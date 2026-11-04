-- =============================================================================
-- calendar — schema gaps found while writing the Postgres adapters
-- (integration stage §1). To be merged into V005__integration.sql.
-- Idempotent where PostgreSQL allows it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. calendar_events.extracted_event_id is a cross-service reference (owned by
--    event-extraction). A hard FK couples write ordering across services and
--    lets retention deletes of extracted events reach published calendars.
--    Provenance is copied onto the calendar event (quote, transcript, segment),
--    so the id stays as a plain, uniquely indexed reference.
-- -----------------------------------------------------------------------------
ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_extracted_event_id_fkey;

-- -----------------------------------------------------------------------------
-- 2. Calendar-owned read models of the academic data pushed by
--    academic-integration (§3: `/v1/sections`, `/v1/enrollments/bulk`).
--    section_access_mirror / enrollment_access_mirror belong to identity and are
--    written with different column sets, so calendar keeps its own copies.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_section_mirror (
    class_section_id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    course_id UUID NOT NULL,
    professor_id UUID,
    course_name TEXT,
    section_code TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_section_mirror_institution
    ON calendar_section_mirror(institution_id);

CREATE TABLE IF NOT EXISTS calendar_enrollment_mirror (
    class_section_id UUID NOT NULL REFERENCES calendar_section_mirror(class_section_id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (class_section_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_enrollment_mirror_student
    ON calendar_enrollment_mirror(student_id);

-- -----------------------------------------------------------------------------
-- 3. Term bounds used by the `non_teaching_day` conflict rule (POST /v1/terms).
--    academic_terms is owned by academic-integration; calendar keeps the bounds
--    it was told about.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_terms (
    id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    name TEXT,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    CONSTRAINT ck_calendar_terms_bounds CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_calendar_terms_institution ON calendar_terms(institution_id);

-- -----------------------------------------------------------------------------
-- 4. Change history ordering: one publish writes several changes in the same
--    instant (e.g. eventDate + eventTime); insertion order is the display order.
-- -----------------------------------------------------------------------------
ALTER TABLE calendar_event_changes ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;

-- -----------------------------------------------------------------------------
-- 5. Student calendar / ICS feed reads events of a set of sections by date.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_calendar_events_section_date
    ON calendar_events(class_section_id, event_date);
