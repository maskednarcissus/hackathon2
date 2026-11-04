"""Ports for the diarization service."""

from __future__ import annotations

from typing import Any, Protocol

from speaker_diarization.models import SpeakerAssignment, TranscriptSegmentRef, TurnOut


class TranscriptStoreClient(Protocol):
    async def get_segments(self, transcript_id: str) -> list[TranscriptSegmentRef]: ...

    async def put_speakers(
        self,
        transcript_id: str,
        assignments: list[SpeakerAssignment],
        speaker_count: int,
        *,
        method: str,
        processing_version: str,
    ) -> None: ...


class TurnRepository(Protocol):
    """``speaker_turns`` — owned by this service."""

    async def replace(
        self, transcript_id: str, turns: list[TurnOut], processing_version: str
    ) -> None:
        """Atomically replace every turn of a transcript (re-diarization)."""
        ...

    async def list(self, transcript_id: str) -> list[TurnOut]: ...


class ProcessedEventStore(Protocol):
    async def is_processed(self, event_id: str) -> bool: ...

    async def mark_processed(self, event_id: str) -> None: ...


class Lifecycle(Protocol):
    async def open(self) -> None: ...

    async def close(self) -> None: ...


class EventPublisher(Protocol):
    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None: ...


class AuditSink(Protocol):
    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str,
        institution_id: str | None,
        metadata: dict[str, Any],
    ) -> None: ...
