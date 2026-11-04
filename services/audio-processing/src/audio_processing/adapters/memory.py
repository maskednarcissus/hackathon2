"""In-memory adapters for development and tests."""

from __future__ import annotations

from pathlib import Path

import structlog

from audio_processing.ports import AuditRecord, EventEnvelope

log = structlog.get_logger(__name__)

URI_SCHEME = "mem://"


class InMemoryObjectStore:
    """Unencrypted store keeping objects as bytes (tests only)."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_file(self, key: str, source: Path, content_type: str) -> str:
        self.objects[key] = source.read_bytes()
        return URI_SCHEME + key

    def put_bytes(self, key: str, data: bytes) -> str:
        self.objects[key] = data
        return URI_SCHEME + key

    def key_of(self, uri: str) -> str:
        if not uri.startswith(URI_SCHEME):
            raise ValueError(f"unsupported storage URI: {uri}")
        return uri[len(URI_SCHEME) :]

    def get_to_file(self, uri: str, destination: Path) -> None:
        key = self.key_of(uri)
        if key not in self.objects:
            raise FileNotFoundError(uri)
        destination.write_bytes(self.objects[key])

    def exists(self, uri: str) -> bool:
        return self.key_of(uri) in self.objects


class InMemoryEventPublisher:
    def __init__(self) -> None:
        self.events: list[EventEnvelope] = []

    def publish(self, event: EventEnvelope) -> None:
        self.events.append(event)

    def of_type(self, event_type: str) -> list[EventEnvelope]:
        return [e for e in self.events if e.type == event_type]


class LoggingEventPublisher:
    def publish(self, event: EventEnvelope) -> None:
        log.info("event.published", event=event.to_json())


class InMemoryAuditClient:
    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    def record(self, record: AuditRecord) -> None:
        self.records.append(record)

    def actions(self) -> list[str]:
        return [r.action for r in self.records]
