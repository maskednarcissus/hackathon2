"""Text normalization helpers for Brazilian Portuguese classroom speech.

``normalize_aligned`` keeps a 1:1 character mapping with the original text so that
regex matches on the normalized form can be mapped back to the exact original span
(used to build quotes and date expressions that are verifiable against the transcript).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

_KEEP = set("/:")


def _fold_char(ch: str) -> str:
    decomposed = unicodedata.normalize("NFKD", ch)
    base = "".join(c for c in decomposed if not unicodedata.combining(c))
    if len(base) != 1:
        base = base[:1] if base else " "
    base = base.lower()
    if base.isalnum() or base in _KEEP:
        return base
    return " "


def normalize_aligned(text: str) -> str:
    """Lowercase, strip accents and punctuation, preserving string length."""
    return "".join(_fold_char(ch) for ch in text)


def normalize(text: str) -> str:
    """Accent/case/punctuation-insensitive form with collapsed whitespace."""
    return re.sub(r"\s+", " ", normalize_aligned(text)).strip()


def contains_normalized(haystack: str, needle: str) -> bool:
    n = normalize(needle)
    return bool(n) and n in normalize(haystack)


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize(a), normalize(b)).ratio()


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    text: str


_SENTENCE_END = re.compile(r"[.!?;]+(?:\s+|$)|\n+")


def split_sentences(text: str) -> list[Span]:
    """Split text into sentences, keeping offsets into the original string."""
    spans: list[Span] = []
    start = 0
    for m in _SENTENCE_END.finditer(text):
        end = m.start()
        chunk = text[start:end]
        if chunk.strip():
            lead = len(chunk) - len(chunk.lstrip())
            spans.append(Span(start + lead, end, chunk.strip()))
        start = m.end()
    tail = text[start:]
    if tail.strip():
        lead = len(tail) - len(tail.lstrip())
        spans.append(Span(start + lead, len(text), tail.strip()))
    return spans


_CLAUSE_SPLIT = re.compile(
    r",?\s+e\s+(?=(?:o|a|os|as)\s+(?:prova|provas|trabalho|trabalhos|lista|listas|semin[aá]rios?|"
    r"projeto|entrega|apresenta[cç][aã]o|leitura|quiz|teste|relat[oó]rio)\b)"
    r"|,?\s+mas\s+|\s+por[eé]m\s+",
    re.IGNORECASE,
)


def split_clauses(sentence: str) -> list[str]:
    """Split a sentence that announces several events ("a prova é dia 20 e o trabalho dia 27",
    "a aula de amanhã foi cancelada, mas vamos repor no sábado")."""
    parts: list[str] = []
    start = 0
    for m in _CLAUSE_SPLIT.finditer(sentence):
        parts.append(sentence[start : m.start()])
        start = m.end()
    parts.append(sentence[start:])
    return [p.strip(" ,:") for p in parts if p.strip(" ,:")]
