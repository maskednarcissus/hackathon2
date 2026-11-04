-- =============================================================================
-- Classroom Intelligence — V001 Initial Academic Schema
-- Database: PostgreSQL 16+ / AlloyDB
-- Standards: UUID PKs, TIMESTAMPTZ, explicit foreign keys, audit logging,
-- soft delete readiness, and LGPD retention policy alignments.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- UPDATED_AT TRIGGER FUNCTION
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- ENUMS
-- -----------------------------------------------------------------------------
CREATE TYPE academic_modality AS ENUM ('in_person', 'hybrid', 'remote');
CREATE TYPE enrollment_status AS ENUM ('active', 'withdrawn', 'completed');
CREATE TYPE scheduled_class_status AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');
CREATE TYPE device_status AS ENUM (
    'online', 'offline', 'recording', 'uploading',
    'attention_required', 'maintenance', 'decommissioned'
);
CREATE TYPE upload_status AS ENUM ('pending', 'uploading', 'complete', 'failed');
CREATE TYPE capture_status AS ENUM ('in_progress', 'complete', 'failed', 'partial');
CREATE TYPE capture_incident_type AS ENUM (
    'device_offline', 'failed_recording', 'poor_audio_quality',
    'failed_upload', 'transcription_failure', 'incorrect_class_association',
    'processing_delay'
);
CREATE TYPE incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE processing_status AS ENUM ('pending', 'processing', 'complete', 'failed', 'partial');
CREATE TYPE transcript_correction_status AS ENUM ('original', 'corrected');
CREATE TYPE question_asked_by AS ENUM ('student', 'professor', 'unknown');
CREATE TYPE reading_reference_type AS ENUM ('book', 'article', 'chapter', 'website', 'other');
CREATE TYPE academic_event_type AS ENUM (
    'examination', 'quiz', 'assignment', 'project', 'presentation',
    'reading_deadline', 'class_cancellation', 'class_reschedule',
    'room_change', 'other'
);
CREATE TYPE confirmation_status AS ENUM (
    'suggested', 'awaiting_professor', 'awaiting_admin',
    'confirmed', 'published', 'rejected'
);
CREATE TYPE event_change_type AS ENUM (
    'date_change', 'description_change', 'status_change', 'cancellation', 'other'
);
CREATE TYPE change_source AS ENUM ('professor', 'admin', 'system', 'integration');
CREATE TYPE actor_type AS ENUM ('student', 'professor', 'coordinator', 'admin', 'system', 'device');
CREATE TYPE notification_channel AS ENUM ('push', 'email', 'in_app');
CREATE TYPE interaction_resource_type AS ENUM (
    'lecture_summary', 'transcript', 'calendar_event', 'extracted_event', 'concept'
);
CREATE TYPE interaction_type AS ENUM ('view', 'search', 'download', 'query');

-- -----------------------------------------------------------------------------
-- 1. ORGANIZATIONAL HIERARCHY
-- -----------------------------------------------------------------------------

CREATE TABLE holding_companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    legal_name VARCHAR(255) NOT NULL,
    country VARCHAR(2) NOT NULL DEFAULT 'BR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_holding_companies_updated_at BEFORE UPDATE ON holding_companies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    holding_company_id UUID NOT NULL REFERENCES holding_companies(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(100),
    country VARCHAR(2) NOT NULL DEFAULT 'BR',
    state VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_institutions_holding_company ON institutions(holding_company_id);
CREATE TRIGGER trg_institutions_updated_at BEFORE UPDATE ON institutions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campuses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(50) NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'America/Sao_Paulo',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_campuses_institution ON campuses(institution_id);
CREATE TRIGGER trg_campuses_updated_at BEFORE UPDATE ON campuses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_department_code_institution UNIQUE (institution_id, code)
);
CREATE INDEX idx_departments_institution ON departments(institution_id);
CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON departments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. ACADEMIC STRUCTURE
-- -----------------------------------------------------------------------------

CREATE TABLE academic_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_academic_terms_institution ON academic_terms(institution_id);
CREATE TRIGGER trg_academic_terms_updated_at BEFORE UPDATE ON academic_terms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE academic_programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    modality academic_modality NOT NULL DEFAULT 'in_person',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_program_code_institution UNIQUE (institution_id, code)
);
CREATE INDEX idx_programs_institution ON academic_programs(institution_id);
CREATE TRIGGER trg_academic_programs_updated_at BEFORE UPDATE ON academic_programs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    academic_program_id UUID NOT NULL REFERENCES academic_programs(id) ON DELETE RESTRICT,
    academic_term_id UUID NOT NULL REFERENCES academic_terms(id) ON DELETE RESTRICT,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    discipline VARCHAR(100) NOT NULL,
    credits INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_courses_program ON courses(academic_program_id);
CREATE INDEX idx_courses_term ON courses(academic_term_id);
CREATE TRIGGER trg_courses_updated_at BEFORE UPDATE ON courses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE professors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    external_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_professor_email_institution UNIQUE (institution_id, email)
);
CREATE INDEX idx_professors_institution ON professors(institution_id);
CREATE TRIGGER trg_professors_updated_at BEFORE UPDATE ON professors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    external_id VARCHAR(100),
    date_of_birth DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_student_email_institution UNIQUE (institution_id, email)
);
CREATE INDEX idx_students_institution ON students(institution_id);
CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON students
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE classrooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campus_id UUID NOT NULL REFERENCES campuses(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL,
    capacity INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_classroom_code_campus UNIQUE (campus_id, code)
);
CREATE INDEX idx_classrooms_campus ON classrooms(campus_id);
CREATE TRIGGER trg_classrooms_updated_at BEFORE UPDATE ON classrooms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE class_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    professor_id UUID NOT NULL REFERENCES professors(id) ON DELETE RESTRICT,
    section_code VARCHAR(50) NOT NULL,
    max_students INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_class_sections_course ON class_sections(course_id);
CREATE INDEX idx_class_sections_professor ON class_sections(professor_id);
CREATE TRIGGER trg_class_sections_updated_at BEFORE UPDATE ON class_sections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status enrollment_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_student_enrollment UNIQUE (student_id, class_section_id)
);
CREATE INDEX idx_enrollments_student ON enrollments(student_id);
CREATE INDEX idx_enrollments_section ON enrollments(class_section_id);
CREATE TRIGGER trg_enrollments_updated_at BEFORE UPDATE ON enrollments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE scheduled_classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
    classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE RESTRICT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status scheduled_class_status NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_scheduled_classes_section ON scheduled_classes(class_section_id);
CREATE INDEX idx_scheduled_classes_classroom_time ON scheduled_classes(classroom_id, starts_at, ends_at);
CREATE TRIGGER trg_scheduled_classes_updated_at BEFORE UPDATE ON scheduled_classes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. CAPTURE & HARDWARE
-- -----------------------------------------------------------------------------

CREATE TABLE capture_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
    serial_number VARCHAR(100) NOT NULL UNIQUE,
    model VARCHAR(100) NOT NULL,
    firmware_version VARCHAR(50) NOT NULL,
    status device_status NOT NULL DEFAULT 'offline',
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_capture_devices_classroom ON capture_devices(classroom_id);
CREATE INDEX idx_capture_devices_status ON capture_devices(status);
CREATE TRIGGER trg_capture_devices_updated_at BEFORE UPDATE ON capture_devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE device_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE CASCADE,
    classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unassigned_at TIMESTAMPTZ,
    assigned_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_device_assignments_device ON device_assignments(device_id);
CREATE INDEX idx_device_assignments_classroom ON device_assignments(classroom_id);
CREATE TRIGGER trg_device_assignments_updated_at BEFORE UPDATE ON device_assignments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recording_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    legal_basis VARCHAR(100) NOT NULL,
    requires_explicit_consent BOOLEAN NOT NULL DEFAULT FALSE,
    audio_retention_days INT NOT NULL DEFAULT 90,
    transcript_retention_days INT NOT NULL DEFAULT 365,
    summary_retention_days INT NOT NULL DEFAULT 730,
    allow_raw_audio_access BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recording_policies_institution ON recording_policies(institution_id);
CREATE TRIGGER trg_recording_policies_updated_at BEFORE UPDATE ON recording_policies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recording_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE RESTRICT,
    classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE RESTRICT,
    scheduled_class_id UUID REFERENCES scheduled_classes(id) ON DELETE SET NULL,
    recording_policy_id UUID NOT NULL REFERENCES recording_policies(id) ON DELETE RESTRICT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration_seconds INT,
    audio_format VARCHAR(50) NOT NULL,
    sample_rate INT NOT NULL,
    channels INT NOT NULL,
    file_size_bytes BIGINT,
    storage_path TEXT,
    checksum_sha256 TEXT,
    upload_status upload_status NOT NULL DEFAULT 'pending',
    capture_status capture_status NOT NULL DEFAULT 'in_progress',
    audio_quality_score NUMERIC(4,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recording_sessions_device ON recording_sessions(device_id);
CREATE INDEX idx_recording_sessions_scheduled_class ON recording_sessions(scheduled_class_id);
CREATE INDEX idx_recording_sessions_started_at ON recording_sessions(started_at);
CREATE TRIGGER trg_recording_sessions_updated_at BEFORE UPDATE ON recording_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audio_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    segment_index INT NOT NULL,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    checksum_sha256 TEXT,
    upload_status upload_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_audio_segment_index UNIQUE (recording_session_id, segment_index)
);
CREATE INDEX idx_audio_segments_session ON audio_segments(recording_session_id);
CREATE TRIGGER trg_audio_segments_updated_at BEFORE UPDATE ON audio_segments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE capture_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_session_id UUID REFERENCES recording_sessions(id) ON DELETE SET NULL,
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE CASCADE,
    classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
    incident_type capture_incident_type NOT NULL,
    severity incident_severity NOT NULL DEFAULT 'medium',
    description TEXT NOT NULL,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_capture_incidents_device ON capture_incidents(device_id);
CREATE INDEX idx_capture_incidents_severity ON capture_incidents(severity);
CREATE TRIGGER trg_capture_incidents_updated_at BEFORE UPDATE ON capture_incidents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. TRANSCRIPTION
-- -----------------------------------------------------------------------------

CREATE TABLE transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    scheduled_class_id UUID REFERENCES scheduled_classes(id) ON DELETE SET NULL,
    language TEXT NOT NULL DEFAULT 'pt-BR',
    word_error_rate NUMERIC(5,4),
    processing_version TEXT NOT NULL,
    processing_status processing_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transcripts_recording ON transcripts(recording_session_id);
CREATE INDEX idx_transcripts_class ON transcripts(scheduled_class_id);
CREATE TRIGGER trg_transcripts_updated_at BEFORE UPDATE ON transcripts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transcript_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    segment_index INT NOT NULL,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    text TEXT NOT NULL,
    speaker_label TEXT,
    confidence NUMERIC(4,3) NOT NULL,
    language TEXT NOT NULL DEFAULT 'pt-BR',
    correction_status transcript_correction_status NOT NULL DEFAULT 'original',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_transcript_segment_index UNIQUE (transcript_id, segment_index)
);
CREATE INDEX idx_transcript_segments_transcript ON transcript_segments(transcript_id);
CREATE TRIGGER trg_transcript_segments_updated_at BEFORE UPDATE ON transcript_segments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transcript_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_segment_id UUID NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
    original_text TEXT NOT NULL,
    corrected_text TEXT NOT NULL,
    corrected_by UUID NOT NULL,
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transcript_corrections_segment ON transcript_corrections(transcript_segment_id);
CREATE TRIGGER trg_transcript_corrections_updated_at BEFORE UPDATE ON transcript_corrections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE speakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    speaker_index INT NOT NULL,
    is_professor BOOLEAN,
    person_id UUID,
    attribution_confidence NUMERIC(4,3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_speakers_transcript_label UNIQUE (transcript_id, label)
);
CREATE INDEX idx_speakers_transcript ON speakers(transcript_id);
CREATE TRIGGER trg_speakers_updated_at BEFORE UPDATE ON speakers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. LECTURE INTELLIGENCE
-- -----------------------------------------------------------------------------

CREATE TABLE lecture_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_class_id UUID NOT NULL REFERENCES scheduled_classes(id) ON DELETE CASCADE,
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    executive_summary TEXT NOT NULL,
    processing_version TEXT NOT NULL,
    processing_status processing_status NOT NULL DEFAULT 'pending',
    model_provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lecture_summaries_class ON lecture_summaries(scheduled_class_id);
CREATE TRIGGER trg_lecture_summaries_updated_at BEFORE UPDATE ON lecture_summaries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lecture_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lecture_summary_id UUID NOT NULL REFERENCES lecture_summaries(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    topic_order INT NOT NULL,
    parent_topic_id UUID REFERENCES lecture_topics(id) ON DELETE CASCADE,
    start_ms BIGINT,
    end_ms BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lecture_topics_summary ON lecture_topics(lecture_summary_id);
CREATE TRIGGER trg_lecture_topics_updated_at BEFORE UPDATE ON lecture_topics
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lecture_summary_id UUID NOT NULL REFERENCES lecture_summaries(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    definition TEXT NOT NULL,
    example TEXT,
    source_segment_id UUID REFERENCES transcript_segments(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_concepts_summary ON concepts(lecture_summary_id);
CREATE TRIGGER trg_concepts_updated_at BEFORE UPDATE ON concepts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lecture_summary_id UUID NOT NULL REFERENCES lecture_summaries(id) ON DELETE CASCADE,
    transcript_segment_id UUID REFERENCES transcript_segments(id) ON DELETE SET NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT,
    asked_by question_asked_by NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_questions_summary ON questions(lecture_summary_id);
CREATE TRIGGER trg_questions_updated_at BEFORE UPDATE ON questions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reading_references (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lecture_summary_id UUID NOT NULL REFERENCES lecture_summaries(id) ON DELETE CASCADE,
    transcript_segment_id UUID REFERENCES transcript_segments(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    authors TEXT,
    reference_type reading_reference_type NOT NULL DEFAULT 'other',
    url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reading_references_summary ON reading_references(lecture_summary_id);
CREATE TRIGGER trg_reading_references_updated_at BEFORE UPDATE ON reading_references
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 6. ACADEMIC EVENTS & CONFIRMATION
-- -----------------------------------------------------------------------------

CREATE TABLE extracted_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_segment_id UUID NOT NULL REFERENCES transcript_segments(id) ON DELETE RESTRICT,
    scheduled_class_id UUID NOT NULL REFERENCES scheduled_classes(id) ON DELETE RESTRICT,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    event_type academic_event_type NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    event_date DATE,
    event_time TIME,
    event_timezone TEXT DEFAULT 'America/Sao_Paulo',
    confidence_overall NUMERIC(4,3) NOT NULL,
    confidence_transcription NUMERIC(4,3) NOT NULL,
    confidence_event_classification NUMERIC(4,3) NOT NULL,
    confidence_date_interpretation NUMERIC(4,3) NOT NULL,
    confidence_course_association NUMERIC(4,3) NOT NULL,
    confirmation_status confirmation_status NOT NULL DEFAULT 'suggested',
    processing_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_extracted_events_class ON extracted_events(scheduled_class_id);
CREATE INDEX idx_extracted_events_course ON extracted_events(course_id);
CREATE INDEX idx_extracted_events_status ON extracted_events(confirmation_status);
CREATE INDEX idx_extracted_events_date ON extracted_events(event_date);
CREATE TRIGGER trg_extracted_events_updated_at BEFORE UPDATE ON extracted_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_confirmations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    extracted_event_id UUID NOT NULL REFERENCES extracted_events(id) ON DELETE CASCADE,
    confirmed_by UUID NOT NULL,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action VARCHAR(50) NOT NULL, -- confirmed, edited, rejected, escalated
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_confirmations_event ON event_confirmations(extracted_event_id);
CREATE TRIGGER trg_event_confirmations_updated_at BEFORE UPDATE ON event_confirmations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    extracted_event_id UUID NOT NULL REFERENCES extracted_events(id) ON DELETE CASCADE,
    changed_by UUID,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    change_type event_change_type NOT NULL,
    field_name TEXT NOT NULL,
    previous_value TEXT,
    new_value TEXT,
    source change_source NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_changes_event ON event_changes(extracted_event_id);
CREATE TRIGGER trg_event_changes_updated_at BEFORE UPDATE ON event_changes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. CALENDAR & STUDENT NOTIFICATIONS
-- -----------------------------------------------------------------------------

CREATE TABLE calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    class_section_id UUID REFERENCES class_sections(id) ON DELETE CASCADE,
    extracted_event_id UUID REFERENCES extracted_events(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    event_type academic_event_type NOT NULL,
    event_date DATE,
    event_time TIME,
    event_timezone TEXT DEFAULT 'America/Sao_Paulo',
    confirmation_status confirmation_status NOT NULL DEFAULT 'published',
    is_official BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_calendar_events_course ON calendar_events(course_id);
CREATE INDEX idx_calendar_events_section ON calendar_events(class_section_id);
CREATE INDEX idx_calendar_events_date ON calendar_events(event_date);
CREATE TRIGGER trg_calendar_events_updated_at BEFORE UPDATE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE student_calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
    reminder_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_student_calendar_event UNIQUE (student_id, calendar_event_id)
);
CREATE INDEX idx_student_calendar_events_student ON student_calendar_events(student_id);
CREATE TRIGGER trg_student_calendar_events_updated_at BEFORE UPDATE ON student_calendar_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    professor_id UUID REFERENCES professors(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    channel notification_channel NOT NULL DEFAULT 'in_app',
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifications_student ON notifications(student_id);
CREATE INDEX idx_notifications_professor ON notifications(professor_id);
CREATE TRIGGER trg_notifications_updated_at BEFORE UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    resource_type interaction_resource_type NOT NULL,
    resource_id UUID NOT NULL,
    interaction_type interaction_type NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_content_interactions_student ON content_interactions(student_id);
CREATE INDEX idx_content_interactions_resource ON content_interactions(resource_type, resource_id);
CREATE TRIGGER trg_content_interactions_updated_at BEFORE UPDATE ON content_interactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 8. GOVERNANCE, CONSENT & AUDIT
-- -----------------------------------------------------------------------------

CREATE TABLE recording_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    professor_id UUID REFERENCES professors(id) ON DELETE CASCADE,
    recording_policy_id UUID NOT NULL REFERENCES recording_policies(id) ON DELETE RESTRICT,
    class_section_id UUID REFERENCES class_sections(id) ON DELETE CASCADE,
    consent_given BOOLEAN NOT NULL DEFAULT FALSE,
    consented_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recording_consents_student ON recording_consents(student_id);
CREATE INDEX idx_recording_consents_professor ON recording_consents(professor_id);
CREATE TRIGGER trg_recording_consents_updated_at BEFORE UPDATE ON recording_consents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL,
    actor_id UUID,
    actor_type actor_type NOT NULL DEFAULT 'system',
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id UUID,
    metadata JSONB,
    ip_address VARCHAR(45),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- NOTE: audit_events are strictly immutable; no updated_at trigger
);
CREATE INDEX idx_audit_events_tenant ON audit_events(tenant_institution_id);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at);
CREATE INDEX idx_audit_events_resource ON audit_events(resource_type, resource_id);

-- =============================================================================
-- END OF V001 SCHEMA
-- =============================================================================
