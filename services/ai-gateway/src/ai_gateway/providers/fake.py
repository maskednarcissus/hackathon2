"""Deterministic provider for development and tests.

Scripts are keyed by ``promptId`` (preferred) or ``task``. Each script is a queue of responses;
the last response is repeated once the queue is exhausted. A response may be a string (returned
verbatim — useful to simulate invalid JSON), a JSON-serialisable object, a callable receiving the
:class:`ProviderRequest`, or an exception instance (raised).
Without a script the provider returns the minimal instance of the response schema.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ai_gateway.providers.base import ProviderRequest, ProviderResponse, estimate_tokens

ScriptItem = str | dict[str, Any] | list[Any] | BaseException | Callable[[ProviderRequest], Any]


class FakeProvider:
    name = "fake"

    def __init__(
        self,
        scripts: dict[str, list[ScriptItem]] | None = None,
        model_override: str | None = "fake-model",
    ) -> None:
        self._scripts: dict[str, list[ScriptItem]] = {
            k: list(v) for k, v in (scripts or {}).items()
        }
        self._model_override = model_override
        self.requests: list[ProviderRequest] = []

    def script(self, key: str, *responses: ScriptItem) -> None:
        self._scripts[key] = list(responses)

    async def generate(self, request: ProviderRequest) -> ProviderResponse:
        self.requests.append(request)
        item = self._next(request)
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            item = item(request)
        text = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
        prompt_text = request.system + "".join(m.text for m in request.messages)
        return ProviderResponse(
            text=text,
            model=self._model_override or request.model,
            input_tokens=estimate_tokens(prompt_text),
            output_tokens=estimate_tokens(text),
        )

    def _next(self, request: ProviderRequest) -> ScriptItem:
        for key in (request.prompt_id, request.task):
            queue = self._scripts.get(key)
            if queue:
                return queue.pop(0) if len(queue) > 1 else queue[0]
        instance: dict[str, Any] = minimal_instance(
            request.response_schema, request.response_schema
        )
        return instance


def minimal_instance(schema: dict[str, Any], root: dict[str, Any]) -> Any:
    """Build the smallest value satisfying common JSON-schema constructs."""

    if "$ref" in schema:
        ref = str(schema["$ref"])
        node: Any = root
        for part in ref.removeprefix("#/").split("/"):
            node = node[part]
        return minimal_instance(node, root)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    for combinator in ("anyOf", "oneOf", "allOf"):
        if combinator in schema:
            return minimal_instance(schema[combinator][0], root)
    schema_type = schema.get("type", "object")
    if isinstance(schema_type, list):
        schema_type = next((t for t in schema_type if t != "null"), "null")
    if schema_type == "object":
        props: dict[str, Any] = schema.get("properties", {})
        return {
            key: minimal_instance(props.get(key, {}), root) for key in schema.get("required", [])
        }
    if schema_type == "array":
        min_items = int(schema.get("minItems", 0))
        return [minimal_instance(schema.get("items", {}), root) for _ in range(min_items)]
    if schema_type == "string":
        return "x" * int(schema.get("minLength", 0))
    if schema_type in ("integer", "number"):
        return schema.get("minimum", 0)
    if schema_type == "boolean":
        return False
    return None
