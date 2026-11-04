"""Time helpers. All timestamps exchanged with the cloud are ISO 8601 UTC."""

from __future__ import annotations

from datetime import UTC, datetime


def utcnow() -> datetime:
    return datetime.now(UTC)


def to_iso(value: datetime) -> str:
    """Format as ``2026-11-04T19:00:00.000Z``."""
    if value.tzinfo is None:
        raise ValueError("naive datetime not allowed")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp without offset: {value!r}")
    return parsed.astimezone(UTC)
