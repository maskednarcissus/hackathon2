# Transcription Service

Phase 1 deliverable **1.10**. Converts classroom audio segments into timestamped Brazilian
Portuguese transcript segments (contract: `docs/architecture/phase-1-capture-pipeline.md` §6, §8).

## Flow

1. `recording.segmented` (Pub/Sub push or raw envelope) or a direct request creates a job —
   idempotent per `recordingSessionId` (a failed job may be resubmitted).
2. Every audio segment is sent to the speech provider with bounded concurrency
   (`TRANSCRIPTION_MAX_CONCURRENCY`) and exponential-backoff retries on transient errors.
3. Word timestamps are offset by the segment start; words in overlapping segment edges are
   de-duplicated at the overlap midpoint.
4. Words are grouped into transcript segments at sentence punctuation, pauses > 1.2 s, provider
   speaker changes, or 30 s; confidence = mean word confidence.
5. The transcript is stored in transcript-management (`POST /v1/transcripts`), then
   `transcription.completed` / `transcription.failed` is published and audited.

## API (port 8003)

| Method | Path                             |                                                                                                                                                                             |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                        |                                                                                                                                                                             |
| `POST` | `/v1/transcriptions`             | `{recordingSessionId, scheduledClassId?, institutionId?, discipline?, language?, segments:[{index,startMs,endMs,storageUri}]}` → `202 {jobId}` (`200` if already submitted) |
| `GET`  | `/v1/transcriptions/{jobId}`     | job status, `transcriptId`, counts, failure reason                                                                                                                          |
| `POST` | `/v1/events/recording-segmented` | Pub/Sub push endpoint                                                                                                                                                       |

## Provider

`GoogleChirpProvider` — Speech-to-Text v2 `BatchRecognize`, model `chirp_2`, `pt-BR`, automatic
punctuation, word time offsets and word confidence, inline phrase-set adaptation from the
vocabulary catalog (`TRANSCRIPTION_VOCABULARY_PATH`, per institution × discipline; see
`src/transcription/vocabulary.py`). Install with `pip install -e ".[gcp]"`. Check Chirp 2
availability for the configured `SPEECH_LOCATION` (ADR-004 assumes `southamerica-east1`).

Configuration: see `src/transcription/config.py`.

## Development

```bash
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
uvicorn main:app --app-dir src --port 8003
```

## Languages (Phase 6.4)

`pt-BR` (default), `en-US`, `es-ES`, `es-419`, `fr-FR` (`src/transcription/languages.py`; aliases
such as `es_MX` → `es-419`). Resolution: `recording.segmented` / request `language` → class
context (`language` of the scheduled class, section or course) → `pt-BR`. The language selects
the Chirp code (overridable with `SPEECH_LANGUAGE_CODES`) and the vocabulary
(`config/vocabularies.json` → `"languages"`, and `transcription_vocabularies.language`). The
transcript and `transcription.completed` carry the effective language.

## Integration (Postgres, event bus, security)

* `DATABASE_URL` → `adapters/postgres.py`: `transcription_jobs` (create-if-absent on the partial
  unique index `uq_transcription_jobs_active`, atomic `queued → running` claim), vocabularies from
  `transcription_vocabularies` merged over the JSON catalog (platform-wide rows need
  `data/migrations/pending/transcription.sql`), `processed_events` (consumer `transcription`).
  Unset → in-memory.
* Events: `EVENT_BUS_URL` → `POST {url}/v1/topics/{type}:publish`; `PUBSUB_PROJECT_ID` → Pub/Sub;
  else logged. The push route is idempotent by `eventId`, processes the job **before** answering
  2xx, and answers `409` while another delivery is still running the job (bus retries).
* `INTERNAL_API_TOKEN` → `x-internal-token` required on `/v1/events/*` and sent on outbound calls.
* `classSectionId` / `institutionId` / discipline come from the `recording.segmented` payload, or
  from academic-integration (`GET /v1/scheduled-classes/{id}`, else `POST /v1/class-identification`
  with classroom + recording bounds) when `ACADEMIC_INTEGRATION_URL` is set, and are passed to
  `POST /v1/transcripts`. A `409 transcript_exists` is treated as success.
* Postgres tests: `TEST_DATABASE_URL=postgresql://… pytest` (fresh `ci_test_*` DB per module).

## Technology

Python · FastAPI · Google Cloud Speech-to-Text v2 (Chirp 2) · Pub/Sub
