from __future__ import annotations

import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx

from ci_agent.agent import Agent, AgentSettings
from ci_agent.api import IngestionApi
from ci_agent.identity import DeviceIdentity
from ci_agent.recorder import FakeSource, Recorder
from ci_agent.scheduler import ClockGuard, PlanStore
from ci_agent.spool import Spool
from ci_agent.timeutil import to_iso
from ci_agent.uploader import Uploader

from .conftest import T0, Clock, FakeIngestion


class FakeDeviceManagement:
    def __init__(self, windows: list[dict[str, Any]]) -> None:
        self.windows = windows
        self.heartbeats: list[dict[str, Any]] = []
        self.offline = False

    def recording_plan(self, start: Any, end: Any) -> tuple[dict[str, Any], str | None]:
        if self.offline:
            raise httpx.ConnectError("offline")
        return (
            {"classroomId": "room", "generatedAt": to_iso(T0), "windows": self.windows},
            None,
        )

    def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.offline:
            raise httpx.ConnectError("offline")
        self.heartbeats.append(payload)
        return {}


def build(
    tmp_path: Path, clock: Clock, identity: DeviceIdentity
) -> tuple[Agent, FakeDeviceManagement, FakeIngestion]:
    dm = FakeDeviceManagement(
        [
            {
                "scheduledClassId": "class-A",
                "recordStartAt": to_iso(T0 + timedelta(minutes=10)),
                "recordStopAt": to_iso(T0 + timedelta(minutes=20)),
                "recordingEnabled": True,
            }
        ]
    )
    fake = FakeIngestion(identity, "dev-1")
    ingestion = IngestionApi(
        "http://i", identity, "dev-1", transport=httpx.MockTransport(fake.handler), clock=clock
    )
    spool = Spool(tmp_path / "spool", 10**9, 10**9)
    recorder = Recorder(spool, lambda: FakeSource(total_bytes=3200), clock=clock)
    agent = Agent(
        AgentSettings(device_id="dev-1", firmware_version="1.0.0", data_dir=tmp_path),
        plan_client=dm,
        event_client=ingestion,
        plans=PlanStore(tmp_path / "plan.json", 300),
        clock_guard=ClockGuard(120),
        spool=spool,
        recorder=recorder,
        uploader=Uploader(
            ingestion, spool, "dev-1", "1.0.0", 1024, sleep=lambda _: None, clock=clock
        ),
        clock=clock,
    )
    return agent, dm, fake


def test_full_cycle_record_upload_heartbeat(
    tmp_path: Path, clock: Clock, identity: DeviceIdentity
) -> None:
    agent, dm, fake = build(tmp_path, clock, identity)
    agent.tick()
    assert agent.state.action == "idle" and agent.recorder.active is None
    assert dm.heartbeats and dm.heartbeats[0]["isRecording"] is False

    clock.now = T0 + timedelta(minutes=10)
    agent.tick()
    assert agent.recorder.active_scheduled_class_id == "class-A"
    time.sleep(0.05)

    dm.offline = True  # connectivity lost during class: keeps recording from cached plan
    clock.now = T0 + timedelta(minutes=15)
    agent.tick()
    assert agent.recorder.active is not None
    payload = agent.heartbeat_payload()
    assert payload["isRecording"] is True
    assert payload["currentScheduledClassId"] == "class-A"
    assert payload["diskFreeBytes"] > 0

    clock.now = T0 + timedelta(minutes=20)
    agent.tick()
    assert agent.recorder.active is None
    assert [e["type"] for e in fake.events] == ["recording.started", "recording.stopped"]
    assert len(fake.uploads) == 1
    (entry,) = agent.spool.entries()
    assert entry.state == "uploaded"


def test_restart_uses_cached_plan_while_offline(
    tmp_path: Path, clock: Clock, identity: DeviceIdentity
) -> None:
    agent, dm, _ = build(tmp_path, clock, identity)
    agent.tick()
    agent2, dm2, _ = build(tmp_path, clock, identity)
    dm2.offline = True
    clock.now = T0 + timedelta(minutes=11)
    agent2.tick()
    assert agent2.recorder.active_scheduled_class_id == "class-A"
    agent2.recorder.stop()
