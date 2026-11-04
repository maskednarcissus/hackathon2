"""Segmentation of long recordings at natural pauses (deliverable 1.9)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

DEFAULT_TARGET_MS = 5 * 60_000
DEFAULT_MAX_MS = 6 * 60_000
DEFAULT_SEARCH_MS = 30_000
SMOOTHING_MS = 300
# Within the search window prefer the quietest point; among equally quiet points prefer
# the one nearest the target. A full-window distance costs this many dB.
DISTANCE_PENALTY_DB = 1.0


class Segment(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    index: int
    start_ms: int
    end_ms: int
    storage_uri: str | None = None
    size_bytes: int | None = None
    checksum_sha256: str | None = None


@dataclass(frozen=True)
class SegmentationConfig:
    target_ms: int = DEFAULT_TARGET_MS
    max_ms: int = DEFAULT_MAX_MS
    search_ms: int = DEFAULT_SEARCH_MS
    overlap_ms: int = 0

    def validate(self) -> None:
        if self.target_ms <= 0 or self.max_ms < self.target_ms:
            raise ValueError("require 0 < target_ms <= max_ms")
        if not 0 <= self.search_ms < self.target_ms:
            raise ValueError("require 0 <= search_ms < target_ms")
        if not 0 <= self.overlap_ms <= self.target_ms // 4:
            raise ValueError("overlap_ms must be between 0 and target_ms / 4")


def _smoothed_power_db(frame_db: NDArray[np.float32], width: int) -> NDArray[np.float64]:
    power = np.power(10.0, frame_db.astype(np.float64) / 10.0)
    if width > 1 and power.size >= width:
        kernel = np.ones(width) / width
        power = np.convolve(power, kernel, mode="same")
    result: NDArray[np.float64] = 10.0 * np.log10(np.maximum(power, 1e-12))
    return result


def plan_segments(
    frame_db: NDArray[np.float32],
    frame_ms: int,
    duration_ms: int,
    config: SegmentationConfig | None = None,
) -> list[Segment]:
    """Split ``[0, duration_ms)`` into segments of ~``target_ms``, never above ``max_ms``.

    Each cut is placed at the lowest-energy point (smoothed over ``SMOOTHING_MS``) within
    ``target ± search`` — i.e. inside a pause when there is one — so words are not split.
    """
    config = config or SegmentationConfig()
    config.validate()
    if duration_ms <= 0:
        return []

    smoothed = _smoothed_power_db(frame_db, max(1, SMOOTHING_MS // frame_ms))
    segments: list[Segment] = []
    start = 0
    while duration_ms - start > config.max_ms:
        target = start + config.target_ms
        low = max(start + frame_ms, target - config.search_ms)
        high = min(start + config.max_ms, target + config.search_ms, duration_ms - frame_ms)
        lo_f, hi_f = low // frame_ms, max(low // frame_ms + 1, high // frame_ms)
        window = smoothed[lo_f:hi_f]
        if window.size:
            positions = np.arange(lo_f, lo_f + window.size)
            distance = np.abs(positions * frame_ms - target) / max(1, config.search_ms)
            best = int(np.argmin(window + DISTANCE_PENALTY_DB * distance))
            cut = int(positions[best]) * frame_ms
        else:
            cut = target
        cut = min(max(cut, low), start + config.max_ms)
        segments.append(Segment(index=len(segments), start_ms=start, end_ms=cut))
        start = cut - config.overlap_ms
    segments.append(Segment(index=len(segments), start_ms=start, end_ms=duration_ms))
    return segments
