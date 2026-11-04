# AI regression suite (Phase 6 · 6.8)

Golden datasets + a runner that scores every model-facing path and fails CI when a metric
regresses beyond tolerance against the committed [`baseline.json`](./baseline.json).

| Suite | Dataset | What is measured |
|---|---|---|
| `event_extraction` | `datasets/event_extraction.yaml` → `../event-extraction-cases.yaml` (50) + `../event-extraction-holdout.yaml` (8) | precision / recall / F1, date accuracy, ambiguity-hold rate, hallucination rate, injection-driven events (per set) |
| `date_resolution` | `datasets/date_resolution.yaml` (51) | case accuracy, date accuracy, ambiguity recall, false resolutions, time accuracy |
| `injection_resistance` | `datasets/injection_resistance.yaml` | events driven by injected speech, legit-event recall, assistant injection refusal / false-refusal rate, structuring injection flag rate, injected items kept |
| `lecture_grounding` | `datasets/lecture_grounding.yaml` (6 lectures, scripted good + hallucinated items) | item precision / recall, validation-flag accuracy, citation validity, fabricated-quote leaks, drop rate |
| `assistant` | `datasets/assistant.yaml` (10) | refusal accuracy, block-kind accuracy, citation accuracy and validity, foreign-section leaks, attribution leaks |
| `prompt_contracts` | built in | every service prompt (`event-extraction`, `lecture-structuring`, `assistant-answer`) renders through the real gateway with untrusted input fenced and never in the system prompt |

Offline (CI on every PR touching prompts, the gateway, event-extraction, lecture-intelligence or
this folder) the services run **in-process** and call the **real ai-gateway app** (prompt registry,
request validation, fencing, injection detection, schema enforcement) backed by its scripted
`FakeProvider`; event extraction uses the deterministic heuristic extractor. `--live` sends the same
requests to a running gateway with real models; metrics that depend on scripted outputs
(item/kind/citation accuracy, flag accuracy) are skipped and only model-independent invariants and
dataset metrics are scored, against the separate `live` baseline.

```bash
python tests/ai-evaluation/regression/run_regression.py                       # offline
python tests/ai-evaluation/regression/run_regression.py --suite assistant     # one suite
python tests/ai-evaluation/regression/run_regression.py --update-baseline     # after review
python tests/ai-evaluation/regression/run_regression.py --live --gateway-url http://localhost:8005
pytest tests/ai-evaluation/regression
```

Reports: `results/regression-<mode>.{json,md}` (gitignored; uploaded as CI artifacts and written to
the job summary).

## Pass / fail

* **Tolerances** (`baseline.json` → `tolerances`, `liveTolerances`): absolute; looked up by metric,
  then suite, then `default` (0.02 offline, 0.05 live). Safety-relevant suites use 0.
* **Hard limits** (`HARD_LIMITS` in `run_regression.py`) apply regardless of the baseline, e.g. 0
  injection-driven events, 0 hallucinated quotes, 100 % ambiguous events held, 100 % injection
  refusals, 100 % valid citations, 0 foreign-section citations, all prompt contracts passing.
  `--update-baseline` refuses to record a run that breaches one.
* A metric missing from the run but present in the baseline fails; new metrics are reported only.

## Current baseline (offline) and known issues

All metrics are at 1.0 / 0 except two recorded known issues, kept in the golden sets so that a fix
shows up as an improvement:

* `lecture_grounding.item_precision` 0.9655 / `flag_accuracy` 0.9375 — topic titles need only one
  supported token, so *"Divisão celular por mitose"* survives on a segment mentioning *"respiração
  celular"* (`biology-photosynthesis`).
* `injection_resistance.structuring_injected_items_kept` 2 — when the gateway flags an injection the
  structure is flagged (`$ injection_suspected`) but items sourced only from the injected segment
  (title and topic *"Criptomoedas"* in `st-override`) are kept.

> The event-extraction main set is in-sample for the heuristic extractor (see
> `../README.md`); the live baseline does not exist yet — record it from the first nightly run
> with credentials (`--live --update-baseline`) after reviewing the report.
