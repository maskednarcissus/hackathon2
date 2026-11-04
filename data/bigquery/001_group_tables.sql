-- Classroom Intelligence — Phase 5 group warehouse (BigQuery standard SQL).
-- Replace ${dataset} with the dataset id (Terraform creates ci_group_<env>; see
-- infrastructure/terraform/modules/bigquery). Aggregates only — no student identifiers;
-- student-derived columns are NULL when the cohort is smaller than 5.

CREATE TABLE IF NOT EXISTS `${dataset}.institution_daily` (
  holding_company_id STRING NOT NULL,
  institution_id STRING NOT NULL,
  date DATE NOT NULL,
  classes_scheduled INT64 NOT NULL,
  classes_captured INT64 NOT NULL,
  classes_transcribed INT64 NOT NULL,
  classes_structured INT64 NOT NULL,
  events_extracted INT64 NOT NULL,
  events_reviewed INT64 NOT NULL,
  professors_teaching INT64 NOT NULL,
  active_professors INT64 NOT NULL,
  active_students INT64,
  assistant_questions INT64,
  searches INT64,
  devices_total INT64 NOT NULL,
  devices_online INT64 NOT NULL,
  device_uptime_pct FLOAT64,
  firmware_current_pct FLOAT64,
  incidents_opened INT64 NOT NULL,
  incidents_resolved INT64 NOT NULL,
  mttr_minutes FLOAT64,
  ai_cost_usd NUMERIC NOT NULL,
  stt_cost_usd NUMERIC NOT NULL,
  storage_cost_usd NUMERIC NOT NULL,
  infra_cost_usd NUMERIC NOT NULL,
  built_at TIMESTAMP NOT NULL
)
PARTITION BY date
CLUSTER BY holding_company_id, institution_id
OPTIONS (description = 'Group facts per institution-day (Phase 5 §3)');

CREATE TABLE IF NOT EXISTS `${dataset}.campus_daily` (
  holding_company_id STRING NOT NULL,
  institution_id STRING NOT NULL,
  campus_id STRING NOT NULL,
  date DATE NOT NULL,
  classes_scheduled INT64 NOT NULL,
  classes_captured INT64 NOT NULL,
  devices_total INT64 NOT NULL,
  devices_online INT64 NOT NULL,
  stt_cost_usd NUMERIC NOT NULL,
  storage_cost_usd NUMERIC NOT NULL,
  hardware_cost_usd NUMERIC NOT NULL,
  built_at TIMESTAMP NOT NULL
)
PARTITION BY date
CLUSTER BY holding_company_id, institution_id, campus_id
OPTIONS (description = 'Group facts per campus-day (Phase 5 §3)');

CREATE TABLE IF NOT EXISTS `${dataset}.cost_daily` (
  holding_company_id STRING NOT NULL,
  institution_id STRING NOT NULL,
  campus_id STRING,
  date DATE NOT NULL,
  category STRING NOT NULL, -- ai | stt | storage | compute | hardware
  amount_usd NUMERIC NOT NULL,
  source STRING NOT NULL
)
PARTITION BY date
CLUSTER BY holding_company_id, institution_id, category
OPTIONS (description = 'Estimated cost per institution/campus-day and category (Phase 5 §3)');

CREATE TABLE IF NOT EXISTS `${dataset}.cost_allocations` (
  id STRING NOT NULL,
  holding_company_id STRING NOT NULL,
  institution_id STRING NOT NULL,
  month STRING NOT NULL, -- YYYY-MM
  category STRING NOT NULL, -- compute
  amount_usd NUMERIC NOT NULL,
  note STRING,
  created_at TIMESTAMP NOT NULL
)
CLUSTER BY holding_company_id, institution_id
OPTIONS (description = 'Monthly compute cost allocations entered by group finance');

CREATE TABLE IF NOT EXISTS `${dataset}.pipeline_runs` (
  id STRING NOT NULL,
  date DATE NOT NULL,
  status STRING NOT NULL,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP NOT NULL,
  institutions INT64 NOT NULL,
  details STRING -- JSON: holdingCompanyIds, errors
)
PARTITION BY DATE(started_at)
OPTIONS (description = 'group-intelligence pipeline executions');
