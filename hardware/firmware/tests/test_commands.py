from __future__ import annotations

import json
import logging
import logging.handlers
import threading
from collections import namedtuple
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from ci_agent.api import DeviceManagementApi
from ci_agent.commands import (
    Command,
    CommandDeps,
    CommandResult,
    CommandRunner,
    ProbeResult,
    ProcessResult,
    ReportRejected,
    build_handlers,
    measure_mic,
    rotate_file_logs,
)
from ci_agent.identity import HEADER_SIGNATURE, HEADER_TIMESTAMP, DeviceIdentity, verify_signature
from ci_agent.recorder import FakeSource
from ci_agent.timeutil import to_iso

from .conftest import T0, Clock
from .test_agent import build

Usage = namedtuple("Usage", "total used free")
GIB = 1024**3


class FakeReporter:
    def __init__(self) -> None:
        self.results: list[tuple[str, dict[str, Any]]] = []
        self.fail_times = 0
        self.reject = False

    def command_result(self, command_id: str, payload: dict[str, Any]) -> None:
        if self.reject:
            raise ReportRejected("409 command_already_finished")
        if self.fail_times > 0:
            self.fail_times -= 1
            raise httpx.ConnectError("offline")
        self.results.append((command_id, payload))


class SilentSource(FakeSource):
    def read(self, max_bytes: int) -> bytes:
        data = super().read(max_bytes)
        return bytes(len(data))


def cmd(
    command_id: str, type_: str, expires_in: timedelta = timedelta(minutes=30)
) -> dict[str, Any]:
    return {
        "commandId": command_id,
        "type": type_,
        "issuedAt": to_iso(T0),
        "expiresAt": to_iso(T0 + expires_in),
    }


class Harness:
    def __init__(self, tmp_path: Path, clock: Clock) -> None:
        self.tmp_path = tmp_path
        self.clock = clock
        self.reporter = FakeReporter()
        self.processes: list[Sequence[str]] = []
        self.process_result = ProcessResult(0, "", "")
        self.recording = False
        self.reboot_prepared = 0
        self.probe_ok = True
        self.skew_ms = 0
        self.source_cls: type[FakeSource] = FakeSource
        self.uploads = 0
        self.plan_ok = True

    def run_process(self, argv: Sequence[str], _timeout: float) -> ProcessResult:
        self.processes.append(tuple(argv))
        return self.process_result

    def before_reboot(self) -> None:
        self.reboot_prepared += 1

    def upload_now(self) -> dict[str, Any]:
        self.uploads += 1
        return {"queuedBefore": 2, "queuedAfter": 0}

    def deps(self, **overrides: Any) -> CommandDeps:
        values: dict[str, Any] = {
            "data_dir": self.tmp_path,
            "source_factory": lambda: self.source_cls(total_bytes=None),
            "recorder_active": lambda: self.recording,
            "before_reboot": self.before_reboot,
            "upload_now": self.upload_now,
            "refresh_plan": lambda: (self.plan_ok, None if self.plan_ok else "plan refresh failed"),
            "clock_skew_ms": lambda: self.skew_ms,
            "probe_urls": {"deviceManagement": "http://dm", "ingestion": "http://in"},
            "run_process": self.run_process,
            "probe": lambda url: ProbeResult(self.probe_ok, 12, None if self.probe_ok else "down"),
            "disk_usage": lambda _p: Usage(32 * GIB, 12 * GIB, 20 * GIB),
            "self_test_capture_s": 0.25,
        }
        values.update(overrides)
        return CommandDeps(**values)

    def runner(self, **overrides: Any) -> CommandRunner:
        return CommandRunner(
            build_handlers(self.deps(**overrides)),
            self.reporter,
            self.tmp_path / "commands.json",
            clock=self.clock,
        )


@pytest.fixture
def h(tmp_path: Path, clock: Clock) -> Harness:
    return Harness(tmp_path, clock)


def test_self_test_reports_all_checks(h: Harness) -> None:
    runner = h.runner()
    assert runner.submit([cmd("c1", "self_test")]) == ["c1"]
    assert runner.run_pending() == 1
    ((command_id, payload),) = h.reporter.results
    assert command_id == "c1"
    assert payload["status"] == "succeeded"
    assert payload["finishedAt"] == to_iso(T0)
    checks = payload["output"]["checks"]
    assert checks["microphone"]["ok"] is True
    assert -20 < checks["microphone"]["levelDbfs"] < -10  # 440 Hz tone at amplitude 8000
    assert checks["disk"] == {
        "ok": True,
        "freeBytes": 20 * GIB,
        "totalBytes": 32 * GIB,
        "writable": True,
    }
    assert checks["clock"] == {"ok": True, "skewMs": 0}
    assert checks["network"]["targets"]["ingestion"] == {"ok": True, "latencyMs": 12}


def test_self_test_fails_on_silent_mic_skew_and_network(h: Harness) -> None:
    h.source_cls = SilentSource
    h.skew_ms = 90_000
    h.probe_ok = False
    runner = h.runner()
    runner.submit([cmd("c1", "self_test")])
    runner.run_pending()
    payload = h.reporter.results[0][1]
    assert payload["status"] == "failed"
    checks = payload["output"]["checks"]
    assert checks["microphone"]["ok"] is False
    assert checks["microphone"]["levelDbfs"] == -120.0
    assert checks["clock"]["ok"] is False
    assert checks["network"]["targets"]["deviceManagement"]["error"] == "down"


def test_self_test_never_interrupts_a_recording(h: Harness) -> None:
    h.recording = True
    opened: list[int] = []

    def factory() -> FakeSource:
        opened.append(1)
        return FakeSource()

    runner = h.runner(source_factory=factory)
    runner.submit([cmd("c1", "self_test")])
    runner.run_pending()
    payload = h.reporter.results[0][1]
    assert payload["status"] == "succeeded"
    assert payload["output"]["checks"]["microphone"] == {
        "ok": None,
        "skipped": "recording_in_progress",
    }
    assert opened == []


def test_redelivered_and_expired_commands_are_ignored(h: Harness, clock: Clock) -> None:
    runner = h.runner()
    assert runner.submit([cmd("c1", "upload_now"), cmd("c1", "upload_now")]) == ["c1"]
    runner.run_pending()
    assert runner.submit([cmd("c1", "upload_now")]) == []  # server re-delivers until answered
    assert h.uploads == 1

    clock.now = T0 + timedelta(minutes=31)
    assert runner.submit([cmd("old", "upload_now")]) == []

    # Expired while waiting in the queue.
    clock.now = T0
    runner.submit([cmd("short", "upload_now", timedelta(seconds=30))])
    clock.now = T0 + timedelta(minutes=1)
    assert runner.run_pending() == 0
    assert h.uploads == 1

    # Seen ids survive a restart.
    restarted = h.runner()
    assert restarted.submit([cmd("c1", "upload_now")]) == []


def test_never_runs_two_commands_at_once(h: Harness) -> None:
    started = threading.Event()
    release = threading.Event()
    concurrent = 0
    max_concurrent = 0
    lock = threading.Lock()

    def slow_upload() -> dict[str, Any]:
        nonlocal concurrent, max_concurrent
        with lock:
            concurrent += 1
            max_concurrent = max(max_concurrent, concurrent)
        started.set()
        release.wait(5)
        with lock:
            concurrent -= 1
        return {}

    runner = h.runner(upload_now=slow_upload)
    runner.submit([cmd("a", "upload_now"), cmd("b", "rotate_logs")])
    worker = threading.Thread(target=runner.run_next)
    worker.start()
    assert started.wait(5)
    assert runner.running is not None and runner.running.command_id == "a"
    assert runner.run_next() is None  # busy: the second command waits
    assert [c.command_id for c in runner.queued] == ["b"]
    release.set()
    worker.join(5)
    assert runner.run_pending() == 1
    assert [r[0] for r in h.reporter.results] == ["a", "b"]
    assert max_concurrent == 1


def test_reboot_finalizes_recording_and_runs_configured_command(h: Harness) -> None:
    runner = h.runner(reboot_command=("sudo", "-n", "/sbin/reboot"))
    runner.submit([cmd("r1", "reboot")])
    runner.run_pending()
    assert h.reboot_prepared == 1
    assert h.processes == [("sudo", "-n", "/sbin/reboot")]
    assert h.reporter.results[0][1]["status"] == "succeeded"


def test_reboot_failure_is_reported(h: Harness) -> None:
    h.process_result = ProcessResult(1, "", "Interactive authentication required.\n")
    runner = h.runner()
    runner.submit([cmd("r1", "reboot")])
    runner.run_pending()
    assert h.processes == [("systemctl", "reboot")]
    payload = h.reporter.results[0][1]
    assert payload["status"] == "failed"
    assert payload["output"]["stderr"] == "Interactive authentication required."


def test_reboot_that_kills_the_agent_is_answered_after_restart_not_rerun(
    h: Harness, clock: Clock
) -> None:
    class PowerCut(BaseException):
        pass

    def reboot_now(_argv: Sequence[str], _timeout: float) -> ProcessResult:
        raise PowerCut  # the process dies before it can report

    runner = h.runner(run_process=reboot_now)
    runner.submit([cmd("r1", "reboot")])
    with pytest.raises(PowerCut):
        runner.run_pending()
    assert h.reporter.results == []

    clock.now = T0 + timedelta(minutes=2)
    restarted = h.runner()
    assert restarted.outbox[0]["payload"]["status"] == "succeeded"
    assert restarted.submit([cmd("r1", "reboot")]) == []  # re-delivery must not reboot again
    assert restarted.flush_outbox() == 1
    (command_id, payload) = h.reporter.results[0]
    assert command_id == "r1"
    assert payload["output"] == {"rebooted": True, "agentStartedAt": to_iso(clock.now)}
    assert h.processes == []


def test_interrupted_non_reboot_command_is_reported_failed(h: Harness) -> None:
    state = h.tmp_path / "commands.json"
    state.write_text(
        json.dumps(
            {
                "seen": ["x"],
                "outbox": [],
                "inProgress": {"commandId": "x", "type": "self_test", "startedAt": to_iso(T0)},
            }
        )
    )
    runner = h.runner()
    runner.flush_outbox()
    assert h.reporter.results[0][1]["status"] == "failed"


def test_results_are_retried_until_delivered_and_dropped_when_rejected(h: Harness) -> None:
    h.reporter.fail_times = 2
    runner = h.runner()
    runner.submit([cmd("c1", "refresh_plan")])
    runner.run_pending()
    assert len(runner.outbox) == 1  # first report failed
    assert runner.flush_outbox() == 0
    assert h.runner().outbox  # persisted across restarts
    assert runner.flush_outbox() == 1
    assert runner.outbox == []

    h.reporter.reject = True
    runner.submit([cmd("c2", "refresh_plan")])
    runner.run_pending()
    assert runner.outbox == []


def test_refresh_plan_failure_and_unknown_type(h: Harness) -> None:
    h.plan_ok = False
    runner = h.runner()
    runner.submit([cmd("p", "refresh_plan"), cmd("u", "format_disk"), {"type": "broken"}])
    runner.run_pending()
    results = dict(h.reporter.results)
    assert results["p"]["status"] == "failed"
    assert results["p"]["output"]["error"] == "plan refresh failed"
    assert results["u"] == {
        "status": "failed",
        "finishedAt": to_iso(T0),
        "output": "unsupported command type: format_disk",
    }


def test_handler_exceptions_become_failed_results(h: Harness) -> None:
    def boom() -> dict[str, Any]:
        raise RuntimeError("spool locked")

    runner = h.runner(upload_now=boom)
    runner.submit([cmd("c1", "upload_now")])
    result = runner.run_next()
    assert result == CommandResult("failed", "RuntimeError: spool locked")


def test_rotate_logs_rolls_file_handlers_and_optional_command(h: Harness, tmp_path: Path) -> None:
    logger = logging.getLogger("ci-agent-test-rotate")
    handler = logging.handlers.RotatingFileHandler(tmp_path / "agent.log", backupCount=2)
    logger.addHandler(handler)
    try:
        logger.warning("hello")
        assert rotate_file_logs(logger) == {"rotated": [str(tmp_path / "agent.log")]}
        assert (tmp_path / "agent.log.1").exists()
    finally:
        logger.removeHandler(handler)
        handler.close()

    runner = h.runner(
        rotate_logs=lambda: {"rotated": []},
        rotate_logs_command=("logrotate", "--force", "/etc/logrotate.d/ci-agent"),
    )
    runner.submit([cmd("l", "rotate_logs")])
    runner.run_pending()
    assert h.processes == [("logrotate", "--force", "/etc/logrotate.d/ci-agent")]
    assert h.reporter.results[0][1]["status"] == "succeeded"


def test_measure_mic_handles_slow_and_empty_sources() -> None:
    result = measure_mic(lambda: FakeSource(total_bytes=0), 0.1, sleep=lambda _s: None)
    assert result["bytes"] == 0 and result["levelDbfs"] is None


def test_command_parsing() -> None:
    c = Command.from_json(cmd("x", "reboot"))
    assert c.expires_at == T0 + timedelta(minutes=30)
    assert c.issued_at == T0


def test_command_result_is_signed_and_conflicts_raise_rejected(identity: DeviceIdentity) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert verify_signature(
            identity.public_key,
            request.method,
            request.url.raw_path.decode(),
            request.headers[HEADER_TIMESTAMP],
            request.content,
            request.headers[HEADER_SIGNATURE],
        )
        if request.url.path.endswith("/c2/result"):
            return httpx.Response(409, json={"error": {"code": "command_already_finished"}})
        return httpx.Response(200, json={"commandId": "c1"})

    api = DeviceManagementApi(
        "http://dm", identity, "dev-1", transport=httpx.MockTransport(handler), clock=lambda: T0
    )
    api.command_result("c1", {"status": "succeeded", "finishedAt": to_iso(T0)})
    assert seen[0].url.path == "/v1/devices/dev-1/commands/c1/result"
    assert json.loads(seen[0].content) == {"status": "succeeded", "finishedAt": to_iso(T0)}
    with pytest.raises(ReportRejected):
        api.command_result("c2", {"status": "failed", "finishedAt": to_iso(T0)})


def test_agent_runs_commands_from_heartbeat_response(
    tmp_path: Path, clock: Clock, identity: DeviceIdentity
) -> None:
    agent, dm, _ = build(tmp_path, clock, identity)
    reporter = FakeReporter()
    agent.commands = CommandRunner(
        build_handlers(
            CommandDeps(
                data_dir=tmp_path,
                source_factory=FakeSource,
                recorder_active=lambda: agent.recorder.active is not None,
                before_reboot=agent.stop_recording_for_reboot,
                upload_now=agent.upload_now,
                refresh_plan=agent.refresh_plan_now,
                clock_skew_ms=lambda: agent.clock_guard.skew_ms,
                probe_urls={},
            )
        ),
        reporter,
        tmp_path / "commands.json",
        clock=agent.now,
    )
    responses = [{"commands": [cmd("u1", "upload_now"), cmd("p1", "refresh_plan")]}]

    def heartbeat(payload: dict[str, Any]) -> dict[str, Any]:
        dm.heartbeats.append(payload)
        return responses.pop(0) if responses else {"commands": []}

    dm.heartbeat = heartbeat  # type: ignore[method-assign]
    agent.tick()
    results = dict(reporter.results)
    assert results["u1"]["status"] == "succeeded"
    assert results["u1"]["output"] == {"queuedBefore": 0, "queuedAfter": 0, "queuedBytesAfter": 0}
    assert results["p1"] == {
        "status": "succeeded",
        "finishedAt": to_iso(T0),
        "output": {"planRefreshed": True},
    }
