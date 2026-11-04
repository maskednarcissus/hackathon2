"""HTTP and Pub/Sub adapters for production wiring."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from transcription.models import TranscriptSegment
from transcription.ports import StoredTranscript

SERVICE_NAME = "transcription"


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
    """transcript-management ``POST /v1/transcripts``."""

    base_url: str
    timeout_s: float = 30.0
    client: httpx.AsyncClient | None = None

    async def create_transcript(
        self,
        *,
        recording_session_id: str,
        scheduled_class_id: str | None,
        language: str,
        processing_version: str,
        provider: str,
        model: str,
        segments: list[TranscriptSegment],
    ) -> StoredTranscript:
        body: dict[str, Any] = {
            "recordingSessionId": recording_session_id,
            "language": language,
            "processingVersion": processing_version,
            "provider": provider,
            "model": model,
            "segments": [s.dump() for s in segments],
        }
        if scheduled_class_id:
            body["scheduledClassId"] = scheduled_class_id
        client = self.client or httpx.AsyncClient(timeout=self.timeout_s)
        try:
            resp = await client.post(f"{self.base_url.rstrip('/')}/v1/transcripts", json=body)
            resp.raise_for_status()
            payload = resp.json()
        finally:
            if self.client is None:
                await client.aclose()
        transcript_id = payload.get("id") or payload.get("transcriptId")
        if not transcript_id:
            raise RuntimeError("transcript-management response missing transcript id")
        return StoredTranscript(transcript_id=str(transcript_id))


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
    """Publishes the §6 envelope to the topic named after the event type.

    ``topic_template`` supports ``{event}`` (``recording.uploaded``) and
    ``{event_dashed}`` (``recording-uploaded``), e.g. ``ci-{event_dashed}-prod``.
    """

    project_id: str
    topic_template: str = "{event}"
    _client: Any = field(default=None, init=False, repr=False)

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        import asyncio

        from google.cloud import pubsub_v1

        if self._client is None:
            self._client = pubsub_v1.PublisherClient()
        topic = self._client.topic_path(
            self.project_id,
            self.topic_template.format(event=event_type, event_dashed=event_type.replace(".", "-")),
        )
        payload = json.dumps(build_envelope(event_type, data, institution_id)).encode()
        future = self._client.publish(topic, payload, eventType=event_type)
        await asyncio.wrap_future(future)
