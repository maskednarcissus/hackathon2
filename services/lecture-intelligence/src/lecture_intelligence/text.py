"""Text normalisation and lexical grounding helpers (accent-insensitive, Portuguese-aware)."""

from __future__ import annotations

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^0-9a-z]+")

STOPWORDS = frozenset(
    """
    a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra
    com sem sobre entre ate e ou mas que se como quando onde qual quais quem cujo cuja ao aos
    seu sua seus suas meu minha nosso nossa este esta isto esse essa isso aquele aquela aquilo
    ele ela eles elas voce voces nos eu tu lhe lhes me te ja nao sim mais menos muito muita
    muitos muitas tambem so ser estar ter haver foi era sao esta estao tem vai vao fazer
    aula professor professora turma gente aqui entao ne tipo coisa coisas assim bem
    the of and to in for on with is are
    """.split()
)


def fold(text: str) -> str:
    """Lowercase, strip accents, replace punctuation with spaces, collapse whitespace."""

    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c)).lower()
    return " ".join(_NON_ALNUM.sub(" ", stripped).split())


def content_tokens(text: str) -> list[str]:
    return [t for t in fold(text).split() if len(t) >= 3 and t not in STOPWORDS]


_PLURALS = (("oes", "ao"), ("aes", "ao"), ("ais", "al"), ("eis", "el"), ("ns", "m"))


def stem(token: str) -> str:
    """Very light Portuguese stemmer: plural → singular, then drop a final vowel."""

    for suffix, replacement in _PLURALS:
        if token.endswith(suffix) and len(token) > len(suffix) + 2:
            token = token[: -len(suffix)] + replacement
            break
    else:
        if token.endswith("s") and len(token) > 3:
            token = token[:-1]
    if token[-1:] in ("a", "o", "e") and len(token) > 3:
        token = token[:-1]
    return token


def _token_matches(token: str, stems: set[str], prefixes: set[str]) -> bool:
    stemmed = stem(token)
    if stemmed in stems:
        return True
    # Derivations sharing a 6-letter root (inflacao / inflacionaria).
    return len(stemmed) >= 7 and stemmed[:6] in prefixes


def token_overlap(claim: str, evidence: str) -> float:
    """Fraction of the claim's content tokens supported by the evidence text (0..1)."""

    tokens = content_tokens(claim)
    if not tokens:
        folded = fold(claim)
        return 1.0 if folded and folded in fold(evidence) else 0.0
    stems = {stem(v) for v in fold(evidence).split()}
    prefixes = {v[:6] for v in stems if len(v) >= 7}
    matched = sum(1 for t in tokens if _token_matches(t, stems, prefixes))
    return matched / len(tokens)


_QUOTE_RE = re.compile(r"[\"“”«»](.+?)[\"“”«»]")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def strip_fabricated_quotes(text: str, transcript_folded: str) -> tuple[str, int]:
    """Remove sentences quoting text that does not literally appear in the transcript.

    Quotation marks attribute words to a speaker; an AI paraphrase must never be presented
    as a direct statement, so sentences with unverifiable quotes are removed.
    """

    kept: list[str] = []
    removed = 0
    for sentence in _SENTENCE_RE.split(text.strip()):
        quotes = [q for q in _QUOTE_RE.findall(sentence) if fold(q)]
        if any(fold(q) not in transcript_folded for q in quotes):
            removed += 1
            continue
        kept.append(sentence)
    return " ".join(kept).strip(), removed
