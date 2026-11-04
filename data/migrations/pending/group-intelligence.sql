-- group-intelligence (Phase 5) — Postgres warehouse tables (dev / fallback when BigQuery is not used).
-- Aggregates only: no student identifiers. Student-derived columns are NULL when the cohort < 5.
-- Self-contained (no FKs to OLTP tables) so the warehouse can live in a separate database.

CREATE TABLE IF NOT EXISTS group_institution_daily (
    holding_company_id UUID NOT NULL,
    institution_id UUID NOT NULL,
    date DATE NOT NULL,
    classes_scheduled INT NOT NULL DEFAULT 0,
    classes_captured INT NOT NULL DEFAULT 0,
    classes_transcribed INT NOT NULL DEFAULT 0,
    classes_structured INT NOT NULL DEFAULT 0,
    events_extracted INT NOT NULL DEFAULT 0,
    events_reviewed INT NOT NULL DEFAULT 0,
    professors_teaching INT NOT NULL DEFAULT 0,
    active_professors INT NOT NULL DEFAULT 0,
    active_students INT CHECK (active_students IS NULL OR active_students >= 5),
    assistant_questions INT,
    searches INT,
    devices_total INT NOT NULL DEFAULT 0,
    devices_online INT NOT NULL DEFAULT 0,
    device_uptime_pct NUMERIC(5,1),
    firmware_current_pct NUMERIC(5,1),
    incidents_opened INT NOT NULL DEFAULT 0,
    incidents_resolved INT NOT NULL DEFAULT 0,
    mttr_minutes NUMERIC(10,1),
    ai_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    stt_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    storage_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    infra_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (institution_id, date),
    -- Student-derived counts are either all present or all suppressed.
    CONSTRAINT ck_group_inst_daily_cohort CHECK (
        (active_students IS NULL AND assistant_questions IS NULL AND searches IS NULL)
        OR (active_students IS NOT NULL AND assistant_questions IS NOT NULL AND searches IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_group_inst_daily_hc_date ON group_institution_daily(holding_company_id, date);

CREATE TABLE IF NOT EXISTS group_campus_daily (
    holding_company_id UUID NOT NULL,
    institution_id UUID NOT NULL,
    campus_id UUID NOT NULL,
    date DATE NOT NULL,
    classes_scheduled INT NOT NULL DEFAULT 0,
    classes_captured INT NOT NULL DEFAULT 0,
    devices_total INT NOT NULL DEFAULT 0,
    devices_online INT NOT NULL DEFAULT 0,
    stt_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    storage_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    hardware_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (campus_id, date)
);
CREATE INDEX IF NOT EXISTS idx_group_campus_daily_inst_date ON group_campus_daily(institution_id, date);

DO $$ BEGIN
    CREATE TYPE group_cost_category AS ENUM ('ai', 'stt', 'storage', 'compute', 'hardware');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS group_cost_daily (
    id BIGSERIAL PRIMARY KEY,
    holding_company_id UUID NOT NULL,
    institution_id UUID NOT NULL,
    campus_id UUID,
    date DATE NOT NULL,
    category group_cost_category NOT NULL,
    amount_usd NUMERIC(14,6) NOT NULL CHECK (amount_usd >= 0),
    source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_cost_daily_inst_date ON group_cost_daily(institution_id, date);

CREATE TABLE IF NOT EXISTS group_cost_allocations (
    id UUID PRIMARY KEY,
    holding_company_id UUID NOT NULL,
    institution_id UUID NOT NULL,
    month CHAR(7) NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    category group_cost_category NOT NULL DEFAULT 'compute' CHECK (category = 'compute'),
    amount_usd NUMERIC(14,2) NOT NULL CHECK (amount_usd >= 0),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_group_cost_allocations_inst_month ON group_cost_allocations(institution_id, month);

DO $$ BEGIN
    CREATE TYPE group_pipeline_status AS ENUM ('completed', 'completed_with_errors', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS group_pipeline_runs (
    id UUID PRIMARY KEY,
    date DATE NOT NULL,
    holding_company_ids UUID[] NOT NULL,
    status group_pipeline_status NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    institutions INT NOT NULL,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_group_pipeline_runs_started ON group_pipeline_runs(started_at DESC);
