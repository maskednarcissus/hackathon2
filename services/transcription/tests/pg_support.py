"""Throw-away PostgreSQL databases for integration tests (integration-stage §1).

Tests using this are skipped unless ``TEST_DATABASE_URL`` (admin URL of an empty server)
is set. Each test module gets a fresh ``ci_test_<random>`` database with every
``data/migrations/V*.sql`` applied in order, followed by ``data/migrations/pending/*.sql``
(this service's own file must apply; failures in other services' pending files are
reported as warnings so one unfinished file does not mask this service's results).
"""

from __future__ import annotations

import os
import uuid
import warnings
from collections.abc import Iterator
from pathlib import Path

import psycopg
from psycopg import conninfo

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
MIGRATIONS = Path(__file__).resolve().parents[3] / "data" / "migrations"


def _with_dbname(url: str, dbname: str) -> str:
    params = conninfo.conninfo_to_dict(url)
    params["dbname"] = dbname
    return conninfo.make_conninfo(**{k: v for k, v in params.items() if v is not None})


def apply_migrations(url: str, own_pending: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        for path in sorted(MIGRATIONS.glob("V*.sql")):
            conn.execute(path.read_text(encoding="utf-8").encode())
        for path in sorted((MIGRATIONS / "pending").glob("*.sql")):
            sql = path.read_text(encoding="utf-8").encode()
            if path.stem == own_pending or path.stem.startswith(f"{own_pending}-"):
                conn.execute(sql)
                continue
            try:
                conn.execute(sql)
            except psycopg.Error as exc:  # pragma: no cover - depends on other services
                warnings.warn(f"pending migration {path.name} failed: {exc}", stacklevel=1)


def fresh_database(own_pending: str) -> Iterator[str]:
    """Generator for a module-scoped fixture: yields the URL of a migrated database."""
    assert TEST_DATABASE_URL
    name = f"ci_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"'.encode())
    url = _with_dbname(TEST_DATABASE_URL, name)
    try:
        apply_migrations(url, own_pending)
        yield url
    finally:
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'.encode())


SEED_SQL = """
WITH hc AS (
    INSERT INTO holding_companies (name, legal_name) VALUES ('Grupo Teste', 'Grupo Teste SA')
    RETURNING id
), inst AS (
    INSERT INTO institutions (holding_company_id, name, state)
    SELECT id, 'Faculdade Teste', 'SP' FROM hc RETURNING id
), camp AS (
    INSERT INTO campuses (institution_id, name, city, state)
    SELECT id, 'Campus Centro', 'São Paulo', 'SP' FROM inst RETURNING id
), room AS (
    INSERT INTO classrooms (campus_id, name, code)
    SELECT id, 'Sala 101', 'S101' FROM camp RETURNING id
), dev AS (
    INSERT INTO capture_devices
        (institution_id, serial_number, model, firmware_version, public_key_pem,
         public_key_fingerprint, certificate, certificate_issued_at, certificate_expires_at)
    SELECT id, 'CI-T-' || md5(random()::text), 'ci-capture-a1', '1.0.0', 'test-key',
           'sha256:' || md5(random()::text), 'test-cert', NOW(), NOW() + interval '365 days'
    FROM inst
    RETURNING id
), pol AS (
    INSERT INTO recording_policies (institution_id, name, legal_basis)
    SELECT id, 'Padrão', 'legitimate_interest' FROM inst RETURNING id
)
SELECT inst.id::text AS institution_id, room.id::text AS classroom_id,
       dev.id::text AS device_id, pol.id::text AS policy_id
FROM inst, room, dev, pol
"""


def seed_institution(url: str) -> dict[str, str]:
    with psycopg.connect(url, autocommit=True) as conn:
        row = conn.execute(SEED_SQL.encode()).fetchone()
    assert row is not None
    return {
        "institution_id": row[0],
        "classroom_id": row[1],
        "device_id": row[2],
        "policy_id": row[3],
    }


def seed_recording(url: str, ids: dict[str, str]) -> str:
    with psycopg.connect(url, autocommit=True) as conn:
        row = conn.execute(
            """
            INSERT INTO recording_sessions
                (device_id, classroom_id, recording_policy_id, started_at, audio_format,
                 sample_rate, channels)
            VALUES (%s, %s, %s, NOW(), 'wav_pcm_s16le', 16000, 1)
            RETURNING id::text
            """,
            (ids["device_id"], ids["classroom_id"], ids["policy_id"]),
        ).fetchone()
    assert row is not None
    return str(row[0])


def seed_transcript(url: str, recording_session_id: str, version: str = "seed-1") -> str:
    with psycopg.connect(url, autocommit=True) as conn:
        row = conn.execute(
            """
            INSERT INTO transcripts (recording_session_id, processing_version)
            VALUES (%s, %s) RETURNING id::text
            """,
            (recording_session_id, version),
        ).fetchone()
    assert row is not None
    return str(row[0])
