"""HTTP adapters for sibling services (device-management, audit)."""

from __future__ import annotations

import time
from typing import Any

import httpx
import structlog

from audio_ingestion.ports import AuditRecord, DeviceIdentity

log = structlog.get_logger(__name__)


class HttpDeviceKeyResolver:
    """Resolves device keys via ``GET /internal/v1/devices/{id}/public-key`` (contract §3)."""

    def __init__(
        self,
        base_url: str,
        internal_token: str | None = None,
        cache_ttl_seconds: float = 60.0,
        timeout: float = 5.0,
    ):
        self._base_url = base_url.rstrip("/")
        self._headers = {"x-internal-token": internal_token} if internal_token else {}
        self._ttl = cache_ttl_seconds
        self._timeout = timeout
        self._cache: dict[str, tuple[float, DeviceIdentity | None]] = {}

    async def resolve(self, device_id: str) -> DeviceIdentity | None:
        cached = self._cache.get(device_id)
        if cached and time.monotonic() - cached[0] < self._ttl:
            return cached[1]
        url = f"{self._base_url}/internal/v1/devices/{device_id}/public-key"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(url, headers=self._headers)
        identity: DeviceIdentity | None
        if response.status_code == httpx.codes.NOT_FOUND:
            identity = None
        else:
            response.raise_for_status()
            body: dict[str, Any] = response.json()
            identity = DeviceIdentity(
                device_id=str(body["deviceId"]),
                public_key_pem=str(body["publicKeyPem"]),
                status=str(body.get("status", "online")),
                classroom_id=body.get("classroomId"),
                institution_id=body.get("institutionId"),
            )
        self._cache[device_id] = (time.monotonic(), identity)
        return identity


class HttpAuditClient:
    """Best-effort forwarder to the audit service (``POST /v1/audit-events``).

    Audit delivery failures are logged, never raised: the ingestion path must not lose
    audio because the audit service is temporarily unavailable. Production deployments
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
