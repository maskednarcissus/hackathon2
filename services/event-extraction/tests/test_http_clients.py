from __future__ import annotations

import json
from datetime import date

import httpx
import pytest

from event_extraction.http_clients import (
    HttpAcademicClient,
    HttpAuditClient,
    HttpCalendarClient,
    HttpGatewayClient,
    HttpTranscriptClient,
)
from event_extraction.ports import NotFoundError, UpstreamError


def transport(handler: object) -> httpx.MockTransport:
    return httpx.MockTransport(handler)  # type: ignore[arg-type]


async def test_academic_client_builds_context_in_campus_timezone() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/scheduled-classes/sc-1":
            return httpx.Response(
                200,
                json={
                    "id": "sc-1",
                    # 01:30 UTC on the 11th is 22:30 on the 10th in São Paulo
                    "startsAt": "2026-03-11T01:30:00.000Z",
                    "timezone": "America/Sao_Paulo",
                    "classSection": {"id": "sec-1", "professorId": "prof-1"},
                    "course": {"id": "c-1", "name": "Cálculo", "institutionId": "inst-1"},
                },
            )
        return httpx.Response(
            200,
            json={
                "items": [
                    {"id": "sc-2", "startsAt": "2026-03-18T01:30:00Z", "status": "scheduled"},
                    {"id": "sc-3", "startsAt": "2026-03-25T01:30:00Z", "status": "cancelled"},
                ]
            },
        )

    ctx = await HttpAcademicClient("http://ai", transport=transport(handler)).get_class_context(
        "sc-1"
    )
    assert ctx.class_date == date(2026, 3, 10)
    assert ctx.class_section_id == "sec-1"
    assert ctx.professor_id == "prof-1"
    assert ctx.institution_id == "inst-1"
    assert ctx.course_name == "Cálculo"
    assert [c.class_date for c in ctx.upcoming_classes] == [date(2026, 3, 17)]
    assert seen[1].url.params["classSectionId"] == "sec-1"


async def test_academic_not_found() -> None:
    client = HttpAcademicClient("http://ai", transport=transport(lambda r: httpx.Response(404)))
    with pytest.raises(NotFoundError):
        await client.get_class_context("x")


async def test_gateway_error_is_upstream_error() -> None:
    client = HttpGatewayClient(
        "http://gw", transport=transport(lambda r: httpx.Response(422, json={"error": {}}))
    )
    with pytest.raises(UpstreamError):
        await client.generate({"task": "event_extraction"})


async def test_calendar_client_round_trip() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/conflicts/check":
            return httpx.Response(
                200,
                json={
                    "conflicts": [
                        {
                            "kind": "assessment_load",
                            "severity": "warning",
                            "message": "3 provas na semana",
                        }
                    ]
                },
            )
        assert json.loads(request.content)["extractedEventId"] == "e-1"
        return httpx.Response(201, json={"id": "cal-1"})

    client = HttpCalendarClient("http://cal", transport=transport(handler))
    conflicts = await client.check_conflicts({"classSectionId": "s"})
    assert conflicts[0].kind == "assessment_load"
    assert await client.publish({"extractedEventId": "e-1"}) == "cal-1"


async def test_transcript_client_paginates_segments() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/transcripts/t-1":
            return httpx.Response(200, json={"id": "t-1", "recordingSessionId": "r-1"})
        if "cursor" not in request.url.params:
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "segmentIndex": 0,
                            "startMs": 0,
                            "endMs": 10,
                            "text": "a",
                            "confidence": 0.9,
                        }
                    ],
                    "nextCursor": "c2",
                },
            )
        return httpx.Response(
            200,
            json={
                "items": [
                    {"segmentIndex": 1, "startMs": 10, "endMs": 20, "text": "b", "confidence": 0.9}
                ]
            },
        )

    data = await HttpTranscriptClient("http://tm", transport=transport(handler)).get_transcript(
        "t-1"
    )
    assert data.recording_session_id == "r-1"
    assert [s.text for s in data.segments] == ["a", "b"]


async def test_audit_failures_are_not_fatal() -> None:
    client = HttpAuditClient("http://audit", transport=transport(lambda r: httpx.Response(500)))
    await client.record(
        action="event.extracted",
        resource_type="extracted_event",
        resource_id="e",
        tenant_id="i",
        actor_id=None,
        actor_type="system",
    )
