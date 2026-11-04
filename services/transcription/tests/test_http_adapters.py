import json
from datetime import UTC, datetime

import httpx

from transcription.adapters.http import (
    HttpAuditSink,
    HttpClassContextResolver,
    HttpEventBusPublisher,
    HttpTranscriptStoreClient,
)
from transcription.assembly import group_words
from transcription.models import TranscriptSegment, Word

REC = "44444444-4444-4444-8444-444444444444"
SECTION = "22222222-2222-4222-8222-222222222222"
INST = "11111111-1111-4111-8111-111111111111"


def recorder(
    responses: dict[tuple[str, str], httpx.Response],
) -> tuple[list[httpx.Request], httpx.AsyncClient]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return responses.get(
            (request.method, request.url.path), httpx.Response(404, json={"error": {}})
        )

    return seen, httpx.AsyncClient(transport=httpx.MockTransport(handler))


def segment() -> TranscriptSegment:
    return TranscriptSegment(segment_index=0, start_ms=0, end_ms=1000, text="Oi.", confidence=0.9)


async def test_transcript_store_sends_section_and_token() -> None:
    seen, client = recorder({("POST", "/v1/transcripts"): httpx.Response(201, json={"id": "t-1"})})
    store = HttpTranscriptStoreClient("http://tm/", internal_token="tok", client=client)
    stored = await store.create_transcript(
        recording_session_id=REC,
        scheduled_class_id=None,
        language="pt-BR",
        processing_version="v1",
        provider="fake",
        model="m",
        segments=[segment()],
        class_section_id=SECTION,
        institution_id=INST,
    )
    assert stored.transcript_id == "t-1"
    body = json.loads(seen[0].content)
    assert body["classSectionId"] == SECTION and body["institutionId"] == INST
    assert "scheduledClassId" not in body
    assert seen[0].headers["x-internal-token"] == "tok"


async def test_transcript_store_treats_409_as_existing() -> None:
    conflict = httpx.Response(
        409,
        json={"error": {"code": "transcript_exists", "details": {"transcriptId": "t-old"}}},
    )
    _, client = recorder({("POST", "/v1/transcripts"): conflict})
    store = HttpTranscriptStoreClient("http://tm", client=client)
    stored = await store.create_transcript(
        recording_session_id=REC,
        scheduled_class_id=None,
        language="pt-BR",
        processing_version="v1",
        provider="fake",
        model="m",
        segments=[segment()],
    )
    assert stored.transcript_id == "t-old"


async def test_event_bus_publisher_posts_envelope_to_topic() -> None:
    seen, client = recorder(
        {("POST", "/v1/topics/transcription.completed:publish"): httpx.Response(202, json={})}
    )
    pub = HttpEventBusPublisher("http://bus", internal_token="tok", client=client)
    await pub.publish("transcription.completed", {"transcriptId": "t"}, INST)
    envelope = json.loads(seen[0].content)
    assert envelope["type"] == "transcription.completed"
    assert envelope["source"] == "transcription" and envelope["institutionId"] == INST
    assert seen[0].headers["x-internal-token"] == "tok"


async def test_class_context_resolver_both_paths() -> None:
    sc = {
        "id": "sc-1",
        "classSectionId": SECTION,
        "institutionId": INST,
        "course": {"discipline": "law"},
    }
    seen, client = recorder(
        {
            ("GET", "/v1/scheduled-classes/sc-1"): httpx.Response(200, json=sc),
            ("POST", "/v1/class-identification"): httpx.Response(
                200, json={"status": "matched", "scheduledClass": sc}
            ),
        }
    )
    resolver = HttpClassContextResolver("http://ai", client=client)
    ctx = await resolver.resolve(
        scheduled_class_id="sc-1",
        classroom_id=None,
        started_at=None,
        ended_at=None,
        recording_session_id=REC,
    )
    assert ctx is not None and ctx.class_section_id == SECTION and ctx.discipline == "law"
    t = datetime(2026, 11, 4, 19, tzinfo=UTC)
    ctx2 = await resolver.resolve(
        scheduled_class_id=None,
        classroom_id="room",
        started_at=t,
        ended_at=t,
        recording_session_id=REC,
    )
    assert ctx2 is not None and ctx2.scheduled_class_id == "sc-1"
    assert json.loads(seen[1].content)["classroomId"] == "room"
    missing = await resolver.resolve(
        scheduled_class_id="other",
        classroom_id=None,
        started_at=None,
        ended_at=None,
        recording_session_id=REC,
    )
    assert missing is None


async def test_audit_moves_non_uuid_resource_into_metadata() -> None:
    seen, client = recorder({("POST", "/v1/audit-events"): httpx.Response(201, json={})})
    sink = HttpAuditSink("http://audit", client=client)
    await sink.record(
        action="transcription.failed",
        resource_type="recording_session",
        resource_id="legacy-id",
        institution_id=INST,
        metadata={"reason": "x"},
    )
    body = json.loads(seen[0].content)
    assert "resourceId" not in body and body["metadata"]["resourceRef"] == "legacy-id"
    assert body["actorId"] == "transcription" and body["tenantId"] == INST


def test_assembly_keeps_words_inside_non_overlapping_segments() -> None:
    def w(t: str, s: int, e: int) -> Word:
        return Word(word=t, start_ms=s, end_ms=e, confidence=0.9)

    # "fim." ends after the next sentence starts (provider timestamp overlap).
    segments = group_words([w("início", 0, 400), w("fim.", 450, 1_300), w("Novo.", 1_000, 1_500)])
    for i, seg in enumerate(segments):
        assert seg.end_ms > seg.start_ms
        assert all(seg.start_ms <= x.start_ms <= x.end_ms <= seg.end_ms for x in seg.words)
        if i:
            assert segments[i - 1].end_ms <= seg.start_ms
