"""Chunked, resumable upload of spooled recordings (contract §5)."""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Protocol

import httpx

from ci_agent.api import ApiError
from ci_agent.spool import Spool, SpoolEntry
from ci_agent.timeutil import to_iso, utcnow

log = logging.getLogger(__name__)

AUDIO_FORMAT = "wav_pcm_s16le"


class IngestionClient(Protocol):
    def create_recording(self, metadata: dict[str, Any]) -> dict[str, Any]: ...

    def create_upload(
        self,
        recording_session_id: str,
        total_size_bytes: int,
        checksum_sha256: str,
        chunk_size_bytes: int,
    ) -> dict[str, Any]: ...

    def upload_status(self, upload_id: str) -> dict[str, Any]: ...

    def put_chunk(self, upload_id: str, index: int, data: bytes) -> None: ...

    def complete_upload(self, upload_id: str) -> dict[str, Any]: ...


class TransientUploadError(Exception):
    pass


@dataclass
class UploadCycleResult:
    uploaded: list[str] = field(default_factory=list)
    deferred: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def is_transient(exc: Exception) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    return isinstance(exc, ApiError) and exc.retryable


class Uploader:
    def __init__(
        self,
        api: IngestionClient,
        spool: Spool,
        device_id: str,
        firmware_version: str,
        chunk_size_bytes: int,
        *,
        max_attempts_per_cycle: int = 5,
        backoff_base_s: float = 2.0,
        backoff_max_s: float = 300.0,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[], float] = random.random,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.api = api
        self.spool = spool
        self.device_id = device_id
        self.firmware_version = firmware_version
        self.chunk_size_bytes = chunk_size_bytes
        self.max_attempts = max_attempts_per_cycle
        self.backoff_base_s = backoff_base_s
        self.backoff_max_s = backoff_max_s
        self.sleep = sleep
        self.rand = rand
        self.clock = clock

    def backoff(self, attempt: int) -> float:
        """Exponential backoff with ±50 % jitter (``attempt`` starts at 0)."""
        delay = min(self.backoff_max_s, self.backoff_base_s * (2**attempt))
        return float(delay * (0.5 + self.rand() / 2))

    def _with_retry(self, label: str, op: Callable[[], Any]) -> Any:
        for attempt in range(self.max_attempts):
            try:
                return op()
            except Exception as exc:
                if not is_transient(exc):
                    raise
                if attempt == self.max_attempts - 1:
                    raise TransientUploadError(f"{label}: {exc}") from exc
                delay = self.backoff(attempt)
                log.warning("%s failed (%s); retry in %.1fs", label, exc, delay)
                self.sleep(delay)
        raise AssertionError("unreachable")

    def upload_pending(self) -> UploadCycleResult:
        result = UploadCycleResult()
        for entry in self.spool.pending(self.clock()):
            try:
                self.upload_entry(entry)
                result.uploaded.append(entry.local_recording_id)
            except TransientUploadError as exc:
                self._defer(entry, str(exc))
                result.deferred.append(entry.local_recording_id)
                break  # network is down: don't hammer it with the rest of the queue
            except ApiError as exc:
                self._defer(entry, str(exc))
                result.failed.append(entry.local_recording_id)
        return result

    def _defer(self, entry: SpoolEntry, error: str) -> None:
        entry.attempts += 1
        entry.last_error = error[:500]
        wait = self.backoff(min(entry.attempts, 16))
        entry.next_attempt_at = to_iso(self.clock() + timedelta(seconds=wait))
        self.spool.update(entry)
        log.warning("upload of %s deferred: %s", entry.local_recording_id, error)

    def _metadata(self, entry: SpoolEntry) -> dict[str, Any]:
        meta: dict[str, Any] = {
            "deviceId": self.device_id,
            "classroomId": entry.classroom_id,
            "startedAt": entry.started_at,
            "endedAt": entry.ended_at,
            "audioFormat": AUDIO_FORMAT,
            "sampleRate": entry.sample_rate,
            "channels": entry.channels,
            "fileSizeBytes": entry.size_bytes,
            "checksumSha256": entry.checksum_sha256,
            "firmwareVersion": self.firmware_version,
            "localRecordingId": entry.local_recording_id,
        }
        if entry.scheduled_class_id:
            meta["scheduledClassId"] = entry.scheduled_class_id
        return meta

    def upload_entry(self, entry: SpoolEntry) -> None:
        if entry.checksum_sha256 is None:
            raise ValueError(f"{entry.local_recording_id} has no checksum")
        if entry.state == "recorded":
            entry.state = "uploading"
            self.spool.update(entry)

        if entry.recording_session_id is None:
            created = self._with_retry(
                "create recording", lambda: self.api.create_recording(self._metadata(entry))
            )
            entry.recording_session_id = str(created["recordingSessionId"])
            self.spool.update(entry)

        received: set[int] = set()
        total_chunks: int | None = None
        if entry.upload_id is not None:
            upload_id = entry.upload_id
            try:
                status = self._with_retry(
                    "upload status", lambda: self.api.upload_status(upload_id)
                )
                if status.get("status") == "failed":
                    entry.upload_id = None
                else:
                    received = {int(i) for i in status.get("receivedChunks", [])}
                    total_chunks = int(status["totalChunks"])
                    if status.get("status") == "complete":
                        self._done(entry)
                        return
            except ApiError as exc:
                if exc.status_code not in (404, 410):
                    raise
                entry.upload_id = None  # expired server-side: start over
        if entry.upload_id is None:
            session_id = entry.recording_session_id
            checksum = entry.checksum_sha256
            created_upload = self._with_retry(
                "create upload",
                lambda: self.api.create_upload(
                    session_id, entry.size_bytes, checksum, self.chunk_size_bytes
                ),
            )
            entry.upload_id = str(created_upload["uploadId"])
            total_chunks = int(created_upload["totalChunks"])
            received = {int(i) for i in created_upload.get("receivedChunks", [])}
            self.spool.update(entry)

        upload_id = entry.upload_id
        assert total_chunks is not None
        path = self.spool.path_of(entry.wav_file)
        with path.open("rb") as fh:
            for index in range(total_chunks):
                if index in received:
                    continue
                fh.seek(index * self.chunk_size_bytes)
                data = fh.read(self.chunk_size_bytes)
                self._send_chunk(upload_id, index, data)
        try:
            self._with_retry("complete upload", lambda: self.api.complete_upload(upload_id))
        except ApiError as exc:
            if exc.status_code == 422:
                # Server-side checksum mismatch: discard this upload and retry fresh.
                entry.upload_id = None
                self.spool.update(entry)
            raise
        self._done(entry)

    def _send_chunk(self, upload_id: str, index: int, data: bytes) -> None:
        self._with_retry(f"chunk {index}", lambda: self.api.put_chunk(upload_id, index, data))

    def _done(self, entry: SpoolEntry) -> None:
        self.spool.mark_uploaded(entry.local_recording_id, self.clock())
        log.info("uploaded %s as %s", entry.local_recording_id, entry.recording_session_id)
