"""Service-to-service authentication with the shared ``INTERNAL_API_TOKEN`` (integration §4)."""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable

import structlog
from fastapi import HTTPException, Request, status

log = structlog.get_logger(__name__)

HEADER = "x-internal-token"


def internal_token_guard(token: str | None) -> Callable[[Request], Awaitable[None]]:
    """Dependency requiring ``x-internal-token`` when a token is configured.

    Unset token → open (development only; a warning is logged once at start-up).
    """
    if not token:
        log.warning(
            "internal_auth.disabled",
            message="INTERNAL_API_TOKEN is not set; internal endpoints are unauthenticated",
        )

    async def guard(request: Request) -> None:
        if not token:
            return
        provided = request.headers.get(HEADER, "")
        if not hmac.compare_digest(provided.encode(), token.encode()):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid internal token")

    return guard
