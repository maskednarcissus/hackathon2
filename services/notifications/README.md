# Notifications Service

Port **4006**. Phase 1 scope: **recording failure alerting** (deliverable 1.17) per
[`docs/architecture/phase-1-capture-pipeline.md` §10](../../docs/architecture/phase-1-capture-pipeline.md).
Student notifications (push / email / in-app, preferences) arrive in Phase 3.

## Alert rules

| Rule                    | Trigger                                                      | Severity      | Auto-resolves when                         |
| ----------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------------ |
| `device_offline`        | no heartbeat > 3 min during a class window / > 5 min outside | high / low    | heartbeat back (≤ 3 min)                   |
| `recording_missed`      | window started + 5 min, no `recording.started` for the class | high          | `recording.started` / `recording.uploaded` |
| `failed_upload`         | `upload.failed`, or no upload 2 h after `recordStopAt`       | medium        | `recording.uploaded` / `upload.completed`  |
| `poor_audio_quality`    | `audio.quality_assessed` verdict `poor` / `unusable`         | medium / high | later verdict `good`/`acceptable`          |
| `transcription_failure` | `transcription.failed`                                       | medium        | `transcription.completed`                  |
| `low_storage`           | device `diskFreeBytes` < 1 GiB                               | medium        | ≥ 1 GiB                                    |

- Deduplication by `(rule, resourceId)` while the alert is unresolved; `occurrences` counts repeats.
- Re-notification at most every 30 min while `open`; acknowledged alerts are silent unless
  the severity escalates (which re-opens them and notifies immediately).
- Every raise / acknowledge / resolve is written to the audit service (non-fatal on failure).
- Windows with `recordingEnabled: false` never produce `recording_missed`.

## API

| Method | Path                                                                       | Purpose                                                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/v1/lifecycle-events`                                                     | ingest an event envelope (contract §6) — Pub/Sub push target → `202 {raised, updated, resolved}`                                                                                                       |
| `POST` | `/v1/alerts/evaluate`                                                      | time-based rules: `{ now?, classWindows: [...], devices: [...] }` — called every minute (Cloud Scheduler job that joins device-management `/v1/fleet/health` and academic-integration recording plans) |
| `GET`  | `/v1/alerts?status&severity&rule&classroomId&deviceId&institutionId&limit` | list (unresolved first, then severity)                                                                                                                                                                 |
| `GET`  | `/v1/alerts/:id`                                                           | alert + delivery log                                                                                                                                                                                   |
| `POST` | `/v1/alerts/:id/acknowledge`                                               | `{ actorId, note? }`                                                                                                                                                                                   |
| `POST` | `/v1/alerts/:id/resolve`                                                   | `{ actorId, note? }`                                                                                                                                                                                   |

Errors: `{ "error": { "code", "message", "details?" } }`.

## Configuration

| Env                                  | Meaning                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                               | default 4006                                                                                                                                                       |
| `ALERT_RECIPIENTS_JSON`              | `{"default":[{"channel":"email","address":"noc@…","minSeverity":"high"}],"institutions":{"<uuid>":[…]}}` — channels: `email`, `webhook` (address = URL), `console` |
| `MAIL_RELAY_URL`, `MAIL_RELAY_TOKEN` | HTTP mail relay: `POST {to, subject, text, metadata}`                                                                                                              |
| `AUDIT_URL`                          | audit service base URL (`POST /v1/audit-events`)                                                                                                                   |

Storage is behind the `AlertStore` port (`src/store.ts`); the in-memory adapter is used
until the Postgres adapter lands (tables `alerts`, `alert_deliveries`, `alert_class_marks`).

## Technology

TypeScript · Fastify · Zod · PostgreSQL (planned adapter) · HTTP mail relay
