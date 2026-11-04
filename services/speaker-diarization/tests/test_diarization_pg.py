"""Postgres adapter scenarios (skipped unless TEST_DATABASE_URL is set)."""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from collections.abc import AsyncIterator, Iterator

import psycopg
import pytest
from fastapi.testclient import TestClient
from pg_support import (
    TEST_DATABASE_URL,
    fresh_database,
    seed_institution,
    seed_recording,
    seed_transcript,
)
from psycopg_pool import AsyncConnectionPool
from synth import SR, conversation

from speaker_diarization import PROCESSING_VERSION
from speaker_diarization.adapters.memory import (
    InMemoryAuditSink,
    InMemoryPublisher,
    InMemoryTranscriptStore,
)
from speaker_diarization.adapters.postgres import (
    PoolLifecycle,
    PostgresProcessedEvents,
    PostgresTurnRepository,
    make_pool,
)
from speaker_diarization.app import AppDeps, create_app
from speaker_diarization.audio import LocalAudioLoader, encode_wav
from speaker_diarization.models import TranscriptSegmentRef, TurnOut
from speaker_diarization.service import DiarizationService

pytestmark = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set")


@pytest.fixture(scope="module")
def db_url() -> Iterator[str]:
    yield from fresh_database("speaker-diarization")


@pytest.fixture(scope="module")
def ids(db_url: str) -> dict[str, str]:
    return seed_institution(db_url)


@pytest.fixture
async def pool(db_url: str) -> AsyncIterator[AsyncConnectionPool]:
    p = make_pool(db_url, max_size=4)
    await p.open(wait=True)
    try:
        yield p
    finally:
        await p.close()


def new_transcript(db_url: str, ids: dict[str, str]) -> str:
    return seed_transcript(db_url, seed_recording(db_url, ids))


async def test_turns_replace_and_list(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    repo = PostgresTurnRepository(pool)
    t = new_transcript(db_url, ids)
    first = [
        TurnOut(speaker_label="SPEAKER_1", start_ms=0, end_ms=5_000),
        TurnOut(speaker_label="SPEAKER_2", start_ms=5_000, end_ms=9_000),
    ]
    await repo.replace(t, first, "v1")
    assert await repo.list(t) == first
    second = [TurnOut(speaker_label="SPEAKER_1", start_ms=0, end_ms=9_000)]
    await repo.replace(t, second, "v2")
    assert await repo.list(t) == second
    with psycopg.connect(db_url) as conn:
        assert conn.execute(
            "SELECT processing_version FROM speaker_turns WHERE transcript_id = %s", (t,)
        ).fetchall() == [("v2",)]
    assert await repo.list("nope") == []

    # Concurrent replacements serialise (advisory lock) and leave exactly one full set.
    await asyncio.gather(*(repo.replace(t, first, f"c{i}") for i in range(4)))
    assert await repo.list(t) == first

    # Database constraints keep labels anonymous.
    with pytest.raises(psycopg.errors.CheckViolation):
        await repo.replace(t, [TurnOut(speaker_label="Prof. Ana", start_ms=0, end_ms=1)], "v3")
    assert await repo.list(t) == first  # failed replacement rolled back


async def test_overlap_turns_and_confidence_persist(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    repo = PostgresTurnRepository(pool)
    t = new_transcript(db_url, ids)
    turns = [
        TurnOut(speaker_label="SPEAKER_1", start_ms=0, end_ms=6_000, overlap=True, confidence=0.97),
        # Second voice starting at the same instant (allowed: uniqueness is per speaker).
        TurnOut(speaker_label="SPEAKER_2", start_ms=0, end_ms=2_000, overlap=True, confidence=0.41),
        TurnOut(speaker_label="SPEAKER_2", start_ms=6_000, end_ms=9_000, confidence=0.99),
    ]
    await repo.replace(t, turns, PROCESSING_VERSION)
    stored = await repo.list(t)
    assert sorted(stored, key=lambda x: (x.start_ms, x.speaker_label)) == turns
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(db_url, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO speaker_turns (transcript_id, speaker_label, start_ms, end_ms,"
                " confidence) VALUES (%s, 'SPEAKER_3', 0, 10, 1.5)",
                (t,),
            )


async def test_processed_events(pool: AsyncConnectionPool) -> None:
    events = PostgresProcessedEvents(pool)
    eid = str(uuid.uuid4())
    assert not await events.is_processed(eid)
    await events.mark_processed(eid)
    await events.mark_processed(eid)
    assert await events.is_processed(eid)


def test_event_route_end_to_end_with_postgres(db_url: str, ids: dict[str, str]) -> None:
    audio, truth = conversation([("A", 8), ("B", 8), ("A", 8)], seed=4)
    t = new_transcript(db_url, ids)
    store = InMemoryTranscriptStore()
    store.segments[t] = [
        TranscriptSegmentRef(segment_index=i, start_ms=s + 200, end_ms=e - 200)
        for i, (_, s, e) in enumerate(truth)
    ]
    pool = make_pool(db_url, max_size=4)
    service = DiarizationService(
        loader=LocalAudioLoader(),
        store=store,
        publisher=InMemoryPublisher(),
        audit=InMemoryAuditSink(),
        turns=PostgresTurnRepository(pool),
    )
    deps = AppDeps(
        service=service,
        processed_events=PostgresProcessedEvents(pool),
        internal_token="tok",
        resources=[PoolLifecycle(pool)],
    )
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "rec.wav"
        wav.write_bytes(encode_wav(audio.samples, SR))
        event = {
            "eventId": str(uuid.uuid4()),
            "type": "transcription.completed",
            "occurredAt": "2026-11-04T20:00:00Z",
            "source": "transcription",
            "institutionId": ids["institution_id"],
            "data": {"transcriptId": t, "storageUri": f"file://{wav}"},
        }
        push = {"message": {"data": base64.b64encode(json.dumps(event).encode()).decode()}}
        headers = {"x-internal-token": "tok"}
        with TestClient(create_app(deps)) as client:
            resp = client.post("/v1/events/transcription-completed", json=push, headers=headers)
            assert resp.status_code == 200, resp.text
            assert resp.json()["speakerCount"] == 2
            dup = client.post("/v1/events/transcription-completed", json=push, headers=headers)
            assert dup.json()["duplicate"] is True
            turns = client.get(f"/v1/diarizations/{t}/turns").json()["turns"]
    assert [x["speakerLabel"] for x in turns] == ["SPEAKER_1", "SPEAKER_2", "SPEAKER_1"]
    assert store.speakers[t]["processingVersion"] == PROCESSING_VERSION
