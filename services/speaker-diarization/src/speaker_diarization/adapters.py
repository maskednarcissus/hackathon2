"""In-memory and production adapters."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from speaker_diarization.models import SpeakerAssignment, TranscriptSegmentRef

SERVICE_NAME = "speaker-diarization"


# --------------------------------------------------------------------------- in-memory


@dataclass
class InMemoryTranscriptStore:
    segments: dict[str, list[TranscriptSegmentRef]] = field(default_factory=dict)
    speakers: dict[str, dict[str, Any]] = field(default_factory=dict)

    async def get_segments(self, transcript_id: str) -> list[TranscriptSegmentRef]:
        return list(self.segments.get(transcript_id, []))

    async def put_speakers(
        self, transcript_id: str, assignments: list[SpeakerAssignment], speaker_count: int
    ) -> None:
        self.speakers[transcript_id] = {
            "assignments": [a.dump() for a in assignments],
            "speakerCount": speaker_count,
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


# --------------------------------------------------------------------------- production


def build_envelope(
    event_type: str, data: dict[str, Any], institution_id: str | None
) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "eventId": str(uuid.uuid4()),
        "type": event_type,
        "version": 1,
        "occurredAt": datetime.now(UTC).isoformat(),
        "source": SERVICE_NAME,
        "data": data,
    }
    if institution_id:
        envelope["institutionId"] = institution_id
    return envelope


@dataclass
class HttpTranscriptStoreClient:
    """transcript-management: ``GET /v1/transcripts/{id}/segments`` and
    ``PUT /v1/transcripts/{id}/speakers``."""

    base_url: str
    timeout_s: float = 30.0

    def _url(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{path}"

    async def get_segments(self, transcript_id: str) -> list[TranscriptSegmentRef]:
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.get(self._url(f"/v1/transcripts/{transcript_id}/segments"))
            resp.raise_for_status()
            payload = resp.json()
        items = (
            payload
            if isinstance(payload, list)
            else payload.get("segments", payload.get("items", []))
        )
        return [TranscriptSegmentRef.model_validate(item) for item in items]

    async def put_speakers(
        self, transcript_id: str, assignments: list[SpeakerAssignment], speaker_count: int
    ) -> None:
        body = {"assignments": [a.dump() for a in assignments], "speakerCount": speaker_count}
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.put(
                self._url(f"/v1/transcripts/{transcript_id}/speakers"), json=body
            )
            resp.raise_for_status()


@dataclass
class HttpAuditSink:
    """audit service ``POST /v1/audit-events`` (system actor)."""

    base_url: str
    timeout_s: float = 10.0

    async def record(
        self,
        *,
        action: str,
        resource_type: str,
        resource_id: str,
        institution_id: str | None,
        metadata: dict[str, Any],
    ) -> None:
        body: dict[str, Any] = {
            "actorType": "system",
            "actorId": SERVICE_NAME,
            "action": action,
            "resourceType": resource_type,
            "resourceId": resource_id,
            "metadata": metadata,
        }
        if institution_id:
            body["tenantId"] = institution_id
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            resp = await client.post(f"{self.base_url.rstrip('/')}/v1/audit-events", json=body)
            resp.raise_for_status()


@dataclass
class PubSubPublisher:
    """§6 envelope → topic from ``topic_template`` (``{event}`` / ``{event_dashed}``)."""

    project_id: str
    topic_template: str = "{event}"
    _client: Any = field(default=None, init=False, repr=False)

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        from google.cloud import pubsub_v1

        if self._client is None:
            self._client = pubsub_v1.PublisherClient()
        topic = self._client.topic_path(
            self.project_id,
            self.topic_template.format(event=event_type, event_dashed=event_type.replace(".", "-")),
        )
        payload = json.dumps(build_envelope(event_type, data, institution_id)).encode()
        await asyncio.wrap_future(self._client.publish(topic, payload, eventType=event_type))
