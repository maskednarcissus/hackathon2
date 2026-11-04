"""Postgres adapter scenarios (skipped unless TEST_DATABASE_URL is set)."""

from __future__ import annotations

import asyncio
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
)
from psycopg_pool import AsyncConnectionPool

from transcription import PROCESSING_VERSION
from transcription.adapters.postgres import (
    PostgresJobRepository,
    PostgresProcessedEvents,
    PostgresVocabularySource,
    make_pool,
)
from transcription.app import AppDeps, create_app
from transcription.fakes import (
    FakeSpeechProvider,
    InMemoryAuditSink,
    InMemoryPublisher,
)
from transcription.models import AudioSegmentRef, JobStatus, TranscriptionRequest, TranscriptSegment
from transcription.ports import StoredTranscript
from transcription.service import TranscriptionService
from transcription.vocabulary import VocabularyCatalog

pytestmark = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set")

FIVE_MIN = 300_000


@pytest.fixture(scope="module")
def db_url() -> Iterator[str]:
    yield from fresh_database("transcription")


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


class PgTranscriptStore:
    """Stand-in for transcript-management that writes the ``transcripts`` row (FK target)."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.calls: list[dict[str, object]] = []

    async def create_transcript(
        self,
        *,
        recording_session_id: str,
        scheduled_class_id: str | None,
        language: str,
        processing_version: str,
        provider: str,
        model: str,
        segments: list[TranscriptSegment],
        class_section_id: str | None = None,
        institution_id: str | None = None,
    ) -> StoredTranscript:
        self.calls.append({"classSectionId": class_section_id, "institutionId": institution_id})
        async with await psycopg.AsyncConnection.connect(self.url, autocommit=True) as conn:
            cur = await conn.execute(
                """
                INSERT INTO transcripts
                    (recording_session_id, language, processing_version, provider, model,
                     institution_id)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id::text
                """,
                (
                    recording_session_id,
                    language,
                    processing_version,
                    provider,
                    model,
                    institution_id,
                ),
            )
            row = await cur.fetchone()
        assert row is not None
        return StoredTranscript(transcript_id=str(row[0]))


def request(recording_id: str, institution_id: str, n: int = 3) -> TranscriptionRequest:
    return TranscriptionRequest(
        recording_session_id=recording_id,
        institution_id=institution_id,
        discipline="law",
        segments=[
            AudioSegmentRef(
                index=i,
                start_ms=i * FIVE_MIN,
                end_ms=(i + 1) * FIVE_MIN,
                storage_uri=f"gs://b/{i}.wav",
            )
            for i in range(n)
        ],
    )


def build_service(
    pool: AsyncConnectionPool, db_url: str, provider: FakeSpeechProvider | None = None
) -> tuple[TranscriptionService, PostgresJobRepository, InMemoryPublisher, PgTranscriptStore]:
    jobs = PostgresJobRepository(pool, PROCESSING_VERSION)
    store = PgTranscriptStore(db_url)
    publisher = InMemoryPublisher()
    service = TranscriptionService(
        provider=provider or FakeSpeechProvider(),
        store=store,
        publisher=publisher,
        audit=InMemoryAuditSink(),
        jobs=jobs,
        vocabulary=PostgresVocabularySource(
            pool,
            VocabularyCatalog.from_dict({"default": ["ementa"]}),
        ),
    )
    return service, jobs, publisher, store


async def test_job_lifecycle_persists(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    service, jobs, publisher, store = build_service(pool, db_url)
    rec = seed_recording(db_url, ids)
    job, created = await service.submit(request(rec, ids["institution_id"]))
    assert created and job.status is JobStatus.QUEUED

    done = await service.run(job.job_id)
    assert done.status is JobStatus.COMPLETED, done.failure_reason
    stored = await jobs.get(job.job_id)
    assert stored is not None
    assert stored.status is JobStatus.COMPLETED
    assert stored.transcript_id == done.transcript_id
    assert stored.segment_count == 3 * 75 and stored.mean_confidence == 0.9
    assert stored.request.institution_id == ids["institution_id"]
    assert store.calls[0]["institutionId"] == ids["institution_id"]
    assert publisher.events[0]["type"] == "transcription.completed"

    with psycopg.connect(db_url) as conn:
        row = conn.execute(
            "SELECT started_at IS NOT NULL, finished_at IS NOT NULL, processing_version "
            "FROM transcription_jobs WHERE id = %s",
            (job.job_id,),
        ).fetchone()
    assert row == (True, True, PROCESSING_VERSION)

    # Completed job is the active one: a resubmission returns it.
    again, created_again = await service.submit(request(rec, ids["institution_id"]))
    assert not created_again and again.job_id == job.job_id
    # Running a finished job is a no-op.
    assert (await service.run(job.job_id)).status is JobStatus.COMPLETED


async def test_partial_unique_index_allows_retry_after_failure(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    rec = seed_recording(db_url, ids)
    failing, *_ = build_service(pool, db_url, FakeSpeechProvider(permanent_failures={0}))
    job, _ = await failing.submit(request(rec, ids["institution_id"], 1))
    failed = await failing.run(job.job_id)
    assert failed.status is JobStatus.FAILED and failed.failure_reason

    service, jobs, *_ = build_service(pool, db_url)
    retry, created = await service.submit(request(rec, ids["institution_id"], 1))
    assert created and retry.job_id != job.job_id
    assert (await jobs.get(job.job_id)).status is JobStatus.FAILED  # type: ignore[union-attr]


async def test_concurrent_submissions_create_one_job(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    service, *_ = build_service(pool, db_url)
    rec = seed_recording(db_url, ids)
    results = await asyncio.gather(
        *(service.submit(request(rec, ids["institution_id"], 1)) for _ in range(5))
    )
    assert sum(created for _, created in results) == 1
    assert len({job.job_id for job, _ in results}) == 1


async def test_claim_is_exclusive(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    service, jobs, *_ = build_service(pool, db_url)
    rec = seed_recording(db_url, ids)
    job, _ = await service.submit(request(rec, ids["institution_id"], 1))
    claims = await asyncio.gather(*(jobs.claim(job.job_id) for _ in range(4)))
    assert sum(c is not None for c in claims) == 1
    assert await jobs.get("not-a-uuid") is None
    assert await jobs.get(str(uuid.uuid4())) is None


async def test_vocabulary_merges_platform_institution_and_discipline(
    pool: AsyncConnectionPool, db_url: str, ids: dict[str, str]
) -> None:
    inst = ids["institution_id"]
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO transcription_vocabularies (institution_id, discipline, phrases, boost)"
            " VALUES (NULL, NULL, ARRAY['plano de ensino'], 5),"
            " (NULL, 'law', ARRAY['jurisprudência'], 8),"
            " (%s, NULL, ARRAY['Vade Mecum', 'ementa'], 12),"
            " (%s, 'law', ARRAY['habeas corpus'], 15),"
            " (%s, 'medicine', ARRAY['anamnese'], 15)",
            (inst, inst, inst),
        )
    source = PostgresVocabularySource(
        pool,
        VocabularyCatalog.from_dict({"default": ["ementa"]}),
    )
    phrases, boosts = await source.phrases_for(inst, "law")
    assert phrases == ("ementa", "plano de ensino", "jurisprudência", "Vade Mecum", "habeas corpus")
    assert boosts["habeas corpus"] == 15 and boosts["plano de ensino"] == 5
    assert boosts["ementa"] == 12  # institution row overrides the catalog default boost
    platform_only, _ = await source.phrases_for(None, None)
    assert platform_only == ("ementa", "plano de ensino")

    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(db_url, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO transcription_vocabularies (institution_id, phrases)"
                " VALUES (%s, '{}')",
                (inst,),
            )


async def test_processed_events(pool: AsyncConnectionPool) -> None:
    events = PostgresProcessedEvents(pool)
    other = PostgresProcessedEvents(pool, consumer="speaker-diarization")
    eid = str(uuid.uuid4())
    assert not await events.is_processed(eid)
    await events.mark_processed(eid)
    await events.mark_processed(eid)  # idempotent
    assert await events.is_processed(eid)
    assert not await other.is_processed(eid)


def test_event_route_end_to_end_with_postgres(db_url: str, ids: dict[str, str]) -> None:
    """App with Postgres jobs + processed_events (pool opened by the app lifespan)."""
    from transcription.adapters.postgres import PoolLifecycle

    pool = make_pool(db_url, max_size=4)
    service, *_ = build_service(pool, db_url)
    deps = AppDeps(
        service=service,
        processed_events=PostgresProcessedEvents(pool),
        internal_token="tok",
        resources=[PoolLifecycle(pool)],
    )
    rec = seed_recording(db_url, ids)
    event = {
        "eventId": str(uuid.uuid4()),
        "type": "recording.segmented",
        "occurredAt": "2026-11-04T19:00:00Z",
        "source": "audio-processing",
        "institutionId": ids["institution_id"],
        "data": {
            "recordingSessionId": rec,
            "segments": [{"index": 0, "startMs": 0, "endMs": 60_000, "storageUri": "gs://b/0"}],
        },
    }
    headers = {"x-internal-token": "tok"}
    with TestClient(create_app(deps)) as client:
        first = client.post("/v1/events/recording-segmented", json=event, headers=headers)
        assert first.status_code == 200 and first.json()["status"] == "completed"
        dup = client.post("/v1/events/recording-segmented", json=event, headers=headers)
        assert dup.json() == {"duplicate": True, "eventId": event["eventId"]}
        status = client.get(f"/v1/transcriptions/{first.json()['jobId']}").json()
        assert status["status"] == "completed" and status["transcriptId"]
