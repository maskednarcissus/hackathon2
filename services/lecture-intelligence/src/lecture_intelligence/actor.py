"""Caller attribution for engagement audit events (integration stage §5).

The actor comes from the identity bearer token (EdDSA / Ed25519 JWT verified against the JWKS at
``IDENTITY_JWKS_URL``) when present, otherwise from the ``X-Actor-Id`` / ``X-Actor-Role`` headers
set by the BFF. Without a configured JWKS the token is only *decoded* (dev only, warned at
start-up).
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from dataclasses import dataclass
from typing import Any

import httpx
import structlog
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Request

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class Actor:
    actor_id: str
    role: str
    institution_id: str | None = None
    verified: bool = False


def _b64decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def decode_unverified(token: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(_b64decode(token.split(".")[1]))
    except (IndexError, ValueError, binascii.Error):
        return None
    return payload if isinstance(payload, dict) else None


class JwksVerifier:
    def __init__(
        self,
        jwks_url: str | None = None,
        *,
        keys: dict[str, Ed25519PublicKey] | None = None,
        issuer: str = "ci-identity",
        audience: str = "ci",
        cache_seconds: float = 600.0,
        leeway_seconds: int = 30,
    ) -> None:
        self._url = jwks_url
        self._keys: dict[str, Ed25519PublicKey] = dict(keys or {})
        self._fetched_at = time.monotonic() if keys else 0.0
        self._issuer = issuer
        self._audience = audience
        self._cache_seconds = cache_seconds
        self._leeway = leeway_seconds

    async def _refresh(self) -> None:
        if not self._url:
            return
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(self._url)
                response.raise_for_status()
                body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("jwks_fetch_failed", error=str(exc))
            return
        keys: dict[str, Ed25519PublicKey] = {}
        for jwk in body.get("keys", []):
            if jwk.get("kty") == "OKP" and jwk.get("crv") == "Ed25519" and "x" in jwk:
                keys[str(jwk.get("kid", ""))] = Ed25519PublicKey.from_public_bytes(
                    _b64decode(jwk["x"])
                )
        self._keys = keys
        self._fetched_at = time.monotonic()

    async def verify(self, token: str) -> dict[str, Any] | None:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        try:
            header = json.loads(_b64decode(parts[0]))
            payload = json.loads(_b64decode(parts[1]))
            signature = _b64decode(parts[2])
        except (ValueError, binascii.Error):
            return None
        if not isinstance(header, dict) or header.get("alg") != "EdDSA":
            return None
        kid = str(header.get("kid", ""))
        stale = time.monotonic() - self._fetched_at > self._cache_seconds
        if kid not in self._keys or stale:
            await self._refresh()
        key = self._keys.get(kid)
        if key is None:
            return None
        try:
            key.verify(signature, f"{parts[0]}.{parts[1]}".encode("ascii"))
        except InvalidSignature:
            return None
        if not isinstance(payload, dict):
            return None
        now = time.time()
        aud = payload.get("aud")
        audiences = aud if isinstance(aud, list) else [aud]
        if (
            payload.get("iss") != self._issuer
            or self._audience not in audiences
            or not isinstance(payload.get("exp"), int | float)
            or payload["exp"] + self._leeway < now
        ):
            return None
        return payload


class ActorResolver:
    def __init__(self, verifier: JwksVerifier | None, *, allow_unverified: bool = False) -> None:
        self._verifier = verifier
        self._allow_unverified = allow_unverified
        if verifier is None and allow_unverified:
            log.warning("actor_tokens_unverified", detail="IDENTITY_JWKS_URL unset (dev only)")

    async def resolve(self, request: Request) -> Actor | None:
        authorization = request.headers.get("authorization", "")
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
            claims: dict[str, Any] | None = None
            verified = False
            if self._verifier is not None:
                claims = await self._verifier.verify(token)
                verified = claims is not None
            elif self._allow_unverified:
                claims = decode_unverified(token)
            if not claims:
                return None
            actor_id = claims.get("pid") or claims.get("sub")
            if not isinstance(actor_id, str):
                return None
            institution = claims.get("inst")
            return Actor(
                actor_id=actor_id,
                role=str(claims.get("role", "unknown")),
                institution_id=institution if isinstance(institution, str) else None,
                verified=verified,
            )
        actor_id = request.headers.get("x-actor-id")
        if actor_id:
            return Actor(
                actor_id=actor_id,
                role=request.headers.get("x-actor-role", "student"),
                institution_id=request.headers.get("x-institution-id"),
            )
        return None
