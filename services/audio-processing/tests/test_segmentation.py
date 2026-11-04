from __future__ import annotations

import time
import tracemalloc
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest

from audio_processing.segmentation import SegmentationConfig, plan_segments
from audio_processing.wav import analyze_wav
from tests.signals import speech_like, to_int16, write_streaming_wav, write_wav


def assert_contiguous(segments, duration_ms: int, overlap_ms: int = 0) -> None:  # type: ignore[no-untyped-def]
    assert segments[0].start_ms == 0
    assert segments[-1].end_ms == duration_ms
    for i, (a, b) in enumerate(pairwise(segments)):
        assert a.index == i
        assert b.start_ms == a.end_ms - overlap_ms
    for s in segments:
        assert 0 < s.end_ms - s.start_ms <= 360_000


def test_short_recording_is_single_segment() -> None:
    frames = np.full(100, -20, dtype=np.float32)
    segments = plan_segments(frames, 20, 2_000)
    assert [(s.start_ms, s.end_ms) for s in segments] == [(0, 2_000)]
    assert plan_segments(frames, 20, 0) == []


def test_cuts_land_in_pauses(tmp_path: Path) -> None:
    rng = np.random.default_rng(10)
    # Long continuous speech (no natural gaps) with two deliberate 1.5 s pauses.
    pauses = [(312.0, 313.5), (588.0, 589.5)]
    signal = speech_like(0, 12 * 60, rng, silences=pauses)
    path = write_wav(tmp_path / "lecture.wav", to_int16(signal))
    analysis = analyze_wav(path)
    # Mask the regular 0.8 s utterance gaps so only the deliberate pauses are quiet.
    frame_db = analysis.frame_db.copy()
    t = np.arange(frame_db.size) * analysis.frame_ms / 1000
    regular_gap = (np.mod(t, 3.3) >= 2.5) & ~(
        ((t >= 312.0) & (t < 313.5)) | ((t >= 588.0) & (t < 589.5))
    )
    frame_db[regular_gap] = -20
    segments = plan_segments(frame_db, analysis.frame_ms, analysis.info.duration_ms)
    assert_contiguous(segments, 12 * 60_000)
    assert len(segments) == 3
    assert 312_000 <= segments[0].end_ms <= 313_500
    assert 588_000 <= segments[1].end_ms <= 589_500


def test_uniform_energy_cuts_near_target() -> None:
    frames = np.full(20 * 60 * 50, -25, dtype=np.float32)  # 20 min at 20 ms frames
    segments = plan_segments(frames, 20, 20 * 60_000)
    assert_contiguous(segments, 20 * 60_000)
    for s in segments[:-1]:
        assert abs((s.end_ms - s.start_ms) - 300_000) <= 40


def test_overlap_and_custom_lengths() -> None:
    frames = np.full(10 * 60 * 50, -25, dtype=np.float32)
    config = SegmentationConfig(target_ms=60_000, max_ms=90_000, search_ms=5_000, overlap_ms=500)
    segments = plan_segments(frames, 20, 10 * 60_000, config)
    assert_contiguous(segments, 10 * 60_000, overlap_ms=500)
    assert all(s.end_ms - s.start_ms <= 90_000 for s in segments)
    assert len(segments) == 10


@pytest.mark.parametrize(
    "config",
    [
        SegmentationConfig(target_ms=0),
        SegmentationConfig(target_ms=400_000, max_ms=300_000),
        SegmentationConfig(search_ms=400_000),
        SegmentationConfig(overlap_ms=200_000),
    ],
)
def test_invalid_config_rejected(config: SegmentationConfig) -> None:
    with pytest.raises(ValueError):
        plan_segments(np.zeros(10, dtype=np.float32), 20, 1_000_000, config)


def test_ninety_minute_lecture_is_fast_and_bounded(tmp_path: Path) -> None:
    """A 90-minute 16 kHz recording (≈172 MB) is analysed and segmented in bounded memory."""
    rng = np.random.default_rng(11)
    seconds = 90 * 60

    path = write_streaming_wav(
        tmp_path / "lecture-90min.wav", seconds, lambda start, n: speech_like(start, n, rng)
    )
    assert path.stat().st_size > 170_000_000

    tracemalloc.start()
    started = time.perf_counter()
    analysis = analyze_wav(path)
    segments = plan_segments(analysis.frame_db, analysis.frame_ms, analysis.info.duration_ms)
    elapsed = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert analysis.info.duration_ms == seconds * 1000
    assert_contiguous(segments, seconds * 1000)
    assert len(segments) == 18
    assert elapsed < 30, f"took {elapsed:.1f}s"
    assert peak < 120 * 1024 * 1024, f"peak {peak / 1e6:.0f} MB"
    # Each cut sits in a low-energy region (regular utterance pause).
    for s in segments[:-1]:
        frame = s.end_ms // analysis.frame_ms
        assert analysis.frame_db[frame] < -40
