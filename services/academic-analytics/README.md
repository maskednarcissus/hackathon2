# Academic Analytics Service

Institutional intelligence for coordinators and administrators (phase-4 contract §2,
`docs/architecture/phase-4-institutional-intelligence.md`). Port `4009`.

Deliverables: 4.2 syllabus coverage · 4.3 assessment calendar · 4.4 cross-course conflicts ·
4.5 professor adoption & class analytics · 4.9 operational reports (+ the data behind the 4.6 overview).

## Privacy rules

- Every analytics endpoint requires a **coordinator or admin** access token of the **same institution**
  (`claims.inst` must equal the institution of the route / course). Cross-institution access → `403`.
- Student identities never leave the service. Student-level data is only aggregated, and any aggregate over
  fewer than **5 students** is suppressed: `{ "count": null, "suppressed": true }` or, for metric groups,
  `{ "suppressed": true, "cohortSize": null, "views": null, … }` (`src/stats.ts`, `MIN_COHORT`).
- CSV exports neutralise spreadsheet formulas (cells starting with `= + - @` are prefixed with `'`).

## API

| Method | Path                                                                                      | Notes                                                                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT`  | `/v1/courses/:courseId/syllabus`                                                          | `{items: [{id, title, keywords?: [], plannedWeek?}]}` (unique ids, ≤ 500)                                                                                                            |
| `GET`  | `/v1/courses/:courseId/syllabus`                                                          |                                                                                                                                                                                      |
| `GET`  | `/v1/courses/:courseId/coverage`                                                          | `{items: [{id, title, status, coverageScore, matchedLectures[], plannedWeek, firstCoveredWeek, behindSchedule}], counts, coverageRatio, weightedCoverageRatio, currentWeek, method}` |
| `GET`  | `/v1/institutions/:id/assessment-calendar?from&to&programId&courseId&includePending=true` | days → `{load, published, awaitingReview, items[…, enrolledStudents]}`                                                                                                               |
| `GET`  | `/v1/institutions/:id/assessment-conflicts?from&to&includePending=true`                   | `assessment_overlap_shared_students` (blocking if two exams), `assessment_load` (≥ 3 in 7 days), `same_day_same_program`; `students` cohort-suppressed                               |
| `GET`  | `/v1/institutions/:id/adoption?from&to`                                                   | `professors[]`, `sections[]` (with `engagement` cohort), `totals`, `source`                                                                                                          |
| `GET`  | `/v1/institutions/:id/reports/:kind?from&to&format=json\|csv`                             | kinds `capture-coverage`, `transcription-success`, `corrections`, `processing-latency`                                                                                               |
| `GET`  | `/v1/institutions/:id/overview?date`                                                      | today's capture + fleet summary + open alerts by severity (partial results with `errors` if an upstream is down)                                                                     |
| `POST` | `/v1/snapshots/run`                                                                       | `{institutionId, date?}` (default yesterday; `422` for days not yet closed) — internal token or admin                                                                                |
| `GET`  | `/v1/snapshots?institutionId&from&to`                                                     | materialised days                                                                                                                                                                    |
| `POST` | `/v1/sync/sections` · `/v1/sync/enrollments` · `/v1/sync/classrooms`                      | data feeds from academic-integration / organization — internal token or admin                                                                                                        |

Ranges are local dates `YYYY-MM-DD` (inclusive), default the last 30 days (60 for assessments), max 186 days.
Upstream failures return `502 upstream_unavailable` with `details.service`.

### Syllabus coverage (4.2)

Candidates are the topics, subtopics and concepts of every lecture structure of the course's past classes.
`score = 0.6 · token overlap + 0.4 · embedding cosine` (token overlap = share of the item's pt-BR normalised
terms — accent folding, stopwords, light stemming — found in the candidate; keywords widen recall).
`covered ≥ 0.75`, `partial ≥ 0.5`. If embeddings are unavailable the score is lexical only and
`method.degraded = true`. Weeks count from the earliest synced `termStartDate`; `behindSchedule` = the
planned week has passed without coverage (or coverage came after the planned week).

### Adoption (4.5)

Only classes that have ended count; cancelled classes are reported separately. Review rate = events reviewed
(confirmed / published / rejected, or touched by a professor/admin) ÷ events extracted (duplicates excluded);
review latency = first professor/admin change − extraction time; corrections = corrected transcript segments +
event edits. Student engagement counts audit actions `lecture.viewed`, `lecture.searched`,
`lecture.assistant_question` (actor type `student`, `metadata.classSectionId`) — student-web and
lecture-intelligence must emit them.

## Data sources

No shared database: everything is pulled through client interfaces in `src/clients.ts` (HTTP implementations
match the real endpoints) with in-memory fakes in `src/fakes.ts`:

| Client                | Endpoint                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| academic-integration  | `GET /v1/scheduled-classes?classSectionId&from&to&includeCancelled=true`                                                                                                 |
| calendar              | `GET /v1/calendar-events?institutionId&from&to`                                                                                                                          |
| lecture-intelligence  | `GET /v1/lectures/{scheduledClassId}`                                                                                                                                    |
| audit                 | `GET /v1/audit-events?tenantId&action&from&to` (cursor pages) — `recording.class_identified`, `recording.uploaded`, `transcription.completed/failed`, engagement actions |
| transcript-management | `GET /v1/transcripts?recordingSessionId`                                                                                                                                 |
| event-extraction      | `GET /v1/review-queue?classSectionId&status=<all>`                                                                                                                       |
| device-management     | `GET /v1/fleet/health?institutionId` (admin bearer `DEVICE_MANAGEMENT_ADMIN_TOKEN`)                                                                                      |
| notifications         | `GET /v1/alerts?institutionId`                                                                                                                                           |
| ai-gateway            | `POST /v1/embed` (`EMBEDDINGS_PROVIDER=gateway`; default deterministic fake)                                                                                             |

academic-integration has no per-institution listing of sections, so sections (course, program, professor,
term dates), enrollments (pseudonymous student ids, used only for counts) and classrooms → campus are mirrored
through the `/v1/sync/*` feeds — the same pattern calendar and identity use.

**Snapshots:** `POST /v1/snapshots/run` (nightly) stores one row per scheduled class of the day
("class facts": captured, transcribed, structured, event review, latencies). Reads use snapshots for closed
days and collect missing days live (`source: {snapshotDays, liveDays}`); today is always live.

## Auth

`src/jwt-verify.ts` is **vendored from `services/identity/src/jwt-verify.ts`** (keep in sync); tokens are
verified against identity's JWKS (`IDENTITY_JWKS_URL`). Service-to-service calls use `INTERNAL_TOKEN`.
`AUTH_DISABLED=true` disables authentication for local development only (a warning is logged).

## Configuration

`PORT` (4009), `IDENTITY_JWKS_URL`, `INTERNAL_TOKEN`, `AUTH_DISABLED`, `ACADEMIC_INTEGRATION_URL` (4003),
`CALENDAR_URL` (4005), `LECTURE_INTELLIGENCE_URL` (8006), `AUDIT_SERVICE_URL` (4011),
`TRANSCRIPT_MANAGEMENT_URL` (4008), `EVENT_EXTRACTION_URL` (8007), `DEVICE_MANAGEMENT_URL` (4004),
`DEVICE_MANAGEMENT_ADMIN_TOKEN`, `NOTIFICATIONS_URL` (4006), `EMBEDDINGS_PROVIDER` (`fake` | `gateway`),
`AI_GATEWAY_URL` (8005).

## Technology

TypeScript · Fastify · Zod · PostgreSQL (snapshots) · BigQuery (Phase 5 export)
