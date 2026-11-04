"""WAV decoding and audio loading."""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse

import numpy as np
import numpy.typing as npt

FloatArray = npt.NDArray[np.float32]


class AudioDecodeError(ValueError):
    pass


@dataclass(frozen=True)
class Audio:
    samples: FloatArray  # mono, float32 in [-1, 1]
    sample_rate: int

    @property
    def duration_ms(self) -> int:
        return int(len(self.samples) * 1000 / self.sample_rate)


def decode_wav(data: bytes) -> Audio:
    """Decode PCM WAV (8/16/24/32-bit integer) into mono float32."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
    except (wave.Error, EOFError) as exc:
        raise AudioDecodeError(f"invalid WAV: {exc}") from exc

    if width == 1:
        pcm = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        raw = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        ints = raw[:, 0] | (raw[:, 1] << 8) | (raw[:, 2] << 16)
        ints = np.where(ints & 0x800000, ints - 0x1000000, ints)
        pcm = ints.astype(np.float32) / 8388608.0
    elif width == 4:
        pcm = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise AudioDecodeError(f"unsupported sample width {width}")

    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return Audio(samples=pcm.astype(np.float32), sample_rate=rate)


def encode_wav(samples: FloatArray, sample_rate: int) -> bytes:
    """16-bit mono PCM encoder (tests, fixtures)."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


class AudioLoader(Protocol):
    async def load(self, storage_uri: str) -> Audio: ...


class LocalAudioLoader:
    """``file://`` URIs or plain paths, optionally confined to ``root``."""

    def __init__(self, root: str | Path | None = None) -> None:
        self._root = Path(root).resolve() if root else None

    async def load(self, storage_uri: str) -> Audio:
        parsed = urlparse(storage_uri)
        if parsed.scheme not in ("", "file"):
            raise AudioDecodeError(f"LocalAudioLoader cannot read {storage_uri!r}")
        path = Path(parsed.path if parsed.scheme == "file" else storage_uri).resolve()
        if self._root is not None and not path.is_relative_to(self._root):
            raise AudioDecodeError("path escapes configured audio root")
        return decode_wav(path.read_bytes())


class GcsAudioLoader:
    """``gs://bucket/object`` via google-cloud-storage (CMEK decryption is transparent)."""

    def __init__(self) -> None:
        from google.cloud import storage

        self._client = storage.Client()

    async def load(self, storage_uri: str) -> Audio:
        import asyncio

        parsed = urlparse(storage_uri)
        if parsed.scheme != "gs":
            raise AudioDecodeError(f"GcsAudioLoader cannot read {storage_uri!r}")
        blob = self._client.bucket(parsed.netloc).blob(parsed.path.lstrip("/"))
        data: bytes = await asyncio.to_thread(blob.download_as_bytes)
        return decode_wav(data)


class RoutingAudioLoader:
    """Dispatch by URI scheme."""

    def __init__(self, loaders: dict[str, AudioLoader]) -> None:
        self._loaders = loaders

    async def load(self, storage_uri: str) -> Audio:
        scheme = urlparse(storage_uri).scheme or "file"
        loader = self._loaders.get(scheme)
        if loader is None:
            raise AudioDecodeError(f"no audio loader for scheme {scheme!r}")
        return await loader.load(storage_uri)
