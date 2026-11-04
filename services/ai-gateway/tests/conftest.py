from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_gateway.app import DEFAULT_PROMPTS_DIR, GatewayDeps, create_app
from ai_gateway.audit import InMemoryAuditClient
from ai_gateway.pricing import PricingTable
from ai_gateway.prompts import PromptRegistry
from ai_gateway.providers.fake import FakeProvider
from ai_gateway.records import InMemoryBudgetRepository, InMemoryCallRepository
from ai_gateway.service import GatewayService, GatewaySettings

INSTITUTION = "11111111-1111-4111-8111-111111111111"

EVENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["events"],
    "additionalProperties": False,
    "properties": {
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["type", "quote", "segmentIndex"],
                "properties": {
                    "type": {"type": "string", "enum": ["examination", "assignment"]},
                    "quote": {"type": "string", "minLength": 1},
                    "segmentIndex": {"type": "integer", "minimum": 0},
                },
            },
        }
    },
}


class Harness:
    def __init__(self, tmp_prompts: Path | None = None) -> None:
        self.provider = FakeProvider(model_override=None)
        self.calls = InMemoryCallRepository()
        self.budgets = InMemoryBudgetRepository()
        self.audit = InMemoryAuditClient()
        self.sleeps: list[float] = []
        self.now = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)

        async def fake_sleep(delay: float) -> None:
            self.sleeps.append(delay)

        self.service = GatewayService(
            registry=PromptRegistry(tmp_prompts or DEFAULT_PROMPTS_DIR),
            provider=self.provider,
            calls=self.calls,
            budgets=self.budgets,
            pricing=PricingTable(),
            audit=self.audit,
            settings=GatewaySettings(provider_timeout_s=1.0, max_transient_retries=2),
            clock=lambda: self.now,
            sleep=fake_sleep,
        )
        deps = GatewayDeps(
            registry=self.service.registry,
            provider=self.provider,
            calls=self.calls,
            budgets=self.budgets,
            pricing=PricingTable(),
            audit=self.audit,
            settings=self.service.settings,
        )
        self.client = TestClient(create_app(deps, service=self.service))


@pytest.fixture()
def harness() -> Harness:
    return Harness()


@pytest.fixture()
def generate_body() -> Callable[..., dict[str, Any]]:
    def build(**overrides: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "task": "event_extraction",
            "promptId": "event-extraction",
            "variables": {
                "courseName": "Economia Monetária",
                "classDate": "2026-11-04",
                "timezone": "America/Sao_Paulo",
                "upcomingClasses": ["2026-11-11"],
            },
            "untrustedInputs": {
                "transcript": "[s0 00:00:01] Nossa segunda prova será no dia 20 de novembro."
            },
            "responseSchema": EVENT_SCHEMA,
            "institutionId": INSTITUTION,
            "requestedBy": "event-extraction",
        }
        body.update(overrides)
        return body

    return build
