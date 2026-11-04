"""Service-to-service authentication (integration-stage §4)."""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable

import structlog
from fastapi import Header, HTTPException, status

log = structlog.get_logger(__name__)

HEADER = "x-internal-token"


def internal_token_dependency(token: str | None) -> Callable[..., Awaitable[None]]:
    """FastAPI dependency requiring ``x-internal-token == token`` (constant-time).

    With no token configured the routes stay open (development only) and a warning is
    logged once at start-up.
    """
    if not token:
        log.warning("internal_token.disabled", detail="INTERNAL_API_TOKEN unset; routes open")

    async def check(x_internal_token: str | None = Header(default=None)) -> None:
        if not token:
            return
        if x_internal_token is None or not hmac.compare_digest(
            x_internal_token.encode(), token.encode()
        ):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid internal token")

    return check
