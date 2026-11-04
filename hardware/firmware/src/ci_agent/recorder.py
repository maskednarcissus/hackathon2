"""Audio capture: pulls PCM from an ``AudioSource`` into the spool."""

from __future__ import annotations

import hashlib
import io
import logging
import math
import os
import shutil
import struct
import subprocess
import threading
from collections.abc import Callable
from datetime import datetime
from typing import IO, Protocol, cast

from ci_agent.spool import Spool, SpoolEntry
from ci_agent.timeutil import utcnow

log = logging.getLogger(__name__)

READ_SIZE = 32 * 1024  # ~1 s of 16 kHz mono s16le
FSYNC_EVERY_BYTES = 1024 * 1024


class AudioSource(Protocol):
    sample_rate: int
    channels: int

    def open(self) -> None: ...

    def read(self, max_bytes: int) -> bytes:
        """Return PCM s16le bytes; ``b""`` means the source ended."""
        ...

    def close(self) -> None: ...


class ArecordSource:
    """ALSA capture via ``arecord`` writing raw s16le PCM to stdout."""

    def __init__(self, device: str = "default", sample_rate: int = 16000, channels: int = 1):
        self.device = device
        self.sample_rate = sample_rate
        self.channels = channels
        self._proc: subprocess.Popen[bytes] | None = None

    def open(self) -> None:
        binary = shutil.which("arecord")
        if binary is None:
            raise RuntimeError("arecord not found (install alsa-utils)")
        self._proc = subprocess.Popen(
            [
                binary,
                "-q",
                "-D",
                self.device,
                "-f",
                "S16_LE",
                "-r",
                str(self.sample_rate),
                "-c",
                str(self.channels),
                "-t",
                "raw",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def read(self, max_bytes: int) -> bytes:
        if self._proc is None or self._proc.stdout is None:
            return b""
        stream = cast(io.BufferedReader, self._proc.stdout)
        return stream.read1(max_bytes)

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


class FakeSource:
    """Deterministic 440 Hz tone, for tests and bench runs without a microphone."""

    def __init__(
        self,
        sample_rate: int = 16000,
        channels: int = 1,
        total_bytes: int | None = None,
        realtime: bool = False,
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.total_bytes = total_bytes
        self.realtime = realtime
        self._produced = 0
        self._stop = threading.Event()

    def open(self) -> None:
        self._produced = 0
        self._stop.clear()

    def read(self, max_bytes: int) -> bytes:
        if self._stop.is_set():
            return b""
        size = max_bytes - (max_bytes % (2 * self.channels))
        if self.total_bytes is not None:
            size = min(size, self.total_bytes - self._produced)
        if size <= 0:
            return b""
        start = self._produced // (2 * self.channels)
        frames = size // (2 * self.channels)
        samples = []
        for i in range(frames):
            value = int(8000 * math.sin(2 * math.pi * 440 * (start + i) / self.sample_rate))
            samples.extend([value] * self.channels)
        self._produced += size
        if self.realtime:
            self._stop.wait(frames / self.sample_rate)
        return struct.pack(f"<{len(samples)}h", *samples)

    def close(self) -> None:
        self._stop.set()


class Recorder:
    """Owns at most one active capture; each capture is one spool entry."""

    def __init__(
        self,
        spool: Spool,
        source_factory: Callable[[], AudioSource],
        clock: Callable[[], datetime] = utcnow,
        on_error: Callable[[str], None] | None = None,
    ) -> None:
        self.spool = spool
        self.source_factory = source_factory
        self.clock = clock
        self.on_error = on_error
        self._entry: SpoolEntry | None = None
        self._source: AudioSource | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._digest = hashlib.sha256()
        self.bytes_captured = 0
        self.last_error: str | None = None

    @property
    def active(self) -> SpoolEntry | None:
        return self._entry

    @property
    def active_scheduled_class_id(self) -> str | None:
        return self._entry.scheduled_class_id if self._entry else None

    @property
    def pcm_sha256(self) -> str:
        """Running hash of captured PCM (integrity of the in-progress capture)."""
        return self._digest.hexdigest()

    def start(self, classroom_id: str, scheduled_class_id: str | None) -> SpoolEntry:
        if self._entry is not None:
            raise RuntimeError("recorder already active")
        source = self.source_factory()
        source.open()
        entry = self.spool.begin(classroom_id, scheduled_class_id, self.clock())
        self._entry = entry
        self._source = source
        self._digest = hashlib.sha256()
        self.bytes_captured = 0
        self._stop.clear()
        handle = self.spool.path_of(entry.pcm_file).open("ab")
        self._thread = threading.Thread(
            target=self._pump, args=(source, handle), name="ci-recorder", daemon=True
        )
        self._thread.start()
        log.info("recording started %s (class %s)", entry.local_recording_id, scheduled_class_id)
        return entry

    def _pump(self, source: AudioSource, handle: IO[bytes]) -> None:
        since_sync = 0
        try:
            while not self._stop.is_set():
                data = source.read(READ_SIZE)
                if not data:
                    if self._stop.wait(0.05):
                        break
                    continue
                handle.write(data)
                self._digest.update(data)
                self.bytes_captured += len(data)
                since_sync += len(data)
                if since_sync >= FSYNC_EVERY_BYTES:
                    handle.flush()
                    os.fsync(handle.fileno())
                    since_sync = 0
        except Exception as exc:  # capture errors must not kill the agent
            self.last_error = f"capture failed: {exc}"
            log.exception("audio capture failed")
            if self.on_error:
                self.on_error(self.last_error)
        finally:
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()

    def stop(self) -> SpoolEntry | None:
        entry = self._entry
        if entry is None:
            return None
        self._stop.set()
        if self._source is not None:
            self._source.close()
        if self._thread is not None:
            self._thread.join(timeout=10)
        self._entry = None
        self._source = None
        self._thread = None
        if self.bytes_captured == 0 and self.spool.path_of(entry.pcm_file).stat().st_size == 0:
            log.error("recording %s captured no audio", entry.local_recording_id)
        finished = self.spool.finish(entry.local_recording_id, self.clock())
        log.info(
            "recording stopped %s (%d ms, %d bytes)",
            finished.local_recording_id,
            finished.duration_ms,
            finished.size_bytes,
        )
        return finished
