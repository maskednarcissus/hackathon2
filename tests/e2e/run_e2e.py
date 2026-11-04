"""Classroom Intelligence — end-to-end scenario (integration stage §7).

One class goes through the whole platform:

  organization + timetable import → identity users + access sync → device provisioning,
  registration, assignment, heartbeat, recording plan → signed upload of a synthetic WAV →
  audio processing → transcription → diarization → lecture structure → extracted exam awaiting
  review → professor confirms → calendar event with provenance → student inbox notification →
  audit chain verifies → analytics capture coverage counts the class.

Modes
  python tests/e2e/run_e2e.py                 # services already running (docker compose), URLs from env
  python tests/e2e/run_e2e.py --local         # start every service + dev event bus as local processes
  python tests/e2e/run_e2e.py --local --database postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433
                                              # …against a fresh Postgres database (migrations applied)

Outputs a step table and ``tests/e2e/results/e2e-report.json``; exit code 1 if any step fails.
Steps marked ``WORKAROUND`` passed only because the runner stood in for a missing integration
(e.g. pushing access data itself because academic-integration has no sync push yet).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
import wave
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from services import BUS_PORT, REPO, SERVICES, url_env  # noqa: E402

TZ = ZoneInfo("America/Sao_Paulo")
RESULTS_DIR = Path(__file__).resolve().parent / "results"
PT_MONTHS = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


# --------------------------------------------------------------------------------------- utilities
def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


IS_WINDOWS = os.name == "nt"
VENV_PYTHON = REPO / (".venv/Scripts/python.exe" if IS_WINDOWS else ".venv/bin/python")
_SESSION_KW: dict[str, Any] = (
    {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WINDOWS else {"start_new_session": True}
)
SHARED = load_env_file(REPO / "infrastructure/docker/full-stack.env")
INTERNAL = SHARED["INTERNAL_API_TOKEN"]
ADMIN = SHARED["ADMIN_API_TOKEN"]


class StepFailed(Exception):
    pass


@dataclass
class Step:
    name: str
    status: str = "pending"  # passed | failed | skipped | workaround
    detail: str = ""
    seconds: float = 0.0


@dataclass
class Report:
    steps: list[Step] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return any(s.status == "failed" for s in self.steps)


REPORT = Report()


@contextmanager
def step(name: str, soft: bool = False) -> Iterator[Step]:
    """A scenario step. ``soft`` steps record a failure but let the scenario continue
    (used where later steps do not depend on the result)."""
    s = Step(name)
    REPORT.steps.append(s)
    started = time.monotonic()
    print(f"▶ {name}", flush=True)
    try:
        yield s
        if s.status == "pending":
            s.status = "passed"
    except StepFailed as exc:
        s.status = "failed"
        s.detail = str(exc)
        if not soft:
            raise
    except Exception as exc:  # noqa: BLE001 — report everything as a step failure
        s.status = "failed"
        s.detail = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
        if not soft:
            raise StepFailed(s.detail) from exc
    finally:
        s.seconds = round(time.monotonic() - started, 2)
        mark = {"passed": "✓", "workaround": "≈", "failed": "✗", "skipped": "-"}.get(s.status, "?")
        print(f"  {mark} {s.status} {s.detail}".rstrip(), flush=True)


def expect(cond: bool, message: str) -> None:
    if not cond:
        raise StepFailed(message)


def poll(fn: Callable[[], Any], timeout: float, what: str, interval: float = 1.0) -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise StepFailed(f"timed out after {timeout:.0f}s waiting for {what}")


def body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text


def check(resp: httpx.Response, *ok: int) -> Any:
    codes = ok or (200, 201, 202)
    if resp.status_code not in codes:
        raise StepFailed(
            f"{resp.request.method} {resp.request.url.path} → {resp.status_code}: "
            f"{json.dumps(body(resp), ensure_ascii=False)[:800]}"
        )
    return body(resp)


def items_of(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "events", "results", "transcripts", "data"):
            if isinstance(payload.get(key), list):
                return list(payload[key])
    return []


# ------------------------------------------------------------------------------- device identity
class Device:
    """Ed25519 device identity + signed requests (contract Phase 1 §3)."""

    def __init__(self) -> None:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        self._key = Ed25519PrivateKey.generate()
        self.public_key_pem = (
            self._key.public_key()
            .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
            .decode()
        )
        self.device_id: str | None = None

    def headers(self, method: str, path_with_query: str, raw: bytes) -> dict[str, str]:
        assert self.device_id, "device not registered"
        ts = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        canonical = "\n".join(
            ["CI-DEVICE-V1", method.upper(), path_with_query, ts, hashlib.sha256(raw).hexdigest()]
        )
        sig = base64.b64encode(self._key.sign(canonical.encode())).decode()
        return {"X-Device-Id": self.device_id, "X-Device-Timestamp": ts, "X-Device-Signature": sig}

    def request(
        self,
        client: httpx.Client,
        method: str,
        url: str,
        *,
        json_body: Any = None,
        content: bytes | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        raw = content if content is not None else (
            b"" if json_body is None else json.dumps(json_body).encode()
        )
        parsed = urlparse(url)
        path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        headers = self.headers(method, path, raw)
        if json_body is not None and content is None:
            headers["content-type"] = "application/json"
        headers.update(extra_headers or {})
        return client.request(method, url, content=raw, headers=headers)


# ---------------------------------------------------------------------------------- synthetic WAV
def synth_lecture_wav(path: Path, seconds: int, sample_rate: int = 16_000) -> None:
    """Speech-like signal: band-limited noise with syllable-rate envelope and short pauses."""
    import numpy as np

    rng = np.random.default_rng(42)
    n = seconds * sample_rate
    t = np.arange(n) / sample_rate
    noise = rng.standard_normal(n)
    kernel = np.ones(8) / 8  # crude low-pass
    voiced = np.convolve(noise, kernel, mode="same")
    syllables = 0.55 + 0.45 * np.sin(2 * math.pi * 4.0 * t)
    phrases = (np.sin(2 * math.pi * 0.18 * t) > -0.6).astype(float)  # ~25 % pauses
    carrier = 0.3 * np.sin(2 * math.pi * 140 * t) + 0.2 * np.sin(2 * math.pi * 280 * t)
    signal_ = (voiced * 0.6 + carrier) * syllables * phrases
    signal_ += 0.004 * rng.standard_normal(n)  # room noise floor
    pcm = np.clip(signal_ / np.max(np.abs(signal_)) * 0.6 * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


# ------------------------------------------------------------------------------------ local stack
@dataclass
class LocalStack:
    workdir: Path
    database_url: str | None
    procs: dict[str, subprocess.Popen[bytes]] = field(default_factory=dict)

    def urls(self) -> dict[str, str]:
        return {s.name: f"http://127.0.0.1:{s.port}" for s in SERVICES}

    def env_for(self, service_name: str | None) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.endswith("_URL")}
        env.update(SHARED)
        env.update(url_env(self.urls()))
        env["EVENT_BUS_URL"] = f"http://127.0.0.1:{BUS_PORT}"
        if self.database_url:
            env["DATABASE_URL"] = self.database_url
        else:
            env.pop("DATABASE_URL", None)
        data = self.workdir / "data"
        for svc in SERVICES:
            if svc.name == service_name:
                env["PORT"] = str(svc.port)
                for k, v in svc.extra_env.items():
                    env[k] = v.format(data=str(data), service_dir=str(REPO / svc.path))
        env["DSR_EXPORT_DIR"] = str(data / "dsr")
        return env

    def start(self, name: str, extra: dict[str, str] | None = None) -> None:
        log = (self.workdir / "logs" / f"{name}.log").open("ab")
        if name == "dev-event-bus":
            cwd = REPO / "infrastructure/dev-event-bus"
            cmd = ["node", "dist/index.js"]
            env = self.env_for(None)
            env.update(
                PORT=str(BUS_PORT),
                SUBSCRIPTIONS_FILE=str(REPO / "infrastructure/events/subscriptions.yaml"),
                BUS_TIMEOUT_MS="600000",
            )
        else:
            svc = next(s for s in SERVICES if s.name == name)
            cwd = REPO / svc.path
            env = self.env_for(name)
            if svc.kind == "node":
                cmd = ["node", "dist/index.js"]
            else:
                py = VENV_PYTHON
                cmd = [str(py), "-m", "uvicorn", "main:app", "--app-dir", "src",
                       "--host", "127.0.0.1", "--port", str(svc.port)]
        env.update(extra or {})
        self.procs[name] = subprocess.Popen(
            cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, **_SESSION_KW
        )

    def wait_healthy(self, names: list[str], timeout: float = 90) -> None:
        urls = self.urls() | {"dev-event-bus": f"http://127.0.0.1:{BUS_PORT}"}
        pending = set(names)
        deadline = time.monotonic() + timeout
        with httpx.Client(timeout=2) as c:
            while pending and time.monotonic() < deadline:
                for name in sorted(pending):
                    proc = self.procs.get(name)
                    if proc and proc.poll() is not None:
                        tail = self.log_tail(name)
                        raise StepFailed(f"{name} exited with {proc.returncode}:\n{tail}")
                    try:
                        if c.get(urls[name] + "/health").status_code == 200:
                            pending.discard(name)
                    except httpx.HTTPError:
                        pass
                time.sleep(0.5)
        if pending:
            raise StepFailed(f"not healthy after {timeout:.0f}s: {', '.join(sorted(pending))}")

    def log_tail(self, name: str, lines: int = 25) -> str:
        path = self.workdir / "logs" / f"{name}.log"
        if not path.exists():
            return ""
        return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])

    def stop(self) -> None:
        for proc in self.procs.values():
            if proc.poll() is None:
                try:
                    if IS_WINDOWS:
                        proc.terminate()
                    else:
                        os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for proc in self.procs.values():
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if IS_WINDOWS:
                    proc.kill()
                else:
                    os.killpg(proc.pid, signal.SIGKILL)


def create_database(admin_url: str) -> str:
    """Creates ``ci_e2e_<random>`` on the server, applies migrations, returns its URL."""
    import psycopg

    name = f"ci_e2e_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    parsed = urlparse(admin_url)
    query = parse_qs(parsed.query)
    env = dict(os.environ)
    env.update(
        PGHOST=query.get("host", [parsed.hostname or "localhost"])[0],
        PGPORT=query.get("port", [str(parsed.port or 5432)])[0],
        PGUSER=parsed.username or "postgres",
        PGDATABASE=name,
    )
    if parsed.password:
        env["PGPASSWORD"] = parsed.password
    subprocess.run(
        ["sh", str(REPO / "infrastructure/docker/apply-migrations.sh"), str(REPO / "data/migrations")],
        check=True, env=env,
    )
    db_url = parsed._replace(path=f"/{name}").geturl()
    REPORT.context["database"] = name
    return db_url


# ---------------------------------------------------------------------------------------- scenario
def run_scenario(urls: dict[str, str], stack: LocalStack | None, wav_seconds: int) -> None:
    U = urls
    c = httpx.Client(timeout=120)
    admin_h = {"Authorization": f"Bearer {ADMIN}", "x-internal-token": INTERNAL}
    internal_h = {"x-internal-token": INTERNAL}
    ctx = REPORT.context
    now = datetime.now(TZ)

    # 1 ── organization ---------------------------------------------------------------------
    with step("organization: holding, institution, campus, classroom, default policy"):
        hc = check(c.post(f"{U['organization']}/v1/holding-companies", headers=admin_h,
                          json={"name": "Grupo E2E", "legalName": "Grupo E2E Educação S.A."}))
        inst = check(c.post(f"{U['organization']}/v1/institutions", headers=admin_h,
                            json={"holdingCompanyId": hc["id"], "name": "Faculdade E2E", "state": "SP"}))
        policy = check(c.post(
            f"{U['organization']}/v1/institutions/{inst['id']}/recording-policies", headers=admin_h,
            json={"name": "Padrão", "legalBasis": "legitimate_interest", "isDefault": True,
                  "preRollMinutes": 2, "postRollMinutes": 5}))
        campus = check(c.post(f"{U['organization']}/v1/campuses", headers=admin_h,
                              json={"institutionId": inst["id"], "name": "Campus Centro",
                                    "city": "São Paulo", "state": "SP"}))
        room = check(c.post(f"{U['organization']}/v1/classrooms", headers=admin_h,
                            json={"campusId": campus["id"], "name": "Sala 101", "code": "S101"}))
        ctx.update(institutionId=inst["id"], campusId=campus["id"], classroomId=room["id"],
                   policyId=policy["id"], holdingCompanyId=hc["id"])

    # identity needs the institution id for its bootstrap admin → started now in --local mode
    if stack:
        with step("identity: start with bootstrap admin for the new institution"):
            stack.start("identity", {"IDENTITY_BOOTSTRAP_INSTITUTION_ID": ctx["institutionId"]})
            stack.wait_healthy(["identity"])
            s = REPORT.steps[-1]
            s.status = "workaround"
            s.detail = ("identity can only bootstrap an admin for an institution id known at start-up; "
                        "no internal-token user provisioning exists")

    # 2 ── timetable import ------------------------------------------------------------------
    with step("academic-integration: timetable import with a class that just ended"):
        # A class that ended a few minutes ago: still inside the recording plan's post-roll,
        # and already "finished" for analytics (which only counts classes that have ended).
        start = (now - timedelta(minutes=70)).replace(second=0, microsecond=0)
        end = (now - timedelta(minutes=3)).replace(second=0, microsecond=0)
        if start.date() != now.date():
            raise StepFailed("run after 01:10 São Paulo time (the class must fit in today)")
        dow = (now.weekday() + 1) % 7  # Sunday = 0
        students = [
            {"externalId": f"ALU{i:03d}", "name": f"Estudante {i}", "email": f"aluno{i}@e2e.local"}
            for i in range(1, 7)
        ]
        payload = {
            "institutionId": ctx["institutionId"],
            "timezone": "America/Sao_Paulo",
            "term": {"externalId": "2026-2", "name": "2026/2",
                     "startDate": (now.date() - timedelta(days=30)).isoformat(),
                     "endDate": (now.date() + timedelta(days=90)).isoformat()},
            "courses": [{"externalId": "ECO101", "code": "ECO101",
                         "name": "Economia Monetária", "discipline": "economics"}],
            "professors": [{"externalId": "PROF01", "name": "Profa. Ana Lima",
                            "email": "ana.lima@e2e.local"}],
            "students": students,
            "classSections": [{
                "externalId": "ECO101-A", "courseExternalId": "ECO101", "professorExternalId": "PROF01",
                "sectionCode": "A",
                "schedule": [{"dayOfWeek": dow, "startTime": start.strftime("%H:%M"),
                              "endTime": end.strftime("%H:%M"), "classroomId": ctx["classroomId"]}],
            }],
            "enrollments": [{"studentExternalId": s["externalId"], "classSectionExternalId": "ECO101-A"}
                            for s in students],
        }
        report = check(c.post(f"{U['academic-integration']}/v1/imports", headers=internal_h, json=payload),
                       200, 201)
        expect(report.get("status") == "applied", f"import not applied: {report}")
        frm = (now - timedelta(hours=2)).astimezone(UTC).isoformat()
        to = (now + timedelta(hours=3)).astimezone(UTC).isoformat()
        classes = items_of(check(c.get(f"{U['academic-integration']}/v1/scheduled-classes",
                                       params={"classroomId": ctx["classroomId"], "from": frm, "to": to})))
        expect(len(classes) >= 1, "no scheduled class around now")
        sc = classes[0]
        roster = check(c.get(f"{U['academic-integration']}/v1/class-sections/{sc['classSectionId']}/roster"))
        ctx.update(scheduledClassId=sc["id"], classSectionId=sc["classSectionId"],
                   courseId=sc["courseId"], professorId=sc["professorId"],
                   studentIds=roster["studentIds"], classStartsAt=sc["startsAt"], classEndsAt=sc["endsAt"])

    # 3 ── identity users + access data sync -------------------------------------------------
    with step("identity: admin login, professor + student accounts"):
        login = check(c.post(f"{U['identity']}/v1/auth/login", json={
            "email": SHARED["IDENTITY_BOOTSTRAP_ADMIN_EMAIL"],
            "password": SHARED["IDENTITY_BOOTSTRAP_ADMIN_PASSWORD"],
            "institutionId": ctx["institutionId"]}))
        admin_jwt = login["accessToken"]
        ctx["adminUserId"] = login["user"]["id"]
        jwt_h = {"Authorization": f"Bearer {admin_jwt}"}
        prof = check(c.post(f"{U['identity']}/v1/users", headers=jwt_h, json={
            "institutionId": ctx["institutionId"], "email": "ana.lima@e2e.local", "name": "Profa. Ana Lima",
            "role": "professor", "password": "professora-e2e-123", "professorId": ctx["professorId"]}))
        stu = check(c.post(f"{U['identity']}/v1/users", headers=jwt_h, json={
            "institutionId": ctx["institutionId"], "email": "aluno1@e2e.local", "name": "Estudante 1",
            "role": "student", "password": "estudante-e2e-123", "studentId": ctx["studentIds"][0]}))
        ctx.update(professorUserId=prof.get("id") or prof.get("user", {}).get("id"),
                   studentUserId=stu.get("id") or stu.get("user", {}).get("id"), adminJwt=admin_jwt)

    with step("academic-integration → identity/calendar/notifications/analytics: access data sync"):
        push = c.post(f"{U['academic-integration']}/v1/sync/push", headers=internal_h,
                      json={"institutionId": ctx["institutionId"]})
        if push.status_code in (200, 202):
            REPORT.steps[-1].detail = "sync pushed by academic-integration"
        else:
            REPORT.steps[-1].status = "workaround"
            REPORT.steps[-1].detail = (f"POST /v1/sync/push → {push.status_code}; runner pushed the "
                                       "sections/enrollments itself")
            inst_id, sec = ctx["institutionId"], ctx["classSectionId"]
            enroll = [{"studentId": s, "classSectionId": sec, "status": "active"} for s in ctx["studentIds"]]
            check(c.post(f"{U['identity']}/v1/sync/sections", headers=internal_h, json={
                "institutionId": inst_id, "sections": [{"classSectionId": sec,
                                                        "professorId": ctx["professorId"],
                                                        "courseId": ctx["courseId"]}]}))
            check(c.post(f"{U['identity']}/v1/sync/enrollments", headers=internal_h,
                         json={"institutionId": inst_id, "enrollments": enroll}))
            check(c.post(f"{U['calendar']}/v1/sections", headers=internal_h, json={"sections": [{
                "classSectionId": sec, "institutionId": inst_id, "courseId": ctx["courseId"],
                "professorId": ctx["professorId"], "courseName": "Economia Monetária", "sectionCode": "A"}]}))
            check(c.post(f"{U['calendar']}/v1/enrollments/bulk", headers=internal_h,
                         json={"classSectionId": sec, "studentIds": ctx["studentIds"]}))
            notif_rows = [dict(r) for r in enroll]
            notif_rows[0]["userId"] = ctx["studentUserId"]
            notif_rows[0]["email"] = "aluno1@e2e.local"
            check(c.post(f"{U['notifications']}/v1/sync/enrollments", headers=internal_h,
                         json={"institutionId": inst_id, "enrollments": notif_rows}))
            bearer_internal = {"Authorization": f"Bearer {INTERNAL}", "x-internal-token": INTERNAL}
            check(c.post(f"{U['academic-analytics']}/v1/sync/sections", headers=bearer_internal,
                         json={"sections": [{"classSectionId": sec, "institutionId": inst_id,
                                             "courseId": ctx["courseId"], "courseCode": "ECO101",
                                             "courseName": "Economia Monetária",
                                             "professorId": ctx["professorId"], "sectionCode": "A"}]}))
            check(c.post(f"{U['academic-analytics']}/v1/sync/enrollments", headers=bearer_internal,
                         json={"classSectionId": sec, "studentIds": ctx["studentIds"]}))
            check(c.post(f"{U['academic-analytics']}/v1/sync/classrooms", headers=bearer_internal,
                         json={"classrooms": [{"classroomId": ctx["classroomId"], "institutionId": inst_id,
                                               "campusId": ctx["campusId"], "campusName": "Campus Centro",
                                               "name": "Sala 101"}]}))

    # 4 ── device -----------------------------------------------------------------------------
    device = Device()
    serial = f"CI-E2E-{uuid.uuid4().hex[:6].upper()}"
    with step("device-management: provisioning token, registration, classroom assignment"):
        tok = check(c.post(f"{U['device-management']}/v1/provisioning-tokens", headers=admin_h,
                           json={"serialNumber": serial, "institutionId": ctx["institutionId"]}))
        reg = check(c.post(f"{U['device-management']}/v1/devices/register", json={
            "provisioningToken": tok.get("token") or tok.get("provisioningToken"),
            "serialNumber": serial, "model": "ci-capture-a1", "firmwareVersion": "1.0.0",
            "publicKeyPem": device.public_key_pem}))
        device.device_id = reg["deviceId"]
        check(c.put(f"{U['device-management']}/v1/devices/{device.device_id}/assignment", headers=admin_h,
                    json={"classroomId": ctx["classroomId"]}))
        ctx["deviceId"] = device.device_id

    with step("device-management: signed heartbeat and recording plan", soft=True):
        hb = device.request(c, "POST", f"{U['device-management']}/v1/devices/{device.device_id}/heartbeat",
                            json_body={"firmwareVersion": "1.0.0", "uptimeSeconds": 120, "cpuTempC": 48.5,
                                       "diskFreeBytes": 20 * 1024**3, "diskTotalBytes": 32 * 1024**3,
                                       "bufferQueueCount": 0, "bufferQueueBytes": 0, "isRecording": False})
        check(hb, 200, 201, 202, 204)
        plan = check(device.request(c, "GET",
                                    f"{U['device-management']}/v1/devices/{device.device_id}/recording-plan"))
        windows = plan.get("windows", [])
        win = next((w for w in windows if w.get("scheduledClassId") == ctx["scheduledClassId"]), None)
        expect(win is not None, f"scheduled class missing from plan: {json.dumps(plan)[:500]}")
        expect(win.get("recordingEnabled") is True, f"recording disabled: {win}")

    # 5 ── capture + upload ------------------------------------------------------------------
    wav = Path(tempfile.mkdtemp(prefix="ci-e2e-")) / "lecture.wav"
    synth_lecture_wav(wav, wav_seconds)
    raw = wav.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    local_id = f"rec-{uuid.uuid4().hex[:8]}"
    started_at = datetime.fromisoformat(ctx["classStartsAt"].replace("Z", "+00:00")) + timedelta(minutes=1)
    ended_at = started_at + timedelta(seconds=wav_seconds)
    with step("audio-ingestion: recording.started event + recording metadata"):
        ev = device.request(c, "POST", f"{U['audio-ingestion']}/v1/recording-events", json_body={
            "type": "recording.started", "deviceId": device.device_id, "localRecordingId": local_id,
            "scheduledClassId": ctx["scheduledClassId"], "at": started_at.isoformat()})
        check(ev, 200, 201, 202, 204)
        meta = check(device.request(c, "POST", f"{U['audio-ingestion']}/v1/recordings", json_body={
            "deviceId": device.device_id, "classroomId": ctx["classroomId"],
            "scheduledClassId": ctx["scheduledClassId"], "startedAt": started_at.isoformat(),
            "endedAt": ended_at.isoformat(), "audioFormat": "wav_pcm_s16le", "sampleRate": 16000,
            "channels": 1, "fileSizeBytes": len(raw), "checksumSha256": digest,
            "firmwareVersion": "1.0.0", "localRecordingId": local_id}))
        ctx["recordingSessionId"] = meta["id"]

    with step("audio-ingestion: chunked upload with checksums, complete"):
        chunk = 4 * 1024 * 1024
        up = check(device.request(c, "POST", f"{U['audio-ingestion']}/v1/uploads", json_body={
            "recordingSessionId": ctx["recordingSessionId"], "totalSizeBytes": len(raw),
            "checksumSha256": digest, "chunkSizeBytes": chunk}))
        upload_id = up["uploadId"]
        for i in range(up["totalChunks"]):
            part = raw[i * chunk:(i + 1) * chunk]
            r = device.request(c, "PUT", f"{U['audio-ingestion']}/v1/uploads/{upload_id}/chunks/{i}",
                               content=part,
                               extra_headers={"X-Chunk-SHA256": hashlib.sha256(part).hexdigest(),
                                              "content-type": "application/octet-stream"})
            check(r, 200, 201, 204)
        done = check(device.request(c, "POST", f"{U['audio-ingestion']}/v1/uploads/{upload_id}/complete",
                                    json_body={}))
        REPORT.steps[-1].detail = f"{up['totalChunks']} chunks, status={done.get('status')}"
        ctx["uploadId"] = upload_id
        device.request(c, "POST", f"{U['audio-ingestion']}/v1/recording-events", json_body={
            "type": "recording.stopped", "deviceId": device.device_id, "localRecordingId": local_id,
            "scheduledClassId": ctx["scheduledClassId"], "at": ended_at.isoformat()})

    # 6 ── pipeline through the event bus --------------------------------------------------------
    def transcript() -> dict[str, Any] | None:
        r = c.get(f"{U['transcript-management']}/v1/transcripts",
                  params={"recordingSessionId": ctx["recordingSessionId"]})
        found = items_of(body(r)) if r.status_code == 200 else []
        return found[0] if found else None

    with step("pipeline: recording.uploaded → processing → recording.segmented → transcription"):
        t = poll(transcript, 240, "a transcript for the recording (check dev bus dead letters)", 2)
        ctx["transcriptId"] = t["id"]
        REPORT.steps[-1].detail = f"transcript {t['id']} ({t.get('stats', {}).get('segmentCount', '?')} segments)"

    with step("pipeline: diarization assigns anonymous SPEAKER_n labels", soft=True):
        def labelled() -> Any:
            r = c.get(f"{U['transcript-management']}/v1/transcripts/{ctx['transcriptId']}/segments",
                      params={"limit": 200})
            segs = items_of(body(r)) if r.status_code == 200 else []
            labels = {s.get("speakerLabel") for s in segs if s.get("speakerLabel")}
            return labels or None
        labels = poll(labelled, 180, "speaker labels on transcript segments", 2)
        expect(all(str(lb).startswith("SPEAKER_") for lb in labels), f"non-anonymous labels: {labels}")
        REPORT.steps[-1].detail = f"labels={sorted(labels)}"

    with step("pipeline: lecture structured (summary, topics)", soft=True):
        def lecture() -> Any:
            r = c.get(f"{U['lecture-intelligence']}/v1/lectures/{ctx['scheduledClassId']}")
            return body(r) if r.status_code == 200 else None
        lec = poll(lecture, 120, "lecture structure", 2)
        REPORT.steps[-1].detail = f"title={lec.get('title')!r}, topics={len(lec.get('topics', []))}"

    # 7 ── event extraction + professor review ---------------------------------------------------
    prof_h = {"X-Actor-Id": ctx["professorId"], "X-Actor-Role": "professor"}

    def queue() -> list[Any] | None:
        r = c.get(f"{U['event-extraction']}/v1/review-queue",
                  params={"classSectionId": ctx["classSectionId"]}, headers=prof_h)
        found = [e for e in items_of(body(r)) if e.get("type") == "examination"] if r.status_code == 200 else []
        return found or None

    exam_date = date.fromisoformat(ctx["classStartsAt"][:10]) + timedelta(days=14)
    with step("event-extraction: exam announcement extracted and held for professor review"):
        found = None
        try:
            found = poll(queue, 60, "an extracted examination from the automatic pipeline", 2)
        except StepFailed:
            # The fake STT provider produces filler text, so the automatic run finds no exam.
            # Re-run extraction on the same transcript with a scripted announcement segment.
            seg_text = (f"Atenção, turma: a segunda prova será no dia {exam_date.day} de "
                        f"{PT_MONTHS[exam_date.month - 1]}, cobrindo os capítulos quatro a sete.")
            r = c.post(f"{U['event-extraction']}/v1/extractions", headers=internal_h, json={
                "transcriptId": ctx["transcriptId"], "scheduledClassId": ctx["scheduledClassId"],
                "recordingSessionId": ctx["recordingSessionId"],
                "segments": [{"segmentIndex": 0, "startMs": 0, "endMs": 6000, "text": seg_text,
                              "confidence": 0.95, "speakerLabel": "SPEAKER_1"}]})
            check(r)
            found = poll(queue, 30, "the scripted examination in the review queue", 1)
            REPORT.steps[-1].status = "workaround"
            REPORT.steps[-1].detail = ("fake STT emits filler text (no announcement); extraction was "
                                       "re-run with a scripted pt-BR exam segment")
        ev = found[0]
        expect(ev.get("confirmationStatus") in ("awaiting_professor", "suggested"),
               f"unexpected status {ev.get('confirmationStatus')}")
        expect(ev.get("eventDate") == exam_date.isoformat(), f"date {ev.get('eventDate')} ≠ {exam_date}")
        ctx["extractedEventId"] = ev["id"]

    with step("event-extraction: professor confirms → published to calendar"):
        conf = check(c.post(f"{U['event-extraction']}/v1/events/{ctx['extractedEventId']}/confirm",
                            headers=prof_h, json={"actorId": ctx["professorId"]}))
        if conf.get("confirmationStatus") != "published":
            conf = check(c.post(f"{U['event-extraction']}/v1/events/{ctx['extractedEventId']}/publish",
                                headers=prof_h, json={"actorId": ctx["professorId"]}))
        expect(conf.get("confirmationStatus") == "published", f"status {conf.get('confirmationStatus')}")

    with step("calendar: event with source provenance (recording, segment, quote)", soft=True):
        def cal() -> Any:
            r = c.get(f"{U['calendar']}/v1/calendar-events", headers=internal_h,
                      params={"classSectionId": ctx["classSectionId"]})
            evs = [e for e in items_of(body(r)) if e.get("extractedEventId") == ctx["extractedEventId"]]
            return evs[0] if evs else None
        cev = poll(cal, 20, "calendar event", 1)
        prov = cev.get("provenance") or {}
        expect(prov.get("transcriptId") == ctx["transcriptId"] and prov.get("quote"),
               f"missing provenance: {prov}")
        ctx["calendarEventId"] = cev["id"]

    # 8 ── student notification ------------------------------------------------------------------
    with step("notifications: student inbox has the new assessment", soft=True):
        slog = check(c.post(f"{U['identity']}/v1/auth/login", json={
            "email": "aluno1@e2e.local", "password": "estudante-e2e-123",
            "institutionId": ctx["institutionId"]}))
        stu_h = {"Authorization": f"Bearer {slog['accessToken']}"}

        def inbox() -> Any:
            r = c.get(f"{U['notifications']}/v1/users/{ctx['studentUserId']}/notifications", headers=stu_h)
            got = [n for n in items_of(body(r)) if n.get("category") == "new_assessment"] \
                if r.status_code == 200 else []
            return got or None
        notes = poll(inbox, 30, "a new_assessment notification for the student", 1)
        REPORT.steps[-1].detail = f"{notes[0].get('title')!r} → {notes[0].get('link')}"

    # 9 ── governance & analytics ----------------------------------------------------------------
    with step("audit: hash chain verifies for the institution", soft=True):
        v = check(c.get(f"{U['audit']}/v1/audit-events/verify", headers=internal_h,
                        params={"tenantId": ctx["institutionId"]}))
        expect(v.get("valid") is True or v.get("ok") is True, f"chain invalid: {v}")
        lc = check(c.get(f"{U['audit']}/v1/recordings/{ctx['recordingSessionId']}/lifecycle",
                         headers=internal_h))
        actions = [e.get("action") for e in (lc.get("timeline") or items_of(lc))]
        REPORT.steps[-1].detail = f"verify={json.dumps(v)[:200]}; lifecycle={actions}"
        expect(len(actions) >= 3, f"recording lifecycle has too few audit events: {actions}")

    with step("academic-analytics: capture coverage counts the class as captured", soft=True):
        day = ctx["classStartsAt"][:10]
        rep = check(c.get(f"{U['academic-analytics']}/v1/institutions/{ctx['institutionId']}/reports/"
                          "capture-coverage",
                          headers={"Authorization": f"Bearer {INTERNAL}"},
                          params={"from": day, "to": day}))
        rows = rep.get("rows", [])
        captured = sum(int(r.get("captured", r.get("classesCaptured", 0)) or 0) for r in rows)
        expect(captured >= 1, f"capture coverage rows show nothing captured: {json.dumps(rep)[:600]}")
        REPORT.steps[-1].detail = f"rows={len(rows)} captured={captured}"


# ------------------------------------------------------------------------------------- dev server
def serve_forever(stack: LocalStack) -> None:
    """Keeps the seeded local stack up for the web apps (``--serve``) and writes their env file."""
    ctx = REPORT.context
    env_lines = [f"{v}={u}" for s in SERVICES for v in s.url_vars for u in [stack.urls()[s.name]]]
    env_lines += [
        f"INSTITUTION_ID={ctx.get('institutionId', '')}",
        f"ADMIN_INSTITUTION_ID={ctx.get('institutionId', '')}",
        f"PROFESSOR_ID={ctx.get('professorId', '')}",
        f"ADMIN_API_TOKEN={ADMIN}",
        f"DEVICE_MANAGEMENT_TOKEN={ADMIN}",
    ]
    out = RESULTS_DIR / "dev-stack.env"
    RESULTS_DIR.mkdir(exist_ok=True)
    out.write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    print("\n=== Local stack is up (Ctrl+C to stop) ===")
    print(f"institutionId : {ctx.get('institutionId')}")
    print("professor     : ana.lima@e2e.local / professora-e2e-123")
    print("student       : aluno1@e2e.local / estudante-e2e-123")
    print(f"env for apps  : {out}")
    print(f"service logs  : {stack.workdir / 'logs'}", flush=True)
    try:
        while True:
            time.sleep(5)
            dead = [n for n, p in stack.procs.items() if p.poll() is not None]
            if dead:
                print(f"stopped unexpectedly: {', '.join(dead)}", flush=True)
                for n in dead:
                    stack.procs.pop(n)
    except KeyboardInterrupt:
        pass


# -------------------------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", action="store_true", help="start all services as local processes")
    ap.add_argument("--database", help="admin URL of a Postgres server (fresh DB is created; --local)")
    ap.add_argument("--wav-seconds", type=int, default=360, help="length of the synthetic recording")
    ap.add_argument("--keep", action="store_true", help="keep the work dir and logs")
    ap.add_argument("--serve", action="store_true",
                    help="--local: after seeding the scenario, keep every service running until Ctrl+C")
    args = ap.parse_args()

    stack: LocalStack | None = None
    workdir = Path(tempfile.mkdtemp(prefix="ci-e2e-stack-"))
    urls: dict[str, str]
    try:
        if args.local:
            (workdir / "logs").mkdir(parents=True)
            db_url = None
            if args.database:
                with step("postgres: fresh database with all migrations"):
                    db_url = create_database(args.database)
            stack = LocalStack(workdir, db_url)
            with step("local stack: dev event bus + services healthy"):
                for d in ("node", "python"):
                    for s in SERVICES:
                        if s.kind == d and s.kind == "node" and not (REPO / s.path / "dist/index.js").exists():
                            raise StepFailed(f"{s.path} is not built — run `pnpm turbo run build` first")
                if not (REPO / "infrastructure/dev-event-bus/dist/index.js").exists():
                    raise StepFailed("dev-event-bus is not built")
                stack.start("dev-event-bus")
                names = [s.name for s in SERVICES if s.name != "identity"]
                for n in names:
                    stack.start(n)
                stack.wait_healthy(["dev-event-bus", *names])
            urls = stack.urls()
        else:
            defaults = {s.name: f"http://localhost:{s.port}" for s in SERVICES}
            urls = {s.name: os.environ.get(s.url_vars[0], defaults[s.name]) for s in SERVICES}
        REPORT.context["mode"] = "local" if args.local else "external"
        REPORT.context["persistence"] = "postgres" if args.database else "in-memory"
        try:
            run_scenario(urls, stack, args.wav_seconds)
        except StepFailed:
            pass
        if args.serve and stack:
            serve_forever(stack)
    except StepFailed:
        pass
    finally:
        bus_url = f"http://127.0.0.1:{BUS_PORT}" if args.local else os.environ.get(
            "EVENT_BUS_URL", f"http://localhost:{BUS_PORT}")
        try:
            dl = httpx.get(f"{bus_url}/v1/dead-letters", headers={"x-internal-token": INTERNAL},
                           timeout=5).json()
            REPORT.context["deadLetters"] = [
                {k: d.get(k) for k in ("topic", "subscription", "attempts", "lastStatusCode", "lastError")}
                for d in dl.get("items", [])
            ]
            dels = httpx.get(f"{bus_url}/v1/deliveries", params={"limit": 500},
                             headers={"x-internal-token": INTERNAL}, timeout=5).json()
            # 2xx answers that still report a problem (acknowledged but not processed).
            REPORT.context["acknowledgedProblems"] = [
                {k: d.get(k) for k in ("topic", "subscription", "lastStatusCode", "lastResponse")}
                for d in dels.get("items", [])
                if d.get("lastResponse") and any(
                    w in str(d["lastResponse"]) for w in ('"failed"', '"ignored"', '"error"', "skipped"))
            ]
        except Exception:  # noqa: BLE001
            pass
        if stack:
            for name in stack.procs:
                if any(name in s.detail for s in REPORT.steps if s.status == "failed"):
                    REPORT.notes.append(f"--- {name} log tail ---\n{stack.log_tail(name)}")
            stack.stop()
        RESULTS_DIR.mkdir(exist_ok=True)
        (RESULTS_DIR / "e2e-report.json").write_text(json.dumps({
            "steps": [s.__dict__ for s in REPORT.steps], "context": {
                k: v for k, v in REPORT.context.items() if k != "adminJwt"},
            "notes": REPORT.notes}, indent=2, ensure_ascii=False), encoding="utf-8")
        print("\n=== E2E summary ===")
        for s in REPORT.steps:
            print(f"{s.status:10} {s.seconds:6.1f}s  {s.name}")
        for d in REPORT.context.get("deadLetters", []):
            print(f"dead letter: {d}")
        for d in REPORT.context.get("acknowledgedProblems", []):
            print(f"acknowledged with problem: {d}")
        if args.keep or REPORT.failed:
            print(f"work dir (logs): {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)
    return 1 if REPORT.failed else 0


if __name__ == "__main__":
    sys.exit(main())
