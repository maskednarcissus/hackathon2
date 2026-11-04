"""DER metric, synthetic fixtures and ``run_benchmark.py --diarization`` (Phase 6.1)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

_HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


dz = _load("diarization_benchmark", _HERE / "diarization_benchmark.py")
rb = _load("run_benchmark", _HERE / "run_benchmark.py")
T = dz.Turn


def test_der_perfect_and_label_permutation() -> None:
    ref = [T("A", 0, 5_000), T("B", 5_000, 10_000)]
    hyp = [T("SPEAKER_2", 0, 5_000), T("SPEAKER_1", 5_000, 10_000)]
    assert dz.der(ref, hyp)["der"] == 0.0


def test_der_components_without_collar() -> None:
    ref = [T("A", 0, 10_000), T("B", 10_000, 20_000)]
    # 2 s of B labelled as A (confusion), 1 s missed, 1 s false alarm after the end.
    hyp = [T("x", 0, 12_000), T("y", 12_000, 19_000), T("y", 20_000, 21_000)]
    r = dz.der(ref, hyp, collar_ms=0)
    assert r["confusion"] == pytest.approx(2.0)
    assert r["missed"] == pytest.approx(1.0)
    assert r["falseAlarm"] == pytest.approx(1.0)
    assert r["der"] == pytest.approx(4.0 / 20.0)


def test_der_scores_overlap() -> None:
    ref = [T("A", 0, 10_000), T("B", 4_000, 6_000)]
    single = [T("s1", 0, 10_000)]
    both = [T("s1", 0, 10_000), T("s2", 4_000, 6_000)]
    assert dz.der(ref, single, collar_ms=0)["missed"] == pytest.approx(2.0)
    assert dz.der(ref, both, collar_ms=0)["der"] == 0.0


def test_collar_forgives_boundaries() -> None:
    ref = [T("A", 0, 5_000), T("B", 5_000, 10_000)]
    hyp = [T("a", 0, 5_200), T("b", 5_200, 10_000)]
    assert dz.der(ref, hyp, collar_ms=0)["der"] > 0
    assert dz.der(ref, hyp, collar_ms=250)["der"] == 0.0


def test_rttm_and_json_loading(tmp_path: Path) -> None:
    rttm = tmp_path / "r.rttm"
    rttm.write_text("SPEAKER rec 1 0.00 2.50 <NA> <NA> prof <NA> <NA>\nnoise\n")
    assert dz.load_turns(rttm) == [T("prof", 0, 2_500)]
    js = tmp_path / "h.json"
    js.write_text(json.dumps({"turns": [{"speakerLabel": "SPEAKER_1", "startMs": 1, "endMs": 9}]}))
    assert dz.load_turns(js) == [T("SPEAKER_1", 1, 9)]


def test_synthetic_render_reference_has_overlap() -> None:
    synthetic = _load("syn", _HERE / "diarization" / "synthetic.py")
    audio, sr, truth = synthetic.render(
        {
            "seed": 1,
            "script": [{"speaker": "A", "seconds": 2}, {"speakers": ["A", "B"], "seconds": 1}],
        }
    )
    assert sr == 16_000 and len(audio) > 3 * sr
    assert [t.speaker for t in truth] == ["A", "A", "B"]
    assert truth[1].start_ms == truth[2].start_ms


def test_cli_small_manifest_and_missing_data(tmp_path: Path) -> None:
    manifest = {
        "cases": [
            {
                "id": "tiny",
                "expected_der_max": 0.2,
                "synthetic": {
                    "seed": 3,
                    "script": [
                        {"speaker": "A", "seconds": 8},
                        {"speaker": "B", "seconds": 6},
                        {"speaker": "A", "seconds": 6},
                    ],
                },
            },
            {"id": "labelled", "reference_path": "corpus/none.rttm", "audio_path": "x.wav"},
        ]
    }
    dz_dir = tmp_path / "dz"
    dz_dir.mkdir()
    (dz_dir / "manifest.yaml").write_text(json.dumps(manifest))
    (dz_dir / "synthetic.py").write_text((_HERE / "diarization" / "synthetic.py").read_text())
    out = tmp_path / "out"
    code = rb.main(
        [
            "--diarization",
            "--diarization-manifest",
            str(dz_dir / "manifest.yaml"),
            "--output",
            str(out),
        ]
    )
    payload = json.loads((out / "diarization-results.json").read_text())
    by_id = {c["id"]: c for c in payload["cases"]}
    assert by_id["tiny"]["status"] == "passed"
    assert by_id["tiny"]["results"]["v2"]["speakers"] == 2
    assert by_id["labelled"]["status"] == "missing_data"
    assert code == 0
    assert "pooled DER" in (out / "diarization-report.md").read_text()


def test_v2_improves_der_over_v1_on_synthetic_set() -> None:
    results = dz.evaluate(_HERE / "diarization" / "manifest.yaml", ["v1", "v2"])
    s = results["summary"]
    assert s["v2"]["der"] < s["v1"]["der"]
    assert s["v2"]["meanCaseDer"] < s["v1"]["meanCaseDer"]
    assert s["failed"] == 0
    synthetic = [c for c in results["cases"] if c["status"] != "missing_data"]
    assert len(synthetic) >= 6
    # Speaker-count estimate (eigengap + linking) matches the reference on every case.
    assert all(c["results"]["v2"]["speakers"] == c["referenceSpeakers"] for c in synthetic)
