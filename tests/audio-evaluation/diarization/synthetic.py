"""Synthetic multi-speaker classroom audio with exact reference turns (Phase 6.1 DER set).

Voices are harmonic sources with distinct pitch, formants and breathiness, modulated at a
syllable rate; *overlap* items mix two voices. Everything is deterministic per seed.
Only NumPy is required so the benchmark runner can render cases on the fly — no audio is
committed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt

SR = 16_000
FloatArray = npt.NDArray[np.float32]


@dataclass(frozen=True)
class Voice:
    f0: float
    formants: tuple[float, ...]
    bandwidth: float = 150.0
    breathiness: float = 0.02


VOICES: dict[str, Voice] = {
    "A": Voice(f0=110.0, formants=(500.0, 1500.0)),
    "B": Voice(f0=220.0, formants=(850.0, 2600.0)),
    "C": Voice(f0=160.0, formants=(320.0, 3300.0), breathiness=0.08),
    "D": Voice(f0=130.0, formants=(700.0, 1100.0, 2400.0)),
    "E": Voice(f0=250.0, formants=(400.0, 2000.0), breathiness=0.05),
    "F": Voice(f0=95.0, formants=(600.0, 1800.0, 3000.0), bandwidth=220.0),
}


def speak(voice: Voice, seconds: float, rng: np.random.Generator) -> FloatArray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f0 = voice.f0 * (1.0 + 0.04 * np.sin(2 * np.pi * 0.3 * t + rng.uniform(0, 6)))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    signal = np.zeros(n)
    for k in range(1, int(4000 / voice.f0)):
        freq = k * voice.f0
        gain = sum(np.exp(-0.5 * ((freq - f) / voice.bandwidth) ** 2) for f in voice.formants)
        signal += (gain + 0.02) * np.sin(k * phase)
    signal += voice.breathiness * rng.standard_normal(n) * signal.std()
    signal *= 0.55 + 0.45 * np.sin(2 * np.pi * 4.0 * t + rng.uniform(0, 6)) ** 2
    signal /= np.max(np.abs(signal)) + 1e-9
    return (0.3 * signal).astype(np.float32)


@dataclass(frozen=True)
class RefTurn:
    speaker: str
    start_ms: int
    end_ms: int


def render(spec: dict[str, Any]) -> tuple[FloatArray, int, list[RefTurn]]:
    """Render a case spec::

        {"seed": 1, "gap_s": 0.4, "noise_snr_db": 25,
         "script": [{"speaker": "A", "seconds": 8, "gain": 1.0},
                    {"speakers": ["A", "B"], "seconds": 2}, ...]}

    Overlap items emit one reference turn per voice over the same span.
    """
    rng = np.random.default_rng(int(spec.get("seed", 0)))
    gap_s = float(spec.get("gap_s", 0.4))
    parts: list[FloatArray] = []
    truth: list[RefTurn] = []
    cursor = 0
    for item in spec["script"]:
        seconds = float(item["seconds"])
        speakers = item.get("speakers") or [item["speaker"]]
        gain = float(item.get("gain", 1.0))
        chunk = np.zeros(int(seconds * SR), dtype=np.float32)
        for spk in speakers:
            chunk += speak(VOICES[spk], seconds, rng) * (gain / (len(speakers) ** 0.5))
        start = cursor * 1000 // SR
        end = (cursor + len(chunk)) * 1000 // SR
        truth.extend(RefTurn(spk, start, end) for spk in speakers)
        parts.append(chunk)
        cursor += len(chunk)
        if gap_s > 0:
            gap = (0.0005 * rng.standard_normal(int(gap_s * SR))).astype(np.float32)
            parts.append(gap)
            cursor += len(gap)
    audio = np.concatenate(parts)
    snr = spec.get("noise_snr_db")
    if snr is not None:
        noise = rng.standard_normal(len(audio)).astype(np.float32)
        noise = np.convolve(noise, np.ones(8) / 8, mode="same").astype(np.float32)
        speech_rms = float(np.sqrt(np.mean(audio[np.abs(audio) > 1e-3] ** 2)))
        noise *= speech_rms / (10 ** (float(snr) / 20)) / float(noise.std())
        audio = (audio + noise).astype(np.float32)
    return audio, SR, truth
