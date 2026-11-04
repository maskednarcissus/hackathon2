"""Gateway error types mapped to HTTP responses."""

from __future__ import annotations

from typing import Any


class GatewayError(Exception):
    """An error returned to callers as ``{"error": {code, message, details}}``."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


class ProviderError(Exception):
    """Raised by providers. ``transient`` errors are retried with backoff."""

    def __init__(self, message: str, *, transient: bool) -> None:
        super().__init__(message)
        self.transient = transient
