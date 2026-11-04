# AI Evaluation

Evaluation datasets and runners for AI-generated academic information.

## Event extraction (Phase 2 · deliverable 2.20)

| File                            | Purpose                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-extraction-cases.yaml`   | 50 pt-BR cases: exams, quizzes, assignments, projects, presentations, readings, cancellations, reschedules, room changes; absolute / relative / next-class / weekday dates and times; ambiguous, hedged, past, hypothetical, retrospective, negated and chatter cases; prompt injection; dedup within a class, across classes, and date-change proposals. |
| `event-extraction-holdout.yaml` | 8 cases written after the heuristic rules were tuned and never used for tuning.                                                                                                                                                                                                                                                                           |
| `run_event_eval.py`             | Runs the cases through the real `services/event-extraction` pipeline with in-memory adapters and an auto-publish policy (0.92).                                                                                                                                                                                                                           |
| `test_event_eval.py`            | pytest wrapper enforcing the thresholds with the heuristic extractor.                                                                                                                                                                                                                                                                                     |

```bash
python tests/ai-evaluation/run_event_eval.py                       # heuristic, offline
python tests/ai-evaluation/run_event_eval.py --extractor llm --gateway-url http://localhost:8005
python tests/ai-evaluation/run_event_eval.py --cases tests/ai-evaluation/event-extraction-holdout.yaml
pytest tests/ai-evaluation
```

Reports go to `tests/ai-evaluation/results/` (`event-extraction-eval.json` and `.md`); the
process exits 1 when a threshold is missed.

Metrics: precision / recall / F1 overall and per event type (match = type + date), date accuracy
(type-matched pairs with the right date), ambiguity-hold rate (expected-held events that were not
published), hallucination rate (published-from-pipeline events whose quote is not in the source),
validation drop rate (candidates rejected by the hallucination rules), injection-driven events.

Thresholds (contract §9): precision ≥ 0.95, recall ≥ 0.85, date accuracy ≥ 0.95, 100 % of
ambiguous cases held, 0 injection-driven events, 0 hallucinations.

> **Caveat.** The main case set was written by the same team that wrote the heuristic rules, so
> its scores are in-sample. The hold-out file and, above all, annotated real classroom
> transcripts are needed before claiming production accuracy. The LLM path is only measured
> when a gateway with model credentials is available (`--extractor llm`).

## Regression suite (Phase 6 · deliverable 6.8)

See [`regression/`](./regression/README.md): golden datasets for event extraction, date
resolution, injection resistance, lecture-structuring grounding, assistant citations/refusals and
prompt contracts, scored against a committed baseline in CI (`.github/workflows/ai-regression.yml`).

## Still planned

- Brazilian Portuguese transcription benchmarks (`tests/audio-evaluation`)
- Lecture structuring groundedness (lecture-intelligence)
- Speaker diarization quality
