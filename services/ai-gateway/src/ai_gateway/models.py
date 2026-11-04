"""HTTP request/response models (camelCase on the wire)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

Task = Literal["lecture_structuring", "event_extraction", "date_resolution", "assistant_answer"]
JsonScalar = str | int | float | bool | None


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class GenerateOptions(CamelModel):
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, ge=16, le=65536)


class GenerateRequest(CamelModel):
    task: Task
    prompt_id: str = Field(min_length=1, max_length=64)
    prompt_version: str | None = Field(default=None, max_length=64)
    variables: dict[str, Any] = Field(default_factory=dict)
    untrusted_inputs: dict[str, str] = Field(default_factory=dict)
    response_schema: dict[str, Any]
    institution_id: str = Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    )
    requested_by: str = Field(min_length=1, max_length=100)
    options: GenerateOptions = Field(default_factory=GenerateOptions)

    @field_validator("variables")
    @classmethod
    def _no_untrusted_namespace(cls, value: dict[str, Any]) -> dict[str, Any]:
        for key in value:
            if key.startswith("untrusted"):
                raise ValueError("variables must not use the reserved 'untrusted' namespace")
        return value

    @field_validator("untrusted_inputs")
    @classmethod
    def _input_names(cls, value: dict[str, str]) -> dict[str, str]:
        for key in value:
            if not key.replace("_", "").isalnum():
                raise ValueError(f"invalid untrusted input name {key!r}")
        return value


class EmbedRequest(CamelModel):
    texts: list[str] = Field(min_length=1, max_length=1000)
    institution_id: str = Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    )
    purpose: Literal["search_index", "query"]
    requested_by: str = Field(default="unknown", min_length=1, max_length=100)

    @field_validator("texts")
    @classmethod
    def _text_sizes(cls, value: list[str]) -> list[str]:
        for i, text in enumerate(value):
            if len(text) > 20000:
                raise ValueError(f"texts[{i}] exceeds 20000 characters")
        return value


class BudgetUpdate(CamelModel):
    monthly_usd: float | None = Field(ge=0)


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ProviderInfo(BaseModel):
    provider: str
    name: str


JsonDict = dict[str, Any]
__all__ = [
    "BudgetUpdate",
    "EmbedRequest",
    "CamelModel",
    "GenerateOptions",
    "GenerateRequest",
    "JsonDict",
    "JsonScalar",
    "ProviderInfo",
    "Task",
]
