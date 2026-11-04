# Device Management Service

Device registry, provisioning, cryptographic identity, classroom assignment, heartbeats and fleet
health (Phase 1 deliverables 1.1, 1.2, 1.3 — server side, and the data behind 1.16).
Contract: [`docs/architecture/phase-1-capture-pipeline.md`](../../docs/architecture/phase-1-capture-pipeline.md) §3–4.

Port `4004` · TypeScript · Fastify · zod · node:crypto (Ed25519)

## Device identity

1. An administrator creates a **provisioning token** bound to a serial number and institution.
   The token (`pt_…`) is returned once; only its SHA-256 is stored. Single-use, default expiry 72 h (max 720 h).
2. The device generates an Ed25519 key pair and calls `POST /v1/devices/register` with the token and its public key.
3. The service issues a **device certificate** `base64url(payload).base64url(signature)` signed with the device CA
   key (`DEVICE_CA_PRIVATE_KEY_PEM`; an ephemeral key is generated in development, refused in production).
   Validity 365 days. The CA public key is published at `GET /v1/device-ca/public-key`.
4. Every device call is signed (`CI-DEVICE-V1`, ±300 s skew). `src/signature.ts` exports
   `verifySignedRequest`, `signDeviceRequest`, `canonicalString` and the Fastify hook `createDeviceAuthHook` for reuse.
   Revoked/decommissioned devices get `403 device_revoked`; a device can only act on its own `:id` (`403 device_mismatch`).

## Derived status

Precedence: `decommissioned` > `maintenance` > `offline` (no heartbeat for 180 s) > `attention_required`
(disk < 1 GiB, CPU > 80 °C, > 20 buffered recordings, revoked) > `recording` > `uploading` (buffer not empty) > `online`.
Issues reported: `no_heartbeat, heartbeat_missed, low_disk, high_temperature, upload_backlog, unassigned,
certificate_expiring (< 30 days), certificate_revoked`. A sweep (every `STATUS_SWEEP_INTERVAL_MS`, default 30 s)
persists transitions, audits `device.status_changed` and publishes `device.heartbeat_missed`.

## Endpoints

Admin routes require `Authorization: Bearer $ADMIN_API_TOKEN` (when set) and accept `X-Actor-Id` (UUID) for audit.

| Method | Path                                  | Auth             | Purpose                                                                                                |
| ------ | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/health`                             | —                | liveness                                                                                               |
| POST   | `/v1/provisioning-tokens`             | admin            | `{ serialNumber, institutionId, expiresInHours? }`                                                     |
| POST   | `/v1/devices/register`                | token            | registration → `{ deviceId, certificate, certificatePayload }`                                         |
| GET    | `/v1/device-ca/public-key`            | —                | CA public key for certificate verification                                                             |
| GET    | `/v1/devices`                         | admin            | `?institutionId=&classroomId=`                                                                         |
| GET    | `/v1/devices/:id`                     | admin            | device + certificate                                                                                   |
| PUT    | `/v1/devices/:id/assignment`          | admin            | `{ classroomId }` — same-institution only, one active device per classroom, closes previous assignment |
| DELETE | `/v1/devices/:id/assignment`          | admin            | unassign                                                                                               |
| GET    | `/v1/devices/:id/assignments`         | admin            | assignment history                                                                                     |
| POST   | `/v1/devices/:id/revoke`              | admin            | `{ reason }`                                                                                           |
| POST   | `/v1/devices/:id/decommission`        | admin            |                                                                                                        |
| PUT    | `/v1/devices/:id/maintenance`         | admin            | `{ enabled }`                                                                                          |
| POST   | `/v1/devices/:id/heartbeat`           | device           | metrics → `{ status, issues, serverTime, classroomId, certificateExpiresAt }`                          |
| GET    | `/v1/devices/:id/recording-plan`      | device           | `?from=&to=` (default next 24 h, max 14 days) — proxies academic-integration                           |
| GET    | `/v1/fleet/health`                    | admin            | `?institutionId=&classroomId=&status=` → summary by status + per-device rows                           |
| GET    | `/v1/devices/:id/health`              | admin            | current health + heartbeat history (`?limit=`, default 60)                                             |
| GET    | `/internal/v1/devices/:id/public-key` | internal network | used by other services to verify signatures                                                            |
| POST   | `/internal/v1/status-sweep`           | internal network | run the status sweep now                                                                               |

Heartbeat body: `firmwareVersion, uptimeSeconds, cpuTempC, diskFreeBytes, diskTotalBytes, bufferQueueCount,
bufferQueueBytes, networkRssiDbm?, micLevelDbfs?, isRecording, currentScheduledClassId?, lastUploadAt?`.

## Configuration

| Variable                    | Default                                             |
| --------------------------- | --------------------------------------------------- |
| `PORT`                      | `4004`                                              |
| `DEVICE_CA_PRIVATE_KEY_PEM` | — (required in production; `\n` escapes accepted)   |
| `ADMIN_API_TOKEN`           | — (admin routes open when unset — development only) |
| `ORGANIZATION_URL`          | `http://localhost:4002`                             |
| `ACADEMIC_INTEGRATION_URL`  | `http://localhost:4003`                             |
| `AUDIT_URL`                 | `http://localhost:4011`                             |
| `STATUS_SWEEP_INTERVAL_MS`  | `30000`                                             |

Audit events (catalog §9): `device.provisioning_token_created`, `device.registered`, `device.assigned`,
`device.unassigned`, `device.certificate_revoked`, `device.status_changed`. Audit failures are logged, never fatal.
Events are currently published through `LoggingEventPublisher`; a Pub/Sub publisher plugs into the `EventPublisher` interface.

## Phase 4 — fleet console, diagnostics, remote commands (4.7)

Contract: [`docs/architecture/phase-4-institutional-intelligence.md`](../../docs/architecture/phase-4-institutional-intelligence.md) §3.

| Method | Path                                         | Auth            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | -------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/fleet`                                  | admin           | `?institutionId&campusId&status&firmwareVersion&q&sort&page&pageSize` — paged rows with classroom/campus names (from organization; `namesUnavailable: true` if it is down), `summary.byStatus` over the filtered set (before `status`). `sort` ∈ `serialNumber, status, lastSeenAt, firmwareVersion` (numeric-aware), `classroom, campus`; prefix `-` for descending. `q` matches serial, model, classroom name/code, campus name |
| GET    | `/v1/fleet/firmware`                         | admin           | `?institutionId` — version distribution (count, percent, device ids), `latestVersion`, `outdated`                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/v1/devices/:id/diagnostics`                | admin           | `?windowHours` (1–24, default 24) — latest heartbeat, uptime % (a heartbeat covers 180 s), expected/received/missed heartbeats and gaps, hourly upload-backlog trend, firmware history, certificate expiry, last 10 commands                                                                                                                                                                                                      |
| POST   | `/v1/devices/:id/commands`                   | admin           | `{ type: reboot\|self_test\|upload_now\|refresh_plan\|rotate_logs, requestedBy, ttlMinutes? (≤ 30) }` → `202 { commandId, status: "pending", expiresAt }`. An open command of the same type is returned instead (`deduplicated: true`); max 10 open per device (`429`)                                                                                                                                                            |
| GET    | `/v1/devices/:id/commands`                   | admin           | history (`?status&limit`)                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/v1/devices/:id/commands/:commandId`        | admin           | one command                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/v1/devices/:id/commands/:commandId/cancel` | admin           | cancel a pending/delivered command                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/v1/devices/:id/commands/:commandId/result` | device (signed) | `{ status: succeeded\|failed, output?, finishedAt }`                                                                                                                                                                                                                                                                                                                                                                              |

Command lifecycle: `pending → delivered → succeeded | failed`, or `expired` (30 min, swept and
checked lazily) / `cancelled`. Every heartbeat response carries
`commands: [{ commandId, type, issuedAt, expiresAt }]` with all open commands; delivered-but-unanswered
commands are re-sent until they expire (the device de-duplicates by id). A result is accepted for a
delivered command even after expiry; never-delivered commands, cancelled ones and conflicting second
results get `409`. An identical retried result is idempotent (`200`).
Audit actions: `device.command_issued`, `device.command_completed`, `device.command_expired`,
`device.command_cancelled`.

## Integration stage — persistence, events, internal auth

| Variable                                       | Effect                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | Postgres (`src/repository.pg.ts`) instead of the in-memory repository. Schema: `data/migrations/V*.sql` + `pending/device-management.sql`; the service never runs DDL. |
| `EVENT_BUS_URL`                                | publish events to `POST {EVENT_BUS_URL}/v1/topics/{type}:publish` (envelope JSON, `x-internal-token`)                                                                  |
| `PUBSUB_PROJECT_ID` (+ `PUBSUB_EMULATOR_HOST`) | publish to Google Pub/Sub over REST (metadata-server token) when no bus URL is set                                                                                     |
| `INTERNAL_API_TOKEN`                           | required as `x-internal-token` on `/internal/*` (public-key lookup, `POST /internal/v1/status-sweep` for Cloud Scheduler); also sent on outbound calls                 |
| `STATUS_SWEEP_INTERVAL_MS`                     | in-process sweep (default 30 s); `0` when Cloud Scheduler drives the sweep                                                                                             |

Atomic operations in Postgres: token consume + device upsert (`UPDATE … WHERE used_at IS NULL`),
assignment changes (row lock + `uq_capture_devices_active_classroom` / `uq_device_assignments_open`,
conflict → `409 classroom_occupied`), command creation (`ON CONFLICT … DO NOTHING` on
`uq_device_commands_open_type` → the existing open command is returned). Constraint backstops map to
`409 conflict` / `422 invalid_reference`.

Postgres suite: `TEST_DATABASE_URL=postgresql://… pnpm test` (creates and drops `ci_test_<random>`).
