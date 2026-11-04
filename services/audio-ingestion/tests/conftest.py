"""Shared fixtures: an app wired with in-memory adapters and a signing test client."""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from httpx import Response

from audio_ingestion.adapters.local_store import EncryptedLocalObjectStore
from audio_ingestion.adapters.memory import (
    InMemoryAuditClient,
    InMemoryEventPublisher,
    InMemoryRecordingRepository,
    InMemoryUploadRepository,
    StaticDeviceKeyResolver,
)
from audio_ingestion.app import create_app
from audio_ingestion.config import Dependencies
from audio_ingestion.ports import DeviceIdentity
from audio_ingestion.signing import sign_request

INSTITUTION_ID = str(uuid.uuid4())
CLASSROOM_ID = str(uuid.uuid4())


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class Device:
    identity: DeviceIdentity
    private_key: Ed25519PrivateKey


def make_device(classroom_id: str | None = CLASSROOM_ID, status: str = "online") -> Device:
    key = Ed25519PrivateKey.generate()
    pem = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    identity = DeviceIdentity(
        device_id=str(uuid.uuid4()),
        public_key_pem=pem,
        status=status,
        classroom_id=classroom_id,
        institution_id=INSTITUTION_ID,
    )
    return Device(identity=identity, private_key=key)


class SignedClient:
    """Test client that signs every request as a device (contract §3)."""

    def __init__(self, client: TestClient, device: Device) -> None:
        self.client = client
        self.device = device

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
        timestamp: str | None = None,
        signer: Ed25519PrivateKey | None = None,
    ) -> Response:
        body = json.dumps(json_body).encode() if json_body is not None else (content or b"")
        ts = timestamp or iso_now()
        signature = sign_request(signer or self.device.private_key, method, path, ts, body)
        all_headers = {
            "X-Device-Id": self.device.identity.device_id,
            "X-Device-Timestamp": ts,
            "X-Device-Signature": signature,
        }
        if json_body is not None:
            all_headers["Content-Type"] = "application/json"
        all_headers.update(headers or {})
        return self.client.request(method, path, content=body, headers=all_headers)

    def post(self, path: str, **kwargs: Any) -> Response:
        return self.request("POST", path, **kwargs)

    def get(self, path: str, **kwargs: Any) -> Response:
        return self.request("GET", path, **kwargs)

    def put(self, path: str, **kwargs: Any) -> Response:
        return self.request("PUT", path, **kwargs)


@dataclass
class Harness:
    client: TestClient
    deps: Dependencies
    publisher: InMemoryEventPublisher
    audit: InMemoryAuditClient
    resolver: StaticDeviceKeyResolver
    store: EncryptedLocalObjectStore
    device: Device
    signed: SignedClient

    def sign_as(self, device: Device) -> SignedClient:
        self.resolver.add(device.identity)
        return SignedClient(self.client, device)


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    publisher = InMemoryEventPublisher()
    audit = InMemoryAuditClient()
    resolver = StaticDeviceKeyResolver()
    key = base64.b64decode(base64.b64encode(b"k" * 32))
    store = EncryptedLocalObjectStore(tmp_path / "objects", key)
    deps = Dependencies(
        recordings=InMemoryRecordingRepository(),
        uploads=InMemoryUploadRepository(),
        store=store,
        publisher=publisher,
        key_resolver=resolver,
        audit=audit,
        staging_dir=tmp_path / "staging",
    )
    client = TestClient(create_app(deps))
    device = make_device()
    resolver.add(device.identity)
    return Harness(
        client=client,
        deps=deps,
        publisher=publisher,
        audit=audit,
        resolver=resolver,
        store=store,
        device=device,
        signed=SignedClient(client, device),
    )
