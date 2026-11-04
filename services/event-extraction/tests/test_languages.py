"""Phase 6 §6.4: event extraction is pt-BR only and skips other languages."""

from __future__ import annotations

from conftest import CLASS_1, Harness, segments

from event_extraction.models import TranscriptSegment
from event_extraction.ports import TranscriptData
from event_extraction.service import dominant_language, is_supported_language

EXAM_EN = "The midterm exam will be on March 24 at 7 pm."
EXAM_ES = "El examen parcial será el 24 de marzo, a las 19 horas."


def test_supported_languages() -> None:
    assert (
        is_supported_language("pt-BR")
        and is_supported_language("pt")
        and is_supported_language("pt_br")
    )
    assert not is_supported_language("en-US")
    assert not is_supported_language("es-419")


def test_dominant_language_by_duration() -> None:
    segs = [
        TranscriptSegment(segment_index=0, start_ms=0, end_ms=1000, text="a", language="pt-BR"),
        TranscriptSegment(segment_index=1, start_ms=1000, end_ms=9000, text="b", language="en-US"),
    ]
    assert dominant_language(segs) == "en-US"
    assert dominant_language([]) == "pt-BR"


def test_explicit_language_skips_with_limitation(harness: Harness) -> None:
    # Spanish text that the pt-BR rules would otherwise half-understand ("examen ... 24 de marzo")
    result = harness.extract(EXAM_ES, language="es-419")
    assert result["events"] == []
    assert result["skipped"] is True
    assert result["language"] == "es-419"
    assert result["limitation"]["code"] == "unsupported_language"
    assert result["validation"]["reasons"] == {"unsupported_language": 1}
    assert harness.repository._events == {}
    assert harness.audit.records[-1]["action"] == "event.extraction_skipped"
    assert harness.audit.records[-1]["metadata"]["language"] == "es-419"
    published = harness.publisher.events[-1]
    assert published["type"] == "events.extracted" and published["data"]["skipped"] is True


def test_segment_language_is_used_when_request_has_none(harness: Harness) -> None:
    body = {
        "transcriptId": "t-en",
        "scheduledClassId": CLASS_1,
        "segments": [{**s, "language": "en-US"} for s in segments(EXAM_EN)],
    }
    result = harness.client.post("/v1/extractions", json=body).json()
    assert result["skipped"] is True and result["language"] == "en-US"


def test_pt_br_is_unaffected(harness: Harness) -> None:
    result = harness.extract("A P1 vai ser dia 24/03.", language="pt-BR")
    assert result["skipped"] is False and result["limitation"] is None
    assert len(result["events"]) == 1


def test_push_with_non_pt_transcript_is_skipped_and_acknowledged(harness: Harness) -> None:
    harness.transcripts.transcripts["tx-en"] = TranscriptData(
        transcript_id="tx-en",
        recording_session_id="rec",
        scheduled_class_id=CLASS_1,
        segments=[TranscriptSegment(segment_index=0, start_ms=0, end_ms=5000, text=EXAM_EN)],
        language="en-US",
    )
    envelope = {"eventId": "e-en", "type": "transcript.created", "data": {"transcriptId": "tx-en"}}
    r = harness.client.post("/v1/events/transcript-ready", json=envelope)
    assert r.status_code == 202
    assert r.json()["status"] == "skipped"
    assert r.json()["limitation"]["language"] == "en-US"
    again = harness.client.post("/v1/events/transcript-ready", json=envelope)
    assert again.json()["status"] == "duplicate"
