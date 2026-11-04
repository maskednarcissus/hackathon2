"""PostgreSQL adapters (psycopg 3 async pool) for lecture-intelligence.

Tables: ``lecture_summaries``, ``lecture_topics``, ``concepts``, ``questions``,
``reading_references`` (V001 + V003), ``assistant_*`` (V003) and ``event_inbox`` (pending).
No DDL is executed here.
"""

from __future__ import annotations

import re
import uuid
from collections import defaultdict
from datetime import datetime
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from lecture_intelligence.assistant_store import (
    ANONYMISED_QUESTION,
    Conversation,
    StoredAnswer,
    Turn,
)
from lecture_intelligence.models import (
    AnswerBlock,
    AnswerProvenance,
    AssistantAnswer,
    Citation,
    Concept,
    LectureStructure,
    Provenance,
    Question,
    ReadingReference,
    Subtopic,
    Topic,
    ValidationFlag,
    ValidationReport,
)
from lecture_intelligence.revision import (
    REVIEWABLE,
    RevisionItem,
    RevisionPlan,
    Schedule,
    sm2,
)

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def is_uuid(value: str | None) -> bool:
    return bool(value and _UUID.match(value))


def create_pool(conninfo: str, *, min_size: int = 1, max_size: int = 10) -> AsyncConnectionPool:
    return AsyncConnectionPool(
        conninfo, open=False, min_size=min_size, max_size=max_size, kwargs={"autocommit": True}
    )


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


_SUMMARY_SELECT = """
SELECT ls.id, ls.scheduled_class_id, ls.transcript_id, ls.title, ls.executive_summary,
       ls.processing_version, ls.model_name, ls.class_section_id, ls.course_id, ls.course_name,
       ls.class_date, ls.starts_at, ls.prompt_id, ls.prompt_version, ls.chunk_count,
       ls.ai_request_ids, ls.dropped_items, ls.validation_flags, ls.created_at, ls.language,
       c.institution_id
FROM lecture_summaries ls
JOIN scheduled_classes sc ON sc.id = ls.scheduled_class_id
LEFT JOIN class_sections cs ON cs.id = sc.class_section_id
LEFT JOIN courses c ON c.id = cs.course_id
"""


class PostgresLectureRepository:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def save(self, structure: LectureStructure) -> None:
        s = structure
        p = s.provenance
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(
                """
                INSERT INTO lecture_summaries (
                    id, scheduled_class_id, transcript_id, title, executive_summary,
                    processing_version, processing_status, model_provider, model_name,
                    class_section_id, course_id, course_name, class_date, starts_at,
                    prompt_id, prompt_version, chunk_count, ai_request_ids, dropped_items,
                    validation_flags, created_at, language)
                VALUES (%s, %s, %s, %s, %s, %s, 'complete', 'ai-gateway', %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s::uuid[], %s, %s, %s, %s)
                """,
                (
                    s.lecture_summary_id,
                    s.scheduled_class_id,
                    s.transcript_id,
                    s.title,
                    s.executive_summary,
                    p.processing_version,
                    p.model,
                    s.class_section_id,
                    s.course_id,
                    s.course_name,
                    s.class_date,
                    _parse_ts(s.starts_at),
                    p.prompt_id,
                    p.prompt_version,
                    p.chunk_count,
                    [r for r in p.ai_request_ids if is_uuid(r)],
                    s.validation.dropped_items,
                    Jsonb([f.model_dump(by_alias=True) for f in s.validation.flags]),
                    _parse_ts(s.created_at),
                    s.language,
                ),
            )
            for topic in s.topics:
                parent = await self._insert_topic(conn, s.lecture_summary_id, topic, None)
                for sub in topic.subtopics:
                    await self._insert_topic(conn, s.lecture_summary_id, sub, parent)
            for c in s.concepts:
                await conn.execute(
                    "INSERT INTO concepts (id, lecture_summary_id, term, definition, example, "
                    "segment_indexes) VALUES (%s, %s, %s, %s, %s, %s)",
                    (
                        c.id,
                        s.lecture_summary_id,
                        c.term,
                        c.definition,
                        c.example,
                        c.segment_indexes,
                    ),
                )
            for q in s.questions:
                await conn.execute(
                    "INSERT INTO questions (lecture_summary_id, question_text, answer_text, "
                    "asked_by, segment_indexes) VALUES (%s, %s, %s, %s, %s)",
                    (s.lecture_summary_id, q.question, q.answer, q.asked_by, q.segment_indexes),
                )
            for r in s.reading_references:
                await conn.execute(
                    "INSERT INTO reading_references (lecture_summary_id, title, authors, "
                    "reference_type, segment_indexes) VALUES (%s, %s, %s, %s, %s)",
                    (s.lecture_summary_id, r.title, r.authors, r.type, r.segment_indexes),
                )

    @staticmethod
    async def _insert_topic(
        conn: AsyncConnection[Any], summary_id: str, topic: Subtopic, parent: str | None
    ) -> str:
        topic_id = str(uuid.uuid4())
        await conn.execute(
            "INSERT INTO lecture_topics (id, lecture_summary_id, title, description, topic_order, "
            "parent_topic_id, start_ms, end_ms, segment_indexes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                topic_id,
                summary_id,
                topic.title,
                topic.description,
                topic.order,
                parent,
                topic.start_ms,
                topic.end_ms,
                topic.segment_indexes,
            ),
        )
        return topic_id

    async def latest_for_class(self, scheduled_class_id: str) -> LectureStructure | None:
        if not is_uuid(scheduled_class_id):
            return None
        found = await self._load(
            "WHERE ls.scheduled_class_id = %s ORDER BY ls.created_at DESC LIMIT 1",
            (scheduled_class_id,),
        )
        return found[0] if found else None

    async def get(self, lecture_summary_id: str) -> LectureStructure | None:
        if not is_uuid(lecture_summary_id):
            return None
        found = await self._load("WHERE ls.id = %s", (lecture_summary_id,))
        return found[0] if found else None

    async def latest_for_sections(self, class_section_ids: set[str]) -> list[LectureStructure]:
        ids = sorted(i for i in class_section_ids if is_uuid(i))
        if not ids:
            return []
        return await self._load(
            "WHERE ls.id IN (SELECT DISTINCT ON (scheduled_class_id) id FROM lecture_summaries "
            "WHERE class_section_id = ANY(%s::uuid[]) "
            "ORDER BY scheduled_class_id, created_at DESC)",
            (ids,),
        )

    async def retention_candidates(self, institution_id: str, older_than: datetime) -> list[str]:
        if not is_uuid(institution_id):
            return []
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT ls.id FROM lecture_summaries ls "
                "JOIN scheduled_classes sc ON sc.id = ls.scheduled_class_id "
                "JOIN class_sections cs ON cs.id = sc.class_section_id "
                "JOIN courses c ON c.id = cs.course_id "
                "WHERE c.institution_id = %s AND ls.created_at < %s ORDER BY ls.created_at",
                (institution_id, older_than),
            )
            return [str(r[0]) for r in await cur.fetchall()]

    async def delete(self, lecture_summary_ids: list[str]) -> list[str]:
        ids = [i for i in lecture_summary_ids if is_uuid(i)]
        if not ids:
            return []
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "DELETE FROM lecture_summaries WHERE id = ANY(%s::uuid[]) RETURNING id", (ids,)
            )
            return [str(r[0]) for r in await cur.fetchall()]

    async def _load(self, where: str, params: tuple[Any, ...]) -> list[LectureStructure]:
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(f"{_SUMMARY_SELECT} {where}", params)
            rows = await cur.fetchall()
            if not rows:
                return []
            ids = [r["id"] for r in rows]
            children: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
                lambda: defaultdict(list)
            )
            for table, order in (
                ("lecture_topics", "topic_order"),
                ("concepts", "created_at, id"),
                ("questions", "created_at, id"),
                ("reading_references", "created_at, id"),
            ):
                await cur.execute(
                    f"SELECT * FROM {table} WHERE lecture_summary_id = ANY(%s) ORDER BY {order}",
                    (ids,),
                )
                for child in await cur.fetchall():
                    children[str(child["lecture_summary_id"])][table].append(child)
        return [_structure(row, children[str(row["id"])]) for row in rows]


def _structure(row: dict[str, Any], children: dict[str, list[dict[str, Any]]]) -> LectureStructure:
    topic_rows = children["lecture_topics"]
    subs: dict[str, list[Subtopic]] = defaultdict(list)
    for t in topic_rows:
        if t["parent_topic_id"]:
            subs[str(t["parent_topic_id"])].append(
                Subtopic(
                    order=t["topic_order"],
                    title=t["title"],
                    description=t["description"],
                    start_ms=t["start_ms"] or 0,
                    end_ms=t["end_ms"] or 0,
                    segment_indexes=list(t["segment_indexes"]),
                )
            )
    topics = [
        Topic(
            order=t["topic_order"],
            title=t["title"],
            description=t["description"],
            start_ms=t["start_ms"] or 0,
            end_ms=t["end_ms"] or 0,
            segment_indexes=list(t["segment_indexes"]),
            subtopics=sorted(subs[str(t["id"])], key=lambda s: s.order),
        )
        for t in topic_rows
        if not t["parent_topic_id"]
    ]
    return LectureStructure(
        lecture_summary_id=str(row["id"]),
        transcript_id=str(row["transcript_id"]),
        scheduled_class_id=str(row["scheduled_class_id"]),
        institution_id=str(row["institution_id"]) if row["institution_id"] else None,
        class_section_id=str(row["class_section_id"]) if row["class_section_id"] else None,
        course_id=str(row["course_id"]) if row["course_id"] else None,
        course_name=row["course_name"],
        class_date=_iso(row["class_date"]),
        starts_at=_iso(row["starts_at"]),
        language=row["language"] or "pt-BR",
        title=row["title"],
        executive_summary=row["executive_summary"],
        topics=topics,
        concepts=[
            Concept(
                id=str(c["id"]),
                term=c["term"],
                definition=c["definition"],
                example=c["example"],
                segment_indexes=list(c["segment_indexes"]),
            )
            for c in children["concepts"]
        ],
        questions=[
            Question(
                question=q["question_text"],
                answer=q["answer_text"],
                asked_by=q["asked_by"],
                segment_indexes=list(q["segment_indexes"]),
            )
            for q in children["questions"]
        ],
        reading_references=[
            ReadingReference(
                title=r["title"],
                authors=r["authors"],
                type=r["reference_type"],
                segment_indexes=list(r["segment_indexes"]),
            )
            for r in children["reading_references"]
        ],
        validation=ValidationReport(
            dropped_items=row["dropped_items"],
            flags=[ValidationFlag.model_validate(f) for f in row["validation_flags"] or []],
        ),
        provenance=Provenance(
            prompt_id=row["prompt_id"] or "",
            prompt_version=row["prompt_version"] or "",
            model=row["model_name"],
            processing_version=row["processing_version"],
            chunk_count=row["chunk_count"] or 1,
            ai_request_ids=[str(r) for r in row["ai_request_ids"] or []],
        ),
        created_at=row["created_at"].isoformat(),
    )


# ----------------------------------------------------------------------------- assistant
def _answer_text(blocks: list[dict[str, Any]], refusal: str | None) -> str:
    return " ".join(str(b.get("text", "")) for b in blocks) or f"[recusa: {refusal}]"


class PostgresAssistantRepository:
    def __init__(self, pool: AsyncConnectionPool, memory_turns: int = 6) -> None:
        self._pool = pool
        self.memory_turns = memory_turns

    async def get_conversation(self, conversation_id: str) -> Conversation | None:
        if not is_uuid(conversation_id):
            return None
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT id, student_id, institution_id FROM assistant_conversations WHERE id = %s",
                (conversation_id,),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            await cur.execute(
                "SELECT question, answer_blocks, refusal FROM assistant_answers "
                "WHERE conversation_id = %s ORDER BY turn_index DESC LIMIT %s",
                (conversation_id, self.memory_turns),
            )
            turns = [
                Turn(t["question"], _answer_text(t["answer_blocks"], t["refusal"]))
                for t in reversed(await cur.fetchall())
            ]
        return Conversation(
            str(row["id"]), str(row["student_id"]), str(row["institution_id"]), turns
        )

    async def save_conversation(self, conversation: Conversation) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO assistant_conversations (id, student_id, institution_id) "
                "VALUES (%s, %s, %s) ON CONFLICT (id) DO UPDATE SET updated_at = NOW()",
                (
                    conversation.conversation_id,
                    conversation.student_id,
                    conversation.institution_id,
                ),
            )

    async def save_answer(self, answer: StoredAnswer) -> None:
        a = answer.answer
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 11))", (a.conversation_id,)
            )
            await conn.execute(
                """
                INSERT INTO assistant_answers (
                    id, conversation_id, student_id, institution_id, turn_index, question,
                    answer_blocks, refusal, grounded, prompt_id, prompt_version, model,
                    ai_request_id, created_at)
                VALUES (%s, %s, %s, %s,
                        (SELECT COALESCE(MAX(turn_index) + 1, 0) FROM assistant_answers
                         WHERE conversation_id = %s),
                        %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    a.answer_id,
                    a.conversation_id,
                    answer.student_id,
                    answer.institution_id,
                    a.conversation_id,
                    answer.question,
                    Jsonb(a.to_json()["answer"]),
                    a.refusal,
                    a.grounded,
                    a.provenance.prompt_id,
                    a.provenance.prompt_version,
                    a.provenance.model,
                    answer.ai_request_id if is_uuid(answer.ai_request_id) else None,
                    answer.created_at,
                ),
            )
            for c in a.citations:
                await conn.execute(
                    "INSERT INTO assistant_answer_citations (answer_id, citation_id, "
                    "scheduled_class_id, transcript_id, segment_index, start_ms, end_ms, quote) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        a.answer_id,
                        c.id,
                        c.scheduled_class_id if is_uuid(c.scheduled_class_id) else None,
                        c.transcript_id,
                        c.segment_index,
                        c.start_ms,
                        c.end_ms,
                        c.quote,
                    ),
                )

    async def get_answer(self, answer_id: str) -> StoredAnswer | None:
        if not is_uuid(answer_id):
            return None
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute("SELECT * FROM assistant_answers WHERE id = %s", (answer_id,))
            row = await cur.fetchone()
            if row is None:
                return None
            await cur.execute(
                "SELECT * FROM assistant_answer_citations WHERE answer_id = %s", (answer_id,)
            )
            citations = await cur.fetchall()
            await cur.execute(
                "SELECT id, helpful, comment, created_at FROM assistant_feedback "
                "WHERE answer_id = %s ORDER BY created_at",
                (answer_id,),
            )
            feedback = await cur.fetchall()
        order = {f"s{i}": i for i in range(1, 100)}
        answer = AssistantAnswer(
            answer_id=str(row["id"]),
            conversation_id=str(row["conversation_id"]),
            answer=[AnswerBlock.model_validate(b) for b in row["answer_blocks"]],
            citations=[
                Citation(
                    id=c["citation_id"],
                    scheduled_class_id=str(c["scheduled_class_id"] or ""),
                    transcript_id=str(c["transcript_id"]),
                    segment_index=c["segment_index"],
                    start_ms=c["start_ms"],
                    end_ms=c["end_ms"],
                    quote=c["quote"],
                )
                for c in sorted(citations, key=lambda c: order.get(c["citation_id"], 999))
            ],
            grounded=row["grounded"],
            refusal=row["refusal"],
            provenance=AnswerProvenance(
                prompt_id=row["prompt_id"], prompt_version=row["prompt_version"], model=row["model"]
            ),
        )
        return StoredAnswer(
            answer=answer,
            student_id=str(row["student_id"]),
            institution_id=str(row["institution_id"]),
            question=row["question"],
            created_at=row["created_at"],
            ai_request_id=str(row["ai_request_id"]) if row["ai_request_id"] else None,
            feedback=[
                {
                    "feedbackId": str(f["id"]),
                    "answerId": answer_id,
                    "helpful": f["helpful"],
                    "comment": f["comment"],
                    "createdAt": f["created_at"].isoformat(),
                }
                for f in feedback
            ],
        )

    async def add_feedback(self, answer_id: str, entry: dict[str, Any]) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO assistant_feedback (id, answer_id, student_id, helpful, comment) "
                "SELECT %s, id, student_id, %s, %s FROM assistant_answers WHERE id = %s",
                (entry["feedbackId"], entry["helpful"], entry.get("comment"), answer_id),
            )

    async def recent_questions(self, student_id: str, limit: int = 50) -> list[str]:
        if not is_uuid(student_id):
            return []
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT question FROM assistant_answers WHERE student_id = %s AND question <> %s "
                "ORDER BY created_at DESC LIMIT %s",
                (student_id, ANONYMISED_QUESTION, limit),
            )
            return [str(r[0]) for r in await cur.fetchall()]

    async def export_subject(self, student_id: str) -> dict[str, Any]:
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT id, institution_id, created_at FROM assistant_conversations "
                "WHERE student_id = %s ORDER BY created_at",
                (student_id,),
            )
            conversations = await cur.fetchall()
            await cur.execute(
                "SELECT id, conversation_id, question, answer_blocks, refusal, created_at "
                "FROM assistant_answers WHERE student_id = %s ORDER BY created_at",
                (student_id,),
            )
            answers = await cur.fetchall()
            await cur.execute(
                "SELECT id, answer_id, helpful, comment, created_at FROM assistant_feedback "
                "WHERE student_id = %s ORDER BY created_at",
                (student_id,),
            )
            feedback = await cur.fetchall()
        return {
            "conversations": [
                {
                    "conversationId": str(c["id"]),
                    "institutionId": str(c["institution_id"]),
                    "createdAt": c["created_at"].isoformat(),
                }
                for c in conversations
            ],
            "answers": [
                {
                    "answerId": str(a["id"]),
                    "conversationId": str(a["conversation_id"]),
                    "question": a["question"],
                    "answer": a["answer_blocks"],
                    "refusal": a["refusal"],
                    "createdAt": a["created_at"].isoformat(),
                }
                for a in answers
            ],
            "feedback": [
                {
                    "feedbackId": str(f["id"]),
                    "answerId": str(f["answer_id"]),
                    "helpful": f["helpful"],
                    "comment": f["comment"],
                    "createdAt": f["created_at"].isoformat(),
                }
                for f in feedback
            ],
        }

    async def delete_subject(self, student_id: str) -> int:
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT COUNT(*) FROM assistant_answers WHERE student_id = %s", (student_id,)
            )
            row = await cur.fetchone()
            answers = int(row[0]) if row else 0
            await conn.execute(
                "DELETE FROM assistant_feedback WHERE student_id = %s", (student_id,)
            )
            cur = await conn.execute(
                "DELETE FROM assistant_conversations WHERE student_id = %s", (student_id,)
            )
            return answers + cur.rowcount

    async def anonymize_subject(self, student_id: str) -> int:
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "UPDATE assistant_answers SET question = %s WHERE student_id = %s",
                (ANONYMISED_QUESTION, student_id),
            )
            await conn.execute(
                "UPDATE assistant_feedback SET comment = NULL WHERE student_id = %s", (student_id,)
            )
            return cur.rowcount


class PostgresEventInbox:
    def __init__(self, pool: AsyncConnectionPool, consumer: str) -> None:
        self._pool = pool
        self._consumer = consumer

    async def seen(self, event_id: str) -> bool:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM event_inbox WHERE consumer = %s AND event_id = %s",
                (self._consumer, event_id),
            )
            return await cur.fetchone() is not None

    async def mark(self, event_id: str, event_type: str) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO event_inbox (consumer, event_id, event_type) VALUES (%s, %s, %s) "
                "ON CONFLICT (consumer, event_id) DO NOTHING",
                (self._consumer, event_id, event_type),
            )


# ----------------------------------------------------------------------------- revision (6.2)
class PostgresRevisionRepository:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def save_plan(self, plan: RevisionPlan) -> None:
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO revision_plans (id, student_id, class_section_ids, from_date, "
                "to_date, focus, signals, validation, limitations, generated_at) "
                "VALUES (%s, %s, %s::uuid[], %s, %s, %s, %s, %s, %s, %s)",
                (
                    plan.id,
                    plan.student_id,
                    [s for s in plan.class_section_ids if is_uuid(s)],
                    plan.from_date[:10] if plan.from_date else None,
                    plan.to_date[:10] if plan.to_date else None,
                    plan.focus,
                    Jsonb(plan.signals),
                    Jsonb(plan.validation.model_dump(by_alias=True)),
                    plan.limitations,
                    plan.generated_at,
                ),
            )
            for order, item in enumerate(plan.items):
                await conn.execute(
                    "INSERT INTO revision_items (id, plan_id, student_id, kind, "
                    "scheduled_class_id, concept_ids, content, source_citations, item_order, "
                    "created_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s::uuid[], %s, %s, %s, %s)",
                    (
                        item.id,
                        plan.id,
                        item.student_id,
                        item.kind,
                        item.scheduled_class_id,
                        [c for c in item.concept_ids if is_uuid(c)],
                        Jsonb(item.content),
                        Jsonb(item.source_citations),
                        order,
                        item.created_at,
                    ),
                )
                if item.kind in REVIEWABLE:
                    await conn.execute(
                        "INSERT INTO revision_schedules (item_id, student_id, due_at) "
                        "VALUES (%s, %s, %s)",
                        (item.id, item.student_id, plan.generated_at),
                    )

    async def get_plan(self, plan_id: str) -> RevisionPlan | None:
        if not is_uuid(plan_id):
            return None
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute("SELECT * FROM revision_plans WHERE id = %s", (plan_id,))
            row = await cur.fetchone()
            if row is None:
                return None
            await cur.execute(
                "SELECT * FROM revision_items WHERE plan_id = %s ORDER BY item_order", (plan_id,)
            )
            items = [_revision_item(r) for r in await cur.fetchall()]
        validation = row["validation"] or {}
        return RevisionPlan(
            id=str(row["id"]),
            student_id=str(row["student_id"]),
            class_section_ids=[str(s) for s in row["class_section_ids"]],
            from_date=_iso(row["from_date"]),
            to_date=_iso(row["to_date"]),
            focus=list(row["focus"]),
            generated_at=row["generated_at"],
            items=items,
            signals=dict(row["signals"] or {}),
            validation=ValidationReport.model_validate(
                {
                    "droppedItems": validation.get("droppedItems", 0),
                    "flags": validation.get("flags", []),
                }
            ),
            limitations=list(row["limitations"]),
        )

    async def get_item(self, item_id: str) -> tuple[RevisionItem, Schedule | None] | None:
        if not is_uuid(item_id):
            return None
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT i.*, s.repetitions, s.interval_days, s.easiness, s.due_at, s.last_grade, "
                "s.last_reviewed_at, s.item_id AS scheduled FROM revision_items i "
                "LEFT JOIN revision_schedules s ON s.item_id = i.id WHERE i.id = %s",
                (item_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return _revision_item(row), (_schedule(row) if row["scheduled"] else None)

    async def record_review(
        self, item_id: str, student_id: str, grade: int, now: datetime
    ) -> Schedule:
        async with self._pool.connection() as conn, conn.transaction():
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT item_id, student_id, repetitions, interval_days, easiness, due_at, "
                "last_grade, last_reviewed_at FROM revision_schedules "
                "WHERE item_id = %s FOR UPDATE",
                (item_id,),
            )
            row = await cur.fetchone()
            if row is None:
                raise LookupError(item_id)
            updated = sm2(_schedule(row), grade, now)
            await conn.execute(
                "UPDATE revision_schedules SET repetitions = %s, interval_days = %s, "
                "easiness = %s, due_at = %s, last_grade = %s, last_reviewed_at = %s "
                "WHERE item_id = %s",
                (
                    updated.repetitions,
                    updated.interval_days,
                    round(updated.easiness, 3),
                    updated.due_at,
                    grade,
                    now,
                    item_id,
                ),
            )
            await conn.execute(
                "INSERT INTO revision_reviews (item_id, student_id, grade, reviewed_at) "
                "VALUES (%s, %s, %s, %s)",
                (item_id, student_id, grade, now),
            )
        return updated

    async def due(
        self, student_id: str, now: datetime, limit: int
    ) -> tuple[list[tuple[RevisionItem, Schedule]], int]:
        if not is_uuid(student_id):
            return [], 0
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT COUNT(*) AS n FROM revision_schedules "
                "WHERE student_id = %s AND due_at <= %s",
                (student_id, now),
            )
            count_row = await cur.fetchone()
            await cur.execute(
                "SELECT i.*, s.repetitions, s.interval_days, s.easiness, s.due_at, s.last_grade, "
                "s.last_reviewed_at FROM revision_schedules s "
                "JOIN revision_items i ON i.id = s.item_id "
                "WHERE s.student_id = %s AND s.due_at <= %s ORDER BY s.due_at, i.id LIMIT %s",
                (student_id, now, limit),
            )
            rows = await cur.fetchall()
        total = int(count_row["n"]) if count_row else 0
        return [(_revision_item(r), _schedule(r)) for r in rows], total

    async def concept_struggles(self, student_id: str) -> dict[str, int]:
        if not is_uuid(student_id):
            return {}
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT c.concept_id, COUNT(*) FROM revision_reviews r "
                "JOIN revision_items i ON i.id = r.item_id, UNNEST(i.concept_ids) AS c(concept_id) "
                "WHERE r.student_id = %s AND r.grade < 3 GROUP BY c.concept_id",
                (student_id,),
            )
            return {str(r[0]): int(r[1]) for r in await cur.fetchall()}

    async def export_subject(self, student_id: str) -> dict[str, Any]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT id FROM revision_plans WHERE student_id = %s ORDER BY generated_at",
                (student_id,),
            )
            plan_ids = [str(r[0]) for r in await cur.fetchall()]
            cur = await conn.execute(
                "SELECT item_id, grade, reviewed_at FROM revision_reviews WHERE student_id = %s "
                "ORDER BY reviewed_at",
                (student_id,),
            )
            reviews = await cur.fetchall()
        plans = [p for pid in plan_ids if (p := await self.get_plan(pid)) is not None]
        return {
            "revisionPlans": [p.to_json() for p in plans],
            "revisionReviews": [
                {
                    "itemId": str(r[0]),
                    "studentId": student_id,
                    "grade": r[1],
                    "reviewedAt": r[2].isoformat(),
                }
                for r in reviews
            ],
        }

    async def delete_subject(self, student_id: str) -> int:
        async with self._pool.connection() as conn, conn.transaction():
            reviews = await conn.execute(
                "DELETE FROM revision_reviews WHERE student_id = %s", (student_id,)
            )
            plans = await conn.execute(
                "DELETE FROM revision_plans WHERE student_id = %s", (student_id,)
            )
            return reviews.rowcount + plans.rowcount


def _revision_item(row: dict[str, Any]) -> RevisionItem:
    return RevisionItem(
        id=str(row["id"]),
        plan_id=str(row["plan_id"]),
        student_id=str(row["student_id"]),
        kind=row["kind"],
        scheduled_class_id=str(row["scheduled_class_id"]),
        concept_ids=[str(c) for c in row["concept_ids"]],
        content=dict(row["content"]),
        source_citations=list(row["source_citations"]),
        created_at=row["created_at"],
    )


def _schedule(row: dict[str, Any]) -> Schedule:
    return Schedule(
        item_id=str(row.get("item_id") or row["id"]),
        student_id=str(row["student_id"]),
        repetitions=row["repetitions"],
        interval_days=row["interval_days"],
        easiness=float(row["easiness"]),
        due_at=row["due_at"],
        last_grade=row["last_grade"],
        last_reviewed_at=row["last_reviewed_at"],
    )
