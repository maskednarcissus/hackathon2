"""Integration stage: internal token, eventId idempotency, derived event ids, event bus."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from audio_processing.adapters.event_bus import EventPublishError, HttpEventBusPublisher
from audio_processing.adapters.memory import InMemoryEventPublisher, InMemoryObjectStore
from audio_processing.pipeline import derived_event_id
from audio_processing.ports import EventEnvelope
from tests.test_pipeline import Harness, lecture, make_harness, upload_recording, uploaded_event


class FlakyPublisher(InMemoryEventPublisher):
    """Fails the first publish of ``recording.segmented``."""

    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    def publish(self, event: EventEnvelope) -> None:
        if event.type == "recording.segmented" and not self.failed:
            self.failed = True
            raise EventPublishError("bus unavailable")
        super().publish(event)


def test_push_endpoint_requires_internal_token(tmp_path: Path) -> None:
    harness = make_harness(tmp_path, InMemoryObjectStore(), internal_token="s3cret")
    path = lecture(tmp_path, 1)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    event = uploaded_event(path, uri, recording_id)
    url = "/v1/events/recording-uploaded"
    assert harness.client.post(url, json=event).status_code == 401
    wrong = harness.client.post(url, json=event, headers={"x-internal-token": "x"})
    assert wrong.status_code == 401
    ok = harness.client.post(url, json=event, headers={"x-internal-token": "s3cret"})
    assert ok.status_code == 200
    # Ad-hoc tools and health stay open.
    assert harness.client.get("/health").status_code == 200


def test_emitted_event_ids_derive_from_consumed_event(harness: Harness, tmp_path: Path) -> None:
    path = lecture(tmp_path, 2)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    event = uploaded_event(path, uri, recording_id)
    assert harness.client.post("/v1/events/recording-uploaded", json=event).status_code == 200
    ids = {e.type: e.event_id for e in harness.publisher.events}
    assert ids["audio.quality_assessed"] == derived_event_id(
        event["eventId"], "audio.quality_assessed"
    )
    assert ids["recording.segmented"] == derived_event_id(event["eventId"], "recording.segmented")


def test_publish_failure_is_not_marked_processed(tmp_path: Path) -> None:
    publisher = FlakyPublisher()
    harness = make_harness(tmp_path, InMemoryObjectStore(), publisher=publisher)
    path = lecture(tmp_path, 2)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    event = uploaded_event(path, uri, recording_id)
    client = harness.client
    with pytest.raises(EventPublishError):
        client.post("/v1/events/recording-uploaded", json=event)
    # Redelivery completes the work (not a "duplicate"), with the same derived ids.
    retry = client.post("/v1/events/recording-uploaded", json=event)
    assert retry.status_code == 200
    assert retry.json()["status"] == "segmented"
    quality = [e for e in publisher.events if e.type == "audio.quality_assessed"]
    assert len(quality) == 2 and quality[0].event_id == quality[1].event_id
    assert len([e for e in publisher.events if e.type == "recording.segmented"]) == 1


def test_event_id_must_be_uuid(harness: Harness, tmp_path: Path) -> None:
    path = lecture(tmp_path, 1)
    event = uploaded_event(path, "mem://x.wav", str(uuid.uuid4()))
    event["eventId"] = "not-a-uuid"
    response = harness.client.post("/v1/events/recording-uploaded", json=event)
    assert response.status_code == 422


def test_http_event_bus_publisher() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    publisher = HttpEventBusPublisher(
        "http://bus:8080", internal_token="tok", transport=httpx.MockTransport(handler)
    )
    event = EventEnvelope(
        event_id=str(uuid.uuid4()),
        type="recording.segmented",
        version=1,
        occurred_at=datetime(2026, 11, 4, tzinfo=UTC),
        source="audio-processing",
        institution_id=None,
        data={"segments": []},
    )
    publisher.publish(event)
    assert str(seen[0].url) == "http://bus:8080/v1/topics/recording.segmented:publish"
    assert seen[0].headers["x-internal-token"] == "tok"
    assert json.loads(seen[0].content) == event.to_json()
    failing = HttpEventBusPublisher(
        "http://bus:8080", transport=httpx.MockTransport(lambda r: httpx.Response(500))
    )
    with pytest.raises(EventPublishError):
        failing.publish(event)
