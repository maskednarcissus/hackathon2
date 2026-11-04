# Student Web (`@ci/student-web`)

The student workspace for Phase 3 (deliverables 3.2–3.5, 3.7, 3.8, 3.12–3.17). It is built with Next.js 15 (App Router) and React 19, in pt-BR.
The app works as a server-side BFF: the browser never calls backend services directly.

## Pages

| Route                                                  | Content                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `/entrar`                                              | Login (server action → identity `POST /v1/auth/login`). Only `student` role accepted                                    |
| `/`                                                    | Upcoming assessments and deadlines, class changes, recent lectures, recent notices                                      |
| `/aulas`                                               | Lecture library: search, course and date filters, sorting, pagination                                                   |
| `/aulas/[scheduledClassId]`                            | Summary, outline with timestamps, concepts, Q&A, readings, announcements. AI blocks are labelled "Gerado por IA"        |
| `/aulas/[scheduledClassId]/transcricao`                | Transcript with `hh:mm:ss` anchors, topic markers, `?t=<ms>` / `?s=<index>` deep links, anonymous speakers ("Pessoa n") |
| `/busca`                                               | Hybrid transcript search with accent-insensitive highlighting                                                           |
| `/calendario?view=mes\|semana\|agenda&data=YYYY-MM-DD` | Month, week and agenda views; status badges with text; ICS subscription                                                 |
| `/calendario/[eventId]`                                | Event detail: source class, timestamp and quote; official vs AI-extracted; change history                               |
| `/assistente`                                          | Academic assistant: "Dito em aula" vs "Explicação gerada por IA" blocks, citations, refusals, feedback                  |
| `/notificacoes`                                        | In-app notifications: filter, mark read / mark all read                                                                 |
| `/preferencias`                                        | Per-category channel toggles (critical in-app is locked), quiet hours, reminder offsets, Web Push opt-in                |

"Reportar informação incorreta" appears on summaries, concepts, transcript segments, calendar events and
assistant answers. It posts to audit `POST /v1/content-reports`.

## Session & security

- Tokens live in httpOnly, `Secure`, `SameSite=Lax` cookies (`ci_at` access, `ci_rt` refresh).
- `src/middleware.ts` refreshes silently through identity `/v1/auth/refresh` when the access token is about to
  expire. The rotated pair is written both to the response and to the forwarded request. Prefetches never refresh.
- The BFF only _decodes_ JWT claims (`sub`, `pid`, `inst`). Every upstream service verifies the signature against
  the JWKS.
- Upstream errors become explicit error states, never thrown pages. A 401 redirects to `/entrar?sessao=expirada`.
- Post-login `next` only accepts same-origin relative paths (no open redirect).
- Search highlighting is rendered as React elements, never as HTML.

## Environment

| Variable                               | Default                                             |
| -------------------------------------- | --------------------------------------------------- |
| `IDENTITY_URL`                         | `http://localhost:4001`                             |
| `CALENDAR_URL` / `CALENDAR_PUBLIC_URL` | `http://localhost:4005`                             |
| `NOTIFICATIONS_URL`                    | `http://localhost:4006`                             |
| `TRANSCRIPT_MANAGEMENT_URL`            | `http://localhost:4008`                             |
| `AUDIT_URL`                            | `http://localhost:4011`                             |
| `LECTURE_INTELLIGENCE_URL`             | `http://localhost:8006`                             |
| `INSTITUTION_ID`                       | unset: the login form asks for the institution code |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`         | unset: push opt-in shows "not available"            |
| `COOKIE_INSECURE=1`                    | only for plain-http testing on non-localhost hosts  |

## Backend shapes consumed

- lecture-intelligence `GET /v1/lectures` (library/home), `LectureStructure.classSectionId` and `concepts[].id`
  (focus concepts for revision), revision endpoints `POST /v1/revision/plans`, `GET /v1/revision/plans/{id}?studentId`,
  `POST /v1/revision/reviews`, `GET /v1/revision/due?studentId`.
- calendar student view: `{ items: [{ …, courseName, source: { scheduledClassId, transcriptId, startMs, quote, … } }] }`;
  detail view keeps `provenance`; history via `?view=student`.
- identity accepts the immediately previous refresh token for 10 s (concurrent refreshes are safe).
- `?secao=` remains only as a fallback when a lecture structure has no `classSectionId`.
- Revision plans have no list endpoint; the BFF keeps the last 5 plan ids in an httpOnly cookie (`ci_rev`).

## Commands

```bash
pnpm --filter @ci/student-web dev        # http://localhost:3000
pnpm --filter @ci/student-web typecheck
pnpm --filter @ci/student-web lint
pnpm --filter @ci/student-web build
```

Accessibility audit: `docs/accessibility/student-web-wcag-audit.md` (script in the same folder).
