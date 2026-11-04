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
    DeviceIdentity,
    EventEnvelope,
    EventPublisher,
    ObjectStore,
    RecordingRepository,
    UploadRepository,
)

log = structlog.get_logger(__name__)

SERVICE_NAME = "audio-ingestion"
CONTENT_TYPES = {"wav_pcm_s16le": "audio/wav"}
EXTENSIONS = {"wav_pcm_s16le": "wav"}


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
    def _emit(self, event_type: str, institution_id: str | None, data: dict[str, Any]) -> None:
        self._publisher.publish(
            EventEnvelope(
                event_id=str(uuid.uuid4()),
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
        self._recordings.add(recording)
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
        data = {
            "deviceId": device.device_id,
            "localRecordingId": body.local_recording_id,
            "scheduledClassId": str(body.scheduled_class_id) if body.scheduled_class_id else None,
            "at": body.at.isoformat(),
        }
        if body.reason:
            data["reason"] = body.reason
        self._audit_device(body.type, device, "device", device.device_id, **data)
        self._emit(body.type, device.institution_id, {**data, "classroomId": device.classroom_id})

    # ------------------------------------------------------------ 1.5 uploads
    def create_upload(
        self, device: DeviceIdentity, body: UploadCreateIn
    ) -> tuple[UploadSession, bool]:
        """Start an upload, or return the open one for the same recording (resume)."""
        recording = self._owned_recording(device, str(body.recording_session_id))
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
            created_at=self._clock(),
        )
        self._uploads.add(upload)
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

        stored = upload.chunk_checksums.get(index)
        if stored is not None:
            if stored == actual_sha:
                return False
            raise IngestionError(
                409, "chunk_conflict", f"chunk {index} was already received with other content"
            )

        chunk_dir = self._chunk_dir(upload.upload_id)
        chunk_dir.mkdir(parents=True, exist_ok=True)
        part = chunk_dir / f"{index:06d}.part"
        tmp = part.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(part)

        upload.chunk_checksums[index] = actual_sha
        upload.status = "uploading"
        self._uploads.update(upload)
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
        self._uploads.update(upload)
        recording.upload_status = "failed"
        self._recordings.update(recording)
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
        )
        return IngestionError(422, code, reason)

    def complete_upload(
        self, device: DeviceIdentity, upload_id: str
    ) -> tuple[UploadSession, RecordingSession]:
        upload = self._owned_upload(device, upload_id)
        recording = self._owned_recording(device, upload.recording_session_id)
        if upload.status == "complete":
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

        shutil.rmtree(chunk_dir, ignore_errors=True)
        upload.status = "complete"
        upload.completed_at = self._clock()
        self._uploads.update(upload)
        recording.upload_status = "complete"
        recording.storage_uri = storage_uri
        self._recordings.update(recording)

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
        self._emit(
            "recording.uploaded",
            recording.institution_id,
            {
                "recordingSessionId": recording.id,
                "deviceId": recording.device_id,
                "classroomId": recording.classroom_id,
                "scheduledClassId": recording.scheduled_class_id,
                "storageUri": storage_uri,
                "sizeBytes": size,
                "checksumSha256": upload.checksum_sha256,
                "sampleRate": recording.sample_rate,
                "channels": recording.channels,
                "durationMs": recording.duration_ms,
                "audioFormat": recording.audio_format,
                "startedAt": recording.started_at.isoformat(),
            },
        )
        log.info("upload.completed", recording_session_id=recording.id, size=size)
        return upload, recording
