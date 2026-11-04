"""In-memory adapters for development and tests."""

from __future__ import annotations

import threading
from datetime import datetime

import structlog

from audio_ingestion.models import RecordingSession, UploadSession
from audio_ingestion.ports import (
    AuditRecord,
    ConcurrentUpdateError,
    DeviceIdentity,
    EventEnvelope,
    RetentionCandidate,
)

log = structlog.get_logger(__name__)


class InMemoryRecordingRepository:
    def __init__(self) -> None:
        self._items: dict[str, RecordingSession] = {}
        self._lock = threading.Lock()
        self.uploads: InMemoryUploadRepository | None = None

    def add(self, recording: RecordingSession) -> None:
        with self._lock:
            self._items[recording.id] = recording.model_copy(deep=True)

    def get(self, recording_id: str) -> RecordingSession | None:
        item = self._items.get(recording_id)
        return item.model_copy(deep=True) if item else None

    def find_by_local_id(self, device_id: str, local_recording_id: str) -> RecordingSession | None:
        for item in self._items.values():
            if item.device_id == device_id and item.local_recording_id == local_recording_id:
                return item.model_copy(deep=True)
        return None

    def update(self, recording: RecordingSession) -> None:
        self.add(recording)

    def retention_candidates(
        self, institution_id: str, older_than: datetime
    ) -> list[RetentionCandidate]:
        return [
            RetentionCandidate(
                id=item.id,
                created_at=item.created_at,
                recording_session_id=item.id,
                recording_policy_id=item.recording_policy_id,
            )
            for item in sorted(self._items.values(), key=lambda r: r.created_at)
            if item.institution_id == institution_id
            and item.storage_uri is not None
            and item.audio_deleted_at is None
            and item.created_at < older_than
        ]

    def delete_audio(self, recording_id: str, deleted_at: datetime) -> RecordingSession | None:
        with self._lock:
            item = self._items.get(recording_id)
            if item is None:
                return None
            before = item.model_copy(deep=True)
            item.audio_deleted_at = deleted_at
            item.storage_uri = None
            if self.uploads is not None:
                self.uploads.delete_for_recording(recording_id)
            return before


class InMemoryUploadRepository:
    def __init__(self) -> None:
        self._items: dict[str, UploadSession] = {}
        self._lock = threading.Lock()
        self.recordings: InMemoryRecordingRepository | None = None

    def add(self, upload: UploadSession) -> None:
        with self._lock:
            if upload.upload_id not in self._items and any(
                v.recording_session_id == upload.recording_session_id
                and v.status in ("pending", "uploading")
                for v in self._items.values()
            ):
                raise ConcurrentUpdateError("an open upload already exists for the recording")
            self._items[upload.upload_id] = upload.model_copy(deep=True)

    def get(self, upload_id: str) -> UploadSession | None:
        item = self._items.get(upload_id)
        return item.model_copy(deep=True) if item else None

    def find_open_for_recording(self, recording_session_id: str) -> UploadSession | None:
        for item in self._items.values():
            if item.recording_session_id == recording_session_id and item.status in (
                "pending",
                "uploading",
            ):
                return item.model_copy(deep=True)
        return None

    def find_complete_for_recording(self, recording_session_id: str) -> UploadSession | None:
        for item in self._items.values():
            if item.recording_session_id == recording_session_id and item.status == "complete":
                return item.model_copy(deep=True)
        return None

    def update(self, upload: UploadSession) -> None:
        self.add(upload)

    def add_chunk(self, upload_id: str, index: int, checksum_sha256: str, size: int) -> str | None:
        with self._lock:
            item = self._items[upload_id]
            stored = item.chunk_checksums.get(index)
            if stored is not None:
                return stored
            item.chunk_checksums[index] = checksum_sha256
            if item.status == "pending":
                item.status = "uploading"
            return None

    def finalize(self, upload: UploadSession, recording: RecordingSession) -> bool:
        with self._lock:
            current = self._items.get(upload.upload_id)
            if current is None or current.status not in ("pending", "uploading"):
                return False
            self._items[upload.upload_id] = upload.model_copy(deep=True)
        if self.recordings is not None:
            self.recordings.update(recording)
        return True

    def fail(self, upload: UploadSession, recording: RecordingSession) -> None:
        self.update(upload)
        if self.recordings is not None:
            self.recordings.update(recording)

    def delete_for_recording(self, recording_id: str) -> None:
        for upload_id in [
            k for k, v in self._items.items() if v.recording_session_id == recording_id
        ]:
            del self._items[upload_id]


class InMemoryEventPublisher:
    def __init__(self) -> None:
        self.events: list[EventEnvelope] = []

    def publish(self, event: EventEnvelope) -> None:
        self.events.append(event)

    def of_type(self, event_type: str) -> list[EventEnvelope]:
        return [e for e in self.events if e.type == event_type]


class LoggingEventPublisher:
    """Development publisher: writes events to the structured log."""

    def publish(self, event: EventEnvelope) -> None:
        log.info("event.published", event=event.to_json())


class InMemoryAuditClient:
    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    def record(self, record: AuditRecord) -> None:
        self.records.append(record)

    def actions(self) -> list[str]:
        return [r.action for r in self.records]


class StaticDeviceKeyResolver:
    """Resolver backed by a fixed mapping (tests / offline development)."""

    def __init__(self, devices: dict[str, DeviceIdentity] | None = None) -> None:
        self.devices: dict[str, DeviceIdentity] = dict(devices or {})

    def add(self, identity: DeviceIdentity) -> None:
        self.devices[identity.device_id] = identity

    async def resolve(self, device_id: str) -> DeviceIdentity | None:
        return self.devices.get(device_id)


def in_memory_repositories() -> tuple[InMemoryRecordingRepository, InMemoryUploadRepository]:
    """Linked recording + upload repositories (finalize/fail/delete touch both)."""
    recordings = InMemoryRecordingRepository()
    uploads = InMemoryUploadRepository()
    recordings.uploads = uploads
    uploads.recordings = recordings
    return recordings, uploads
