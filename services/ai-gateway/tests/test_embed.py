from __future__ import annotations

import asyncio
import math

from conftest import INSTITUTION, Harness

from ai_gateway.embeddings import hashed_vector, normalise_tokens
from ai_gateway.errors import ProviderError


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_fake_vectors_are_deterministic_normalised_and_accent_insensitive() -> None:
    a = hashed_vector("Política monetária e inflação")
    b = hashed_vector("politica MONETARIA e inflacao")
    assert a == b
    assert len(a) == 256
    assert math.isclose(math.sqrt(sum(v * v for v in a)), 1.0, rel_tol=1e-6)
    related = hashed_vector("A inflação depende da política monetária do Banco Central")
    unrelated = hashed_vector("Anatomia do sistema nervoso periférico")
    assert _cos(a, related) > _cos(a, unrelated)
    assert hashed_vector("de a o") == [0.0] * 256
    assert normalise_tokens("As provas finais") == ["prov", "final"]


def test_embed_endpoint_returns_vectors_and_accounts_usage(harness: Harness) -> None:
    body = {
        "texts": ["curva IS-LM", "taxa Selic"],
        "institutionId": INSTITUTION,
        "purpose": "query",
        "requestedBy": "transcript-management",
    }
    response = harness.client.post("/v1/embed", json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["model"] == "fake-embedding"
    assert data["dimensions"] == 256
    assert len(data["vectors"]) == 2
    assert data["usage"]["inputTokens"] > 0
    record = harness.client.get(f"/v1/calls/{data['requestId']}").json()
    assert record["task"] == "embedding"
    assert record["prompt"]["version"] == "query"
    assert "Selic" not in str(record)
    usage = harness.client.get("/v1/usage", params={"institutionId": INSTITUTION}).json()
    assert usage["byTask"][0]["key"] == "embedding"


def test_embed_validation_and_budget(harness: Harness) -> None:
    bad = {"texts": [], "institutionId": INSTITUTION, "purpose": "query"}
    assert harness.client.post("/v1/embed", json=bad).status_code == 400
    bad = {"texts": ["x"], "institutionId": INSTITUTION, "purpose": "other"}
    assert harness.client.post("/v1/embed", json=bad).status_code == 400
    asyncio.run(harness.budgets.set(INSTITUTION, 0.0))
    ok = {"texts": ["x"], "institutionId": INSTITUTION, "purpose": "query"}
    resp = harness.client.post("/v1/embed", json=ok)
    assert resp.status_code == 429
    assert resp.json()["error"]["code"] == "budget_exceeded"


def test_embed_provider_failure_retries_then_502(harness: Harness) -> None:
    class Failing:
        name = "fake"
        model = "fake-embedding"

        def __init__(self) -> None:
            self.calls = 0

        async def embed(self, texts: list[str], purpose: str) -> object:
            self.calls += 1
            raise ProviderError("503", transient=True)

    failing = Failing()
    harness.service.embedder = failing  # type: ignore[assignment]
    ok = {"texts": ["x"], "institutionId": INSTITUTION, "purpose": "search_index"}
    resp = harness.client.post("/v1/embed", json=ok)
    assert resp.status_code == 502
    assert failing.calls == 3  # 1 + max_transient_retries (2)


def test_assistant_prompt_is_registered(harness: Harness) -> None:
    detail = harness.client.get("/v1/prompts/assistant-answer").json()
    assert detail["versions"][0]["task"] == "assistant_answer"
