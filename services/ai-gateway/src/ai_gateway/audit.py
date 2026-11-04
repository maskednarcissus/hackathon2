"""Audit client port (non-fatal: failures are logged, never raised)."""

from __future__ import annotations

from typing import Any, Protocol

import httpx
import structlog

log = structlog.get_logger(__name__)


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
