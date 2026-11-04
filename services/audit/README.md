# Audit Service

Append-only, tamper-evident audit log (1.18) and content reports (3.15). Port `4011`.

## Responsibilities

- Immutable audit event log — no update or delete routes exist
- Action catalog (`src/catalog.ts`; phase-1 §9, phase-2 §8, phase-3 §2/§7). Governed namespaces
  `device.`, `recording.`, `upload.`, `audio.`, `transcription.`, `diarization.`, `alert.`, `transcript.`,
  `content.`, `auth.`, `ai.` accept only catalogued actions; `lecture.*`, `event.*`, `calendar.*` accept any
  well-formed action; other namespaces are free-form. `actorId` may be `null`
- Integration shapes: `institutionId` is accepted as an alias of `tenantId`; a non-UUID `actorId` (service name,
  e.g. `"transcription"`) is stored as `actorId: null` with `metadata.actorLabel`; `occurredAt` defaults to now
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

| `POST` | `/v1/content-reports` | `{reporterId, reporterRole, institutionId, resourceType, resourceId, classSectionId, reason, details?}` → `201`; an open report by the same reporter on the same resource → `200 {…, duplicate: true}` |
| `GET` | `/v1/content-reports?classSectionId\|institutionId&status=open\|resolved` | newest first |
| `GET` | `/v1/content-reports/:id` | |
| `POST` | `/v1/content-reports/:id/resolve` | `{actorId, actorRole?=professor, resolution: corrected\|no_change_needed\|duplicate\|invalid, notes?}`; `409` if already resolved |

Events without `tenantId` form a separate global chain. Content reports write audit `content.reported` /
`content.report_resolved` and publish events of the same names through `EventPublisher`
(`resourceId` may be composite, e.g. `<transcriptId>:<segmentIndex>`; it is kept in audit `metadata`).

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

## Integration stage

- `DATABASE_URL` → Postgres (`PgAuditRepository`, `PgContentReportRepository` in `src/repository.pg.ts`), unset → in-memory.
  Appends take a transaction-scoped advisory lock on the tenant plus `SELECT … FOR UPDATE` on the chain head; the
  `trg_audit_events_immutable` trigger rejects UPDATE/DELETE. Unknown tenants → `422 unknown_tenant`.
  Cursor pagination uses `audit_events.position` (`data/migrations/pending/audit.sql`).
- `EVENT_BUS_URL` → content report events go to `POST {EVENT_BUS_URL}/v1/topics/{type}:publish` (`src/platform/event-bus.ts`).
- `INTERNAL_API_TOKEN` → required as `x-internal-token` on `/internal/*`.
- `POST /internal/v1/dsr/{type}` (identity DataSubjectHandler): `access` exports the events where the subject is the actor
  and their content reports; `deletion`/`anonymization` → `not_applicable` (audit records kept 7 years, legal basis in
  the response) while authored content reports are anonymised; other types → `not_applicable`.
- Tests: `src/app.pg.test.ts` runs when `TEST_DATABASE_URL` is set (fresh database, all migrations + pending).
