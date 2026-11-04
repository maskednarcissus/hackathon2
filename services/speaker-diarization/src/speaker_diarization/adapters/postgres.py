"""PostgreSQL adapters (psycopg 3 + psycopg_pool), selected when ``DATABASE_URL`` is set.

Tables: ``speaker_turns`` (V002 + pending/speaker-diarization.sql, owned here) and
``processed_events``. No DDL at runtime.
"""

from __future__ import annotations

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from speaker_diarization.ids import is_uuid
from speaker_diarization.models import TurnOut

CONSUMER = "speaker-diarization"


def make_pool(url: str, *, min_size: int = 1, max_size: int = 10) -> AsyncConnectionPool:
    return AsyncConnectionPool(
        url, min_size=min_size, max_size=max_size, open=False, kwargs={"autocommit": True}
    )


class PoolLifecycle:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self.pool = pool

    async def open(self) -> None:
        await self.pool.open(wait=True)

    async def close(self) -> None:
        await self.pool.close()


class PostgresTurnRepository:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def replace(
        self, transcript_id: str, turns: list[TurnOut], processing_version: str
    ) -> None:
        async with self._pool.connection() as conn, conn.transaction():
            # Serialise concurrent re-diarizations of the same transcript.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext('speaker_turns:' || %s))",
                (transcript_id,),
            )
            await conn.execute(
                "DELETE FROM speaker_turns WHERE transcript_id = %s", (transcript_id,)
            )
            if turns:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        """
                        INSERT INTO speaker_turns
                            (transcript_id, speaker_label, start_ms, end_ms, processing_version)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        [
                            (
                                transcript_id,
                                t.speaker_label,
                                t.start_ms,
                                t.end_ms,
                                processing_version,
                            )
                            for t in turns
                        ],
                    )

    async def list(self, transcript_id: str) -> list[TurnOut]:
        if not is_uuid(transcript_id):
            return []
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT speaker_label, start_ms, end_ms FROM speaker_turns
                WHERE transcript_id = %s ORDER BY start_ms, end_ms
                """,
                (transcript_id,),
            )
            rows = await cur.fetchall()
        return [
            TurnOut(speaker_label=r["speaker_label"], start_ms=r["start_ms"], end_ms=r["end_ms"])
            for r in rows
        ]


class PostgresProcessedEvents:
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
                "INSERT INTO processed_events (event_id, consumer) VALUES (%s, %s)"
                " ON CONFLICT DO NOTHING",
                (event_id, self._consumer),
            )
