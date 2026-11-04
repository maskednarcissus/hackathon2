# Notifications Service

Port **4006**. Phase 1 scope: **recording failure alerting** (deliverable 1.17) per
[`docs/architecture/phase-1-capture-pipeline.md` §10](../../docs/architecture/phase-1-capture-pipeline.md).
Phase 3 scope: **student notifications** (3.11) and **notification preferences** (3.12) per
[`docs/architecture/phase-3-student-experience.md` §6](../../docs/architecture/phase-3-student-experience.md).

## Alert rules

| Rule                    | Trigger                                                      | Severity      | Auto-resolves when                         |
| ----------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------------ |
| `device_offline`        | no heartbeat > 3 min during a class window / > 5 min outside | high / low    | heartbeat back (≤ 3 min)                   |
| `recording_missed`      | window started + 5 min, no `recording.started` for the class | high          | `recording.started` / `recording.uploaded` |
| `failed_upload`         | `upload.failed`, or no upload 2 h after `recordStopAt`       | medium        | `recording.uploaded` / `upload.completed`  |
| `poor_audio_quality`    | `audio.quality_assessed` verdict `poor` / `unusable`         | medium / high | later verdict `good`/`acceptable`          |
| `transcription_failure` | `transcription.failed`                                       | medium        | `transcription.completed`                  |
| `low_storage`           | device `diskFreeBytes` < 1 GiB                               | medium        | ≥ 1 GiB                                    |

- Deduplication by `(rule, resourceId)` while the alert is unresolved; `occurrences` counts repeats.
- Re-notification at most every 30 min while `open`; acknowledged alerts are silent unless
  the severity escalates (which re-opens them and notifies immediately).
- Every raise / acknowledge / resolve is written to the audit service (non-fatal on failure).
- Windows with `recordingEnabled: false` never produce `recording_missed`.

## API

| Method | Path                                                                       | Purpose                                                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/v1/lifecycle-events`                                                     | ingest an event envelope (contract §6) — Pub/Sub push target → `202 {raised, updated, resolved}`                                                                                                       |
| `POST` | `/v1/alerts/evaluate`                                                      | time-based rules: `{ now?, classWindows: [...], devices: [...] }` — called every minute (Cloud Scheduler job that joins device-management `/v1/fleet/health` and academic-integration recording plans) |
| `GET`  | `/v1/alerts?status&severity&rule&classroomId&deviceId&institutionId&limit` | list (unresolved first, then severity)                                                                                                                                                                 |
| `GET`  | `/v1/alerts/:id`                                                           | alert + delivery log                                                                                                                                                                                   |
| `POST` | `/v1/alerts/:id/acknowledge`                                               | `{ actorId, note? }`                                                                                                                                                                                   |
| `POST` | `/v1/alerts/:id/resolve`                                                   | `{ actorId, note? }`                                                                                                                                                                                   |

Errors: `{ "error": { "code", "message", "details?" } }`.

## Capture incident queue (Phase 4 — 4.8)

Alerts are the incident records ([`phase-4` contract §4](../../docs/architecture/phase-4-institutional-intelligence.md)).

- Statuses: `open → acknowledged → in_progress → resolved` (`in_progress` also counts as the
  acknowledgement for MTTA and assigns the actor when unassigned). Escalation re-opens an
  `acknowledged` incident but keeps `in_progress`.
- Resolution through the incident API requires `resolutionCode` ∈ `hardware_replaced`,
  `network_fixed`, `configuration`, `false_positive`, `class_cancelled`, `other`
  (`422 resolution_code_required`). Auto-resolved incidents have `resolution: "auto"` and no code.
- SLA (time to resolve) by severity: critical 1 h, high 4 h, medium 24 h, low 72 h →
  `slaDueAt = openedAt + SLA` (recomputed on escalation), `slaBreached` = resolved late or overdue now.
- `campusId`, `campusName`, `classroomName` (and a missing `institutionId`) come from organization
  `GET /v1/classrooms/:id` + `GET /v1/campuses/:id` (`OrganizationClient`, cached 10 min / misses 1 min,
  best-effort) when the alert is created.

| Method | Path                                                                                                                 | Response                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/incidents?institutionId&status&severity&type&campusId&assignee&sort=severity\|age&limit&offset`                 | `{ items: Incident[], total }` — `assignee=unassigned` supported                                                          |
| `GET`  | `/v1/incidents/{id}`                                                                                                 | `Incident` + `comments[]` + `timeline[]`                                                                                  |
| `POST` | `/v1/incidents/{id}/assign` `{ assigneeId, actorId }`                                                                | incident detail                                                                                                           |
| `POST` | `/v1/incidents/{id}/status` `{ status: "acknowledged"\|"in_progress"\|"resolved", actorId, resolutionCode?, note? }` | incident detail (`409` if resolved / invalid transition)                                                                  |
| `POST` | `/v1/incidents/{id}/comments` `{ actorId, body }`                                                                    | `201 { comment, incident }`                                                                                               |
| `GET`  | `/v1/incidents/stats?institutionId&from&to`                                                                          | `{ mttaMinutes, mttrMinutes, openBySeverity, openTotal, slaBreaches, raised, resolved, byType, from, to, institutionId }` |

`Incident` = `{ id, type, rule, severity, status, title, message, resourceType, resourceId, institutionId,
deviceId, classroomId, classroomName, campusId, campusName, scheduledClassId, recordingSessionId,
assigneeId, assignedAt, openedAt, lastSeenAt, occurrences, acknowledgedAt, acknowledgedBy, inProgressAt,
resolvedAt, resolvedBy, resolution, resolutionCode, resolutionNote, slaDueAt, slaBreached, ageMinutes, details }`.

Stats: MTTA/MTTR over incidents **opened** in `[from, to)` (acknowledged / resolved ones);
`openBySeverity`/`openTotal` are a current snapshot; `slaBreaches` counts incidents opened in range.

Audit actions: `alert.raised`, `alert.escalated`, `alert.acknowledged`, `alert.assigned`,
`alert.in_progress`, `alert.commented`, `alert.resolved` (metadata includes `resolutionCode`).

**Auth.** `/v1/alerts*` and `/v1/incidents*` are admin routes: with `ADMIN_API_TOKEN` and/or
`IDENTITY_URL` configured they require `Authorization: Bearer` — the static admin token, or an identity
JWT with role `coordinator`/`admin` (scoped to its `inst`; the token subject is recorded as the actor).
`/v1/lifecycle-events` and `/v1/alerts/evaluate` require `x-internal-token` when `INTERNAL_API_TOKEN` is set.

## Student notifications (Phase 3 — 3.11, 3.12)

### Triggers (via `POST /v1/lifecycle-events`)

| Event                                                            | Category             | Notification                      |
| ---------------------------------------------------------------- | -------------------- | --------------------------------- |
| `event.published` / `calendar.event_published` (assessment)      | `new_assessment`     | "Nova avaliação/prazo: Prova"     |
| same, type `class_cancellation`                                  | `class_cancellation` | "Aula cancelada"                  |
| `event.updated` / `calendar.event_updated` with date/time change | `deadline_change`    | "Prazo alterado: …" (from → to)   |
| update to status `cancelled`, `event.cancelled`                  | `class_cancellation` | "Aula cancelada" / "Cancelado: …" |
| `lecture.structured`                                             | `lecture_summary`    | "Resumo da aula disponível"       |
| `POST /v1/reminders/run`                                         | `reminder`           | "Lembrete: Prova amanhã / em 2 h" |

- Event details come inline (`classSectionId, title, eventDate…`) or from calendar
  `GET /v1/calendar-events/{calendarEventId}`; `event.updated` that only carries the extracted
  `eventId` is resolved through the locally tracked event. Title-only edits are silent.
- `lecture.structured` resolves the section via academic-integration `GET /v1/scheduled-classes/{id}`.
- Fan-out goes to students with an **active** enrollment in the section (`EnrollmentDirectory`;
  default = local mirror fed by `POST /v1/sync/enrollments`).
- Dedup key `(userId, category, resourceId, version)`; redelivered events never notify twice.
  If the calendar is unreachable the endpoint answers `503` so Pub/Sub retries (safe: idempotent).
- Reminders: for each active assessment (not announcements), each student gets the reminder of the
  **smallest** of their offsets whose time has come (default `[24, 2]` h) — a late publication never
  produces a burst of stale reminders. A date change re-arms reminders. Events without a time are
  treated as due at 08:00 local. Run every 5–15 min (Cloud Scheduler); it also flushes deferred deliveries.

### Channels

- `in_app` — stored; always delivered immediately.
- `email` — HTTP mail relay (`MAIL_RELAY_URL`); address from the enrollment sync (`email`).
- `push` — Web Push: VAPID JWT (ES256, RFC 8292) + `aes128gcm` payload encryption (RFC 8291),
  implemented with `node:crypto` (verified against the RFC 8291 Appendix A vector). 404/410
  responses delete the subscription. `FakePushSender` when VAPID keys are not configured.
- Quiet hours defer `email`/`push` until the window ends (`in_app` is never deferred); deferred
  items are re-checked against the current preferences when flushed.

### Preferences

`in_app` cannot be disabled for `deadline_change` and `class_cancellation` (`422 critical_in_app_locked`).
Defaults: everything on, except `lecture_summary` email/push and `reminder` email.

### API

| Method         | Path                                                                                           | Auth      |
| -------------- | ---------------------------------------------------------------------------------------------- | --------- |
| `GET`          | `/v1/users/{userId}/notifications?unread=&limit=&before=` → `{items, unreadCount, nextBefore}` | user      |
| `POST`         | `/v1/users/{userId}/notifications/{id}/read`                                                   | user      |
| `POST`         | `/v1/users/{userId}/notifications/read-all`                                                    | user      |
| `GET` / `PUT`  | `/v1/users/{userId}/notification-preferences` (PUT merges partial updates)                     | user      |
| `POST` / `GET` | `/v1/users/{userId}/push-subscriptions` (body = `PushSubscription.toJSON()`)                   | user      |
| `DELETE`       | `/v1/users/{userId}/push-subscriptions/{id}`                                                   | user      |
| `GET`          | `/v1/push/vapid-public-key`                                                                    | public    |
| `POST`         | `/v1/sync/enrollments` (identity's body + optional `userId`, `email` per row; `mode: upsert    | replace`) | internal |
| `POST`         | `/v1/reminders/run` `{now?}`                                                                   | internal  |
| `POST`         | `/v1/notifications/flush-deferred` `{now?}`                                                    | internal  |
| `GET`          | `/v1/notifications/{id}/deliveries`                                                            | internal  |

_user_: with `IDENTITY_URL` set, `Authorization: Bearer <identity JWT>` is verified via JWKS
(vendored `src/vendor/jwt-verify.ts`) and `sub` must equal `{userId}`. _internal_: with
`INTERNAL_API_TOKEN` set, `x-internal-token` is required.

## Configuration

| Env                                                         | Meaning                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                      | default 4006                                                                                                                                                       |
| `ALERT_RECIPIENTS_JSON`                                     | `{"default":[{"channel":"email","address":"noc@…","minSeverity":"high"}],"institutions":{"<uuid>":[…]}}` — channels: `email`, `webhook` (address = URL), `console` |
| `MAIL_RELAY_URL`, `MAIL_RELAY_TOKEN`                        | HTTP mail relay: `POST {to, subject, text, metadata}`                                                                                                              |
| `AUDIT_URL`                                                 | audit service base URL (`POST /v1/audit-events`)                                                                                                                   |
| `CALENDAR_URL`, `ACADEMIC_INTEGRATION_URL`, `SERVICE_TOKEN` | lookups for event details / scheduled classes (student notifications)                                                                                              |
| `ORGANIZATION_URL`                                          | classroom → campus lookup for incidents                                                                                                                            |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`    | Web Push (base64url raw P-256 keys; `generateVapidKeys()` in `src/student/webpush.ts`)                                                                             |
| `IDENTITY_URL`                                              | enables identity JWT verification (user routes; coordinator/admin on admin routes)                                                                                 |
| `ADMIN_API_TOKEN`                                           | static bearer for admin routes (alerts, incidents)                                                                                                                 |
| `INTERNAL_API_TOKEN`                                        | `x-internal-token` for internal routes                                                                                                                             |
| `STUDENT_WEB_URL`                                           | base URL for deep links in email/push                                                                                                                              |

Storage is behind the `AlertStore` port (`src/store.ts`); the in-memory adapter is used
until the Postgres adapter lands (tables `alerts`, `alert_deliveries`, `alert_class_marks`, `incident_comments`, `incident_activity`).
Student notifications use the `StudentStore` port (`src/student/store.ts`): `user_notifications`,
`notification_preferences`, `push_subscriptions`, `deferred_deliveries`, `notification_deliveries`,
`notification_enrollments`, `notification_tracked_events`.

## Technology

TypeScript · Fastify · Zod · PostgreSQL (planned adapter) · HTTP mail relay
