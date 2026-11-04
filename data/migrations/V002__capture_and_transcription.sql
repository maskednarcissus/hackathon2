-- =============================================================================
-- Classroom Intelligence — V002 Capture & Transcription (Phase 1)
-- Device identity, provisioning, heartbeats, timetable import keys,
-- chunked uploads, audio quality, transcription jobs and hash-chained audit.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. ORGANIZATION & RECORDING POLICIES (1.2, 1.4, 1.15)
-- -----------------------------------------------------------------------------
ALTER TABLE recording_policies
    ADD COLUMN pre_roll_minutes INT NOT NULL DEFAULT 2 CHECK (pre_roll_minutes BETWEEN 0 AND 30),
    ADD COLUMN post_roll_minutes INT NOT NULL DEFAULT 5 CHECK (post_roll_minutes BETWEEN 0 AND 60),
    ADD COLUMN recording_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX uq_recording_policies_default
    ON recording_policies(institution_id) WHERE is_default;
CREATE UNIQUE INDEX uq_recording_policies_name
    ON recording_policies(institution_id, lower(name));

ALTER TABLE campuses
    ADD COLUMN recording_policy_id UUID REFERENCES recording_policies(id) ON DELETE SET NULL;
ALTER TABLE classrooms
    ADD COLUMN recording_policy_id UUID REFERENCES recording_policies(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_institutions_name ON institutions(holding_company_id, lower(name));
CREATE UNIQUE INDEX uq_campuses_name ON campuses(institution_id, lower(name));

-- -----------------------------------------------------------------------------
-- 2. DEVICE IDENTITY, PROVISIONING & HEALTH (1.1, 1.2, 1.3, 1.16)
-- -----------------------------------------------------------------------------
CREATE TYPE device_credential_status AS ENUM ('active', 'revoked', 'decommissioned');

ALTER TABLE capture_devices
    ADD COLUMN institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    ADD COLUMN public_key_pem TEXT NOT NULL,
    ADD COLUMN public_key_fingerprint TEXT NOT NULL UNIQUE,
    ADD COLUMN certificate TEXT NOT NULL,
    ADD COLUMN certificate_issued_at TIMESTAMPTZ NOT NULL,
    ADD COLUMN certificate_expires_at TIMESTAMPTZ NOT NULL,
    ADD COLUMN credential_status device_credential_status NOT NULL DEFAULT 'active',
    ADD COLUMN revoked_at TIMESTAMPTZ,
    ADD COLUMN revocation_reason TEXT,
    ADD COLUMN maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_capture_devices_institution ON capture_devices(institution_id);
CREATE UNIQUE INDEX uq_capture_devices_active_classroom
    ON capture_devices(classroom_id)
    WHERE credential_status = 'active' AND classroom_id IS NOT NULL;

ALTER TABLE device_assignments
    ADD COLUMN institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    ADD COLUMN unassigned_by UUID,
    ALTER COLUMN assigned_by DROP NOT NULL;
CREATE UNIQUE INDEX uq_device_assignments_open
    ON device_assignments(device_id) WHERE unassigned_at IS NULL;

CREATE TABLE device_provisioning_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL UNIQUE,              -- SHA-256 of the token; plaintext never stored
    serial_number VARCHAR(100) NOT NULL,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_by UUID,
    used_at TIMESTAMPTZ,
    device_id UUID REFERENCES capture_devices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_provisioning_tokens_serial ON device_provisioning_tokens(serial_number);

CREATE TABLE device_heartbeats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE CASCADE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_timestamp TIMESTAMPTZ,
    firmware_version VARCHAR(50),
    uptime_seconds BIGINT,
    cpu_temp_c NUMERIC(5,2),
    disk_free_bytes BIGINT,
    disk_total_bytes BIGINT,
    buffer_queue_count INT,
    buffer_queue_bytes BIGINT,
    network_rssi_dbm NUMERIC(6,2),
    mic_level_dbfs NUMERIC(6,2),
    is_recording BOOLEAN NOT NULL DEFAULT FALSE,
    current_scheduled_class_id UUID REFERENCES scheduled_classes(id) ON DELETE SET NULL,
    last_upload_at TIMESTAMPTZ
);
CREATE INDEX idx_device_heartbeats_device_time ON device_heartbeats(device_id, received_at DESC);

-- -----------------------------------------------------------------------------
-- 3. ACADEMIC IMPORT & SCHEDULE EXPANSION (1.13, 1.14)
-- -----------------------------------------------------------------------------
ALTER TABLE academic_terms ADD COLUMN external_id VARCHAR(100),
    ADD COLUMN timezone VARCHAR(50) NOT NULL DEFAULT 'America/Sao_Paulo';
ALTER TABLE courses ADD COLUMN external_id VARCHAR(100);
ALTER TABLE class_sections
    ADD COLUMN external_id VARCHAR(100),
    ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE RESTRICT,
    ADD COLUMN academic_term_id UUID REFERENCES academic_terms(id) ON DELETE RESTRICT,
    ADD COLUMN schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN exceptions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX uq_academic_terms_external ON academic_terms(institution_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX uq_courses_external ON courses(institution_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX uq_professors_external ON professors(institution_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX uq_students_external ON students(institution_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX uq_class_sections_external ON class_sections(institution_id, external_id) WHERE external_id IS NOT NULL;

CREATE TYPE scheduled_class_source AS ENUM ('timetable', 'exception');
ALTER TABLE scheduled_classes
    ADD COLUMN slot_key TEXT,
    ADD COLUMN local_date DATE,
    ADD COLUMN timezone VARCHAR(50) NOT NULL DEFAULT 'America/Sao_Paulo',
    ADD COLUMN cancellation_reason TEXT,
    ADD COLUMN source scheduled_class_source NOT NULL DEFAULT 'timetable';
CREATE UNIQUE INDEX uq_scheduled_classes_slot ON scheduled_classes(class_section_id, slot_key) WHERE slot_key IS NOT NULL;

CREATE TYPE import_run_status AS ENUM ('validated', 'applied', 'rejected');
CREATE TABLE academic_import_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    format VARCHAR(20) NOT NULL,                 -- json | csv
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    status import_run_status NOT NULL,
    counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_import_runs_institution ON academic_import_runs(institution_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. RECORDINGS, UPLOADS & AUDIO QUALITY (1.5, 1.7, 1.8, 1.9)
-- -----------------------------------------------------------------------------
ALTER TABLE recording_sessions
    ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE RESTRICT,
    ADD COLUMN local_recording_id VARCHAR(100),
    ADD COLUMN firmware_version VARCHAR(50),
    ADD COLUMN duration_ms BIGINT,
    ADD COLUMN class_identification_status VARCHAR(20),   -- matched | ambiguous | unmatched
    ADD COLUMN class_identification_confidence NUMERIC(4,3),
    ALTER COLUMN recording_policy_id DROP NOT NULL;      -- resolved after class identification
CREATE UNIQUE INDEX uq_recording_sessions_local ON recording_sessions(device_id, local_recording_id)
    WHERE local_recording_id IS NOT NULL;

CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE RESTRICT,
    total_size_bytes BIGINT NOT NULL CHECK (total_size_bytes > 0),
    checksum_sha256 CHAR(64) NOT NULL,
    chunk_size_bytes INT NOT NULL CHECK (chunk_size_bytes BETWEEN 65536 AND 16777216),
    total_chunks INT NOT NULL CHECK (total_chunks > 0),
    status upload_status NOT NULL DEFAULT 'uploading',
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_upload_sessions_open ON upload_sessions(recording_session_id)
    WHERE status IN ('pending', 'uploading');

CREATE TABLE upload_chunks (
    upload_session_id UUID NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL CHECK (chunk_index >= 0),
    checksum_sha256 CHAR(64) NOT NULL,
    size_bytes INT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (upload_session_id, chunk_index)
);

CREATE TYPE audio_quality_verdict AS ENUM ('good', 'acceptable', 'poor', 'unusable');
CREATE TABLE audio_quality_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    duration_ms BIGINT NOT NULL,
    sample_rate INT NOT NULL,
    channels INT NOT NULL,
    rms_dbfs NUMERIC(6,2),
    peak_dbfs NUMERIC(6,2),
    noise_floor_dbfs NUMERIC(6,2),
    snr_db NUMERIC(6,2),
    clipping_ratio NUMERIC(8,6) NOT NULL,
    silence_ratio NUMERIC(5,4) NOT NULL,
    longest_silence_ms BIGINT NOT NULL,
    score NUMERIC(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
    verdict audio_quality_verdict NOT NULL,
    issues TEXT[] NOT NULL DEFAULT '{}',
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audio_quality_recording ON audio_quality_reports(recording_session_id);

ALTER TABLE audio_segments ALTER COLUMN file_size_bytes DROP NOT NULL;

-- Idempotent event consumption (Pub/Sub at-least-once delivery)
CREATE TABLE processed_events (
    event_id UUID NOT NULL,
    consumer VARCHAR(100) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, consumer)
);

-- -----------------------------------------------------------------------------
-- 5. TRANSCRIPTION & DIARIZATION (1.10, 1.11, 1.12)
-- -----------------------------------------------------------------------------
CREATE TYPE transcription_job_status AS ENUM ('queued', 'running', 'completed', 'failed');
CREATE TABLE transcription_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    status transcription_job_status NOT NULL DEFAULT 'queued',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    processing_version TEXT NOT NULL,
    request JSONB NOT NULL,
    transcript_id UUID REFERENCES transcripts(id) ON DELETE SET NULL,
    segment_count INT,
    word_count INT,
    mean_confidence NUMERIC(4,3),
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_transcription_jobs_active ON transcription_jobs(recording_session_id)
    WHERE status IN ('queued', 'running', 'completed');

ALTER TABLE transcripts
    ADD COLUMN provider TEXT,
    ADD COLUMN model TEXT,
    ADD COLUMN speaker_count INT,
    ADD COLUMN diarization_method TEXT,           -- provider_tags | acoustic_clustering
    ADD COLUMN diarization_version TEXT,
    ADD CONSTRAINT uq_transcripts_recording_version UNIQUE (recording_session_id, processing_version);

ALTER TABLE transcript_segments
    ADD COLUMN words JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD CONSTRAINT ck_transcript_segments_speaker_label
        CHECK (speaker_label IS NULL OR speaker_label ~ '^SPEAKER_[0-9]{1,3}$'),
    ADD CONSTRAINT ck_transcript_segments_confidence CHECK (confidence BETWEEN 0 AND 1),
    ADD CONSTRAINT ck_transcript_segments_range CHECK (end_ms > start_ms);

CREATE TABLE speaker_turns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    speaker_label TEXT NOT NULL CHECK (speaker_label ~ '^SPEAKER_[0-9]{1,3}$'),
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL CHECK (end_ms > start_ms)
);
CREATE INDEX idx_speaker_turns_transcript ON speaker_turns(transcript_id, start_ms);

-- Phase 1: speakers are anonymous labels — real-world identity is never stored.
ALTER TABLE speakers ADD CONSTRAINT ck_speakers_anonymous CHECK (person_id IS NULL);

CREATE TABLE transcription_vocabularies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    discipline VARCHAR(100),
    phrases TEXT[] NOT NULL,
    boost NUMERIC(4,1) NOT NULL DEFAULT 10,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transcription_vocab_institution ON transcription_vocabularies(institution_id, discipline);
CREATE TRIGGER trg_transcription_vocabularies_updated_at BEFORE UPDATE ON transcription_vocabularies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 6. AUDIT — HASH CHAIN & IMMUTABILITY (1.18)
-- -----------------------------------------------------------------------------
ALTER TABLE audit_events
    ADD COLUMN sequence BIGINT,
    ADD COLUMN prev_hash CHAR(64),
    ADD COLUMN hash CHAR(64),
    ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX uq_audit_events_chain
    ON audit_events(COALESCE(tenant_institution_id, '00000000-0000-0000-0000-000000000000'::uuid), sequence);
CREATE INDEX idx_audit_events_recording ON audit_events((metadata->>'recordingSessionId'));

CREATE OR REPLACE FUNCTION reject_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

COMMIT;
