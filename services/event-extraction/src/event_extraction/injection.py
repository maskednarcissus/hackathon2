"""Local prompt-injection signal detection (defence in depth; the AI gateway also checks).

Classroom speech is untrusted input. Sentences that look like instructions to an AI system
are never used as evidence for an academic event.
"""

from __future__ import annotations

import re

from .text import normalize

_SIGNALS: list[tuple[str, str]] = [
    (
        "ignore_instructions_pt",
        r"\b(?:ignore|ignorem|ignorar|desconsidere|esqueca|esquecam)\s+"
        r"(?:todas\s+)?(?:as\s+)?(?:suas\s+)?(?:instrucoes|regras|ordens|orientacoes)",
    ),
    ("ignore_instructions_en", r"\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\b"),
    ("system_prompt", r"\b(?:system\s+prompt|prompt\s+do\s+sistema|instrucoes\s+do\s+sistema)\b"),
    (
        "role_override_pt",
        r"\b(?:voce\s+agora\s+e|a\s+partir\s+de\s+agora\s+voce|finja\s+que\s+voce)",
    ),
    ("role_override_en", r"\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\b"),
    (
        "bulk_action",
        r"\b(?:confirme|confirmem|cancele|cancelem|apague|apaguem|publique|marque)\s+"
        r"(?:todas|todos|tudo)\b",
    ),
    (
        "ai_addressed",
        r"\b(?:inteligencia\s+artificial|assistente|chatbot|robo|ia)\s*,?\s+"
        r"(?:ignore|confirme|cancele|publique|marque|registre|anote)\b",
    ),
]
_RAW_SIGNALS: list[tuple[str, str]] = [
    ("role_tag", r"</?\s*(?:system|assistant|user|untrusted[_a-z]*)\s*>"),
    ("role_prefix", r"(?im)^\s*(?:system|assistant)\s*:"),
]


def injection_signals(text: str) -> list[str]:
    norm = normalize(text)
    found = [name for name, pattern in _SIGNALS if re.search(pattern, norm)]
    found += [name for name, pattern in _RAW_SIGNALS if re.search(pattern, text, re.IGNORECASE)]
    return found
