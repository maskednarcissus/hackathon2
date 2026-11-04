"""Supported lecture languages (Phase 6.4).

``language`` comes from the ``recording.segmented`` payload or the class context
(class section / course), defaulting to ``pt-BR``. Each language maps to the Speech-to-Text v2
(Chirp 2) language code; the map can be overridden per deployment with
``SPEECH_LANGUAGE_CODES`` (JSON, e.g. ``{"es-419": "es-US"}``) if the configured region
exposes a different code.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

DEFAULT_LANGUAGE = "pt-BR"
SUPPORTED_LANGUAGES: tuple[str, ...] = ("pt-BR", "en-US", "es-ES", "es-419", "fr-FR")

#: Platform language → Chirp 2 ``language_codes`` entry.
CHIRP_LANGUAGE_CODES: dict[str, str] = {
    "pt-BR": "pt-BR",
    "en-US": "en-US",
    "es-ES": "es-ES",
    "es-419": "es-419",
    "fr-FR": "fr-FR",
}

_ALIASES = {
    "pt": "pt-BR",
    "pt-br": "pt-BR",
    "pt-pt": "pt-BR",
    "en": "en-US",
    "en-us": "en-US",
    "en-gb": "en-US",
    "es": "es-ES",
    "es-es": "es-ES",
    "es-419": "es-419",
    "fr": "fr-FR",
    "fr-fr": "fr-FR",
    "fr-ca": "fr-FR",
}
_LATAM_REGIONS = {"mx", "ar", "co", "cl", "pe", "ve", "uy", "py", "bo", "ec", "cr", "gt", "us"}


class UnsupportedLanguageError(ValueError):
    pass


def canonical_language(code: str | None) -> str:
    """Normalise a BCP-47-ish tag to a supported platform language (``None`` → pt-BR)."""
    if code is None or not str(code).strip():
        return DEFAULT_LANGUAGE
    key = str(code).strip().replace("_", "-").lower()
    if key in _ALIASES:
        return _ALIASES[key]
    base, _, region = key.partition("-")
    if base == "es" and (region in _LATAM_REGIONS or region.isdigit()):
        return "es-419"
    if base in _ALIASES:
        return _ALIASES[base]
    raise UnsupportedLanguageError(
        f"unsupported language {code!r}; supported: {', '.join(SUPPORTED_LANGUAGES)}"
    )


def check_language(code: str) -> str:
    return canonical_language(code)


def chirp_code(language: str, overrides: Mapping[str, str] | None = None) -> str:
    lang = canonical_language(language)
    if overrides and lang in overrides:
        return overrides[lang]
    return CHIRP_LANGUAGE_CODES[lang]


def parse_overrides(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("SPEECH_LANGUAGE_CODES must be a JSON object")
    return {canonical_language(str(k)): str(v) for k, v in data.items()}
