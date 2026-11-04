from __future__ import annotations

from typing import Any

from conftest import CLASS, INSTITUTION, LECTURE_TEXTS, TRANSCRIPT, Harness, structure_body

from lecture_intelligence.catalog import truncate
from lecture_intelligence.models import Segment

SECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
SECTION_X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
COURSE_MACRO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
COURSE_LAW = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


def _seed(harness: Harness) -> None:
    lectures = [
        (
            "10000000-0000-4000-8000-000000000001",
            SECTION_A,
            COURSE_MACRO,
            "Macroeconomia",
            "2026-10-01",
            "Inflação e juros",
        ),
        (
            "10000000-0000-4000-8000-000000000002",
            SECTION_A,
            COURSE_MACRO,
            "Macroeconomia",
            "2026-10-08",
            "Modelo IS-LM",
        ),
        (
            "10000000-0000-4000-8000-000000000003",
            SECTION_B,
            COURSE_LAW,
            "Direito Constitucional",
            "2026-10-05",
            "Controle de constitucionalidade",
        ),
        (
            "10000000-0000-4000-8000-000000000004",
            SECTION_X,
            COURSE_LAW,
            "Direito Penal",
            "2026-10-06",
            "Teoria do crime",
        ),
    ]
    for class_id, section, course, course_name, day, title in lectures:
        harness.gateway.responders["lecture-structuring"] = lambda _, t=title: {
            "title": t,
            "executiveSummary": "Resumo da aula sobre inflação. " * 20,
            "topics": [{"title": "Inflação", "segmentIndexes": [1]}],
            "concepts": [
                {
                    "term": "Inflação",
                    "definition": "Aumento generalizado e persistente do nível de preços.",
                    "segmentIndexes": [1],
                }
            ],
        }
        body = structure_body(
            LECTURE_TEXTS[:6],
            scheduledClassId=class_id,
            classSectionId=section,
            courseId=course,
            courseName=course_name,
            classDate=day,
            startsAt=f"{day}T22:00:00Z",
        )
        assert harness.client.post("/v1/lectures/structure", json=body).status_code == 201


def _list(harness: Harness, **params: Any) -> dict[str, Any]:
    params.setdefault("classSectionIds", f"{SECTION_A},{SECTION_B}")
    response = harness.client.get("/v1/lectures", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def test_library_lists_only_requested_sections_newest_first(harness: Harness) -> None:
    _seed(harness)
    body = _list(harness)
    assert body["total"] == 3 and body["page"] == 1 and body["pageSize"] == 20
    assert [i["title"] for i in body["items"]] == [
        "Modelo IS-LM",
        "Controle de constitucionalidade",
        "Inflação e juros",
    ]
    item = body["items"][0]
    assert item["classSectionId"] == SECTION_A
    assert item["courseId"] == COURSE_MACRO and item["courseName"] == "Macroeconomia"
    assert item["classDate"] == "2026-10-08" and item["startsAt"] == "2026-10-08T22:00:00Z"
    assert item["transcriptId"] == TRANSCRIPT
    assert item["topicCount"] == 1 and item["conceptCount"] == 1
    assert len(item["executiveSummary"]) <= 281 and item["executiveSummary"].endswith("…")
    assert "Teoria do crime" not in str(body)


def test_library_filters_sorting_and_pagination(harness: Harness) -> None:
    _seed(harness)
    assert [i["title"] for i in _list(harness, sort="oldest")["items"]][0] == "Inflação e juros"
    assert [i["title"] for i in _list(harness, sort="date_asc")["items"]][0] == "Inflação e juros"
    assert [i["courseName"] for i in _list(harness, sort="course")["items"]] == [
        "Direito Constitucional",
        "Macroeconomia",
        "Macroeconomia",
    ]
    assert _list(harness, sort="title")["items"][0]["title"] == "Controle de constitucionalidade"
    assert _list(harness, courseId=COURSE_LAW)["total"] == 1
    assert [i["title"] for i in _list(harness, q="is-lm")["items"]] == ["Modelo IS-LM"]
    assert _list(harness, q="INFLACAO")["total"] == 3  # accent-insensitive, matches concepts
    ranged = _list(harness, **{"from": "2026-10-02", "to": "2026-10-07"})
    assert [i["title"] for i in ranged["items"]] == ["Controle de constitucionalidade"]
    page2 = _list(harness, page=2, pageSize=2)
    assert page2["total"] == 3 and len(page2["items"]) == 1


def test_library_requires_sections_and_valid_params(harness: Harness) -> None:
    assert harness.client.get("/v1/lectures").status_code == 400
    assert harness.client.get("/v1/lectures", params={"classSectionIds": " , "}).status_code == 400
    bad_sort = {"classSectionIds": SECTION_A, "sort": "random"}
    assert harness.client.get("/v1/lectures", params=bad_sort).status_code == 400
    bad_size = {"classSectionIds": SECTION_A, "pageSize": 500}
    assert harness.client.get("/v1/lectures", params=bad_size).status_code == 400


def test_event_handler_resolves_class_metadata(harness: Harness) -> None:
    harness.transcripts.transcripts[TRANSCRIPT] = {
        "id": TRANSCRIPT,
        "scheduledClassId": CLASS,
        "classSectionId": SECTION_A,
    }
    harness.transcripts.segments[TRANSCRIPT] = [
        Segment.model_validate(s) for s in structure_body(LECTURE_TEXTS[:6])["segments"]
    ]
    harness.academic.classes[CLASS] = {
        "id": CLASS,
        "classSectionId": SECTION_A,
        "courseId": COURSE_MACRO,
        "startsAt": "2026-11-05T01:30:00Z",  # 22:30 on the 4th in São Paulo
        "course": {"id": COURSE_MACRO, "name": "Macroeconomia"},
    }
    harness.gateway.responders["lecture-structuring"] = lambda p: {
        "title": "Inflação",
        "executiveSummary": "Aula.",
    }
    event = {
        "eventId": "ev-meta",
        "type": "transcript.created",
        "institutionId": INSTITUTION,
        "data": {"transcriptId": TRANSCRIPT},
    }
    assert harness.client.post("/v1/events/transcript-created", json=event).status_code == 202
    stored = harness.client.get(f"/v1/lectures/{CLASS}").json()
    assert stored["classSectionId"] == SECTION_A
    assert stored["courseId"] == COURSE_MACRO and stored["courseName"] == "Macroeconomia"
    assert stored["classDate"] == "2026-11-04"
    assert harness.gateway.payloads[0]["variables"]["courseName"] == "Macroeconomia"
    assert harness.gateway.payloads[0]["variables"]["classDate"] == "2026-11-04"


def test_metadata_lookup_failure_is_not_fatal(harness: Harness) -> None:
    harness.academic.fail = True
    harness.transcripts.transcripts[TRANSCRIPT] = {"id": TRANSCRIPT, "scheduledClassId": CLASS}
    harness.transcripts.segments[TRANSCRIPT] = [
        Segment.model_validate(s) for s in structure_body(LECTURE_TEXTS[:6])["segments"]
    ]
    harness.gateway.responders["lecture-structuring"] = lambda p: {
        "title": "A",
        "executiveSummary": "B.",
    }
    event = {"eventId": "ev-f", "institutionId": INSTITUTION, "data": {"transcriptId": TRANSCRIPT}}
    assert harness.client.post("/v1/events/transcript-created", json=event).status_code == 202
    assert "classSectionId" not in harness.client.get(f"/v1/lectures/{CLASS}").json()


def test_truncate() -> None:
    assert truncate("curto") == "curto"
    assert truncate("palavra " * 100, 30) == "palavra palavra palavra…"
