"""Ingestion use cases: recording metadata (1.7) and chunked upload (1.5)."""

from __future__ import annotations

import hashlib
import shutil
import tempfile
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog

from audio_ingestion.models import (
    RecordingEventIn,
    RecordingMetadataIn,
    RecordingSession,
    UploadCreateIn,
    UploadSession,
)
from audio_ingestion.ports import (
    AuditClient,
    AuditRecord,
    ConcurrentUpdateError,
    DeviceIdentity,
    EventEnvelope,
    EventPublisher,
    ObjectStore,
    RecordingRepository,
    RetentionCandidate,
    UnknownReferenceError,
    UploadRepository,
)

log = structlog.get_logger(__name__)

SERVICE_NAME = "audio-ingestion"
CONTENT_TYPES = {"wav_pcm_s16le": "audio/wav", "flac": "audio/flac"}
EXTENSIONS = {"wav_pcm_s16le": "wav", "flac": "flac"}


class IngestionError(Exception):
    """Domain error mapped to an HTTP status by the API layer."""

    def __init__(self, status_code: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def storage_key(recording: RecordingSession) -> str:
    """Object key from contract §5: ``recordings/{institutionId}/{yyyy}/{mm}/{dd}/{id}.wav``."""
    started = recording.started_at.astimezone(UTC)
    institution = recording.institution_id or "unassigned"
    extension = EXTENSIONS.get(recording.audio_format, "bin")
    return (
        f"recordings/{institution}/{started:%Y}/{started:%m}/{started:%d}/"
        f"{recording.id}.{extension}"
    )


class IngestionService:
    def __init__(
        self,
        recordings: RecordingRepository,
        uploads: UploadRepository,
        store: ObjectStore,
        publisher: EventPublisher,
        audit: AuditClient,
        staging_dir: Path,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._recordings = recordings
        self._uploads = uploads
        self._store = store
        self._publisher = publisher
        self._audit = audit
        self._staging = staging_dir
        self._clock = clock
        staging_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ helpers
    def _emit(
        self,
        event_type: str,
        institution_id: str | None,
        data: dict[str, Any],
        event_id: str | None = None,
    ) -> None:
        self._publisher.publish(
            EventEnvelope(
                event_id=event_id or str(uuid.uuid4()),
                type=event_type,
                version=1,
                occurred_at=self._clock(),
                source=SERVICE_NAME,
                institution_id=institution_id,
                data=data,
            )
        )

    def _audit_device(
        self,
        action: str,
        device: DeviceIdentity,
        resource_type: str,
        resource_id: str | None,
        **metadata: Any,
    ) -> None:
        self._audit.record(
            AuditRecord(
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                actor_type="device",
                actor_id=device.device_id,
                institution_id=device.institution_id,
                occurred_at=self._clock(),
                metadata=metadata,
            )
        )

    def _chunk_dir(self, upload_id: str) -> Path:
        return self._staging / upload_id

    def _owned_recording(self, device: DeviceIdentity, recording_id: str) -> RecordingSession:
        recording = self._recordings.get(recording_id)
        if recording is None or recording.device_id != device.device_id:
            # Do not reveal recordings that belong to other devices.
            raise IngestionError(404, "recording_not_found", "recording session not found")
        return recording

    def _owned_upload(self, device: DeviceIdentity, upload_id: str) -> UploadSession:
        upload = self._uploads.get(upload_id)
        if upload is None or upload.device_id != device.device_id:
            raise IngestionError(404, "upload_not_found", "upload not found")
        return upload

    # --------------------------------------------------------- 1.7 metadata
    def register_recording(
        self, device: DeviceIdentity, body: RecordingMetadataIn
    ) -> tuple[RecordingSession, bool]:
        """Create (or return the existing) recording session. Returns ``(recording, created)``."""
        if str(body.device_id) != device.device_id:
            raise IngestionError(403, "device_mismatch", "deviceId does not match the signer")
        if device.classroom_id is None:
            raise IngestionError(409, "device_unassigned", "device is not assigned to a classroom")
        if str(body.classroom_id) != device.classroom_id:
            raise IngestionError(
                409,
                "classroom_mismatch",
                "classroomId does not match the device's current classroom assignment",
                expectedClassroomId=device.classroom_id,
            )

        existing = self._recordings.find_by_local_id(device.device_id, body.local_recording_id)
        if existing is not None:
            if (
                existing.checksum_sha256 != body.checksum_sha256
                or existing.file_size_bytes != body.file_size_bytes
            ):
                raise IngestionError(
                    409,
                    "local_recording_conflict",
                    "localRecordingId already registered with different content",
                    recordingSessionId=existing.id,
                )
            return existing, False

        duration_ms = int((body.ended_at - body.started_at).total_seconds() * 1000)
        recording = RecordingSession(
            id=str(uuid.uuid4()),
            device_id=device.device_id,
            classroom_id=str(body.classroom_id),
            institution_id=device.institution_id,
            scheduled_class_id=str(body.scheduled_class_id) if body.scheduled_class_id else None,
            started_at=body.started_at,
            ended_at=body.ended_at,
            duration_ms=duration_ms,
            audio_format=body.audio_format,
            sample_rate=body.sample_rate,
            channels=body.channels,
            file_size_bytes=body.file_size_bytes,
            checksum_sha256=body.checksum_sha256,
            firmware_version=body.firmware_version,
            local_recording_id=body.local_recording_id,
            created_at=self._clock(),
        )
        try:
            self._recordings.add(recording)
        except ConcurrentUpdateError:
            # Same (deviceId, localRecordingId) registered by a parallel retry.
            existing = self._recordings.find_by_local_id(device.device_id, body.local_recording_id)
            if existing is None:
                raise
            return existing, False
        except UnknownReferenceError as exc:
            raise IngestionError(422, "unknown_reference", str(exc)) from exc
        self._audit_device(
            "recording.metadata_received",
            device,
            "recording_session",
            recording.id,
            localRecordingId=recording.local_recording_id,
            scheduledClassId=recording.scheduled_class_id,
            durationMs=duration_ms,
            fileSizeBytes=recording.file_size_bytes,
        )
        return recording, True

    def get_recording(self, device: DeviceIdentity, recording_id: str) -> RecordingSession:
        return self._owned_recording(device, recording_id)

    def report_recording_event(self, device: DeviceIdentity, body: RecordingEventIn) -> None:
        if body.device_id is not None and str(body.device_id) != device.device_id:
            raise IngestionError(403, "device_mismatch", "deviceId does not match the signer")
        data = {
            "deviceId": device.device_id,
            "localRecordingId": body.local_recording_id,
            "scheduledClassId": str(body.scheduled_class_id) if body.scheduled_class_id else None,
            "at": body.at.isoformat(),
        }
        if body.reason:
            data["reason"] = body.reason
        self._audit_device(body.type, device, "device", device.device_id, **data)
        # Deterministic id: a firmware retry of the same report is deduplicated downstream.
        event_id = _event_id(body.type, device.device_id, body.local_recording_id)
        self._emit(
            body.type,
            device.institution_id,
            {**data, "classroomId": device.classroom_id},
            event_id=event_id,
        )

    # ------------------------------------------------------------ 1.5 uploads
    def create_upload(
        self, device: DeviceIdentity, body: UploadCreateIn
    ) -> tuple[UploadSession, bool]:
        """Start an upload, or return the open one for the same recording (resume)."""
        recording = self._owned_recording(device, str(body.recording_session_id))
        if recording.audio_deleted_at is not None:
            raise IngestionError(410, "audio_deleted", "recording audio was deleted by retention")
        if body.total_size_bytes != recording.file_size_bytes:
            raise IngestionError(
                422, "size_mismatch", "totalSizeBytes differs from the recording metadata"
            )
        if body.checksum_sha256 != recording.checksum_sha256:
            raise IngestionError(
                422, "checksum_mismatch", "checksumSha256 differs from the recording metadata"
            )
        if self._uploads.find_complete_for_recording(recording.id) is not None:
            raise IngestionError(409, "already_uploaded", "recording audio was already uploaded")
        existing = self._uploads.find_open_for_recording(recording.id)
        if existing is not None:
            return existing, False

        total_chunks = -(-body.total_size_bytes // body.chunk_size_bytes)
        upload = UploadSession(
            upload_id=str(uuid.uuid4()),
            recording_session_id=recording.id,
            device_id=device.device_id,
            total_size_bytes=body.total_size_bytes,
            checksum_sha256=body.checksum_sha256,
            chunk_size_bytes=body.chunk_size_bytes,
            total_chunks=total_chunks,
            status="uploading",
            created_at=self._clock(),
        )
        try:
            self._uploads.add(upload)
        except ConcurrentUpdateError:
            # A parallel request opened an upload for this recording first: resume it.
            existing = self._uploads.find_open_for_recording(recording.id)
            if existing is None:
                raise
            return existing, False
        recording.upload_status = "uploading"
        self._recordings.update(recording)
        self._audit_device(
            "upload.started",
            device,
            "recording_session",
            recording.id,
            uploadId=upload.upload_id,
            totalChunks=total_chunks,
            chunkSizeBytes=upload.chunk_size_bytes,
        )
        return upload, True

    def get_upload(self, device: DeviceIdentity, upload_id: str) -> UploadSession:
        return self._owned_upload(device, upload_id)

    def put_chunk(
        self, device: DeviceIdentity, upload_id: str, index: int, data: bytes, claimed_sha: str
    ) -> bool:
        """Store one chunk. Returns ``False`` when the identical chunk was already stored."""
        upload = self._owned_upload(device, upload_id)
        if upload.status not in ("pending", "uploading"):
            raise IngestionError(409, "upload_closed", f"upload is {upload.status}")
        if not 0 <= index < upload.total_chunks:
            raise IngestionError(
                422, "chunk_out_of_range", f"chunk index must be 0..{upload.total_chunks - 1}"
            )
        expected_size = upload.expected_chunk_size(index)
        if len(data) != expected_size:
            raise IngestionError(
                422,
                "chunk_size_mismatch",
                f"chunk {index} must be {expected_size} bytes, got {len(data)}",
            )
        actual_sha = hashlib.sha256(data).hexdigest()
        if actual_sha != claimed_sha.lower():
            raise IngestionError(422, "chunk_checksum_mismatch", "X-Chunk-SHA256 does not match")

        def conflict_or_duplicate(stored: str) -> bool:
            if stored == actual_sha:
                return False
            raise IngestionError(
                409, "chunk_conflict", f"chunk {index} was already received with other content"
            )

        stored = upload.chunk_checksums.get(index)
        if stored is not None:
            return conflict_or_duplicate(stored)

        chunk_dir = self._chunk_dir(upload.upload_id)
        chunk_dir.mkdir(parents=True, exist_ok=True)
        part = chunk_dir / f"{index:06d}.part"
        tmp = chunk_dir / f"{index:06d}.{uuid.uuid4().hex}.tmp"
        tmp.write_bytes(data)
        try:
            # The (upload, index) primary key arbitrates concurrent senders of the same chunk.
            stored = self._uploads.add_chunk(upload.upload_id, index, actual_sha, len(data))
            if stored is not None:
                return conflict_or_duplicate(stored)
            tmp.replace(part)
        finally:
            tmp.unlink(missing_ok=True)
        return True

    def _fail_upload(
        self,
        device: DeviceIdentity,
        upload: UploadSession,
        recording: RecordingSession,
        code: str,
        reason: str,
    ) -> IngestionError:
        upload.status = "failed"
        upload.failure_reason = reason
        recording.upload_status = "failed"
        self._uploads.fail(upload, recording)
        shutil.rmtree(self._chunk_dir(upload.upload_id), ignore_errors=True)
        self._audit_device(
            "upload.failed",
            device,
            "recording_session",
            recording.id,
            uploadId=upload.upload_id,
            reason=reason,
        )
        self._emit(
            "upload.failed",
            recording.institution_id,
            {
                "recordingSessionId": recording.id,
                "uploadId": upload.upload_id,
                "deviceId": device.device_id,
                "classroomId": recording.classroom_id,
                "reason": reason,
            },
            event_id=_event_id("upload.failed", upload.upload_id),
        )
        return IngestionError(422, code, reason)

    def _publish_uploaded(self, recording: RecordingSession, upload: UploadSession) -> None:
        assert recording.storage_uri is not None
        self._emit(
            "recording.uploaded",
            recording.institution_id,
            {
                "recordingSessionId": recording.id,
                "deviceId": recording.device_id,
                "classroomId": recording.classroom_id,
                "scheduledClassId": recording.scheduled_class_id,
                "storageUri": recording.storage_uri,
                "sizeBytes": upload.total_size_bytes,
                "checksumSha256": upload.checksum_sha256,
                "sampleRate": recording.sample_rate,
                "channels": recording.channels,
                "durationMs": recording.duration_ms,
                "audioFormat": recording.audio_format,
                "startedAt": recording.started_at.isoformat(),
                "endedAt": recording.ended_at.isoformat(),
                "institutionId": recording.institution_id,
            },
            # One recording is uploaded once: a re-published event keeps its id, so
            # subscribers deduplicate it (processed_events) instead of re-processing.
            event_id=_event_id("recording.uploaded", recording.id),
        )

    def complete_upload(
        self, device: DeviceIdentity, upload_id: str
    ) -> tuple[UploadSession, RecordingSession]:
        upload = self._owned_upload(device, upload_id)
        recording = self._owned_recording(device, upload.recording_session_id)
        if upload.status == "complete":
            # Retried completion (e.g. the first response was lost, or publishing failed
            # after the commit): re-publish with the same event id so nothing is lost.
            if recording.storage_uri and recording.audio_deleted_at is None:
                self._publish_uploaded(recording, upload)
            return upload, recording
        if upload.status == "failed":
            raise IngestionError(409, "upload_closed", "upload has failed; start a new upload")
        missing = upload.missing_chunks()
        if missing:
            raise IngestionError(
                409, "chunks_missing", "upload is missing chunks", missingChunks=missing
            )

        chunk_dir = self._chunk_dir(upload.upload_id)
        digest = hashlib.sha256()
        size = 0
        fd, assembled_name = tempfile.mkstemp(dir=self._staging, suffix=".assembled")
        assembled = Path(assembled_name)
        try:
            with open(fd, "wb") as out:
                for index in range(upload.total_chunks):
                    part = chunk_dir / f"{index:06d}.part"
                    if not part.exists():
                        raise IngestionError(
                            409,
                            "chunks_missing",
                            "chunk data is not available on this instance; re-send it",
                            missingChunks=[index],
                        )
                    with part.open("rb") as src:
                        while block := src.read(1024 * 1024):
                            digest.update(block)
                            size += len(block)
                            out.write(block)

            if size != upload.total_size_bytes:
                raise self._fail_upload(
                    device,
                    upload,
                    recording,
                    "size_mismatch",
                    f"assembled size {size} != declared {upload.total_size_bytes}",
                )
            if digest.hexdigest() != upload.checksum_sha256:
                raise self._fail_upload(
                    device,
                    upload,
                    recording,
                    "checksum_mismatch",
                    "assembled file SHA-256 does not match the declared checksum",
                )

            key = storage_key(recording)
            content_type = CONTENT_TYPES.get(recording.audio_format, "application/octet-stream")
            storage_uri = self._store.put_file(key, assembled, content_type)
        finally:
            assembled.unlink(missing_ok=True)

        upload.status = "complete"
        upload.completed_at = self._clock()
        recording.upload_status = "complete"
        recording.storage_uri = storage_uri
        if not self._uploads.finalize(upload, recording):
            # Lost a race with a concurrent completion of the same upload.
            current = self._owned_upload(device, upload_id)
            if current.status != "complete":
                raise IngestionError(409, "upload_closed", f"upload is {current.status}")
            return current, self._owned_recording(device, recording.id)
        shutil.rmtree(chunk_dir, ignore_errors=True)

        self._audit_device(
            "upload.completed",
            device,
            "recording_session",
            recording.id,
            uploadId=upload.upload_id,
            storageUri=storage_uri,
            sizeBytes=size,
            checksumSha256=upload.checksum_sha256,
        )
        self._publish_uploaded(recording, upload)
        log.info("upload.completed", recording_session_id=recording.id, size=size)
        return upload, recording

    # ------------------------------------------- retention (Phase 4 §5, kind "audio")
    def retention_candidates(
        self, institution_id: str, older_than: datetime
    ) -> list[RetentionCandidate]:
        return self._recordings.retention_candidates(institution_id, older_than)

    def delete_audio(self, ids: list[str], job_id: str | None) -> list[str]:
        """Delete stored audio (recording + derived segments) and its upload/segment rows.

        Objects are deleted before rows are marked, so a failure leaves the item a
        candidate for the next run instead of orphaning objects. Ids whose audio is
        already gone are reported as deleted (idempotent retries).
        """
        deleted: list[str] = []
        for recording_id in dict.fromkeys(ids):
            recording = self._recordings.get(recording_id)
            if recording is None:
                continue
            if recording.storage_uri:
                self._store.delete(recording.storage_uri)
                self._store.delete_prefix(segment_uri_prefix(recording.storage_uri))
            if recording.audio_deleted_at is None:
                self._recordings.delete_audio(recording_id, self._clock())
                self._audit.record(
                    AuditRecord(
                        action="retention.deleted",
                        resource_type="recording_session",
                        resource_id=recording_id,
                        actor_type="system",
                        actor_id=None,
                        institution_id=recording.institution_id,
                        occurred_at=self._clock(),
                        metadata={"kind": "audio", "jobId": job_id, "service": SERVICE_NAME},
                    )
                )
            deleted.append(recording_id)
        return deleted


EVENT_ID_NAMESPACE = uuid.UUID("6f1c3d1e-9a52-4f4e-8a8e-2b0f1d7c5a10")


def _event_id(*parts: str) -> str:
    return str(uuid.uuid5(EVENT_ID_NAMESPACE, ":".join(parts)))


def segment_uri_prefix(storage_uri: str) -> str:
    """``…/{id}.wav`` → ``…/{id}/segments/`` (written by audio-processing)."""
    base = storage_uri.rsplit(".", 1)[0] if "." in storage_uri.rsplit("/", 1)[-1] else storage_uri
    return f"{base}/segments/"
