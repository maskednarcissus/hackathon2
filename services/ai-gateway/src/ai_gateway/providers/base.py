"""Provider abstraction: the gateway speaks only this interface."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


@dataclass(frozen=True)
class Message:
    role: Literal["user", "model"]
    text: str


@dataclass(frozen=True)
class ProviderRequest:
    task: str
    prompt_id: str
    model: str
    system: str
    messages: list[Message]
    response_schema: dict[str, Any]
    temperature: float = 0.0
    max_output_tokens: int = 8192
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderResponse:
    text: str
    model: str
    input_tokens: int
    output_tokens: int


class GenerationProvider(Protocol):
    name: str

    async def generate(self, request: ProviderRequest) -> ProviderResponse: ...


def estimate_tokens(text: str) -> int:
    """Rough token estimate (≈4 characters per token) for providers without usage metadata."""

    return max(1, (len(text) + 3) // 4)
