"""Shared plumbing for the AI regression suite (Phase 6 §6.8).

Imports the services in-process (no network) the same way ``run_event_eval.py`` does, and runs
model calls through the **real ai-gateway** (prompt registry from ``services/ai-gateway/prompts``,
request validation, untrusted-input fencing, injection detection, JSON-schema enforcement) backed by
its deterministic ``FakeProvider``. A prompt change therefore exercises the same gateway code path
the services use in production; only the model is scripted. In ``--live`` mode the services talk to
a running gateway over HTTP instead.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
AI_EVAL = HERE.parent
REPO = AI_EVAL.parent.parent
for src in (
    REPO / "services" / "event-extraction" / "src",
    REPO / "services" / "lecture-intelligence" / "src",
    REPO / "services" / "ai-gateway" / "src",
):
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
if str(AI_EVAL) not in sys.path:
    sys.path.insert(0, str(AI_EVAL))

import logging  # noqa: E402

import httpx  # noqa: E402
import structlog  # noqa: E402


def quiet_logs() -> None:
    """Service loggers warn about dev settings (open internal endpoints…) on every app build."""
    logging.disable(logging.WARNING)
    structlog.configure(wrapper_class=structlog.make_filtering_bound_logger(logging.ERROR))


quiet_logs()

ErrorFactory = Callable[[str, str, int], Exception]


class InProcessGateway:
    """ai-gateway ``create_app`` + ``FakeProvider`` behind an ASGI transport."""

    def __init__(self, prompts_dir: Path | None = None) -> None:
        from ai_gateway.app import DEFAULT_PROMPTS_DIR, GatewayDeps, create_app
        from ai_gateway.audit import InMemoryAuditClient
        from ai_gateway.pricing import PricingTable
        from ai_gateway.prompts import PromptRegistry
        from ai_gateway.providers.fake import FakeProvider
        from ai_gateway.records import InMemoryBudgetRepository, InMemoryCallRepository
        from ai_gateway.service import GatewaySettings

        self.provider = FakeProvider()
        deps = GatewayDeps(
            registry=PromptRegistry(prompts_dir or DEFAULT_PROMPTS_DIR),
            provider=self.provider,
            calls=InMemoryCallRepository(),
            budgets=InMemoryBudgetRepository(None),
            pricing=PricingTable(),
            audit=InMemoryAuditClient(),
            settings=GatewaySettings(max_transient_retries=0, backoff_base_s=0),
        )
        self.app = create_app(deps)

    def script(self, prompt_id: str, *responses: Any) -> None:
        self.provider.script(prompt_id, *responses)

    def client(self, error_factory: ErrorFactory) -> GatewayAdapter:
        return GatewayAdapter(httpx.ASGITransport(app=self.app), "http://gateway", error_factory)


class GatewayAdapter:
    """``generate(payload) -> response`` client usable by every service's gateway port."""

    def __init__(
        self, transport: httpx.AsyncBaseTransport | None, base_url: str, errors: ErrorFactory
    ) -> None:
        self._client = httpx.AsyncClient(transport=transport, base_url=base_url, timeout=180.0)
        self._errors = errors
        self.payloads: list[dict[str, Any]] = []

    async def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads.append(payload)
        try:
            response = await self._client.post("/v1/generate", json=payload)
        except httpx.HTTPError as exc:
            raise self._errors("gateway_unavailable", str(exc), 502) from exc
        if response.status_code >= 400:
            try:
                err = response.json().get("error", {})
            except ValueError:
                err = {}
            raise self._errors(
                str(err.get("code", "gateway_error")),
                str(err.get("message", response.text[:200])),
                response.status_code,
            )
        body: dict[str, Any] = response.json()
        return body


def live_gateway(
    base_url: str, errors: ErrorFactory, transport: httpx.AsyncBaseTransport | None = None
) -> GatewayAdapter:
    return GatewayAdapter(transport, base_url.rstrip("/"), errors)


def event_extraction_errors(code: str, message: str, status: int) -> Exception:
    from event_extraction.ports import UpstreamError

    return UpstreamError(f"{code}: {message} (HTTP {status})")


def lecture_errors(code: str, message: str, status: int) -> Exception:
    from lecture_intelligence.clients import GatewayCallError

    return GatewayCallError(code, message, status)
