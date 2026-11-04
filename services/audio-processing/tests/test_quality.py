from __future__ import annotations

from pathlib import Path

import numpy as np

from audio_processing.quality import assess
from audio_processing.wav import analyze_wav
from tests.signals import SR, db_to_amp, speech_like, to_int16, write_wav


def report_for(path: Path):  # type: ignore[no-untyped-def]
    return assess(analyze_wav(path))


def test_clean_speech_is_good(tmp_path: Path) -> None:
    rng = np.random.default_rng(1)
    path = write_wav(tmp_path / "speech.wav", to_int16(speech_like(0, 180, rng)))
    report = report_for(path)
    assert report.verdict == "good", report
    assert report.issues == []
    assert report.duration_ms == 180_000
    assert report.snr_db > 30
    assert report.clipping_ratio == 0
    assert 0.15 < report.silence_ratio < 0.6
    assert -26 < report.rms_dbfs < -18
    assert report.longest_silence_ms >= 500
    assert report.score >= 0.8


def test_clipping_detected(tmp_path: Path) -> None:
    rng = np.random.default_rng(2)
    loud = speech_like(0, 120, rng, level_dbfs=-6, gain=4.0)
    report = report_for(write_wav(tmp_path / "clip.wav", to_int16(loud)))
    assert "clipping" in report.issues
    assert report.clipping_ratio > 0.001
    assert report.peak_dbfs > -0.01
    assert report.verdict in ("acceptable", "poor")


def test_digital_silence_is_unusable(tmp_path: Path) -> None:
    path = write_wav(tmp_path / "silence.wav", np.zeros(SR * 120, dtype=np.int16))
    report = report_for(path)
    assert report.verdict == "unusable"
    assert {"excessive_silence", "too_quiet"} <= set(report.issues)
    assert report.silence_ratio == 1.0
    assert report.longest_silence_ms == 120_000


def test_continuous_noise_has_low_snr(tmp_path: Path) -> None:
    rng = np.random.default_rng(3)
    noise = rng.standard_normal(SR * 120).astype(np.float32) * db_to_amp(-30)
    report = report_for(write_wav(tmp_path / "noise.wav", to_int16(noise)))
    assert "low_snr" in report.issues
    assert report.snr_db < 15
    assert report.verdict != "good"


def test_quiet_mostly_silent_recording(tmp_path: Path) -> None:
    rng = np.random.default_rng(4)
    signal = speech_like(0, 120, rng, level_dbfs=-20, silences=[(10, 110)])
    report = report_for(write_wav(tmp_path / "quiet.wav", to_int16(signal)))
    assert "excessive_silence" in report.issues
    assert report.verdict in ("poor", "unusable", "acceptable")
    assert report.score < 0.8


def test_short_recording_flagged(tmp_path: Path) -> None:
    rng = np.random.default_rng(5)
    report = report_for(write_wav(tmp_path / "short.wav", to_int16(speech_like(0, 20, rng))))
    assert "too_short" in report.issues
    assert report.verdict in ("acceptable", "poor")


def test_sub_second_audio_unusable(tmp_path: Path) -> None:
    rng = np.random.default_rng(6)
    signal = to_int16(speech_like(0, 0.5, rng))
    report = report_for(write_wav(tmp_path / "tiny.wav", signal))
    assert report.verdict == "unusable"


def test_stereo_is_supported(tmp_path: Path) -> None:
    rng = np.random.default_rng(7)
    mono = to_int16(speech_like(0, 90, rng))
    stereo = np.column_stack([mono, mono]).reshape(-1)
    report = report_for(write_wav(tmp_path / "stereo.wav", stereo, channels=2))
    assert report.channels == 2
    assert report.duration_ms == 90_000
    assert report.verdict == "good"
