"""The pipeline scenarios re-run against the PostgreSQL repository.

Skipped unless ``TEST_DATABASE_URL`` is set (see ``tests/pg.py``).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import psycopg
import pytest

from audio_processing.adapters.memory import InMemoryObjectStore
from audio_processing.adapters.postgres import PostgresProcessingRepository, create_pool
from audio_processing.quality import QualityReport
from audio_processing.results import PipelineResult
from tests.pg import fresh_database, requires_pg

# Re-run the shared scenarios with the Postgres-backed ``harness`` fixture defined below.
from tests.test_integration_stage import (  # noqa: F401
    test_emitted_event_ids_derive_from_consumed_event,
    test_event_id_must_be_uuid,
)
from tests.test_pipeline import (  # noqa: F401
    INSTITUTION,
    Harness,
    lecture,
    make_harness,
    test_checksum_mismatch_rejected,
    test_invalid_events_rejected,
    test_recording_uploaded_is_assessed_segmented_and_published,
    test_unusable_audio_stops_pipeline,
    upload_recording,
    uploaded_event,
)

pytestmark = requires_pg

DEVICE = str(uuid.uuid4())
CLASSROOM = str(uuid.uuid4())


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with fresh_database() as url:
        yield url


def seed(url: str) -> None:
    holding, campus, now = str(uuid.uuid4()), str(uuid.uuid4()), datetime.now(UTC)
    with psycopg.connect(url) as conn:
        conn.execute("TRUNCATE holding_companies, processed_events CASCADE")
        conn.execute(
            "INSERT INTO holding_companies (id, name, legal_name) VALUES (%s, 'G', 'G SA')",
            (holding,),
        )
        conn.execute(
            "INSERT INTO institutions (id, holding_company_id, name, state) "
            "VALUES (%s, %s, 'U', 'SP')",
            (INSTITUTION, holding),
        )
        conn.execute(
            "INSERT INTO campuses (id, institution_id, name, city, state) "
            "VALUES (%s, %s, 'C', 'SP', 'SP')",
            (campus, INSTITUTION),
        )
        conn.execute(
            "INSERT INTO classrooms (id, campus_id, name, code) VALUES (%s, %s, 'S', '1')",
            (CLASSROOM, campus),
        )
        conn.execute(
            """INSERT INTO capture_devices (id, classroom_id, serial_number, model,
                   firmware_version, institution_id, public_key_pem, public_key_fingerprint,
                   certificate, certificate_issued_at, certificate_expires_at)
               VALUES (%s, %s, 'SN-1', 'm', '1', %s, 'pem', 'fp', 'c', %s, %s)""",
            (DEVICE, CLASSROOM, INSTITUTION, now, now),
        )


class SeedingRepository(PostgresProcessingRepository):
    """Creates the ``recording_sessions`` row (owned by audio-ingestion) the result refers to."""

    def __init__(self, url: str, pool: object) -> None:
        super().__init__(pool)  # type: ignore[arg-type]
        self._url = url

    def save(self, event_id: str, result: PipelineResult) -> bool:
        with psycopg.connect(self._url) as conn:
            conn.execute(
                """INSERT INTO recording_sessions (id, device_id, classroom_id, institution_id,
                       started_at, audio_format, sample_rate, channels)
                   VALUES (%s, %s, %s, %s, now(), 'wav_pcm_s16le', 16000, 1)
                   ON CONFLICT (id) DO NOTHING""",
                (result.recording_session_id, DEVICE, CLASSROOM, INSTITUTION),
            )
        return super().save(event_id, result)


@pytest.fixture
def harness(tmp_path: Path, database_url: str) -> Iterator[Harness]:
    seed(database_url)
    pool = create_pool(database_url, max_size=4)
    try:
        yield make_harness(
            tmp_path, InMemoryObjectStore(), repository=SeedingRepository(database_url, pool)
        )
    finally:
        pool.close()


def test_results_are_persisted(harness: Harness, tmp_path: Path, database_url: str) -> None:
    path = lecture(tmp_path, 7)
    recording_id = str(uuid.uuid4())
    uri = upload_recording(harness.store, path, recording_id)
    event = uploaded_event(path, uri, recording_id)
    assert harness.client.post("/v1/events/recording-uploaded", json=event).status_code == 200
    with psycopg.connect(database_url) as conn:
        assert conn.execute(
            "SELECT consumer FROM processed_events WHERE event_id = %s", (event["eventId"],)
        ).fetchall() == [("audio-processing",)]
        report = conn.execute(
            "SELECT verdict::text, score FROM audio_quality_reports "
            "WHERE recording_session_id = %s",
            (recording_id,),
        ).fetchall()
        assert len(report) == 1 and report[0][0] == "good"
        segments = conn.execute(
            "SELECT segment_index, storage_path, file_size_bytes, upload_status::text "
            "FROM audio_segments WHERE recording_session_id = %s ORDER BY segment_index",
            (recording_id,),
        ).fetchall()
        assert [s[0] for s in segments] == [0, 1]
        assert all(s[1].startswith("mem://recordings/") and s[2] > 0 for s in segments)
        assert {s[3] for s in segments} == {"complete"}
        score = conn.execute(
            "SELECT audio_quality_score FROM recording_sessions WHERE id = %s", (recording_id,)
        ).fetchone()
        assert score is not None and float(score[0]) == float(report[0][1])


def test_concurrent_delivery_stores_one_result(harness: Harness, database_url: str) -> None:
    pool = create_pool(database_url, max_size=2)
    try:
        repo = SeedingRepository(database_url, pool)
        report = QualityReport(
            duration_ms=1000,
            sample_rate=16000,
            channels=1,
            rms_dbfs=-120,
            peak_dbfs=-120,
            noise_floor_dbfs=-120,
            snr_db=0,
            clipping_ratio=0,
            silence_ratio=1,
            longest_silence_ms=1000,
            score=0,
            verdict="unusable",
            issues=["excessive_silence"],
        )
        result = PipelineResult(
            recording_session_id=str(uuid.uuid4()), status="stopped_unusable", report=report
        )
        event_id = str(uuid.uuid4())
        assert repo.save(event_id, result) is True
        assert repo.save(event_id, result) is False
        assert repo.is_processed(event_id)
        loaded = repo.load_result(result.recording_session_id)
        assert loaded is not None and loaded.status == "stopped_unusable"
        assert loaded.report is not None and loaded.report.issues == ["excessive_silence"]
    finally:
        pool.close()


def test_unknown_recording_is_rejected(database_url: str, tmp_path: Path) -> None:
    seed(database_url)
    pool = create_pool(database_url, max_size=2)
    try:
        harness = make_harness(
            tmp_path, InMemoryObjectStore(), repository=PostgresProcessingRepository(pool)
        )
        path = lecture(tmp_path, 1)
        recording_id = str(uuid.uuid4())
        uri = upload_recording(harness.store, path, recording_id)
        event = uploaded_event(path, uri, recording_id)
        response = harness.client.post("/v1/events/recording-uploaded", json=event)
        assert response.status_code == 422
        assert response.json()["error"] == "unknown_recording"
        assert not PostgresProcessingRepository(pool).is_processed(event["eventId"])
    finally:
        pool.close()
