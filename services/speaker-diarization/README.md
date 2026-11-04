# Speaker Diarization Service

Phase 1 deliverable **1.12**. Assigns **anonymous** speaker labels (`SPEAKER_1`, `SPEAKER_2`, …)
to transcript segments. It never infers who a speaker is (LGPD; contract §8).

## Methods

1. **Provider tags** — when every transcript segment carries a provider speaker tag/label,
   tags are mapped to `SPEAKER_n` by first appearance; no audio is read.
2. **Acoustic fallback** (NumPy only) — 1.5 s windows / 0.75 s hop, energy-based speech gating,
   40-band log-mel spectral-shape embeddings (loudness-invariant), average-linkage agglomerative
   clustering on cosine distance (`DIARIZATION_DISTANCE_THRESHOLD`, `DIARIZATION_MAX_SPEAKERS`),
   tiny-cluster absorption, majority smoothing, turn building, and max-overlap assignment of
   transcript segments. Long recordings are processed audio segment by audio segment (bounded
   memory) and clustered on a subsample. See `src/speaker_diarization/engine.py`.

The acoustic threshold was tuned on synthetic voices only; it must be calibrated on the field
benchmark corpus (Phase 6.1 covers overlapping speech and multi-turn improvements).

## API (port 8004)

| Method | Path                                 |                                                                                                                                                                                                                              |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                            |                                                                                                                                                                                                                              |
| `POST` | `/v1/diarizations`                   | `{transcriptId, recordingSessionId?, institutionId?, maxSpeakers?, audio?: {storageUri \| wavBase64 \| segments[]}, segments:[{segmentIndex,startMs,endMs,speakerTag?,speakerLabel?}]}` → assignments, turns, `speakerCount` |
| `POST` | `/v1/events/transcription-completed` | Pub/Sub push endpoint; fetches segments from transcript-management, reads `data.audioSegments` (or `data.storageUri`)                                                                                                        |

Results are written with `PUT /v1/transcripts/{id}/speakers` and announced as
`diarization.completed`; successes and failures are audited.

Audio loaders: `file://` / paths (`AUDIO_LOCAL_ROOT` confinement) and `gs://`
(`AUDIO_GCS_ENABLED=true`, `[gcp]` extra). Configuration: `src/speaker_diarization/config.py`.

## Development

```bash
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
uvicorn main:app --app-dir src --port 8004
```

## Integration (Postgres, event bus, security)

* `DATABASE_URL` → `adapters/postgres.py`: `speaker_turns` replaced atomically per transcript
  (advisory lock; `processing_version` column from `data/migrations/pending/speaker-diarization.sql`)
  and `processed_events` (consumer `speaker-diarization`). Unset → in-memory.
  `GET /v1/diarizations/{transcriptId}/turns` reads them back.
* Events: `EVENT_BUS_URL` → `POST {url}/v1/topics/{type}:publish`; `PUBSUB_PROJECT_ID` → Pub/Sub;
  else logged. The push route is idempotent by `eventId` and answers 2xx only after processing.
* `INTERNAL_API_TOKEN` → `x-internal-token` required on `/v1/events/*` and sent on outbound calls.
* transcript-management segments are read page by page (`cursor`/`limit=50`); the speakers `PUT`
  also sends `method` (`provider_tags` | `acoustic_clustering`) and `processingVersion` for
  `transcripts.diarization_method/_version`.
* Postgres tests: `TEST_DATABASE_URL=postgresql://… pytest` (fresh `ci_test_*` DB per module).

## Technology

Python · FastAPI · NumPy · Pub/Sub
