"""Input decoding: FLAC (Phase 6.10 gen2 devices) → WAV PCM s16le for analysis.

FLAC is decoded with ``soundfile`` (libsndfile, bundled in its wheels) block by block, so a
two-hour recording never sits in memory. Higher bit depths (24-bit FLAC from multichannel
gen2 capture) are converted to 16-bit, which is what analysis and the STT segments use.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from audio_processing.wav import WavFormatError

FLAC_MAGIC = b"fLaC"
BLOCK_FRAMES = 16_000 * 30


def sniff_format(path: Path) -> str:
    """``"flac"`` or ``"wav"`` from the file header; anything else raises."""
    with path.open("rb") as handle:
        head = handle.read(12)
    if head.startswith(FLAC_MAGIC):
        return "flac"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    raise WavFormatError("unsupported audio: expected WAV (RIFF/WAVE) or FLAC")


def flac_to_wav(source: Path, destination: Path) -> None:
    import soundfile  # local import keeps WAV-only paths free of libsndfile

    try:
        with soundfile.SoundFile(str(source)) as flac, wave.open(str(destination), "wb") as out:
            out.setnchannels(flac.channels)
            out.setsampwidth(2)
            out.setframerate(flac.samplerate)
            for block in flac.blocks(blocksize=BLOCK_FRAMES, dtype="int16", always_2d=True):
                out.writeframes(np.ascontiguousarray(block).astype("<i2", copy=False).tobytes())
    except (RuntimeError, soundfile.LibsndfileError) as exc:
        raise WavFormatError(f"invalid FLAC file: {exc}") from exc
