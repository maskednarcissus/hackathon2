from __future__ import annotations

import uuid

from tests.conftest import Harness, make_device
from tests.helpers import random_audio, recording_body


def test_register_recording_creates_session(harness: Harness) -> None:
    audio = random_audio(100)
    response = harness.signed.post("/v1/recordings", json_body=recording_body(harness, audio))
    assert response.status_code == 201
    body = response.json()
    assert body["durationMs"] == 90 * 60 * 1000
    assert body["institutionId"] == harness.device.identity.institution_id
    assert body["uploadStatus"] == "pending"
    assert "recording.metadata_received" in harness.audit.actions()

    fetched = harness.signed.get(f"/v1/recordings/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == body["id"]


def test_register_is_idempotent_per_local_recording_id(harness: Harness) -> None:
    audio = random_audio(100)
    first = harness.signed.post("/v1/recordings", json_body=recording_body(harness, audio))
    second = harness.signed.post("/v1/recordings", json_body=recording_body(harness, audio))
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


def test_same_local_id_with_different_content_conflicts(harness: Harness) -> None:
    harness.signed.post("/v1/recordings", json_body=recording_body(harness, random_audio(100)))
    response = harness.signed.post(
        "/v1/recordings", json_body=recording_body(harness, random_audio(101))
    )
    assert response.status_code == 409
    assert response.json()["error"] == "local_recording_conflict"


def test_validation_rules(harness: Harness) -> None:
    audio = random_audio(10)
    cases = [
        {"endedAt": "2026-11-04T18:00:00+00:00"},
        {"sampleRate": 8000},
        {"channels": 0},
        {"audioFormat": "mp3"},
        {"audioFormat": "flac"},
        {"checksumSha256": "abc"},
        {"startedAt": "2026-11-04T19:00:00"},
        {"unexpected": True},
    ]
    for override in cases:
        response = harness.signed.post(
            "/v1/recordings", json_body=recording_body(harness, audio, **override)
        )
        assert response.status_code == 422, override


def test_device_id_must_match_signer(harness: Harness) -> None:
    body = recording_body(harness, random_audio(10), deviceId=str(uuid.uuid4()))
    assert harness.signed.post("/v1/recordings", json_body=body).status_code == 403


def test_classroom_must_match_assignment(harness: Harness) -> None:
    body = recording_body(harness, random_audio(10), classroomId=str(uuid.uuid4()))
    response = harness.signed.post("/v1/recordings", json_body=body)
    assert response.status_code == 409
    assert response.json()["error"] == "classroom_mismatch"


def test_unassigned_device_cannot_register(harness: Harness) -> None:
    device = make_device(classroom_id=None)
    signed = harness.sign_as(device)
    body = recording_body(harness, random_audio(10), deviceId=device.identity.device_id)
    response = signed.post("/v1/recordings", json_body=body)
    assert response.status_code == 409
    assert response.json()["error"] == "device_unassigned"


def test_other_devices_cannot_read_recording(harness: Harness) -> None:
    created = harness.signed.post(
        "/v1/recordings", json_body=recording_body(harness, random_audio(10))
    ).json()
    other = harness.sign_as(make_device())
    assert other.get(f"/v1/recordings/{created['id']}").status_code == 404


def test_recording_lifecycle_events(harness: Harness) -> None:
    response = harness.signed.post(
        "/v1/recording-events",
        json_body={
            "type": "recording.started",
            "localRecordingId": "rec-1",
            "scheduledClassId": str(uuid.uuid4()),
            "at": "2026-11-04T19:00:00Z",
        },
    )
    assert response.status_code == 202
    assert "recording.started" in harness.audit.actions()
    events = harness.publisher.of_type("recording.started")
    assert len(events) == 1
    assert events[0].data["deviceId"] == harness.device.identity.device_id
    assert events[0].institution_id == harness.device.identity.institution_id

    bad = harness.signed.post(
        "/v1/recording-events",
        json_body={"type": "recording.paused", "localRecordingId": "x", "at": "2026-11-04T19:00Z"},
    )
    assert bad.status_code == 422
