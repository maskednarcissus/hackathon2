"""FastAPI application factory for the AI gateway."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import structlog
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ai_gateway.audit import AuditClient, HttpAuditClient, InMemoryAuditClient
from ai_gateway.embeddings import EmbeddingProvider, FakeEmbeddingProvider
from ai_gateway.errors import GatewayError
from ai_gateway.models import BudgetUpdate, EmbedRequest, GenerateRequest
from ai_gateway.pricing import PricingTable
from ai_gateway.prompts import PromptNotFoundError, PromptRegistry
from ai_gateway.providers.base import GenerationProvider
from ai_gateway.providers.fake import FakeProvider
from ai_gateway.records import (
    BudgetRepository,
    CallRepository,
    InMemoryBudgetRepository,
    InMemoryCallRepository,
    summarise,
)
from ai_gateway.security import install_internal_token
from ai_gateway.service import GatewayService, GatewaySettings

log = structlog.get_logger(__name__)

DEFAULT_PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"


@dataclass
class GatewayDeps:
    registry: PromptRegistry
    provider: GenerationProvider
    calls: CallRepository
    budgets: BudgetRepository
    pricing: PricingTable
    audit: AuditClient
    settings: GatewaySettings
    embedder: EmbeddingProvider = field(default_factory=FakeEmbeddingProvider)
    pool: Any = None  # psycopg_pool.AsyncConnectionPool when DATABASE_URL is set
    internal_token: str | None = None


def deps_from_env() -> GatewayDeps:
    provider_name = os.environ.get("AI_GATEWAY_PROVIDER", "fake")
    provider: GenerationProvider
    embedder: EmbeddingProvider = FakeEmbeddingProvider()
    if provider_name == "vertex":
        from ai_gateway.embeddings import VertexEmbeddingProvider
        from ai_gateway.providers.vertex import VertexGeminiProvider

        provider = VertexGeminiProvider()
        embedder = VertexEmbeddingProvider()
    elif provider_name == "fake":
        provider = FakeProvider()
    else:
        raise ValueError(f"Unknown AI_GATEWAY_PROVIDER {provider_name!r}")
    default_budget = os.environ.get("AI_GATEWAY_DEFAULT_MONTHLY_BUDGET_USD")
    audit_url = os.environ.get("AUDIT_SERVICE_URL")
    return GatewayDeps(
        registry=PromptRegistry(
            Path(os.environ.get("AI_GATEWAY_PROMPTS_DIR", DEFAULT_PROMPTS_DIR))
        ),
        provider=provider,
        calls=InMemoryCallRepository(),
        budgets=InMemoryBudgetRepository(float(default_budget) if default_budget else None),
        pricing=PricingTable.from_env(),
        audit=HttpAuditClient(audit_url) if audit_url else InMemoryAuditClient(),
        settings=GatewaySettings(
            provider_timeout_s=float(os.environ.get("AI_GATEWAY_PROVIDER_TIMEOUT_S", "60")),
        ),
        embedder=embedder,
    )


def _error(code: str, message: str, status: int, details: Any = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if details:
        body["details"] = details
    return JSONResponse({"error": body}, status_code=status)


def _parse_dt(value: str | None, name: str) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GatewayError(
            "validation_error", f"{name} must be an ISO 8601 timestamp", 400
        ) from exc


def create_app(deps: GatewayDeps | None = None, service: GatewayService | None = None) -> FastAPI:
    deps = deps or deps_from_env()
    svc = service or GatewayService(
        registry=deps.registry,
        provider=deps.provider,
        calls=deps.calls,
        budgets=deps.budgets,
        pricing=deps.pricing,
        audit=deps.audit,
        settings=deps.settings,
        embedder=deps.embedder,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if deps.pool is not None:
            from ai_gateway.adapters.postgres import sync_prompt_versions

            await deps.pool.open(wait=True)
            try:
                await sync_prompt_versions(deps.pool, svc.registry)
                yield
            finally:
                await deps.pool.close()
        else:
            yield

    app = FastAPI(
        lifespan=lifespan,
        title="CI AI Gateway Service",
        description=(
            "Sole intermediary between domain services and foundation models: versioned prompts, "
            "schema-enforced structured output, prompt-injection defence, token and cost "
            "accounting."
        ),
        version="0.2.0",
    )
    app.state.service = svc
    # Every gateway route is service-to-service; only /health stays open.
    install_internal_token(app, deps.internal_token, lambda path: path != "/health")

    @app.exception_handler(GatewayError)
    async def _gateway_error(_: Request, exc: GatewayError) -> JSONResponse:
        return _error(exc.code, exc.message, exc.status_code, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        issues = [
            {"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in exc.errors()
        ]
        return _error("validation_error", "Request validation failed", 400, {"issues": issues})

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "ai-gateway"}

    @app.post("/v1/generate")
    async def generate(body: GenerateRequest) -> dict[str, Any]:
        return await svc.generate(body)

    @app.post("/v1/embed")
    async def embed(body: EmbedRequest) -> dict[str, Any]:
        return await svc.embed(body)

    @app.get("/v1/prompts")
    async def list_prompts() -> dict[str, Any]:
        return {"items": svc.registry.list()}

    @app.get("/v1/prompts/{prompt_id}")
    async def get_prompt(prompt_id: str) -> dict[str, Any]:
        try:
            return svc.registry.describe(prompt_id)
        except PromptNotFoundError as exc:
            raise GatewayError("prompt_not_found", str(exc), 404) from exc

    @app.get("/v1/calls/{request_id}")
    async def get_call(request_id: str) -> dict[str, Any]:
        record = await svc.calls.get(request_id)
        if record is None:
            raise GatewayError("not_found", "Unknown requestId", 404)
        return record.to_json()

    @app.get("/v1/usage")
    async def usage(
        institution_id: str | None = Query(default=None, alias="institutionId"),
        start: str | None = Query(default=None, alias="from"),
        end: str | None = Query(default=None, alias="to"),
    ) -> dict[str, Any]:
        records = await svc.calls.query(
            institution_id, _parse_dt(start, "from"), _parse_dt(end, "to")
        )
        return {"institutionId": institution_id, "from": start, "to": end, **summarise(records)}

    @app.get("/v1/budgets/{institution_id}")
    async def get_budget(institution_id: str) -> dict[str, Any]:
        return {
            "institutionId": institution_id,
            "monthlyUsd": await svc.budgets.get(institution_id),
            "monthToDateUsd": await svc.month_to_date_spend(institution_id),
        }

    @app.put("/v1/budgets/{institution_id}")
    async def put_budget(institution_id: str, body: BudgetUpdate) -> dict[str, Any]:
        await svc.budgets.set(institution_id, body.monthly_usd)
        return await get_budget(institution_id)

    return app
