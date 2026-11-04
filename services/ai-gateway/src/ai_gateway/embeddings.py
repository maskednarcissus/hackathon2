"""Embedding providers (deliverable 3.6 / 3.13 retrieval).

``FakeEmbeddingProvider`` is deterministic and dependency-free: a signed, hashed bag of
pt-BR-normalised tokens (accent folding, stopwords, light stemming) projected into 256
dimensions and L2-normalised, so lexically similar texts get high cosine similarity.
``VertexEmbeddingProvider`` calls ``text-multilingual-embedding-002`` (extra ``gcp``).
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from ai_gateway.errors import ProviderError

Purpose = Literal["search_index", "query"]
FAKE_DIMENSIONS = 256

_STOPWORDS = frozenset(
    """
    a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra
    com sem sobre entre ate e ou mas que se como quando onde qual quais quem ao aos seu sua seus
    suas este esta isto esse essa isso ele ela eles elas voce voces eu nao sim mais menos muito
    tambem so ser estar ter foi era sao tem vai the of and to in for on with is are
    """.split()
)
_PLURALS = (("oes", "ao"), ("aes", "ao"), ("ais", "al"), ("eis", "el"), ("ns", "m"))


@dataclass(frozen=True)
class EmbeddingResponse:
    vectors: list[list[float]]
    model: str
    dimensions: int
    input_tokens: int


class EmbeddingProvider(Protocol):
    name: str
    model: str

    async def embed(self, texts: list[str], purpose: Purpose) -> EmbeddingResponse: ...


def normalise_tokens(text: str) -> list[str]:
    decomposed = unicodedata.normalize("NFKD", text)
    folded = "".join(c for c in decomposed if not unicodedata.combining(c)).lower()
    tokens = []
    for token in re.findall(r"[0-9a-z]+", folded):
        if len(token) < 2 or token in _STOPWORDS:
            continue
        for suffix, replacement in _PLURALS:
            if token.endswith(suffix) and len(token) > len(suffix) + 2:
                token = token[: -len(suffix)] + replacement
                break
        else:
            if token.endswith("s") and len(token) > 3:
                token = token[:-1]
        if token[-1:] in ("a", "o", "e") and len(token) > 3:
            token = token[:-1]
        tokens.append(token)
    return tokens


def hashed_vector(text: str, dimensions: int = FAKE_DIMENSIONS) -> list[float]:
    vector = [0.0] * dimensions
    for token in normalise_tokens(text):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        vector[bucket] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vector))
    return [round(v / norm, 8) for v in vector] if norm else vector


class FakeEmbeddingProvider:
    name = "fake"
    model = "fake-embedding"

    def __init__(self, dimensions: int = FAKE_DIMENSIONS) -> None:
        self.dimensions = dimensions
        self.calls: list[tuple[list[str], Purpose]] = []

    async def embed(self, texts: list[str], purpose: Purpose) -> EmbeddingResponse:
        self.calls.append((list(texts), purpose))
        return EmbeddingResponse(
            vectors=[hashed_vector(t, self.dimensions) for t in texts],
            model=self.model,
            dimensions=self.dimensions,
            input_tokens=sum(max(1, (len(t) + 3) // 4) for t in texts),
        )


class VertexEmbeddingProvider:  # pragma: no cover - requires GCP credentials
    name = "vertex"
    model = "text-multilingual-embedding-002"
    batch_size = 250

    def __init__(self, project: str | None = None, location: str | None = None) -> None:
        try:
            from google import genai
        except ImportError as exc:
            raise RuntimeError("Install ci-ai-gateway[gcp] to use Vertex embeddings") from exc
        self._client: Any = genai.Client(
            vertexai=True,
            project=project or os.environ.get("GOOGLE_CLOUD_PROJECT"),
            location=location or os.environ.get("VERTEX_LOCATION", "southamerica-east1"),
        )

    async def embed(self, texts: list[str], purpose: Purpose) -> EmbeddingResponse:
        from google.genai import errors, types

        task_type = "RETRIEVAL_QUERY" if purpose == "query" else "RETRIEVAL_DOCUMENT"
        vectors: list[list[float]] = []
        tokens = 0
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start : start + self.batch_size]
            try:
                response = await self._client.aio.models.embed_content(
                    model=self.model,
                    contents=batch,
                    config=types.EmbedContentConfig(task_type=task_type),
                )
            except errors.APIError as exc:
                code = int(getattr(exc, "code", 0) or 0)
                raise ProviderError(
                    f"Vertex embedding error {code}: {exc}",
                    transient=code in {408, 429, 500, 502, 503, 504},
                ) from exc
            for embedding in response.embeddings or []:
                vectors.append(list(embedding.values or []))
                stats = getattr(embedding, "statistics", None)
                tokens += int(getattr(stats, "token_count", 0) or 0)
        dims = len(vectors[0]) if vectors else 0
        return EmbeddingResponse(
            vectors=vectors, model=self.model, dimensions=dims, input_tokens=tokens
        )
