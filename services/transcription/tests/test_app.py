import base64
import json
import uuid
from typing import Any

from fastapi.testclient import TestClient

from transcription.app import AppDeps, create_app
from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryJobRepository,
    InMemoryPublisher,
    InMemoryTranscriptStore,
    StaticClassContextResolver,
)
from transcription.ports import ClassContext
from transcription.service import TranscriptionService

INSTITUTION = "11111111-1111-4111-8111-111111111111"
SECTION = "22222222-2222-4222-8222-222222222222"
SCHEDULED = "33333333-3333-4333-8333-333333333333"


class Env:
    def __init__(self, token: str | None = None) -> None:
        self.store = InMemoryTranscriptStore()
        self.publisher = InMemoryPublisher()
        self.provider = FakeSpeechProvider()
        self.resolver = StaticClassContextResolver(
            by_scheduled_class={
                SCHEDULED: ClassContext(
                    scheduled_class_id=SCHEDULED,
                    class_section_id=SECTION,
                    institution_id=INSTITUTION,
                    discipline="law",
                )
            }
        )
        service = TranscriptionService(
            provider=self.provider,
            store=self.store,
            publisher=self.publisher,
            audit=InMemoryAuditSink(),
            jobs=InMemoryJobRepository(),
            class_context=self.resolver,
        )
        self.client = TestClient(create_app(AppDeps(service=service, internal_token=token)))


def segmented_event(
    recording_id: str | None = None, event_id: str | None = None, **data: Any
) -> dict[str, Any]:
    return {
        "eventId": event_id or str(uuid.uuid4()),
        "type": "recording.segmented",
        "version": 1,
        "occurredAt": "2026-11-04T19:00:00Z",
        "source": "audio-processing",
        "institutionId": INSTITUTION,
        "data": {
            "recordingSessionId": recording_id or str(uuid.uuid4()),
            "segments": [
                {"index": 0, "startMs": 0, "endMs": 60_000, "storageUri": "gs://b/0.wav"},
                {"index": 1, "startMs": 60_000, "endMs": 120_000, "storageUri": "gs://b/1.wav"},
            ],
            **data,
        },
    }


def push(envelope: dict[str, Any]) -> dict[str, Any]:
    return {
        "message": {
            "data": base64.b64encode(json.dumps(envelope).encode()).decode(),
            "messageId": "1",
            "attributes": {},
        },
        "subscription": "projects/p/subscriptions/s",
    }


def test_health() -> None:
    assert Env().client.get("/health").json() == {"status": "ok", "service": "transcription"}


def test_direct_transcription_and_status() -> None:
    env = Env()
    resp = env.client.post(
        "/v1/transcriptions",
        json={
            "recordingSessionId": str(uuid.uuid4()),
            "segments": [{"index": 0, "startMs": 0, "endMs": 30_000, "storageUri": "gs://b/x"}],
        },
    )
    assert resp.status_code == 202
    job_id = resp.json()["jobId"]
    status = env.client.get(f"/v1/transcriptions/{job_id}").json()
    assert status["status"] == "completed"
    assert status["transcriptId"] in env.store.transcripts
    assert env.client.get("/v1/transcriptions/nope").status_code == 404


def test_validation_errors() -> None:
    env = Env()
    rid = str(uuid.uuid4())
    bad = env.client.post(
        "/v1/transcriptions",
        json={
            "recordingSessionId": rid,
            "segments": [{"index": 0, "startMs": 10, "endMs": 5, "storageUri": "gs://b"}],
        },
    )
    assert bad.status_code == 422
    empty = env.client.post("/v1/transcriptions", json={"recordingSessionId": rid, "segments": []})
    assert empty.status_code == 422
    not_uuid = env.client.post(
        "/v1/transcriptions",
        json={
            "recordingSessionId": "rec-1",
            "segments": [{"index": 0, "startMs": 0, "endMs": 5, "storageUri": "gs://b"}],
        },
    )
    assert not_uuid.status_code == 422


def test_event_is_processed_before_ack_and_idempotent() -> None:
    env = Env()
    event = segmented_event(scheduledClassId=SCHEDULED)
    first = env.client.post("/v1/events/recording-segmented", json=push(event))
    assert first.status_code == 200
    body = first.json()
    assert body["status"] == "completed" and body["created"] is True
    # Processing finished before the 2xx: the transcript exists already.
    stored = env.store.transcripts[body["transcriptId"]]
    # classSectionId / institutionId resolved from academic-integration and passed through.
    assert stored["classSectionId"] == SECTION
    assert stored["institutionId"] == INSTITUTION
    assert stored["scheduledClassId"] == SCHEDULED

    # Same eventId redelivered → duplicate, nothing re-run.
    again = env.client.post("/v1/events/recording-segmented", json=event)
    assert again.status_code == 200 and again.json()["duplicate"] is True
    # New eventId, same recording → existing completed job returned.
    other = segmented_event(event["data"]["recordingSessionId"], scheduledClassId=SCHEDULED)
    third = env.client.post("/v1/events/recording-segmented", json=other)
    assert third.status_code == 200 and third.json()["created"] is False
    assert len(env.store.transcripts) == 1
    assert len(env.provider.calls) == 2
    completed = env.publisher.events[0]
    assert completed["type"] == "transcription.completed"
    assert completed["data"]["classSectionId"] == SECTION


def test_class_section_from_payload_wins_without_lookup() -> None:
    env = Env()
    event = segmented_event(classSectionId=SECTION)
    resp = env.client.post("/v1/events/recording-segmented", json=event)
    stored = env.store.transcripts[resp.json()["transcriptId"]]
    assert stored["classSectionId"] == SECTION and stored["institutionId"] == INSTITUTION


def test_internal_token_required_on_event_route() -> None:
    env = Env(token="s3cret")
    event = segmented_event()
    assert env.client.post("/v1/events/recording-segmented", json=event).status_code == 401
    wrong = env.client.post(
        "/v1/events/recording-segmented", json=event, headers={"x-internal-token": "nope"}
    )
    assert wrong.status_code == 401
    ok = env.client.post(
        "/v1/events/recording-segmented", json=event, headers={"x-internal-token": "s3cret"}
    )
    assert ok.status_code == 200


def test_unexpected_event_type_is_acknowledged() -> None:
    env = Env()
    event = segmented_event()
    event["type"] = "recording.uploaded"
    resp = env.client.post("/v1/events/recording-segmented", json=event)
    assert resp.status_code == 200 and resp.json()["ignored"] is True


def test_bad_payloads() -> None:
    env = Env()
    resp = env.client.post("/v1/events/recording-segmented", json={"message": {"data": "%%%"}})
    assert resp.status_code == 400
    event = segmented_event()
    event["eventId"] = "not-a-uuid"
    assert env.client.post("/v1/events/recording-segmented", json=event).status_code == 422
