-- =============================================================================
-- Classroom Intelligence — V004 Institutional Intelligence (Phase 4)
-- Recording governance (policy versions, consent, legal holds, retention),
-- LGPD data subject requests, fleet commands, incident queue and analytics.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. POLICY VERSIONS & CONSENT (4.10)
-- -----------------------------------------------------------------------------
ALTER TABLE recording_policies
    ADD COLUMN extracted_event_retention_days INT NOT NULL DEFAULT 1825,
    ADD COLUMN current_version INT NOT NULL DEFAULT 1,
    ADD COLUMN current_version_id UUID;

CREATE TABLE recording_policy_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL REFERENCES recording_policies(id) ON DELETE RESTRICT,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    version INT NOT NULL CHECK (version >= 1),
    content JSONB NOT NULL,
    changed_fields TEXT[] NOT NULL DEFAULT '{}',
    change_reason TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_policy_version UNIQUE (policy_id, version)
);
ALTER TABLE recording_policies
    ADD CONSTRAINT fk_recording_policies_current_version
    FOREIGN KEY (current_version_id) REFERENCES recording_policy_versions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE recording_sessions
    ADD COLUMN recording_policy_version_id UUID REFERENCES recording_policy_versions(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_policy_versions_immutable BEFORE UPDATE OR DELETE ON recording_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TYPE consent_subject_type AS ENUM ('student', 'professor');
ALTER TABLE recording_consents
    ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE CASCADE,
    ADD COLUMN subject_type consent_subject_type,
    ADD COLUMN subject_id UUID,
    ADD COLUMN policy_version INT,
    ADD COLUMN actor_id UUID,
    ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN withdrawn_by UUID,
    ADD COLUMN withdrawal_reason TEXT,
    ADD COLUMN superseded_at TIMESTAMPTZ,
    ADD COLUMN superseded_by UUID REFERENCES recording_consents(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX uq_recording_consents_current
    ON recording_consents(subject_type, subject_id, recording_policy_id,
                          COALESCE(class_section_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE superseded_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. LEGAL HOLDS & RETENTION (4.12)
-- -----------------------------------------------------------------------------
CREATE TYPE legal_hold_scope AS ENUM ('class_section', 'recording', 'subject');
CREATE TABLE legal_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    scope_type legal_hold_scope NOT NULL,
    scope_id UUID NOT NULL,
    reason TEXT NOT NULL,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    released_by UUID,
    release_reason TEXT
);
CREATE INDEX idx_legal_holds_active ON legal_holds(institution_id, scope_type, scope_id)
    WHERE released_at IS NULL;

CREATE TYPE retention_job_status AS ENUM ('running', 'completed', 'completed_with_errors', 'failed');
CREATE TABLE retention_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    dry_run BOOLEAN NOT NULL,
    reference_time TIMESTAMPTZ NOT NULL,
    requested_by UUID,
    status retention_job_status NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    kinds JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per kind: candidates, due, deleted, wouldDelete, skippedHold, failed
    holds_applied UUID[] NOT NULL DEFAULT '{}',
    unconfigured_kinds TEXT[] NOT NULL DEFAULT '{}',
    errors JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE UNIQUE INDEX uq_retention_jobs_running ON retention_jobs(institution_id) WHERE status = 'running';

-- -----------------------------------------------------------------------------
-- 3. LGPD DATA SUBJECT REQUESTS (4.11)
-- -----------------------------------------------------------------------------
CREATE TYPE dsr_type AS ENUM ('access', 'correction', 'deletion', 'anonymization', 'restriction');
CREATE TYPE dsr_status AS ENUM ('received', 'verifying', 'in_progress', 'completed', 'rejected');
CREATE TYPE dsr_service_status AS ENUM ('pending', 'completed', 'not_applicable', 'failed');

CREATE TABLE dsr_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    subject_type TEXT NOT NULL,                -- student | professor | user
    subject_id UUID NOT NULL,
    subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type dsr_type NOT NULL,
    status dsr_status NOT NULL DEFAULT 'received',
    requested_by UUID,
    channel TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at TIMESTAMPTZ NOT NULL,               -- received_at + 15 days (LGPD art. 19)
    verified_at TIMESTAMPTZ,
    verified_by UUID,
    verification_method TEXT,
    completed_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    export_uri TEXT,
    execution_attempts INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_dsr_requests_queue ON dsr_requests(institution_id, status, due_at);
CREATE UNIQUE INDEX uq_dsr_requests_open ON dsr_requests(institution_id, subject_id, type)
    WHERE status IN ('received', 'verifying', 'in_progress');
CREATE TRIGGER trg_dsr_requests_updated_at BEFORE UPDATE ON dsr_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dsr_service_results (
    request_id UUID NOT NULL REFERENCES dsr_requests(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    status dsr_service_status NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    export_uri TEXT,
    error TEXT,
    last_attempt_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, service)
);

CREATE TABLE dsr_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES dsr_requests(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    type TEXT NOT NULL,
    actor_id UUID,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_dsr_events_request ON dsr_events(request_id, at);
CREATE TRIGGER trg_dsr_events_immutable BEFORE UPDATE OR DELETE ON dsr_events
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- -----------------------------------------------------------------------------
-- 4. FLEET REMOTE COMMANDS (4.7)
-- -----------------------------------------------------------------------------
CREATE TYPE device_command_type AS ENUM ('reboot', 'self_test', 'upload_now', 'refresh_plan', 'rotate_logs');
CREATE TYPE device_command_status AS ENUM ('pending', 'delivered', 'succeeded', 'failed', 'expired', 'cancelled');
CREATE TABLE device_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    type device_command_type NOT NULL,
    status device_command_status NOT NULL DEFAULT 'pending',
    requested_by UUID,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    delivery_count INT NOT NULL DEFAULT 0,
    finished_at TIMESTAMPTZ,
    result_received_at TIMESTAMPTZ,
    output JSONB,
    cancelled_at TIMESTAMPTZ,
    cancelled_by UUID,
    CONSTRAINT ck_device_commands_ttl CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '30 minutes')
);
CREATE INDEX idx_device_commands_device ON device_commands(device_id, issued_at DESC);
CREATE INDEX idx_device_commands_open ON device_commands(status, expires_at) WHERE status IN ('pending', 'delivered');
CREATE UNIQUE INDEX uq_device_commands_open_type ON device_commands(device_id, type)
    WHERE status IN ('pending', 'delivered');

-- -----------------------------------------------------------------------------
-- 5. CAPTURE INCIDENT QUEUE (4.8) — incidents are alerts with workflow fields
-- -----------------------------------------------------------------------------
CREATE TYPE incident_resolution_code AS ENUM (
    'hardware_replaced', 'network_fixed', 'configuration', 'false_positive', 'class_cancelled', 'other'
);
ALTER TABLE alerts
    ADD COLUMN campus_id UUID,
    ADD COLUMN classroom_name TEXT,
    ADD COLUMN campus_name TEXT,
    ADD COLUMN assignee_id UUID,
    ADD COLUMN assigned_at TIMESTAMPTZ,
    ADD COLUMN in_progress_at TIMESTAMPTZ,
    ADD COLUMN resolution_code incident_resolution_code,
    ADD COLUMN sla_due_at TIMESTAMPTZ;
CREATE INDEX idx_alerts_campus ON alerts(campus_id);
CREATE INDEX idx_alerts_assignee ON alerts(assignee_id);
CREATE INDEX idx_alerts_raised ON alerts(first_raised_at);

CREATE TABLE incident_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    actor_id UUID,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_incident_comments_alert ON incident_comments(alert_id, created_at);

CREATE TABLE incident_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action TEXT NOT NULL,
    actor_id UUID,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_incident_activity_alert ON incident_activity(alert_id, at);

-- -----------------------------------------------------------------------------
-- 6. ACADEMIC ANALYTICS (4.2–4.5, 4.9)
-- Student identifiers in analytics are used only for counting; outputs apply
-- a minimum cohort size of 5.
-- -----------------------------------------------------------------------------
CREATE TABLE syllabus_items (
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    planned_week INT CHECK (planned_week BETWEEN 1 AND 53),
    position INT NOT NULL,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (course_id, item_id)
);

CREATE TABLE analytics_daily_snapshots (
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (institution_id, snapshot_date)
);

CREATE TABLE analytics_class_facts (
    institution_id UUID NOT NULL,
    snapshot_date DATE NOT NULL,
    scheduled_class_id UUID NOT NULL,
    class_section_id UUID NOT NULL,
    course_id UUID,
    professor_id UUID,
    classroom_id UUID,
    campus_id UUID,
    local_date DATE NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    captured BOOLEAN NOT NULL DEFAULT FALSE,
    recording_session_ids UUID[] NOT NULL DEFAULT '{}',
    transcribed BOOLEAN NOT NULL DEFAULT FALSE,
    transcription_failed BOOLEAN NOT NULL DEFAULT FALSE,
    failure_reasons TEXT[] NOT NULL DEFAULT '{}',
    mean_confidence NUMERIC(4,3),
    corrected_segments INT NOT NULL DEFAULT 0,
    transcript_created_at TIMESTAMPTZ,
    structured BOOLEAN NOT NULL DEFAULT FALSE,
    summary_created_at TIMESTAMPTZ,
    events_extracted INT NOT NULL DEFAULT 0,
    events_reviewed INT NOT NULL DEFAULT 0,
    event_edits INT NOT NULL DEFAULT 0,
    event_rejections INT NOT NULL DEFAULT 0,
    review_latencies_minutes INT[] NOT NULL DEFAULT '{}',
    first_event_created_at TIMESTAMPTZ,
    PRIMARY KEY (snapshot_date, scheduled_class_id),
    FOREIGN KEY (institution_id, snapshot_date)
        REFERENCES analytics_daily_snapshots(institution_id, snapshot_date) ON DELETE CASCADE
);
CREATE INDEX idx_analytics_class_facts_inst_date ON analytics_class_facts(institution_id, local_date);

COMMIT;
