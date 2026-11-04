"""Ports (interfaces) and in-memory adapters used in dev and tests."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from .models import ClassContext, Conflict, ExtractedEvent, PublicationPolicy, TranscriptSegment


class NotFoundError(Exception):
    pass


class UpstreamError(Exception):
    """A dependency (gateway, calendar, academic-integration…) failed."""


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


@dataclass(frozen=True)
class RetentionCandidate:
    id: str
    created_at: datetime
    class_section_id: str
    recording_session_id: str | None
    recording_policy_id: str | None
    subject_ids: list[str]


class EventRepository(Protocol):
    async def add(self, event: ExtractedEvent) -> None: ...
    async def update(self, event: ExtractedEvent) -> None: ...
    async def get(self, event_id: str) -> ExtractedEvent | None: ...
    async def list_by_section(self, class_section_id: str) -> list[ExtractedEvent]: ...
    async def list_all(self) -> list[ExtractedEvent]: ...
    async def list_review(
        self, statuses: list[str], professor_id: str | None, class_section_id: str | None
    ) -> list[ExtractedEvent]: ...
    def lock_section(self, class_section_id: str) -> AbstractAsyncContextManager[None]:
        """Serialise dedup + insert for one class section (atomic in Postgres)."""
        ...

    async def retention_candidates(
        self, institution_id: str, older_than: datetime, limit: int
    ) -> list[RetentionCandidate]: ...
    async def delete_many(self, ids: list[str]) -> list[str]: ...


class InMemoryEventRepository:
    def __init__(self) -> None:
        self._events: dict[str, ExtractedEvent] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def lock_section(self, class_section_id: str) -> AsyncIterator[None]:
        lock = self._locks.setdefault(class_section_id, asyncio.Lock())
        async with lock:
            yield

    async def retention_candidates(
        self, institution_id: str, older_than: datetime, limit: int
    ) -> list[RetentionCandidate]:
        due = sorted(
            (
                e
                for e in self._events.values()
                if e.institution_id == institution_id and e.created_at < older_than
            ),
            key=lambda e: e.created_at,
        )
        return [
            RetentionCandidate(
                id=e.id,
                created_at=e.created_at,
                class_section_id=e.class_section_id,
                recording_session_id=e.source.recording_session_id,
                recording_policy_id=None,
                subject_ids=[e.professor_id] if e.professor_id else [],
            )
            for e in due[:limit]
        ]

    async def delete_many(self, ids: list[str]) -> list[str]:
        deleted = [i for i in ids if self._events.pop(i, None) is not None]
        for e in self._events.values():
            if e.duplicate_of in deleted:
                e.duplicate_of = None
        return deleted

    async def add(self, event: ExtractedEvent) -> None:
        self._events[event.id] = event.model_copy(deep=True)

    async def update(self, event: ExtractedEvent) -> None:
        if event.id not in self._events:
            raise NotFoundError(event.id)
        self._events[event.id] = event.model_copy(deep=True)

    async def get(self, event_id: str) -> ExtractedEvent | None:
        e = self._events.get(event_id)
        return e.model_copy(deep=True) if e else None

    async def list_by_section(self, class_section_id: str) -> list[ExtractedEvent]:
        return [
            e.model_copy(deep=True)
            for e in self._events.values()
            if e.class_section_id == class_section_id
        ]

    async def list_all(self) -> list[ExtractedEvent]:
        return [e.model_copy(deep=True) for e in self._events.values()]

    async def list_review(
        self, statuses: list[str], professor_id: str | None, class_section_id: str | None
    ) -> list[ExtractedEvent]:
        return [
            e.model_copy(deep=True)
            for e in self._events.values()
            if e.confirmation_status in statuses
            and (professor_id is None or e.professor_id == professor_id)
            and (class_section_id is None or e.class_section_id == class_section_id)
        ]


class GatewayClient(Protocol):
    async def generate(self, request: dict[str, Any]) -> dict[str, Any]: ...


class ScriptedGatewayClient:
    """Fake gateway returning scripted outputs (or computed by a callable) — tests/dev."""

    def __init__(
        self,
        responder: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        *,
        injection_suspected: bool = False,
    ) -> None:
        self.requests: list[dict[str, Any]] = []
        self._responder = responder or (lambda _req: {"events": []})
        self._injection = injection_suspected

    async def generate(self, request: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(request)
        return {
            "requestId": str(uuid.uuid4()),
            "output": self._responder(request),
            "model": {"provider": "fake", "name": "fake-model"},
            "prompt": {"id": request.get("promptId"), "version": "fake", "sha256": "0" * 64},
            "usage": {"inputTokens": 0, "outputTokens": 0, "costUsd": 0.0},
            "latencyMs": 0,
            "attempts": 1,
            "safety": {"injectionSuspected": self._injection, "injectionSignals": []},
        }


class CalendarClient(Protocol):
    async def check_conflicts(self, payload: dict[str, Any]) -> list[Conflict]: ...
    async def publish(self, payload: dict[str, Any]) -> str: ...


@dataclass
class InMemoryCalendarClient:
    conflicts: list[Conflict] = field(default_factory=list)
    published: dict[str, dict[str, Any]] = field(default_factory=dict)
    fail_conflict_check: bool = False
    checks: list[dict[str, Any]] = field(default_factory=list)

    async def check_conflicts(self, payload: dict[str, Any]) -> list[Conflict]:
        self.checks.append(payload)
        if self.fail_conflict_check:
            raise UpstreamError("calendar unavailable")
        return list(self.conflicts)

    async def publish(self, payload: dict[str, Any]) -> str:
        key = str(payload.get("extractedEventId") or uuid.uuid4())
        existing = next(
            (cid for cid, p in self.published.items() if p.get("extractedEventId") == key), None
        )
        cal_id = existing or str(uuid.uuid4())
        self.published[cal_id] = payload
        return cal_id


class AcademicClient(Protocol):
    async def get_class_context(self, scheduled_class_id: str) -> ClassContext: ...


class InMemoryAcademicClient:
    def __init__(self, contexts: dict[str, ClassContext] | None = None) -> None:
        self.contexts = contexts or {}

    async def get_class_context(self, scheduled_class_id: str) -> ClassContext:
        ctx = self.contexts.get(scheduled_class_id)
        if ctx is None:
            raise NotFoundError(f"scheduled class {scheduled_class_id}")
        return ctx


@dataclass
class TranscriptData:
    transcript_id: str
    recording_session_id: str | None
    scheduled_class_id: str | None
    segments: list[TranscriptSegment]


class TranscriptClient(Protocol):
    async def get_transcript(self, transcript_id: str) -> TranscriptData: ...


class InMemoryTranscriptClient:
    def __init__(self, transcripts: dict[str, TranscriptData] | None = None) -> None:
        self.transcripts = transcripts or {}

    async def get_transcript(self, transcript_id: str) -> TranscriptData:
        t = self.transcripts.get(transcript_id)
        if t is None:
            raise NotFoundError(f"transcript {transcript_id}")
        return t


class EventPublisher(Protocol):
    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None: ...


class InMemoryEventPublisher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        self.events.append(
            {
                "eventId": str(uuid.uuid4()),
                "type": event_type,
                "version": 1,
                "occurredAt": datetime.now(UTC).isoformat(),
                "source": "event-extraction",
                "institutionId": institution_id,
                "data": data,
            }
        )


class AuditClient(Protocol):
    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str | None,
        tenant_id: str | None,
        actor_id: str | None,
        actor_type: str,
        metadata: dict[str, Any] | None = None,
    ) -> None: ...


class InMemoryAuditClient:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str | None,
        tenant_id: str | None,
        actor_id: str | None,
        actor_type: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.records.append(
            {
                "action": action,
                "resourceType": resource_type,
                "resourceId": resource_id,
                "tenantId": tenant_id,
                "actorId": actor_id,
                "actorType": actor_type,
                "metadata": metadata or {},
            }
        )


class PolicyProvider(Protocol):
    async def get_policy(self, institution_id: str) -> PublicationPolicy: ...


class StaticPolicyProvider:
    def __init__(
        self,
        default: PublicationPolicy | None = None,
        per_institution: dict[str, PublicationPolicy] | None = None,
    ) -> None:
        self.default = default or PublicationPolicy()
        self.per_institution = per_institution or {}

    async def get_policy(self, institution_id: str) -> PublicationPolicy:
        return self.per_institution.get(institution_id, self.default)


class ProcessedEventStore(Protocol):
    """Idempotent consumption of bus deliveries (V002 ``processed_events``)."""

    async def is_processed(self, event_id: str, consumer: str) -> bool: ...
    async def mark_processed(self, event_id: str, consumer: str) -> None: ...


class InMemoryProcessedEventStore:
    def __init__(self) -> None:
        self.processed: set[tuple[str, str]] = set()

    async def is_processed(self, event_id: str, consumer: str) -> bool:
        return (event_id, consumer) in self.processed

    async def mark_processed(self, event_id: str, consumer: str) -> None:
        self.processed.add((event_id, consumer))
