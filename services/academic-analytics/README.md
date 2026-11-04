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

## Integration stage

- `DATABASE_URL` → Postgres (`PgAnalyticsRepository` on `syllabus_items` / `analytics_daily_snapshots` /
  `analytics_class_facts`, `PgDirectory` on the mirror tables in `data/migrations/pending/academic-analytics.sql`).
  Re-running a snapshot day replaces its facts.
- `INTERNAL_API_TOKEN` (fallback `INTERNAL_TOKEN`) → accepted as `x-internal-token` (contract §4) or as a bearer token on
  the sync feeds and `POST /v1/snapshots/run`; an invalid `x-internal-token` → `401 internal_token_required`.

## Phase 6.7 — Learning patterns

`GET /v1/courses/:courseId/learning-patterns?from&to` and `GET /v1/institutions/:id/learning-patterns?from&to`
(coordinator/admin of the institution; default 60 days). Computed live from audit engagement events
(`lecture.viewed`, `lecture.searched`, `lecture.assistant_question` — actor type `student`, `metadata.classSectionId`,
`metadata.scheduledClassId`), scheduled classes, calendar assessments and the enrolment mirror (`src/learning-patterns.ts`):

- `engagementCurve` — views by days after each class (0…13, 14+), median days to first view, share viewed within 2 days;
- `revisitBeforeAssessments` — share of enrolled students revisiting lectures in the 7 days before each assessment vs.
  the week before (`lift`);
- `difficultTopics` — lectures with the highest assistant-question density (questions per enrolled student), labelled
  with the lecture title and first topics;
- `searchesWithoutResults` — normalised terms of searches with no results (from transcript-management) and the zero-result rate;
- `engagementVsAssessments` — daily views / searches / questions next to assessment days, plus the activity ratio in the
  3 days before assessments vs. other days.

Every student-derived figure requires ≥ 5 distinct students (`suppressed: true` and nulls otherwise); lectures and search
terms below the cohort are omitted; no per-student output exists. The institution endpoint adds a per-course summary.
No schema change: nothing is persisted.
