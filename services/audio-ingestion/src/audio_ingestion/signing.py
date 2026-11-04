"""Device request signing — Ed25519 over the ``CI-DEVICE-V1`` canonical string (contract §3)."""

from __future__ import annotations

import base64
import binascii
import hashlib
from datetime import datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

SIGNATURE_SCHEME = "CI-DEVICE-V1"
MAX_CLOCK_SKEW = timedelta(seconds=300)

HEADER_DEVICE_ID = "X-Device-Id"
HEADER_TIMESTAMP = "X-Device-Timestamp"
HEADER_SIGNATURE = "X-Device-Signature"


class SignatureError(Exception):
    """Raised when a device request signature is missing, stale or invalid."""


def canonical_string(method: str, path_with_query: str, timestamp: str, body: bytes) -> str:
    body_hash = hashlib.sha256(body).hexdigest()
    return "\n".join([SIGNATURE_SCHEME, method.upper(), path_with_query, timestamp, body_hash])


def sign_request(
    private_key: Ed25519PrivateKey,
    method: str,
    path_with_query: str,
    timestamp: str,
    body: bytes,
) -> str:
    """Return the base64 signature for a request (used by tests and tooling)."""
    message = canonical_string(method, path_with_query, timestamp, body).encode("utf-8")
    return base64.b64encode(private_key.sign(message)).decode("ascii")


def load_public_key(pem: str) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(pem.encode("utf-8"))
    if not isinstance(key, Ed25519PublicKey):
        raise SignatureError("device public key is not Ed25519")
    return key


def parse_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise SignatureError("X-Device-Timestamp is not ISO 8601") from exc
    if parsed.tzinfo is None:
        raise SignatureError("X-Device-Timestamp must be UTC with offset")
    return parsed


def verify_request(
    public_key_pem: str,
    method: str,
    path_with_query: str,
    timestamp: str,
    body: bytes,
    signature_b64: str,
    now: datetime,
) -> None:
    """Verify a signed device request; raise :class:`SignatureError` on any failure."""
    signed_at = parse_timestamp(timestamp)
    if abs(now - signed_at) > MAX_CLOCK_SKEW:
        raise SignatureError("X-Device-Timestamp outside the allowed clock skew")
    try:
        signature = base64.b64decode(signature_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SignatureError("X-Device-Signature is not valid base64") from exc
    public_key = load_public_key(public_key_pem)
    message = canonical_string(method, path_with_query, timestamp, body).encode("utf-8")
    try:
        public_key.verify(signature, message)
    except InvalidSignature as exc:
        raise SignatureError("signature does not match") from exc
