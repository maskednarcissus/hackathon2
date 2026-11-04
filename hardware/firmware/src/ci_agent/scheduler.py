"""Policy-driven recording schedule (contract §4) — pure decision logic + plan cache.

Rules
-----
* A window is *active* when ``recordStartAt <= now < recordStopAt``.
* Among active windows the one with the **latest** ``recordStartAt`` wins: when the
  post-roll of class A overlaps the pre-roll of class B, the device rotates the file
  at B's ``recordStartAt`` so each recording maps to exactly one scheduled class.
* An active window with ``recordingEnabled=false`` (policy/consent) forces idle and
  is reported as the reason; it also pre-empts an older enabled window.
* With no usable plan the device stays idle (it never records unscheduled audio).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Literal

from ci_agent.fsutil import atomic_write_json, read_json
from ci_agent.timeutil import parse_iso, to_iso

log = logging.getLogger(__name__)

Action = Literal["record", "idle"]


@dataclass(frozen=True)
class RecordingWindow:
    scheduled_class_id: str
    record_start_at: datetime
    record_stop_at: datetime
    recording_enabled: bool = True
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    class_section_id: str | None = None
    course_id: str | None = None
    professor_id: str | None = None
    recording_policy_id: str | None = None

    def is_active(self, now: datetime) -> bool:
        return self.record_start_at <= now < self.record_stop_at

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> RecordingWindow:
        def opt_dt(key: str) -> datetime | None:
            value = data.get(key)
            return parse_iso(value) if isinstance(value, str) else None

        window = cls(
            scheduled_class_id=str(data["scheduledClassId"]),
            record_start_at=parse_iso(data["recordStartAt"]),
            record_stop_at=parse_iso(data["recordStopAt"]),
            recording_enabled=bool(data.get("recordingEnabled", True)),
            starts_at=opt_dt("startsAt"),
            ends_at=opt_dt("endsAt"),
            class_section_id=data.get("classSectionId"),
            course_id=data.get("courseId"),
            professor_id=data.get("professorId"),
            recording_policy_id=data.get("recordingPolicyId"),
        )
        if window.record_stop_at <= window.record_start_at:
            raise ValueError(f"window {window.scheduled_class_id} has stop <= start")
        return window

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "scheduledClassId": self.scheduled_class_id,
            "recordStartAt": to_iso(self.record_start_at),
            "recordStopAt": to_iso(self.record_stop_at),
            "recordingEnabled": self.recording_enabled,
            "classSectionId": self.class_section_id,
            "courseId": self.course_id,
            "professorId": self.professor_id,
            "recordingPolicyId": self.recording_policy_id,
        }
        if self.starts_at:
            out["startsAt"] = to_iso(self.starts_at)
        if self.ends_at:
            out["endsAt"] = to_iso(self.ends_at)
        return out


@dataclass(frozen=True)
class RecordingPlan:
    classroom_id: str
    generated_at: datetime
    timezone: str
    windows: tuple[RecordingWindow, ...] = field(default_factory=tuple)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> RecordingPlan:
        windows: list[RecordingWindow] = []
        for raw in data.get("windows", []):
            try:
                windows.append(RecordingWindow.from_json(raw))
            except (KeyError, ValueError) as exc:
                log.warning("skipping invalid plan window: %s", exc)
        return cls(
            classroom_id=str(data["classroomId"]),
            generated_at=parse_iso(data["generatedAt"]),
            timezone=str(data.get("timezone", "America/Sao_Paulo")),
            windows=tuple(sorted(windows, key=lambda w: w.record_start_at)),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "classroomId": self.classroom_id,
            "generatedAt": to_iso(self.generated_at),
            "timezone": self.timezone,
            "windows": [w.to_json() for w in self.windows],
        }

    def next_window(self, now: datetime) -> RecordingWindow | None:
        upcoming = [w for w in self.windows if w.record_start_at > now and w.recording_enabled]
        return upcoming[0] if upcoming else None


@dataclass(frozen=True)
class DesiredState:
    action: Action
    window: RecordingWindow | None
    reason: str

    @property
    def scheduled_class_id(self) -> str | None:
        return self.window.scheduled_class_id if self.window else None


def desired_state(plan: RecordingPlan | None, now: datetime) -> DesiredState:
    if plan is None:
        return DesiredState("idle", None, "no_plan")
    active = [w for w in plan.windows if w.is_active(now)]
    if not active:
        return DesiredState("idle", None, "outside_windows")
    current = max(active, key=lambda w: (w.record_start_at, w.scheduled_class_id))
    if not current.recording_enabled:
        return DesiredState("idle", current, "recording_disabled_by_policy")
    return DesiredState("record", current, "scheduled_class")


class ClockGuard:
    """Tracks the offset between the device clock and the server clock.

    The offset is learned from the HTTP ``Date`` header of plan responses. When the
    skew exceeds ``max_skew_s`` the scheduler uses server-corrected time so classes are
    not missed because of a drifting RTC (e.g. no NTP after a power cut).
    """

    def __init__(self, max_skew_s: float) -> None:
        self.max_skew = timedelta(seconds=max_skew_s)
        self.offset = timedelta(0)

    def observe(self, server_date_header: str | None, local_now: datetime) -> None:
        if not server_date_header:
            return
        try:
            server_now = parsedate_to_datetime(server_date_header)
        except (TypeError, ValueError):
            return
        skew = server_now - local_now
        if abs(skew) > self.max_skew:
            log.warning("clock skew %.1fs exceeds limit; correcting", skew.total_seconds())
            self.offset = skew
        else:
            self.offset = timedelta(0)

    @property
    def skew_ms(self) -> int:
        return int(self.offset.total_seconds() * 1000)

    def corrected(self, local_now: datetime) -> datetime:
        return local_now + self.offset


class PlanStore:
    """Persists the last good plan so the device keeps recording while offline."""

    def __init__(self, path: Path, refresh_interval_s: float) -> None:
        self.path = path
        self.refresh_interval = timedelta(seconds=refresh_interval_s)
        self.plan: RecordingPlan | None = None
        self.fetched_at: datetime | None = None
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = read_json(self.path)
            self.plan = RecordingPlan.from_json(data["plan"])
            self.fetched_at = parse_iso(data["fetchedAt"])
        except (OSError, ValueError, KeyError, TypeError) as exc:
            log.error("discarding corrupt plan cache %s: %s", self.path, exc)
            self.plan = None
            self.fetched_at = None

    def needs_refresh(self, now: datetime) -> bool:
        return self.fetched_at is None or now - self.fetched_at >= self.refresh_interval

    def update(self, plan: RecordingPlan, fetched_at: datetime) -> None:
        self.plan = plan
        self.fetched_at = fetched_at
        atomic_write_json(self.path, {"fetchedAt": to_iso(fetched_at), "plan": plan.to_json()})
