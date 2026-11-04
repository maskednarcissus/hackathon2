"""HTTP event-bus publisher (integration stage §2).

``POST {EVENT_BUS_URL}/v1/topics/{type}:publish`` with the envelope as JSON and the shared
``x-internal-token``. Used against the dev event bus locally; production uses Pub/Sub.
"""

from __future__ import annotations

import httpx
import structlog

from audio_ingestion.ports import EventEnvelope

log = structlog.get_logger(__name__)


class EventPublishError(RuntimeError):
    pass


class HttpEventBusPublisher:
    def __init__(
        self,
        base_url: str,
        internal_token: str | None = None,
        timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        headers = {"x-internal-token": internal_token} if internal_token else {}
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout, transport=transport
        )

    def publish(self, event: EventEnvelope) -> None:
        try:
            response = self._client.post(f"/v1/topics/{event.type}:publish", json=event.to_json())
            response.raise_for_status()
        except httpx.HTTPError as exc:
            # Raised to the caller: the request fails and the device retries; event ids are
            # deterministic, so a retried publish is deduplicated by subscribers.
            raise EventPublishError(f"publishing {event.type} failed: {exc}") from exc
        log.info("event.published", type=event.type, event_id=event.event_id)
