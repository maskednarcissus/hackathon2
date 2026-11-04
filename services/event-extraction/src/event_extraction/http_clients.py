"""HTTP adapters for the ports (production wiring)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from .models import ClassContext, Conflict, ScheduledClassRef, TranscriptSegment
from .ports import NotFoundError, TranscriptData, UpstreamError

log = logging.getLogger("event_extraction.http")

INTERNAL_TOKEN_HEADER = "x-internal-token"


def internal_headers(token: str | None) -> dict[str, str]:
    return {INTERNAL_TOKEN_HEADER: token} if token else {}


def make_envelope(
    event_type: str, data: dict[str, Any], institution_id: str | None
) -> dict[str, Any]:
    """Phase 1 contract §6 envelope."""
    return {
        "eventId": str(uuid.uuid4()),
        "type": event_type,
        "version": 1,
        "occurredAt": datetime.now(UTC).isoformat(),
        "source": "event-extraction",
        "institutionId": institution_id,
        "data": data,
    }


async def _request(
    client: httpx.AsyncClient, method: str, url: str, **kwargs: Any
) -> httpx.Response:
    try:
        response = await client.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"{method} {url}: {exc}") from exc
    if response.status_code == 404:
        raise NotFoundError(url)
    if response.status_code >= 400:
        raise UpstreamError(f"{method} {url}: HTTP {response.status_code} {response.text[:300]}")
    return response


class HttpGatewayClient:
    def __init__(
        self,
        base_url: str,
        timeout: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
        internal_token: str | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers=internal_headers(internal_token),
        )

    async def generate(self, request: dict[str, Any]) -> dict[str, Any]:
        response = await _request(self._client, "POST", "/v1/generate", json=request)
        body: dict[str, Any] = response.json()
        return body


class HttpCalendarClient:
    def __init__(
        self,
        base_url: str,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
        internal_token: str | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers=internal_headers(internal_token),
        )

    async def check_conflicts(self, payload: dict[str, Any]) -> list[Conflict]:
        response = await _request(self._client, "POST", "/v1/conflicts/check", json=payload)
        return [Conflict.model_validate(c) for c in response.json().get("conflicts", [])]

    async def publish(self, payload: dict[str, Any]) -> str:
        response = await _request(self._client, "POST", "/v1/calendar-events", json=payload)
        body = response.json()
        event = body.get("event", body) if isinstance(body, dict) else {}
        return str(event.get("id"))


def _get(d: dict[str, Any], *paths: str) -> Any:
    for path in paths:
        cur: Any = d
        for part in path.split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
        if cur is not None:
            return cur
    return None


def _items(body: Any) -> list[dict[str, Any]]:
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("items", "scheduledClasses", "data", "results", "segments"):
            value = body.get(key)
            if isinstance(value, list):
                return value
    return []


def _local_date(iso: str, tz: str) -> date:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(ZoneInfo(tz)).date()


class HttpAcademicClient:
    """academic-integration adapter (GET /v1/scheduled-classes/{id}, list by section)."""

    def __init__(
        self,
        base_url: str,
        timeout: float = 10.0,
        horizon_days: int = 120,
        transport: httpx.AsyncBaseTransport | None = None,
        internal_token: str | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers=internal_headers(internal_token),
        )
        self._horizon = horizon_days

    async def get_class_context(self, scheduled_class_id: str) -> ClassContext:
        response = await _request(
            self._client, "GET", f"/v1/scheduled-classes/{scheduled_class_id}"
        )
        body = response.json()
        sc = body.get("scheduledClass", body) if isinstance(body, dict) else {}
        tz = str(
            _get(sc, "timezone", "campus.timezone", "classroom.timezone") or "America/Sao_Paulo"
        )
        starts_at = str(_get(sc, "startsAt", "starts_at"))
        class_date = _local_date(starts_at, tz)
        section_id = str(_get(sc, "classSectionId", "classSection.id", "section.id"))
        upcoming: list[ScheduledClassRef] = []
        try:
            start = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
            listing = await _request(
                self._client,
                "GET",
                "/v1/scheduled-classes",
                params={
                    "classSectionId": section_id,
                    "from": (start + timedelta(hours=1)).isoformat(),
                    "to": (start + timedelta(days=self._horizon)).isoformat(),
                },
            )
            for item in _items(listing.json()):
                if item.get("status") == "cancelled":
                    continue
                item_start = _get(item, "startsAt", "starts_at")
                if item_start:
                    upcoming.append(
                        ScheduledClassRef(
                            scheduled_class_id=str(item.get("id")),
                            class_date=_local_date(str(item_start), tz),
                        )
                    )
        except (UpstreamError, NotFoundError) as exc:
            log.warning("could not list upcoming classes for %s: %s", section_id, exc)
        return ClassContext(
            scheduled_class_id=scheduled_class_id,
            class_date=class_date,
            timezone=tz,
            institution_id=str(_get(sc, "institutionId", "course.institutionId")),
            course_id=str(_get(sc, "courseId", "course.id", "classSection.courseId")),
            course_name=_get(sc, "courseName", "course.name"),
            class_section_id=section_id,
            professor_id=_get(sc, "professorId", "professor.id", "classSection.professorId"),
            upcoming_classes=sorted(upcoming, key=lambda c: c.class_date),
        )


class HttpTranscriptClient:
    def __init__(
        self,
        base_url: str,
        timeout: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
        internal_token: str | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers=internal_headers(internal_token),
        )

    async def get_transcript(self, transcript_id: str) -> TranscriptData:
        response = await _request(self._client, "GET", f"/v1/transcripts/{transcript_id}")
        body = response.json()
        t = body.get("transcript", body)
        raw_segments = t.get("segments")
        if raw_segments is None:
            raw_segments = []
            cursor: str | None = None
            while True:
                params: dict[str, str] = {"limit": "500"}
                if cursor:
                    params["cursor"] = cursor
                page = await _request(
                    self._client, "GET", f"/v1/transcripts/{transcript_id}/segments", params=params
                )
                page_body = page.json()
                raw_segments.extend(_items(page_body))
                cursor = page_body.get("nextCursor") if isinstance(page_body, dict) else None
                if not cursor:
                    break
        return TranscriptData(
            transcript_id=transcript_id,
            recording_session_id=t.get("recordingSessionId"),
            scheduled_class_id=t.get("scheduledClassId"),
            segments=[TranscriptSegment.model_validate(s) for s in raw_segments],
        )


class HttpAuditClient:
    def __init__(
        self,
        base_url: str,
        timeout: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
        internal_token: str | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers=internal_headers(internal_token),
        )

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
        body: dict[str, Any] = {
            "action": action,
            "resourceType": resource_type,
            "actorType": actor_type,
            "metadata": metadata or {},
        }
        if resource_id:
            body["resourceId"] = resource_id
        if tenant_id:
            body["tenantId"] = tenant_id
        if actor_id:
            body["actorId"] = actor_id
        try:
            await _request(self._client, "POST", "/v1/audit-events", json=body)
        except (UpstreamError, NotFoundError) as exc:
            log.warning("audit event %s not recorded: %s", action, exc)


class LoggingEventPublisher:
    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        log.info("event %s %s", event_type, data)


class HttpEventBusPublisher:
    """Integration stage §2: ``POST {EVENT_BUS_URL}/v1/topics/{type}:publish``."""

    def __init__(
        self,
        base_url: str,
        internal_token: str | None = None,
        *,
        attempts: int = 3,
        backoff_seconds: float = 0.2,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=10.0,
            transport=transport,
            headers=internal_headers(internal_token),
        )
        self._attempts = attempts
        self._backoff = backoff_seconds

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        import asyncio

        envelope = make_envelope(event_type, data, institution_id)
        last: Exception | None = None
        for attempt in range(self._attempts):
            try:
                await _request(
                    self._client, "POST", f"/v1/topics/{event_type}:publish", json=envelope
                )
                return
            except (UpstreamError, NotFoundError) as exc:
                last = exc
                await asyncio.sleep(self._backoff * (2**attempt))
        raise UpstreamError(f"event bus publish {event_type} failed: {last}")


class PubSubEventPublisher:
    """Publishes the §6 envelope to a Pub/Sub topic named after the event type."""

    def __init__(self, project_id: str) -> None:
        from google.cloud import pubsub_v1

        self._publisher = pubsub_v1.PublisherClient()
        self._project = project_id

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        import json

        envelope = make_envelope(event_type, data, institution_id)
        topic = self._publisher.topic_path(self._project, event_type)
        self._publisher.publish(topic, json.dumps(envelope).encode())
