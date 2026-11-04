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
