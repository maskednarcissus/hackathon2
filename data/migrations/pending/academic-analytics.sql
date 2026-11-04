-- academic-analytics (integration stage)
-- Read models fed by academic-integration's sync push (POST /v1/sync/sections|enrollments|classrooms).
-- No foreign keys: the mirror may be updated before or after the source rows in other schemas.
-- Student ids are pseudonymous and only ever used to compute cohort-suppressed counts.
CREATE TABLE IF NOT EXISTS analytics_sections (
    class_section_id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    course_id UUID NOT NULL,
    course_code TEXT,
    course_name TEXT,
    program_id UUID,
    program_name TEXT,
    professor_id UUID,
    professor_name TEXT,
    section_code TEXT,
    term_start_date DATE,
    term_end_date DATE,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_sections_institution ON analytics_sections(institution_id);
CREATE INDEX IF NOT EXISTS idx_analytics_sections_course ON analytics_sections(course_id);

CREATE TABLE IF NOT EXISTS analytics_enrollments (
    class_section_id UUID NOT NULL REFERENCES analytics_sections(class_section_id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    PRIMARY KEY (class_section_id, student_id)
);

CREATE TABLE IF NOT EXISTS analytics_classrooms (
    classroom_id UUID PRIMARY KEY,
    institution_id UUID NOT NULL,
    campus_id UUID NOT NULL,
    campus_name TEXT,
    name TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A course whose syllabus was registered with zero items (syllabus_items has no row to carry it).
CREATE TABLE IF NOT EXISTS analytics_empty_syllabi (
    course_id UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID
);

-- Class facts keep whether the class had ended when the snapshot was taken.
ALTER TABLE analytics_class_facts ADD COLUMN IF NOT EXISTS due BOOLEAN;
