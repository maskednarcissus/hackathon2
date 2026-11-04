"""MVP demo: the whole platform on localhost with a simulated institution, no credentials needed.

    python tests/demo/run_demo.py            # services + seed + the three web apps, Ctrl+C stops
    python tests/demo/run_demo.py --no-apps  # backend only

What it does:
1. starts the dev event bus and every service in-memory, with the offline demo AI
   (``AI_GATEWAY_PROVIDER=demo``) and the heuristic event extractor;
2. creates "Faculdade Horizonte": campus, classrooms, 3 courses, 3 professors, 12 students;
3. loads the lectures in ``demo_content.py`` as transcripts of past classes, structures them
   (summary, topics, concepts, questions, readings) and extracts exams/deadlines;
4. confirms most extracted events (published to the calendar → student notifications) and
   leaves one awaiting professor review;
5. starts student-web (3000), professor-web (3001) and administration-web (3002).

Demo logins are listed in tests/demo/README.md. Data lives in memory and is recreated on each run.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "e2e"))
sys.path.insert(0, str(HERE))

import run_e2e as e2e  # noqa: E402
from demo_content import (  # noqa: E402
    CLASSROOMS, COURSES, INSTITUTION, LECTURES, PROF, PROFESSORS, STUDENT_NAMES,
)
from services import BUS_PORT, REPO, SERVICES  # noqa: E402

DEMO_PASSWORD = "horizonte-demo-2026"  # fictional demo accounts only (see README.md)
DEMO_ENV = {
    "AI_GATEWAY_PROVIDER": "demo",
    "EVENT_EXTRACTOR": "heuristic",
    "AUTH_DISABLED": "true",  # academic-analytics / group-intelligence: dev-only bypass
    "IDENTITY_ACCESS_TOKEN_TTL_SECONDS": "43200",  # admin console token lasts the whole demo
}
APPS = [("student-web", 3000), ("professor-web", 3001), ("administration-web", 3002)]
check, items_of, body = e2e.check, e2e.items_of, e2e.body
INTERNAL, ADMIN, SHARED = e2e.INTERNAL, e2e.ADMIN, e2e.SHARED


def log(msg: str) -> None:
    print(msg, flush=True)


def human_date(d: date) -> str:
    return f"{d.day} de {e2e.PT_MONTHS[d.month - 1]}"


def slug_email(name: str) -> str:
    import unicodedata

    plain = "".join(c for c in unicodedata.normalize("NFKD", name.lower()) if not unicodedata.combining(c))
    return plain.replace(" ", ".") + "@demo.local"


class DemoStack(e2e.LocalStack):
    def env_for(self, service_name: str | None) -> dict[str, str]:
        env = super().env_for(service_name)
        env.update(DEMO_ENV)
        return env


# ------------------------------------------------------------------------------------- seeding
def seed(stack: DemoStack) -> dict[str, Any]:
    U = stack.urls()
    admin_h = {"Authorization": f"Bearer {ADMIN}", "x-internal-token": INTERNAL}
    internal_h = {"x-internal-token": INTERNAL}
    today = datetime.now(e2e.TZ).date()
    ctx: dict[str, Any] = {}
    c = httpx.Client(timeout=120)

    log("• organização: grupo, faculdade, campus e salas")
    hc = check(c.post(f"{U['organization']}/v1/holding-companies", headers=admin_h,
                      json={"name": INSTITUTION["holding"], "legalName": INSTITUTION["holding"] + " S.A."}))
    inst = check(c.post(f"{U['organization']}/v1/institutions", headers=admin_h,
                        json={"holdingCompanyId": hc["id"], "name": INSTITUTION["name"],
                              "state": INSTITUTION["state"]}))
    check(c.post(f"{U['organization']}/v1/institutions/{inst['id']}/recording-policies", headers=admin_h,
                 json={"name": "Padrão", "legalBasis": "legitimate_interest", "isDefault": True,
                       "preRollMinutes": 2, "postRollMinutes": 5}))
    campus = check(c.post(f"{U['organization']}/v1/campuses", headers=admin_h,
                          json={"institutionId": inst["id"], "name": INSTITUTION["campus"],
                                "city": INSTITUTION["city"], "state": INSTITUTION["state"]}))
    rooms = [check(c.post(f"{U['organization']}/v1/classrooms", headers=admin_h,
                          json={"campusId": campus["id"], "name": n, "code": code}))
             for n, code in CLASSROOMS]
    ctx.update(institutionId=inst["id"], campusId=campus["id"])

    log("• identity: iniciando com o administrador da faculdade")
    stack.start("identity", {"IDENTITY_BOOTSTRAP_INSTITUTION_ID": inst["id"]})
    stack.wait_healthy(["identity"])

    log("• grade horária: 3 disciplinas, 3 professores, 12 alunos")
    students = [{"externalId": f"ALU{i:03d}", "name": n, "email": slug_email(n)}
                for i, n in enumerate(STUDENT_NAMES, start=1)]
    payload = {
        "institutionId": inst["id"], "timezone": "America/Sao_Paulo",
        "term": {"externalId": "2026-2", "name": "2026/2",
                 "startDate": (today - timedelta(days=42)).isoformat(),
                 "endDate": (today + timedelta(days=60)).isoformat()},
        "courses": [{"externalId": k["code"], "code": k["code"], "name": k["name"],
                     "discipline": k["discipline"]} for k in COURSES],
        "professors": PROFESSORS,
        "students": students,
        "classSections": [{
            "externalId": f"{k['code']}-A", "courseExternalId": k["code"],
            "professorExternalId": k["professor"], "sectionCode": "A",
            "schedule": [{"dayOfWeek": d, "startTime": k["start"], "endTime": k["end"],
                          "classroomId": rooms[k["room"]]["id"]} for d in k["days"]],
        } for k in COURSES],
        "enrollments": [{"studentExternalId": s["externalId"], "classSectionExternalId": f"{k['code']}-A"}
                        for s in students for k in COURSES],
    }
    report = check(c.post(f"{U['academic-integration']}/v1/imports", headers=internal_h, json=payload), 200, 201)
    if report.get("status") != "applied":
        raise RuntimeError(f"timetable import not applied: {report}")

    # past scheduled classes per course (most recent last)
    frm = datetime.combine(today - timedelta(days=40), datetime.min.time(), e2e.TZ).astimezone(UTC)
    to = datetime.now(UTC)
    sections: dict[str, dict[str, Any]] = {}
    for k in COURSES:
        room_id = rooms[k["room"]]["id"]
        classes = items_of(check(c.get(f"{U['academic-integration']}/v1/scheduled-classes",
                                       params={"classroomId": room_id, "from": frm.isoformat(),
                                               "to": to.isoformat()})))
        classes = sorted((x for x in classes if x["endsAt"] <= to.isoformat().replace("+00:00", "Z")
                          or datetime.fromisoformat(x["endsAt"].replace("Z", "+00:00")) <= to),
                         key=lambda x: x["startsAt"])
        if not classes:
            raise RuntimeError(f"no past scheduled classes for {k['code']}")
        roster = check(c.get(f"{U['academic-integration']}/v1/class-sections/{classes[0]['classSectionId']}/roster"))
        sections[k["code"]] = {"course": k, "classes": classes, "sectionId": classes[0]["classSectionId"],
                               "courseId": classes[0]["courseId"], "professorId": classes[0]["professorId"],
                               "studentIds": roster["studentIds"]}
    ctx["sections"] = {code: s["sectionId"] for code, s in sections.items()}

    log("• contas: professores, alunos e sincronização de acesso")
    login = check(c.post(f"{U['identity']}/v1/auth/login", json={
        "email": SHARED["IDENTITY_BOOTSTRAP_ADMIN_EMAIL"], "password": SHARED["IDENTITY_BOOTSTRAP_ADMIN_PASSWORD"],
        "institutionId": inst["id"]}))
    jwt_h = {"Authorization": f"Bearer {login['accessToken']}"}
    ctx["adminUserId"] = login["user"]["id"]
    ctx["adminJwt"] = login["accessToken"]
    prof_ids = {k["professor"]: s["professorId"] for s in sections.values() for k in [s["course"]]}
    for p in PROFESSORS:
        check(c.post(f"{U['identity']}/v1/users", headers=jwt_h, json={
            "institutionId": inst["id"], "email": p["email"], "name": p["name"], "role": "professor",
            "password": DEMO_PASSWORD, "professorId": prof_ids[p["externalId"]]}))
    ctx["professorId"] = prof_ids["PROF01"]
    student_ids = sections[COURSES[0]["code"]]["studentIds"]  # same 12 students in every section
    # roster order follows import order; map by position
    student_users: list[dict[str, Any]] = []
    for s, sid in zip(students[:3], student_ids[:3], strict=False):
        u = check(c.post(f"{U['identity']}/v1/users", headers=jwt_h, json={
            "institutionId": inst["id"], "email": s["email"], "name": s["name"], "role": "student",
            "password": DEMO_PASSWORD, "studentId": sid}))
        student_users.append({"userId": u.get("id") or u.get("user", {}).get("id"), "studentId": sid,
                              "email": s["email"]})
    push = c.post(f"{U['academic-integration']}/v1/sync/push", headers=internal_h, json={"institutionId": inst["id"]})
    if push.status_code not in (200, 202):
        log(f"  aviso: sync/push → {push.status_code}")
    users_by_student = {u["studentId"]: u for u in student_users}
    for s in sections.values():
        rows = []
        for sid in s["studentIds"]:
            row: dict[str, Any] = {"studentId": sid, "classSectionId": s["sectionId"], "status": "active"}
            if sid in users_by_student:
                row.update(userId=users_by_student[sid]["userId"], email=users_by_student[sid]["email"])
            rows.append(row)
        c.post(f"{U['notifications']}/v1/sync/enrollments", headers=internal_h,
               json={"institutionId": inst["id"], "enrollments": rows})

    log("• aulas: transcrições, estrutura com IA demo e eventos do calendário")
    per_course: dict[str, list[dict[str, Any]]] = {}
    for lec in LECTURES:
        per_course.setdefault(str(lec["course"]), []).append(lec)
    extracted: list[tuple[str, str, str]] = []  # (event id, section id, professor id)
    for code, lectures in per_course.items():
        s = sections[code]
        chosen = s["classes"][-len(lectures):]
        if len(chosen) < len(lectures):
            lectures = lectures[-len(chosen):]
        for lec, sc in zip(lectures, chosen, strict=True):
            class_day = date.fromisoformat(sc["startsAt"][:10])
            segs, t = [], 0
            for i, (speaker, raw) in enumerate(lec["segments"]):  # type: ignore[arg-type]
                text = raw
                for n in range(0, 40):
                    text = text.replace(f"{{d+{n}}}", human_date(today + timedelta(days=n)))
                dur = max(6000, len(text) * 70)
                segs.append({"segmentIndex": i, "startMs": t, "endMs": t + dur, "text": text,
                             "confidence": 0.94, "language": "pt-BR",
                             "speakerLabel": speaker if speaker.startswith("SPEAKER_") else PROF})
                t += dur + 90_000 if speaker == PROF else dur + 20_000
            recording_id = str(uuid.uuid4())
            tr = check(c.post(f"{U['transcript-management']}/v1/transcripts", headers=internal_h, json={
                "recordingSessionId": recording_id, "scheduledClassId": sc["id"],
                "classSectionId": s["sectionId"], "institutionId": inst["id"], "language": "pt-BR",
                "processingVersion": "demo-1", "provider": "demo", "model": "demo-transcript",
                "segments": segs}))
            transcript_id = tr.get("id") or tr.get("transcript", {}).get("id")
            st = check(c.post(f"{U['lecture-intelligence']}/v1/lectures/structure", headers=internal_h, json={
                "transcriptId": transcript_id, "scheduledClassId": sc["id"], "institutionId": inst["id"],
                "classSectionId": s["sectionId"], "courseId": s["courseId"], "courseName": s["course"]["name"],
                "classDate": class_day.isoformat(), "startsAt": sc["startsAt"], "language": "pt-BR",
                "segments": segs}))
            title = st.get("title") or st.get("structure", {}).get("title")
            log(f"    {code} {class_day:%d/%m}: {title}")
            c.post(f"{U['event-extraction']}/v1/extractions", headers=internal_h, json={
                "transcriptId": transcript_id, "scheduledClassId": sc["id"],
                "recordingSessionId": recording_id, "segments": segs})

    log("• calendário: professor confirma os anúncios extraídos")
    time.sleep(1)
    pending_left = False
    published = 0
    for code, s in sections.items():
        prof_h = {"X-Actor-Id": s["professorId"], "X-Actor-Role": "professor"}
        queue = items_of(body(c.get(f"{U['event-extraction']}/v1/review-queue",
                                    params={"classSectionId": s["sectionId"]}, headers=prof_h)))
        for ev in queue:
            if ev.get("confirmationStatus") not in ("awaiting_professor", "suggested"):
                continue
            if not pending_left and code == "ECO101" and ev.get("type") == "assignment":
                pending_left = True  # keep one for the professor review demo
                continue
            conf = body(c.post(f"{U['event-extraction']}/v1/events/{ev['id']}/confirm", headers=prof_h,
                               json={"actorId": s["professorId"]}))
            if isinstance(conf, dict) and conf.get("confirmationStatus") != "published":
                conf = body(c.post(f"{U['event-extraction']}/v1/events/{ev['id']}/publish", headers=prof_h,
                                   json={"actorId": s["professorId"]}))
            if isinstance(conf, dict) and conf.get("confirmationStatus") == "published":
                published += 1
    log(f"    {published} eventos publicados no calendário, {int(pending_left)} aguardando revisão")
    log("• dispositivos: um gravador simulado por sala, com heartbeat")
    for i, room in enumerate(rooms, start=1):
        try:
            dev = e2e.Device()
            serial = f"HZ-CAP-{i:03d}"
            tok = check(c.post(f"{U['device-management']}/v1/provisioning-tokens", headers=admin_h,
                               json={"serialNumber": serial, "institutionId": inst["id"]}))
            reg = check(c.post(f"{U['device-management']}/v1/devices/register", json={
                "provisioningToken": tok.get("token") or tok.get("provisioningToken"),
                "serialNumber": serial, "model": "ci-capture-a1", "firmwareVersion": "1.2.0",
                "publicKeyPem": dev.public_key_pem}))
            dev.device_id = reg["deviceId"]
            check(c.put(f"{U['device-management']}/v1/devices/{dev.device_id}/assignment", headers=admin_h,
                        json={"classroomId": room["id"]}))
            dev.request(c, "POST", f"{U['device-management']}/v1/devices/{dev.device_id}/heartbeat",
                        json_body={"firmwareVersion": "1.2.0", "uptimeSeconds": 3600 * i, "cpuTempC": 44.0 + i,
                                   "diskFreeBytes": (20 - i) * 1024**3, "diskTotalBytes": 32 * 1024**3,
                                   "bufferQueueCount": 0, "bufferQueueBytes": 0, "isRecording": False})
        except Exception as exc:  # noqa: BLE001 - devices are optional for the demo
            log(f"    aviso: dispositivo {i} não registrado ({exc})")

    ctx["studentUsers"] = student_users
    return ctx


# ------------------------------------------------------------------------------------- apps
def write_env(stack: DemoStack, ctx: dict[str, Any]) -> dict[str, str]:
    env = {var: stack.urls()[s.name] for s in SERVICES for var in s.url_vars}
    env.update(
        INSTITUTION_ID=ctx["institutionId"], ADMIN_INSTITUTION_ID=ctx["institutionId"],
        ADMIN_USER_ID=ctx["adminUserId"], PROFESSOR_ID=ctx["professorId"],
        ADMIN_API_TOKEN=ADMIN, DEVICE_MANAGEMENT_TOKEN=ADMIN, ADMIN_BEARER_TOKEN=ctx["adminJwt"], INTERNAL_API_TOKEN=INTERNAL,
        CALENDAR_PUBLIC_URL=stack.urls()["calendar"],
    )
    out = HERE / "demo-stack.env"
    out.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
    return env


def start_apps(env_extra: dict[str, str], logdir: Path) -> list[subprocess.Popen[bytes]]:
    procs = []
    for app, port in APPS:
        app_dir = REPO / "apps" / app
        if not (app_dir / ".next" / "BUILD_ID").exists():
            log(f"  compilando {app} (primeira vez)…")
            subprocess.run(["node", "node_modules/next/dist/bin/next", "build"], cwd=app_dir, check=True,
                           stdout=subprocess.DEVNULL)
        env = {**os.environ, **env_extra, "PORT": str(port)}
        logf = (logdir / f"{app}.log").open("ab")
        procs.append(subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "-p", str(port)],
                                      cwd=app_dir, env=env, stdout=logf, stderr=subprocess.STDOUT,
                                      **e2e._SESSION_KW))
    with httpx.Client(timeout=2) as c:
        for _, port in APPS:
            for _ in range(60):
                try:
                    c.get(f"http://localhost:{port}/")
                    break
                except httpx.HTTPError:
                    time.sleep(1)
    return procs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-apps", action="store_true", help="do not start the three web apps")
    args = ap.parse_args()

    workdir = Path(tempfile.mkdtemp(prefix="ci-demo-"))
    (workdir / "logs").mkdir(parents=True)
    stack = DemoStack(workdir, None)
    apps: list[subprocess.Popen[bytes]] = []
    try:
        log("• subindo barramento de eventos e serviços (memória)…")
        missing = [s.path for s in SERVICES if s.kind == "node" and not (REPO / s.path / "dist/index.js").exists()]
        if missing:
            raise RuntimeError(f"not built: {missing} — run `pnpm turbo run build` first")
        stack.start("dev-event-bus")
        names = [s.name for s in SERVICES if s.name != "identity"]
        for n in names:
            stack.start(n)
        stack.wait_healthy(["dev-event-bus", *names])
        ctx = seed(stack)
        env = write_env(stack, ctx)
        if not args.no_apps:
            log("• iniciando os apps web…")
            apps = start_apps(env, workdir / "logs")
        log("\n=== Demo pronta (Ctrl+C para parar) ===")
        log("Aluno      http://localhost:3000")
        log("Professor  http://localhost:3001")
        log("Admin      http://localhost:3002")
        log("Logins de demonstração: tests/demo/README.md")
        log(f"Logs: {workdir / 'logs'}")
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # noqa: BLE001
        log(f"\nFALHOU: {exc}")
        for name in stack.procs:
            tail = stack.log_tail(name, 8)
            if "Error" in tail or "Traceback" in tail:
                log(f"--- {name} ---\n{tail}")
        return 1
    finally:
        for p in apps:
            if p.poll() is None:
                p.terminate()
        stack.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
