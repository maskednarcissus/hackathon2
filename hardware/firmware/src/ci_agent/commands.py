"""Remote commands (phase-4 contract §3).

device-management hands pending commands to the device in the heartbeat response
(``{"commands": [{commandId, type, issuedAt, expiresAt}]}``). The agent runs them one at a
time and reports ``POST /v1/devices/{id}/commands/{commandId}/result`` (signed).

Guarantees:

* **At most one command runs at a time** (non-blocking lock; queued commands wait).
* **Expired commands are ignored** — checked on receipt and again right before running.
* **Each command id runs at most once**, even though the server re-delivers unanswered
  commands: ids are remembered in a small state file that survives restarts.
* **Results are never lost**: they go to an outbox that is retried until the server accepts
  them (``404``/``409`` mean the server already has an answer, so the entry is dropped).
* **Reboot is safe**: the command is persisted as in-progress before acting, so after the
  restart it is reported as succeeded instead of being executed again (no reboot loops).
"""

from __future__ import annotations

import array
import logging
import math
import shlex
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from ci_agent.fsutil import atomic_write_json, read_json
from ci_agent.recorder import AudioSource
from ci_agent.timeutil import parse_iso, to_iso, utcnow

log = logging.getLogger(__name__)

COMMAND_TYPES = ("reboot", "self_test", "upload_now", "refresh_plan", "rotate_logs")
MAX_REMEMBERED_IDS = 500
MAX_OUTPUT_CHARS = 9_000
GIB = 1024**3

ResultStatus = Literal["succeeded", "failed"]


@dataclass(frozen=True)
class Command:
    command_id: str
    type: str
    expires_at: datetime
    issued_at: datetime | None = None

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> Command:
        issued = data.get("issuedAt")
        return cls(
            command_id=str(data["commandId"]),
            type=str(data["type"]),
            expires_at=parse_iso(str(data["expiresAt"])),
            issued_at=parse_iso(str(issued)) if issued else None,
        )


@dataclass(frozen=True)
class CommandResult:
    status: ResultStatus
    output: dict[str, Any] | str | None = None


Handler = Callable[[Command], CommandResult]


class ResultReporter(Protocol):
    def command_result(self, command_id: str, payload: dict[str, Any]) -> None: ...


class ReportRejected(Exception):
    """The server will never accept this result (e.g. it already has one)."""


@dataclass
class _State:
    seen: deque[str] = field(default_factory=lambda: deque(maxlen=MAX_REMEMBERED_IDS))
    outbox: list[dict[str, Any]] = field(default_factory=list)
    in_progress: dict[str, Any] | None = None


class CommandRunner:
    def __init__(
        self,
        handlers: Mapping[str, Handler],
        reporter: ResultReporter,
        state_path: Path,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.handlers = dict(handlers)
        self.reporter = reporter
        self.state_path = state_path
        self.clock = clock
        self._queue: deque[Command] = deque()
        self._run_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._state = self._load()
        self.running: Command | None = None
        self._recover_interrupted()

    # ------------------------------------------------------------ state
    def _load(self) -> _State:
        state = _State()
        if not self.state_path.exists():
            return state
        try:
            data = read_json(self.state_path)
            state.seen.extend(str(i) for i in data.get("seen", []))
            state.outbox = list(data.get("outbox", []))
            state.in_progress = data.get("inProgress")
        except (OSError, ValueError) as exc:
            log.error("command state unreadable (%s); starting fresh", exc)
        return state

    def _save(self) -> None:
        with self._state_lock:
            atomic_write_json(
                self.state_path,
                {
                    "seen": list(self._state.seen),
                    "outbox": self._state.outbox,
                    "inProgress": self._state.in_progress,
                },
                mode=0o600,
            )

    def _recover_interrupted(self) -> None:
        """A command that was running when the agent stopped is answered, never re-run."""
        current = self._state.in_progress
        if not current:
            return
        now = to_iso(self.clock())
        if current.get("type") == "reboot":
            result = CommandResult("succeeded", {"rebooted": True, "agentStartedAt": now})
        else:
            result = CommandResult("failed", "agent restarted while the command was running")
        self._state.in_progress = None
        self._enqueue_result(str(current["commandId"]), result, now)

    def _enqueue_result(self, command_id: str, result: CommandResult, finished_at: str) -> None:
        payload: dict[str, Any] = {"status": result.status, "finishedAt": finished_at}
        if result.output is not None:
            payload["output"] = _bounded(result.output)
        with self._state_lock:
            self._state.outbox = [e for e in self._state.outbox if e["commandId"] != command_id]
            self._state.outbox.append({"commandId": command_id, "payload": payload})
            self._save()

    @property
    def outbox(self) -> list[dict[str, Any]]:
        with self._state_lock:
            return [dict(e) for e in self._state.outbox]

    @property
    def queued(self) -> list[Command]:
        return list(self._queue)

    # ------------------------------------------------------------ intake
    def submit(self, commands: Iterable[Mapping[str, Any]]) -> list[str]:
        """Accept commands from a heartbeat response; returns the ids newly queued."""
        accepted: list[str] = []
        now = self.clock()
        with self._state_lock:
            for raw in commands:
                try:
                    command = Command.from_json(raw)
                except (KeyError, ValueError, TypeError) as exc:
                    log.warning("ignoring malformed command %r: %s", raw, exc)
                    continue
                if command.command_id in self._state.seen:
                    continue  # re-delivery of a command already queued, running or answered
                self._state.seen.append(command.command_id)
                if command.expires_at <= now:
                    log.info("ignoring expired command %s (%s)", command.command_id, command.type)
                    continue
                self._queue.append(command)
                accepted.append(command.command_id)
            if accepted:
                self._save()
        return accepted

    # ------------------------------------------------------------ execution
    def run_next(self) -> CommandResult | None:
        """Run the oldest queued command unless one is already running."""
        if not self._run_lock.acquire(blocking=False):
            return None
        try:
            while self._queue:
                command = self._queue.popleft()
                if command.expires_at <= self.clock():
                    log.info("command %s expired while queued; skipped", command.command_id)
                    continue
                return self._execute(command)
            return None
        finally:
            self._run_lock.release()

    def _execute(self, command: Command) -> CommandResult:
        handler = self.handlers.get(command.type)
        with self._state_lock:
            self._state.in_progress = {
                "commandId": command.command_id,
                "type": command.type,
                "startedAt": to_iso(self.clock()),
            }
            self._save()  # persisted *before* acting (reboot must not loop)
        self.running = command
        log.info("running command %s (%s)", command.command_id, command.type)
        try:
            if handler is None:
                result = CommandResult("failed", f"unsupported command type: {command.type}")
            else:
                result = handler(command)
        except Exception as exc:  # a failing command must not kill the agent
            log.exception("command %s failed", command.command_id)
            result = CommandResult("failed", f"{type(exc).__name__}: {exc}")
        finally:
            self.running = None
        with self._state_lock:
            self._state.in_progress = None
            self._enqueue_result(command.command_id, result, to_iso(self.clock()))
        self.flush_outbox()
        return result

    def run_pending(self) -> int:
        """Run queued commands one after another; returns how many ran."""
        ran = 0
        while self._queue:
            if self.run_next() is None:
                break
            ran += 1
        return ran

    def flush_outbox(self) -> int:
        """Report stored results; returns how many the server accepted."""
        delivered = 0
        for entry in self.outbox:
            try:
                self.reporter.command_result(entry["commandId"], entry["payload"])
            except ReportRejected as exc:
                log.warning("result for %s rejected: %s (dropped)", entry["commandId"], exc)
            except Exception as exc:
                log.warning("could not report result for %s: %s", entry["commandId"], exc)
                continue
            else:
                delivered += 1
            with self._state_lock:
                self._state.outbox = [
                    e for e in self._state.outbox if e["commandId"] != entry["commandId"]
                ]
                self._save()
        return delivered


def _bounded(output: dict[str, Any] | str) -> dict[str, Any] | str:
    if isinstance(output, str) and len(output) > MAX_OUTPUT_CHARS:
        return output[-MAX_OUTPUT_CHARS:]
    return output


# ================================================================ handlers


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str


def run_process(argv: Sequence[str], timeout_s: float) -> ProcessResult:
    try:
        done = subprocess.run(
            list(argv), capture_output=True, text=True, timeout=timeout_s, check=False
        )
    except FileNotFoundError as exc:
        return ProcessResult(127, "", str(exc))
    except subprocess.TimeoutExpired:
        return ProcessResult(124, "", f"timed out after {timeout_s:.0f}s")
    return ProcessResult(done.returncode, done.stdout, done.stderr)


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    latency_ms: int | None = None
    error: str | None = None


def http_probe(url: str, timeout_s: float = 5.0) -> ProbeResult:
    import httpx

    started = time.monotonic()
    try:
        response = httpx.get(f"{url.rstrip('/')}/health", timeout=timeout_s)
    except httpx.HTTPError as exc:
        return ProbeResult(False, None, f"{type(exc).__name__}: {exc}")
    latency = int((time.monotonic() - started) * 1000)
    if response.status_code >= 500:
        return ProbeResult(False, latency, f"HTTP {response.status_code}")
    return ProbeResult(True, latency)


def measure_mic(
    source_factory: Callable[[], AudioSource],
    duration_s: float,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Short capture through the same ``AudioSource`` the recorder uses."""
    source = source_factory()
    target = int(source.sample_rate * source.channels * 2 * duration_s)
    chunks: list[bytes] = []
    received = 0
    source.open()
    try:
        deadline = monotonic() + duration_s + 3.0
        while received < target and monotonic() < deadline:
            data = source.read(min(32 * 1024, target - received))
            if not data:
                sleep(0.02)
                continue
            chunks.append(data)
            received += len(data)
    finally:
        source.close()
    pcm = b"".join(chunks)
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return {"bytes": 0, "levelDbfs": None, "peakDbfs": None, "clippingRatio": None}
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    peak = max(abs(s) for s in samples)
    clipped = sum(1 for s in samples if s >= 32767 or s <= -32768)
    return {
        "bytes": received,
        "expectedBytes": target,
        "levelDbfs": round(_dbfs(rms), 1),
        "peakDbfs": round(_dbfs(peak), 1),
        "clippingRatio": round(clipped / len(samples), 5),
    }


def _dbfs(value: float) -> float:
    return 20 * math.log10(value / 32768) if value > 0 else -120.0


def rotate_file_logs(logger: logging.Logger | None = None) -> dict[str, Any]:
    """Roll over every rotating file handler on the root logger."""
    from logging.handlers import RotatingFileHandler, TimedRotatingFileHandler

    root = logger or logging.getLogger()
    rotated: list[str] = []
    for handler in root.handlers:
        if isinstance(handler, RotatingFileHandler | TimedRotatingFileHandler):
            handler.doRollover()
            rotated.append(handler.baseFilename)
    return {"rotated": rotated}


@dataclass
class CommandDeps:
    data_dir: Path
    source_factory: Callable[[], AudioSource]
    recorder_active: Callable[[], bool]
    before_reboot: Callable[[], None]
    upload_now: Callable[[], dict[str, Any]]
    refresh_plan: Callable[[], tuple[bool, str | None]]
    clock_skew_ms: Callable[[], int]
    probe_urls: Mapping[str, str]
    reboot_command: Sequence[str] = ("systemctl", "reboot")
    rotate_logs_command: Sequence[str] = ()
    run_process: Callable[[Sequence[str], float], ProcessResult] = run_process
    probe: Callable[[str], ProbeResult] = http_probe
    rotate_logs: Callable[[], dict[str, Any]] = rotate_file_logs
    command_timeout_s: float = 60.0
    self_test_capture_s: float = 2.0
    min_mic_dbfs: float = -60.0
    min_free_bytes: int = GIB
    max_clock_skew_ms: int = 5_000
    disk_usage: Callable[[Path], Any] = shutil.disk_usage


def parse_command_line(value: str) -> tuple[str, ...]:
    return tuple(shlex.split(value))


def build_handlers(deps: CommandDeps) -> dict[str, Handler]:
    def reboot(_: Command) -> CommandResult:
        try:
            deps.before_reboot()  # finalize the live recording so no audio is lost
        except Exception as exc:
            log.warning("pre-reboot cleanup failed: %s", exc)
        done = deps.run_process(deps.reboot_command, deps.command_timeout_s)
        if done.returncode != 0:
            return CommandResult(
                "failed",
                {"returncode": done.returncode, "stderr": done.stderr.strip()[-2000:]},
            )
        return CommandResult("succeeded", {"rebootRequested": True})

    def self_test(_: Command) -> CommandResult:
        checks: dict[str, dict[str, Any]] = {}

        if deps.recorder_active():
            # The capture device is busy with a class; never interrupt it for a test.
            checks["microphone"] = {"ok": None, "skipped": "recording_in_progress"}
        else:
            try:
                mic = measure_mic(deps.source_factory, deps.self_test_capture_s)
                level = mic["levelDbfs"]
                complete = mic["bytes"] >= 0.5 * mic.get("expectedBytes", 1)
                ok = bool(complete and level is not None and level >= deps.min_mic_dbfs)
                checks["microphone"] = {"ok": ok, **mic}
            except Exception as exc:
                checks["microphone"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        try:
            usage = deps.disk_usage(deps.data_dir)
            probe_file = deps.data_dir / ".self-test"
            probe_file.write_bytes(b"ok")
            probe_file.unlink()
            checks["disk"] = {
                "ok": usage.free >= deps.min_free_bytes,
                "freeBytes": usage.free,
                "totalBytes": usage.total,
                "writable": True,
            }
        except OSError as exc:
            checks["disk"] = {"ok": False, "writable": False, "error": str(exc)}

        skew = deps.clock_skew_ms()
        checks["clock"] = {"ok": abs(skew) <= deps.max_clock_skew_ms, "skewMs": skew}

        network: dict[str, Any] = {}
        for name, url in deps.probe_urls.items():
            result = deps.probe(url)
            network[name] = {"ok": result.ok, "latencyMs": result.latency_ms}
            if result.error:
                network[name]["error"] = result.error
        checks["network"] = {"ok": all(v["ok"] for v in network.values()), "targets": network}

        passed = all(c["ok"] is not False for c in checks.values())
        return CommandResult("succeeded" if passed else "failed", {"checks": checks})

    def upload_now(_: Command) -> CommandResult:
        return CommandResult("succeeded", deps.upload_now())

    def refresh_plan(_: Command) -> CommandResult:
        ok, error = deps.refresh_plan()
        if ok:
            return CommandResult("succeeded", {"planRefreshed": True})
        return CommandResult("failed", {"planRefreshed": False, "error": error})

    def rotate_logs(_: Command) -> CommandResult:
        output = deps.rotate_logs()
        if deps.rotate_logs_command:
            done = deps.run_process(deps.rotate_logs_command, deps.command_timeout_s)
            output["command"] = {"returncode": done.returncode, "stderr": done.stderr[-2000:]}
            if done.returncode != 0:
                return CommandResult("failed", output)
        return CommandResult("succeeded", output)

    return {
        "reboot": reboot,
        "self_test": self_test,
        "upload_now": upload_now,
        "refresh_plan": refresh_plan,
        "rotate_logs": rotate_logs,
    }
