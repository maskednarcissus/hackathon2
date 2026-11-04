# Handoff — Classroom Intelligence (cloud session → local team)

Branch: `cloud-handoff` (from `feat/phase-1-capture-transcription`). All work after Phase 0 lives here.
The last commit (`WIP: in-progress agent work`) is a snapshot of unfinished work — see §3.

## 1. How to run locally

```bash
pnpm install
pnpm turbo run typecheck test build lint        # TS services, apps, packages
```
Python services (each dir has `pyproject.toml`, Python 3.12):
```bash
python -m venv .venv && . .venv/bin/activate
pip install -e "services/<svc>[dev]"      # audio-ingestion, audio-processing, transcription,
cd services/<svc> && ruff check . && mypy src/ && pytest   # speaker-diarization, ai-gateway,
                                                           # lecture-intelligence, event-extraction
pip install -e "hardware/firmware[dev]"   # device agent
```
Postgres tests run when `TEST_DATABASE_URL` points to an empty PG 16 server (admin URL); each test file
creates and drops its own database and applies `data/migrations/V*.sql` + `data/migrations/pending/*.sql`.

Contracts (read first): `docs/architecture/phase-{1..6}-*.md`, `docs/architecture/integration-stage.md`.

## 2. State at handoff (all verified in the cloud session unless noted)

* Phases 1–6: services implemented with in-memory + Postgres adapters, event-bus publishers, internal
  token, tests passing (counts in each commit message / service README).
* Migrations V001–V004 apply cleanly on PG 16. Schema changes since V004 are in
  `data/migrations/pending/*.sql` (idempotent, applied by tests in filename order) — **not yet merged
  into a numbered `V005__integration.sql`.** Merge them (watch ordering: `calendar.sql` before
  `calendar-phase6.sql`; enum `ADD VALUE` statements in `identity.sql` / `audit.sql` must not be used in the
  same transaction).
* Last full-repo green run: commit `b3f60d1` (before integration). Later commits were verified per
  service, not as a whole repo — **run the full check first.**

## 3. Unfinished work (in the WIP commit — may not build/pass)

| Area | What was in progress | Next step |
|---|---|---|
| `infrastructure/dev-event-bus`, `infrastructure/events/subscriptions.yaml`, `infrastructure/terraform` (pubsub push subs, scheduler, bigquery wiring, group-intelligence SA), `infrastructure/docker/docker-compose.full.yml`, `tests/e2e/run_e2e.py` | Integration stage §2, §6, §7. The e2e run in Postgres mode was executing when the session stopped. | Run `tests/e2e/run_e2e.py --local`, fix the failing step; `terraform validate` (never run — no binary in cloud). Make sure subscriptions include `calendar-external-sync` (`/internal/v1/events/calendar`) and `transcript-management-concepts` (`/v1/events/lecture-structured`). |
| `apps/administration-web` | Reconciling Phase 4 pages with the real backend shapes (was tested only against a mock). | Finish + run against real services; then build `/grupo/*` (Phase 5 UI — not started). |
| `services/academic-integration` | Phase 6 SIS/LMS connectors (TOTVS, Banner, Colleague, Moodle, Canvas, Blackboard) + `language` on course/section. | Finish, fixture tests, typecheck/lint. |
| `services/audio-ingestion`, `services/audio-processing` | Accept `audioFormat: "flac"` (firmware gen2 already sends it) and pass `language` through events. | Finish; until done, gen2 FLAC uploads are rejected. |
| `services/transcription` | `POST /internal/v1/jobs/reap` for jobs stuck in `running`. | Finish + scheduler job. |

## 4. Known gaps (not started / needs real-world validation)

* Never executed against real cloud: Google Speech/Chirp, Vertex Gemini + embeddings, GCS, Pub/Sub,
  BigQuery, Terraform, Google Calendar / Microsoft Graph, SIS/LMS APIs, Web Push services.
* Needs physical/field data: capture device (ALSA, PKCS#11, attestation roots), WER on a real pt-BR corpus
  (`tests/audio-evaluation` has no corpus), diarization calibration on real classrooms, live LLM
  regression baseline (`.github/workflows/ai-regression.yml` live job needs `AI_REGRESSION_GCP_SA_KEY`).
* Accessibility: automated checks only; manual screen-reader + axe-core pass pending.
* `apps/api` (BFF) is still a placeholder; `.github/workflows/migration-check.yml` uses golang-migrate
  naming and is broken (the `test-migrations` job in `ci.yml` replaces it).
* Admin console still uses a static `ADMIN_API_TOKEN` instead of identity login.
