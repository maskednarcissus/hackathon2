"""HTTP, event-bus and Pub/Sub adapters for production wiring.

Every outbound call to a platform service carries ``x-internal-token`` when
``INTERNAL_API_TOKEN`` is configured (integration-stage §4).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog

from transcription.ids import is_uuid
from transcription.models import TranscriptSegment
from transcription.ports import ClassContext, StoredTranscript

SERVICE_NAME = "transcription"
log = structlog.get_logger(__name__)


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


def internal_headers(token: str | None) -> dict[str, str]:
    return {"x-internal-token": token} if token else {}


@dataclass
class _HttpBase:
    base_url: str
    internal_token: str | None = None
    timeout_s: float = 30.0
    client: httpx.AsyncClient | None = None

    def _url(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{path}"

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {**internal_headers(self.internal_token), **kwargs.pop("headers", {})}
        if self.client is not None:
            return await self.client.request(method, self._url(path), headers=headers, **kwargs)
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            return await client.request(method, self._url(path), headers=headers, **kwargs)


@dataclass
class HttpTranscriptStoreClient(_HttpBase):
    """transcript-management ``POST /v1/transcripts``.

    A ``409 transcript_exists`` (same recording + processing version, e.g. a retry after a
    crash between storing and acknowledging) is treated as success with the existing id.
    """

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
        class_section_id: str | None = None,
        institution_id: str | None = None,
    ) -> StoredTranscript:
        body: dict[str, Any] = {
            "recordingSessionId": recording_session_id,
            "language": language,
            "processingVersion": processing_version,
            "provider": provider,
            "model": model,
            "segments": [s.dump() for s in segments],
        }
        for key, value in (
            ("scheduledClassId", scheduled_class_id),
            ("classSectionId", class_section_id),
            ("institutionId", institution_id),
        ):
            if value:
                body[key] = value
        resp = await self._request("POST", "/v1/transcripts", json=body)
        if resp.status_code == 409:
            details = (resp.json().get("error") or {}).get("details") or {}
            existing = details.get("transcriptId")
            if existing:
                return StoredTranscript(transcript_id=str(existing))
        resp.raise_for_status()
        payload = resp.json()
        transcript_id = payload.get("id") or payload.get("transcriptId")
        if not transcript_id:
            raise RuntimeError("transcript-management response missing transcript id")
        return StoredTranscript(transcript_id=str(transcript_id))


@dataclass
class HttpAuditSink(_HttpBase):
    """audit ``POST /v1/audit-events`` (system actor; ``actorId`` is the service label)."""

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
            "metadata": metadata,
        }
        if is_uuid(resource_id):
            body["resourceId"] = resource_id
        else:
            body["metadata"] = {**metadata, "resourceRef": resource_id}
        if institution_id:
            body["tenantId"] = institution_id
        resp = await self._request("POST", "/v1/audit-events", json=body)
        resp.raise_for_status()


@dataclass
class HttpEventBusPublisher(_HttpBase):
    """Integration-stage §2: ``POST {EVENT_BUS_URL}/v1/topics/{type}:publish``."""

    timeout_s: float = 10.0

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        envelope = build_envelope(event_type, data, institution_id)
        resp = await self._request("POST", f"/v1/topics/{event_type}:publish", json=envelope)
        resp.raise_for_status()


@dataclass
class LoggingPublisher:
    """Fallback when no bus is configured: events are only logged."""

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        log.info("event.published", type=event_type, institution_id=institution_id, data=data)


@dataclass
class HttpClassContextResolver(_HttpBase):
    """academic-integration lookups.

    * ``GET /v1/scheduled-classes/{id}`` when the recording knows its scheduled class.
    * ``POST /v1/class-identification`` (classroom + recording bounds) otherwise; only a
      ``matched`` result is used.
    """

    timeout_s: float = 10.0

    async def resolve(
        self,
        *,
        scheduled_class_id: str | None,
        classroom_id: str | None,
        started_at: datetime | None,
        ended_at: datetime | None,
        recording_session_id: str,
    ) -> ClassContext | None:
        if scheduled_class_id:
            resp = await self._request("GET", f"/v1/scheduled-classes/{scheduled_class_id}")
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return _context_from_scheduled_class(resp.json())
        if classroom_id and started_at and ended_at:
            body = {
                "classroomId": classroom_id,
                "startedAt": started_at.isoformat(),
                "endedAt": ended_at.isoformat(),
                "recordingSessionId": recording_session_id,
            }
            resp = await self._request("POST", "/v1/class-identification", json=body)
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("status") != "matched" or not payload.get("scheduledClass"):
                return None
            return _context_from_scheduled_class(payload["scheduledClass"])
        return None


def _context_from_scheduled_class(sc: dict[str, Any]) -> ClassContext:
    course = sc.get("course") or {}
    section = sc.get("classSection") or {}
    return ClassContext(
        scheduled_class_id=sc.get("id"),
        class_section_id=sc.get("classSectionId"),
        institution_id=sc.get("institutionId"),
        discipline=course.get("discipline"),
        # Phase 6.4: section language overrides the course's; either may be absent.
        language=sc.get("language") or section.get("language") or course.get("language"),
    )


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
