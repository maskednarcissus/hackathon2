"""PostgreSQL adapters (integration stage §1).

Schema: ``data/migrations/V001–V004`` + ``data/migrations/pending/event-extraction.sql``.
The service never runs DDL. Dedup + insert for a class section runs in one transaction holding
a transaction-scoped advisory lock on the section, so two concurrent extractions of the same
announcement cannot both create an event.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import date, datetime, time
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..models import (
    ChangeRecord,
    Confidence,
    Conflict,
    DateResolutionModel,
    EventSource,
    ExtractedEvent,
    Mention,
    ProposedChange,
    Provenance,
    PublicationPolicy,
)
from ..ports import NotFoundError, RetentionCandidate

_UUID_NS = uuid.UUID("7d3c0f0e-5a51-4f0c-9d0e-6e7a1f1b2c3d")

Conn = AsyncConnection[DictRow]


def as_uuid(value: str) -> str:
    """Map arbitrary identifiers (e.g. Pub/Sub messageIds) to a stable UUID."""
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return str(uuid.uuid5(_UUID_NS, value))


def _maybe_uuid(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def make_pool(
    database_url: str, *, min_size: int = 1, max_size: int = 10
) -> AsyncConnectionPool[Conn]:
    """Create an unopened pool; :class:`PoolLifecycle` opens it at application start-up."""
    return AsyncConnectionPool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        open=False,
        kwargs={"row_factory": dict_row},
        connection_class=AsyncConnection[DictRow],
    )


async def create_pool(
    database_url: str, *, min_size: int = 1, max_size: int = 10
) -> AsyncConnectionPool[Conn]:
    pool = make_pool(database_url, min_size=min_size, max_size=max_size)
    await pool.open(wait=True, timeout=30)
    return pool


class PoolLifecycle:
    def __init__(self, pool: AsyncConnectionPool[Conn]) -> None:
        self.pool = pool

    async def start(self) -> None:
        await self.pool.open(wait=True, timeout=30)

    async def stop(self) -> None:
        await self.pool.close()


_EVENT_COLUMNS = (
    "id, transcript_segment_id, source_segment_index, scheduled_class_id, course_id, "
    "institution_id, event_type, title, description, event_date, event_time, event_timezone, "
    "confidence_overall, confidence_transcription, confidence_event_classification, "
    "confidence_date_interpretation, confidence_course_association, confirmation_status, "
    "processing_version, created_at, updated_at, transcript_id, recording_session_id, "
    "class_section_id, professor_id, date_expression, date_resolution, quote, source_start_ms, "
    "source_end_ms, flags, duplicate_of, proposed_change, conflicts, conflict_check, "
    "calendar_event_id, extractor, prompt_id, prompt_version, model_name"
)


def _row_params(ev: ExtractedEvent) -> dict[str, Any]:
    c = ev.confidence
    return {
        "id": ev.id,
        "segment_index": ev.source.segment_index,
        "scheduled_class_id": ev.scheduled_class_id,
        "course_id": ev.course_id,
        "institution_id": ev.institution_id,
        "event_type": ev.type,
        "title": ev.title,
        "description": ev.description,
        "event_date": ev.event_date,
        "event_time": ev.event_time,
        "timezone": ev.timezone,
        "c_overall": c.overall,
        "c_transcription": c.transcription,
        "c_classification": c.event_classification,
        "c_date": c.date_interpretation,
        "c_course": c.course_association,
        "status": ev.confirmation_status,
        "processing_version": ev.provenance.processing_version,
        "created_at": ev.created_at,
        "updated_at": ev.updated_at,
        "transcript_id": ev.transcript_id,
        "recording_session_id": ev.source.recording_session_id,
        "class_section_id": ev.class_section_id,
        "professor_id": ev.professor_id,
        "date_expression": ev.date_expression,
        "date_resolution": Jsonb(ev.date_resolution.model_dump(by_alias=True)),
        "quote": ev.source.quote,
        "start_ms": ev.source.start_ms,
        "end_ms": ev.source.end_ms,
        "flags": ev.flags,
        "duplicate_of": ev.duplicate_of,
        "proposed_change": Jsonb(ev.proposed_change.model_dump(by_alias=True))
        if ev.proposed_change
        else None,
        "conflicts": Jsonb([x.model_dump(by_alias=True) for x in ev.conflicts]),
        "conflict_check": ev.conflict_check,
        "calendar_event_id": ev.calendar_event_id,
        "extractor": ev.provenance.extractor,
        "prompt_id": ev.provenance.prompt_id,
        "prompt_version": ev.provenance.prompt_version,
        "model_name": ev.provenance.model,
    }


_INSERT = f"""
INSERT INTO extracted_events ({_EVENT_COLUMNS}) VALUES (
  %(id)s,
  (SELECT ts.id FROM transcript_segments ts
    WHERE ts.transcript_id = %(transcript_id)s AND ts.segment_index = %(segment_index)s),
  %(segment_index)s, %(scheduled_class_id)s, %(course_id)s, %(institution_id)s,
  %(event_type)s::academic_event_type, %(title)s, %(description)s, %(event_date)s::date,
  %(event_time)s::time, %(timezone)s, %(c_overall)s, %(c_transcription)s, %(c_classification)s,
  %(c_date)s, %(c_course)s, %(status)s::confirmation_status, %(processing_version)s,
  %(created_at)s, %(updated_at)s, %(transcript_id)s, %(recording_session_id)s,
  %(class_section_id)s, %(professor_id)s, %(date_expression)s, %(date_resolution)s, %(quote)s,
  %(start_ms)s, %(end_ms)s, %(flags)s, %(duplicate_of)s, %(proposed_change)s, %(conflicts)s,
  %(conflict_check)s, %(calendar_event_id)s, %(extractor)s, %(prompt_id)s, %(prompt_version)s,
  %(model_name)s
)"""

_UPDATE = """
UPDATE extracted_events SET
  event_type = %(event_type)s::academic_event_type, title = %(title)s,
  description = %(description)s, event_date = %(event_date)s::date,
  event_time = %(event_time)s::time, event_timezone = %(timezone)s,
  confidence_overall = %(c_overall)s, confidence_transcription = %(c_transcription)s,
  confidence_event_classification = %(c_classification)s,
  confidence_date_interpretation = %(c_date)s, confidence_course_association = %(c_course)s,
  confirmation_status = %(status)s::confirmation_status, flags = %(flags)s,
  duplicate_of = %(duplicate_of)s, proposed_change = %(proposed_change)s,
  conflicts = %(conflicts)s, conflict_check = %(conflict_check)s,
  calendar_event_id = %(calendar_event_id)s, date_expression = %(date_expression)s,
  date_resolution = %(date_resolution)s
WHERE id = %(id)s"""


def _iso_time(value: time | None) -> str | None:
    return value.strftime("%H:%M") if value else None


def _iso_date(value: date | None) -> str | None:
    return value.isoformat() if value else None


def _to_event(
    row: dict[str, Any], mentions: list[dict[str, Any]], changes: list[dict[str, Any]]
) -> ExtractedEvent:
    return ExtractedEvent(
        id=str(row["id"]),
        type=row["event_type"],
        title=row["title"],
        description=row["description"],
        institution_id=str(row["institution_id"]),
        course_id=str(row["course_id"]),
        class_section_id=str(row["class_section_id"]),
        scheduled_class_id=str(row["scheduled_class_id"]),
        transcript_id=str(row["transcript_id"]),
        professor_id=str(row["professor_id"]) if row["professor_id"] else None,
        event_date=_iso_date(row["event_date"]),
        event_time=_iso_time(row["event_time"]),
        timezone=row["event_timezone"] or "America/Sao_Paulo",
        date_expression=row["date_expression"],
        date_resolution=DateResolutionModel.model_validate(row["date_resolution"]),
        source=EventSource(
            recording_session_id=str(row["recording_session_id"])
            if row["recording_session_id"]
            else None,
            segment_index=row["source_segment_index"],
            start_ms=row["source_start_ms"],
            end_ms=row["source_end_ms"],
            quote=row["quote"],
        ),
        confidence=Confidence(
            overall=float(row["confidence_overall"]),
            transcription=float(row["confidence_transcription"]),
            event_classification=float(row["confidence_event_classification"]),
            date_interpretation=float(row["confidence_date_interpretation"]),
            course_association=float(row["confidence_course_association"]),
        ),
        flags=list(row["flags"] or []),
        confirmation_status=row["confirmation_status"],
        duplicate_of=str(row["duplicate_of"]) if row["duplicate_of"] else None,
        proposed_change=ProposedChange.model_validate(row["proposed_change"])
        if row["proposed_change"]
        else None,
        mentions=[
            Mention(
                scheduled_class_id=str(m["scheduled_class_id"]),
                segment_index=m["transcript_segment_index"],
                quote=m["quote"],
                event_date=_iso_date(m["event_date"]),
                recorded_at=m["recorded_at"],
            )
            for m in mentions
        ],
        conflicts=[Conflict.model_validate(c) for c in row["conflicts"] or []],
        conflict_check=row["conflict_check"],
        change_history=[
            ChangeRecord(
                changed_at=c["changed_at"],
                changed_by=c["actor_ref"]
                or (str(c["changed_by"]) if c["changed_by"] else "system"),
                source=c["source"],
                change_type=c["change_type"],
                field=c["field_name"],
                previous_value=c["previous_value"],
                new_value=c["new_value"],
                reason=c["reason"],
            )
            for c in changes
        ],
        provenance=Provenance(
            extractor="llm" if row["extractor"] == "llm" else "heuristic",
            prompt_id=row["prompt_id"],
            prompt_version=row["prompt_version"],
            model=row["model_name"],
            processing_version=row["processing_version"],
        ),
        calendar_event_id=str(row["calendar_event_id"]) if row["calendar_event_id"] else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class PostgresEventRepository:
    def __init__(self, pool: AsyncConnectionPool[Conn]) -> None:
        self.pool = pool
        self._tx: ContextVar[Conn | None] = ContextVar(f"ee_tx_{id(self)}", default=None)

    @asynccontextmanager
    async def _conn(self) -> AsyncIterator[Conn]:
        current = self._tx.get()
        if current is not None:
            yield current
            return
        async with self.pool.connection() as conn:
            yield conn

    @asynccontextmanager
    async def lock_section(self, class_section_id: str) -> AsyncIterator[None]:
        if self._tx.get() is not None:
            yield
            return
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"extracted_events:section:{class_section_id}",),
            )
            token = self._tx.set(conn)
            try:
                yield
            finally:
                self._tx.reset(token)

    async def add(self, event: ExtractedEvent) -> None:
        async with self._conn() as conn, conn.transaction():
            await conn.execute(_INSERT, _row_params(event))
            await self._write_children(conn, event)

    async def update(self, event: ExtractedEvent) -> None:
        async with self._conn() as conn, conn.transaction():
            cur = await conn.execute(_UPDATE, _row_params(event))
            if cur.rowcount == 0:
                raise NotFoundError(event.id)
            await self._write_children(conn, event)

    async def _write_children(self, conn: Conn, ev: ExtractedEvent) -> None:
        await conn.execute(
            "DELETE FROM extracted_event_mentions WHERE extracted_event_id = %s", (ev.id,)
        )
        for position, m in enumerate(ev.mentions):
            await conn.execute(
                """INSERT INTO extracted_event_mentions
                   (extracted_event_id, scheduled_class_id, transcript_segment_index, quote,
                    event_date, recorded_at, position)
                   VALUES (%s, %s, %s, %s, %s::date, %s, %s)""",
                (
                    ev.id,
                    m.scheduled_class_id,
                    m.segment_index,
                    m.quote,
                    m.event_date,
                    m.recorded_at,
                    position,
                ),
            )
        cur = await conn.execute(
            "SELECT COALESCE(MAX(sequence), -1) AS last FROM event_changes "
            "WHERE extracted_event_id = %s",
            (ev.id,),
        )
        row = await cur.fetchone()
        last = int(row["last"]) if row else -1
        for seq, change in enumerate(ev.change_history):
            if seq <= last:
                continue
            actor_uuid = _maybe_uuid(change.changed_by)
            await conn.execute(
                """INSERT INTO event_changes
                   (extracted_event_id, changed_by, actor_ref, changed_at, change_type, field_name,
                    previous_value, new_value, source, reason, sequence)
                   VALUES (%s, %s, %s, %s, %s::event_change_type, %s, %s, %s,
                           %s::change_source, %s, %s)""",
                (
                    ev.id,
                    actor_uuid,
                    None if actor_uuid else change.changed_by,
                    change.changed_at,
                    change.change_type,
                    change.field,
                    change.previous_value,
                    change.new_value,
                    change.source,
                    change.reason,
                    seq,
                ),
            )

    async def _hydrate(self, conn: Conn, rows: list[dict[str, Any]]) -> list[ExtractedEvent]:
        if not rows:
            return []
        ids = [r["id"] for r in rows]
        mentions: dict[Any, list[dict[str, Any]]] = {}
        cur = await conn.execute(
            "SELECT * FROM extracted_event_mentions WHERE extracted_event_id = ANY(%s) "
            "ORDER BY extracted_event_id, position NULLS LAST, recorded_at, id",
            (ids,),
        )
        for m in await cur.fetchall():
            mentions.setdefault(m["extracted_event_id"], []).append(m)
        changes: dict[Any, list[dict[str, Any]]] = {}
        cur = await conn.execute(
            "SELECT * FROM event_changes WHERE extracted_event_id = ANY(%s) "
            "ORDER BY extracted_event_id, sequence NULLS LAST, changed_at, id",
            (ids,),
        )
        for c in await cur.fetchall():
            changes.setdefault(c["extracted_event_id"], []).append(c)
        return [_to_event(r, mentions.get(r["id"], []), changes.get(r["id"], [])) for r in rows]

    async def _select(self, where: str, params: tuple[Any, ...]) -> list[ExtractedEvent]:
        async with self._conn() as conn:
            cur = await conn.execute(
                f"SELECT * FROM extracted_events WHERE {where} ORDER BY created_at, id", params
            )
            return await self._hydrate(conn, list(await cur.fetchall()))

    async def get(self, event_id: str) -> ExtractedEvent | None:
        if _maybe_uuid(event_id) is None:
            return None
        events = await self._select("id = %s", (event_id,))
        return events[0] if events else None

    async def list_by_section(self, class_section_id: str) -> list[ExtractedEvent]:
        return await self._select("class_section_id = %s", (class_section_id,))

    async def list_all(self) -> list[ExtractedEvent]:
        return await self._select("TRUE", ())

    async def list_review(
        self, statuses: list[str], professor_id: str | None, class_section_id: str | None
    ) -> list[ExtractedEvent]:
        where = ["confirmation_status::text = ANY(%s)"]
        params: list[Any] = [statuses]
        if professor_id:
            if _maybe_uuid(professor_id) is None:
                return []
            where.append("professor_id = %s")
            params.append(professor_id)
        if class_section_id:
            if _maybe_uuid(class_section_id) is None:
                return []
            where.append("class_section_id = %s")
            params.append(class_section_id)
        return await self._select(" AND ".join(where), tuple(params))

    async def retention_candidates(
        self, institution_id: str, older_than: datetime, limit: int
    ) -> list[RetentionCandidate]:
        async with self._conn() as conn:
            cur = await conn.execute(
                """SELECT e.id, e.created_at, e.class_section_id, e.recording_session_id,
                          e.professor_id, rs.recording_policy_id
                     FROM extracted_events e
                     LEFT JOIN recording_sessions rs ON rs.id = e.recording_session_id
                    WHERE e.institution_id = %s AND e.created_at < %s
                    ORDER BY e.created_at, e.id
                    LIMIT %s""",
                (institution_id, older_than, limit),
            )
            rows = await cur.fetchall()
        return [
            RetentionCandidate(
                id=str(r["id"]),
                created_at=r["created_at"],
                class_section_id=str(r["class_section_id"]),
                recording_session_id=str(r["recording_session_id"])
                if r["recording_session_id"]
                else None,
                recording_policy_id=str(r["recording_policy_id"])
                if r["recording_policy_id"]
                else None,
                subject_ids=[str(r["professor_id"])] if r["professor_id"] else [],
            )
            for r in rows
        ]

    async def delete_many(self, ids: list[str]) -> list[str]:
        valid = [i for i in ids if _maybe_uuid(i)]
        if not valid:
            return []
        async with self._conn() as conn, conn.transaction():
            cur = await conn.execute(
                "DELETE FROM extracted_events WHERE id = ANY(%s::uuid[]) RETURNING id", (valid,)
            )
            return [str(r["id"]) for r in await cur.fetchall()]


class PostgresPolicyProvider:
    """``event_publication_policies`` (V003); institutions without a row use ``default``."""

    def __init__(self, pool: AsyncConnectionPool[Conn], default: PublicationPolicy) -> None:
        self.pool = pool
        self.default = default

    async def get_policy(self, institution_id: str) -> PublicationPolicy:
        if _maybe_uuid(institution_id) is None:
            return self.default
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """SELECT auto_publish, auto_publish_min_confidence,
                          allow_auto_publish_types::text[] AS allow_types,
                          require_professor_review_for::text[] AS review_types,
                          publish_on_confirm
                     FROM event_publication_policies WHERE institution_id = %s""",
                (institution_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return self.default
        return PublicationPolicy.model_validate(
            {
                "autoPublish": row["auto_publish"],
                "autoPublishMinConfidence": float(row["auto_publish_min_confidence"]),
                "allowAutoPublishTypes": list(row["allow_types"]),
                "requireProfessorReviewFor": list(row["review_types"]),
                "publishOnConfirm": row["publish_on_confirm"],
            }
        )


class PostgresProcessedEventStore:
    """V002 ``processed_events`` (event_id, consumer)."""

    def __init__(self, pool: AsyncConnectionPool[Conn]) -> None:
        self.pool = pool

    async def is_processed(self, event_id: str, consumer: str) -> bool:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM processed_events WHERE event_id = %s AND consumer = %s",
                (as_uuid(event_id), consumer),
            )
            return await cur.fetchone() is not None

    async def mark_processed(self, event_id: str, consumer: str) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(
                "INSERT INTO processed_events (event_id, consumer) VALUES (%s, %s) "
                "ON CONFLICT DO NOTHING",
                (as_uuid(event_id), consumer),
            )
