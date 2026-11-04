-- =============================================================================
-- academic-integration — Phase 6 (6.5 / 6.6): SIS / LMS connectors.
-- To be merged into the Phase 6 migration. Idempotent where PostgreSQL allows it.
-- =============================================================================

-- Per-institution connector configuration. `auth` holds the auth kind and a *reference* to the
-- secret (env:NAME / gcp-sm:…), never the secret itself (enforced below and by the API schema).
CREATE TABLE IF NOT EXISTS academic_connectors (
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    connector_type VARCHAR(30) NOT NULL
        CHECK (connector_type IN ('totvs_rm', 'banner', 'colleague', 'moodle', 'canvas', 'blackboard')),
    base_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    auth JSONB NOT NULL,
    mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
    outbound JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_successful_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (institution_id, connector_type),
    CONSTRAINT chk_academic_connectors_secret_ref CHECK (
        auth ? 'secretRef'
        AND auth->>'secretRef' ~ '^(env|gcp-sm):'
        AND NOT (auth ?| ARRAY['secret', 'password', 'clientSecret', 'apiKey', 'token', 'privateKeyPem'])
    )
);

-- Sync history (one row per POST …/sync). At most one running sync per connector.
CREATE TABLE IF NOT EXISTS academic_connector_runs (
    id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    connector_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('running', 'succeeded', 'partial', 'rejected', 'failed')),
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    since TIMESTAMPTZ,
    triggered_by TEXT,
    import_id UUID,                 -- academic_import_runs.id (no FK: rejected reports may not be stored)
    import_status VARCHAR(20),
    counts JSONB,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    error JSONB,
    stats JSONB,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (institution_id, connector_type)
        REFERENCES academic_connectors(institution_id, connector_type) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_academic_connector_runs_running
    ON academic_connector_runs(institution_id, connector_type) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_academic_connector_runs_history
    ON academic_connector_runs(institution_id, connector_type, started_at DESC);

-- LMS outbound publications (announcements / calendar items), idempotent per source item and kind.
CREATE TABLE IF NOT EXISTS lms_publications (
    id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    connector_type VARCHAR(30) NOT NULL,
    source_type VARCHAR(30) NOT NULL CHECK (source_type IN ('calendar_event', 'lecture_summary')),
    source_id UUID NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('announcement', 'calendar_item')),
    class_section_id UUID NOT NULL,
    lms_course_id TEXT NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('published', 'failed')),
    external_id TEXT,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    source_event_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_lms_publications_item UNIQUE (institution_id, connector_type, source_type, source_id, kind),
    FOREIGN KEY (institution_id, connector_type)
        REFERENCES academic_connectors(institution_id, connector_type) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lms_publications_recent
    ON lms_publications(institution_id, connector_type, created_at DESC);
