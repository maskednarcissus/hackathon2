"""Tests for the transcription benchmark runner (run with the shared venv:
``.venv/bin/pytest tests/audio-evaluation``)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

_HERE = Path(__file__).resolve().parent


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("run_benchmark", _HERE / "run_benchmark.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["run_benchmark"] = module
    spec.loader.exec_module(module)
    return module


rb = _load()


def _naive_distance(a: list[str], b: list[str]) -> int:
    dp = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, dp[0] = dp[0], i
        for j, y in enumerate(b, 1):
            prev, dp[j] = dp[j], min(dp[j] + 1, dp[j - 1] + 1, prev + (x != y))
    return dp[-1]


def test_normalization_portuguese() -> None:
    assert (
        rb.normalize_text("  Olá, Turma!  A PROVA é dia 12/05.") == "olá turma a prova é dia 12 05"
    )
    assert rb.normalize_text("guarda-chuva d'água — fim") == "guarda-chuva d'água fim"
    assert rb.normalize_text("Ação", accent_insensitive=True) == "acao"
    assert rb.normalize_text("ﬁm") == "fim"  # NFKC ligature


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("a b c d", "a x c d e"),
        ("", "a b"),
        ("a b", ""),
        ("o rato roeu a roupa do rei", "rato roeu roupa do rei de roma"),
        ("x y z", "z y x"),
    ],
)
def test_edit_distance_matches_reference_implementation(a: str, b: str) -> None:
    assert rb.edit_distance(a.split(), b.split()) == _naive_distance(a.split(), b.split())


def test_wer_and_cer() -> None:
    ref = "Hoje vamos estudar farmacocinética."
    assert rb.compute_wer(ref, "hoje vamos estudar farmacocinética") == 0.0
    assert rb.compute_wer(ref, "hoje vamos estudar fármaco cinética") == pytest.approx(2 / 4)
    assert rb.compute_wer(ref, "hoje vamos estudar farmacocinetica") == 0.25
    assert rb.compute_wer(ref, "hoje vamos estudar farmacocinetica", accent_insensitive=True) == 0
    assert rb.compute_cer("abc", "abd") == pytest.approx(1 / 3)
    assert rb.compute_wer("", "") == 0.0


def test_terminology_accuracy() -> None:
    ref = "O habeas corpus foi impetrado. Outro habeas corpus e a ementa."
    hyp = "o rabeas corpus foi impetrado outro habeas corpus e a ementa"
    acc = rb.terminology_accuracy(ref, hyp, ["habeas corpus", "ementa", "mandado de segurança"])
    assert acc == pytest.approx(2 / 3)
    assert rb.terminology_accuracy(ref, hyp, ["inexistente"]) is None


def _write_manifest(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    (data / "law.ref.txt").write_text(
        "O habeas corpus protege a liberdade de locomoção.", encoding="utf-8"
    )
    (data / "law.hyp.json").write_text(
        json.dumps(
            {
                "segments": [
                    {"text": "O habeas corpus protege"},
                    {"text": "a liberdade de locomoção."},
                ]
            }
        ),
        encoding="utf-8",
    )
    (data / "med.ref.txt").write_text("A anamnese do paciente foi completa.", encoding="utf-8")
    (data / "med.hyp.txt").write_text("a anamnésia do paciente foi completa", encoding="utf-8")
    manifest = {
        "version": "test",
        "test_cases": [
            {
                "id": "law",
                "discipline": "law",
                "reference_path": "data/law.ref.txt",
                "hypothesis_path": "data/law.hyp.json",
                "terms": ["habeas corpus"],
                "expected_wer_max": 0.1,
                "expected_terminology_accuracy_min": 0.9,
            },
            {
                "id": "med",
                "reference_path": "data/med.ref.txt",
                "hypothesis_path": "data/med.hyp.txt",
                "terms": ["anamnese"],
                "expected_wer_max": 0.1,
                "expected_terminology_accuracy_min": 0.9,
            },
            {"id": "missing", "reference_path": "data/none.txt", "expected_wer_max": 0.1},
        ],
    }
    path = tmp_path / "manifest.yaml"
    path.write_text(json.dumps(manifest), encoding="utf-8")  # JSON is valid YAML
    return path


def test_run_reports_pass_fail_and_missing(tmp_path: Path) -> None:
    results = rb.run(_write_manifest(tmp_path))
    by_id = {c["id"]: c for c in results["cases"]}
    assert by_id["law"]["status"] == "passed" and by_id["law"]["wer"] == 0.0
    assert by_id["med"]["status"] == "failed"
    assert by_id["med"]["wer"] == pytest.approx(1 / 6, abs=1e-4)
    assert any("terminology" in f for f in by_id["med"]["failures"])
    assert by_id["missing"]["status"] == "missing_data"
    s = results["summary"]
    assert (s["passed"], s["failed"], s["missingData"]) == (1, 1, 1)
    assert s["weightedWer"] == pytest.approx(1 / 14, abs=1e-4)  # 1 error / (8 + 6) reference words


def test_main_writes_reports_and_exit_codes(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path)
    out = tmp_path / "out"
    assert rb.main(["--manifest", str(manifest), "--output", str(out)]) == 1
    payload = json.loads((out / "results.json").read_text(encoding="utf-8"))
    assert payload["summary"]["cases"] == 3
    assert "| med | failed |" in (out / "report.md").read_text(encoding="utf-8")

    # Score a provider run from a directory: perfect hypotheses → pass.
    hyp_dir = tmp_path / "provider"
    hyp_dir.mkdir()
    (hyp_dir / "law.txt").write_text("o habeas corpus protege a liberdade de locomoção")
    (hyp_dir / "med.txt").write_text("a anamnese do paciente foi completa")
    code = rb.main(
        ["--manifest", str(manifest), "--output", str(out), "--hypothesis-dir", str(hyp_dir)]
    )
    assert code == 0
    code = rb.main(
        [
            "--manifest",
            str(manifest),
            "--output",
            str(out),
            "--hypothesis-dir",
            str(hyp_dir),
            "--require-data",
        ]
    )
    assert code == 1


def test_repository_manifest_loads_and_reports_missing_data(tmp_path: Path) -> None:
    results = rb.run(_HERE / "benchmark-manifest.yaml")
    assert results["summary"]["cases"] >= 4
    # Audio corpora are not versioned; until transcripts are dropped in, cases are skipped.
    assert all(c["status"] in ("passed", "failed", "missing_data") for c in results["cases"])


def test_language_aware_normalisation() -> None:
    assert rb.canonical_language(None) == "pt-BR"
    assert rb.canonical_language("es_MX") == "es-419"
    assert rb.canonical_language("EN") == "en-US"
    assert rb.canonical_language("fr-CA") == "fr-FR"
    with pytest.raises(ValueError):
        rb.canonical_language("de-DE")
    assert (
        rb.normalize_text("Pesquisa & Ensino: 50% da nota")
        == "pesquisa e ensino 50 por cento da nota"
    )
    assert rb.normalize_text("Research & teaching: 50%", language="en-US") == (
        "research and teaching 50 percent"
    )
    assert rb.normalize_text("¿Investigación & docencia? ¡Sí!", language="es-419") == (
        "investigación y docencia sí"
    )
    assert rb.normalize_text("L’œuvre d'art & la thèse", language="fr-FR") == (
        "l'oeuvre d'art et la thèse"
    )
    assert rb.normalize_text("don't stop", language="en-US") == "don't stop"
    assert rb.normalize_text("euh donc euh", language="fr-FR", drop_fillers=True) == "donc"
    assert rb.normalize_text("um so uh yes", language="en-US", drop_fillers=True) == "so yes"


def test_wer_uses_case_language(tmp_path: Path) -> None:
    data = tmp_path / "d"
    data.mkdir()
    (data / "ref.txt").write_text("Uh, the midterm is worth 30%.", encoding="utf-8")
    (data / "hyp.txt").write_text("the midterm is worth 30 percent", encoding="utf-8")
    manifest = {
        "test_cases": [
            {
                "id": "en",
                "language": "en-US",
                "reference_path": "d/ref.txt",
                "hypothesis_path": "d/hyp.txt",
                "expected_wer_max": 0.0,
            }
        ]
    }
    path = tmp_path / "m.yaml"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    plain = rb.run(path)["cases"][0]
    assert plain["language"] == "en-US" and plain["wer"] == pytest.approx(1 / 7, abs=1e-4)
    assert rb.run(path, drop_fillers=True)["cases"][0]["status"] == "passed"
