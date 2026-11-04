from __future__ import annotations

import base64
import hashlib
import stat
from pathlib import Path

import httpx

from ci_agent.api import DeviceManagementApi
from ci_agent.identity import DeviceIdentity, canonical_string, verify_signature

from .conftest import T0


def test_canonical_string_matches_contract() -> None:
    body = b'{"a":1}'
    expected = "\n".join(
        [
            "CI-DEVICE-V1",
            "POST",
            "/v1/devices/abc/heartbeat?x=1",
            "2026-11-04T22:00:00.000Z",
            hashlib.sha256(body).hexdigest(),
        ]
    )
    got = canonical_string(
        "post", "/v1/devices/abc/heartbeat?x=1", "2026-11-04T22:00:00.000Z", body
    )
    assert got == expected
    empty = canonical_string("GET", "/x", "t", b"")
    assert empty.endswith("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")


def test_key_created_with_0600_and_reloaded(tmp_path: Path) -> None:
    path = tmp_path / "identity" / "device.key"
    first = DeviceIdentity.load_or_create(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    second = DeviceIdentity.load_or_create(path)
    assert first.public_key_pem() == second.public_key_pem()
    assert first.public_key_fingerprint().startswith("sha256:")


def test_signed_headers_verify(identity: DeviceIdentity) -> None:
    headers = identity.signed_headers("dev-1", "GET", "/v1/x?y=2", b"", T0)
    assert headers["X-Device-Timestamp"] == "2026-11-04T22:00:00.000Z"
    assert verify_signature(
        identity.public_key,
        "GET",
        "/v1/x?y=2",
        headers["X-Device-Timestamp"],
        b"",
        headers["X-Device-Signature"],
    )
    assert not verify_signature(
        identity.public_key,
        "GET",
        "/v1/x?y=3",
        headers["X-Device-Timestamp"],
        b"",
        headers["X-Device-Signature"],
    )
    assert len(base64.b64decode(headers["X-Device-Signature"])) == 64


def test_http_client_signs_path_with_query(identity: DeviceIdentity) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"classroomId": "c", "generatedAt": "2026-11-04T22:00:00Z", "windows": []},
            headers={"Date": "Wed, 04 Nov 2026 22:00:00 GMT"},
        )

    api = DeviceManagementApi(
        "http://dm", identity, "dev-1", transport=httpx.MockTransport(handler), clock=lambda: T0
    )
    plan, date = api.recording_plan(T0, T0)
    assert plan["classroomId"] == "c" and date
    req = seen[0]
    path = req.url.raw_path.decode()
    assert path.startswith("/v1/devices/dev-1/recording-plan?from=")
    assert verify_signature(
        identity.public_key,
        "GET",
        path,
        req.headers["X-Device-Timestamp"],
        b"",
        req.headers["X-Device-Signature"],
    )
