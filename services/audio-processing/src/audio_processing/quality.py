"""Audio quality assessment (deliverable 1.8, contract §7)."""

from __future__ import annotations

import math
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from audio_processing.wav import DB_FLOOR, FULL_SCALE, FrameAnalysis

Verdict = Literal["good", "acceptable", "poor", "unusable"]
Issue = Literal["clipping", "low_snr", "excessive_silence", "too_quiet", "too_short"]

# Contract §7 thresholds
CLIPPING_RATIO_MAX = 0.001  # 0.1 % of samples
SNR_MIN_DB = 15.0
SILENCE_RATIO_MAX = 0.60
RMS_MIN_DBFS = -45.0
DURATION_MIN_MS = 60_000

SILENCE_FRAME_DBFS = -50.0  # a frame below this level counts as silence
NOISE_FLOOR_PERCENTILE = 10
SIGNAL_PERCENTILE = 95
UNUSABLE_SILENCE_RATIO = 0.95


class QualityReport(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    duration_ms: int
    sample_rate: int
    channels: int
    rms_dbfs: float
    peak_dbfs: float
    noise_floor_dbfs: float
    snr_db: float
    clipping_ratio: float
    silence_ratio: float
    longest_silence_ms: int
    score: float
    verdict: Verdict
    issues: list[Issue]


def _longest_run(mask: np.ndarray) -> int:
    if not mask.any():
        return 0
    padded = np.concatenate(([0], mask.astype(np.int8), [0]))
    edges = np.flatnonzero(np.diff(padded))
    return int((edges[1::2] - edges[::2]).max())


def _db(value: float) -> float:
    if value <= 0:
        return DB_FLOOR
    return max(DB_FLOOR, 20.0 * math.log10(value / FULL_SCALE))


def assess(analysis: FrameAnalysis) -> QualityReport:
    info = analysis.info
    frames = analysis.frame_db
    duration_ms = info.duration_ms

    rms_dbfs = _db(math.sqrt(analysis.mean_square))
    peak_dbfs = _db(float(analysis.peak))
    if frames.size:
        noise_floor = float(np.percentile(frames, NOISE_FLOOR_PERCENTILE))
        signal = float(np.percentile(frames, SIGNAL_PERCENTILE))
        silent = frames < SILENCE_FRAME_DBFS
        silence_ratio = float(silent.mean())
        longest_silence_ms = _longest_run(silent) * analysis.frame_ms
    else:
        noise_floor = signal = DB_FLOOR
        silence_ratio = 1.0
        longest_silence_ms = 0
    snr_db = max(0.0, signal - noise_floor)
    clipping_ratio = (
        analysis.clipped_samples / analysis.total_samples if analysis.total_samples else 0.0
    )

    issues: list[Issue] = []
    penalty = 0.0
    if clipping_ratio > CLIPPING_RATIO_MAX:
        issues.append("clipping")
        penalty += 0.25 + 0.2 * min(1.0, clipping_ratio / 0.02)
    if snr_db < SNR_MIN_DB:
        issues.append("low_snr")
        penalty += 0.2 + 0.3 * (SNR_MIN_DB - snr_db) / SNR_MIN_DB
    if silence_ratio > SILENCE_RATIO_MAX:
        issues.append("excessive_silence")
        penalty += 0.2 + 0.4 * (silence_ratio - SILENCE_RATIO_MAX) / (1 - SILENCE_RATIO_MAX)
    if rms_dbfs < RMS_MIN_DBFS:
        issues.append("too_quiet")
        penalty += 0.3
    if duration_ms < DURATION_MIN_MS:
        issues.append("too_short")
        penalty += 0.3
    score = round(max(0.0, min(1.0, 1.0 - penalty)), 3)

    verdict: Verdict
    if duration_ms < 1000 or silence_ratio >= UNUSABLE_SILENCE_RATIO or score < 0.25:
        verdict = "unusable"
    elif score < 0.5:
        verdict = "poor"
    elif score < 0.8 or issues:
        verdict = "acceptable"
    else:
        verdict = "good"

    return QualityReport(
        duration_ms=duration_ms,
        sample_rate=info.sample_rate,
        channels=info.channels,
        rms_dbfs=round(rms_dbfs, 2),
        peak_dbfs=round(peak_dbfs, 2),
        noise_floor_dbfs=round(noise_floor, 2),
        snr_db=round(snr_db, 2),
        clipping_ratio=round(clipping_ratio, 6),
        silence_ratio=round(silence_ratio, 4),
        longest_silence_ms=longest_silence_ms,
        score=score,
        verdict=verdict,
        issues=issues,
    )
