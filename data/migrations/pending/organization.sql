-- organization — schema gaps found while writing the Postgres adapter (integration stage).
-- Idempotent; merged by the coordinator into V005__integration.sql.

-- The service enforces these case-insensitively; V001 only had case-sensitive / no constraints.
CREATE UNIQUE INDEX IF NOT EXISTS uq_holding_companies_name ON holding_companies(lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_classrooms_code_ci ON classrooms(campus_id, lower(code));

-- Consent status reads every current consent of a policy; DSR/subject lookups by subject.
CREATE INDEX IF NOT EXISTS idx_recording_consents_policy_current
    ON recording_consents(recording_policy_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recording_consents_subject
    ON recording_consents(subject_id, recording_policy_id);

-- Retention job history per institution (GET /v1/retention/jobs?institutionId=).
CREATE INDEX IF NOT EXISTS idx_retention_jobs_institution
    ON retention_jobs(institution_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_versions_policy ON recording_policy_versions(policy_id, version);
