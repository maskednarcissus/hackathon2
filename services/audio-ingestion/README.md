# Audio Ingestion Service

Receives recording metadata and chunked audio uploads from classroom devices, checks
integrity with SHA-256, stores audio encrypted at rest and publishes `recording.uploaded`.
Phase 1 deliverables **1.5** (encrypted chunked upload with integrity check) and **1.7**
(recording metadata ingestion). The contract is in
[`docs/architecture/phase-1-capture-pipeline.md`](../../docs/architecture/phase-1-capture-pipeline.md) (§3, §5, §6, §9).

## Endpoints (port 8001)

All `/v1` routes require a **signed device request** (Ed25519, `CI-DEVICE-V1` canonical
string, `X-Device-Id` / `X-Device-Timestamp` / `X-Device-Signature`, ±300 s clock skew).
Device keys are resolved through device-management
`GET /internal/v1/devices/{id}/public-key`; `revoked` / `decommissioned` devices get `403`.

| Method | Path                              | Purpose                                                                                                                                                                                                        |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                         | Health check (public)                                                                                                                                                                                          |
| `POST` | `/v1/recordings`                  | Register recording metadata. `201` created, `200` when the same `(deviceId, localRecordingId)` is re-sent, `409` if it was registered with different content or the device/classroom assignment does not match |
| `GET`  | `/v1/recordings/{id}`             | Recording session (only for the device that owns it)                                                                                                                                                           |
| `POST` | `/v1/recording-events`            | Device-reported `recording.started` / `recording.stopped` → audit + event                                                                                                                                      |
| `POST` | `/v1/uploads`                     | Start an upload; an open upload for the same recording is returned (`200`) for resume                                                                                                                          |
| `GET`  | `/v1/uploads/{id}`                | Status and `receivedChunks`                                                                                                                                                                                    |
| `PUT`  | `/v1/uploads/{id}/chunks/{index}` | Raw chunk, header `X-Chunk-SHA256`. Re-sending the same chunk is a no-op; different content for a stored index → `409`                                                                                         |
| `POST` | `/v1/uploads/{id}/complete`       | Assemble, verify size and whole-file SHA-256, store, publish `recording.uploaded`. Missing chunks → `409`; mismatch → `422`, upload `failed`, `upload.failed` published                                        |

Validation: `audioFormat` = `wav_pcm_s16le`; `sampleRate` ∈ {16000, 22050, 24000, 32000,
44100, 48000}; `channels` 1–8; `endedAt > startedAt`; timestamps must carry an offset.
Chunks: 4 MiB default, 1 KiB – 16 MiB; every chunk except the last must be exactly
`chunkSizeBytes`.

Audio is stored at `recordings/{institutionId}/{yyyy}/{mm}/{dd}/{recordingSessionId}.wav`.

## Architecture

`src/audio_ingestion/` — `app.py` (FastAPI factory `create_app(deps)`), `service.py`
(use cases), `auth.py` + `signing.py` (device signatures), `models.py`, `ports.py`
(interfaces) and `adapters/`:

| Port                | Development / tests                                                                                      | Production                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ObjectStore`       | `EncryptedLocalObjectStore` — streaming AES-256-GCM (`CIENC1` frames bound to key, index and final flag) | `GcsObjectStore` — CMEK (`kms_key_name`), no overwrite                       |
| `EventPublisher`    | `InMemoryEventPublisher`, `LoggingEventPublisher`                                                        | `PubSubEventPublisher` (topic = event type)                                  |
| `DeviceKeyResolver` | `StaticDeviceKeyResolver`                                                                                | `HttpDeviceKeyResolver` (60 s cache)                                         |
| `AuditClient`       | `InMemoryAuditClient`                                                                                    | `HttpAuditClient` (`POST {AUDIT_URL}/v1/audit-events`, best effort)          |
| Repositories        | in-memory                                                                                                | PostgreSQL (`recording_sessions`, `upload_sessions`, `upload_chunks` — V002) |

## Configuration

| Variable                                                 | Default                           |                              |
| -------------------------------------------------------- | --------------------------------- | ---------------------------- |
| `AUDIO_STORAGE_BACKEND`                                  | `local`                           | `local` or `gcs`             |
| `AUDIO_LOCAL_STORAGE_DIR`                                | `$TMP/ci-audio-ingestion/objects` | shared with audio-processing |
| `AUDIO_ENCRYPTION_KEY`                                   | ephemeral (logged warning)        | base64, 32 bytes             |
| `GCS_AUDIO_BUCKET`, `GCS_KMS_KEY_NAME`, `GCP_PROJECT_ID` | —                                 | for `gcs` / `pubsub`         |
| `EVENT_PUBLISHER`                                        | `log`                             | `log` or `pubsub`            |
| `DEVICE_MANAGEMENT_URL`                                  | unset → no devices accepted       |                              |
| `AUDIT_URL`                                              | unset → in-memory                 |                              |
| `UPLOAD_STAGING_DIR`                                     | `$TMP/ci-audio-ingestion/staging` | in-flight chunks             |

## Development

```bash
pip install -e ".[dev]"          # add ".[gcp]" for Cloud Storage / Pub/Sub
uvicorn main:app --app-dir src --port 8001
ruff check . && ruff format --check . && mypy src/ && pytest
```

`tests/conftest.py` contains `SignedClient`, a test client that signs requests like a device.
