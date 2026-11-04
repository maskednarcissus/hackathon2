# Lecture Intelligence Service

Turns transcripts into grounded, student-facing lecture materials. Phase 2 deliverables
**2.3** (title, topic outline, definitions, Q&A), **2.4** (executive summary), **2.5** (key concepts),
**2.6** (reading references), **2.7** (structured output validation) and **2.21** (hallucination prevention).
Contract: [`docs/architecture/phase-2-classroom-intelligence.md`](../../docs/architecture/phase-2-classroom-intelligence.md) §3.

Port **8006** · Python · FastAPI · calls `ai-gateway` (never a model SDK directly)

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/lectures/structure` | Structure a transcript (`institutionId` required for AI cost accounting) |
| `GET` | `/v1/lectures/{scheduledClassId}` | Latest structure for a class |
| `POST` | `/v1/events/transcript-created` · `/v1/events/diarization-completed` | Event handlers (raw envelope or Pub/Sub push); fetch the transcript from transcript-management, structure it, publish `lecture.structured`; duplicate `eventId`s are ignored |

## Pipeline

1. Segments are rendered as `[s<index> hh:mm:ss] text` and split on segment boundaries into chunks of
   at most `LECTURE_MAX_CHUNK_TOKENS` (default 12 000 estimated tokens).
2. **Map:** each chunk → `lecture-structuring` prompt (bounded concurrency).
3. **Reduce:** with more than one chunk, the partial titles/summaries/topics → `lecture-structuring-merge`;
   concepts, questions and reading references are merged deterministically (deduplicated, citations unioned).
4. **Grounding validation** (nothing from the model is trusted):
   * every item must cite existing segment indexes (`missing_citation`, `invalid_segment_reference`);
   * concept terms (≥ 60 % of content tokens), reading titles (≥ 60 %), questions (≥ 30 %), topic titles
     (≥ 1 token) and concept definitions (≥ 20 %) must be supported by the cited segments ±1 neighbour
     (accent-insensitive, light Portuguese stemming) — otherwise `ungrounded`, dropped;
   * unsupported authors / answers are removed (`ungrounded_authors`, `ungrounded_answer`);
   * sentences quoting words that are not literally in the transcript are removed (`fabricated_quote`) —
     AI explanations are never presented as professor statements;
   * topic `startMs/endMs` come from the cited segments, not from the model;
   * a suspected prompt injection reported by the gateway adds a `$ injection_suspected` flag.
5. Stored, `lecture.structured` published, `lecture.structured` audit event recorded.

## Configuration

`AI_GATEWAY_URL` (default `http://localhost:8005`), `TRANSCRIPT_MANAGEMENT_URL` (`http://localhost:4008`),
`AUDIT_SERVICE_URL`, `PUBSUB_PROJECT_ID` (enables Pub/Sub publishing, extra `gcp`), `LECTURE_MAX_CHUNK_TOKENS`.

## Development

```bash
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
uvicorn main:app --app-dir src --port 8006
```
