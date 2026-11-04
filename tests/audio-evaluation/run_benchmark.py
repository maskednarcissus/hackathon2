"""
Classroom Intelligence — Transcription Benchmark Runner (Phase 0.6 / DoD 1.x WER target).

Computes Word Error Rate (WER), Character Error Rate (CER) and academic terminology
accuracy for each manifest case, compares them with the case thresholds and writes
``results.json`` and ``report.md`` to ``--output``.

Manifest case fields used here (paths are relative to the manifest file):

    reference_path:  human reference transcript (.txt, or .json transcript)
    hypothesis_path: system output (.txt, or transcript-management JSON with "segments")
    terms:           list of domain terms whose recognition is measured
    expected_wer_max, expected_terminology_accuracy_min, expected_cer_max (optional)

``--hypothesis-dir DIR`` overrides every case's hypothesis with ``DIR/<case id>.txt`` or
``DIR/<case id>.json`` so a provider run can be scored without editing the manifest.

Exit codes: 0 = all evaluated cases passed, 1 = at least one case failed (or, with
``--require-data``, a case had missing data).
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

# --------------------------------------------------------------------------- normalisation


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return unicodedata.normalize(
        "NFC", "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    )


#: Phase 6.4 languages (``pt-BR`` default). Aliases resolve like the transcription service.
SUPPORTED_LANGUAGES = ("pt-BR", "en-US", "es-ES", "es-419", "fr-FR")
_LANGUAGE_ALIASES = {
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
_LATAM_SPANISH = {"mx", "ar", "co", "cl", "pe", "ve", "uy", "py", "bo", "ec", "cr", "gt", "us"}

#: Symbols spoken as words, per language (applied before punctuation removal).
_SYMBOL_WORDS = {
    "pt": {"&": " e ", "%": " por cento ", "+": " mais ", "=": " igual "},
    "en": {"&": " and ", "%": " percent ", "+": " plus ", "=": " equals "},
    "es": {"&": " y ", "%": " por ciento ", "+": " más ", "=": " igual "},
    "fr": {"&": " et ", "%": " pour cent ", "+": " plus ", "=": " égal "},
}
#: Hesitation fillers removed with ``drop_fillers`` (never content words).
_FILLERS = {
    "pt": {"ahn", "hã", "hum", "humm", "éé", "ééé", "uhum"},
    "en": {"uh", "um", "uhm", "er", "erm", "hmm", "mm"},
    "es": {"eh", "ehm", "em", "mmm", "este…"},
    "fr": {"euh", "heu", "hum", "bah", "mmh"},
}
#: Ligatures NFKC keeps (French orthography) → scoring form.
_LIGATURES = {"fr": {"œ": "oe", "æ": "ae"}}


def canonical_language(code: str | None) -> str:
    """Normalise a language tag to one of ``SUPPORTED_LANGUAGES`` (default ``pt-BR``)."""
    if not code:
        return "pt-BR"
    key = code.strip().replace("_", "-").lower()
    if key in _LANGUAGE_ALIASES:
        return _LANGUAGE_ALIASES[key]
    base, _, region = key.partition("-")
    if base == "es" and (region in _LATAM_SPANISH or region.isdigit()):
        return "es-419"
    if base in ("pt", "en", "es", "fr"):
        return _LANGUAGE_ALIASES[base]
    raise ValueError(f"unsupported language {code!r}; expected one of {SUPPORTED_LANGUAGES}")


def normalize_text(
    text: str,
    accent_insensitive: bool = False,
    language: str = "pt-BR",
    drop_fillers: bool = False,
) -> str:
    """Language-aware normalisation for scoring (Phase 6.4).

    NFKC → casefold → language ligatures (fr ``œ``→``oe``) → spoken symbols (``&``, ``%``,
    ``+``, ``=`` → the language's words) → punctuation/symbols become spaces (hyphens and
    apostrophes between letters/digits are kept: ``guarda-chuva``, ``d'água``, ``l'école``,
    ``don't``) → optional filler removal → whitespace collapsed. Digits are kept as written.
    """
    base = canonical_language(language).split("-")[0]
    text = unicodedata.normalize("NFKC", text).casefold()
    for lig, repl in _LIGATURES.get(base, {}).items():
        text = text.replace(lig, repl)
    for sym, words in _SYMBOL_WORDS[base].items():
        text = text.replace(sym, words)
    if accent_insensitive:
        text = _strip_accents(text)
    out: list[str] = []
    for i, ch in enumerate(text):
        cat = unicodedata.category(ch)
        if cat[0] in ("P", "S"):
            joiner = ch in "-'’"
            prev_ok = i > 0 and text[i - 1].isalnum()
            next_ok = i + 1 < len(text) and text[i + 1].isalnum()
            if joiner and prev_ok and next_ok:
                out.append("-" if ch == "-" else "'")
            else:
                out.append(" ")
        else:
            out.append(ch)
    tokens = "".join(out).split()
    if drop_fillers:
        fillers = _FILLERS[base]
        tokens = [t for t in tokens if t not in fillers]
    return " ".join(tokens)


# --------------------------------------------------------------------------- edit distance


def edit_distance(reference: list[Any], hypothesis: list[Any]) -> int:
    """Levenshtein distance between token sequences (row-vectorised with NumPy)."""
    if not reference:
        return len(hypothesis)
    if not hypothesis:
        return len(reference)
    vocab: dict[Any, int] = {}
    ref = np.fromiter((vocab.setdefault(t, len(vocab)) for t in reference), dtype=np.int64)
    hyp = np.fromiter((vocab.setdefault(t, len(vocab)) for t in hypothesis), dtype=np.int64)
    cols = np.arange(len(hyp) + 1, dtype=np.int64)
    prev = cols.copy()
    for i, token in enumerate(ref, start=1):
        cand = np.empty_like(prev)
        cand[0] = i
        # substitution/match and deletion
        cand[1:] = np.minimum(prev[:-1] + (hyp != token), prev[1:] + 1)
        # insertion: row[j] = min(cand[j], row[j-1] + 1) ⇔ cummin(cand - j) + j
        prev = np.minimum.accumulate(cand - cols) + cols
    return int(prev[-1])


def compute_wer(
    reference: str,
    hypothesis: str,
    accent_insensitive: bool = False,
    language: str = "pt-BR",
    drop_fillers: bool = False,
) -> float:
    ref = normalize_text(reference, accent_insensitive, language, drop_fillers).split()
    hyp = normalize_text(hypothesis, accent_insensitive, language, drop_fillers).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def compute_cer(
    reference: str,
    hypothesis: str,
    accent_insensitive: bool = False,
    language: str = "pt-BR",
    drop_fillers: bool = False,
) -> float:
    ref = list(normalize_text(reference, accent_insensitive, language, drop_fillers))
    hyp = list(normalize_text(hypothesis, accent_insensitive, language, drop_fillers))
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def _count_phrase(tokens: list[str], phrase: list[str]) -> int:
    n = len(phrase)
    if n == 0 or n > len(tokens):
        return 0
    return sum(1 for i in range(len(tokens) - n + 1) if tokens[i : i + n] == phrase)


def terminology_accuracy(
    reference: str,
    hypothesis: str,
    terms: list[str],
    accent_insensitive: bool = False,
    language: str = "pt-BR",
) -> float | None:
    """Share of domain-term occurrences in the reference also produced in the hypothesis
    (``Σ min(hyp, ref) / Σ ref``). ``None`` when no listed term occurs in the reference."""
    ref = normalize_text(reference, accent_insensitive, language).split()
    hyp = normalize_text(hypothesis, accent_insensitive, language).split()
    found = expected = 0
    for term in terms:
        phrase = normalize_text(term, accent_insensitive, language).split()
        r = _count_phrase(ref, phrase)
        if r:
            expected += r
            found += min(r, _count_phrase(hyp, phrase))
    return found / expected if expected else None


# --------------------------------------------------------------------------- manifest / IO


def load_manifest(manifest_path: str | Path) -> dict[str, Any]:
    with open(manifest_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{manifest_path}: manifest must be a mapping")
    return data


def load_transcript_text(path: Path) -> str:
    """Plain text, or a transcript JSON (``{"segments": [{"text": ...}]}`` or a list)."""
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() != ".json":
        return raw
    data = json.loads(raw)
    segments = data.get("segments", []) if isinstance(data, dict) else data
    if isinstance(data, dict) and "text" in data and not segments:
        return str(data["text"])
    return " ".join(str(s.get("text", "")) for s in segments if isinstance(s, dict))


@dataclass
class CaseResult:
    id: str
    status: str  # passed | failed | missing_data
    discipline: str | None = None
    acoustic_condition: str | None = None
    language: str = "pt-BR"
    reference_words: int | None = None
    hypothesis_words: int | None = None
    wer: float | None = None
    cer: float | None = None
    terminology_accuracy: float | None = None
    thresholds: dict[str, float] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)


def _resolve_hypothesis(
    case: dict[str, Any], base: Path, hypothesis_dir: Path | None
) -> Path | None:
    if hypothesis_dir is not None:
        for ext in (".txt", ".json"):
            candidate = hypothesis_dir / f"{case['id']}{ext}"
            if candidate.exists():
                return candidate
        return hypothesis_dir / f"{case['id']}.txt"
    value = case.get("hypothesis_path")
    return base / str(value) if value else None


def evaluate_case(
    case: dict[str, Any],
    base: Path,
    hypothesis_dir: Path | None = None,
    accent_insensitive: bool = False,
    drop_fillers: bool = False,
    default_language: str = "pt-BR",
) -> CaseResult:
    thresholds = {
        k: float(case[k])
        for k in ("expected_wer_max", "expected_cer_max", "expected_terminology_accuracy_min")
        if case.get(k) is not None
    }
    result = CaseResult(
        id=str(case["id"]),
        status="missing_data",
        discipline=case.get("discipline"),
        acoustic_condition=case.get("acoustic_condition"),
        language=canonical_language(case.get("language") or default_language),
        thresholds=thresholds,
    )
    lang = result.language
    ref_path = base / str(case["reference_path"]) if case.get("reference_path") else None
    hyp_path = _resolve_hypothesis(case, base, hypothesis_dir)
    for label, path in (("reference", ref_path), ("hypothesis", hyp_path)):
        if path is None:
            result.missing.append(f"{label}: not configured")
        elif not path.exists():
            result.missing.append(f"{label}: {path} not found")
    if result.missing or ref_path is None or hyp_path is None:
        return result

    reference = load_transcript_text(ref_path)
    hypothesis = load_transcript_text(hyp_path)
    opts = (accent_insensitive, lang, drop_fillers)
    result.reference_words = len(normalize_text(reference, *opts).split())
    result.hypothesis_words = len(normalize_text(hypothesis, *opts).split())
    result.wer = round(compute_wer(reference, hypothesis, *opts), 4)
    result.cer = round(compute_cer(reference, hypothesis, *opts), 4)
    terms = [str(t) for t in case.get("terms", [])]
    term_acc = terminology_accuracy(reference, hypothesis, terms, accent_insensitive, lang)
    result.terminology_accuracy = None if term_acc is None else round(term_acc, 4)

    if "expected_wer_max" in thresholds and result.wer > thresholds["expected_wer_max"]:
        result.failures.append(f"WER {result.wer:.2%} > {thresholds['expected_wer_max']:.2%}")
    if "expected_cer_max" in thresholds and result.cer > thresholds["expected_cer_max"]:
        result.failures.append(f"CER {result.cer:.2%} > {thresholds['expected_cer_max']:.2%}")
    term_min = thresholds.get("expected_terminology_accuracy_min")
    if term_min is not None:
        if result.terminology_accuracy is None:
            result.failures.append("terminology accuracy required but no listed term in reference")
        elif result.terminology_accuracy < term_min:
            result.failures.append(
                f"terminology accuracy {result.terminology_accuracy:.2%} < {term_min:.2%}"
            )
    result.status = "failed" if result.failures else "passed"
    return result


def run(
    manifest_path: str | Path,
    hypothesis_dir: str | Path | None = None,
    accent_insensitive: bool = False,
    drop_fillers: bool = False,
    language: str | None = None,
) -> dict[str, Any]:
    manifest_path = Path(manifest_path)
    manifest = load_manifest(manifest_path)
    base = manifest_path.resolve().parent
    hyp_dir = Path(hypothesis_dir).resolve() if hypothesis_dir else None
    default_language = canonical_language(language or manifest.get("language"))
    cases = [
        evaluate_case(case, base, hyp_dir, accent_insensitive, drop_fillers, default_language)
        for case in manifest.get("test_cases", [])
    ]
    evaluated = [c for c in cases if c.status != "missing_data"]
    total_ref = sum(c.reference_words or 0 for c in evaluated)
    weighted_wer = (
        sum((c.wer or 0.0) * (c.reference_words or 0) for c in evaluated) / total_ref
        if total_ref
        else None
    )
    return {
        "manifest": str(manifest_path),
        "manifestVersion": manifest.get("version"),
        "generatedAt": datetime.now(UTC).isoformat(),
        "accentInsensitive": accent_insensitive,
        "dropFillers": drop_fillers,
        "languages": sorted({c.language for c in cases}),
        "summary": {
            "cases": len(cases),
            "evaluated": len(evaluated),
            "passed": sum(c.status == "passed" for c in cases),
            "failed": sum(c.status == "failed" for c in cases),
            "missingData": sum(c.status == "missing_data" for c in cases),
            "weightedWer": None if weighted_wer is None else round(weighted_wer, 4),
        },
        "cases": [asdict(c) for c in cases],
    }


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value:.2%}"


def render_markdown(results: dict[str, Any]) -> str:
    s = results["summary"]
    lines = [
        "# Transcription Benchmark Report",
        "",
        f"- Generated: {results['generatedAt']}",
        f"- Manifest: `{results['manifest']}` (version {results['manifestVersion']})",
        f"- Cases: {s['cases']} · evaluated {s['evaluated']} · passed {s['passed']} · "
        f"failed {s['failed']} · missing data {s['missingData']}",
        f"- Word-weighted WER: {_pct(s['weightedWer'])}",
        "",
        "| Case | Status | WER (max) | CER | Terminology (min) | Notes |",
        "|---|---|---|---|---|---|",
    ]
    for c in results["cases"]:
        th = c["thresholds"]
        wer = f"{_pct(c['wer'])} ({_pct(th.get('expected_wer_max'))})"
        term = (
            f"{_pct(c['terminology_accuracy'])} "
            f"({_pct(th.get('expected_terminology_accuracy_min'))})"
        )
        notes = "; ".join(c["failures"] or c["missing"])
        lines.append(f"| {c['id']} | {c['status']} | {wer} | {_pct(c['cer'])} | {term} | {notes} |")
    lines.append("")
    return "\n".join(lines)


def _diarization_main(args: argparse.Namespace) -> int:
    import diarization_benchmark as dz

    systems = [s.strip() for s in args.systems.split(",") if s.strip()]
    results = dz.evaluate(Path(args.diarization_manifest), systems, args.collar_ms)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    (out / "diarization-results.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    report = dz.render_markdown(results, systems)
    s = results["summary"]
    regression = False
    if "v1" in s and "v2" in s and s["v1"]["der"] is not None and s["v2"]["der"] is not None:
        delta = s["v1"]["der"] - s["v2"]["der"]
        regression = delta < 0
        report += f"\nv2 vs v1 pooled DER: {delta:+.2%} absolute improvement\n"
    (out / "diarization-report.md").write_text(report, encoding="utf-8")
    print(report)
    if s["failed"] or regression or (args.require_data and s["missingData"]):
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transcription / diarization benchmark")
    parser.add_argument("--manifest", default="tests/audio-evaluation/benchmark-manifest.yaml")
    parser.add_argument("--output", default="tests/audio-evaluation/results")
    parser.add_argument("--hypothesis-dir", default=None)
    parser.add_argument("--accent-insensitive", action="store_true")
    parser.add_argument("--drop-fillers", action="store_true", help="remove hesitation fillers")
    parser.add_argument("--language", default=None, help="default language for cases")
    parser.add_argument(
        "--require-data", action="store_true", help="treat missing data as a failure"
    )
    parser.add_argument(
        "--diarization", action="store_true", help="run the DER benchmark (Phase 6.1)"
    )
    parser.add_argument(
        "--diarization-manifest",
        default=str(Path(__file__).resolve().parent / "diarization" / "manifest.yaml"),
    )
    parser.add_argument("--systems", default="v1,v2", help="diarization engines to compare")
    parser.add_argument("--collar-ms", type=int, default=250)
    args = parser.parse_args(argv)
    if args.diarization:
        return _diarization_main(args)

    results = run(
        args.manifest,
        args.hypothesis_dir,
        args.accent_insensitive,
        args.drop_fillers,
        args.language,
    )
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    report = render_markdown(results)
    (out / "report.md").write_text(report, encoding="utf-8")
    print(report)

    s = results["summary"]
    if s["failed"] or (args.require_data and s["missingData"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
