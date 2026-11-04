"""Ports to other services (AI gateway, transcript-management, audit, Pub/Sub) and adapters."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx
import structlog

from lecture_intelligence.models import SearchResult, Segment

log = structlog.get_logger(__name__)


class GatewayCallError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class GatewayClient(Protocol):
    async def generate(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class HttpGatewayClient:
    def __init__(self, base_url: str, timeout_s: float = 180.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s

    async def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(f"{self._base_url}/v1/generate", json=payload)
        except httpx.HTTPError as exc:
            raise GatewayCallError("gateway_unreachable", str(exc), 503) from exc
        if response.status_code != 200:
            error = _error_body(response)
            raise GatewayCallError(
                str(error.get("code", "gateway_error")),
                str(error.get("message", response.text[:500])),
                response.status_code,
            )
        body: dict[str, Any] = response.json()
        return body


class TranscriptNotFoundError(LookupError):
    pass


class TranscriptClient(Protocol):
    async def get_transcript(self, transcript_id: str) -> dict[str, Any]: ...

    async def get_segments(self, transcript_id: str) -> list[Segment]: ...


class HttpTranscriptClient:
    """Reads transcripts from transcript-management (``GET /v1/transcripts/{id}[/segments]``)."""

    def __init__(self, base_url: str, timeout_s: float = 30.0, page_size: int = 500) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s
        self._page_size = page_size

    async def get_transcript(self, transcript_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(f"{self._base_url}/v1/transcripts/{transcript_id}")
        if response.status_code == 404:
            raise TranscriptNotFoundError(transcript_id)
        response.raise_for_status()
        body: dict[str, Any] = response.json()
        return body

    async def get_segments(self, transcript_id: str) -> list[Segment]:
        segments: list[Segment] = []
        params: dict[str, str | int] = {"limit": self._page_size}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for _ in range(10_000):
                response = await client.get(
                    f"{self._base_url}/v1/transcripts/{transcript_id}/segments", params=params
                )
                if response.status_code == 404:
                    raise TranscriptNotFoundError(transcript_id)
                response.raise_for_status()
                body = response.json()
                items: list[Any] = (
                    (body.get("items") or body.get("segments") or [])
                    if isinstance(body, dict)
                    else list(body)
                )
                segments.extend(Segment.model_validate(item) for item in items)
                cursor = body.get("nextCursor") if isinstance(body, dict) else None
                if not cursor or not items:
                    break
                params = {"limit": self._page_size, "cursor": cursor}
        return segments


class EventPublisher(Protocol):
    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None: ...


def envelope(event_type: str, data: dict[str, Any], institution_id: str | None) -> dict[str, Any]:
    return {
        "eventId": str(uuid.uuid4()),
        "type": event_type,
        "version": 1,
        "occurredAt": datetime.now(UTC).isoformat(),
        "source": "lecture-intelligence",
        "institutionId": institution_id,
        "data": data,
    }


class InMemoryEventPublisher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        self.events.append(envelope(event_type, data, institution_id))


class PubSubEventPublisher:  # pragma: no cover - requires GCP
    def __init__(self, project_id: str) -> None:
        from google.cloud import pubsub_v1

        self._client: Any = pubsub_v1.PublisherClient()
        self._project = project_id

    async def publish(
        self, event_type: str, data: dict[str, Any], institution_id: str | None
    ) -> None:
        topic = self._client.topic_path(self._project, event_type.replace(".", "-"))
        payload = json.dumps(envelope(event_type, data, institution_id)).encode("utf-8")
        self._client.publish(topic, payload, type=event_type).result(timeout=30)


class AuditClient(Protocol):
    async def record(self, event: dict[str, Any]) -> None: ...


class InMemoryAuditClient:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def record(self, event: dict[str, Any]) -> None:
        self.events.append(event)


class HttpAuditClient:
    def __init__(self, base_url: str, timeout_s: float = 2.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s

    async def record(self, event: dict[str, Any]) -> None:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(f"{self._base_url}/v1/audit-events", json=event)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("audit_record_failed", action=event.get("action"), error=str(exc))


def _error_body(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    error = body.get("error") if isinstance(body, dict) else None
    return error if isinstance(error, dict) else {}


class SearchClient(Protocol):
    async def search(
        self, query: str, class_section_ids: list[str], limit: int, mode: str
    ) -> list[SearchResult]: ...


class HttpSearchClient:
    """transcript-management ``GET /v1/search`` (Phase 3 contract §3)."""

    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s

    async def search(
        self, query: str, class_section_ids: list[str], limit: int, mode: str
    ) -> list[SearchResult]:
        params: dict[str, str | int] = {
            "q": query,
            "classSectionIds": ",".join(class_section_ids),
            "limit": limit,
            "mode": mode,
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(f"{self._base_url}/v1/search", params=params)
        response.raise_for_status()
        body = response.json()
        return [SearchResult.model_validate(r) for r in body.get("results", [])]


class AcademicClient(Protocol):
    async def get_scheduled_class(self, scheduled_class_id: str) -> dict[str, Any] | None: ...


class HttpAcademicClient:
    """academic-integration ``GET /v1/scheduled-classes/{id}`` (with course and section)."""

    def __init__(self, base_url: str, timeout_s: float = 5.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s

    async def get_scheduled_class(self, scheduled_class_id: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(
                f"{self._base_url}/v1/scheduled-classes/{scheduled_class_id}"
            )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        body: dict[str, Any] = response.json()
        return body
