"""Postgres integration tests (skipped unless TEST_DATABASE_URL is set)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from conftest import (
    LECTURE_TEXTS,
    FakeAcademic,
    FakeSearch,
    FakeTranscripts,
    ScriptedGateway,
    make_segments,
)
from fastapi.testclient import TestClient
from pg_support import ADMIN_URL, fresh_database, seed_academic

from lecture_intelligence.adapters.postgres import (
    PostgresAssistantRepository,
    PostgresEventInbox,
    PostgresLectureRepository,
    create_pool,
)
from lecture_intelligence.app import LectureDeps, create_app
from lecture_intelligence.clients import InMemoryAuditClient, InMemoryEventPublisher
from lecture_intelligence.models import SearchResult, Segment

pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set")

IDS = {
    k: str(uuid.uuid4())
    for k in (
        "institution section course scheduled_class scheduled_class_2 transcript student "
        "student_2"
    ).split()
}

STRUCTURE: dict[str, Any] = {
    "title": "Inflação e política monetária",
    "executiveSummary": "A aula introduziu inflação e a taxa Selic.",
    "topics": [
        {
            "title": "Taxa Selic e política monetária",
            "segmentIndexes": [2, 3],
            "subtopics": [{"title": "Efeito no crédito", "segmentIndexes": [3]}],
        },
        {"title": "Conceito de inflação", "segmentIndexes": [1]},
    ],
    "concepts": [
        {
            "term": "Inflação",
            "definition": "Aumento generalizado e persistente do nível de preços.",
            "segmentIndexes": [1],
        },
        {"term": "Curva de Phillips", "definition": "Inventada.", "segmentIndexes": [1]},
    ],
    "questions": [
        {
            "question": "A Selic alta sempre reduz a inflação?",
            "answer": "Depende das expectativas.",
            "askedBy": "student",
            "segmentIndexes": [4],
        }
    ],
    "readingReferences": [
        {"title": "Macroeconomia", "authors": "Mankiw", "type": "book", "segmentIndexes": [5]}
    ],
}


@pytest.fixture(scope="module")
def database() -> Iterator[str]:
    with fresh_database(["lecture-intelligence.sql"]) as url:
        seed_academic(url, IDS)
        yield url


@pytest.fixture()
def env(database: str) -> Iterator[dict[str, Any]]:
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute("TRUNCATE lecture_summaries, assistant_conversations, event_inbox CASCADE")
    pool = create_pool(database, max_size=4)
    gateway = ScriptedGateway()
    transcripts = FakeTranscripts()
    search = FakeSearch()
    audit = InMemoryAuditClient()
    deps = LectureDeps(
        gateway=gateway,
        transcripts=transcripts,
        repository=PostgresLectureRepository(pool),
        publisher=InMemoryEventPublisher(),
        audit=audit,
        search=search,
        academic=FakeAcademic(),
        assistant_repository=PostgresAssistantRepository(pool, memory_turns=6),
        inbox=PostgresEventInbox(pool, "lecture-intelligence"),
        pool=pool,
    )
    with TestClient(create_app(deps)) as client:
        yield {
            "client": client,
            "gateway": gateway,
            "transcripts": transcripts,
            "search": search,
            "audit": audit,
            "db": database,
        }


def _structure(env: dict[str, Any], scheduled_class: str = "scheduled_class") -> dict[str, Any]:
    env["gateway"].responders["lecture-structuring"] = lambda _: STRUCTURE
    body = {
        "transcriptId": IDS["transcript"],
        "scheduledClassId": IDS[scheduled_class],
        "institutionId": IDS["institution"],
        "classSectionId": IDS["section"],
        "courseId": IDS["course"],
        "courseName": "Macroeconomia",
        "classDate": "2026-11-04",
        "startsAt": "2026-11-04T22:00:00Z",
        "segments": make_segments(LECTURE_TEXTS),
    }
    response = env["client"].post("/v1/lectures/structure", json=body)
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def test_structure_round_trip_and_library(env: dict[str, Any]) -> None:
    created = _structure(env)
    client = env["client"]
    stored = client.get(f"/v1/lectures/{IDS['scheduled_class']}").json()
    for key in (
        "title",
        "executiveSummary",
        "topics",
        "concepts",
        "questions",
        "readingReferences",
    ):
        assert stored[key] == created[key], key
    assert stored["topics"][1]["subtopics"][0]["title"] == "Efeito no crédito"
    assert stored["validation"] == created["validation"]
    assert (
        stored["classSectionId"] == IDS["section"] and stored["institutionId"] == IDS["institution"]
    )
    assert stored["classDate"] == "2026-11-04"

    newer = _structure(env)
    assert (
        client.get(f"/v1/lectures/{IDS['scheduled_class']}").json()["lectureSummaryId"]
        == (newer["lectureSummaryId"])
    )
    _structure(env, "scheduled_class_2")
    library = client.get("/v1/lectures", params={"classSectionIds": IDS["section"]}).json()
    assert library["total"] == 2
    assert {i["lectureSummaryId"] for i in library["items"]} >= {newer["lectureSummaryId"]}
    assert library["items"][0]["conceptCount"] == 1
    assert (
        client.get("/v1/lectures", params={"classSectionIds": str(uuid.uuid4())}).json()["total"]
        == 0
    )
    assert client.get("/v1/lectures/not-a-uuid").status_code == 404


def test_retention_deletes_with_children(env: dict[str, Any]) -> None:
    first = _structure(env)
    client = env["client"]
    found = client.get(
        "/internal/v1/retention/candidates",
        params={"institutionId": IDS["institution"], "olderThan": "2999-01-01T00:00:00Z"},
    ).json()
    assert first["lectureSummaryId"] in found["ids"]
    deleted = client.post(
        "/internal/v1/retention/delete",
        json={"ids": found["ids"], "kind": "summary", "jobId": "job-1"},
    ).json()
    assert sorted(deleted["deletedIds"]) == sorted(found["ids"])
    with psycopg.connect(env["db"]) as conn:
        for table in ("lecture_summaries", "lecture_topics", "concepts", "questions"):
            row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            assert row is not None and row[0] == 0, table


def _ask(
    env: dict[str, Any], question: str, conversation: str | None = None, student: str = "student"
) -> Any:
    body: dict[str, Any] = {
        "question": question,
        "studentId": IDS[student],
        "institutionId": IDS["institution"],
        "classSectionIds": [IDS["section"]],
    }
    if conversation:
        body["conversationId"] = conversation
    return env["client"].post("/v1/assistant/ask", json=body)


def test_assistant_persistence_memory_feedback_and_dsr(env: dict[str, Any]) -> None:
    env["search"].results = [
        SearchResult(
            transcript_id=IDS["transcript"],
            scheduled_class_id=IDS["scheduled_class"],
            class_section_id=IDS["section"],
            segment_index=1,
            start_ms=10_000,
            end_ms=19_900,
            text=LECTURE_TEXTS[1],
            score=1.0,
        )
    ]
    env["gateway"].responders["assistant-answer"] = lambda _: {
        "answer": [
            {
                "kind": "professor_statement",
                "text": "Inflação é o aumento generalizado e persistente do nível de preços.",
                "citationIds": ["s1"],
                "quote": "aumento generalizado e persistente do nível de preços",
            }
        ]
    }
    first = _ask(env, "O que é inflação?")
    assert first.status_code == 200, first.text
    conversation = first.json()["conversationId"]
    second = _ask(env, "E na prática?", conversation)
    assert second.json()["conversationId"] == conversation
    history = env["gateway"].payloads[-1]["untrustedInputs"]["conversation"]
    assert "Estudante: O que é inflação?" in history
    assert _ask(env, "Oi?", conversation, student="student_2").status_code == 404

    answer_id = first.json()["answerId"]
    fb = env["client"].post(
        "/v1/assistant/feedback", json={"answerId": answer_id, "helpful": True, "comment": "ótima"}
    )
    assert fb.status_code == 201
    missing = {"answerId": str(uuid.uuid4()), "helpful": True}
    assert env["client"].post("/v1/assistant/feedback", json=missing).status_code == 404
    with psycopg.connect(env["db"]) as conn:
        turns = conn.execute(
            "SELECT turn_index FROM assistant_answers WHERE conversation_id = %s ORDER BY 1",
            (conversation,),
        ).fetchall()
        citation = conn.execute(
            "SELECT quote FROM assistant_answer_citations WHERE answer_id = %s", (answer_id,)
        ).fetchone()
    assert [t[0] for t in turns] == [0, 1]
    assert (
        citation is not None
        and citation[0] == "aumento generalizado e persistente do nível de preços"
    )

    subject = {"subjectType": "student", "subjectId": IDS["student"], "requestId": "r1"}
    access = env["client"].post("/internal/v1/dsr/access", json=subject).json()
    assert access["items"] == 1 + 2 + 1
    assert access["export"]["feedback"][0]["comment"] == "ótima"
    anon = env["client"].post("/internal/v1/dsr/anonymization", json=subject).json()
    assert anon["items"] == 2
    after = env["client"].post("/internal/v1/dsr/access", json=subject).json()
    assert {a["question"] for a in after["export"]["answers"]} == {"[removido a pedido do titular]"}
    deleted = env["client"].post("/internal/v1/dsr/deletion", json=subject).json()
    assert deleted["items"] == 3
    assert env["client"].post("/internal/v1/dsr/access", json=subject).json()["items"] == 0


def test_event_inbox_is_durable(env: dict[str, Any]) -> None:
    env["transcripts"].transcripts[IDS["transcript"]] = {
        "id": IDS["transcript"],
        "scheduledClassId": IDS["scheduled_class"],
        "classSectionId": IDS["section"],
    }
    env["transcripts"].segments[IDS["transcript"]] = [
        Segment.model_validate(s) for s in make_segments(LECTURE_TEXTS[:6])
    ]
    env["gateway"].responders["lecture-structuring"] = lambda _: {
        "title": "Aula",
        "executiveSummary": "Resumo.",
    }
    event = {
        "eventId": "evt-durable",
        "type": "transcript.created",
        "institutionId": IDS["institution"],
        "data": {"transcriptId": IDS["transcript"]},
    }
    client = env["client"]
    assert client.post("/v1/events/transcript-created", json=event).json()["status"] == "processed"
    assert client.post("/v1/events/transcript-created", json=event).json() == {
        "status": "duplicate"
    }
    with psycopg.connect(env["db"]) as conn:
        row = conn.execute("SELECT consumer, event_type FROM event_inbox").fetchone()
    assert row == ("lecture-intelligence", "transcript.created")
