"""Fresh-database helper for Postgres integration tests (integration stage §1).

``TEST_DATABASE_URL`` is the admin URL of an empty server. Each test module creates
``ci_test_<random>``, applies ``data/migrations/V*.sql`` then ``pending/*.sql`` in order,
and drops the database afterwards.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo, sql

MIGRATIONS = Path(__file__).resolve().parents[3] / "data" / "migrations"
ADMIN_URL = os.environ.get("TEST_DATABASE_URL")

requires_pg = pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set")


def migration_files() -> list[Path]:
    versioned = sorted(MIGRATIONS.glob("V*.sql"))
    pending = sorted((MIGRATIONS / "pending").glob("*.sql"))
    return versioned + pending


@contextmanager
def fresh_database() -> Iterator[str]:
    assert ADMIN_URL
    name = f"ci_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = conninfo.make_conninfo(ADMIN_URL, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            for path in migration_files():
                conn.execute(path.read_text(encoding="utf-8").encode())
        yield url
    finally:
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )
