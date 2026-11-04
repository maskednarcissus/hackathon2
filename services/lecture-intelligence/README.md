# Lecture Intelligence Service

Turns transcripts into grounded, student-facing lecture materials. Phase 2 deliverables
**2.3** (title, topic outline, definitions, Q&A), **2.4** (executive summary), **2.5** (key concepts),
**2.6** (reading references), **2.7** (structured output validation) and **2.21** (hallucination prevention).
Contract: [`docs/architecture/phase-2-classroom-intelligence.md`](../../docs/architecture/phase-2-classroom-intelligence.md) §3.

Port **8006** · Python · FastAPI · calls `ai-gateway` (never a model SDK directly)

## Endpoints

| Method | Path                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/lectures/structure`                                                 | Structure a transcript (`institutionId` required for AI cost accounting)                                                                                                                                                                                                                                                                                            |
| `GET`  | `/v1/lectures?classSectionIds=a,b&q&courseId&from&to&sort&page&pageSize` | Lecture library (`classSectionIds` mandatory; `sort` = `recent`\|`oldest`\|`course`\|`title`, aliases `date_desc`/`date_asc`; `pageSize` ≤ 100) → `{items:[{lectureSummaryId, scheduledClassId, transcriptId, classSectionId, courseId, courseName, classDate, startsAt, title, executiveSummary (≤ 280 chars), topicCount, conceptCount}], page, pageSize, total}` |
| `GET`  | `/v1/lectures/{scheduledClassId}`                                        | Latest structure for a class (includes `classSectionId`, `courseId`, `courseName`, `classDate`, `startsAt` when known)                                                                                                                                                                                                                                              |
| `POST` | `/v1/assistant/ask`                                                      | Academic assistant (3.13/3.14) — grounded, cited answers (see below)                                                                                                                                                                                                                                                                                                |
| `POST` | `/v1/assistant/feedback`                                                 | `{answerId, helpful, comment?, studentId?}` → `201`                                                                                                                                                                                                                                                                                                                 |
| `POST` | `/v1/events/transcript-created` · `/v1/events/diarization-completed`     | Event handlers (raw envelope or Pub/Sub push); fetch the transcript from transcript-management, structure it, publish `lecture.structured`; duplicate `eventId`s are ignored                                                                                                                                                                                        |

## Pipeline

1. Segments are rendered as `[s<index> hh:mm:ss] text` and split on segment boundaries into chunks of
   at most `LECTURE_MAX_CHUNK_TOKENS` (default 12 000 estimated tokens).
2. **Map:** each chunk → `lecture-structuring` prompt (bounded concurrency).
3. **Reduce:** with more than one chunk, the partial titles/summaries/topics → `lecture-structuring-merge`;
   concepts, questions and reading references are merged deterministically (deduplicated, citations unioned).
4. **Grounding validation** (nothing from the model is trusted):
   - every item must cite existing segment indexes (`missing_citation`, `invalid_segment_reference`);
   - concept terms (≥ 60 % of content tokens), reading titles (≥ 60 %), questions (≥ 30 %), topic titles
     (≥ 1 token) and concept definitions (≥ 20 %) must be supported by the cited segments ±1 neighbour
     (accent-insensitive, light Portuguese stemming) — otherwise `ungrounded`, dropped;
   - unsupported authors / answers are removed (`ungrounded_authors`, `ungrounded_answer`);
   - sentences quoting words that are not literally in the transcript are removed (`fabricated_quote`) —
     AI explanations are never presented as professor statements;
   - topic `startMs/endMs` come from the cited segments, not from the model;
   - a suspected prompt injection reported by the gateway adds a `$ injection_suspected` flag.
5. Stored, `lecture.structured` published, `lecture.structured` audit event recorded.

## Academic assistant (Phase 3 §4)

- The student question is untrusted. Instruction-like questions (override, system-prompt probing, role
  reassignment, delimiter spoofing) get `refusal: "injection_suspected"` **before** retrieval or any model
  call — refusing is cheaper and safer than flagging, and no legitimate study question needs those phrases.
- Retrieval: transcript-management `GET /v1/search?mode=hybrid` restricted to the caller's
  `classSectionIds` (optionally one `scheduledClassId`); results from other sections are discarded again
  here. Stored lecture structures for the retrieved classes are added as AI-summary context (`l1…`) —
  never citable. Short follow-ups reuse the previous question for retrieval.
- No retrieved passage → `refusal: "no_evidence"` without calling the model.
- Model output (`assistant-answer` prompt) is validated: unknown citation ids removed; a
  `professor_statement` needs a cited passage **and** either a verbatim (normalised) `quote` from it or
  ≥ 60 % lexical support, otherwise it is downgraded to `ai_explanation`; `ai_explanation` blocks have
  attribution phrases ("o professor disse que", "segundo a professora") stripped. Citation `quote` is the
  verified verbatim excerpt, or the full passage.
- Conversation memory: last 6 turns per `conversationId`, bound to the student and institution
  (another student's id → `404`).

## Revision materials (Phase 6.2) and languages (6.4)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/revision/plans` | `{studentId, classSectionIds, from?, to?, focus?: conceptIds[], institutionId?, maxConcepts? (1–30, 10), maxLectures? (1–10, 5)}` → `201` plan |
| `GET` | `/v1/revision/plans/{planId}?studentId` | Stored plan (owner only, else `404`) |
| `POST` | `/v1/revision/reviews` | `{itemId, grade 0–5, studentId?}` → SM-2 schedule; `422` for `summary` items, `404` for another student's item |
| `GET` | `/v1/revision/due?studentId&limit` | Reviewable items due now, with `schedule` |

* Inputs: latest lecture structures of the requested sections (in the date range) and **only the student's
  own** signals — their assistant questions (concept term mentioned), their SM-2 history (reviews graded < 3)
  and the explicit `focus` list. Searches and content reports are not available to this service yet.
* Items: one `summary` per selected lecture and one `concept_review` per selected concept (from the
  validated structure); `flashcards` and `quiz` items (one card/question each) from the `revision-materials`
  prompt, validated like lecture structures — known concept, valid segment citations, card back ≥ 30 % /
  correct option ≥ 40 % lexically supported by the cited segments ±1, 4 distinct options, fabricated quotes
  removed. Failures degrade gracefully to structure-only items with `limitations`.
* Auth: a verified student token must match `studentId` (`403`); review ownership mismatches are `404`.
* DSR access/deletion include revision plans and reviews. Lectures now carry `language` (from the
  transcript) and concepts a stable `id`; the structuring prompts `2026-11-05.1` write in that language.

## Integration stage

| Concern | Behaviour |
|---|---|
| Persistence | `DATABASE_URL` → Postgres (`adapters/postgres.py`): `lecture_summaries` + `lecture_topics` (with sub-topics via `parent_topic_id`), `concepts`, `questions`, `reading_references` (all with `segment_indexes`), `assistant_conversations/answers/answer_citations/feedback`, `event_inbox`. Conversation memory = last N `assistant_answers` by `turn_index` (assigned under a per-conversation advisory lock). |
| Events | Publisher: `EVENT_BUS_URL` → `POST {url}/v1/topics/{type}:publish` (with `x-internal-token`), else `PUBSUB_PROJECT_ID` → Pub/Sub, else in-memory. Handlers accept raw envelopes or Pub/Sub push; idempotent by `eventId` (fallback `messageId`) via `event_inbox`; 2xx only after processing. |
| Service auth | `INTERNAL_API_TOKEN` → `x-internal-token` required on `/internal/*` and `/v1/events/*`. |
| Retention (`summary`) | `GET /internal/v1/retention/candidates?institutionId&olderThan&kind=summary` → `{kind, institutionId, ids}`; `POST /internal/v1/retention/delete {ids, kind, jobId}` → `{kind, jobId, deletedIds}` (children cascade). |
| DSR | `POST /internal/v1/dsr/{access\|deletion\|anonymization\|correction\|restriction} {subjectType, subjectId, requestId}` → `{service, status, items, export?}`. Students: access exports conversations, answers and feedback; deletion removes them; anonymisation replaces questions with `[removido a pedido do titular]` and clears feedback comments. Professors / correction / restriction → `not_applicable`. Lecture content is untouched. |
| Engagement audit | `lecture.viewed` on `GET /v1/lectures/{id}` and `lecture.assistant_question` on ask — `actorType: student`, `metadata.classSectionId`; never the question text. Actor = verified identity JWT (`IDENTITY_JWKS_URL`, EdDSA, `pid` → actorId) or `X-Actor-Id`/`X-Actor-Role` (default `student`). Without a JWKS URL tokens are only decoded (dev). A verified student token whose `pid` ≠ `studentId` on ask → `403`. |

Pending schema: `data/migrations/pending/lecture-intelligence.sql`. Postgres tests:
`TEST_DATABASE_URL=postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433 pytest` (`tests/test_postgres_pg.py`).

## Configuration

`AI_GATEWAY_URL` (default `http://localhost:8005`), `TRANSCRIPT_MANAGEMENT_URL` (`http://localhost:4008`),
`ACADEMIC_INTEGRATION_URL` (`http://localhost:4003`, class/course metadata for event-driven structuring), `DATABASE_URL`, `EVENT_BUS_URL`, `INTERNAL_API_TOKEN`, `IDENTITY_JWKS_URL`, `AUDIT_SERVICE_URL`, `PUBSUB_PROJECT_ID` (enables Pub/Sub publishing, extra `gcp`), `LECTURE_MAX_CHUNK_TOKENS`.

## Development

```bash
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy src/ && pytest
uvicorn main:app --app-dir src --port 8006
```
