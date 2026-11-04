# Phase 4 — Institutional Intelligence (Contracts)

Builds on the Phase 1–3 contracts. All endpoints require a coordinator/admin access token (identity §2)
scoped to one institution; analytics never return individual student identities — student-level data is
aggregated with a **minimum cohort size of 5** (smaller groups are suppressed as `"suppressed": true`).

## 1. Component map

| Component | Lang | Port | Deliverables |
|---|---|---|---|
| `services/academic-analytics` | TS / Fastify | 4009 | 4.2, 4.3, 4.4, 4.5, 4.9 |
| `services/device-management` | TS / Fastify | 4004 | 4.7 (fleet console, diagnostics, remote commands) |
| `hardware/firmware` | Py | — | 4.7 (command execution) |
| `services/notifications` | TS / Fastify | 4006 | 4.8 (incident queue on top of alerts) |
| `services/organization` | TS / Fastify | 4002 | 4.10, 4.12 (policy versions, consent, retention) |
| `services/identity` | TS / Fastify | 4001 | 4.11 (data subject rights) |
| `apps/administration-web` | Next.js | 3002 | 4.1, 4.3, 4.6, 4.7, 4.8, 4.10 UI |

## 2. Academic analytics (4.2–4.5, 4.9)

Inputs are pulled through client interfaces (no shared DB): academic-integration (sections, scheduled
classes, terms), calendar (assessments), lecture-intelligence (lecture topics), audit (lifecycle events),
transcript-management (transcript stats), event-extraction (event status / corrections), device-management
(fleet), notifications (alerts). A nightly `POST /v1/snapshots/run {institutionId, date}` materialises
daily aggregates; reads are served from snapshots + live fallback.

* **Syllabus coverage (4.2):** `PUT /v1/courses/{courseId}/syllabus { items: [{ id, title, keywords?: [], plannedWeek?: n }] }`;
  `GET /v1/courses/{courseId}/coverage` → `{ items: [{ id, title, status: "covered"|"partial"|"not_covered", coverageScore, matchedLectures: [{ scheduledClassId, date, topicTitle, score }], plannedWeek, firstCoveredWeek, behindSchedule }], coverageRatio }`.
  Matching = pt-BR normalised token overlap + embedding cosine (ai-gateway `/v1/embed`) between syllabus
  items and lecture topics/concepts; thresholds covered ≥ 0.75, partial ≥ 0.5.
* **Assessment calendar (4.3):** `GET /v1/institutions/{id}/assessment-calendar?from&to&programId?&courseId?`
  → days with assessments per course/section, load per day, status (published / awaiting review).
* **Cross-course conflicts (4.4):** `GET /v1/institutions/{id}/assessment-conflicts?from&to` → conflicts
  (`assessment_overlap_shared_students`, `assessment_load`, `same_day_same_program`), each with the affected
  sections, aggregated student counts (cohort rule) and severity.
* **Professor adoption & class analytics (4.5):** `GET /v1/institutions/{id}/adoption?from&to` →
  per professor/section: classes scheduled, captured, transcribed, structured, events extracted,
  review rate (events reviewed / extracted), median review latency, corrections made; and
  per section: student engagement aggregates (views, searches, assistant questions — cohort rule).
* **Operational reports (4.9):** `GET /v1/institutions/{id}/reports/{kind}?from&to&format=json|csv`,
  kinds `capture-coverage` (scheduled vs captured by campus/classroom/day), `transcription-success`
  (success rate, mean confidence, failures by reason), `corrections` (transcript corrections and event
  edits/rejections by course), `processing-latency` (class end → transcript → summary → events p50/p95).

## 3. Campus overview & fleet console (4.6, 4.7)

* Campus overview is composed in administration-web from analytics `capture-coverage` (today), device
  fleet health (Phase 1) and open alerts.
* Fleet console (device-management): `GET /v1/fleet?institutionId&campusId&status&firmwareVersion&q&sort&page`
  (paged, with classroom/campus names), `GET /v1/devices/{id}/diagnostics` (latest heartbeat, 24 h uptime %,
  missed heartbeats, upload backlog trend, firmware, certificate expiry, last commands),
  remote commands `POST /v1/devices/{id}/commands { type: "reboot"|"self_test"|"upload_now"|"refresh_plan"|"rotate_logs", requestedBy }`
  → `202 { commandId, status: "pending" }`; the device receives pending commands in the heartbeat
  response `{ commands: [{ commandId, type, issuedAt, expiresAt }] }` and reports
  `POST /v1/devices/{id}/commands/{commandId}/result { status: "succeeded"|"failed", output?, finishedAt }` (signed).
  Commands expire after 30 min; `self_test` returns mic level, disk, clock, network checks.
  Firmware rollout: `GET /v1/fleet/firmware` (versions distribution).

## 4. Capture incident queue (4.8)

Alerts (Phase 1 §10) are the incident records. Additions in notifications:
`GET /v1/incidents?institutionId&status=open|acknowledged|in_progress|resolved&severity&type&campusId&assignee&sort=severity|age`,
`POST /v1/incidents/{id}/assign { assigneeId, actorId }`, `POST /v1/incidents/{id}/status { status: "in_progress", actorId }`,
`POST /v1/incidents/{id}/comments { actorId, body }`, resolution requires `resolutionCode`
(`hardware_replaced`, `network_fixed`, `configuration`, `false_positive`, `class_cancelled`, `other`).
SLA by severity (critical 1 h, high 4 h, medium 24 h, low 72 h) → `slaDueAt`, `slaBreached`.
`GET /v1/incidents/stats?institutionId&from&to` → MTTA, MTTR, open by severity, breaches.

## 5. Recording governance (4.10, 4.12)

* Policy versions (organization): every `PATCH /v1/recording-policies/{id}` creates an immutable version
  (`GET /v1/recording-policies/{id}/versions`); recordings reference the policy version in force.
* Consent (4.10): `POST /v1/consents { subjectType: "student"|"professor", subjectId, policyId, classSectionId?, given, actorId }`,
  `POST /v1/consents/{id}/withdraw`, `GET /v1/consents?policyId&classSectionId&subjectId`,
  `GET /v1/class-sections/{id}/consent-status` → `{ requiresExplicitConsent, allProfessorsConsented, studentsConsented, studentsTotal, recordingAllowed }`.
  When a policy requires explicit consent, academic-integration's recording plan sets
  `recordingEnabled=false, disabledReason: "consent_missing"` (organization exposes this via
  `GET /v1/classrooms/{id}/recording-policy?classSectionId=` → adds `consentSatisfied`).
* Retention (4.12): `POST /v1/retention/run { institutionId, now, dryRun }` computes due items per
  policy (`audio` after `audioRetentionDays`, `transcript`, `summary`, `extracted_event`) by asking each data
  owner via `RetentionTarget` clients (`GET /internal/v1/retention/candidates?institutionId&olderThan&kind` →
  ids; `POST /internal/v1/retention/delete { ids, kind, jobId }` → deleted ids), respecting **legal holds**
  (`POST /v1/legal-holds { scope: { type: "class_section"|"recording"|"subject", id }, reason, actorId }`,
  `DELETE /v1/legal-holds/{id}`). Jobs: `GET /v1/retention/jobs`, `GET /v1/retention/jobs/{id}` (counts per
  kind, skipped by hold, failures). Every deletion is audited (`retention.deleted`, `retention.skipped_hold`);
  audit events themselves follow their own 7-year retention and are never deleted by this job.

## 6. LGPD data subject rights (4.11)

identity: `POST /v1/dsr { subjectType, subjectId, institutionId, type: "access"|"correction"|"deletion"|"anonymization"|"restriction", requestedBy, channel, details? }`
→ `{ id, status: "received", dueAt }` (due in 15 days — LGPD art. 19). Workflow:
`received → verifying → in_progress → completed | rejected` with `POST /v1/dsr/{id}/verify`,
`POST /v1/dsr/{id}/execute`, `POST /v1/dsr/{id}/reject { reason }`; execution fans out to
`DataSubjectHandler` clients per service (`POST /internal/v1/dsr/{type} { subjectType, subjectId, requestId }` →
`{ service, status, items, exportUri? }`); access requests produce a JSON export bundle; deletions of
students anonymise authored content (reports, assistant questions) and remove notifications, preferences,
credentials and consents, while lecture content is unaffected (it is not personal data of the student).
`GET /v1/dsr?status&institutionId`, `GET /v1/dsr/{id}` (per-service results, timeline). Audited
(`dsr.received`, `dsr.verified`, `dsr.completed`, `dsr.rejected`).

## 7. Administration web (4.1, 4.3, 4.6, 4.7, 4.8, 4.10)

Pages (pt-BR, same a11y bar as Phase 3): `/` campus overview (capture coverage today, failures,
processing status, open incidents by severity), `/coordenacao` coordinator workspace (courses, coverage,
adoption, assessment calendar, conflicts), `/coordenacao/cursos/[courseId]` syllabus vs topics,
`/calendario-avaliacoes`, `/devices` (fleet console with filters, paging, commands), `/devices/[id]`
(diagnostics, command history), `/incidentes` queue + detail (assign, status, comments, resolve),
`/relatorios` (operational reports with CSV download), `/governanca` (policies + versions, consent
status by section, legal holds, retention jobs, DSR queue).
