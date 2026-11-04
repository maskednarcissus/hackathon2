"""Vertex AI Gemini provider (google-genai). Imported lazily; requires the ``gcp`` extra."""

from __future__ import annotations

import os
from typing import Any

from ai_gateway.errors import ProviderError
from ai_gateway.providers.base import ProviderRequest, ProviderResponse, estimate_tokens

_TRANSIENT_CODES = {408, 429, 500, 502, 503, 504}


class VertexGeminiProvider:
    name = "vertex"

    def __init__(self, project: str | None = None, location: str | None = None) -> None:
        try:
            from google import genai
        except ImportError as exc:  # pragma: no cover - exercised only without the extra
            raise RuntimeError("Install ci-ai-gateway[gcp] to use the Vertex provider") from exc
        self._client: Any = genai.Client(
            vertexai=True,
            project=project or os.environ.get("GOOGLE_CLOUD_PROJECT"),
            location=location or os.environ.get("VERTEX_LOCATION", "southamerica-east1"),
        )

    async def generate(self, request: ProviderRequest) -> ProviderResponse:  # pragma: no cover
        from google.genai import errors, types

        contents = [
            types.Content(role=m.role, parts=[types.Part(text=m.text)]) for m in request.messages
        ]
        config = types.GenerateContentConfig(
            system_instruction=request.system,
            temperature=request.temperature,
            max_output_tokens=request.max_output_tokens,
            response_mime_type="application/json",
            response_json_schema=request.response_schema,
        )
        try:
            response = await self._client.aio.models.generate_content(
                model=request.model, contents=contents, config=config
            )
        except errors.APIError as exc:
            code = int(getattr(exc, "code", 0) or 0)
            raise ProviderError(
                f"Vertex AI error {code}: {exc}", transient=code in _TRANSIENT_CODES
            ) from exc
        except (TimeoutError, ConnectionError) as exc:
            raise ProviderError(f"Vertex AI connection error: {exc}", transient=True) from exc

        text = response.text or ""
        usage = getattr(response, "usage_metadata", None)
        input_tokens = int(getattr(usage, "prompt_token_count", 0) or 0)
        output_tokens = int(getattr(usage, "candidates_token_count", 0) or 0)
        if not input_tokens:
            input_tokens = estimate_tokens(
                request.system + "".join(m.text for m in request.messages)
            )
        if not output_tokens:
            output_tokens = estimate_tokens(text)
        return ProviderResponse(
            text=text,
            model=request.model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
