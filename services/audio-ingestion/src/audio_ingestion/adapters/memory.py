"""In-memory adapters for development and tests."""

from __future__ import annotations

import threading

import structlog

from audio_ingestion.models import RecordingSession, UploadSession
from audio_ingestion.ports import AuditRecord, DeviceIdentity, EventEnvelope

log = structlog.get_logger(__name__)


class InMemoryRecordingRepository:
    def __init__(self) -> None:
        self._items: dict[str, RecordingSession] = {}
        self._lock = threading.Lock()

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


class InMemoryUploadRepository:
    def __init__(self) -> None:
        self._items: dict[str, UploadSession] = {}
        self._lock = threading.Lock()

    def add(self, upload: UploadSession) -> None:
        with self._lock:
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
