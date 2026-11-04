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


def seed_institution(url: str, institution_id: str) -> None:
    holding = str(uuid.uuid4())
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO holding_companies (id, name, legal_name) VALUES (%s, 'Grupo', 'Grupo SA')",
            (holding,),
        )
        conn.execute(
            "INSERT INTO institutions (id, holding_company_id, name, state) "
            "VALUES (%s, %s, 'Faculdade', 'SP')",
            (institution_id, holding),
        )
