"""Minimal PCM WAV helpers (s16le)."""

from __future__ import annotations

import hashlib
import os
import struct
from dataclasses import dataclass
from pathlib import Path

BYTES_PER_SAMPLE = 2
COPY_BUFFER = 1024 * 1024


def wav_header(data_size: int, sample_rate: int, channels: int) -> bytes:
    byte_rate = sample_rate * channels * BYTES_PER_SAMPLE
    block_align = channels * BYTES_PER_SAMPLE
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_size)
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, 16)
        + b"data"
        + struct.pack("<I", data_size)
    )


@dataclass(frozen=True)
class FinalizedAudio:
    path: Path
    size_bytes: int
    checksum_sha256: str
    duration_ms: int


def finalize_pcm_to_wav(
    pcm_path: Path, wav_path: Path, sample_rate: int, channels: int
) -> FinalizedAudio:
    """Wrap raw PCM into a WAV file, hashing the output in the same pass.

    A trailing partial frame (possible after a crash mid-write) is dropped.
    """
    frame = channels * BYTES_PER_SAMPLE
    raw_size = pcm_path.stat().st_size
    data_size = raw_size - (raw_size % frame)
    digest = hashlib.sha256()
    tmp = wav_path.with_name(f".{wav_path.name}.tmp")
    with pcm_path.open("rb") as src, tmp.open("wb") as dst:
        header = wav_header(data_size, sample_rate, channels)
        dst.write(header)
        digest.update(header)
        remaining = data_size
        while remaining > 0:
            buf = src.read(min(COPY_BUFFER, remaining))
            if not buf:
                break
            dst.write(buf)
            digest.update(buf)
            remaining -= len(buf)
        dst.flush()
        os.fsync(dst.fileno())
    os.replace(tmp, wav_path)
    duration_ms = int(data_size * 1000 / (sample_rate * frame)) if sample_rate else 0
    return FinalizedAudio(wav_path, wav_path.stat().st_size, digest.hexdigest(), duration_ms)
