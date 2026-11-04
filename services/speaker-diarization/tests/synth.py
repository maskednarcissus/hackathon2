"""Synthetic 'voices' with distinct spectral shapes for diarization tests."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from speaker_diarization.audio import Audio, FloatArray

SR = 16_000


@dataclass(frozen=True)
class Voice:
    f0: float
    formants: tuple[float, ...]
    bandwidth: float = 150.0
    breathiness: float = 0.02


VOICES = {
    "A": Voice(f0=110.0, formants=(500.0, 1500.0)),
    "B": Voice(f0=220.0, formants=(850.0, 2600.0)),
    "C": Voice(f0=160.0, formants=(320.0, 3300.0), breathiness=0.08),
}


def speak(voice: Voice, seconds: float, rng: np.random.Generator) -> FloatArray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    # Slow pitch drift and syllable-rate (≈4 Hz) amplitude modulation, like speech.
    f0 = voice.f0 * (1.0 + 0.04 * np.sin(2 * np.pi * 0.3 * t + rng.uniform(0, 6)))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    signal = np.zeros(n)
    for k in range(1, int(4000 / voice.f0)):
        freq = k * voice.f0
        gain = sum(np.exp(-0.5 * ((freq - f) / voice.bandwidth) ** 2) for f in voice.formants)
        signal += (gain + 0.02) * np.sin(k * phase)
    signal += voice.breathiness * rng.standard_normal(n) * signal.std()
    envelope = 0.55 + 0.45 * np.sin(2 * np.pi * 4.0 * t + rng.uniform(0, 6)) ** 2
    signal *= envelope
    signal /= np.max(np.abs(signal)) + 1e-9
    return (0.3 * signal).astype(np.float32)


def conversation(
    script: list[tuple[str, float]], gap_s: float = 0.4, seed: int = 7
) -> tuple[Audio, list[tuple[str, int, int]]]:
    """Concatenate turns separated by near-silence; returns audio and truth turns (ms)."""
    rng = np.random.default_rng(seed)
    parts: list[FloatArray] = []
    truth: list[tuple[str, int, int]] = []
    cursor = 0
    for speaker, seconds in script:
        chunk = speak(VOICES[speaker], seconds, rng)
        truth.append((speaker, cursor * 1000 // SR, (cursor + len(chunk)) * 1000 // SR))
        parts.append(chunk)
        cursor += len(chunk)
        gap = (0.0005 * rng.standard_normal(int(gap_s * SR))).astype(np.float32)
        parts.append(gap)
        cursor += len(gap)
    return Audio(samples=np.concatenate(parts), sample_rate=SR), truth
