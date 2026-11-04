"""PostgreSQL adapters (psycopg 3 async pool) for call records, budgets and the prompt registry.

Tables: ``ai_calls``, ``ai_budgets``, ``ai_prompt_versions`` (V003). No DDL is run here.
"""

from __future__ import annotations

import os
from datetime import datetime
from decimal import Decimal
from typing import Any

import structlog
from psycopg import errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ai_gateway.errors import GatewayError
from ai_gateway.prompts import PromptRegistry
from ai_gateway.records import CallRecord

log = structlog.get_logger(__name__)

_COLUMNS = (
    "request_id, institution_id, requested_by, task, prompt_id, prompt_version, prompt_sha256, "
    "variables_sha256, untrusted_input_chars, provider, model, input_tokens, output_tokens, "
    "cost_usd, latency_ms, attempts, outcome, validation_errors, injection_suspected, "
    "injection_signals, created_at"
)


def create_pool(conninfo: str, *, min_size: int = 1, max_size: int = 10) -> AsyncConnectionPool:
    return AsyncConnectionPool(
        conninfo,
        open=False,
        min_size=min_size,
        max_size=max_size,
        kwargs={"autocommit": True},
    )


def _params(r: CallRecord) -> tuple[Any, ...]:
    return (
        r.request_id,
        r.institution_id,
        r.requested_by,
        r.task,
        r.prompt_id,
        r.prompt_version,
        r.prompt_sha256 or None,
        r.variables_sha256,
        Jsonb(r.untrusted_input_chars),
        r.provider,
        r.model,
        r.input_tokens,
        r.output_tokens,
        r.cost_usd,
        r.latency_ms,
        r.attempts,
        r.outcome,
        Jsonb(r.validation_errors),
        r.injection_suspected,
        r.injection_signals,
        r.created_at,
    )


_INSERT = f"""
INSERT INTO ai_calls ({_COLUMNS})
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (request_id) DO UPDATE SET
    model = EXCLUDED.model, input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens, cost_usd = EXCLUDED.cost_usd,
    latency_ms = EXCLUDED.latency_ms, attempts = EXCLUDED.attempts, outcome = EXCLUDED.outcome,
    validation_errors = EXCLUDED.validation_errors
"""


def _record(row: dict[str, Any]) -> CallRecord:
    def num(value: Any) -> float:
        return float(value) if isinstance(value, Decimal | int | float) else 0.0

    return CallRecord(
        request_id=str(row["request_id"]),
        created_at=row["created_at"],
        institution_id=str(row["institution_id"]) if row["institution_id"] else "",
        requested_by=row["requested_by"],
        task=row["task"],
        prompt_id=row["prompt_id"] or "",
        prompt_version=row["prompt_version"] or "",
        prompt_sha256=(row["prompt_sha256"] or "").strip(),
        variables_sha256=(row["variables_sha256"] or "").strip(),
        untrusted_input_chars=dict(row["untrusted_input_chars"] or {}),
        provider=row["provider"],
        model=row["model"],
        input_tokens=row["input_tokens"],
        output_tokens=row["output_tokens"],
        cost_usd=num(row["cost_usd"]),
        latency_ms=row["latency_ms"] or 0,
        attempts=row["attempts"],
        outcome=row["outcome"],
        validation_errors=list(row["validation_errors"] or []),
        injection_suspected=row["injection_suspected"],
        injection_signals=list(row["injection_signals"] or []),
    )


class PostgresCallRepository:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def reserve(
        self, record: CallRecord, budget_usd: float | None, month_start: datetime
    ) -> tuple[bool, float]:
        async with self._pool.connection() as conn, conn.transaction():
            # Serialise budget checks per institution; reservations of in-flight calls are
            # already in ai_calls.cost_usd, so concurrent calls cannot overspend.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 7))", (record.institution_id,)
            )
            cur = await conn.execute(
                "SELECT COALESCE(SUM(cost_usd), 0) FROM ai_calls "
                "WHERE institution_id = %s AND created_at >= %s",
                (record.institution_id, month_start),
            )
            row = await cur.fetchone()
            spent = float(row[0]) if row else 0.0
            allowed = budget_usd is None or spent < budget_usd
            if not allowed:
                record.outcome = "budget_exceeded"
                record.cost_usd = 0.0
            await conn.execute(_INSERT, _params(record))
        return allowed, round(spent, 8)

    async def save(self, record: CallRecord) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(_INSERT, _params(record))

    async def get(self, request_id: str) -> CallRecord | None:
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            try:
                await cur.execute(
                    f"SELECT {_COLUMNS} FROM ai_calls WHERE request_id = %s", (request_id,)
                )
            except errors.InvalidTextRepresentation:
                return None
            row = await cur.fetchone()
        return _record(row) if row else None

    async def query(
        self,
        institution_id: str | None,
        start: datetime | None,
        end: datetime | None,
    ) -> list[CallRecord]:
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                f"SELECT {_COLUMNS} FROM ai_calls "
                "WHERE (%(inst)s::uuid IS NULL OR institution_id = %(inst)s::uuid) "
                "AND (%(start)s::timestamptz IS NULL OR created_at >= %(start)s) "
                "AND (%(end)s::timestamptz IS NULL OR created_at < %(end)s) "
                "ORDER BY created_at",
                {"inst": institution_id, "start": start, "end": end},
            )
            rows = await cur.fetchall()
        return [_record(r) for r in rows]

    async def month_spend(self, institution_id: str, month_start: datetime) -> float:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT COALESCE(SUM(cost_usd), 0) FROM ai_calls "
                "WHERE institution_id = %s AND created_at >= %s",
                (institution_id, month_start),
            )
            row = await cur.fetchone()
        return round(float(row[0]), 8) if row else 0.0


class PostgresBudgetRepository:
    def __init__(self, pool: AsyncConnectionPool, default_monthly_usd: float | None = None) -> None:
        self._pool = pool
        self._default = default_monthly_usd

    async def get(self, institution_id: str) -> float | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT monthly_usd FROM ai_budgets WHERE institution_id = %s", (institution_id,)
            )
            row = await cur.fetchone()
        return float(row[0]) if row else self._default

    async def set(self, institution_id: str, monthly_usd: float | None) -> None:
        async with self._pool.connection() as conn:
            if monthly_usd is None:
                await conn.execute(
                    "DELETE FROM ai_budgets WHERE institution_id = %s", (institution_id,)
                )
                return
            try:
                await conn.execute(
                    "INSERT INTO ai_budgets (institution_id, monthly_usd, updated_at) "
                    "VALUES (%s, %s, NOW()) ON CONFLICT (institution_id) DO UPDATE "
                    "SET monthly_usd = EXCLUDED.monthly_usd, updated_at = NOW()",
                    (institution_id, monthly_usd),
                )
            except errors.ForeignKeyViolation as exc:
                raise GatewayError("institution_not_found", "Unknown institution", 404) from exc


async def sync_prompt_versions(
    pool: AsyncConnectionPool, registry: PromptRegistry, *, allow_drift: bool | None = None
) -> dict[str, Any]:
    """Mirror the YAML registry into ``ai_prompt_versions`` (insert new versions, set active).

    Published versions are immutable: a version whose file hash differs from the stored hash is
    a drift error and aborts start-up unless ``AI_GATEWAY_ALLOW_PROMPT_DRIFT=1``.
    """

    if allow_drift is None:
        allow_drift = os.environ.get("AI_GATEWAY_ALLOW_PROMPT_DRIFT") == "1"
    inserted: list[str] = []
    drifted: list[str] = []
    async with pool.connection() as conn, conn.transaction():
        for prompt in registry.list():
            for version in prompt["versions"]:
                pv = registry.get(prompt["id"], version["version"])
                cur = await conn.execute(
                    "INSERT INTO ai_prompt_versions "
                    "(prompt_id, version, task, model, temperature, sha256, changelog) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (prompt_id, version) DO NOTHING RETURNING id",
                    (
                        pv.prompt_id,
                        pv.version,
                        pv.task,
                        pv.model,
                        pv.temperature,
                        pv.sha256,
                        pv.changelog or None,
                    ),
                )
                if await cur.fetchone():
                    inserted.append(f"{pv.prompt_id}@{pv.version}")
                    continue
                cur = await conn.execute(
                    "SELECT sha256 FROM ai_prompt_versions WHERE prompt_id = %s AND version = %s",
                    (pv.prompt_id, pv.version),
                )
                row = await cur.fetchone()
                if row and str(row[0]).strip() != pv.sha256:
                    drifted.append(f"{pv.prompt_id}@{pv.version}")
            await conn.execute(
                "UPDATE ai_prompt_versions SET is_active = FALSE "
                "WHERE prompt_id = %s AND version <> %s AND is_active",
                (prompt["id"], prompt["activeVersion"]),
            )
            await conn.execute(
                "UPDATE ai_prompt_versions SET is_active = TRUE "
                "WHERE prompt_id = %s AND version = %s",
                (prompt["id"], prompt["activeVersion"]),
            )
    report = {"inserted": inserted, "drifted": drifted}
    if drifted:
        log.error("prompt_version_drift", versions=drifted)
        if not allow_drift:
            raise RuntimeError(
                f"Published prompt versions changed on disk: {', '.join(drifted)}. "
                "Create a new version instead of editing a published one."
            )
    log.info("prompt_registry_synced", **report)
    return report
