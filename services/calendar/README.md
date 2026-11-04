# Calendar Service

Academic calendar of record. Publishes confirmed events with source provenance, keeps an
immutable change history, and detects conflicts before publication (Phase 2 — deliverables 2.14, 2.17).

Contract: [`docs/architecture/phase-2-classroom-intelligence.md` §6](../../docs/architecture/phase-2-classroom-intelligence.md).

## Run

```bash
pnpm --filter @ci/calendar-service dev      # port 4005
pnpm --filter @ci/calendar-service test
```

| Env         | Default                 | Purpose                                          |
| ----------- | ----------------------- | ------------------------------------------------ |
| `PORT`      | `4005`                  | HTTP port                                        |
| `AUDIT_URL` | `http://localhost:4011` | Audit service (failures are logged, never fatal) |
| `LOG_LEVEL` | `info`                  | Pino log level                                   |

## Endpoints

| Method         | Path                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`         | `/v1/calendar-events`                          | Publish an event. Upserts by `extractedEventId`: field differences become change records (`date_change`, `description_change`, `status_change`, `other`) and bump `version`, so nothing is overwritten silently. Identical republish is a no-op. `201` when created, `200` when updated; the response includes `changes` and current `conflicts`. Events with an `extractedEventId` must carry `provenance` (recording, transcript, segment, timestamps, quote, confirmer). |
| `GET`          | `/v1/calendar-events`                          | Filters: `institutionId`, `courseId`, `classSectionId`, `from`, `to`, `includeCancelled`                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`          | `/v1/calendar-events/{id}`                     | Event with `history`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`          | `/v1/calendar-events/{id}/history`             | Change records in chronological order; `?view=student` omits `changedBy` (3.9)                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST`         | `/v1/calendar-events/{id}/cancel`              | `{actorId, reason, source?}` → `cancellation` change record                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST`         | `/v1/conflicts/check`                          | `{institutionId, classSectionId, type, eventDate, eventTime?, excludeEventId?}` → `{conflicts, hasBlocking}`                                                                                                                                                                                                                                                                                                                                                                |
| `POST`         | `/v1/sections`                                 | `{sections:[{classSectionId, institutionId, courseId, professorId?, courseName?, sectionCode?}]}` mirrors section data from academic-integration (names are used in ICS descriptions)                                                                                                                                                                                                                                                                                       |
| `POST`         | `/v1/enrollments/bulk`                         | `{classSectionId, studentIds, mode: replace\|append}`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST` / `GET` | `/v1/non-teaching-days`                        | Institutional holidays (`GET ?institutionId=`)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST` / `GET` | `/v1/terms`                                    | Term bounds (`GET ?institutionId=`)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET`          | `/v1/students/{studentId}/calendar-events`     | Events from the student's enrolled sections, `?from&to&includeCancelled` (cancellations shown by default). Each item carries `status`, `isOfficial`, `source` (recording, transcript, segment, timestamps, quote, confirmation time) and student-visible `history` (3.8, 3.9)                                                                                                                                                                                               |
| `POST`         | `/v1/students/{studentId}/calendar-feed-token` | Issues or rotates the student's ICS feed token (`cft_` + 256-bit random, base64url). Only the SHA-256 is stored; rotation invalidates the previous token. Response is `no-store` (3.10)                                                                                                                                                                                                                                                                                     |
| `GET`          | `/v1/students/{studentId}/calendar.ics?token=` | RFC 5545 feed for Google/Apple/Outlook subscriptions. Missing, wrong, rotated or foreign tokens all get the same `401 invalid_feed_token`; tokens are redacted from request logs (3.10)                                                                                                                                                                                                                                                                                     |

## Conflict kinds

| Kind                                 | Severity                                                                          | Rule                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `same_section_same_day`              | `blocking` if two in-class assessments share the same time, otherwise `warning`   | Another event in the same section on the same date                                                                 |
| `assessment_overlap_shared_students` | `warning`                                                                         | In-class assessment (exam, quiz, presentation) on the same day in another section that shares ≥ 1 enrolled student |
| `assessment_load`                    | `warning`                                                                         | A student would have ≥ 3 assessments (exam, quiz, presentation, assignment, project) in some 7-day window          |
| `non_teaching_day`                   | `blocking` for in-class events, `warning` for deadlines, `info` for cancellations | Institutional holiday, or a date outside every registered term                                                     |
| `existing_event_different_date`      | `warning`                                                                         | Same section and type already published on another date (possible date change)                                     |

Conflict messages report **aggregate counts only**. Student identities are never exposed (LGPD).

## ICS feed (3.10)

- `VCALENDAR` with `METHOD:PUBLISH`, `REFRESH-INTERVAL` 1 h and a static `VTIMEZONE` for `America/Sao_Paulo` (fixed −03:00, no DST since 2019).
- `UID:<calendarEventId>@classroom-intelligence` stays stable. `SEQUENCE = version − 1` increments on every recorded change, so clients update in place.
- Timed events: `DTSTART;TZID=America/Sao_Paulo` with a 1-hour block (the source data has no end time). Events in other zones are emitted as UTC instants (DST-safe conversion via `Intl`). Date-only events: `VALUE=DATE` all-day, `TRANSP:TRANSPARENT`.
- Cancellations: `STATUS:CANCELLED` plus a `[CANCELADO]` summary prefix.
- `DESCRIPTION` holds the description, course/section, source class excerpt with hh:mm:ss timestamps and quote, confirmation date, and official / not-official status.
- TEXT escaping (`\\ ; , \n`), 75-octet folding that never splits a UTF-8 sequence, CRLF endings. Validated against the Python `icalendar` parser.

## Audit

Emits `calendar.event_published` and `calendar.event_updated` to the audit service.

## Persistence

The in-memory repository implements the `CalendarRepository` port. The PostgreSQL adapter targets
`calendar_events` (V001) plus `calendar_event_changes`, `calendar_section_mirror`,
`calendar_section_enrollments`, `non_teaching_days` and `academic_terms` (V002), plus `calendar_feed_tokens` (Phase 3).

## Integration stage

| Concern         | Behaviour                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persistence     | `DATABASE_URL` → `src/repository.pg.ts` (`PgCalendarRepository`, `PgFeedTokenRepository`); unset → in-memory. Versioned updates are one transaction with an optimistic `WHERE version = $expected` check (409 `concurrent_update` on a lost race).                                                                                                     |
| Event bus       | `EVENT_BUS_URL` → `POST {url}/v1/topics/{type}:publish` with `x-internal-token`. Emits `calendar.event_published` and `calendar.event_updated` (date change, edit, cancellation) with the **full event inline** (`data.event`, `data.section`, `data.changes`, `data.conflicts`, `data.previousVersion`). Failures are logged, never fail the request. |
| Internal token  | `INTERNAL_API_TOKEN` required as `x-internal-token` on `/internal/*`, `POST /v1/sections`, `/v1/enrollments/bulk`, `/v1/non-teaching-days`, `/v1/terms` (open with a warning when unset).                                                                                                                                                              |
| Calendar writes | `POST /v1/calendar-events`, `/v1/calendar-events/:id/cancel`, `/v1/conflicts/check`: `x-internal-token` **or** a coordinator/admin JWT of the event's institution (open only when neither token nor JWKS is configured).                                                                                                                               |
| Student auth    | `IDENTITY_JWKS_URL` (or `IDENTITY_URL`) → identity EdDSA JWTs verified with the vendored `src/jwt-verify.ts` on `GET /v1/students/:id/calendar-events` and `POST /v1/students/:id/calendar-feed-token`: `pid` must equal the student, or coordinator/admin of the student's institution. Required in production. The ICS feed keeps its URL token.     |
| DSR             | `POST /internal/v1/dsr/{type}`: deletion / anonymisation / restriction remove the student's feed token; access reports whether one is active; other subjects → `not_applicable`.                                                                                                                                                                       |

Schema gaps: `data/migrations/pending/calendar.sql`. With `TEST_DATABASE_URL` set, `src/calendar.pg.test.ts` runs against a
fresh database with every migration applied.

## External calendars (Phase 6 §6.9)

Per-student Google Calendar and Microsoft 365 connections (`src/external/`).

| Route                                                          | Auth        | Purpose                                                                                                                                        |
| -------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/students/:id/calendar-connections`                    | student JWT | Connections (no tokens) with status `active` / `broken`, last sync                                                                             |
| `POST /v1/students/:id/calendar-connections/connect/:provider` | student JWT | `{ authorizationUrl, state }` — OAuth 2.0 code flow, PKCE S256, single-use 10-min state                                                        |
| `GET /v1/oauth/:provider/callback`                             | state       | Exchanges the code, creates the dedicated "Classroom Intelligence" calendar, initial sync; redirects to `CALENDAR_CONNECT_RETURN_URL` when set |
| `DELETE /v1/students/:id/calendar-connections/:connectionId`   | student JWT | Deletes the remote calendar, revokes the grant, removes local data                                                                             |
| `POST /internal/v1/events/calendar`                            | internal    | Bus subscriber for `calendar.event_*` (Pub/Sub push or raw envelope, idempotent by `eventId`)                                                  |
| `POST /internal/v1/external-calendars/reconcile`               | internal    | Nightly reconcile (all or `{studentId}`): catches up and removes events the student no longer sees                                             |

- Google: Calendar API v3, scope `calendar.app.created`, deterministic event ids → retried inserts become patches.
  Microsoft: Graph `/me/calendars`, `/me/calendars/{id}/events`, `/me/events/{id}` with `transactionId`.
- Sync is per (connection, event) link with the remote id and synced version: same version → skipped; cancelled or no
  longer visible → remote delete. Exams 2 h, quizzes 1 h, presentations 1.5 h; events without time are all-day.
- Tokens are AES-256-GCM sealed (AAD = connection id) with `CALENDAR_TOKEN_KEY` (base64 32 bytes) or
  `CALENDAR_TOKEN_KEY_REF=env:NAME`; refreshed 60 s before expiry, a 401 triggers one refresh + retry.
  `invalid_grant` (user revoked access) marks the connection `broken` and discards the tokens.
- DSR: access lists connections; deletion/anonymisation/restriction remove them with their remote calendars.
- Config: `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET(_REF)`, `MICROSOFT_CALENDAR_CLIENT_ID` /
  `MICROSOFT_CALENDAR_CLIENT_SECRET(_REF)` / `MICROSOFT_CALENDAR_TENANT`, `CALENDAR_OAUTH_REDIRECT_BASE_URL`.
  Schema: `data/migrations/pending/calendar-phase6.sql`. Tests use an in-process fake provider (no live calls).
