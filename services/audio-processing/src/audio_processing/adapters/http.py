"""HTTP adapter for the audit service."""

from __future__ import annotations

import httpx
import structlog

from audio_processing.ports import AuditRecord

log = structlog.get_logger(__name__)


class HttpAuditClient:
    """Best-effort forwarder to the audit service (``POST /v1/audit-events``).

    Audit delivery failures are logged, never raised: audio processing must not stall
    because the audit service is temporarily unavailable. Production deployments
    should prefer the Pub/Sub ``audit-events`` topic for guaranteed delivery.
    """

    def __init__(
        self, base_url: str, internal_token: str | None = None, timeout: float = 3.0
    ) -> None:
        self._url = base_url.rstrip("/") + "/v1/audit-events"
        self._timeout = timeout
        self._headers = {"x-internal-token": internal_token} if internal_token else {}

    def record(self, record: AuditRecord) -> None:
        payload = {
            "tenantId": record.institution_id,
            "actorId": record.actor_id,
            "actorType": record.actor_type,
            "action": record.action,
            "resourceType": record.resource_type,
            "resourceId": record.resource_id,
            "metadata": record.metadata,
            "occurredAt": record.occurred_at.isoformat(),
        }
        try:
            httpx.post(
                self._url, json=payload, headers=self._headers, timeout=self._timeout
            ).raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("audit.delivery_failed", action=record.action, error=str(exc))
