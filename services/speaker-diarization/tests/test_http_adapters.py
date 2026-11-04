import json

import httpx

from speaker_diarization.adapters.http import (
    HttpAuditSink,
    HttpEventBusPublisher,
    HttpTranscriptStoreClient,
)
from speaker_diarization.models import SpeakerAssignment

T = "55555555-5555-4555-8555-555555555555"
INST = "11111111-1111-4111-8111-111111111111"


def client_for(handler: object) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))  # type: ignore[arg-type]


async def test_get_segments_follows_cursor_pages() -> None:
    seen: list[httpx.Request] = []
    pages = {
        None: {
            "items": [{"segmentIndex": i, "startMs": i, "endMs": i + 1} for i in range(50)],
            "nextCursor": 50,
        },
        "50": {"items": [{"segmentIndex": 50, "startMs": 50, "endMs": 51}], "nextCursor": None},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=pages[request.url.params.get("cursor")])

    store = HttpTranscriptStoreClient("http://tm", internal_token="tok", client=client_for(handler))
    segments = await store.get_segments(T)
    assert [s.segment_index for s in segments] == list(range(51))
    assert len(seen) == 2 and seen[0].url.params["limit"] == "50"
    assert all(r.headers["x-internal-token"] == "tok" for r in seen)


async def test_get_segments_404_is_empty() -> None:
    store = HttpTranscriptStoreClient(
        "http://tm", client=client_for(lambda _r: httpx.Response(404, json={}))
    )
    assert await store.get_segments(T) == []


async def test_put_speakers_body() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    store = HttpTranscriptStoreClient("http://tm", client=client_for(handler))
    await store.put_speakers(
        T,
        [SpeakerAssignment(segment_index=0, speaker_label="SPEAKER_1")],
        1,
        method="acoustic_clustering",
        processing_version="diarization-1.0.0",
    )
    assert seen[0].method == "PUT" and seen[0].url.path == f"/v1/transcripts/{T}/speakers"
    assert json.loads(seen[0].content) == {
        "assignments": [{"segmentIndex": 0, "speakerLabel": "SPEAKER_1"}],
        "speakerCount": 1,
        "method": "acoustic_clustering",
        "processingVersion": "diarization-1.0.0",
    }


async def test_event_bus_and_audit() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(202, json={})

    bus = HttpEventBusPublisher("http://bus/", internal_token="tok", client=client_for(handler))
    await bus.publish("diarization.completed", {"transcriptId": T}, INST)
    assert seen[0].url.path == "/v1/topics/diarization.completed:publish"
    envelope = json.loads(seen[0].content)
    assert envelope["source"] == "speaker-diarization" and envelope["institutionId"] == INST

    audit = HttpAuditSink("http://audit", client=client_for(handler))
    await audit.record(
        action="diarization.failed",
        resource_type="transcript",
        resource_id=T,
        institution_id=None,
        metadata={},
    )
    body = json.loads(seen[1].content)
    assert body["resourceId"] == T and body["actorId"] == "speaker-diarization"
    assert "tenantId" not in body
