"""Synthetic classroom-like signals for tests."""

from __future__ import annotations

import wave
from collections.abc import Callable, Iterable
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

SR = 16_000
Int16 = NDArray[np.int16]


def db_to_amp(dbfs: float) -> float:
    return float(32768.0 * 10 ** (dbfs / 20.0))


def speech_like(
    start_s: float,
    seconds: float,
    rng: np.random.Generator,
    level_dbfs: float = -20.0,
    noise_dbfs: float = -65.0,
    gain: float = 1.0,
    silences: Iterable[tuple[float, float]] = (),
    sr: int = SR,
) -> NDArray[np.float32]:
    """Modulated noise with syllable rhythm (4 Hz) and utterance pauses (2.5 s on / 0.8 s off)."""
    n = int(seconds * sr)
    t = start_s + np.arange(n, dtype=np.float64) / sr
    envelope = (0.5 * (1 + np.sin(2 * np.pi * 4.0 * t))) ** 2
    gate = (np.mod(t, 3.3) < 2.5).astype(np.float64)
    for begin, end in silences:
        gate[(t >= begin) & (t < end)] = 0.0
    carrier = rng.standard_normal(n, dtype=np.float32)
    # RMS of envelope² · gate · N(0,1) ≈ 0.53 → normalise to the requested level.
    speech = carrier * (envelope * gate / 0.53).astype(np.float32) * db_to_amp(level_dbfs)
    noise = rng.standard_normal(n, dtype=np.float32) * db_to_amp(noise_dbfs)
    return (speech + noise) * gain


def to_int16(signal: NDArray[np.float32]) -> Int16:
    return np.clip(np.round(signal), -32768, 32767).astype(np.int16)


def write_wav(path: Path, samples: Int16, sr: int = SR, channels: int = 1) -> Path:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        wav.writeframes(samples.tobytes())
    return path


def write_streaming_wav(
    path: Path,
    seconds: float,
    block: Callable[[float, float], NDArray[np.float32]],
    block_seconds: float = 60.0,
    sr: int = SR,
) -> Path:
    """Write a long mono WAV block by block (bounded memory)."""
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        start = 0.0
        while start < seconds:
            length = min(block_seconds, seconds - start)
            wav.writeframes(to_int16(block(start, length)).tobytes())
            start += length
    return path
