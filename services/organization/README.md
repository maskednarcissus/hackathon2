# Organization Service

Owns the tenant hierarchy (**holding company → institution → campus → classroom**) and the
institutional **recording policies** (Phase 1 deliverables 1.2, 1.15). Other services resolve
tenant (`institutionId`) and timezone for a classroom through `GET /v1/classrooms/:id`.

Port `4002` · TypeScript · Fastify · zod · (PostgreSQL adapter: Phase 1 V002 migration; in-memory repository today)

## Rules

- Every child must reference an existing parent (`404 not_found` otherwise); parents with children cannot be deleted (`409 has_children`).
- Uniqueness (case-insensitive): holding-company name; institution name per holding company; campus name per institution; classroom **code** per campus; policy name per institution.
- Campus timezones must be valid IANA zones (default `America/Sao_Paulo`).
- A campus/classroom may only reference a recording policy of its **own** institution (`422 invalid_recording_policy`).
- Exactly one default policy per institution; the first policy created becomes the default.
- Effective policy resolution for a classroom: classroom override → campus override → institution default.
  If none applies, `404 no_recording_policy` — devices must not record.

## Endpoints

| Method               | Path                                      | Notes                                                                |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| GET                  | `/health`                                 |                                                                      |
| POST / GET           | `/v1/holding-companies`                   |                                                                      |
| GET / PATCH / DELETE | `/v1/holding-companies/:id`               |                                                                      |
| POST / GET           | `/v1/institutions`                        | `?holdingCompanyId=`                                                 |
| GET / PATCH / DELETE | `/v1/institutions/:id`                    |                                                                      |
| GET                  | `/v1/institutions/:id/tree`               | institution + policies + campuses with classrooms                    |
| POST / GET           | `/v1/campuses`                            | `?institutionId=`; body may set `recordingPolicyId`                  |
| GET / PATCH / DELETE | `/v1/campuses/:id`                        | `recordingPolicyId: null` clears the override                        |
| POST / GET           | `/v1/classrooms`                          | `?campusId=` / `?institutionId=`                                     |
| GET / PATCH / DELETE | `/v1/classrooms/:id`                      | response includes `campusId`, `institutionId`, `timezone`            |
| GET                  | `/v1/classrooms/:id/recording-policy`     | `{ classroomId, campusId, institutionId, timezone, source, policy }` |
| POST / GET           | `/v1/institutions/:id/recording-policies` |                                                                      |
| GET / PATCH          | `/v1/recording-policies/:id`              |                                                                      |

Recording policy fields: `name, description?, legalBasis, requiresExplicitConsent, audioRetentionDays (90),
transcriptRetentionDays (365), summaryRetentionDays (730), allowRawAudioAccess, preRollMinutes (2, 0–30),
postRollMinutes (5, 0–60), recordingEnabled (true), isDefault`.

Errors always use `{ "error": { "code", "message", "details?" } }`.

## Development

```bash
pnpm --filter @ci/organization-service dev    # PORT=4002
pnpm --filter @ci/organization-service test
```

## Phase 4 — recording governance (4.10, 4.12)

Contract: [`docs/architecture/phase-4-institutional-intelligence.md`](../../docs/architecture/phase-4-institutional-intelligence.md) §5.

### Policy versions

Creating a policy stores **version 1**; every `PATCH /v1/recording-policies/:id` that changes a content
field (`name, description, legalBasis, requiresExplicitConsent, *RetentionDays, allowRawAudioAccess,
preRollMinutes, postRollMinutes, recordingEnabled`) appends an immutable version
(`changedFields`, optional `changeReason`, `actorId`). `isDefault` and no-op patches do not.
Policies expose `currentVersion` / `currentVersionId`; classroom resolution returns
`policyVersion` / `policyVersionId` so recordings reference the version in force.
New field: `extractedEventRetentionDays` (default 1825).

| Method | Path                                                 |
| ------ | ---------------------------------------------------- |
| GET    | `/v1/recording-policies/:id/versions` (newest first) |
| GET    | `/v1/recording-policies/:id/versions/:version`       |
| GET    | `/v1/recording-policy-versions/:versionId`           |

### Consent

| Method | Path                                                  | Notes                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/consents`                                        | `{ subjectType: student\|professor, subjectId, policyId, classSectionId?, given, actorId }`; records the policy version shown; supersedes the previous decision for the same subject/policy/scope |
| POST   | `/v1/consents/:id/withdraw`                           | `{ actorId, reason? }`                                                                                                                                                                            |
| GET    | `/v1/consents`                                        | `?policyId&classSectionId&subjectId&includeHistory=true` (at least one filter)                                                                                                                    |
| GET    | `/v1/consents/:id`                                    |                                                                                                                                                                                                   |
| GET    | `/v1/class-sections/:id/consent-status`               | `?policyId` (default: institution default policy)                                                                                                                                                 |
| GET    | `/v1/classrooms/:id/recording-policy?classSectionId=` | adds `consentSatisfied` + `consentStatus`                                                                                                                                                         |

A section-specific decision overrides a policy-wide one. When the policy requires explicit consent,
recording is allowed only if **every professor and every actively enrolled student** has a current,
non-withdrawn consent (`reason: "consent_missing"` otherwise). The roster comes from
academic-integration `GET /v1/class-sections/:id/roster → { classSectionId, institutionId, professorIds, studentIds }`
(`RosterClient`); it is not consulted by classroom resolution when the policy needs no consent.

### Legal holds & retention

| Method | Path                                            | Notes                                                                                                                        |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/legal-holds`                               | `{ institutionId, scope: { type: class_section\|recording\|subject, id }, reason, actorId }`                                 |
| DELETE | `/v1/legal-holds/:id`                           | body `{ actorId, reason? }` — releases (record kept)                                                                         |
| GET    | `/v1/legal-holds`                               | `?institutionId&active=true\|false`                                                                                          |
| POST   | `/v1/retention/run`                             | `{ institutionId, now?, dryRun?, actorId? }` → job (`now` may not be in the future unless `dryRun`)                          |
| GET    | `/v1/retention/jobs` · `/v1/retention/jobs/:id` | counts per kind: `candidates, due, deleted, wouldDelete, skippedHold, failed`; `holdsApplied`, `unconfiguredKinds`, `errors` |

For each kind (`audio`, `transcript`, `summary`, `extracted_event`) the runner asks the data owner
(`RetentionTarget`, HTTP: `GET /internal/v1/retention/candidates?institutionId&olderThan&kind`,
`POST /internal/v1/retention/delete { ids, kind, jobId } → { deletedIds }`) for items older than the
shortest window of the institution's policies, then applies each item's own policy
(`recordingPolicyId`, default policy otherwise). Candidates may carry `createdAt, recordingSessionId,
classSectionId, subjectIds, recordingPolicyId`; without `createdAt` an item is only deleted when its
policy has the shortest window. Items under an active hold are skipped. Deletion is in batches of 500;
ids not confirmed by the owner count as `failed`. One running job per institution. Audit:
`retention.deleted` and `retention.skipped_hold` per item, `retention.job_completed` per job (dry runs
audit only the job). Audit events are not a retention kind and are never deleted here.
Other audit actions: `recording_policy.version_created`, `consent.recorded`, `consent.withdrawn`,
`legal_hold.created`, `legal_hold.released`.

| Variable                                                                                                  | Default                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `AUDIT_URL`                                                                                               | `http://localhost:4011`               |
| `ACADEMIC_INTEGRATION_URL`                                                                                | `http://localhost:4003` (roster)      |
| `AUDIO_INGESTION_URL` / `TRANSCRIPT_MANAGEMENT_URL` / `LECTURE_INTELLIGENCE_URL` / `EVENT_EXTRACTION_URL` | `:8001` / `:4008` / `:8006` / `:8007` |

## Integration stage — persistence & internal auth

| Variable                     | Effect                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | Postgres (`src/repository.pg.ts`). Schema: `data/migrations/V*.sql` + `pending/organization.sql`; no DDL at start-up.                                                                                                             |
| `INTERNAL_API_TOKEN`         | `POST /v1/retention/run` (Cloud Scheduler, daily 04:00) and `/internal/*` require `x-internal-token`; the admin console may use `Authorization: Bearer $ADMIN_API_TOKEN` instead. Sent on calls to audit, roster and data owners. |
| `RETENTION_TARGETS_DISABLED` | comma-separated data owners to skip (e.g. while one is not deployed)                                                                                                                                                              |

Atomic operations: policy + version commit (per-institution advisory lock, default switch, deferred
`current_version_id` FK), consent supersede + insert (`uq_recording_consents_current`), retention job
lock (`INSERT … ON CONFLICT (institution_id) WHERE status = 'running' DO NOTHING` → `409`).
Institutions that have recording policies can no longer be deleted (versions are append-only).

Postgres suite: `TEST_DATABASE_URL=postgresql://… pnpm test`.
