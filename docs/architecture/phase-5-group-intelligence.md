# Phase 5 — Group Intelligence (Contracts)

Executive, cross-institution visibility for the holding company. **No individual student data is ever
exposed**: group views only read aggregates; student-derived counts follow the cohort rule (min 5).

## 1. Component map

| Component | Lang | Port | Deliverables |
|---|---|---|---|
| `services/group-intelligence` | TS / Fastify | 4010 | 5.2–5.6, 5.8–5.10 |
| `infrastructure/terraform/modules/bigquery` + `data/bigquery/` | Terraform / SQL | — | 5.7 |
| `services/identity` | TS | 4001 | 5.1 — `group_executive` role scoped to a holding company |
| `apps/administration-web` (`/grupo/*`) | Next.js | 3002 | 5.1 workspace UI |

## 2. Access (5.1)

New role `group_executive` with claim `hc` (holding company id) in the access token; may read any
institution of that holding company through group-intelligence only (other services keep denying
cross-institution access). Coordinators/admins never see group views.

## 3. Data pipeline (5.7)

* Source: academic-analytics daily `analytics_class_facts` + snapshots, ai-gateway `ai_calls`,
  device-management fleet daily rollup, notifications incident stats, identity active users per role.
* `POST /v1/pipeline/run {date}` (internal) builds the **group fact tables** for that date:
  `institution_daily` (institutionId, date, classesScheduled, classesCaptured, classesTranscribed,
  classesStructured, eventsExtracted, eventsReviewed, activeStudents*, activeProfessors, assistantQuestions*,
  searches*, devicesTotal, devicesOnline, deviceUptimePct, incidentsOpened, incidentsResolved, mttrMinutes,
  aiCostUsd, sttCostUsd, storageCostUsd, infraCostUsd) — `*` = cohort-suppressed when < 5;
  `campus_daily` (same, per campus); `cost_daily` (institutionId, campusId?, category: ai|stt|storage|compute|hardware, amountUsd, source).
* Warehouse adapter interface: `BigQueryWarehouse` (dataset `ci_group_<env>`, partitioned by `date`,
  clustered by `institution_id`; `insertAll`/load job via REST with a service-account token — lazy,
  untested here) and `PostgresWarehouse` / in-memory for dev and tests. DDL in `data/bigquery/*.sql`
  (standard SQL) and Terraform module creating dataset, tables, a `group_reader` authorised view per
  holding company, and a scheduled query.
* Cost inputs: ai-gateway `/v1/usage` (AI), configured per-minute STT price × transcribed minutes,
  storage GB-month × price, hardware amortisation (device cost / 36 months), compute allocation table
  (`POST /v1/cost-allocations`). All prices in `config/pricing.json` with an `asOf` date.

## 4. API (group-intelligence)

All responses carry `provenance: { sources: [...], generatedAt, dataThrough, limitations: [...] }`.

* `GET /v1/groups/{holdingCompanyId}/overview?from&to` (5.2) — per institution: capture rate,
  transcription rate, adoption (professors with ≥ 1 reviewed class / professors teaching), active students
  (suppressed rule), device uptime, open incidents, cost per captured class; group totals; trend vs previous period.
* `GET /v1/groups/{id}/comparison?metric&from&to` (5.3) — institutions ranked on one metric with
  **context notes** (`contextNotes`: size band, modality mix, # campuses, device fleet age, days of data,
  term-calendar offset) and a `comparable: boolean` flag when structural differences exceed thresholds.
* `GET /v1/groups/{id}/academic-indicators` (5.4) — syllabus coverage ratio, assessment load index,
  conflict rate, event review latency p50, correction rate — per institution.
* `GET /v1/groups/{id}/operations` (5.5) — fleet size, uptime, incidents MTTR, firmware currency,
  **cost per captured class** = (ai + stt + storage + compute + hardware amortisation) / classes captured.
* `GET /v1/groups/{id}/adoption?granularity=week|month` (5.8) — time series per institution.
* `GET /v1/groups/{id}/costs?groupBy=institution|campus|category&from&to` (5.9) and
  `GET /v1/groups/{id}/ai-usage` (5.10) — tokens, calls, cost by task/model/prompt version/institution.
* `POST /v1/groups/{id}/investigations { question }` (5.6) — natural-language investigation:
  the question goes to ai-gateway (prompt `group-investigation`) with **only** the tool catalogue below;
  the model returns a plan of tool calls, the service executes them against the fact tables, then asks
  the model to answer from the results. Response: `{ answer, findings: [{ statement, metric, value, institutionIds, period }], queriesRun: [{ tool, params, rows }], provenance, limitations, refusal? }`.
  Tools: `metric_by_institution(metric, from, to)`, `metric_timeseries(metric, institutionId?, granularity, from, to)`,
  `cost_breakdown(groupBy, from, to)`, `compare_periods(metric, a, b)`. Every numeric claim in `answer`
  must appear in `queriesRun` results (validated; ungrounded numbers are removed and listed in
  `limitations`). Questions about individuals → refusal `individual_data_not_available`.

## 5. Privacy guarantees (DoD)

* Fact tables contain no student identifiers (only counts); suppression applied at build time.
* Group API never proxies to per-student endpoints.
* Test: a fixture with a 3-student section must not leak its count anywhere in group responses.
