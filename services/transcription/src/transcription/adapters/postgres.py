"""PostgreSQL adapters (psycopg 3 + psycopg_pool), selected when ``DATABASE_URL`` is set.

Tables (V002 + pending/transcription{,-phase6}.sql): ``transcription_jobs`` (partial unique index
``uq_transcription_jobs_active``), ``transcription_vocabularies``, ``processed_events``.
The service never runs DDL.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from transcription.ids import is_uuid
from transcription.languages import DEFAULT_LANGUAGE, canonical_language
from transcription.models import JobStatus, TranscriptionJob, TranscriptionRequest
from transcription.vocabulary import VocabularyCatalog, merge_phrases

CONSUMER = "transcription"


def make_pool(url: str, *, min_size: int = 1, max_size: int = 10) -> AsyncConnectionPool:
    """Closed pool; open it in the app lifespan (``await pool.open()``)."""
    return AsyncConnectionPool(
        url,
        min_size=min_size,
        max_size=max_size,
        open=False,
        kwargs={"autocommit": True},
    )


class PoolLifecycle:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self.pool = pool

    async def open(self) -> None:
        await self.pool.open(wait=True)

    async def close(self) -> None:
        await self.pool.close()


_JOB_COLUMNS = (
    "id::text AS id, recording_session_id::text AS recording_session_id, status::text AS status,"
    " provider, model, processing_version, request, transcript_id::text AS transcript_id,"
    " segment_count, word_count, mean_confidence, failure_reason, created_at, started_at,"
    " finished_at"
)
_ACTIVE_PREDICATE = "status IN ('queued', 'running', 'completed')"


def _row_to_job(row: dict[str, Any]) -> TranscriptionJob:
    created: datetime = row["created_at"]
    return TranscriptionJob(
        job_id=row["id"],
        status=JobStatus(row["status"]),
        request=TranscriptionRequest.model_validate(row["request"]),
        created_at=created,
        updated_at=row["finished_at"] or row["started_at"] or created,
        transcript_id=row["transcript_id"],
        segment_count=row["segment_count"],
        word_count=row["word_count"],
        mean_confidence=(
            float(row["mean_confidence"]) if row["mean_confidence"] is not None else None
        ),
        failure_reason=row["failure_reason"],
        provider=row["provider"],
        model=row["model"],
    )


class PostgresJobRepository:
    def __init__(self, pool: AsyncConnectionPool, processing_version: str) -> None:
        self._pool = pool
        self._processing_version = processing_version

    async def _one(self, sql: str, params: tuple[Any, ...]) -> TranscriptionJob | None:
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(sql, params)
            row = await cur.fetchone()
        return _row_to_job(row) if row else None

    async def create_if_absent(self, job: TranscriptionJob) -> tuple[TranscriptionJob, bool]:
        req = job.request
        for _ in range(3):
            inserted = await self._one(
                f"""
                INSERT INTO transcription_jobs
                    (id, recording_session_id, status, provider, model, processing_version,
                     request, created_at, language)
                VALUES (%s, %s, 'queued', %s, %s, %s, %s, %s, %s)
                ON CONFLICT (recording_session_id) WHERE {_ACTIVE_PREDICATE} DO NOTHING
                RETURNING {_JOB_COLUMNS}
                """,
                (
                    job.job_id,
                    req.recording_session_id,
                    job.provider,
                    job.model,
                    self._processing_version,
                    Jsonb(req.dump()),
                    job.created_at,
                    req.language,
                ),
            )
            if inserted is not None:
                return inserted, True
            existing = await self.find_active_for_recording(req.recording_session_id)
            if existing is not None:
                return existing, False
            # The active job turned 'failed' between the two statements: try again.
        raise RuntimeError(f"could not create a job for recording {req.recording_session_id}")

    async def claim(self, job_id: str) -> TranscriptionJob | None:
        if not is_uuid(job_id):
            return None
        return await self._one(
            f"""
            UPDATE transcription_jobs SET status = 'running', started_at = NOW()
            WHERE id = %s AND status = 'queued'
            RETURNING {_JOB_COLUMNS}
            """,
            (job_id,),
        )

    async def save(self, job: TranscriptionJob) -> None:
        finished = job.status in (JobStatus.COMPLETED, JobStatus.FAILED)
        async with self._pool.connection() as conn:
            await conn.execute(
                """
                UPDATE transcription_jobs SET
                    status = %s::transcription_job_status,
                    request = %s,
                    transcript_id = %s,
                    segment_count = %s,
                    word_count = %s,
                    mean_confidence = %s,
                    failure_reason = %s,
                    language = %s,
                    started_at = CASE WHEN %s::text <> 'queued'
                                      THEN COALESCE(started_at, NOW()) END,
                    finished_at = CASE WHEN %s THEN COALESCE(finished_at, %s) END
                WHERE id = %s
                """,
                (
                    job.status.value,
                    Jsonb(job.request.dump()),
                    job.transcript_id,
                    job.segment_count,
                    job.word_count,
                    job.mean_confidence,
                    job.failure_reason,
                    job.request.language or DEFAULT_LANGUAGE,
                    job.status.value,
                    finished,
                    job.updated_at.astimezone(UTC),
                    job.job_id,
                ),
            )

    async def get(self, job_id: str) -> TranscriptionJob | None:
        if not is_uuid(job_id):
            return None
        return await self._one(
            f"SELECT {_JOB_COLUMNS} FROM transcription_jobs WHERE id = %s", (job_id,)
        )

    async def find_active_for_recording(self, recording_session_id: str) -> TranscriptionJob | None:
        if not is_uuid(recording_session_id):
            return None
        return await self._one(
            f"""
            SELECT {_JOB_COLUMNS} FROM transcription_jobs
            WHERE recording_session_id = %s AND {_ACTIVE_PREDICATE}
            ORDER BY created_at DESC LIMIT 1
            """,
            (recording_session_id,),
        )


class PostgresVocabularySource:
    """``transcription_vocabularies`` merged on top of the JSON catalog.

    Precedence (later wins for per-phrase boost): catalog → platform-wide rows
    (``institution_id IS NULL``, pending migration) → institution rows; within each,
    discipline-agnostic rows before discipline-specific ones.
    """

    def __init__(self, pool: AsyncConnectionPool, base: VocabularyCatalog | None = None) -> None:
        self._pool = pool
        self._base = base or VocabularyCatalog()

    async def phrases_for(
        self, institution_id: str | None, discipline: str | None, language: str = "pt-BR"
    ) -> tuple[tuple[str, ...], dict[str, float]]:
        inst = institution_id if institution_id and is_uuid(institution_id) else None
        lang = canonical_language(language)
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT phrases, boost FROM transcription_vocabularies
                WHERE (institution_id IS NULL OR institution_id = %s)
                  AND (discipline IS NULL OR discipline = %s)
                  AND language = %s
                ORDER BY (institution_id IS NOT NULL), (discipline IS NOT NULL), created_at
                """,
                (inst, discipline, lang),
            )
            rows = await cur.fetchall()
        boosts: dict[str, float] = {}
        db_phrases: list[str] = []
        for row in rows:
            for phrase in row["phrases"]:
                db_phrases.append(phrase)
                boosts[phrase.strip()] = float(row["boost"])
        phrases = merge_phrases(
            self._base.phrases_for(institution_id, discipline, lang),
            db_phrases,
            max_phrases=self._base.max_phrases,
        )
        return phrases, {p: b for p, b in boosts.items() if p in phrases}


class PostgresProcessedEvents:
    """``processed_events`` keyed by ``(event_id, consumer)``."""

    def __init__(self, pool: AsyncConnectionPool, consumer: str = CONSUMER) -> None:
        self._pool = pool
        self._consumer = consumer

    async def is_processed(self, event_id: str) -> bool:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM processed_events WHERE event_id = %s AND consumer = %s",
                (event_id, self._consumer),
            )
            return await cur.fetchone() is not None

    async def mark_processed(self, event_id: str) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                """
                INSERT INTO processed_events (event_id, consumer) VALUES (%s, %s)
                ON CONFLICT DO NOTHING
                """,
                (event_id, self._consumer),
            )
