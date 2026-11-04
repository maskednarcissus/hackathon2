"""Integration-stage behaviour with in-memory adapters: bus delivery, security, retention."""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta

import httpx
from conftest import CLASS_1, INSTITUTION, Harness
from fastapi.testclient import TestClient

from event_extraction.app import create_app, parse_delivery
from event_extraction.http_clients import HttpEventBusPublisher
from event_extraction.models import ExtractionRequest, TranscriptSegment
from event_extraction.ports import TranscriptData
from event_extraction.service import EventExtractionService

TOKEN = "s3cr3t-internal"


def _seed_transcript(h: Harness, transcript_id: str = "tx-1") -> None:
    h.transcripts.transcripts[transcript_id] = TranscriptData(
        transcript_id=transcript_id,
        recording_session_id="rec-1",
        scheduled_class_id=CLASS_1,
        segments=[
            TranscriptSegment(
                segment_index=0,
                start_ms=0,
                end_ms=4000,
                text="A P1 vai ser dia 24/03.",
                confidence=0.95,
            )
        ],
    )


def _envelope(event_type: str = "transcript.created", event_id: str = "e-1") -> dict[str, object]:
    return {"eventId": event_id, "type": event_type, "data": {"transcriptId": "tx-1"}}


def _push(envelope: dict[str, object], message_id: str = "m-1") -> dict[str, object]:
    data = base64.b64encode(json.dumps(envelope).encode()).decode()
    return {
        "message": {"data": data, "messageId": message_id, "attributes": {}},
        "subscription": "projects/p/subscriptions/event-extraction",
    }


def test_parse_delivery_accepts_push_and_raw() -> None:
    env, delivery = parse_delivery(_push(_envelope()))
    assert env.type == "transcript.created" and delivery == "e-1"
    no_id = {"type": "transcript.created", "data": {"transcriptId": "t"}}
    _, delivery = parse_delivery(_push(no_id, message_id="m-77"))
    assert delivery == "m-77"
    _, delivery = parse_delivery(_envelope(event_id="e-9"))
    assert delivery == "e-9"


def test_push_delivery_is_idempotent_by_event_id(harness: Harness) -> None:
    _seed_transcript(harness)
    first = harness.client.post("/v1/events/transcript-ready", json=_push(_envelope()))
    assert first.status_code == 202 and first.json()["status"] == "processed"
    again = harness.client.post("/v1/events/transcript-ready", json=_push(_envelope()))
    assert again.json()["status"] == "duplicate"
    # diarization.completed for the same transcript does not re-extract
    diar = harness.client.post(
        "/v1/events/transcript-ready", json=_envelope("diarization.completed", "e-2")
    )
    assert diar.json() == {"status": "duplicate", "reason": "transcript already extracted"}
    events = harness.client.get("/v1/review-queue").json()
    assert len(events) == 1 and events[0]["mentions"] == []
    # a correction re-extracts; the repeat is merged without a duplicate mention
    corrected = harness.client.post(
        "/v1/events/transcript-ready", json=_envelope("transcript.corrected", "e-3")
    )
    assert corrected.json()["status"] == "processed"
    assert corrected.json()["eventIds"] == []
    events = harness.client.get("/v1/review-queue").json()
    assert len(events) == 1 and events[0]["mentions"] == []


def test_invalid_push_payload_is_400(harness: Harness) -> None:
    r = harness.client.post(
        "/v1/events/transcript-ready", json={"message": {"data": "%%%", "messageId": "x"}}
    )
    assert r.status_code == 400


def test_processing_failure_is_not_acknowledged(harness: Harness) -> None:
    # unknown transcript → 404, nothing marked processed, the bus will retry
    r = harness.client.post("/v1/events/transcript-ready", json=_envelope())
    assert r.status_code == 404
    _seed_transcript(harness)
    r = harness.client.post("/v1/events/transcript-ready", json=_envelope())
    assert r.json()["status"] == "processed"


def test_internal_token_guards_push_and_internal_routes() -> None:
    h = Harness()
    h.deps.internal_token = TOKEN
    client = TestClient(create_app(h.deps))
    _seed_transcript(h)
    assert client.post("/v1/events/transcript-ready", json=_envelope()).status_code == 401
    bad = {"x-internal-token": "nope"}
    assert (
        client.post("/v1/events/transcript-ready", json=_envelope(), headers=bad).status_code == 401
    )
    ok = client.post(
        "/v1/events/transcript-ready", json=_envelope(), headers={"x-internal-token": TOKEN}
    )
    assert ok.status_code == 202
    params = {"institutionId": INSTITUTION, "olderThan": "2030-01-01T00:00:00Z"}
    assert client.get("/internal/v1/retention/candidates", params=params).status_code == 401
    assert (
        client.get(
            "/internal/v1/retention/candidates", params=params, headers={"x-internal-token": TOKEN}
        ).status_code
        == 200
    )
    # public review routes are not affected by the internal token
    assert client.get("/v1/review-queue").status_code == 200


def test_retention_candidates_and_delete(harness: Harness) -> None:
    first = harness.extract("O trabalho em grupo deve ser entregue no dia 24 de março.")
    harness.clock.current += timedelta(days=10)
    harness.extract("A P2 vai ser no dia 12 de maio.")
    cutoff = (datetime(2026, 3, 10, 22, 0, tzinfo=UTC) + timedelta(days=1)).isoformat()
    r = harness.client.get(
        "/internal/v1/retention/candidates",
        params={"institutionId": INSTITUTION, "olderThan": cutoff, "kind": "extracted_event"},
    )
    candidates = r.json()["candidates"]
    assert [c["id"] for c in candidates] == [first["events"][0]["id"]]
    assert candidates[0]["classSectionId"] and candidates[0]["recordingSessionId"] == "rec-1"
    assert candidates[0]["subjectIds"]
    bad_kind = harness.client.get(
        "/internal/v1/retention/candidates",
        params={"institutionId": INSTITUTION, "olderThan": cutoff, "kind": "audio"},
    )
    assert bad_kind.json()["error"]["code"] == "unsupported_kind"
    d = harness.client.post(
        "/internal/v1/retention/delete",
        json={"ids": [candidates[0]["id"], "missing"], "kind": "extracted_event", "jobId": "j1"},
    )
    assert d.json()["deletedIds"] == [candidates[0]["id"]]
    assert harness.client.get(f"/v1/events/{candidates[0]['id']}").status_code == 404


async def test_concurrent_extractions_create_one_event() -> None:
    h = Harness()
    service = EventExtractionService(h.deps)
    seg = [TranscriptSegment(segment_index=0, start_ms=0, end_ms=10, text="A P2 é dia 12 de maio.")]
    results = await asyncio.gather(
        *(
            service.extract(
                ExtractionRequest(transcript_id=f"t{i}", scheduled_class_id=CLASS_1, segments=seg)
            )
            for i in range(5)
        )
    )
    created = [e for r in results for e in r.events]
    assert len(created) == 1
    assert sum(len(r.deduplicated) for r in results) == 4


async def test_event_bus_publisher_posts_envelope_with_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(503) if len(seen) == 1 else httpx.Response(202)

    pub = HttpEventBusPublisher(
        "http://bus:4100/", TOKEN, backoff_seconds=0, transport=httpx.MockTransport(handler)
    )
    await pub.publish("events.extracted", {"eventIds": ["a"]}, INSTITUTION)
    assert len(seen) == 2
    req = seen[-1]
    assert req.url.path == "/v1/topics/events.extracted:publish"
    assert req.headers["x-internal-token"] == TOKEN
    body = json.loads(req.content)
    assert body["type"] == "events.extracted" and body["source"] == "event-extraction"
    assert body["institutionId"] == INSTITUTION and body["eventId"]


def test_outbox_publishes_after_store_phase(harness: Harness) -> None:
    harness.extract("A P1 vai ser dia 24/03.")
    assert [e["type"] for e in harness.publisher.events] == ["events.extracted"]
    assert [r["action"] for r in harness.audit.records] == ["event.extracted"]
