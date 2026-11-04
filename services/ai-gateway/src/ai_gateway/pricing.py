"""Model pricing table (USD per 1M tokens) used for cost accounting.

Prices are list prices for Vertex AI at the time of writing and are configuration, not truth:
override them with ``AI_GATEWAY_PRICING_JSON`` when contracts change.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelPrice:
    input_per_million: float
    output_per_million: float


DEFAULT_PRICING: dict[str, ModelPrice] = {
    "gemini-2.5-pro": ModelPrice(1.25, 10.0),
    "gemini-2.5-flash": ModelPrice(0.30, 2.50),
    "gemini-2.5-flash-lite": ModelPrice(0.10, 0.40),
    # Vertex bills embeddings per character; expressed here per token (~4 chars/token).
    "text-multilingual-embedding-002": ModelPrice(0.10, 0.0),
    "fake-model": ModelPrice(0.0, 0.0),
    "demo-extractive": ModelPrice(0.0, 0.0),
    "fake-embedding": ModelPrice(0.0, 0.0),
}


class PricingTable:
    def __init__(self, prices: dict[str, ModelPrice] | None = None) -> None:
        self._prices = dict(DEFAULT_PRICING if prices is None else prices)

    @classmethod
    def from_env(cls) -> PricingTable:
        raw = os.environ.get("AI_GATEWAY_PRICING_JSON")
        prices = dict(DEFAULT_PRICING)
        if raw:
            for model, value in json.loads(raw).items():
                prices[model] = ModelPrice(float(value["input"]), float(value["output"]))
        return cls(prices)

    def cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        price = self._prices.get(model)
        if price is None:
            # Unknown model: charge the most expensive known price so budgets stay conservative.
            price = max(self._prices.values(), key=lambda p: p.output_per_million)
        cost = (
            input_tokens * price.input_per_million + output_tokens * price.output_per_million
        ) / 1_000_000
        return round(cost, 8)
