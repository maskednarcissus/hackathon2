from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from conftest import INSTITUTION, LECTURE_TEXTS, TRANSCRIPT, Harness, make_segments
from test_integration import KEY, student_claims, token

from lecture_intelligence.actor import ActorResolver, JwksVerifier
from lecture_intelligence.clients import GatewayCallError
from lecture_intelligence.models import Segment
from lecture_intelligence.revision import Schedule, sm2

STUDENT = "55555555-5555-4555-8555-555555555555"
OTHER = "66666666-6666-4666-8666-666666666666"
SECTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
CLASS_A = "10000000-0000-4000-8000-00000000000a"
CLASS_B = "10000000-0000-4000-8000-00000000000b"
CLASS_X = "10000000-0000-4000-8000-00000000000c"

STRUCTURE: dict[str, Any] = {
    "title": "Inflação e política monetária",
    "executiveSummary": "A aula introduziu inflação e a taxa Selic.",
    "topics": [{"title": "Taxa Selic e política monetária", "segmentIndexes": [2, 3]}],
    "concepts": [
        {
            "term": "Inflação",
            "definition": "Aumento generalizado e persistente do nível de preços da economia.",
            "segmentIndexes": [1],
        },
        {
            "term": "Taxa Selic",
            "definition": "Principal instrumento de política monetária do Banco Central.",
            "segmentIndexes": [2],
        },
    ],
}


def _seed(
    h: Harness, class_id: str, section: str, day: str, language: str = "pt-BR"
) -> dict[str, Any]:
    h.gateway.responders["lecture-structuring"] = lambda _: STRUCTURE
    body = {
        "transcriptId": TRANSCRIPT,
        "scheduledClassId": class_id,
        "institutionId": INSTITUTION,
        "classSectionId": section,
        "classDate": day,
        "startsAt": f"{day}T22:00:00Z",
        "language": language,
        "segments": make_segments(LECTURE_TEXTS),
    }
    resp = h.client.post("/v1/lectures/structure", json=body)
    assert resp.status_code == 201, resp.text
    h.transcripts.segments[TRANSCRIPT] = [Segment.model_validate(s) for s in body["segments"]]
    result: dict[str, Any] = resp.json()
    return result


def _materials(concepts: dict[str, str]) -> Any:
    inflacao, selic = concepts["Inflação"], concepts["Taxa Selic"]

    def respond(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "flashcards": [
                {
                    "conceptId": inflacao,
                    "front": "O que é inflação?",
                    "back": "Aumento generalizado e persistente do nível de preços.",
                    "segmentIndexes": [1],
                },
                {
                    "conceptId": inflacao,
                    "front": "Quem inventou a inflação?",
                    "back": "Keynes em 1936 na Inglaterra.",
                    "segmentIndexes": [1],
                },
                {
                    "conceptId": selic,
                    "front": "Selic?",
                    "back": "Taxa básica.",
                    "segmentIndexes": [99],
                },
                {
                    "conceptId": "not-a-concept",
                    "front": "x",
                    "back": "Aumento generalizado de preços.",
                    "segmentIndexes": [1],
                },
            ],
            "quiz": [
                {
                    "conceptId": selic,
                    "question": "Qual o principal instrumento de política monetária?",
                    "options": ["Câmbio fixo", "Taxa Selic", "Imposto de renda", "Salário mínimo"],
                    "correctOption": 1,
                    "explanation": "O Banco Central usa a taxa Selic como principal instrumento.",
                    "segmentIndexes": [2],
                },
                {
                    "conceptId": selic,
                    "question": "Repetida?",
                    "options": ["A", "a", "B", "C"],
                    "correctOption": 0,
                    "segmentIndexes": [2],
                },
                {
                    "conceptId": selic,
                    "question": "Errada?",
                    "options": ["Bitcoin", "Ouro", "Petróleo", "Soja"],
                    "correctOption": 0,
                    "segmentIndexes": [2],
                },
            ],
        }

    return respond


def _plan(h: Harness, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"studentId": STUDENT, "classSectionIds": [SECTION]}
    body.update(overrides)
    resp = h.client.post("/v1/revision/plans", json=body)
    assert resp.status_code == 201, resp.text
    result: dict[str, Any] = resp.json()
    return result


@pytest.fixture()
def seeded() -> tuple[Harness, dict[str, str]]:
    h = Harness()
    _seed(h, CLASS_A, SECTION, "2026-10-01")
    latest = _seed(h, CLASS_B, SECTION, "2026-10-08")
    _seed(h, CLASS_X, FOREIGN, "2026-10-09")
    concepts = {c["term"]: c["id"] for c in latest["concepts"]}
    h.gateway.responders["revision-materials"] = _materials(concepts)
    return h, concepts


def test_sm2_schedule() -> None:
    now = datetime(2026, 11, 1, tzinfo=UTC)
    s = Schedule("i", "s", due_at=now)
    intervals = []
    for _ in range(4):
        s = sm2(s, 5, now)
        intervals.append(s.interval_days)
    assert intervals[:3] == [1, 6, 17] and intervals[3] > intervals[2]
    assert s.easiness == pytest.approx(2.9)
    failed = sm2(s, 2, now)
    assert (failed.repetitions, failed.interval_days) == (0, 1)
    assert failed.due_at == now + timedelta(days=1)
    assert sm2(Schedule("i", "s"), 0, now).easiness == pytest.approx(1.7)
    for _ in range(10):
        s = sm2(s, 0, now)
    assert s.easiness == 1.3
    with pytest.raises(ValueError):
        sm2(s, 6, now)


def test_plan_items_grounding_and_scope(seeded: tuple[Harness, dict[str, str]]) -> None:
    h, concepts = seeded
    plan = _plan(h, maxConcepts=2)
    assert plan["aiGenerated"] is True and plan["studentId"] == STUDENT
    kinds = [i["kind"] for i in plan["items"]]
    assert kinds.count("summary") == 1 and kinds.count("concept_review") == 2
    assert kinds.count("flashcards") == 1 and kinds.count("quiz") == 1
    assert {i["scheduledClassId"] for i in plan["items"]} == {CLASS_B}  # newest lecture wins ties
    assert CLASS_X not in str(plan)

    card = next(i for i in plan["items"] if i["kind"] == "flashcards")
    assert card["content"] == {
        "front": "O que é inflação?",
        "back": "Aumento generalizado e persistente do nível de preços.",
    }
    assert card["conceptIds"] == [concepts["Inflação"]]
    assert card["sourceCitations"][0] == {
        "scheduledClassId": CLASS_B,
        "transcriptId": TRANSCRIPT,
        "segmentIndexes": [1],
        "startMs": 10_000,
        "endMs": 19_900,
    }
    quiz = next(i for i in plan["items"] if i["kind"] == "quiz")
    assert quiz["content"]["correctOption"] == 1 and len(quiz["content"]["options"]) == 4
    reasons = sorted(f["reason"] for f in plan["validation"]["flags"])
    assert reasons == [
        "invalid_options",
        "invalid_segment_reference",
        "ungrounded",
        "ungrounded",
        "unknown_concept",
    ]
    assert plan["validation"]["droppedItems"] == 5

    payload = next(p for p in h.gateway.payloads if p["promptId"] == "revision-materials")
    assert payload["task"] == "revision_materials"
    assert payload["variables"]["language"] == "pt-BR"
    assert "[s1 00:00:10]" in payload["untrustedInputs"]["transcript"]
    assert concepts["Taxa Selic"] in payload["untrustedInputs"]["concepts"]

    stored = h.client.get(f"/v1/revision/plans/{plan['planId']}", params={"studentId": STUDENT})
    assert stored.status_code == 200 and stored.json()["items"] == plan["items"]
    other = h.client.get(f"/v1/revision/plans/{plan['planId']}", params={"studentId": OTHER})
    assert other.status_code == 404


def test_signals_focus_and_date_range(seeded: tuple[Harness, dict[str, str]]) -> None:
    h, concepts = seeded
    focus = _plan(h, maxConcepts=1, focus=[concepts["Taxa Selic"], "unknown"])
    review = next(i for i in focus["items"] if i["kind"] == "concept_review")
    assert review["content"]["term"] == "Taxa Selic"
    assert focus["signals"]["focusConcepts"] == 1
    assert "unknown_focus_concepts_ignored" in focus["limitations"]

    ranged = _plan(h, **{"from": "2026-09-01", "to": "2026-10-02"})
    assert {i["scheduledClassId"] for i in ranged["items"]} == {CLASS_A}
    empty = _plan(h, **{"from": "2027-01-01"})
    assert empty["items"] == [] and "no_lectures_in_scope" in empty["limitations"]


def test_reviews_due_and_struggles(seeded: tuple[Harness, dict[str, str]]) -> None:
    h, concepts = seeded
    plan = _plan(h, maxConcepts=2)
    due = h.client.get("/v1/revision/due", params={"studentId": STUDENT}).json()
    reviewable = [i for i in plan["items"] if i["kind"] != "summary"]
    assert due["total"] == len(reviewable)
    assert all(i["schedule"]["repetitions"] == 0 for i in due["items"])

    selic_review = next(
        i
        for i in plan["items"]
        if i["kind"] == "concept_review" and i["content"]["term"] == "Taxa Selic"
    )
    graded = h.client.post("/v1/revision/reviews", json={"itemId": selic_review["id"], "grade": 1})
    assert graded.status_code == 200
    assert graded.json()["intervalDays"] == 1 and graded.json()["repetitions"] == 0
    after = h.client.get("/v1/revision/due", params={"studentId": STUDENT}).json()
    assert after["total"] == due["total"] - 1

    summary = next(i for i in plan["items"] if i["kind"] == "summary")
    assert (
        h.client.post(
            "/v1/revision/reviews", json={"itemId": summary["id"], "grade": 4}
        ).status_code
        == 422
    )
    stranger = {"itemId": selic_review["id"], "grade": 4, "studentId": OTHER}
    assert h.client.post("/v1/revision/reviews", json=stranger).status_code == 404
    assert (
        h.client.post(
            "/v1/revision/reviews", json={"itemId": selic_review["id"], "grade": 7}
        ).status_code
        == 400
    )

    # The struggled concept now outranks the other one.
    next_plan = _plan(h, maxConcepts=1)
    assert next_plan["signals"]["strugglingConcepts"] == 1
    terms = [i["content"]["term"] for i in next_plan["items"] if i["kind"] == "concept_review"]
    assert terms == ["Taxa Selic"]


def test_assistant_questions_are_a_signal(seeded: tuple[Harness, dict[str, str]]) -> None:
    h, _ = seeded
    h.search.results = []
    for _ in range(2):
        h.client.post(
            "/v1/assistant/ask",
            json={
                "question": "Não entendi a taxa Selic",
                "studentId": STUDENT,
                "institutionId": INSTITUTION,
                "classSectionIds": [SECTION],
            },
        )
    plan = _plan(h, maxConcepts=1)
    assert plan["signals"]["assistantQuestions"] == 2
    assert [i["content"]["term"] for i in plan["items"] if i["kind"] == "concept_review"] == [
        "Taxa Selic"
    ]
    # Another student's questions never influence this student's plan.
    other = _plan(h, maxConcepts=1, studentId=OTHER)
    assert other["signals"]["assistantQuestions"] == 0


def test_ai_failures_degrade_to_structure_items(seeded: tuple[Harness, dict[str, str]]) -> None:
    h, _ = seeded
    h.gateway.responders["revision-materials"] = lambda _: {"flashcards": "nope"}
    invalid = _plan(h)
    assert "ai_materials_invalid" in invalid["limitations"]
    assert {i["kind"] for i in invalid["items"]} == {"summary", "concept_review"}
    h.gateway.error = GatewayCallError("budget_exceeded", "b", 429)
    assert "ai_budget_exceeded" in _plan(h)["limitations"]
    h.gateway.error = None
    h.transcripts.segments.clear()
    assert "transcript_unavailable" in _plan(h)["limitations"]


def test_verified_token_must_match_student() -> None:
    h = Harness(actors=ActorResolver(JwksVerifier(keys={"k1": KEY.public_key()})))
    auth = {"Authorization": f"Bearer {token(student_claims())}"}
    body = {"studentId": OTHER, "classSectionIds": [SECTION]}
    assert h.client.post("/v1/revision/plans", json=body, headers=auth).status_code == 403
    assert (
        h.client.get("/v1/revision/due", params={"studentId": OTHER}, headers=auth).status_code
        == 403
    )
    ok = h.client.post("/v1/revision/plans", json={**body, "studentId": STUDENT}, headers=auth)
    assert ok.status_code == 201


def test_dsr_covers_revision_data(seeded: tuple[Harness, dict[str, str]]) -> None:
    h, _ = seeded
    plan = _plan(h)
    item = next(i for i in plan["items"] if i["kind"] == "concept_review")
    h.client.post("/v1/revision/reviews", json={"itemId": item["id"], "grade": 4})
    subject = {"subjectType": "student", "subjectId": STUDENT}
    access = h.client.post("/internal/v1/dsr/access", json=subject).json()
    assert len(access["export"]["revisionPlans"]) == 1
    assert access["export"]["revisionReviews"][0]["grade"] == 4
    deleted = h.client.post("/internal/v1/dsr/deletion", json=subject).json()
    assert deleted["items"] == 2
    assert h.client.get("/v1/revision/due", params={"studentId": STUDENT}).json()["total"] == 0


def test_lecture_language_reaches_prompts() -> None:
    h = Harness()
    english = _seed(h, CLASS_A, SECTION, "2026-10-01", language="en-US")
    assert english["language"] == "en-US"
    structuring = [p for p in h.gateway.payloads if p["promptId"] == "lecture-structuring"]
    assert structuring[-1]["variables"]["language"] == "en-US"
    concepts = {c["term"]: c["id"] for c in english["concepts"]}
    h.gateway.responders["revision-materials"] = _materials(concepts)
    _plan(h)
    revision = [p for p in h.gateway.payloads if p["promptId"] == "revision-materials"]
    assert revision[-1]["variables"]["language"] == "en-US"
