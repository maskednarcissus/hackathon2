"""In-memory adapters (development and tests)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from speaker_diarization.models import SpeakerAssignment, TranscriptSegmentRef, TurnOut


@dataclass
class InMemoryTranscriptStore:
    segments: dict[str, list[TranscriptSegmentRef]] = field(default_factory=dict)
    speakers: dict[str, dict[str, Any]] = field(default_factory=dict)

    async def get_segments(self, transcript_id: str) -> list[TranscriptSegmentRef]:
        return list(self.segments.get(transcript_id, []))

    async def put_speakers(
        self,
        transcript_id: str,
        assignments: list[SpeakerAssignment],
        speaker_count: int,
        *,
        method: str,
        processing_version: str,
    ) -> None:
        self.speakers[transcript_id] = {
            "assignments": [a.dump() for a in assignments],
            "speakerCount": speaker_count,
            "method": method,
            "processingVersion": processing_version,
        }


@dataclass
class InMemoryPublisher:
    events: list[dict[str, Any]] = field(default_factory=list)

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        self.events.append({"type": event_type, "data": data, "institutionId": institution_id})


@dataclass
class InMemoryAuditSink:
    records: list[dict[str, Any]] = field(default_factory=list)

    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str,
        institution_id: str | None,
        metadata: dict[str, Any],
    ) -> None:
        self.records.append(
            {
                "action": action,
                "resourceType": resource_type,
                "resourceId": resource_id,
                "institutionId": institution_id,
                "metadata": metadata,
            }
        )


@dataclass
class InMemoryTurnRepository:
    turns: dict[str, list[TurnOut]] = field(default_factory=dict)
    versions: dict[str, str] = field(default_factory=dict)

    async def replace(
        self, transcript_id: str, turns: list[TurnOut], processing_version: str
    ) -> None:
        self.turns[transcript_id] = [t.model_copy() for t in turns]
        self.versions[transcript_id] = processing_version

    async def list(self, transcript_id: str) -> list[TurnOut]:
        return [t.model_copy() for t in self.turns.get(transcript_id, [])]


@dataclass
class InMemoryProcessedEvents:
    seen: set[str] = field(default_factory=set)

    async def is_processed(self, event_id: str) -> bool:
        return event_id in self.seen

    async def mark_processed(self, event_id: str) -> None:
        self.seen.add(event_id)
