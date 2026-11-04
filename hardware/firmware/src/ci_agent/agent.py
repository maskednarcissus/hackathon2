"""Agent main loop: plan refresh, recorder reconciliation, heartbeat, upload."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from ci_agent.heartbeat import HeartbeatContext, build_heartbeat
from ci_agent.recorder import Recorder
from ci_agent.scheduler import ClockGuard, DesiredState, PlanStore, RecordingPlan, desired_state
from ci_agent.spool import Spool
from ci_agent.timeutil import to_iso, utcnow
from ci_agent.uploader import Uploader

log = logging.getLogger(__name__)


class PlanClient(Protocol):
    def recording_plan(
        self, start: datetime, end: datetime
    ) -> tuple[dict[str, Any], str | None]: ...

    def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class EventClient(Protocol):
    def recording_event(self, payload: dict[str, Any]) -> None: ...


@dataclass
class AgentSettings:
    device_id: str
    firmware_version: str
    data_dir: Path
    plan_horizon: timedelta = timedelta(hours=36)
    heartbeat_interval: timedelta = timedelta(seconds=60)
    upload_interval: timedelta = timedelta(seconds=30)
    uploaded_retention: timedelta = timedelta(hours=24)
    reconcile_interval_s: float = 1.0


class Agent:
    def __init__(
        self,
        settings: AgentSettings,
        plan_client: PlanClient,
        event_client: EventClient,
        plans: PlanStore,
        clock_guard: ClockGuard,
        spool: Spool,
        recorder: Recorder,
        uploader: Uploader,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.settings = settings
        self.plan_client = plan_client
        self.event_client = event_client
        self.plans = plans
        self.clock_guard = clock_guard
        self.spool = spool
        self.recorder = recorder
        self.uploader = uploader
        self.clock = clock
        self.last_heartbeat_at: datetime | None = None
        self.last_upload_at: datetime | None = None
        self.last_error: str | None = None
        self.state: DesiredState = desired_state(None, clock())

    def now(self) -> datetime:
        return self.clock_guard.corrected(self.clock())

    # --------------------------------------------------------------- plan
    def refresh_plan(self, force: bool = False) -> bool:
        local_now = self.clock()
        if not force and not self.plans.needs_refresh(local_now):
            return False
        now = self.clock_guard.corrected(local_now)
        try:
            data, date_header = self.plan_client.recording_plan(
                now - timedelta(hours=1), now + self.settings.plan_horizon
            )
            self.clock_guard.observe(date_header, local_now)
            self.plans.update(RecordingPlan.from_json(data), local_now)
            return True
        except Exception as exc:  # offline: keep using the cached plan
            self.last_error = f"plan refresh failed: {exc}"
            log.warning("%s (using cached plan)", self.last_error)
            return False

    # --------------------------------------------------------------- recorder
    def reconcile(self) -> DesiredState:
        now = self.now()
        target = desired_state(self.plans.plan, now)
        self.state = target
        active = self.recorder.active
        want_class = target.scheduled_class_id if target.action == "record" else None
        if active is not None and (
            target.action != "record" or active.scheduled_class_id != want_class
        ):
            finished = self.recorder.stop()
            if finished:
                self._event(
                    "recording.stopped",
                    finished.local_recording_id,
                    finished.scheduled_class_id,
                    now,
                )
        if target.action == "record" and self.recorder.active is None:
            plan = self.plans.plan
            assert plan is not None
            try:
                entry = self.recorder.start(plan.classroom_id, want_class)
            except Exception as exc:
                self.last_error = f"recorder start failed: {exc}"
                log.exception("could not start recording")
                return target
            self._event("recording.started", entry.local_recording_id, want_class, now)
        return target

    def _event(
        self, kind: str, local_recording_id: str, scheduled_class_id: str | None, at: datetime
    ) -> None:
        payload: dict[str, Any] = {
            "type": kind,
            "deviceId": self.settings.device_id,
            "localRecordingId": local_recording_id,
            "scheduledClassId": scheduled_class_id,
            "at": to_iso(at),
        }
        try:
            self.event_client.recording_event(payload)
        except Exception as exc:  # best-effort; metadata upload carries the truth
            log.warning("could not report %s: %s", kind, exc)

    # --------------------------------------------------------------- heartbeat
    def heartbeat_payload(self) -> dict[str, Any]:
        ctx = HeartbeatContext(
            firmware_version=self.settings.firmware_version,
            is_recording=self.recorder.active is not None,
            current_scheduled_class_id=self.recorder.active_scheduled_class_id,
            plan_fetched_at=self.plans.fetched_at,
            clock_skew_ms=self.clock_guard.skew_ms,
            last_error=self.last_error or self.recorder.last_error,
        )
        return build_heartbeat(self.now(), self.settings.data_dir, self.spool.stats(), ctx)

    def send_heartbeat(self, force: bool = False) -> bool:
        now = self.clock()
        due = self.last_heartbeat_at is None or (
            now - self.last_heartbeat_at >= self.settings.heartbeat_interval
        )
        if not (force or due):
            return False
        try:
            self.plan_client.heartbeat(self.heartbeat_payload())
            self.last_heartbeat_at = now
            return True
        except Exception as exc:
            log.warning("heartbeat failed: %s", exc)
            return False

    # --------------------------------------------------------------- upload
    def upload(self, force: bool = False) -> None:
        now = self.clock()
        due = self.last_upload_at is None or (
            now - self.last_upload_at >= self.settings.upload_interval
        )
        if not (force or due):
            return
        self.last_upload_at = now
        self.uploader.upload_pending()
        self.spool.purge_uploaded(now, self.settings.uploaded_retention)
        self.spool.enforce_quota()

    def tick(self) -> None:
        """One synchronous iteration (used by tests and the async loop)."""
        self.refresh_plan()
        self.reconcile()
        self.send_heartbeat()
        self.upload()

    # --------------------------------------------------------------- async
    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        await asyncio.to_thread(self.refresh_plan, True)

        async def loop(fn: Callable[[], object], interval: float) -> None:
            while not stop.is_set():
                try:
                    await asyncio.to_thread(fn)
                except Exception:
                    log.exception("agent task %s failed", getattr(fn, "__name__", fn))
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=interval)

        tasks = [
            asyncio.create_task(loop(self.refresh_plan, 15.0)),
            asyncio.create_task(loop(self.reconcile, self.settings.reconcile_interval_s)),
            asyncio.create_task(loop(self.send_heartbeat, 5.0)),
            asyncio.create_task(loop(self.upload, 5.0)),
        ]
        await stop.wait()
        await asyncio.gather(*tasks)
        finished = self.recorder.stop()
        if finished:
            log.info("agent stopping; finalized %s", finished.local_recording_id)
