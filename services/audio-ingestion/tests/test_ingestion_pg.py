"""The in-memory behavioural scenarios, re-run against PostgreSQL repositories.

Skipped unless ``TEST_DATABASE_URL`` is set (see ``tests/pg.py``).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import psycopg
import pytest

from audio_ingestion.adapters.memory import StaticDeviceKeyResolver
from audio_ingestion.ports import ConcurrentUpdateError, DeviceIdentity
from tests.conftest import CLASSROOM_ID, INSTITUTION_ID, Harness, build_harness
from tests.helpers import chunks, put_chunk, random_audio, recording_body, register, start_upload
from tests.pg import fresh_database, requires_pg

# Re-run the shared scenarios with the Postgres-backed ``harness`` fixture defined below.
from tests.test_integration_stage import (  # noqa: F401
    test_concurrent_identical_chunk_is_deduplicated_by_repository,
    test_firmware_recording_event_body_is_accepted,
    test_repeated_completion_republishes_same_event,
    test_retention_candidates_and_delete,
)
from tests.test_recordings import (  # noqa: F401
    test_classroom_must_match_assignment,
    test_device_id_must_match_signer,
    test_other_devices_cannot_read_recording,
    test_recording_lifecycle_events,
    test_register_is_idempotent_per_local_recording_id,
    test_register_recording_creates_session,
    test_same_local_id_with_different_content_conflicts,
    test_unassigned_device_cannot_register,
    test_validation_rules,
)
from tests.test_uploads import (  # noqa: F401
    test_chunk_resend_is_idempotent_and_conflict_detected,
    test_chunk_validation,
    test_full_chunked_upload_stores_encrypted_and_publishes,
    test_resume_returns_existing_upload_with_received_chunks,
    test_upload_must_match_recording_metadata,
    test_uploads_are_private_to_their_device,
    test_whole_file_checksum_mismatch_fails_upload,
)

pytestmark = requires_pg

CHUNK = 64 * 1024


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with fresh_database() as url:
        yield url


class SeedingResolver(StaticDeviceKeyResolver):
    """Registers each test device in ``capture_devices`` (FK target of recordings/uploads)."""

    def __init__(self, url: str) -> None:
        super().__init__()
        self._url = url
        self._classroom_taken = False

    def add(self, identity: DeviceIdentity) -> None:
        super().add(identity)
        # Only one active device per classroom is allowed; extra test devices stay unassigned
        # in the database (the resolver still reports the identity under test).
        classroom = None if self._classroom_taken else identity.classroom_id
        self._classroom_taken = self._classroom_taken or classroom is not None
        now = datetime.now(UTC)
        with psycopg.connect(self._url) as conn:
            conn.execute(
                """INSERT INTO capture_devices (id, classroom_id, serial_number, model,
                       firmware_version, institution_id, public_key_pem, public_key_fingerprint,
                       certificate, certificate_issued_at, certificate_expires_at)
                   VALUES (%s, %s, %s, 'ci-capture-a1', '1.0.0', %s, %s, %s, 'cert', %s, %s)""",
                (
                    identity.device_id,
                    classroom,
                    f"SN-{identity.device_id[:8]}",
                    INSTITUTION_ID,
                    identity.public_key_pem,
                    f"sha256:{identity.device_id}",
                    now,
                    now,
                ),
            )


def seed(url: str) -> None:
    holding = str(uuid.uuid4())
    campus = str(uuid.uuid4())
    with psycopg.connect(url) as conn:
        conn.execute("TRUNCATE holding_companies CASCADE")
        conn.execute(
            "INSERT INTO holding_companies (id, name, legal_name) VALUES (%s, 'Grupo', 'Grupo SA')",
            (holding,),
        )
        conn.execute(
            "INSERT INTO institutions (id, holding_company_id, name, state) "
            "VALUES (%s, %s, 'U', 'SP')",
            (INSTITUTION_ID, holding),
        )
        conn.execute(
            "INSERT INTO campuses (id, institution_id, name, city, state) "
            "VALUES (%s, %s, 'C', 'SP', 'SP')",
            (campus, INSTITUTION_ID),
        )
        conn.execute(
            "INSERT INTO classrooms (id, campus_id, name, code) VALUES (%s, %s, 'Sala 101', '101')",
            (CLASSROOM_ID, campus),
        )


@pytest.fixture
def harness(tmp_path: Path, database_url: str) -> Iterator[Harness]:
    from audio_ingestion.adapters.postgres import (
        PostgresRecordingRepository,
        PostgresUploadRepository,
        create_pool,
    )

    seed(database_url)
    pool = create_pool(database_url, max_size=4)
    try:
        yield build_harness(
            tmp_path,
            recordings=PostgresRecordingRepository(pool),
            uploads=PostgresUploadRepository(pool),
            resolver=SeedingResolver(database_url),
        )
    finally:
        pool.close()


# ----------------------------------------------------------------- Postgres-only invariants
def test_rows_are_persisted(harness: Harness, database_url: str) -> None:
    audio = random_audio(CHUNK + 5)
    recording_id = register(harness, audio)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    for index, data in enumerate(chunks(audio, CHUNK)):
        assert put_chunk(harness.signed, upload_id, index, data) == 204
    assert harness.signed.post(f"/v1/uploads/{upload_id}/complete").status_code == 200
    with psycopg.connect(database_url) as conn:
        row = conn.execute(
            "SELECT upload_status::text, storage_path, duration_ms, capture_status::text "
            "FROM recording_sessions WHERE id = %s",
            (recording_id,),
        ).fetchone()
        assert row is not None
        assert row[0] == "complete" and row[1].startswith("local://recordings/")
        assert row[2] == 90 * 60 * 1000 and row[3] == "complete"
        status = conn.execute(
            "SELECT status::text, completed_at IS NOT NULL FROM upload_sessions WHERE id = %s",
            (upload_id,),
        ).fetchone()
        assert status == ("complete", True)
        count = conn.execute(
            "SELECT count(*) FROM upload_chunks WHERE upload_session_id = %s", (upload_id,)
        ).fetchone()
        assert count == (2,)


def test_second_open_upload_is_rejected_by_index(harness: Harness) -> None:
    audio = random_audio(CHUNK)
    recording_id = register(harness, audio)
    first = harness.deps.uploads.find_open_for_recording(recording_id)
    assert first is None
    upload = start_upload(harness.signed, recording_id, audio, CHUNK)
    existing = harness.deps.uploads.get(upload["uploadId"])
    assert existing is not None
    clone = existing.model_copy(update={"upload_id": str(uuid.uuid4())})
    with pytest.raises(ConcurrentUpdateError):
        harness.deps.uploads.add(clone)


def test_lost_completion_race_returns_winner(harness: Harness) -> None:
    audio = random_audio(CHUNK)
    recording_id = register(harness, audio)
    upload_id = start_upload(harness.signed, recording_id, audio, CHUNK)["uploadId"]
    assert put_chunk(harness.signed, upload_id, 0, audio) == 204
    upload = harness.deps.uploads.get(upload_id)
    recording = harness.deps.recordings.get(recording_id)
    assert upload is not None and recording is not None
    # Another instance finalizes first.
    upload.status = "complete"
    upload.completed_at = datetime.now(UTC)
    recording.storage_uri = "local://elsewhere.wav"
    assert harness.deps.uploads.finalize(upload, recording) is True
    assert harness.deps.uploads.finalize(upload, recording) is False
    response = harness.signed.post(f"/v1/uploads/{upload_id}/complete")
    assert response.status_code == 200
    assert response.json()["status"] == "complete"


def test_unknown_scheduled_class_is_rejected(harness: Harness) -> None:
    audio = random_audio(100)
    body = recording_body(harness, audio, scheduledClassId=str(uuid.uuid4()))
    response = harness.signed.post("/v1/recordings", json_body=body)
    assert response.status_code == 422
    assert response.json()["error"] == "unknown_reference"
