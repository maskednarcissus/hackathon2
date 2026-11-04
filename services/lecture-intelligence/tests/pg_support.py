"""Fresh-database helpers for Postgres integration tests (skipped without TEST_DATABASE_URL)."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg import conninfo

MIGRATIONS = Path(__file__).resolve().parents[3] / "data" / "migrations"
ADMIN_URL = os.environ.get("TEST_DATABASE_URL")


@contextmanager
def fresh_database(pending: list[str]) -> Iterator[str]:
    """Create ``ci_test_<random>``, apply V*.sql + given pending files, yield the URL, drop it."""

    assert ADMIN_URL, "TEST_DATABASE_URL is required"
    name = f"ci_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    url = conninfo.make_conninfo(ADMIN_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            files = sorted(MIGRATIONS.glob("V*.sql")) + [
                MIGRATIONS / "pending" / p for p in pending
            ]
            for file in files:
                conn.execute(file.read_text(encoding="utf-8").encode("utf-8"))
        yield url
    finally:
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def seed_academic(url: str, ids: dict[str, str]) -> None:
    """Insert the FK chain lecture summaries and assistant rows depend on.

    ``ids`` keys: institution, section, course, scheduled_class, scheduled_class_2, transcript,
    student, student_2.
    """

    holding, campus, classroom, program, term, professor = (str(uuid.uuid4()) for _ in range(6))
    device, policy, session = (str(uuid.uuid4()) for _ in range(3))
    with psycopg.connect(url, autocommit=True) as conn:
        run = conn.execute
        run(
            "INSERT INTO holding_companies (id, name, legal_name) VALUES (%s, 'G', 'G SA')",
            (holding,),
        )
        run(
            "INSERT INTO institutions (id, holding_company_id, name, state) "
            "VALUES (%s, %s, 'F', 'SP')",
            (ids["institution"], holding),
        )
        run(
            "INSERT INTO campuses (id, institution_id, name, city, state) "
            "VALUES (%s, %s, 'Centro', 'São Paulo', 'SP')",
            (campus, ids["institution"]),
        )
        run(
            "INSERT INTO classrooms (id, campus_id, name, code) VALUES (%s, %s, 'Sala 1', 'S1')",
            (classroom, campus),
        )
        run(
            "INSERT INTO academic_programs (id, institution_id, name, code) "
            "VALUES (%s, %s, 'Economia', 'ECO')",
            (program, ids["institution"]),
        )
        run(
            "INSERT INTO academic_terms (id, institution_id, name, start_date, end_date) "
            "VALUES (%s, %s, '2026.2', '2026-08-01', '2026-12-20')",
            (term, ids["institution"]),
        )
        run(
            "INSERT INTO courses (id, institution_id, academic_program_id, academic_term_id, code, "
            "name, discipline) VALUES (%s, %s, %s, %s, 'MAC', 'Macroeconomia', 'economia')",
            (ids["course"], ids["institution"], program, term),
        )
        run(
            "INSERT INTO professors (id, institution_id, name, email) "
            "VALUES (%s, %s, 'Prof', 'prof@x.br')",
            (professor, ids["institution"]),
        )
        run(
            "INSERT INTO class_sections (id, course_id, professor_id, section_code) "
            "VALUES (%s, %s, %s, 'A')",
            (ids["section"], ids["course"], professor),
        )
        for key, day in (("scheduled_class", "2026-11-04"), ("scheduled_class_2", "2026-11-11")):
            run(
                "INSERT INTO scheduled_classes (id, class_section_id, classroom_id, starts_at, "
                "ends_at) VALUES (%s, %s, %s, %s, %s)",
                (ids[key], ids["section"], classroom, f"{day}T22:00:00Z", f"{day}T23:30:00Z"),
            )
        for key, email in (("student", "a@x.br"), ("student_2", "b@x.br")):
            run(
                "INSERT INTO students (id, institution_id, name, email) "
                "VALUES (%s, %s, 'Aluno', %s)",
                (ids[key], ids["institution"], email),
            )
        run(
            "INSERT INTO capture_devices (id, institution_id, classroom_id, serial_number, model, "
            "firmware_version, public_key_pem, public_key_fingerprint, certificate, "
            "certificate_issued_at, certificate_expires_at) VALUES (%s, %s, %s, 'SN1', 'a1', "
            "'1.0', 'pem', 'sha256:x', 'cert', NOW(), NOW() + interval '1 year')",
            (device, ids["institution"], classroom),
        )
        run(
            "INSERT INTO recording_policies (id, institution_id, name, legal_basis) "
            "VALUES (%s, %s, 'Padrão', 'legitimate_interest')",
            (policy, ids["institution"]),
        )
        run(
            "INSERT INTO recording_sessions (id, device_id, classroom_id, scheduled_class_id, "
            "recording_policy_id, started_at, audio_format, sample_rate, channels) "
            "VALUES (%s, %s, %s, %s, %s, NOW(), 'wav', 16000, 1)",
            (session, device, classroom, ids["scheduled_class"], policy),
        )
        run(
            "INSERT INTO transcripts (id, recording_session_id, scheduled_class_id, "
            "processing_version) VALUES (%s, %s, %s, 'test')",
            (ids["transcript"], session, ids["scheduled_class"]),
        )
