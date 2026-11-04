"""Signed HTTP clients for device-management and audio-ingestion (contract §3–§5)."""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Generator
from datetime import datetime
from typing import Any, cast

import httpx

from ci_agent.identity import DeviceIdentity
from ci_agent.timeutil import to_iso, utcnow

JsonDict = dict[str, Any]


class ApiError(Exception):
    """Non-2xx response from the cloud."""

    def __init__(self, status_code: int, body: str, url: str) -> None:
        super().__init__(f"HTTP {status_code} from {url}: {body[:300]}")
        self.status_code = status_code
        self.body = body
        self.url = url

    @property
    def retryable(self) -> bool:
        return self.status_code == 429 or self.status_code >= 500


class DeviceAuth(httpx.Auth):
    """Adds ``X-Device-*`` signature headers to every request."""

    requires_request_body = True

    def __init__(
        self,
        identity: DeviceIdentity,
        device_id: str,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._identity = identity
        self._device_id = device_id
        self._clock = clock

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        path = request.url.raw_path.decode("ascii")
        headers = self._identity.signed_headers(
            self._device_id, request.method, path, request.content, self._clock()
        )
        request.headers.update(headers)
        yield request


def _check(response: httpx.Response) -> httpx.Response:
    if response.status_code >= 400:
        raise ApiError(response.status_code, response.text, str(response.url))
    return response


def _json(response: httpx.Response) -> JsonDict:
    return cast(JsonDict, _check(response).json())


def register_device(
    base_url: str,
    *,
    provisioning_token: str,
    serial_number: str,
    model: str,
    firmware_version: str,
    identity: DeviceIdentity,
    transport: httpx.BaseTransport | None = None,
    timeout: float = 30.0,
) -> JsonDict:
    """``POST /v1/devices/register`` — unsigned (the device has no id yet)."""
    with httpx.Client(base_url=base_url, transport=transport, timeout=timeout) as client:
        return _json(
            client.post(
                "/v1/devices/register",
                json={
                    "provisioningToken": provisioning_token,
                    "serialNumber": serial_number,
                    "model": model,
                    "firmwareVersion": firmware_version,
                    "publicKeyPem": identity.public_key_pem(),
                },
            )
        )


class DeviceManagementApi:
    def __init__(
        self,
        base_url: str,
        identity: DeviceIdentity,
        device_id: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.device_id = device_id
        self._client = httpx.Client(
            base_url=base_url,
            auth=DeviceAuth(identity, device_id, clock),
            transport=transport,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def heartbeat(self, payload: JsonDict) -> JsonDict:
        response = _check(
            self._client.post(f"/v1/devices/{self.device_id}/heartbeat", json=payload)
        )
        return cast(JsonDict, response.json()) if response.content else {}

    def recording_plan(self, start: datetime, end: datetime) -> tuple[JsonDict, str | None]:
        """Returns the plan JSON and the server ``Date`` header (for clock-skew checks)."""
        response = _check(
            self._client.get(
                f"/v1/devices/{self.device_id}/recording-plan",
                params={"from": to_iso(start), "to": to_iso(end)},
            )
        )
        return cast(JsonDict, response.json()), response.headers.get("date")


class IngestionApi:
    def __init__(
        self,
        base_url: str,
        identity: DeviceIdentity,
        device_id: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.device_id = device_id
        self._client = httpx.Client(
            base_url=base_url,
            auth=DeviceAuth(identity, device_id, clock),
            transport=transport,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def create_recording(self, metadata: JsonDict) -> JsonDict:
        """``POST /v1/recordings`` — idempotent per (deviceId, localRecordingId)."""
        return _json(self._client.post("/v1/recordings", json=metadata))

    def recording_event(self, payload: JsonDict) -> None:
        """``POST /v1/recording-events`` — ``recording.started`` / ``recording.stopped``."""
        _check(self._client.post("/v1/recording-events", json=payload))

    def create_upload(
        self,
        recording_session_id: str,
        total_size_bytes: int,
        checksum_sha256: str,
        chunk_size_bytes: int,
    ) -> JsonDict:
        return _json(
            self._client.post(
                "/v1/uploads",
                json={
                    "recordingSessionId": recording_session_id,
                    "totalSizeBytes": total_size_bytes,
                    "checksumSha256": checksum_sha256,
                    "chunkSizeBytes": chunk_size_bytes,
                },
            )
        )

    def upload_status(self, upload_id: str) -> JsonDict:
        return _json(self._client.get(f"/v1/uploads/{upload_id}"))

    def put_chunk(self, upload_id: str, index: int, data: bytes) -> None:
        _check(
            self._client.put(
                f"/v1/uploads/{upload_id}/chunks/{index}",
                content=data,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Chunk-SHA256": hashlib.sha256(data).hexdigest(),
                },
            )
        )

    def complete_upload(self, upload_id: str) -> JsonDict:
        return _json(self._client.post(f"/v1/uploads/{upload_id}/complete"))
