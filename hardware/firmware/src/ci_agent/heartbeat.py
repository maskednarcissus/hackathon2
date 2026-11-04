"""Device health metrics sent to device-management every heartbeat interval."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ci_agent.spool import SpoolStats
from ci_agent.timeutil import to_iso

THERMAL_ROOT = Path("/sys/class/thermal")
PROC_UPTIME = Path("/proc/uptime")


def read_cpu_temperature_c(root: Path = THERMAL_ROOT) -> float | None:
    """Highest ``thermal_zone*/temp`` in °C, or ``None`` when unavailable."""
    temps: list[float] = []
    if not root.exists():
        return None
    for zone in root.glob("thermal_zone*/temp"):
        try:
            temps.append(int(zone.read_text().strip()) / 1000.0)
        except (OSError, ValueError):
            continue
    return round(max(temps), 1) if temps else None


def read_uptime_seconds(path: Path = PROC_UPTIME) -> int | None:
    try:
        return int(float(path.read_text().split()[0]))
    except (OSError, ValueError, IndexError):
        return None


@dataclass(frozen=True)
class HeartbeatContext:
    firmware_version: str
    is_recording: bool
    current_scheduled_class_id: str | None
    plan_fetched_at: datetime | None
    clock_skew_ms: int
    last_error: str | None


def build_heartbeat(
    now: datetime,
    data_dir: Path,
    spool: SpoolStats,
    ctx: HeartbeatContext,
    thermal_root: Path = THERMAL_ROOT,
    uptime_path: Path = PROC_UPTIME,
) -> dict[str, Any]:
    usage = shutil.disk_usage(data_dir)
    payload: dict[str, Any] = {
        "sentAt": to_iso(now),
        "firmwareVersion": ctx.firmware_version,
        "uptimeSeconds": read_uptime_seconds(uptime_path),
        "diskFreeBytes": usage.free,
        "diskTotalBytes": usage.total,
        "cpuTempC": read_cpu_temperature_c(thermal_root),
        "bufferQueueCount": spool.queued_recordings,
        "bufferQueueBytes": spool.queued_bytes,
        "spoolBytes": spool.total_bytes,
        "evictedRecordings": spool.evicted_recordings,
        "isRecording": ctx.is_recording,
        "currentScheduledClassId": ctx.current_scheduled_class_id,
        "planFetchedAt": to_iso(ctx.plan_fetched_at) if ctx.plan_fetched_at else None,
        "clockSkewMs": ctx.clock_skew_ms,
        "lastError": ctx.last_error,
    }
    # device-management treats absent fields as unknown; it rejects explicit nulls.
    return {key: value for key, value in payload.items() if value is not None}
