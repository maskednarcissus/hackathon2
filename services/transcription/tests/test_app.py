import base64
import json
from typing import Any

from fastapi.testclient import TestClient

from transcription.app import AppDeps, create_app
from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryJobRepository,
    InMemoryPublisher,
    InMemoryTranscriptStore,
)
from transcription.service import TranscriptionService


def make_client() -> tuple[TestClient, InMemoryTranscriptStore, InMemoryPublisher]:
    store = InMemoryTranscriptStore()
    publisher = InMemoryPublisher()
    service = TranscriptionService(
        provider=FakeSpeechProvider(),
        store=store,
        publisher=publisher,
        audit=InMemoryAuditSink(),
        jobs=InMemoryJobRepository(),
    )
    return TestClient(create_app(AppDeps(service=service))), store, publisher


def segmented_event(recording_id: str = "rec-1") -> dict[str, Any]:
    return {
        "eventId": "e1",
        "type": "recording.segmented",
        "version": 1,
        "occurredAt": "2026-11-04T19:00:00Z",
        "source": "audio-processing",
        "institutionId": "inst-1",
        "data": {
            "recordingSessionId": recording_id,
            "segments": [
                {"index": 0, "startMs": 0, "endMs": 60_000, "storageUri": "gs://b/0.wav"},
                {"index": 1, "startMs": 60_000, "endMs": 120_000, "storageUri": "gs://b/1.wav"},
            ],
        },
    }


def test_health() -> None:
    client, _, _ = make_client()
    assert client.get("/health").json() == {"status": "ok", "service": "transcription"}


def test_direct_transcription_and_status() -> None:
    client, store, _ = make_client()
    resp = client.post(
        "/v1/transcriptions",
        json={
            "recordingSessionId": "rec-9",
            "segments": [{"index": 0, "startMs": 0, "endMs": 30_000, "storageUri": "gs://b/x"}],
        },
    )
    assert resp.status_code == 202
    job_id = resp.json()["jobId"]
    status = client.get(f"/v1/transcriptions/{job_id}").json()
    assert status["status"] == "completed"
    assert status["transcriptId"] in store.transcripts
    assert client.get("/v1/transcriptions/nope").status_code == 404


def test_validation_errors() -> None:
    client, _, _ = make_client()
    bad = client.post(
        "/v1/transcriptions",
        json={
            "recordingSessionId": "r",
            "segments": [{"index": 0, "startMs": 10, "endMs": 5, "storageUri": "gs://b"}],
        },
    )
    assert bad.status_code == 422
    empty = client.post("/v1/transcriptions", json={"recordingSessionId": "r", "segments": []})
    assert empty.status_code == 422


def test_recording_segmented_event_raw_and_pubsub_push() -> None:
    client, store, publisher = make_client()
    first = client.post("/v1/events/recording-segmented", json=segmented_event())
    assert first.status_code == 202
    # Redelivery is idempotent.
    again = client.post("/v1/events/recording-segmented", json=segmented_event())
    assert again.status_code == 200 and again.json()["created"] is False
    assert len(store.transcripts) == 1
    assert publisher.events[0]["institutionId"] == "inst-1"

    push = {
        "message": {
            "data": base64.b64encode(json.dumps(segmented_event("rec-2")).encode()).decode(),
            "messageId": "1",
        },
        "subscription": "projects/p/subscriptions/s",
    }
    assert client.post("/v1/events/recording-segmented", json=push).status_code == 202
    assert len(store.transcripts) == 2


def test_unexpected_event_type_is_acknowledged() -> None:
    client, _, _ = make_client()
    event = segmented_event()
    event["type"] = "recording.uploaded"
    resp = client.post("/v1/events/recording-segmented", json=event)
    assert resp.status_code == 200 and resp.json()["ignored"] is True


def test_bad_push_payload() -> None:
    client, _, _ = make_client()
    resp = client.post("/v1/events/recording-segmented", json={"message": {"data": "%%%"}})
    assert resp.status_code == 400
