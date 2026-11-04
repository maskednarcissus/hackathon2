-- academic-integration (integration stage)
-- Timetable imports carry no academic program (SIS exports rarely do); courses are linked to a program
-- later by curriculum management.
ALTER TABLE courses ALTER COLUMN academic_program_id DROP NOT NULL;

-- Alert context feed and recording plans scan scheduled classes by time window.
CREATE INDEX IF NOT EXISTS idx_scheduled_classes_time ON scheduled_classes(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_class_sections_institution ON class_sections(institution_id);
