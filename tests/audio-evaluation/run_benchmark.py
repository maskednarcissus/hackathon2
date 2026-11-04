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

# --------------------------------------------------------------------------- normalisation


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return unicodedata.normalize(
        "NFC", "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    )


def normalize_text(text: str, accent_insensitive: bool = False) -> str:
    """Normalise Brazilian Portuguese text for scoring.

    NFKC → casefold → punctuation/symbols become spaces (hyphens and apostrophes between
    letters/digits are kept: ``guarda-chuva``, ``d'água``) → whitespace collapsed.
    Digits are kept as written (no number verbalisation).
    """
    text = unicodedata.normalize("NFKC", text).casefold()
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
    return " ".join("".join(out).split())


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


def compute_wer(reference: str, hypothesis: str, accent_insensitive: bool = False) -> float:
    ref = normalize_text(reference, accent_insensitive).split()
    hyp = normalize_text(hypothesis, accent_insensitive).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def compute_cer(reference: str, hypothesis: str, accent_insensitive: bool = False) -> float:
    ref = list(normalize_text(reference, accent_insensitive))
    hyp = list(normalize_text(hypothesis, accent_insensitive))
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def _count_phrase(tokens: list[str], phrase: list[str]) -> int:
    n = len(phrase)
    if n == 0 or n > len(tokens):
        return 0
    return sum(1 for i in range(len(tokens) - n + 1) if tokens[i : i + n] == phrase)


def terminology_accuracy(
    reference: str, hypothesis: str, terms: list[str], accent_insensitive: bool = False
) -> float | None:
    """Share of domain-term occurrences in the reference also produced in the hypothesis
    (``Σ min(hyp, ref) / Σ ref``). ``None`` when no listed term occurs in the reference."""
    ref = normalize_text(reference, accent_insensitive).split()
    hyp = normalize_text(hypothesis, accent_insensitive).split()
    found = expected = 0
    for term in terms:
        phrase = normalize_text(term, accent_insensitive).split()
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
        thresholds=thresholds,
    )
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
    result.reference_words = len(normalize_text(reference, accent_insensitive).split())
    result.hypothesis_words = len(normalize_text(hypothesis, accent_insensitive).split())
    result.wer = round(compute_wer(reference, hypothesis, accent_insensitive), 4)
    result.cer = round(compute_cer(reference, hypothesis, accent_insensitive), 4)
    terms = [str(t) for t in case.get("terms", [])]
    term_acc = terminology_accuracy(reference, hypothesis, terms, accent_insensitive)
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
) -> dict[str, Any]:
    manifest_path = Path(manifest_path)
    manifest = load_manifest(manifest_path)
    base = manifest_path.resolve().parent
    hyp_dir = Path(hypothesis_dir).resolve() if hypothesis_dir else None
    cases = [
        evaluate_case(case, base, hyp_dir, accent_insensitive)
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transcription Benchmark")
    parser.add_argument("--manifest", default="tests/audio-evaluation/benchmark-manifest.yaml")
    parser.add_argument("--output", default="tests/audio-evaluation/results")
    parser.add_argument("--hypothesis-dir", default=None)
    parser.add_argument("--accent-insensitive", action="store_true")
    parser.add_argument(
        "--require-data", action="store_true", help="treat missing data as a failure"
    )
    args = parser.parse_args(argv)

    results = run(args.manifest, args.hypothesis_dir, args.accent_insensitive)
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
