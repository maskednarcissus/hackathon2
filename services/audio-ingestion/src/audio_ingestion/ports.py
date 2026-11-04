"""Ports (interfaces) the ingestion service depends on.

Concrete adapters live in ``audio_ingestion.adapters``. Every port has an in-memory
or local implementation used in development and tests, and a GCP implementation
used in production.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from audio_ingestion.models import RecordingSession, UploadSession


@dataclass(frozen=True)
class DeviceIdentity:
    """What device-management tells us about a device (contract §3)."""

    device_id: str
    public_key_pem: str
    status: str
    classroom_id: str | None
    institution_id: str | None


class DeviceKeyResolver(Protocol):
    async def resolve(self, device_id: str) -> DeviceIdentity | None:
        """Return the device identity, or ``None`` when the device is unknown."""
        ...


class RecordingRepository(Protocol):
    def add(self, recording: RecordingSession) -> None: ...

    def get(self, recording_id: str) -> RecordingSession | None: ...

    def find_by_local_id(
        self, device_id: str, local_recording_id: str
    ) -> RecordingSession | None: ...

    def update(self, recording: RecordingSession) -> None: ...


class UploadRepository(Protocol):
    def add(self, upload: UploadSession) -> None: ...

    def get(self, upload_id: str) -> UploadSession | None: ...

    def find_open_for_recording(self, recording_session_id: str) -> UploadSession | None:
        """Return an upload in ``pending``/``uploading`` state for the recording, if any."""
        ...

    def find_complete_for_recording(self, recording_session_id: str) -> UploadSession | None: ...

    def update(self, upload: UploadSession) -> None: ...


class ObjectStore(Protocol):
    """Durable, encrypted-at-rest object storage for audio."""

    def put_file(self, key: str, source: Path, content_type: str) -> str:
        """Store ``source`` under ``key`` and return its storage URI."""
        ...

    def get_to_file(self, uri: str, destination: Path) -> None:
        """Download (and decrypt) the object at ``uri`` into ``destination``."""
        ...

    def exists(self, uri: str) -> bool: ...


@dataclass
class EventEnvelope:
    event_id: str
    type: str
    version: int
    occurred_at: datetime
    source: str
    institution_id: str | None
    data: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "eventId": self.event_id,
            "type": self.type,
            "version": self.version,
            "occurredAt": self.occurred_at.isoformat().replace("+00:00", "Z"),
            "source": self.source,
            "institutionId": self.institution_id,
            "data": self.data,
        }


class EventPublisher(Protocol):
    def publish(self, event: EventEnvelope) -> None: ...


@dataclass(frozen=True)
class AuditRecord:
    action: str
    resource_type: str
    resource_id: str | None
    actor_type: str
    actor_id: str | None
    institution_id: str | None
    occurred_at: datetime
    metadata: dict[str, Any] = field(default_factory=dict)


class AuditClient(Protocol):
    def record(self, record: AuditRecord) -> None: ...
