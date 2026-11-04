from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

from ci_agent.scheduler import ClockGuard, PlanStore, RecordingPlan, desired_state
from ci_agent.timeutil import to_iso

from .conftest import T0


def window(cid: str, start_min: int, stop_min: int, enabled: bool = True) -> dict[str, Any]:
    return {
        "scheduledClassId": cid,
        "startsAt": to_iso(T0 + timedelta(minutes=start_min + 5)),
        "endsAt": to_iso(T0 + timedelta(minutes=stop_min - 5)),
        "recordStartAt": to_iso(T0 + timedelta(minutes=start_min)),
        "recordStopAt": to_iso(T0 + timedelta(minutes=stop_min)),
        "recordingPolicyId": "p",
        "recordingEnabled": enabled,
    }


def plan(*windows: dict[str, Any]) -> RecordingPlan:
    return RecordingPlan.from_json(
        {
            "classroomId": "room",
            "generatedAt": to_iso(T0),
            "timezone": "America/Sao_Paulo",
            "windows": list(windows),
        }
    )


def at(minutes: float) -> Any:
    return T0 + timedelta(minutes=minutes)


def test_no_plan_is_idle() -> None:
    assert desired_state(None, T0).action == "idle"
    assert desired_state(None, T0).reason == "no_plan"


def test_pre_and_post_roll_boundaries() -> None:
    p = plan(window("A", 0, 110))  # recordStart = class start - 5, recordStop = end + 5
    assert desired_state(p, at(-0.01)).action == "idle"
    assert desired_state(p, at(0)).action == "record"
    assert desired_state(p, at(0)).scheduled_class_id == "A"
    assert desired_state(p, at(109.99)).action == "record"
    assert desired_state(p, at(110)).action == "idle"  # stop is exclusive


def test_overlapping_windows_latest_start_wins() -> None:
    p = plan(window("A", 0, 110), window("B", 100, 200))
    assert desired_state(p, at(99)).scheduled_class_id == "A"
    assert desired_state(p, at(100)).scheduled_class_id == "B"
    assert desired_state(p, at(105)).scheduled_class_id == "B"


def test_adjacent_windows_switch_without_gap() -> None:
    p = plan(window("A", 0, 100), window("B", 100, 200))
    assert desired_state(p, at(99.9)).scheduled_class_id == "A"
    assert desired_state(p, at(100)).scheduled_class_id == "B"


def test_disabled_window_forces_idle() -> None:
    p = plan(window("A", 0, 110), window("B", 50, 150, enabled=False))
    state = desired_state(p, at(60))
    assert state.action == "idle"
    assert state.reason == "recording_disabled_by_policy"
    assert state.scheduled_class_id == "B"


def test_invalid_windows_are_skipped() -> None:
    bad = window("X", 10, 5)
    p = plan(bad, window("A", 0, 10))
    assert [w.scheduled_class_id for w in p.windows] == ["A"]


def test_plan_cache_survives_restart(tmp_path: Path) -> None:
    path = tmp_path / "plan.json"
    store = PlanStore(path, refresh_interval_s=300)
    assert store.needs_refresh(T0)
    store.update(plan(window("A", 0, 110)), T0)
    reloaded = PlanStore(path, refresh_interval_s=300)
    assert reloaded.plan is not None
    assert reloaded.plan.windows[0].scheduled_class_id == "A"
    assert not reloaded.needs_refresh(at(4))
    assert reloaded.needs_refresh(at(5))


def test_corrupt_plan_cache_is_discarded(tmp_path: Path) -> None:
    path = tmp_path / "plan.json"
    path.write_text("{not json")
    assert PlanStore(path, 300).plan is None


def test_clock_guard_corrects_large_skew_only() -> None:
    guard = ClockGuard(max_skew_s=120)
    guard.observe("Wed, 04 Nov 2026 22:01:00 GMT", T0)  # 60 s: within tolerance
    assert guard.corrected(T0) == T0
    guard.observe("Wed, 04 Nov 2026 22:10:00 GMT", T0)  # device 10 min behind
    assert guard.corrected(T0) == at(10)
    assert guard.skew_ms == 600_000
    guard.observe("garbage", T0)
    assert guard.skew_ms == 600_000
