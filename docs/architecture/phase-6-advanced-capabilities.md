# Phase 6 — Advanced Capabilities (Contracts)

Builds on all previous contracts and the integration stage (Postgres + event bus + internal token are
mandatory for every new piece; in-memory fallbacks remain for tests).

| # | Deliverable | Owner |
|---|---|---|
| 6.1 | Improved diarization (overlap, multi-turn, re-segmentation) | `speaker-diarization` |
| 6.2 | Personalised revision materials | `lecture-intelligence` + `student-web` |
| 6.3 | Advanced semantic search with concept linking | `transcript-management` (+ `lecture-intelligence` concepts) |
| 6.4 | Additional languages beyond pt-BR | `transcription` (+ text normalisers) |
| 6.5 | SIS connectors: TOTVS RM/Educacional, Ellucian Banner, Ellucian Colleague | `academic-integration` |
| 6.6 | LMS connectors: Moodle, Canvas, Blackboard Learn | `academic-integration` |
| 6.7 | Learning pattern analytics | `academic-analytics` |
| 6.8 | AI evaluation framework with automated regression | `tests/ai-evaluation` + CI |
| 6.9 | External calendar integrations (Google Calendar, Microsoft 365) | `calendar` |
| 6.10 | Second-generation device support | `device-management` + `hardware/firmware` |

## 6.1 Diarization v2
Overlap detection (frames where two clusters' posteriors are both high → `overlap: true` on turns),
Viterbi/HMM re-segmentation with minimum turn duration, spectral clustering with eigengap speaker-count
estimate (cap 8), cross-segment speaker linking for chunked long audio, per-turn confidence. Output adds
`turns[].overlap`, `turns[].confidence`, `speakerCount.estimated`. Metric: DER on synthetic + any labelled
data in `tests/audio-evaluation/diarization/` (reported by `run_benchmark.py --diarization`).
Labels remain anonymous `SPEAKER_n`.

## 6.2 Revision materials
`POST /v1/revision/plans { studentId, classSectionIds, from?, to?, focus?: conceptIds[] }` → plan built from
lecture structures + the student's own signals (assistant questions, searches, report flags — never other
students' data): `{ items: [{ kind: "summary"|"flashcards"|"quiz"|"concept_review", scheduledClassId, conceptIds,
content, sourceCitations }], generatedAt, aiGenerated: true }`. Flashcards/quiz generated via ai-gateway
(prompt `revision-materials`), every item grounded in cited segments (same validation as lecture
structures). Spaced repetition: `POST /v1/revision/reviews { itemId, grade 0-5 }` (SM-2) →
`GET /v1/revision/due?studentId`. Student web: `/revisao`.

## 6.3 Concept-linked search
Concept graph: concepts from lecture structures are normalised into `concept_nodes` (per course, merged by
normalised term + embedding similarity ≥ 0.88) with `concept_mentions` (lecture, segment indexes) and
`concept_edges` (co-occurrence within a lecture / explicit "relacionado a"). `GET /v1/search?…&expand=concepts`
adds query expansion with linked concepts and returns `concepts: [{ id, term, lectures }]`;
`GET /v1/concepts/{id}` (definition variants with citations, lectures, related concepts);
`GET /v1/courses/{courseId}/concept-map`. Section scoping unchanged.

## 6.4 Languages
`language` per class section/course (`pt-BR` default; `en-US`, `es-ES`, `es-419`, `fr-FR`) carried in the
recording plan and `recording.segmented`; transcription picks the Chirp language code + vocabulary per
language; text normalisation (search, event keyword families, benchmark runner) becomes language-aware;
event extraction remains pt-BR-only and **skips** other languages with a recorded limitation (no false
positives); lecture structuring prompt instructs output in the lecture's language.

## 6.5 / 6.6 Connectors
`Connector` interface in academic-integration: `pull({ since }) → CanonicalImport` (same body as
`POST /v1/imports`) with per-connector config `{ type, baseUrl, auth: { kind: "oauth2_client_credentials"|"api_key"|"basic"|"lti13", secretRef }, mappings }`
stored per institution (`PUT /v1/connectors/{institutionId}/{type}`), `POST /v1/connectors/{institutionId}/{type}/sync`
(internal/admin; dry run supported), sync history. SIS: TOTVS RM (REST `/api/framework/v1` + educational
endpoints), Banner (Ethos Integration API `persons`, `sections`, `section-registrations`, `instructional-events`),
Colleague (Ethos). LMS: Moodle (Web services `core_course_get_courses`, `core_enrol_get_enrolled_users`),
Canvas (REST `/api/v1/courses`, `/sections`, `/enrollments`), Blackboard Learn (REST `/learn/api/public/v3/courses`, memberships).
LMS also receives **outbound** publication: lecture summary links and confirmed events posted as
course announcements/calendar items (opt-in per course). All connectors tested against recorded fixture
responses (no live calls); paging, rate limits (429 + Retry-After) and partial failures handled.

## 6.7 Learning patterns
Aggregate (cohort ≥ 5) per section/course: content engagement curves after each class, revisit rate
before assessments, topics with highest assistant-question density ("difficult topics"), search terms
without results, engagement vs. assessment calendar timing. `GET /v1/courses/{id}/learning-patterns`,
`GET /v1/institutions/{id}/learning-patterns`. Never per-student outputs.

## 6.8 AI regression
`tests/ai-evaluation/regression/`: golden datasets for event extraction, lecture structuring grounding,
assistant answers (citation validity, refusal correctness), date resolution, injection resistance;
runner `run_regression.py` producing a scored report, comparing with a committed baseline
(`baseline.json`) and failing on regressions beyond tolerance; prompt changes in ai-gateway trigger the
suite in CI (`paths:` filter) with the fake/heuristic providers, and a manual/nightly workflow runs it
against live models when credentials exist.

## 6.9 External calendars
Per-student OAuth connections: Google Calendar (OAuth 2.0 + Calendar API events insert/patch/delete into a
dedicated "Classroom Intelligence" calendar) and Microsoft 365 (Microsoft Graph `/me/calendars`,
`/events`). `GET /v1/students/{id}/calendar-connections`, `POST …/connect/{provider}` (returns auth URL,
PKCE, state), `GET /v1/oauth/{provider}/callback`, `DELETE …/{connectionId}`. Tokens stored encrypted
(AES-256-GCM, key from Secret Manager). Sync on `calendar.event_*` events + nightly reconcile; idempotent
via stored external ids; respects cancellations. DSR deletion removes connections and remote events.

## 6.10 Device gen2
Model capability registry in device-management: `GET /v1/device-models` (`ci-capture-a1`, `ci-capture-a2`)
with capabilities (`micChannels`, `beamforming`, `onDeviceVad`, `onDeviceEncoding: ["wav","flac","opus"]`,
`hardwareKeystore: tpm|se050|none`, `lte`). Registration accepts a2 with hardware-attested key
(attestation statement verified against a configured vendor root). Recording plan carries the
per-model capture profile (channels, sample rate, encoding). Firmware: capability detection, multichannel
capture with beamformed mono mixdown for upload + raw multichannel optional, FLAC encoding (ingestion &
processing must accept `flac` — coordinated with audio services), on-device VAD to trim silence in
pre/post-roll, keystore abstraction (file | PKCS#11). OTA: `GET /v1/devices/{id}/firmware-update` with
signed manifests (Ed25519), staged rollout percentages per model.
