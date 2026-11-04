# Audit Service

Append-only, tamper-evident audit log (Phase 1 deliverable 1.18). Port `4011`.

## Responsibilities

- Immutable audit event log — no update or delete routes exist
- Recording lifecycle action catalog (`src/catalog.ts`, contract §9 of
  `docs/architecture/phase-1-capture-pipeline.md`): actions in the governed namespaces
  `device.`, `recording.`, `upload.`, `audio.`, `transcription.`, `diarization.`, `alert.`
  must be in the catalog; other namespaces (e.g. `lecture.viewed`) are free-form
- Per-tenant hash chain: `hash = sha256(prevHash + canonicalJson(body))`, genesis `prevHash` = 64 zeros
- Chain verification reporting the first broken link
- Recording lifecycle timeline per recording session

## API

| Method | Path                                | Notes                                                                                                                                                                       |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/audit-events`                  | `{tenantId?, actorId?, actorType, action, resourceType, resourceId?, metadata?, occurredAt?, ipAddress?}` → `201` with `sequence`, `prevHash`, `hash`; `422 unknown_action` |
| `GET`  | `/v1/audit-events`                  | filters `tenantId, resourceType, resourceId, action, from, to`; `limit` (≤ 500) + opaque `cursor` → `{items, nextCursor}`                                                   |
| `GET`  | `/v1/audit-events/verify?tenantId=` | `{valid, eventCount, headHash, firstBrokenLink: {eventId, sequence, reason}}`; reasons `sequence_gap`, `prev_hash_mismatch`, `hash_mismatch`                                |
| `GET`  | `/v1/recordings/:id/lifecycle`      | lifecycle events whose `resourceId` or `metadata.recordingSessionId` equals `:id`, ordered by `occurredAt`                                                                  |

Events without `tenantId` form a separate global chain.

## Storage

`src/repository.ts` defines `AuditRepository`; the in-memory implementation is used by tests and local dev.
A Postgres implementation must serialize appends per tenant (`pg_advisory_xact_lock(hashtext(tenant))`)
and the table must reject `UPDATE`/`DELETE` (trigger or revoked privileges).

## Development

```bash
pnpm --filter @ci/audit-service test
pnpm --filter @ci/audit-service dev
```

## Technology

TypeScript · Fastify · Zod · PostgreSQL (append-only)
