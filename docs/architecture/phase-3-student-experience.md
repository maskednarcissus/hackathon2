# Phase 3 — Student Experience (Contracts)

Shared contract for Phase 3. Builds on the Phase 1 and Phase 2 contracts.

## 1. Component map

| Component | Lang | Port | Deliverables |
|---|---|---|---|
| `services/identity` | TS / Fastify | 4001 | 3.1 |
| `apps/student-web` | Next.js | 3000 | 3.2–3.5, 3.7, 3.8, 3.12, 3.13–3.17 (UI) |
| `services/transcript-management` | TS / Fastify | 4008 | 3.6 search |
| `services/lecture-intelligence` | Py / FastAPI | 8006 | 3.6 (lecture index), 3.13, 3.14 assistant |
| `services/ai-gateway` | Py / FastAPI | 8005 | embeddings for 3.6 / 3.13 |
| `services/calendar` | TS / Fastify | 4005 | 3.8, 3.9, 3.10 |
| `services/notifications` | TS / Fastify | 4006 | 3.11, 3.12 |
| `services/audit` | TS / Fastify | 4011 | 3.15 content reports |

## 2. Identity & access control (3.1)

* `POST /v1/auth/login {email, password, institutionId}` → `{ accessToken, refreshToken, expiresIn, user }`.
  Passwords hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt). Lockout after 5 failures for 15 min.
  OIDC/SAML SSO is pluggable (`IdentityProvider` interface) — Phase 3 ships local credentials + an OIDC
  authorization-code adapter configured per institution (`GET /v1/auth/oidc/{institutionId}/start`, `/callback`).
* Access token: JWT **EdDSA (Ed25519)**, 15 min, claims
  `{ iss: "ci-identity", sub: userId, aud: "ci", iat, exp, jti, inst: institutionId, role: "student|professor|coordinator|admin", pid: studentId|professorId }`.
  Public keys at `GET /.well-known/jwks.json` (OKP / Ed25519, `kid`). Refresh tokens: opaque, 30 days,
  stored hashed, **rotated on every use**, reuse of a rotated token revokes the whole family.
  `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/me`.
* Enrollment-based authorization: identity keeps a mirror of active enrollments and section teaching
  assignments (`POST /v1/sync/enrollments`, `POST /v1/sync/sections` — fed by academic-integration).
  `POST /v1/authorize { subject (token or userId), action: "read", resource: { type: "class_section"|"scheduled_class"|"transcript"|"lecture"|"calendar_event", classSectionId } }`
  → `{ allowed, reason }`. `GET /v1/me/sections` returns the caller's accessible class section IDs.
  Rule: students → only sections with an `active` enrollment; professors → sections they teach;
  coordinators/admins → their institution. Cross-institution access is always denied.
* Other services verify tokens with JWKS (shared verifier module in `services/identity/src/jwt-verify.ts`
  documented for reuse) and accept `Authorization: Bearer`.

## 3. Search (3.6)

`GET /v1/search?q=<text>&classSectionIds=a,b&limit=20&mode=hybrid|lexical|semantic` (transcript-management)
→ `{ results: [{ transcriptId, scheduledClassId, classSectionId, segmentIndex, startMs, endMs, text, highlight, score, speakerLabel? }] }`.
Hybrid = BM25 over pt-BR normalised tokens (accent-insensitive, stopwords, light stemming) fused with
embedding cosine via reciprocal-rank fusion. Embeddings from ai-gateway
`POST /v1/embed { texts: [], institutionId, purpose: "search_index"|"query" }` →
`{ vectors: number[][], model, dimensions, usage }` (Vertex `text-multilingual-embedding-002`; the `fake`
provider returns deterministic hashed bag-of-words vectors, 256 dims). Callers **must** pass the caller's
accessible `classSectionIds` (from identity); search never returns other sections.

## 4. Academic assistant (3.13, 3.14)

`POST /v1/assistant/ask` (lecture-intelligence)
```json
{ "question": "O que é a curva IS-LM?", "studentId", "institutionId",
  "classSectionIds": ["…"], "scheduledClassId?": "…", "conversationId?": "…" }
```
→
```json
{ "answerId", "conversationId",
  "answer": [ { "kind": "professor_statement", "text": "…", "citationIds": ["c1"] },
              { "kind": "ai_explanation", "text": "…", "citationIds": [] } ],
  "citations": [ { "id": "c1", "scheduledClassId", "transcriptId", "segmentIndex", "startMs", "endMs",
                   "quote": "exact transcript passage", "classDate?", "courseName?" } ],
  "grounded": true, "refusal": null | "no_evidence" | "out_of_scope" | "injection_suspected",
  "provenance": { "promptId", "promptVersion", "model" } }
```
Rules: retrieval via §3 search (+ lecture structures); `professor_statement` blocks must cite ≥ 1
citation whose `quote` is a verbatim transcript passage (validated server-side; otherwise downgraded to
`ai_explanation`); `ai_explanation` blocks are always labelled "Explicação gerada por IA" in UI and never
phrased as "o professor disse"; no evidence → refusal `no_evidence`. Student questions are untrusted input.
`POST /v1/assistant/feedback { answerId, helpful, comment? }`.

## 5. Calendar for students (3.7–3.10)

* `GET /v1/students/{studentId}/calendar-events?from&to` — events of enrolled sections with
  `status`, `isOfficial`, `source` (provenance: class, timestamp, quote) and `history` (3.9).
* `GET /v1/calendar-events/{id}/history` — ordered changes visible to students (3.9).
* Export (3.10): `GET /v1/students/{studentId}/calendar.ics?token=<feedToken>` (RFC 5545, `VTIMEZONE`
  America/Sao_Paulo, stable `UID = <eventId>@classroom-intelligence`, `SEQUENCE` = change count,
  `STATUS:CANCELLED` for cancellations, `DESCRIPTION` includes source class + timestamp);
  `POST /v1/students/{studentId}/calendar-feed-token` issues/rotates an unguessable feed token
  (stored hashed). Subscribing from Google/Apple/Outlook = external synchronisation.

## 6. Notifications (3.11, 3.12)

* Triggers: `event.published` → "Nova avaliação/prazo"; `event.updated` with date change → "Prazo alterado";
  cancellation → "Aula cancelada"; `lecture.structured` → "Resumo da aula disponível"; reminders
  (24 h and 2 h before assessments). Fan-out to students with active enrollments in the section.
* Channels: `in_app` (stored; `GET /v1/users/{userId}/notifications?unread=`, `POST …/{id}/read`,
  `POST …/read-all`), `email` (provider webhook), `push` (Web Push subscription
  `POST /v1/users/{userId}/push-subscriptions` with endpoint/keys; delivery adapter interface — VAPID/FCM
  implementation behind it).
* Preferences (3.12): `GET/PUT /v1/users/{userId}/notification-preferences`
  `{ categories: { new_assessment, deadline_change, class_cancellation, lecture_summary, reminder }: { in_app, email, push }, quietHours: { start: "22:00", end: "07:00", timezone }, reminderOffsetsHours: [24, 2] }`.
  `in_app` cannot be disabled for `deadline_change` and `class_cancellation` (critical). Quiet hours defer push/email.
  Deduplication key `(userId, category, resourceId, version)`.

## 7. Report incorrect information (3.15)

`POST /v1/content-reports` (audit) `{ reporterId, reporterRole, institutionId, resourceType: "lecture_summary"|"concept"|"transcript_segment"|"calendar_event"|"assistant_answer", resourceId, classSectionId, reason: "incorrect_date"|"incorrect_content"|"misattributed_statement"|"transcription_error"|"other", details? }`
→ `201`; `GET /v1/content-reports?classSectionId&status`, `POST /v1/content-reports/{id}/resolve { actorId, resolution, notes }`.
Each report writes audit `content.reported` / `content.report_resolved` and emits `content.reported` (professor review).

## 8. Student web (3.2–3.5, 3.16, 3.17)

Server-side BFF in `apps/student-web` (route handlers / server actions) holding the session in an
httpOnly, Secure, SameSite=Lax cookie; all upstream calls carry the student's access token and the
`classSectionIds` from `GET /v1/me/sections`. Pages: `/entrar`, `/` (home: upcoming events, recent
classes, announcements), `/aulas` (library: search, filters by course/date, sorting), `/aulas/[scheduledClassId]`
(summary, outline, concepts, Q&A, announcements, AI labelling), `/aulas/[scheduledClassId]/transcricao`
(timestamp navigation, topic markers, `?t=ms` deep link), `/busca`, `/calendario` (month / week / agenda,
status + source inspection, history), `/assistente`, `/notificacoes`, `/preferencias`. Mobile-first
(≥ 320 px), WCAG 2.2 AA (contrast ≥ 4.5:1, focus visible, target ≥ 24 px, keyboard operable, landmarks,
status never colour-only, `prefers-reduced-motion`), pt-BR. Accessibility audit recorded in
`docs/accessibility/student-web-wcag-audit.md` (automated axe run via Playwright + manual checklist).
