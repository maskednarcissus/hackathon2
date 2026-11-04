# Event Extraction Service

Phase 2 deliverables 2.7–2.13, 2.16, 2.17 (backend) and 2.21. Contract:
[`docs/architecture/phase-2-classroom-intelligence.md`](../../docs/architecture/phase-2-classroom-intelligence.md) §4–§5.

Python · FastAPI · port **8007**

## Pipeline

```
transcript segments
  → candidate detection (pt-BR keyword families, sentence/clause split, ±1 sentence context)
  → extractor: heuristic | llm (AI gateway, prompt `event-extraction`) | hybrid
  → deterministic date resolution (never the LLM)       dates.py
  → hallucination validation (quote / date / type / hypothetical / injection)   validation.py
  → multi-dimensional confidence                         validation.py
  → dedup within the class, then against the section's stored events
      same date → merged as a mention; new date → date-change proposal
  → calendar conflict check
  → publication policy → auto-publish or review queue
```

| Module | Purpose |
|---|---|
| `dates.py` | pt-BR resolver: `20 de novembro`, `dia 15`, `15/11(/2026)`, `dia 10 do mês que vem`, number words, `amanhã`, `depois de amanhã`, `hoje`, `daqui a duas semanas`, `em 15 dias`, `na próxima aula`/`aula que vem` (next scheduled class of the section), `semana que vem`, weekdays (`próxima segunda`, `sexta que vem`, `na quarta da semana que vem`), `do dia X para o dia Y`, times (`19h`, `19h30`, `às 7 da noite`, `14:15`, `meio dia`). Vague expressions (`final do mês`, `mês que vem`, `depois do feriado`, `em breve`, `lá pra maio`, `a definir`…) and conflicting dates → `eventDate: null`, `ambiguous: true`. Past dates are flagged. |
| `keywords.py` | Event-type keyword families, hypothetical/retrospective/negation/hedge/content-reference cues. |
| `injection.py` | Local prompt-injection signals (defence in depth on top of the gateway). |
| `extractors.py` | `HeuristicExtractor` (deterministic, offline/CI) and `LlmExtractor` (gateway, JSON schema). |
| `validation.py` | Hallucination rules (2.21) and confidence: `overall = 0.4·min + 0.6·geomean` of transcription, classification, date and course dimensions. |
| `service.py` | Pipeline, dedup, policy, professor review workflow, calendar publication, audit and events. |
| `http_clients.py` | Adapters for ai-gateway, calendar, academic-integration, transcript-management, audit, Pub/Sub. |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | |
| POST | `/v1/extractions` | `{transcriptId, scheduledClassId, recordingSessionId?, segments?, extractor?}` → `ExtractionResult` (events, deduplicated, validation stats, awaitingReview, published). Without `segments` the transcript is fetched from transcript-management. |
| POST | `/v1/events/transcript-ready` | Push handler for `transcript.created` / `diarization.completed` / `transcript.corrected` envelopes. |
| GET | `/v1/review-queue?professorId&status&classSectionId` | Default `status=awaiting_professor,awaiting_admin`, sorted by date (undated last). |
| GET | `/v1/events/{id}` | Full event with provenance, mentions, conflicts, change history. |
| POST | `/v1/events/{id}/confirm` | `{notes?}`. Confirming a date-change proposal applies the new date to the original event (with a `date_change` record) and republishes it. |
| POST | `/v1/events/{id}/edit` | `{changes:{title?,type?,eventDate?,eventTime?,description?}, reason?}` — implies confirm; on a published event it republishes and emits `event.updated`. |
| POST | `/v1/events/{id}/reject` | `{reason}` (required). Published events cannot be rejected. |
| POST | `/v1/events/{id}/publish` | Publishes a confirmed event (idempotent). |

Review actions require `X-Actor-Id` and `X-Actor-Role` (`professor` of the section, `admin`
or `coordinator`) until identity lands in Phase 3. Errors: `{"error": {"code", "message", "details?"}}`.

### Publication policy (2.17)

`autoPublish` (default **false**), `autoPublishMinConfidence` 0.92, `allowAutoPublishTypes`,
`requireProfessorReviewFor` (cancellations, reschedules and room changes by default),
`publishOnConfirm` (default true). An event is auto-published only when the policy allows it,
confidence ≥ threshold, it has a date, **no flags** (ambiguous, past, low transcription
confidence, injection suspected, duplicate) and the calendar conflict check succeeded with no
conflicts. Sections without a known professor go to `awaiting_admin`.

## Configuration

| Env | Default |
|---|---|
| `EVENT_EXTRACTOR` | `hybrid` (`llm`, `heuristic`) |
| `AI_GATEWAY_URL` | `http://localhost:8005` |
| `CALENDAR_URL` | `http://localhost:4005` |
| `ACADEMIC_INTEGRATION_URL` | `http://localhost:4003` |
| `TRANSCRIPT_MANAGEMENT_URL` | `http://localhost:4008` |
| `AUDIT_URL` | `http://localhost:4011` |
| `AUTO_PUBLISH`, `AUTO_PUBLISH_MIN_CONFIDENCE` | `false`, `0.92` |
| `EVENT_PUBLISHER=pubsub` + `GCP_PROJECT_ID` | Pub/Sub publishing (extra `gcp`) |
| `EVENT_EXTRACTION_PROMPT_VERSION` | gateway's active version |

> The event store is in-memory in this phase (see the V002 migration notes for the Postgres
> columns it maps to).

## Development

```bash
cd services/event-extraction
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
uvicorn main:app --app-dir src --port 8007
```
