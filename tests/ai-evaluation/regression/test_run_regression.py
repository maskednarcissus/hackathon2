"""Tests for the AI regression runner (Phase 6 §6.8)."""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_regression as rr  # noqa: E402
from suites import SUITES, RunContext  # noqa: E402


def test_compare_statuses_and_directions() -> None:
    base = {
        "s.precision": 0.95,
        "s.recall": 0.90,
        "s.f1": 0.80,
        "lecture_grounding.drop_rate": 0.30,
        "s.gone": 1.0,
    }
    current = {
        "s.precision": 0.94,  # within tolerance
        "s.recall": 0.85,  # regressed
        "s.f1": 0.90,  # improved
        "lecture_grounding.drop_rate": 0.40,  # lower-is-better and beyond its 0.05 tolerance
        "s.brand_new": 0.5,
    }
    rows = {
        r.metric: r
        for r in rr.compare(current, base, {"default": 0.02, "lecture_grounding.drop_rate": 0.05})
    }
    assert rows["s.precision"].status == "ok"
    assert rows["s.recall"].status == "regressed"
    assert rows["s.f1"].status == "improved"
    assert rows["lecture_grounding.drop_rate"].status == "regressed"
    assert rows["s.brand_new"].status == "new"
    assert rows["s.gone"].status == "missing"
    failing = {r.metric for r in rr.failures(list(rows.values()), have_baseline=True)}
    assert failing == {"s.recall", "lecture_grounding.drop_rate", "s.gone"}


def test_hard_limits_fail_even_without_baseline() -> None:
    rows = rr.compare(
        {"assistant.foreign_citation_leaks": 1.0, "prompt_contracts.pass_rate": 1.0}, None, {}
    )
    by = {r.metric: r.status for r in rows}
    assert by == {
        "assistant.foreign_citation_leaks": "hard_limit",
        "prompt_contracts.pass_rate": "new",
    }
    assert [r.metric for r in rr.failures(rows, have_baseline=False)] == [
        "assistant.foreign_citation_leaks"
    ]


def test_tolerance_lookup_prefers_metric_then_suite_then_default() -> None:
    tol = {"default": 0.02, "date_resolution": 0.0, "date_resolution.time_accuracy": 0.1}
    assert rr.tolerance_for("date_resolution.time_accuracy", tol) == 0.1
    assert rr.tolerance_for("date_resolution.date_accuracy", tol) == 0.0
    assert rr.tolerance_for("assistant.kind_accuracy", tol) == 0.02


def test_committed_baseline_passes_offline(tmp_path: Path) -> None:
    code = rr.main(["--output", str(tmp_path)])
    report = json.loads((tmp_path / "regression-offline.json").read_text())
    assert code == 0, [
        c for c in report["comparison"] if c["status"] in ("regressed", "hard_limit")
    ]
    assert report["passed"] is True
    assert {s["name"] for s in report["suites"]} == set(SUITES)
    assert (tmp_path / "regression-offline.md").read_text().startswith("# AI regression report")


def test_detects_a_regression_against_the_baseline(tmp_path: Path) -> None:
    datasets = tmp_path / "datasets"
    shutil.copytree(HERE / "datasets", datasets)
    spec = yaml.safe_load((datasets / "date_resolution.yaml").read_text())
    spec["cases"][0]["expected"]["date"] = "2026-11-21"  # simulate a resolver regression
    (datasets / "date_resolution.yaml").write_text(yaml.safe_dump(spec, allow_unicode=True))
    results = asyncio.run(rr.run_suites(RunContext(datasets=datasets), ["date_resolution"]))
    baseline = rr.load_baseline(rr.BASELINE)
    base = {
        k: v
        for k, v in baseline["modes"]["offline"]["metrics"].items()
        if k.startswith("date_resolution.")
    }
    rows = rr.compare(rr.flatten(results), base, baseline["tolerances"])
    failing = {r.metric for r in rr.failures(rows, have_baseline=True)}
    assert "date_resolution.date_accuracy" in failing
    assert results[0].failed_cases[0].id == "abs-day-month"


def test_update_baseline_writes_mode_section(tmp_path: Path) -> None:
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps({"version": 1, "tolerances": {"default": 0.02}, "modes": {}}))
    code = rr.main(
        [
            "--suite",
            "date_resolution",
            "--baseline",
            str(path),
            "--output",
            str(tmp_path),
            "--update-baseline",
        ]
    )
    assert code == 0
    data = json.loads(path.read_text())
    metrics = data["modes"]["offline"]["metrics"]
    assert metrics["date_resolution.date_accuracy"] == 1.0
    assert data["tolerances"] == {"default": 0.02}
    # a subsequent run against the new baseline passes
    assert (
        rr.main(["--suite", "date_resolution", "--baseline", str(path), "--output", str(tmp_path)])
        == 0
    )


def test_live_requires_gateway_url() -> None:
    with pytest.raises(SystemExit):
        rr.main(["--live"])


def test_unknown_suite_is_rejected() -> None:
    with pytest.raises(SystemExit):
        asyncio.run(rr.run_suites(RunContext(), ["nope"]))


def test_live_mode_scores_invariants_over_http() -> None:
    """--live: services reach the gateway over HTTP; only model-independent metrics are scored."""
    import httpx
    from harness import InProcessGateway

    gw = InProcessGateway()
    # a "live model" that answers everything with an unsupported professor statement
    gw.script(
        "assistant-answer",
        {
            "answer": [
                {
                    "kind": "professor_statement",
                    "text": "O professor disse algo não dito.",
                    "citationIds": ["s1"],
                }
            ]
        },
    )
    gw.script(
        "lecture-structuring",
        {
            "title": "Aula",
            "executiveSummary": "Resumo.",
            "topics": [],
            "concepts": [],
            "questions": [],
            "readingReferences": [],
        },
    )
    ctx = RunContext(
        live=True, gateway_url="http://gateway", live_transport=httpx.ASGITransport(app=gw.app)
    )
    results = {
        r.name: r
        for r in asyncio.run(
            rr.run_suites(ctx, ["assistant", "lecture_grounding", "prompt_contracts"])
        )
    }
    assert "kind_accuracy" not in results["assistant"].metrics  # needs scripted outputs
    assert results["assistant"].metrics["foreign_citation_leaks"] == 0
    assert results["assistant"].metrics["citation_validity"] == 1.0
    assert "item_recall" not in results["lecture_grounding"].metrics
    assert results["lecture_grounding"].metrics["citation_validity"] == 1.0
    assert results["prompt_contracts"].skipped == "offline only"
