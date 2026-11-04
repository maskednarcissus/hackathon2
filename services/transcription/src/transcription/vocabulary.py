"""Domain vocabulary (speech adaptation phrase sets), ADR-004 §3.

Configuration file (JSON), path from ``TRANSCRIPTION_VOCABULARY_PATH``::

    {
      "default": ["ementa", "avaliação", "trabalho final"],
      "disciplines": {"medicine": ["anamnese", "farmacocinética"]},
      "institutions": {"<institution uuid>": {"*": ["..."], "law": ["habeas corpus"]}}
    }

Phrases for a job = default ∪ discipline ∪ institution["*"] ∪ institution[discipline],
de-duplicated case-insensitively and capped at ``max_phrases`` (provider limit).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class VocabularyCatalog:
    default: tuple[str, ...] = ()
    disciplines: dict[str, tuple[str, ...]] = field(default_factory=dict)
    institutions: dict[str, dict[str, tuple[str, ...]]] = field(default_factory=dict)
    max_phrases: int = 500

    @classmethod
    def from_dict(cls, raw: dict[str, Any], max_phrases: int = 500) -> VocabularyCatalog:
        def phrases(value: Any) -> tuple[str, ...]:
            if not isinstance(value, list):
                raise ValueError("vocabulary entries must be lists of strings")
            return tuple(str(v).strip() for v in value if str(v).strip())

        return cls(
            default=phrases(raw.get("default", [])),
            disciplines={k: phrases(v) for k, v in dict(raw.get("disciplines", {})).items()},
            institutions={
                inst: {k: phrases(v) for k, v in dict(sets).items()}
                for inst, sets in dict(raw.get("institutions", {})).items()
            },
            max_phrases=max_phrases,
        )

    @classmethod
    def load(cls, path: str | Path | None) -> VocabularyCatalog:
        if not path:
            return cls()
        with open(path, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    def phrases_for(self, institution_id: str | None, discipline: str | None) -> tuple[str, ...]:
        candidates: list[str] = list(self.default)
        if discipline:
            candidates += self.disciplines.get(discipline, ())
        if institution_id and institution_id in self.institutions:
            inst = self.institutions[institution_id]
            candidates += inst.get("*", ())
            if discipline:
                candidates += inst.get(discipline, ())
        seen: set[str] = set()
        out: list[str] = []
        for phrase in candidates:
            key = phrase.casefold()
            if key not in seen:
                seen.add(key)
                out.append(phrase)
        return tuple(out[: self.max_phrases])
