# Integration Stage (Phases 1–4 → end-to-end)

Goal: the services built in Phases 1–4 run together against **PostgreSQL** and an **event bus**, with
academic data synchronised, internal endpoints authenticated, and one end-to-end scenario passing
locally with Docker Compose.

## 1. Persistence

* Every service keeps its repository/store interfaces. Add a Postgres implementation next to the
  in-memory one, selected at start-up: `DATABASE_URL` set → Postgres, unset → in-memory (dev/tests).
* Schema = `data/migrations/V*.sql` (single database in dev; services only touch their own tables).
  Services **never** run DDL at start-up. Schema gaps found while writing adapters go into
  `data/migrations/pending/<service>.sql` (plain `ALTER`/`CREATE`, idempotent where possible) — the
  coordinator merges them into `V005__integration.sql`.
* TS: `pg` (`Pool`), parameterised queries only, `src/repository.pg.ts` (or `src/store.pg.ts`).
  Python: `psycopg` 3 (`AsyncConnectionPool` from `psycopg_pool`), `adapters/postgres.py`.
* Transactions where invariants span rows (audit hash chain append with `SELECT … FOR UPDATE` on the
  tenant head; provisioning-token consume `UPDATE … WHERE used_at IS NULL RETURNING`; upload completion;
  refresh rotation; retention job lock).
* Integration tests: `*.pg.test.ts` / `tests/test_*_pg.py`, **skipped unless `TEST_DATABASE_URL` is set**
  (admin URL of an empty server). Each test file creates a fresh database `ci_test_<random>`,
  applies all migrations in order, runs the same behavioural scenarios as the in-memory tests, then
  drops it. Local server for this session: `postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433`.

## 2. Event bus

* Envelope: Phase 1 contract §6. Topic name = event `type` (e.g. `recording.uploaded`).
* Publisher selection: `EVENT_BUS_URL` set → HTTP publisher `POST {EVENT_BUS_URL}/v1/topics/{type}:publish`
  with the envelope as JSON (header `x-internal-token`); `PUBSUB_PROJECT_ID` set → Google Pub/Sub; else
  in-memory/logging.
* Subscribers accept Pub/Sub **push** format `{ message: { data: base64(envelope), messageId, attributes }, subscription }`
  as well as a raw envelope, are idempotent by `eventId`, and return 2xx only after processing.
* Routing table: `infrastructure/events/subscriptions.yaml` (`topic → [ { name, pushEndpoint } ]`) — used
  by the dev bus (`infrastructure/dev-event-bus`, Fastify, retries with backoff, dead-letter list
  `GET /v1/dead-letters`) and by Terraform to create Pub/Sub topics + push subscriptions.

## 3. Academic data synchronisation

academic-integration, after every applied import (and on `POST /v1/sync/push`), pushes:
* sections `{classSectionId, institutionId, courseId, courseCode, courseName, programId?, sectionCode, professorId, termStartDate, termEndDate}`
* enrollments `{classSectionId, studentId, status, userId?, email?}`
* classrooms (from organization) `{classroomId, institutionId, campusId, campusName, name}`

to every target in `SYNC_TARGETS` (`name=url,…`): identity `/v1/sync/sections|enrollments`,
calendar `/v1/sections` + `/v1/enrollments/bulk`, notifications `/v1/sync/enrollments`,
academic-analytics `/v1/sync/sections|enrollments|classrooms`. Each target adapter maps the canonical
payload to that service's existing body. Failures are retried and reported in `GET /v1/sync/status`.

## 4. Service-to-service security

* `INTERNAL_API_TOKEN` (one shared secret per environment, from Secret Manager): required as
  `x-internal-token` on `/internal/*`, sync, event push endpoints and scheduler endpoints of every service
  when set; constant-time comparison. Unset → open (dev only, warning logged).
* calendar verifies identity JWTs (vendored verifier) on student routes; `studentId` must match the
  token's `pid` unless coordinator/admin.

## 5. Data-owner endpoints for governance

Data owners implement organization's retention contract (Phase 4 §5) and identity's DSR contract
(Phase 4 §6) for their data:

| Service | retention kinds | DSR |
|---|---|---|
| audio-ingestion | `audio` | — (no personal data beyond device) |
| transcript-management | `transcript` | access/deletion: corrections authored by a professor (anonymise author) |
| lecture-intelligence | `summary` | access/deletion: assistant conversations, answers, feedback |
| event-extraction | `extracted_event` | — |
| notifications | — | access/deletion: inbox, preferences, push subscriptions |
| calendar | — | deletion: feed token |
| audit | — (7-year, never deleted) | access: events where actor = subject; deletion: not allowed → `not_applicable` with legal basis |

Engagement events (Phase 4 analytics): lecture-intelligence emits audit `lecture.viewed`
(GET lecture by a student), `lecture.assistant_question`; transcript-management emits `lecture.searched`
— each with `actorType: student`, `actorId` from the bearer token, `metadata.classSectionId`.

## 6. Scheduled jobs

Cloud Scheduler (Terraform module `scheduler`), each calling with `x-internal-token`:
notifications `/v1/alerts/evaluate` (1 min, with class windows from academic-integration via a small
`/internal/v1/alert-context` feed), `/v1/reminders/run` (10 min); device-management status sweep (1 min);
academic-analytics `/v1/snapshots/run` (daily 03:00 local); organization `/v1/retention/run` (daily 04:00).

## 7. End-to-end scenario

`infrastructure/docker/docker-compose.full.yml` runs Postgres (migrations applied by a one-shot
container), the dev event bus and all services with fake AI/STT providers. `tests/e2e/run_e2e.py`:
seed organization + timetable import → provision & register a simulated device → heartbeat →
recording plan → upload a synthetic 10-minute WAV with a spoken-like signal (fake STT returns a scripted
pt-BR transcript announcing an exam) → assert transcript, diarization labels, lecture structure,
extracted event awaiting review → professor confirms → calendar event published with provenance →
student notification in inbox → audit chain verifies → analytics capture-coverage counts the class.
