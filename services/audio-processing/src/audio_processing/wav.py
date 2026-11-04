"""Streaming WAV PCM s16le analysis.

Recordings can be 2+ hours long (≈230 MB at 16 kHz mono), so audio is never loaded
whole: it is read in blocks and reduced to per-frame energy plus global counters.
A 90-minute recording reduces to ~270 k float32 frame values (≈1 MB).
"""

from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

FULL_SCALE = 32768.0
DB_FLOOR = -120.0
CLIP_LEVEL = 32767  # |sample| >= this counts as clipped (int16 rails)
DEFAULT_FRAME_MS = 20
BLOCK_SECONDS = 30


class WavFormatError(ValueError):
    """The input is not a WAV PCM s16le file."""


@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    channels: int
    frames: int  # samples per channel

    @property
    def duration_ms(self) -> int:
        return self.frames * 1000 // self.sample_rate if self.sample_rate else 0


@dataclass(frozen=True)
class FrameAnalysis:
    info: WavInfo
    frame_ms: int
    frame_db: NDArray[np.float32]  # RMS dBFS of the channel-mixed signal per frame
    peak: int
    clipped_samples: int
    total_samples: int  # across all channels
    mean_square: float  # of the channel-mixed signal, in int16 units²


def read_info(path: Path) -> WavInfo:
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getsampwidth() != 2 or wav.getcomptype() != "NONE":
                raise WavFormatError("only uncompressed 16-bit PCM WAV is supported")
            return WavInfo(wav.getframerate(), wav.getnchannels(), wav.getnframes())
    except (wave.Error, EOFError) as exc:
        raise WavFormatError(f"invalid WAV file: {exc}") from exc


def to_db(rms: NDArray[np.float64]) -> NDArray[np.float32]:
    with np.errstate(divide="ignore"):
        db = 20.0 * np.log10(np.maximum(rms, 1e-12) / FULL_SCALE)
    return np.maximum(db, DB_FLOOR).astype(np.float32)


def analyze_wav(path: Path, frame_ms: int = DEFAULT_FRAME_MS) -> FrameAnalysis:
    info = read_info(path)
    frame_len = max(1, info.sample_rate * frame_ms // 1000)
    block_frames = frame_len * max(1, (info.sample_rate * BLOCK_SECONDS) // frame_len)

    frame_db_parts: list[NDArray[np.float32]] = []
    peak = 0
    clipped = 0
    sum_squares = 0.0
    mono_samples = 0

    with wave.open(str(path), "rb") as wav:
        while True:
            raw = wav.readframes(block_frames)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype="<i2")
            usable = samples.size - samples.size % info.channels
            interleaved = samples[:usable].astype(np.int32).reshape(-1, info.channels)
            if interleaved.size == 0:
                break
            magnitude = np.abs(interleaved)
            peak = max(peak, int(magnitude.max()))
            clipped += int(np.count_nonzero(magnitude >= CLIP_LEVEL))

            mono = interleaved.mean(axis=1, dtype=np.float64)
            squares = mono * mono
            sum_squares += float(squares.sum())
            mono_samples += mono.size

            whole = squares.size - squares.size % frame_len
            parts: list[NDArray[np.float64]] = []
            if whole:
                parts.append(np.sqrt(squares[:whole].reshape(-1, frame_len).mean(axis=1)))
            if squares.size > whole:
                parts.append(np.sqrt(np.array([squares[whole:].mean()])))
            frame_db_parts.extend(to_db(p) for p in parts)

    frame_db = np.concatenate(frame_db_parts) if frame_db_parts else np.zeros(0, dtype=np.float32)
    return FrameAnalysis(
        info=info,
        frame_ms=frame_ms,
        frame_db=frame_db,
        peak=peak,
        clipped_samples=clipped,
        total_samples=mono_samples * info.channels,
        mean_square=sum_squares / mono_samples if mono_samples else 0.0,
    )


def write_wav_range(source: Path, destination: Path, start_ms: int, end_ms: int) -> None:
    """Copy ``[start_ms, end_ms)`` of ``source`` into a new WAV at ``destination``."""
    with wave.open(str(source), "rb") as src:
        rate = src.getframerate()
        start = min(src.getnframes(), start_ms * rate // 1000)
        end = min(src.getnframes(), end_ms * rate // 1000)
        src.setpos(start)
        with wave.open(str(destination), "wb") as dst:
            dst.setnchannels(src.getnchannels())
            dst.setsampwidth(src.getsampwidth())
            dst.setframerate(rate)
            remaining = end - start
            block = rate * BLOCK_SECONDS
            while remaining > 0:
                data = src.readframes(min(block, remaining))
                if not data:
                    break
                dst.writeframes(data)
                remaining -= len(data) // (src.getsampwidth() * src.getnchannels())
