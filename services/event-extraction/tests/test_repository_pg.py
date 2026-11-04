"""Postgres adapter tests (integration stage §1).

Skipped unless ``TEST_DATABASE_URL`` (admin URL of a server) is set. The module creates a fresh
``ci_test_<random>`` database, applies ``data/migrations/V*.sql`` in order plus
``data/migrations/pending/event-extraction.sql``, runs the behavioural scenarios against the
Postgres adapters and drops the database.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FixedClock

from event_extraction.app import create_app
from event_extraction.models import (
    ClassContext,
    ExtractionRequest,
    PublicationPolicy,
    ScheduledClassRef,
    TranscriptSegment,
)
from event_extraction.ports import (
    InMemoryAcademicClient,
    InMemoryAuditClient,
    InMemoryCalendarClient,
    InMemoryEventPublisher,
    InMemoryTranscriptClient,
    TranscriptData,
)
from event_extraction.service import Actor, Dependencies, EventExtractionService

ADMIN_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set")

MIGRATIONS = Path(__file__).resolve().parents[3] / "data" / "migrations"

if ADMIN_URL:
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    from event_extraction.adapters.postgres import (
        PostgresEventRepository,
        PostgresPolicyProvider,
        PostgresProcessedEventStore,
        create_pool,
    )


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    assert ADMIN_URL
    name = f"ci_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    params = conninfo_to_dict(ADMIN_URL)
    params["dbname"] = name
    url = make_conninfo(**params)
    try:
        files = sorted(MIGRATIONS.glob("V*.sql")) + [
            MIGRATIONS / "pending" / "event-extraction.sql"
        ]
        with psycopg.connect(url, autocommit=True) as conn:
            for f in files:
                conn.execute(f.read_text(encoding="utf-8"))  # type: ignore[call-overload]
        yield url
    finally:
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@dataclass
class Seed:
    institution: str
    course: str
    section: str
    professor: str
    classes: list[str]
    class_dates: list[date]
    transcripts: list[str]
    recording_session: str
    policy: str


def seed(url: str, texts: list[list[str]]) -> Seed:
    """Academic data + one recording/transcript per class (texts[i] = segments of class i)."""
    ids: dict[str, Any] = {
        k: str(uuid.uuid4())
        for k in (
            "hc",
            "inst",
            "campus",
            "room",
            "program",
            "term",
            "course",
            "prof",
            "section",
            "policy",
            "device",
            "rec",
        )
    }
    dates = [date(2026, 3, 10) + timedelta(days=7 * i) for i in range(4)]
    with psycopg.connect(url, autocommit=False) as c:
        c.execute(
            "INSERT INTO holding_companies (id, name, legal_name) VALUES (%s,'G','G SA')",
            (ids["hc"],),
        )
        c.execute(
            "INSERT INTO institutions (id, holding_company_id, name, state) "
            "VALUES (%s,%s,%s,'SP')",
            (ids["inst"], ids["hc"], f"Inst {ids['inst'][:6]}"),
        )
        c.execute(
            "INSERT INTO campuses (id, institution_id, name, city, state) "
            "VALUES (%s,%s,'Centro','SP','SP')",
            (ids["campus"], ids["inst"]),
        )
        c.execute(
            "INSERT INTO classrooms (id, campus_id, name, code) VALUES (%s,%s,'101','101')",
            (ids["room"], ids["campus"]),
        )
        c.execute(
            "INSERT INTO academic_programs (id, institution_id, name, code) "
            "VALUES (%s,%s,'Economia','ECO')",
            (ids["program"], ids["inst"]),
        )
        c.execute(
            "INSERT INTO academic_terms (id, institution_id, name, start_date, end_date) "
            "VALUES (%s,%s,'2026.1','2026-02-01','2026-07-15')",
            (ids["term"], ids["inst"]),
        )
        c.execute(
            "INSERT INTO courses (id, institution_id, academic_program_id, academic_term_id, "
            "code, name, discipline) VALUES (%s,%s,%s,%s,'ECO101','Micro I','economia')",
            (ids["course"], ids["inst"], ids["program"], ids["term"]),
        )
        c.execute(
            "INSERT INTO professors (id, institution_id, name, email) "
            "VALUES (%s,%s,'Prof','p@x.br')",
            (ids["prof"], ids["inst"]),
        )
        c.execute(
            "INSERT INTO class_sections (id, course_id, professor_id, section_code, "
            "institution_id) VALUES (%s,%s,%s,'A',%s)",
            (ids["section"], ids["course"], ids["prof"], ids["inst"]),
        )
        c.execute(
            "INSERT INTO recording_policies (id, institution_id, name, legal_basis) "
            "VALUES (%s,%s,'Padrão','legitimate_interest')",
            (ids["policy"], ids["inst"]),
        )
        c.execute(
            "INSERT INTO capture_devices (id, classroom_id, serial_number, model, firmware_version,"
            " institution_id, public_key_pem, public_key_fingerprint, certificate,"
            " certificate_issued_at, certificate_expires_at) VALUES"
            " (%s,%s,%s,'a1','1.0',%s,'pem',%s,'cert',now(),now()+interval '1 year')",
            (ids["device"], ids["room"], f"SN-{ids['device'][:8]}", ids["inst"], ids["device"]),
        )
        c.execute(
            "INSERT INTO recording_sessions (id, device_id, classroom_id, recording_policy_id,"
            " started_at, audio_format, sample_rate, channels, institution_id)"
            " VALUES (%s,%s,%s,%s,now(),'wav',16000,1,%s)",
            (ids["rec"], ids["device"], ids["room"], ids["policy"], ids["inst"]),
        )
        classes, transcripts = [], []
        for i, segs in enumerate(texts):
            sc, tx = str(uuid.uuid4()), str(uuid.uuid4())
            start = datetime(dates[i].year, dates[i].month, dates[i].day, 22, tzinfo=UTC)
            c.execute(
                "INSERT INTO scheduled_classes (id, class_section_id, classroom_id, starts_at,"
                " ends_at) VALUES (%s,%s,%s,%s,%s)",
                (sc, ids["section"], ids["room"], start, start + timedelta(hours=2)),
            )
            c.execute(
                "INSERT INTO transcripts (id, recording_session_id, scheduled_class_id,"
                " processing_version) VALUES (%s,%s,%s,%s)",
                (tx, ids["rec"], sc, f"v{i}"),
            )
            for j, text in enumerate(segs):
                c.execute(
                    "INSERT INTO transcript_segments (transcript_id, segment_index, start_ms,"
                    " end_ms, text, original_text, confidence) VALUES (%s,%s,%s,%s,%s,%s,0.95)",
                    (tx, j, j * 10_000, j * 10_000 + 9_000, text, text),
                )
            classes.append(sc)
            transcripts.append(tx)
        c.commit()
    return Seed(
        ids["inst"],
        ids["course"],
        ids["section"],
        ids["prof"],
        classes,
        dates[: len(texts)],
        transcripts,
        ids["rec"],
        ids["policy"],
    )


class PgHarness:
    def __init__(self, pool: Any, s: Seed, texts: list[list[str]]) -> None:
        self.seed = s
        self.calendar = InMemoryCalendarClient()
        self.publisher = InMemoryEventPublisher()
        self.audit = InMemoryAuditClient()
        self.clock = FixedClock()
        self.repository = PostgresEventRepository(pool)
        self.processed = PostgresProcessedEventStore(pool)
        upcoming = [date(2026, 3, 17), date(2026, 3, 24), date(2026, 3, 31), date(2026, 4, 7)]
        contexts = {
            sc: ClassContext(
                scheduled_class_id=sc,
                class_date=d,
                institution_id=s.institution,
                course_id=s.course,
                course_name="Micro I",
                class_section_id=s.section,
                professor_id=s.professor,
                upcoming_classes=[
                    ScheduledClassRef(scheduled_class_id=f"u{k}", class_date=u)
                    for k, u in enumerate(upcoming)
                    if u > d
                ],
            )
            for sc, d in zip(s.classes, s.class_dates, strict=True)
        }
        self.transcripts = InMemoryTranscriptClient(
            {
                tx: TranscriptData(
                    transcript_id=tx,
                    recording_session_id=s.recording_session,
                    scheduled_class_id=sc,
                    segments=[
                        TranscriptSegment(
                            segment_index=j,
                            start_ms=j * 10_000,
                            end_ms=j * 10_000 + 9_000,
                            text=t,
                            confidence=0.95,
                        )
                        for j, t in enumerate(segs)
                    ],
                )
                for tx, sc, segs in zip(s.transcripts, s.classes, texts, strict=True)
            }
        )
        self.deps = Dependencies(
            repository=self.repository,
            academic=InMemoryAcademicClient(contexts),
            calendar=self.calendar,
            transcripts=self.transcripts,
            publisher=self.publisher,
            audit=self.audit,
            policies=PostgresPolicyProvider(pool, PublicationPolicy()),
            clock=self.clock,
            processed=self.processed,
        )
        self.service = EventExtractionService(self.deps)

    async def extract(self, i: int) -> Any:
        return await self.service.extract(
            ExtractionRequest(
                transcript_id=self.seed.transcripts[i], scheduled_class_id=self.seed.classes[i]
            )
        )


@pytest.fixture
async def pool(database_url: str) -> AsyncIterator[Any]:
    p = await create_pool(database_url, max_size=8)
    try:
        yield p
    finally:
        await p.close()


async def harness_for(pool: Any, url: str, texts: list[list[str]]) -> PgHarness:
    s = await asyncio.to_thread(seed, url, texts)
    return PgHarness(pool, s, texts)


async def test_round_trip_preserves_the_event(pool: Any, database_url: str) -> None:
    h = await harness_for(pool, database_url, [["Bom dia.", "A P1 vai ser dia 24/03, às 19h."]])
    created = (await h.extract(0)).events[0]
    stored = await h.repository.get(created.id)
    assert stored is not None
    assert stored.model_dump(exclude={"created_at", "updated_at"}) == created.model_dump(
        exclude={"created_at", "updated_at"}
    )
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT e.transcript_segment_id, ts.segment_index FROM extracted_events e "
                "JOIN transcript_segments ts ON ts.id = e.transcript_segment_id WHERE e.id = %s",
                (created.id,),
            )
        ).fetchone()
    assert row["segment_index"] == 1  # lineage to transcript_segments resolved
    assert await h.repository.get("not-a-uuid") is None


async def test_dedup_mentions_and_date_change_with_history(pool: Any, database_url: str) -> None:
    h = await harness_for(
        pool,
        database_url,
        [
            [
                "O trabalho em grupo deve ser entregue no dia 24 de março.",
                "Repetindo: o trabalho em grupo é dia 24 de março.",
            ],
            ["Lembrando: o trabalho em grupo é no dia 24 de março."],
            ["O trabalho em grupo foi adiado para o dia 31 de março."],
        ],
    )
    original = (await h.extract(0)).events[0]
    second = await h.extract(1)
    assert second.events == [] and second.deduplicated[0].kind == "repeat"
    stored = await h.repository.get(original.id)
    assert stored is not None
    assert [m.scheduled_class_id for m in stored.mentions] == [h.seed.classes[0], h.seed.classes[1]]

    actor = Actor(h.seed.professor, "professor")
    await h.service.confirm(original.id, actor, "ok")
    proposal = (await h.extract(2)).events[0]
    assert proposal.duplicate_of == original.id
    await h.service.confirm(proposal.id, actor, None)
    updated = await h.repository.get(original.id)
    assert updated is not None and updated.event_date == "2026-03-31"
    fields = [(c.field, c.new_value, c.changed_by) for c in updated.change_history]
    assert fields == [
        ("confirmationStatus", "confirmed", h.seed.professor),
        ("confirmationStatus", "published", h.seed.professor),
        ("eventDate", "2026-03-31", h.seed.professor),
    ]
    assert h.calendar.published[updated.calendar_event_id or ""]["eventDate"] == "2026-03-31"


async def test_concurrent_extractions_do_not_duplicate(pool: Any, database_url: str) -> None:
    texts = [["A P2 é dia 12 de maio."]] * 4
    h = await harness_for(pool, database_url, texts)
    results = await asyncio.gather(*(h.extract(i) for i in range(4)))
    assert sum(len(r.events) for r in results) == 1
    events = await h.repository.list_by_section(h.seed.section)
    assert len(events) == 1
    assert len(events[0].mentions) == 3


async def test_policy_row_enables_auto_publish(pool: Any, database_url: str) -> None:
    h = await harness_for(pool, database_url, [["A P1 vai ser dia 24/03."]])
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO event_publication_policies (institution_id, auto_publish, "
            "allow_auto_publish_types) VALUES (%s, TRUE, '{examination}')",
            (h.seed.institution,),
        )
    ev = (await h.extract(0)).events[0]
    assert ev.confirmation_status == "published"
    stored = await h.repository.get(ev.id)
    assert stored is not None and stored.calendar_event_id == ev.calendar_event_id
    assert stored.change_history[-1].changed_by == "system"
    queue = await h.service.review_queue(h.seed.professor, ["published"], None)
    assert [e.id for e in queue] == [ev.id]


async def test_push_delivery_idempotent_in_postgres(pool: Any, database_url: str) -> None:
    h = await harness_for(pool, database_url, [["Na próxima aula teremos quiz."]])
    h.deps.internal_token = "tok"
    app = create_app(h.deps)
    event_id = str(uuid.uuid4())
    body = {
        "eventId": event_id,
        "type": "transcript.created",
        "data": {"transcriptId": h.seed.transcripts[0]},
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.post("/v1/events/transcript-ready", json=body)).status_code == 401
        headers = {"x-internal-token": "tok"}
        first = await c.post("/v1/events/transcript-ready", json=body, headers=headers)
        assert first.json()["status"] == "processed"
        again = await c.post("/v1/events/transcript-ready", json=body, headers=headers)
        assert again.json()["status"] == "duplicate"
        queue = await c.get("/v1/review-queue", params={"professorId": h.seed.professor})
        assert len(queue.json()) == 1
    assert await h.processed.is_processed(event_id, "event-extraction")


async def test_retention_candidates_and_delete(pool: Any, database_url: str) -> None:
    h = await harness_for(
        pool,
        database_url,
        [
            ["O trabalho em grupo deve ser entregue no dia 24 de março."],
            ["O trabalho em grupo foi adiado para o dia 31 de março."],
        ],
    )
    original = (await h.extract(0)).events[0]
    proposal = (await h.extract(1)).events[0]
    future = h.clock.now() + timedelta(days=1)
    candidates = await h.repository.retention_candidates(h.seed.institution, future, 100)
    assert {c.id for c in candidates} == {original.id, proposal.id}
    assert all(c.recording_policy_id == h.seed.policy for c in candidates)
    assert all(c.subject_ids == [h.seed.professor] for c in candidates)
    assert (
        await h.repository.retention_candidates(h.seed.institution, future - timedelta(days=2), 100)
        == []
    )
    deleted = await h.repository.delete_many([original.id, str(uuid.uuid4()), "junk"])
    assert deleted == [original.id]
    remaining = await h.repository.get(proposal.id)
    assert remaining is not None and remaining.duplicate_of is None
    async with pool.connection() as conn:
        n = await (
            await conn.execute(
                "SELECT count(*) AS n FROM event_changes WHERE extracted_event_id = %s",
                (original.id,),
            )
        ).fetchone()
    assert n["n"] == 0
