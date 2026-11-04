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
