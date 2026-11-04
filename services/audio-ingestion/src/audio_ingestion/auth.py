"""FastAPI dependency that authenticates signed device requests (contract §3)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import HTTPException, Request, status

from audio_ingestion.config import Dependencies
from audio_ingestion.ports import DeviceIdentity, DeviceKeyResolver
from audio_ingestion.signing import (
    HEADER_DEVICE_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    SignatureError,
    verify_request,
)

REJECTED_STATUSES = frozenset({"revoked", "decommissioned"})


def device_authenticator(deps: Dependencies) -> Callable[[Request], Awaitable[DeviceIdentity]]:
    resolver: DeviceKeyResolver = deps.key_resolver

    async def authenticate(request: Request) -> DeviceIdentity:
        device_id = request.headers.get(HEADER_DEVICE_ID)
        timestamp = request.headers.get(HEADER_TIMESTAMP)
        signature = request.headers.get(HEADER_SIGNATURE)
        if not device_id or not timestamp or not signature:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="missing device signature headers"
            )
        identity = await resolver.resolve(device_id)
        if identity is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unknown device")
        if identity.status in REJECTED_STATUSES:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail=f"device is {identity.status}")

        path = request.url.path
        if request.url.query:
            path = f"{path}?{request.url.query}"
        body = await request.body()
        try:
            verify_request(
                identity.public_key_pem,
                request.method,
                path,
                timestamp,
                body,
                signature,
                now=deps.clock(),
            )
        except SignatureError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
        return identity

    return authenticate
