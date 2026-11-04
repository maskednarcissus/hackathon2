"""Service-to-service authentication (integration stage §4): ``x-internal-token``."""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

log = structlog.get_logger(__name__)


def install_internal_token(
    app: FastAPI, token: str | None, protected: Callable[[str], bool]
) -> None:
    """Require ``x-internal-token`` (constant-time compare) on paths where ``protected(path)``."""

    if not token:
        log.warning("internal_token_unset", detail="internal endpoints are open (dev only)")
        return
    expected = token.encode("utf-8")

    @app.middleware("http")
    async def _check(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if protected(request.url.path):
            presented = request.headers.get("x-internal-token", "").encode("utf-8")
            if not hmac.compare_digest(presented, expected):
                return JSONResponse(
                    {"error": {"code": "unauthorized", "message": "Invalid internal token"}},
                    status_code=401,
                )
        return await call_next(request)
