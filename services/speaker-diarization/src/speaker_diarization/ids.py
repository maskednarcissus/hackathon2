"""Identifier helpers."""

from __future__ import annotations

import uuid


def check_uuid(value: str) -> str:
    """Validate a UUID string and return its canonical lowercase form."""
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError(f"must be a UUID, got {value!r}") from exc


def is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True
