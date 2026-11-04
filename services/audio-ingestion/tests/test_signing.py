from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tests.conftest import Harness, make_device
from tests.helpers import random_audio, recording_body


def test_health_is_public(harness: Harness) -> None:
    assert harness.client.get("/health").json() == {
        "status": "ok",
        "service": "audio-ingestion",
    }


def test_unsigned_request_rejected(harness: Harness) -> None:
    response = harness.client.post("/v1/recordings", json={})
    assert response.status_code == 401


def test_wrong_key_rejected(harness: Harness) -> None:
    other = make_device()
    body = recording_body(harness, random_audio(10))
    response = harness.signed.post("/v1/recordings", json_body=body, signer=other.private_key)
    assert response.status_code == 401
    assert "signature" in response.json()["detail"]


def test_stale_timestamp_rejected(harness: Harness) -> None:
    stale = (datetime.now(UTC) - timedelta(seconds=301)).isoformat()
    body = recording_body(harness, random_audio(10))
    response = harness.signed.post("/v1/recordings", json_body=body, timestamp=stale)
    assert response.status_code == 401
    assert "skew" in response.json()["detail"]


def test_tampered_body_rejected(harness: Harness) -> None:
    body = recording_body(harness, random_audio(10))
    signed_ts = datetime.now(UTC).isoformat()
    from audio_ingestion.signing import sign_request

    signature = sign_request(
        harness.device.private_key, "POST", "/v1/recordings", signed_ts, b'{"x": 1}'
    )
    response = harness.client.post(
        "/v1/recordings",
        json=body,
        headers={
            "X-Device-Id": harness.device.identity.device_id,
            "X-Device-Timestamp": signed_ts,
            "X-Device-Signature": signature,
        },
    )
    assert response.status_code == 401


def test_unknown_device_rejected(harness: Harness) -> None:
    stranger = make_device()
    from tests.conftest import SignedClient

    client = SignedClient(harness.client, stranger)
    response = client.post("/v1/recordings", json_body={})
    assert response.status_code == 401


def test_revoked_device_forbidden(harness: Harness) -> None:
    revoked = harness.sign_as(make_device(status="revoked"))
    response = revoked.post("/v1/recordings", json_body={})
    assert response.status_code == 403
