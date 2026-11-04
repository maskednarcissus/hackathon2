"""Runs the event-extraction evaluation in-process and enforces the §9 thresholds."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_event_eval as ev  # noqa: E402


def test_event_extraction_meets_thresholds_with_heuristic_extractor() -> None:
    metrics, results = asyncio.run(ev.evaluate(HERE / "event-extraction-cases.yaml"))
    assert metrics["cases"] >= 40
    failing = {r.id: r.assertion_failures for r in results if not r.passed}
    assert ev.check_thresholds(metrics) == [], (metrics, failing)
    assert metrics["injection_driven_events"] == 0
    assert metrics["hallucination_rate"] == 0.0
    assert metrics["ambiguity_hold_rate"] == 1.0


def test_holdout_set_runs() -> None:
    metrics, _ = asyncio.run(ev.evaluate(HERE / "event-extraction-holdout.yaml"))
    assert metrics["cases"] == 8
    assert metrics["injection_driven_events"] == 0
    assert metrics["hallucination_rate"] == 0.0


def test_scoring_counts_false_positives_and_date_errors() -> None:
    cases = {
        "version": "test",
        "test_cases": [
            {
                "id": "wrong-date",
                "input": {"transcript": "A P1 vai ser dia 24/03.", "class_date": "2026-03-10"},
                "expected": {"events": [{"type": "examination", "event_date": "2026-03-25"}]},
            },
            {
                "id": "unexpected",
                "input": {"transcript": "O quiz é amanhã.", "class_date": "2026-03-10"},
                "expected": {"events": []},
            },
        ],
    }
    import tempfile

    import yaml

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8") as f:
        yaml.safe_dump(cases, f, allow_unicode=True)
    metrics, results = asyncio.run(ev.evaluate(Path(f.name)))
    assert metrics["true_positives"] == 0
    assert metrics["false_positives"] == 2
    assert metrics["date_accuracy"] == 0.0
    assert not any(r.passed for r in results)
    assert ev.check_thresholds(metrics)
