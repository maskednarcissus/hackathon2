# Audio Processing Service

Assesses the quality of uploaded classroom audio and splits long recordings into
segments for transcription. Phase 1 deliverables **1.8** (SNR, clipping, silence
detection) and **1.9** (segmentation of long recordings). The contract is in
[`docs/architecture/phase-1-capture-pipeline.md`](../../docs/architecture/phase-1-capture-pipeline.md) (§6, §7).

## Pipeline

`recording.uploaded` → download and decrypt → verify SHA-256 → quality report →
publish `audio.quality_assessed` → if the verdict is `unusable`, stop here (audit records
`pipelineStopped: true`; notifications raises the `poor_audio_quality` incident) →
otherwise segment, store each segment WAV at
`recordings/…/{recordingSessionId}/segments/{index:04d}.wav` and publish
`recording.segmented` (with the recording's `startedAt`, `endedAt`, `institutionId` and,
when known, `classSectionId`, so transcription can resolve the class section).

Consumption is idempotent by `eventId` (`processed_events`, consumer `audio-processing`):
outputs are written and published first — with event ids derived from the consumed id
(`uuid5`) — and the event is marked processed last, in the same transaction as the
quality report, `audio_segments` rows and `recording_sessions.audio_quality_score`. A crash
or publish failure (non-2xx → redelivery) therefore completes the work instead of losing it;
a redelivered, already-processed event returns `status: "duplicate"` with the stored result.
Unknown recordings → `422 unknown_recording` (dead-lettered by the bus).

## Endpoints (port 8002)

| Method | Path                                                                                                | Purpose                                                                            |
| ------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/health`                                                                                           | Health check                                                                       |
| `POST` | `/v1/quality`                                                                                       | Body: WAV PCM s16le → quality report (§7). Non-WAV / non-16-bit → `415`            |
| `POST` | `/v1/segmentation?recordingSessionId&targetSeconds=300&maxSeconds=360&searchSeconds=30&overlapMs=0` | Body: WAV → segments with `storageUri` (stored under `adhoc/…`)                    |
| `POST` | `/v1/events/recording-uploaded`                                                                     | Pub/Sub push endpoint; accepts the raw envelope or `{"message":{"data":<base64>}}` |

## Quality assessment

Audio is streamed in 30 s blocks and reduced to 20 ms frame energies (a 90-minute
recording reduces to about 1 MB of frame data; the 90-minute test asserts analysis + segmentation < 30 s and < 120 MB peak).

| Metric                             | How                                      |
| ---------------------------------- | ---------------------------------------- |
| `rmsDbfs`, `peakDbfs`              | channel-mixed RMS / absolute peak, dBFS  |
| `noiseFloorDbfs`                   | 10th percentile of frame dB              |
| `snrDb`                            | 95th percentile − noise floor            |
| `clippingRatio`                    | samples at the int16 rails / all samples |
| `silenceRatio`, `longestSilenceMs` | frames below −50 dBFS                    |

Issues (contract thresholds): `clipping` > 0.1 %, `low_snr` < 15 dB, `excessive_silence`

> 60 %, `too_quiet` RMS < −45 dBFS, `too_short` < 60 s. Each issue lowers the score;
> the verdict is `good` (≥ 0.8 with no issues), `acceptable` (≥ 0.5), `poor` (≥ 0.25) or
> `unusable` (< 0.25, ≥ 95 % silence or < 1 s).

## Segmentation

Segments target 5 min and never exceed 6 min. Each cut goes to the quietest point
(energy smoothed over 300 ms) within ±30 s of the target, so cuts fall in pauses, not
mid-word. A small distance penalty breaks ties toward the target. You can set an
overlap (default 0, at most target/4).

## Architecture & configuration

`src/audio_processing/` — `wav.py` (streaming reader / range writer), `quality.py`,
`segmentation.py`, `pipeline.py` (`ProcessingService.handle_recording_uploaded`),
`app.py` (`create_app(deps)`), `ports.py`, `adapters/` (encrypted local store and GCS
CMEK store, in-memory / logging / Pub/Sub publishers, audit client).

Storage variables are shared with audio-ingestion (`AUDIO_STORAGE_BACKEND`,
`AUDIO_LOCAL_STORAGE_DIR`, `AUDIO_ENCRYPTION_KEY`, `GCS_AUDIO_BUCKET`,
`GCS_KMS_KEY_NAME`), plus `DATABASE_URL` (Postgres, unset → in-memory), `EVENT_BUS_URL`
(HTTP bus) or `PUBSUB_PROJECT_ID` (Pub/Sub), `INTERNAL_API_TOKEN`, `AUDIT_URL`,
`PROCESSING_WORK_DIR`, `SEGMENT_TARGET_SECONDS`, `SEGMENT_MAX_SECONDS`.

## Development

```bash
pip install -e ".[dev]"
uvicorn main:app --app-dir src --port 8002
ruff check . && ruff format --check . && mypy src/ && pytest
# Postgres scenarios (tests/test_processing_pg.py), skipped without TEST_DATABASE_URL:
TEST_DATABASE_URL="postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433" pytest
```
