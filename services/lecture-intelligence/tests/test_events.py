from __future__ import annotations

import base64
import json

from conftest import CLASS, INSTITUTION, LECTURE_TEXTS, TRANSCRIPT, Harness, make_segments

from lecture_intelligence.models import Segment


def _prepare(harness: Harness, scheduled_class: str | None = CLASS) -> None:
    harness.transcripts.transcripts[TRANSCRIPT] = {
        "id": TRANSCRIPT,
        "scheduledClassId": scheduled_class,
        "language": "pt-BR",
    }
    harness.transcripts.segments[TRANSCRIPT] = [
        Segment.model_validate(s) for s in make_segments(LECTURE_TEXTS[:6])
    ]
    harness.gateway.responders["lecture-structuring"] = lambda _: {
        "title": "Inflação",
        "executiveSummary": "Aula sobre inflação.",
        "topics": [{"title": "Inflação", "segmentIndexes": [1]}],
    }


def _event(event_id: str = "e1") -> dict[str, object]:
    return {
        "eventId": event_id,
        "type": "diarization.completed",
        "version": 1,
        "occurredAt": "2026-11-04T20:00:00Z",
        "source": "speaker-diarization",
        "institutionId": INSTITUTION,
        "data": {"transcriptId": TRANSCRIPT, "speakerCount": 2},
    }


def test_diarization_completed_triggers_structuring(harness: Harness) -> None:
    _prepare(harness)
    resp = harness.client.post("/v1/events/diarization-completed", json=_event())
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "processed"
    assert harness.client.get(f"/v1/lectures/{CLASS}").json()["topics"][0]["title"] == "Inflação"
    again = harness.client.post("/v1/events/diarization-completed", json=_event())
    assert again.json() == {"status": "duplicate"}
    assert len(harness.gateway.payloads) == 1


def test_pubsub_push_wrapper_is_decoded(harness: Harness) -> None:
    _prepare(harness)
    data = base64.b64encode(json.dumps(_event("e2")).encode()).decode()
    resp = harness.client.post(
        "/v1/events/transcript-created", json={"message": {"data": data}, "subscription": "s"}
    )
    assert resp.status_code == 202
    assert resp.json()["status"] == "processed"


def test_unassociated_transcript_is_skipped(harness: Harness) -> None:
    _prepare(harness, scheduled_class=None)
    resp = harness.client.post("/v1/events/transcript-created", json=_event("e3"))
    assert resp.status_code == 202
    assert resp.json()["status"] == "skipped"
    assert harness.gateway.payloads == []


def test_bad_events(harness: Harness) -> None:
    assert harness.client.post("/v1/events/transcript-created", json={"x": 1}).status_code == 400
    missing = _event("e4")
    missing["data"] = {"transcriptId": "44444444-4444-4444-8444-444444444444"}
    assert harness.client.post("/v1/events/transcript-created", json=missing).status_code == 404
