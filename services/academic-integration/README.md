# Academic Integration Service

Academic schedule import, class identification and recording plans (Phase 1 deliverables 1.13, 1.14). Port `4003`.

## Responsibilities

- Timetable / enrollment import (JSON and CSV), idempotent upsert keyed by institution `externalId`
- Expansion of weekly schedules into concrete scheduled classes in the campus timezone
  (`src/tz.ts`, Intl-based, DST-safe), with exceptions: `cancelled`, `rescheduled`, `extra`
- Class identification for a recording (classroom + time interval → scheduled class)
- Recording plan for devices (contract §4), resolving the classroom recording policy from `organization`

## API

| Method | Path                                                                           | Notes                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/v1/imports`                                                                  | JSON payload (below). `201 applied`, `200 validated` (`dryRun: true`), `422 rejected` with `errors[{path, code, message}]`                                                                                         |
| `POST` | `/v1/imports/timetable.csv?institutionId=&timezone=&dryRun=`                   | `text/csv`, `,` or `;`, one row per weekly slot; errors reference `row <n>.<column>`                                                                                                                               |
| `GET`  | `/v1/imports/:id`                                                              | stored import report                                                                                                                                                                                               |
| `GET`  | `/v1/scheduled-classes?classroomId=\|classSectionId=&from&to&includeCancelled` | sorted by `startsAt`                                                                                                                                                                                               |
| `GET`  | `/v1/scheduled-classes/:id`                                                    | with `classSection`, `course`, `professor`, `term`                                                                                                                                                                 |
| `GET`  | `/v1/class-sections/:id/roster`                                                | `{classSectionId, institutionId, professorIds, studentIds}` — active enrollments only (organization consent status); `404` for unknown sections                                                                    |
| `POST` | `/v1/class-identification`                                                     | `{classroomId, startedAt, endedAt, recordingSessionId?, deviceId?}` → `{status: matched\|ambiguous\|unmatched, confidence, scheduledClass, bestCandidate, alternatives}`; emits audit `recording.class_identified` |
| `GET`  | `/v1/classrooms/:id/recording-plan?from&to`                                    | default next 24 h, max 14 days; `502 organization_unavailable` if policy lookup fails                                                                                                                              |

### Import payload

```json
{ "institutionId": "uuid", "timezone": "America/Sao_Paulo", "dryRun": false,
  "term": { "externalId": "2026-2", "name": "2026/2", "startDate": "2026-08-03", "endDate": "2026-12-11" },
  "courses": [{ "externalId", "code", "name", "discipline", "credits?" }],
  "professors": [{ "externalId", "name", "email" }],
  "students": [{ "externalId", "name", "email" }],
  "classSections": [{ "externalId", "courseExternalId", "professorExternalId", "sectionCode",
    "schedule": [{ "dayOfWeek": 1, "startTime": "19:00", "endTime": "20:40", "classroomId": "uuid" }],
    "exceptions": [{ "type": "rescheduled", "date": "2026-11-04", "startTime": "08:00", "endTime": "09:40", "classroomId?": "uuid" },
                   { "type": "extra", "date", "startTime", "endTime", "classroomId" },
                   { "type": "cancelled", "date", "reason?" }],
    "cancelledDates": ["2026-11-02"] }],
  "enrollments": [{ "studentExternalId", "classSectionExternalId", "status": "active" }] }
```

Rules: imports are all-or-nothing; references may point to entities from the payload or already stored;
sections not present in an import are untouched; sessions removed from a section's timetable are
**cancelled, never deleted** (`cancellationReason: removed_from_timetable`) so recordings keep their link.
Scheduled class ids are stable across re-imports (natural key `localDate|slot`).

CSV columns: `term_external_id, term_name, term_start, term_end, course_external_id, course_code, course_name,
discipline, professor_external_id, professor_name, professor_email, section_external_id, section_code,
day_of_week (0–6 or seg/ter/…/segunda-feira/monday), start_time, end_time, classroom_id`.

### Class identification

Score = Dice coefficient of recording vs. class interval (`2·overlap / (recording + class)`), candidates within
±15 min, cancelled classes excluded. `matched`: best ≥ 0.5 and ≥ 0.15 ahead of the runner-up;
`unmatched`: no overlap or best ≤ 0.15; otherwise `ambiguous` (e.g. a recording spanning two back-to-back classes).

## Configuration

`PORT` (4003), `ORGANIZATION_SERVICE_URL` (http://localhost:4002), `AUDIT_SERVICE_URL` (http://localhost:4011).

## Technology

TypeScript · Fastify · Zod · PostgreSQL · Pub/Sub
