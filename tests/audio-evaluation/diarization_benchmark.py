"""Diarization Error Rate (DER) benchmark — Phase 6.1 (``run_benchmark.py --diarization``).

DER = (missed speech + false alarm + speaker confusion) / total reference speech, computed
on a 10 ms grid with overlapped speech scored (every reference speaker counts) and an
optional forgiveness collar around reference boundaries (default 250 ms, NIST md-eval style).
Hypothesis speakers are mapped one-to-one to reference speakers by the assignment that
maximises overlapping time (exact, bitmask DP).

Cases (``diarization/manifest.yaml``):

* ``synthetic: {...}`` — rendered on the fly by ``diarization/synthetic.py`` and diarized by
  each requested system (``v1`` / ``v2`` engines from ``services/speaker-diarization``).
* ``reference_path`` (RTTM or JSON turns) + ``hypothesis_path`` — labelled real data scored
  as-is; missing files → ``missing_data``.
* ``reference_path`` + ``audio_path`` (16-bit PCM WAV) — diarized by each system.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SERVICE_SRC = REPO / "services" / "speaker-diarization" / "src"
FRAME_MS = 10


@dataclass(frozen=True)
class Turn:
    speaker: str
    start_ms: int
    end_ms: int


# --------------------------------------------------------------------------- IO


def load_turns(path: Path) -> list[Turn]:
    """RTTM (``SPEAKER file chan start dur <NA> <NA> spk ...``) or JSON
    (``[{speaker|speakerLabel, startMs, endMs}]`` or ``{"turns": [...]}``)."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".rttm":
        turns = []
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 8 and parts[0] == "SPEAKER":
                start = round(float(parts[3]) * 1000)
                turns.append(Turn(parts[7], start, start + round(float(parts[4]) * 1000)))
        return turns
    data = json.loads(text)
    items = data.get("turns", []) if isinstance(data, dict) else data
    return [
        Turn(
            str(t.get("speaker") or t.get("speakerLabel")),
            int(t.get("startMs", t.get("start_ms"))),
            int(t.get("endMs", t.get("end_ms"))),
        )
        for t in items
    ]


# --------------------------------------------------------------------------- DER


def _best_mapping(overlap: np.ndarray) -> dict[int, int]:
    """Max-weight one-to-one mapping hyp→ref (rows hyp, cols ref) by bitmask DP."""
    n_hyp, n_ref = overlap.shape
    if n_hyp == 0 or n_ref == 0:
        return {}
    transpose = n_ref > n_hyp
    mat = overlap.T if transpose else overlap  # rows = larger side, cols = smaller (≤ 12)
    rows, cols = mat.shape
    if cols > 12:
        raise ValueError("too many speakers for exact mapping")
    best: dict[int, tuple[float, list[int]]] = {0: (0.0, [])}
    for r in range(rows):
        nxt = dict(best)
        for mask, (score, picks) in best.items():
            for c in range(cols):
                if not mask & (1 << c):
                    cand = score + float(mat[r, c])
                    m2 = mask | (1 << c)
                    if m2 not in nxt or cand > nxt[m2][0]:
                        nxt[m2] = (cand, [*picks, r * 100 + c])
        best = nxt
    _, picks = max(best.values(), key=lambda v: v[0])
    pairs = [(p // 100, p % 100) for p in picks]
    return {c: r for r, c in pairs} if transpose else {r: c for r, c in pairs}


def der(reference: list[Turn], hypothesis: list[Turn], collar_ms: int = 250) -> dict[str, float]:
    """DER components (seconds) and rate. Overlap scored; collar excluded from scoring."""
    if not reference:
        return {"der": 0.0, "missed": 0.0, "falseAlarm": 0.0, "confusion": 0.0, "scored": 0.0}
    end = max(t.end_ms for t in reference + hypothesis)
    n = end // FRAME_MS + 1
    ref_spk = sorted({t.speaker for t in reference})
    hyp_spk = sorted({t.speaker for t in hypothesis})
    ref = np.zeros((len(ref_spk), n), dtype=bool)
    hyp = np.zeros((len(hyp_spk), n), dtype=bool)
    for t in reference:
        ref[ref_spk.index(t.speaker), t.start_ms // FRAME_MS : t.end_ms // FRAME_MS] = True
    for t in hypothesis:
        hyp[hyp_spk.index(t.speaker), t.start_ms // FRAME_MS : t.end_ms // FRAME_MS] = True
    scored = np.ones(n, dtype=bool)
    c = collar_ms // FRAME_MS
    if c > 0:
        for t in reference:
            for b in (t.start_ms // FRAME_MS, t.end_ms // FRAME_MS):
                scored[max(0, b - c) : b + c] = False
    ref, hyp = ref[:, scored], hyp[:, scored]
    overlap = (hyp[:, None, :] & ref[None, :, :]).sum(axis=2).astype(np.float64)
    mapping = _best_mapping(overlap)
    n_ref = ref.sum(axis=0)
    n_hyp = hyp.sum(axis=0)
    correct = np.zeros(ref.shape[1], dtype=np.int64)
    for h, r in mapping.items():
        correct += (hyp[h] & ref[r]).astype(np.int64)
    missed = np.maximum(0, n_ref - n_hyp).sum()
    false_alarm = np.maximum(0, n_hyp - n_ref).sum()
    confusion = (np.minimum(n_ref, n_hyp) - correct).sum()
    total = n_ref.sum()
    sec = FRAME_MS / 1000
    return {
        "der": float((missed + false_alarm + confusion) / max(total, 1)),
        "missed": float(missed * sec),
        "falseAlarm": float(false_alarm * sec),
        "confusion": float(confusion * sec),
        "scored": float(total * sec),
    }


# --------------------------------------------------------------------------- systems


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _service() -> tuple[Any, Any, Any]:
    if str(SERVICE_SRC) not in sys.path:
        sys.path.insert(0, str(SERVICE_SRC))
    from speaker_diarization import audio, engine, engine_v2

    return audio, engine, engine_v2


def run_system(system: str, samples: np.ndarray, sample_rate: int) -> tuple[list[Turn], int]:
    audio_mod, v1, v2 = _service()
    audio = audio_mod.Audio(samples=samples.astype(np.float32), sample_rate=sample_rate)
    if system == "v1":
        turns = v1.diarize_audio(audio)
        return [Turn(t.speaker, t.start_ms, t.end_ms) for t in turns], len(
            {t.speaker for t in turns}
        )
    if system == "v2":
        result = v2.diarize_audio_v2(audio)
        return [Turn(t.speaker, t.start_ms, t.end_ms) for t in result.turns], int(
            result.estimated_speakers
        )
    raise ValueError(f"unknown diarization system {system!r}")


def evaluate(manifest_path: Path, systems: list[str], collar_ms: int = 250) -> dict[str, Any]:
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    base = manifest_path.resolve().parent
    synthetic = _load_module("ci_diarization_synthetic", base / "synthetic.py")
    cases: list[dict[str, Any]] = []
    for case in manifest.get("cases", []):
        row: dict[str, Any] = {"id": case["id"], "results": {}, "status": "evaluated"}
        threshold = case.get("expected_der_max")
        reference: list[Turn] | None = None
        samples: np.ndarray | None = None
        rate = 16_000
        if "synthetic" in case:
            samples, rate, truth = synthetic.render(case["synthetic"])
            reference = [Turn(t.speaker, t.start_ms, t.end_ms) for t in truth]
        else:
            ref_path = base / str(case.get("reference_path", ""))
            if not case.get("reference_path") or not ref_path.exists():
                row["status"] = "missing_data"
                cases.append(row)
                continue
            reference = load_turns(ref_path)
            if case.get("hypothesis_path"):
                hyp_path = base / str(case["hypothesis_path"])
                if not hyp_path.exists():
                    row["status"] = "missing_data"
                    cases.append(row)
                    continue
                score = der(reference, load_turns(hyp_path), collar_ms)
                row["results"]["provided"] = {**score, "speakers": None}
            elif case.get("audio_path") and (base / str(case["audio_path"])).exists():
                audio_mod, _, _ = _service()
                decoded = audio_mod.decode_wav((base / str(case["audio_path"])).read_bytes())
                samples, rate = decoded.samples, decoded.sample_rate
            else:
                row["status"] = "missing_data"
                cases.append(row)
                continue
        row["referenceSpeakers"] = len({t.speaker for t in reference})
        if samples is not None:
            for system in systems:
                hyp, n_spk = run_system(system, samples, rate)
                row["results"][system] = {**der(reference, hyp, collar_ms), "speakers": n_spk}
        if threshold is not None:
            row["expectedDerMax"] = float(threshold)
            judged = row["results"].get("v2") or row["results"].get("provided")
            if judged is not None:
                row["status"] = "passed" if judged["der"] <= float(threshold) else "failed"
        cases.append(row)

    summary: dict[str, Any] = {"cases": len(cases), "collarMs": collar_ms}
    for system in [*systems, "provided"]:
        scored = [c["results"][system] for c in cases if system in c["results"]]
        if scored:
            total = sum(r["scored"] for r in scored)
            errors = sum(r["missed"] + r["falseAlarm"] + r["confusion"] for r in scored)
            summary[system] = {
                "der": round(errors / total, 4) if total else None,
                "meanCaseDer": round(float(np.mean([r["der"] for r in scored])), 4),
            }
    summary["failed"] = sum(c["status"] == "failed" for c in cases)
    summary["missingData"] = sum(c["status"] == "missing_data" for c in cases)
    return {"manifest": str(manifest_path), "summary": summary, "cases": cases}


def render_markdown(results: dict[str, Any], systems: list[str]) -> str:
    s = results["summary"]
    lines = [
        "# Diarization Benchmark Report (DER)",
        "",
        f"- Manifest: `{results['manifest']}` · collar {s['collarMs']} ms · overlap scored",
    ]
    for system in systems:
        if system in s:
            lines.append(
                f"- **{system}**: pooled DER {s[system]['der']:.2%} · "
                f"mean case DER {s[system]['meanCaseDer']:.2%}"
            )
    header = " | ".join(f"{sys_} DER (spk)" for sys_ in systems)
    lines += [
        "",
        f"| Case | Ref spk | {header} | Max | Status |",
        "|---" * (4 + len(systems)) + "|",
    ]
    for c in results["cases"]:
        cells = []
        for system in systems:
            r = c["results"].get(system)
            cells.append("—" if r is None else f"{r['der']:.2%} ({r['speakers']})")
        mx = c.get("expectedDerMax")
        lines.append(
            f"| {c['id']} | {c.get('referenceSpeakers', '—')} | {' | '.join(cells)} | "
            f"{'—' if mx is None else f'{mx:.0%}'} | {c['status']} |"
        )
    lines.append("")
    return "\n".join(lines)
