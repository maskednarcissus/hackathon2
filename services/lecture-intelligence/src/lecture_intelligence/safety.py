"""Prompt-injection heuristics applied to untrusted classroom text (questions, segments)."""

from __future__ import annotations

import re

from lecture_intelligence.text import fold

_INJECTION_PATTERNS = [
    re.compile(
        r"\b(ignore|ignorem|ignora|desconsidere|esqueca|disregard|forget|override)\b"
        r"[\w\s,]{0,40}\b(instruc(ao|oes)|instructions?|regras|rules|prompts?)\b"
    ),
    re.compile(r"\b(system prompt|prompt do sistema|prompt de sistema)\b"),
    re.compile(r"\b(voce agora e|a partir de agora voce|you are now|aja como se|act as)\b"),
    re.compile(r"(<\s*/?\s*(system|assistant|developer)\s*>|untrusted_[a-z_]+|\[\s*system\s*\])"),
]


def injection_suspected(text: str) -> bool:
    """True when ``text`` contains instruction-override / role / delimiter-spoofing patterns."""

    folded = fold(text.replace("<", " <").replace(">", "> "))
    raw = text.lower()
    return any(p.search(folded) or p.search(raw) for p in _INJECTION_PATTERNS)
