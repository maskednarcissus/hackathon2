"""Integration-stage behaviour: retention data owner, internal token, event bus, firmware body."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from audio_ingestion.adapters.event_bus import EventPublishError, HttpEventBusPublisher
from audio_ingestion.ports import EventEnvelope
from audio_ingestion.service import segment_uri_prefix
from tests.conftest import INSTITUTION_ID, Harness, build_harness
from tests.helpers import chunks, put_chunk, random_audio, register, start_upload

CHUNK = 64 * 1024
FUTURE = (datetime.now(UTC) + timedelta(days=1)).isoformat().replace("+00:00", "Z")


def uploaded(harness: Harness, size: int = CHUNK * 2 + 7, local_id: str = "rec-1") -> str:
    audio = random_audio(size)
    recording_id = register(harness, audio, localRecordingId=local_id)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    for index, data in enumerate(chunks(audio, CHUNK)):
        assert put_chunk(harness.signed, upload_id, index, data) == 204
    response = harness.signed.post(f"/v1/uploads/{upload_id}/complete")
    assert response.status_code == 200, response.text
    return recording_id


def candidates(harness: Harness, older_than: str = FUTURE, kind: str = "audio") -> list[dict]:  # type: ignore[type-arg]
    response = harness.client.get(
        "/internal/v1/retention/candidates",
        params={"institutionId": INSTITUTION_ID, "olderThan": older_than, "kind": kind},
    )
    assert response.status_code == 200, response.text
    result: list[dict] = response.json()["candidates"]  # type: ignore[type-arg]
    return result


def test_retention_candidates_and_delete(harness: Harness, tmp_path: Path) -> None:
    recording_id = uploaded(harness)
    recording = harness.signed.get(f"/v1/recordings/{recording_id}").json()
    uri = recording["storageUri"]
    # A derived segment object written by audio-processing under the recording prefix.
    segment = tmp_path / "seg.wav"
    segment.write_bytes(b"segment")
    key = uri.removeprefix("local://").rsplit(".", 1)[0] + "/segments/0000.wav"
    segment_uri = harness.store.put_file(key, segment, "audio/wav")
    assert segment_uri.startswith(segment_uri_prefix(uri))

    items = candidates(harness)
    assert [c["id"] for c in items] == [recording_id]
    assert items[0]["recordingSessionId"] == recording_id
    assert "createdAt" in items[0]
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    assert candidates(harness, older_than=past) == []
    assert candidates(harness, kind="transcript") == []

    unknown = str(uuid.uuid4())
    response = harness.client.post(
        "/internal/v1/retention/delete",
        json={"ids": [recording_id, unknown], "kind": "audio", "jobId": str(uuid.uuid4())},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"deletedIds": [recording_id]}
    assert not harness.store.exists(uri)
    assert not harness.store.exists(segment_uri)

    after = harness.signed.get(f"/v1/recordings/{recording_id}").json()
    assert after["storageUri"] is None
    assert after["audioDeletedAt"] is not None
    assert candidates(harness) == []
    assert "retention.deleted" in harness.audit.actions()

    # Idempotent retry; other kinds are not ours.
    again = harness.client.post(
        "/internal/v1/retention/delete", json={"ids": [recording_id], "kind": "audio"}
    )
    assert again.json() == {"deletedIds": [recording_id]}
    other = harness.client.post(
        "/internal/v1/retention/delete", json={"ids": [recording_id], "kind": "transcript"}
    )
    assert other.json() == {"deletedIds": []}
    # Uploads are gone and the recording can no longer be uploaded.
    audio_len = recording["fileSizeBytes"]
    response = harness.signed.post(
        "/v1/uploads",
        json_body={
            "recordingSessionId": recording_id,
            "totalSizeBytes": audio_len,
            "checksumSha256": recording["checksumSha256"],
        },
    )
    assert response.status_code == 410


def test_internal_routes_require_token_when_configured(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, internal_token="s3cret")
    params = {"institutionId": INSTITUTION_ID, "olderThan": FUTURE, "kind": "audio"}
    url = "/internal/v1/retention/candidates"
    assert harness.client.get(url, params=params).status_code == 401
    bad = harness.client.get(url, params=params, headers={"x-internal-token": "nope"})
    assert bad.status_code == 401
    ok = harness.client.get(url, params=params, headers={"x-internal-token": "s3cret"})
    assert ok.status_code == 200
    delete = harness.client.post("/internal/v1/retention/delete", json={"ids": [], "kind": "audio"})
    assert delete.status_code == 401
    # Device routes keep using device signatures, not the internal token.
    assert harness.client.get("/health").status_code == 200


def test_firmware_recording_event_body_is_accepted(harness: Harness) -> None:
    body = {
        "type": "recording.stopped",
        "deviceId": harness.device.identity.device_id,
        "localRecordingId": "rec-20261104-1900",
        "scheduledClassId": None,
        "at": "2026-11-04T20:35:00Z",
    }
    response = harness.signed.post("/v1/recording-events", json_body=body)
    assert response.status_code == 202, response.text
    response = harness.signed.post("/v1/recording-events", json_body=body)
    events = harness.publisher.of_type("recording.stopped")
    assert len(events) == 2
    assert events[0].event_id == events[1].event_id  # deterministic → deduplicated downstream

    body["deviceId"] = str(uuid.uuid4())
    assert harness.signed.post("/v1/recording-events", json_body=body).status_code == 403


def test_repeated_completion_republishes_same_event(harness: Harness) -> None:
    recording_id = uploaded(harness)
    upload = harness.deps.uploads.find_complete_for_recording(recording_id)
    assert upload is not None
    again = harness.signed.post(f"/v1/uploads/{upload.upload_id}/complete")
    assert again.status_code == 200
    events = harness.publisher.of_type("recording.uploaded")
    assert len(events) == 2
    assert events[0].event_id == events[1].event_id
    assert events[0].data == events[1].data


def test_concurrent_identical_chunk_is_deduplicated_by_repository(harness: Harness) -> None:
    audio = random_audio(CHUNK * 2)
    recording_id = register(harness, audio)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    sha = hashlib.sha256(audio[:CHUNK]).hexdigest()
    # Another instance recorded chunk 0 between our read and our insert.
    assert harness.deps.uploads.add_chunk(upload_id, 0, sha, CHUNK) is None
    assert harness.deps.uploads.add_chunk(upload_id, 0, sha, CHUNK) == sha


def test_http_event_bus_publisher() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    publisher = HttpEventBusPublisher(
        "http://bus:8080/", internal_token="tok", transport=httpx.MockTransport(handler)
    )
    event = EventEnvelope(
        event_id=str(uuid.uuid4()),
        type="recording.uploaded",
        version=1,
        occurred_at=datetime(2026, 11, 4, tzinfo=UTC),
        source="audio-ingestion",
        institution_id=INSTITUTION_ID,
        data={"recordingSessionId": "r"},
    )
    publisher.publish(event)
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "http://bus:8080/v1/topics/recording.uploaded:publish"
    assert request.headers["x-internal-token"] == "tok"
    assert json.loads(request.content) == event.to_json()

    failing = HttpEventBusPublisher(
        "http://bus:8080", transport=httpx.MockTransport(lambda r: httpx.Response(503))
    )
    with pytest.raises(EventPublishError):
        failing.publish(event)
