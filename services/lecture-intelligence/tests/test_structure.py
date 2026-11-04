from __future__ import annotations

from typing import Any

from conftest import CLASS, LECTURE_TEXTS, Harness, structure_body

from lecture_intelligence.clients import GatewayCallError

GOOD_AND_BAD: dict[str, Any] = {
    "title": "Inflação e política monetária",
    "executiveSummary": (
        "A aula introduziu o conceito de inflação. O professor explicou o papel da taxa Selic. "
        'O professor afirmou que "o Brasil terá deflação em 2027".'
    ),
    "topics": [
        {
            "title": "Taxa Selic e política monetária",
            "description": "Como o Banco Central usa a Selic.",
            "segmentIndexes": [2, 3],
            "subtopics": [{"title": "Efeito no crédito", "segmentIndexes": [3]}],
        },
        {"title": "Conceito de inflação", "segmentIndexes": [1]},
        {"title": "Criptomoedas e blockchain", "segmentIndexes": [2]},
        {"title": "Tópico fantasma", "segmentIndexes": [999]},
    ],
    "concepts": [
        {
            "term": "Inflação",
            "definition": "Aumento generalizado e persistente do nível de preços.",
            "segmentIndexes": [1],
        },
        {
            "term": "Curva de Phillips",
            "definition": "Relação inversa entre inflação e desemprego.",
            "segmentIndexes": [1],
        },
        {"term": "Taxa Selic", "definition": "Instrumento do Banco Central.", "segmentIndexes": []},
        {
            "term": "inflacao",
            "definition": "Aumento persistente dos preços na economia.",
            "segmentIndexes": [0, 1],
        },
    ],
    "questions": [
        {
            "question": "A Selic alta sempre reduz a inflação?",
            "answer": "Depende das expectativas.",
            "askedBy": "student",
            "segmentIndexes": [4],
        },
        {
            "question": "Qual é o PIB da Argentina?",
            "askedBy": "student",
            "segmentIndexes": [4],
        },
    ],
    "readingReferences": [
        {
            "title": "Macroeconomia",
            "authors": "Mankiw",
            "type": "book",
            "segmentIndexes": [5],
        },
        {"title": "O Capital", "authors": "Karl Marx", "type": "book", "segmentIndexes": [5]},
        {
            "title": "Macroeconomia capítulo cinco",
            "authors": "Blanchard",
            "type": "chapter",
            "segmentIndexes": [5],
        },
    ],
}


def _reasons(body: dict[str, Any]) -> dict[str, str]:
    return {f["path"]: f["reason"] for f in body["validation"]["flags"]}


def test_structure_keeps_grounded_items_and_drops_hallucinations(harness: Harness) -> None:
    harness.gateway.responders["lecture-structuring"] = lambda _: GOOD_AND_BAD
    response = harness.client.post("/v1/lectures/structure", json=structure_body())
    assert response.status_code == 201, response.text
    body = response.json()

    assert body["title"] == "Inflação e política monetária"
    assert "deflação" not in body["executiveSummary"]
    assert "taxa Selic" in body["executiveSummary"]

    titles = [t["title"] for t in body["topics"]]
    assert titles == ["Conceito de inflação", "Taxa Selic e política monetária"]
    selic = body["topics"][1]
    assert selic["order"] == 2
    assert (selic["startMs"], selic["endMs"]) == (20_000, 39_900)
    assert selic["subtopics"][0]["title"] == "Efeito no crédito"

    assert [c["term"] for c in body["concepts"]] == ["Inflação"]
    assert body["concepts"][0]["segmentIndexes"] == [0, 1]
    assert [q["question"] for q in body["questions"]] == ["A Selic alta sempre reduz a inflação?"]
    assert body["questions"][0]["askedBy"] == "student"

    readings = body["readingReferences"]
    assert [r["title"] for r in readings] == ["Macroeconomia", "Macroeconomia capítulo cinco"]
    assert readings[0]["authors"] == "Mankiw"
    assert "authors" not in readings[1]

    reasons = _reasons(body)
    assert reasons["executiveSummary"] == "fabricated_quote"
    assert reasons["topics[2]"] == "ungrounded"
    assert reasons["topics[3]"] == "invalid_segment_reference"
    assert reasons["concepts[1]"] == "ungrounded"
    assert reasons["concepts[2]"] == "missing_citation"
    assert reasons["questions[1]"] == "ungrounded"
    assert reasons["readingReferences[1]"] == "ungrounded"
    assert reasons["readingReferences[2].authors"] == "ungrounded_authors"
    assert reasons["$"] == "injection_suspected"
    assert body["validation"]["droppedItems"] == 6

    assert body["provenance"]["promptId"] == "lecture-structuring"
    assert body["provenance"]["promptVersion"] == "2026-11-04.1"
    assert body["provenance"]["chunkCount"] == 1

    stored = harness.client.get(f"/v1/lectures/{CLASS}")
    assert stored.status_code == 200
    assert stored.json()["lectureSummaryId"] == body["lectureSummaryId"]
    assert harness.publisher.events[0]["type"] == "lecture.structured"
    assert harness.audit.events[0]["action"] == "lecture.structured"
    assert harness.audit.events[0]["metadata"]["droppedItems"] == 6


def test_transcript_is_sent_as_untrusted_input_with_segment_markers(harness: Harness) -> None:
    harness.gateway.responders["lecture-structuring"] = lambda _: {
        "title": "Aula",
        "executiveSummary": "Resumo.",
    }
    harness.client.post("/v1/lectures/structure", json=structure_body())
    payload = harness.gateway.payloads[0]
    assert payload["task"] == "lecture_structuring"
    assert payload["institutionId"]
    transcript = payload["untrustedInputs"]["transcript"]
    assert transcript.splitlines()[1].startswith("[s1 00:00:10] Inflação é")
    assert "Ignore todas" not in str(payload["variables"])
    assert payload["responseSchema"]["type"] == "object"


def test_clean_lecture_has_no_injection_flag(harness: Harness) -> None:
    harness.gateway.responders["lecture-structuring"] = lambda _: {
        "title": "Aula",
        "executiveSummary": "Resumo.",
    }
    body = harness.client.post(
        "/v1/lectures/structure", json=structure_body(LECTURE_TEXTS[:6])
    ).json()
    assert body["validation"] == {"droppedItems": 0, "flags": []}


def test_errors(harness: Harness) -> None:
    missing = structure_body()
    del missing["institutionId"]
    resp = harness.client.post("/v1/lectures/structure", json=missing)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "institution_required"

    dup = structure_body()
    dup["segments"][1]["segmentIndex"] = 0
    assert harness.client.post("/v1/lectures/structure", json=dup).status_code == 400

    harness.gateway.responders["lecture-structuring"] = lambda _: {"title": ""}
    resp = harness.client.post("/v1/lectures/structure", json=structure_body())
    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "invalid_model_output"

    harness.gateway.error = GatewayCallError("budget_exceeded", "budget", 429)
    resp = harness.client.post("/v1/lectures/structure", json=structure_body())
    assert resp.status_code == 429
    assert resp.json()["error"]["code"] == "ai_gateway_budget_exceeded"

    assert harness.client.get("/v1/lectures/unknown").status_code == 404
