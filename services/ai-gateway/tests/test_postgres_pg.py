"""Postgres integration tests — same scenarios as the in-memory tests, against real tables."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
import pytest
from conftest import EVENT_SCHEMA, INSTITUTION
from fastapi.testclient import TestClient
from pg_support import ADMIN_URL, fresh_database, seed_institution

from ai_gateway.adapters.postgres import (
    PostgresBudgetRepository,
    PostgresCallRepository,
    create_pool,
    sync_prompt_versions,
)
from ai_gateway.app import DEFAULT_PROMPTS_DIR, GatewayDeps, create_app
from ai_gateway.audit import InMemoryAuditClient
from ai_gateway.pricing import PricingTable
from ai_gateway.prompts import PromptRegistry
from ai_gateway.providers.fake import FakeProvider
from ai_gateway.records import CallRecord
from ai_gateway.service import GatewaySettings

pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set")

VALID = {"events": [{"type": "examination", "quote": "segunda prova", "segmentIndex": 0}]}


@pytest.fixture(scope="module")
def database() -> Iterator[str]:
    with fresh_database(["ai-gateway.sql"]) as url:
        seed_institution(url, INSTITUTION)
        yield url


@pytest.fixture()
def clean(database: str) -> str:
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute("TRUNCATE ai_calls, ai_budgets, ai_prompt_versions")
    return database


def _app(url: str, provider: Any, token: str | None = None) -> TestClient:
    pool = create_pool(url, max_size=4)
    deps = GatewayDeps(
        registry=PromptRegistry(DEFAULT_PROMPTS_DIR),
        provider=provider,
        calls=PostgresCallRepository(pool),
        budgets=PostgresBudgetRepository(pool),
        pricing=PricingTable(),
        audit=InMemoryAuditClient(),
        settings=GatewaySettings(provider_timeout_s=5),
        pool=pool,
        internal_token=token,
    )
    return TestClient(create_app(deps))


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "task": "event_extraction",
        "promptId": "event-extraction",
        "variables": {"courseName": "Economia", "classDate": "2026-11-04"},
        "untrustedInputs": {"transcript": "[s0 00:00:01] Nossa segunda prova será dia 20."},
        "responseSchema": EVENT_SCHEMA,
        "institutionId": INSTITUTION,
        "requestedBy": "event-extraction",
    }
    body.update(overrides)
    return body


def test_generate_persists_call_record_and_usage(clean: str) -> None:
    provider = FakeProvider(model_override=None)
    provider.script("event-extraction", VALID)
    with _app(clean, provider) as client:
        response = client.post("/v1/generate", json=_body())
        assert response.status_code == 200, response.text
        request_id = response.json()["requestId"]
        record = client.get(f"/v1/calls/{request_id}").json()
        assert record["outcome"] == "valid"
        assert record["usage"]["costUsd"] == response.json()["usage"]["costUsd"] > 0
        assert "segunda prova" not in str(record)
        usage = client.get("/v1/usage", params={"institutionId": INSTITUTION}).json()
        assert usage["totals"]["calls"] == 1
        assert client.get(f"/v1/calls/{uuid.uuid4()}").status_code == 404
        assert client.get("/v1/calls/not-a-uuid").status_code == 404
    with psycopg.connect(clean) as conn:
        row = conn.execute(
            "SELECT outcome, untrusted_input_chars, prompt_sha256 FROM ai_calls"
        ).fetchone()
    assert row is not None and row[0] == "valid" and "transcript" in row[1]


def test_unknown_institution_is_still_accounted(clean: str) -> None:
    provider = FakeProvider()
    with _app(clean, provider) as client:
        other = str(uuid.uuid4())
        assert client.post("/v1/generate", json=_body(institutionId=other)).status_code == 200
        assert client.put(f"/v1/budgets/{other}", json={"monthlyUsd": 5}).status_code == 404


def test_budget_is_enforced_and_persisted(clean: str) -> None:
    provider = FakeProvider(model_override=None)
    provider.script("event-extraction", VALID)
    with _app(clean, provider) as client:
        assert client.put(f"/v1/budgets/{INSTITUTION}", json={"monthlyUsd": 0.000001}).json()[
            "monthlyUsd"
        ] == pytest.approx(0.0, abs=0.01)
        # NUMERIC(12,2) rounds the budget to 0.00 → every call is blocked.
        blocked = client.post("/v1/generate", json=_body())
        assert blocked.status_code == 429
        client.put(f"/v1/budgets/{INSTITUTION}", json={"monthlyUsd": 1.0})
        assert client.post("/v1/generate", json=_body()).status_code == 200
        budget = client.get(f"/v1/budgets/{INSTITUTION}").json()
        assert budget["monthlyUsd"] == 1.0 and budget["monthToDateUsd"] > 0
        client.put(f"/v1/budgets/{INSTITUTION}", json={"monthlyUsd": None})
        assert client.get(f"/v1/budgets/{INSTITUTION}").json()["monthlyUsd"] is None
    with psycopg.connect(clean) as conn:
        outcomes = [r[0] for r in conn.execute("SELECT outcome FROM ai_calls ORDER BY created_at")]
    assert "budget_exceeded" in outcomes and "valid" in outcomes


def test_concurrent_reservations_cannot_overspend(clean: str) -> None:
    pool = create_pool(clean, max_size=6)
    calls = PostgresCallRepository(pool)
    month = datetime(2026, 11, 1, tzinfo=UTC)

    def record(cost: float) -> CallRecord:
        return CallRecord(
            request_id=str(uuid.uuid4()),
            created_at=datetime(2026, 11, 4, tzinfo=UTC),
            institution_id=INSTITUTION,
            requested_by="test",
            task="event_extraction",
            prompt_id="p",
            prompt_version="v",
            prompt_sha256="",
            variables_sha256="0" * 64,
            untrusted_input_chars={},
            provider="fake",
            model="m",
            cost_usd=cost,
        )

    async def scenario() -> list[bool]:
        await pool.open(wait=True)
        try:
            results = await asyncio.gather(
                *(calls.reserve(record(0.4), 1.0, month) for _ in range(6))
            )
            return [allowed for allowed, _ in results]
        finally:
            await pool.close()

    allowed = asyncio.run(scenario())
    # Spend before each reservation: 0, 0.4, 0.8 → allowed; 1.2 → blocked.
    assert allowed.count(True) == 3


def test_prompt_registry_sync_and_drift_detection(clean: str, tmp_path: Path) -> None:
    async def run(registry: PromptRegistry, allow: bool = False) -> dict[str, Any]:
        pool = create_pool(clean, max_size=2)
        await pool.open(wait=True)
        try:
            return await sync_prompt_versions(pool, registry, allow_drift=allow)
        finally:
            await pool.close()

    first = asyncio.run(run(PromptRegistry(DEFAULT_PROMPTS_DIR)))
    assert "event-extraction@2026-11-04.1" in first["inserted"]
    assert asyncio.run(run(PromptRegistry(DEFAULT_PROMPTS_DIR)))["inserted"] == []
    with psycopg.connect(clean) as conn:
        active = conn.execute(
            "SELECT prompt_id, version FROM ai_prompt_versions WHERE is_active ORDER BY 1"
        ).fetchall()
    assert ("assistant-answer", "2026-11-04.1") in active

    folder = tmp_path / "event-extraction"
    folder.mkdir()
    original = (DEFAULT_PROMPTS_DIR / "event-extraction" / "2026-11-04.1.yaml").read_text()
    (folder / "2026-11-04.1.yaml").write_text(original + "\n# edited after publication\n")
    with pytest.raises(RuntimeError, match="changed on disk"):
        asyncio.run(run(PromptRegistry(tmp_path)))
    assert asyncio.run(run(PromptRegistry(tmp_path), allow=True))["drifted"] == [
        "event-extraction@2026-11-04.1"
    ]


def test_internal_token_required_when_configured(clean: str) -> None:
    with _app(clean, FakeProvider(), token="s3cret") as client:
        assert client.get("/health").status_code == 200
        assert client.post("/v1/generate", json=_body()).status_code == 401
        bad = client.post("/v1/generate", json=_body(), headers={"x-internal-token": "nope"})
        assert bad.status_code == 401
        ok = client.post("/v1/generate", json=_body(), headers={"x-internal-token": "s3cret"})
        assert ok.status_code == 200
