"""Ports (interfaces) the processing service depends on."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol


class ObjectStore(Protocol):
    def put_file(self, key: str, source: Path, content_type: str) -> str:
        """Store ``source`` under ``key`` and return its storage URI."""
        ...

    def get_to_file(self, uri: str, destination: Path) -> None: ...

    def exists(self, uri: str) -> bool: ...

    def key_of(self, uri: str) -> str:
        """Object key addressed by ``uri`` (inverse of :meth:`put_file`)."""
        ...


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
