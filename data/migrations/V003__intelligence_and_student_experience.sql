-- =============================================================================
-- Classroom Intelligence — V003 Classroom Intelligence & Student Experience
-- (Phases 2 and 3): AI gateway accounting, lecture structure provenance,
-- event extraction review, calendar publication, transcript corrections,
-- search embeddings, identity, assistant, notifications and content reports.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. AI GATEWAY (2.1, 2.2, 2.22)
-- -----------------------------------------------------------------------------
CREATE TABLE ai_prompt_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_id TEXT NOT NULL,
    version TEXT NOT NULL,
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    temperature NUMERIC(3,2) NOT NULL DEFAULT 0,
    sha256 CHAR(64) NOT NULL,
    changelog TEXT,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ai_prompt_version UNIQUE (prompt_id, version)
);
CREATE UNIQUE INDEX uq_ai_prompt_active ON ai_prompt_versions(prompt_id) WHERE is_active;

-- Call records never store raw transcript text — only hashes and sizes.
CREATE TABLE ai_calls (
    request_id UUID PRIMARY KEY,
    institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL,
    requested_by TEXT NOT NULL,
    task TEXT NOT NULL,                       -- lecture_structuring | event_extraction | assistant_answer | embedding …
    prompt_id TEXT,
    prompt_version TEXT,
    prompt_sha256 CHAR(64),
    variables_sha256 CHAR(64),
    untrusted_input_chars JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
    latency_ms INT,
    attempts INT NOT NULL DEFAULT 1,
    outcome TEXT NOT NULL,                    -- ok | schema_validation_failed | provider_error | budget_exceeded
    validation_errors JSONB,
    injection_suspected BOOLEAN NOT NULL DEFAULT FALSE,
    injection_signals TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ai_calls_institution_time ON ai_calls(institution_id, created_at);
CREATE INDEX idx_ai_calls_task_time ON ai_calls(task, created_at);

CREATE TABLE ai_budgets (
    institution_id UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    monthly_usd NUMERIC(12,2) NOT NULL CHECK (monthly_usd >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 2. LECTURE INTELLIGENCE (2.3–2.7, 2.21, 3.3)
-- -----------------------------------------------------------------------------
ALTER TABLE lecture_summaries
    ADD COLUMN class_section_id UUID REFERENCES class_sections(id) ON DELETE SET NULL,
    ADD COLUMN course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
    ADD COLUMN course_name TEXT,
    ADD COLUMN class_date DATE,
    ADD COLUMN starts_at TIMESTAMPTZ,
    ADD COLUMN prompt_id TEXT,
    ADD COLUMN prompt_version TEXT,
    ADD COLUMN chunk_count INT,
    ADD COLUMN ai_request_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN dropped_items INT NOT NULL DEFAULT 0,
    ADD COLUMN validation_flags JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX idx_lecture_summaries_section_time ON lecture_summaries(class_section_id, starts_at DESC);
CREATE INDEX idx_lecture_summaries_course ON lecture_summaries(course_id);

-- Every structured item cites the transcript segments it is grounded in.
ALTER TABLE lecture_topics ADD COLUMN segment_indexes INT[] NOT NULL DEFAULT '{}';
ALTER TABLE concepts ADD COLUMN segment_indexes INT[] NOT NULL DEFAULT '{}';
ALTER TABLE questions ADD COLUMN segment_indexes INT[] NOT NULL DEFAULT '{}';
ALTER TABLE reading_references ADD COLUMN segment_indexes INT[] NOT NULL DEFAULT '{}';

-- -----------------------------------------------------------------------------
-- 3. EVENT EXTRACTION & REVIEW (2.8–2.17, 2.21)
-- -----------------------------------------------------------------------------
ALTER TABLE extracted_events
    ADD COLUMN transcript_id UUID REFERENCES transcripts(id) ON DELETE SET NULL,
    ADD COLUMN recording_session_id UUID REFERENCES recording_sessions(id) ON DELETE SET NULL,
    ADD COLUMN class_section_id UUID REFERENCES class_sections(id) ON DELETE SET NULL,
    ADD COLUMN professor_id UUID REFERENCES professors(id) ON DELETE SET NULL,
    ADD COLUMN date_expression TEXT,
    ADD COLUMN date_resolution JSONB,                -- {method, ambiguous, candidates, explanation}
    ADD COLUMN quote TEXT,
    ADD COLUMN source_start_ms BIGINT,
    ADD COLUMN source_end_ms BIGINT,
    ADD COLUMN flags TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN duplicate_of UUID REFERENCES extracted_events(id) ON DELETE SET NULL,
    ADD COLUMN proposed_change JSONB,
    ADD COLUMN conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN conflict_check TEXT NOT NULL DEFAULT 'skipped',   -- ok | failed | skipped
    ADD COLUMN calendar_event_id UUID,
    ADD COLUMN extractor TEXT NOT NULL DEFAULT 'heuristic',      -- llm | heuristic | hybrid
    ADD COLUMN prompt_id TEXT,
    ADD COLUMN prompt_version TEXT,
    ADD COLUMN model_name TEXT;
CREATE INDEX idx_extracted_events_section_status ON extracted_events(class_section_id, confirmation_status);
CREATE INDEX idx_extracted_events_professor_status ON extracted_events(professor_id, confirmation_status);

CREATE TABLE extracted_event_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    extracted_event_id UUID NOT NULL REFERENCES extracted_events(id) ON DELETE CASCADE,
    scheduled_class_id UUID NOT NULL REFERENCES scheduled_classes(id) ON DELETE CASCADE,
    transcript_segment_index INT NOT NULL,
    quote TEXT NOT NULL,
    event_date DATE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_mentions_event ON extracted_event_mentions(extracted_event_id);

ALTER TABLE event_changes ADD COLUMN reason TEXT;

CREATE TABLE event_publication_policies (
    institution_id UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    auto_publish BOOLEAN NOT NULL DEFAULT FALSE,
    auto_publish_min_confidence NUMERIC(4,3) NOT NULL DEFAULT 0.920,
    allow_auto_publish_types academic_event_type[] NOT NULL DEFAULT '{}',
    require_professor_review_for academic_event_type[] NOT NULL DEFAULT '{class_cancellation}',
    publish_on_confirm BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 4. CALENDAR (2.14, 2.17, 3.7–3.10)
-- -----------------------------------------------------------------------------
CREATE TYPE calendar_event_status AS ENUM ('published', 'cancelled');
ALTER TABLE calendar_events
    ADD COLUMN status calendar_event_status NOT NULL DEFAULT 'published',
    ADD COLUMN version INT NOT NULL DEFAULT 1,
    ADD COLUMN recording_session_id UUID,
    ADD COLUMN transcript_id UUID,
    ADD COLUMN scheduled_class_id UUID,
    ADD COLUMN segment_index INT,
    ADD COLUMN source_start_ms BIGINT,
    ADD COLUMN source_end_ms BIGINT,
    ADD COLUMN quote TEXT,
    ADD COLUMN confirmed_by UUID,
    ADD COLUMN confirmed_at TIMESTAMPTZ,
    ADD CONSTRAINT ck_calendar_events_provenance
        CHECK (extracted_event_id IS NULL OR (transcript_id IS NOT NULL AND quote IS NOT NULL));
CREATE UNIQUE INDEX uq_calendar_events_extracted ON calendar_events(extracted_event_id)
    WHERE extracted_event_id IS NOT NULL;

CREATE TABLE calendar_event_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by UUID,
    source change_source NOT NULL DEFAULT 'system',
    change_type event_change_type NOT NULL,
    field TEXT NOT NULL,
    previous_value TEXT,
    new_value TEXT,
    reason TEXT
);
CREATE INDEX idx_calendar_event_changes_event ON calendar_event_changes(calendar_event_id, changed_at);

CREATE TABLE non_teaching_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    description TEXT NOT NULL,
    CONSTRAINT uq_non_teaching_day UNIQUE (institution_id, day)
);

CREATE TABLE calendar_feed_tokens (
    student_id UUID PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,       -- SHA-256; plaintext returned once
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
-- 5. TRANSCRIPT CORRECTIONS & SEARCH (2.18, 2.19, 3.6)
-- -----------------------------------------------------------------------------
ALTER TABLE transcripts
    ADD COLUMN class_section_id UUID REFERENCES class_sections(id) ON DELETE SET NULL,
    ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL;
CREATE INDEX idx_transcripts_section ON transcripts(class_section_id);

ALTER TABLE transcript_segments
    ADD COLUMN original_text TEXT,
    ADD COLUMN version INT NOT NULL DEFAULT 0;
UPDATE transcript_segments SET original_text = text WHERE original_text IS NULL;
ALTER TABLE transcript_segments ALTER COLUMN original_text SET NOT NULL;

-- The machine transcript is never mutated: original_text is write-once.
CREATE OR REPLACE FUNCTION protect_original_text()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.original_text IS DISTINCT FROM OLD.original_text THEN
        RAISE EXCEPTION 'transcript_segments.original_text is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_transcript_segments_original_immutable BEFORE UPDATE ON transcript_segments
FOR EACH ROW EXECUTE FUNCTION protect_original_text();

ALTER TABLE transcript_corrections
    ADD COLUMN transcript_id UUID REFERENCES transcripts(id) ON DELETE CASCADE,
    ADD COLUMN segment_index INT,
    ADD COLUMN version INT NOT NULL DEFAULT 1,
    ADD COLUMN corrected_by_role TEXT,
    ADD CONSTRAINT uq_transcript_correction_version UNIQUE (transcript_segment_id, version);
COMMENT ON COLUMN transcript_corrections.original_text IS 'Text of the previous version being replaced';

-- Embeddings stored as REAL[]; switch to pgvector `vector(768)` where the extension is available.
CREATE TABLE segment_embeddings (
    transcript_segment_id UUID NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    class_section_id UUID REFERENCES class_sections(id) ON DELETE CASCADE,
    dimensions INT NOT NULL,
    embedding REAL[] NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (transcript_segment_id, model),
    CONSTRAINT ck_segment_embedding_dims CHECK (array_length(embedding, 1) = dimensions)
);
CREATE INDEX idx_segment_embeddings_section ON segment_embeddings(class_section_id);

-- -----------------------------------------------------------------------------
-- 6. IDENTITY & ACCESS (3.1)
-- -----------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('student', 'professor', 'coordinator', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'disabled');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role user_role NOT NULL,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    professor_id UUID REFERENCES professors(id) ON DELETE SET NULL,
    status user_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_users_email ON users(institution_id, lower(email));
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    password_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash CHAR(64) NOT NULL UNIQUE,
    family_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL
);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE revoked_access_tokens (
    jti UUID PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE identity_provider_configs (
    institution_id UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    jwks_uri TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_ref TEXT NOT NULL,           -- Secret Manager reference, never the secret
    redirect_uri TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{openid,email,profile}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE oidc_auth_states (
    state TEXT PRIMARY KEY,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE login_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    method TEXT NOT NULL,                      -- password | oidc
    outcome TEXT NOT NULL                      -- succeeded | failed
);
CREATE INDEX idx_login_events_user ON login_events(user_id, at DESC);

-- Read models mirrored from academic-integration for authorization and fan-out
CREATE TABLE section_access_mirror (
    class_section_id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    course_id UUID,
    course_name TEXT,
    section_code TEXT,
    professor_id UUID,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE enrollment_access_mirror (
    student_id UUID NOT NULL,
    class_section_id UUID NOT NULL,
    institution_id UUID NOT NULL,
    user_id UUID,
    email TEXT,
    status enrollment_status NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (student_id, class_section_id)
);
CREATE INDEX idx_enrollment_mirror_section ON enrollment_access_mirror(class_section_id) WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- 7. ACADEMIC ASSISTANT (3.13, 3.14)
-- -----------------------------------------------------------------------------
CREATE TABLE assistant_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assistant_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    turn_index INT NOT NULL,
    question TEXT NOT NULL,
    answer_blocks JSONB NOT NULL,              -- [{kind: professor_statement|ai_explanation, text, citationIds}]
    refusal TEXT,                              -- no_evidence | out_of_scope | injection_suspected
    grounded BOOLEAN NOT NULL,
    prompt_id TEXT,
    prompt_version TEXT,
    model TEXT,
    ai_request_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_assistant_turn UNIQUE (conversation_id, turn_index)
);

CREATE TABLE assistant_answer_citations (
    answer_id UUID NOT NULL REFERENCES assistant_answers(id) ON DELETE CASCADE,
    citation_id TEXT NOT NULL,
    scheduled_class_id UUID,
    transcript_id UUID NOT NULL,
    segment_index INT NOT NULL,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    quote TEXT NOT NULL,
    PRIMARY KEY (answer_id, citation_id)
);

CREATE TABLE assistant_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    answer_id UUID NOT NULL REFERENCES assistant_answers(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    helpful BOOLEAN NOT NULL,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 8. NOTIFICATIONS (1.17, 3.11, 3.12)
-- -----------------------------------------------------------------------------
CREATE TYPE alert_status AS ENUM ('open', 'acknowledged', 'in_progress', 'resolved');
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    institution_id UUID REFERENCES institutions(id) ON DELETE CASCADE,
    classroom_id UUID,
    device_id UUID,
    scheduled_class_id UUID,
    recording_session_id UUID,
    severity incident_severity NOT NULL,
    status alert_status NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_notified_at TIMESTAMPTZ,
    notification_count INT NOT NULL DEFAULT 0,
    occurrences INT NOT NULL DEFAULT 1,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID,
    resolution TEXT,
    resolution_note TEXT
);
CREATE UNIQUE INDEX uq_alerts_open_dedupe ON alerts(dedupe_key) WHERE status <> 'resolved';
CREATE INDEX idx_alerts_institution_status ON alerts(institution_id, status, severity);

CREATE TABLE alert_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE alert_class_marks (
    scheduled_class_id UUID NOT NULL,
    mark TEXT NOT NULL,                        -- recording_started | uploaded
    at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scheduled_class_id, mark)
);

-- Student notifications reuse V001 `notifications` for history; the inbox lives here.
CREATE TABLE user_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    category TEXT NOT NULL,                    -- new_assessment | deadline_change | class_cancellation | lecture_summary | reminder
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    dedupe_key TEXT NOT NULL UNIQUE,           -- user:category:resource:version
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
);
CREATE INDEX idx_user_notifications_user ON user_notifications(user_id, created_at DESC);
CREATE INDEX idx_user_notifications_unread ON user_notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
    user_id UUID PRIMARY KEY,
    categories JSONB NOT NULL,
    quiet_start TIME,
    quiet_end TIME,
    quiet_timezone TEXT,
    reminder_offsets_hours INT[] NOT NULL DEFAULT '{24,2}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_success_at TIMESTAMPTZ,
    failure_count INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_push_subscription UNIQUE (user_id, endpoint)
);

CREATE TABLE notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,
    channel notification_channel NOT NULL,
    status TEXT NOT NULL,                      -- sent | failed | deferred | skipped
    detail TEXT,
    due_at TIMESTAMPTZ,                        -- set while deferred by quiet hours
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notification_deliveries_deferred ON notification_deliveries(due_at) WHERE status = 'deferred';

-- -----------------------------------------------------------------------------
-- 9. CONTENT REPORTS (3.15)
-- -----------------------------------------------------------------------------
CREATE TABLE content_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL,
    reporter_role user_role NOT NULL,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,                 -- may be composite, e.g. <transcriptId>:<segmentIndex>
    class_section_id UUID,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open',       -- open | resolved
    resolution TEXT,
    resolution_notes TEXT,
    resolved_by UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_content_reports_open ON content_reports(reporter_id, resource_type, resource_id)
    WHERE status = 'open';
CREATE INDEX idx_content_reports_section ON content_reports(class_section_id, status);

COMMIT;
