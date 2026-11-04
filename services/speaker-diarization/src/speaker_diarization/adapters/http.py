"""HTTP, event-bus and Pub/Sub adapters.

Outbound calls carry ``x-internal-token`` when ``INTERNAL_API_TOKEN`` is configured.
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

from speaker_diarization.ids import is_uuid
from speaker_diarization.models import SpeakerAssignment, TranscriptSegmentRef

SERVICE_NAME = "speaker-diarization"
log = structlog.get_logger(__name__)

#: transcript-management caps ``GET /v1/transcripts/{id}/segments`` at 50 per page.
SEGMENT_PAGE_SIZE = 50


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
class _HttpBase:
    base_url: str
    internal_token: str | None = None
    timeout_s: float = 30.0
    client: httpx.AsyncClient | None = None

    def _url(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{path}"

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {"x-internal-token": self.internal_token} if self.internal_token else {}
        if self.client is not None:
            return await self.client.request(method, self._url(path), headers=headers, **kwargs)
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            return await client.request(method, self._url(path), headers=headers, **kwargs)


@dataclass
class HttpTranscriptStoreClient(_HttpBase):
    """transcript-management: paged ``GET /v1/transcripts/{id}/segments`` and
    ``PUT /v1/transcripts/{id}/speakers``."""

    async def get_segments(self, transcript_id: str) -> list[TranscriptSegmentRef]:
        out: list[TranscriptSegmentRef] = []
        cursor: int | None = None
        while True:
            params: dict[str, Any] = {"limit": SEGMENT_PAGE_SIZE}
            if cursor is not None:
                params["cursor"] = cursor
            resp = await self._request(
                "GET", f"/v1/transcripts/{transcript_id}/segments", params=params
            )
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload, list):
                return [TranscriptSegmentRef.model_validate(i) for i in payload]
            items = payload.get("items", payload.get("segments", []))
            out.extend(TranscriptSegmentRef.model_validate(i) for i in items)
            next_cursor = payload.get("nextCursor")
            if next_cursor is None or next_cursor == cursor or not items:
                return out
            cursor = int(next_cursor)

    async def put_speakers(
        self,
        transcript_id: str,
        assignments: list[SpeakerAssignment],
        speaker_count: int,
        *,
        method: str,
        processing_version: str,
    ) -> None:
        body = {
            "assignments": [a.dump() for a in assignments],
            "speakerCount": speaker_count,
            # transcripts.diarization_method / diarization_version (V002)
            "method": method,
            "processingVersion": processing_version,
        }
        resp = await self._request("PUT", f"/v1/transcripts/{transcript_id}/speakers", json=body)
        resp.raise_for_status()


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
    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        log.info("event.published", type=event_type, institution_id=institution_id, data=data)


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
