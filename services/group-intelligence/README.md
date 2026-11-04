# Group Intelligence Service (Phase 5)

Cross-institution executive views for a holding company: capture and adoption, academic
indicators, operations, cost per captured class, AI usage and a grounded natural-language
investigation interface. Contract: [`docs/architecture/phase-5-group-intelligence.md`](../../docs/architecture/phase-5-group-intelligence.md).

**Privacy:** only aggregate upstream endpoints are read; fact tables hold counts, never student
identifiers. Student-derived values (`activeStudents`, `assistantQuestions`, `searches`) are
suppressed (`null`) when the cohort is below 5 — at build time, again at group level, and the
Postgres schema rejects a stored `active_students` < 5.

TypeScript · Fastify · zod · `pg` · port **4010**

## Endpoints

All `/v1/groups/:id/*` routes require an identity access token with role `group_executive` and
claim `hc` equal to `:id` (or the internal token). Every response carries
`provenance: { sources, generatedAt, dataThrough, limitations }`. Ranges: `?from&to`
(`YYYY-MM-DD`, default the 30 days ending yesterday, max 366).

| Method   | Path                                                         | Notes                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/health`                                                    |                                                                                                                                                                                        |
| GET      | `/v1/metrics`                                                | Metric catalogue (name, label, unit, direction, student-derived)                                                                                                                       |
| POST     | `/v1/pipeline/run`                                           | Internal. `{date?, holdingCompanyId?}` — builds `institution_daily`, `campus_daily`, `cost_daily` for the date (default yesterday; idempotent per institution-day; future dates → 422) |
| GET      | `/v1/pipeline/runs`                                          | Internal. Recent runs with per-source errors                                                                                                                                           |
| GET      | `/v1/groups/:id/overview`                                    | 5.2 — per institution + totals, trend vs previous period                                                                                                                               |
| GET      | `/v1/groups/:id/comparison?metric=`                          | 5.3 — ranked, `contextNotes`, `comparable` + reasons                                                                                                                                   |
| GET      | `/v1/groups/:id/academic-indicators`                         | 5.4 — live from academic-analytics (≤ 186 days)                                                                                                                                        |
| GET      | `/v1/groups/:id/operations`                                  | 5.5 — fleet, incidents, cost per captured class by category                                                                                                                            |
| GET      | `/v1/groups/:id/adoption?granularity=week\|month`            | 5.8 — time series per institution                                                                                                                                                      |
| GET      | `/v1/groups/:id/costs?groupBy=institution\|campus\|category` | 5.9                                                                                                                                                                                    |
| GET      | `/v1/groups/:id/ai-usage`                                    | 5.10 — live from ai-gateway, merged by task/model/prompt version                                                                                                                       |
| POST/GET | `/v1/groups/:id/cost-allocations`                            | Monthly compute allocations `{institutionId, month, amountUsd, note?}`                                                                                                                 |
| POST     | `/v1/groups/:id/investigations`                              | 5.6 — `{question}` → `{answer, findings, queriesRun, refusal, limitations, provenance}`                                                                                                |

### Investigations (5.6)

1. Questions about individuals are refused locally (`individual_data_not_available`) — no model call.
2. Plan: ai-gateway prompt `group-investigation` returns ≤ 6 tool calls (`metric_by_institution`,
   `metric_timeseries`, `cost_breakdown`, `compare_periods`). The question is sent only as an
   untrusted input; suspected injection → refusal `injection_suspected`.
3. Tools run against the fact tables (unknown tools/metrics, foreign institutions and ranges > 366
   days are skipped and listed in `limitations`).
4. Answer: prompt `group-investigation-answer` writes from the results. Every number in the answer
   and in each finding must match a value in `queriesRun` (± 1 %, ratios also as %); unsupported
   sentences/findings are removed and quoted in `limitations`.

## Data sources

| Source             | Endpoint                                                                                                                                                                      | Auth                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| organization       | `GET /v1/institutions?holdingCompanyId`, `GET /v1/campuses?institutionId`                                                                                                     | —                                                                  |
| academic-analytics | `reports/capture-coverage`, `adoption`, `reports/transcription-success`, `reports/corrections`, `assessment-calendar`, `assessment-conflicts`, `GET /v1/courses/:id/coverage` | `ANALYTICS_INTERNAL_TOKEN` as bearer (analytics' `INTERNAL_TOKEN`) |
| ai-gateway         | `GET /v1/usage`, `POST /v1/generate`                                                                                                                                          | —                                                                  |
| device-management  | `GET /v1/fleet` (paged), `GET /v1/fleet/firmware`                                                                                                                             | `DEVICE_MANAGEMENT_ADMIN_TOKEN`                                    |
| notifications      | `GET /v1/incidents/stats`                                                                                                                                                     | `NOTIFICATIONS_ADMIN_TOKEN`                                        |

Costs: AI = ai-gateway usage; STT, storage and hardware are estimates from
[`config/pricing.json`](./config/pricing.json) (`asOf` dated; surfaced in limitations); compute =
monthly allocations ÷ days in month. Device availability is point-in-time at each daily run
(device-management keeps no daily history). Identity user counts are not used: active professors
come from analytics adoption.

## Warehouse

`WAREHOUSE=bigquery` (+ `BIGQUERY_PROJECT_ID`, `BIGQUERY_DATASET`, `BIGQUERY_LOCATION`) → BigQuery via
REST `jobs.query` DML (metadata-server token; not exercised here — no GCP credentials); else
`DATABASE_URL` → Postgres (`data/migrations/pending/group-intelligence.sql`); else in-memory.
BigQuery DDL: `data/bigquery/`; Terraform: `infrastructure/terraform/modules/bigquery`.

## Configuration

| Variable                                                                                                     | Default                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `PORT`                                                                                                       | `4010`                                                       |
| `AUTH_DISABLED`                                                                                              | `false` (dev only)                                           |
| `IDENTITY_JWKS_URL`                                                                                          | `http://localhost:4001/.well-known/jwks.json`                |
| `INTERNAL_API_TOKEN`                                                                                         | — (pipeline routes closed without it unless `AUTH_DISABLED`) |
| `GROUP_HOLDING_COMPANY_IDS`                                                                                  | — comma-separated, used by scheduled runs without a body     |
| `INVESTIGATION_BILLING_INSTITUTION_ID`                                                                       | first institution of the group                               |
| `PRICING_CONFIG_PATH`                                                                                        | built-in defaults (same as `config/pricing.json`)            |
| `ORGANIZATION_URL`, `ACADEMIC_ANALYTICS_URL`, `AI_GATEWAY_URL`, `DEVICE_MANAGEMENT_URL`, `NOTIFICATIONS_URL` | localhost ports                                              |

`src/jwt-verify.ts` is vendored from `services/identity` with one local change (role
`group_executive`, claim `hc`) — keep in sync.

## Tests

`pnpm test` — 33 tests with in-memory fakes (pipeline, access control, every view, investigations,
privacy leak test). `TEST_DATABASE_URL=<admin url> pnpm test` also runs the Postgres warehouse
tests (3) in a scratch database.
