-- audio-ingestion — integration stage (merge into V005__integration.sql)
-- Retention of raw audio (Phase 4 §5, kind "audio"): the recording row is kept (transcripts,
-- summaries and events reference it); only the audio object, its derived segment objects and
-- the upload/segment rows are removed. audio_deleted_at records when that happened.
ALTER TABLE recording_sessions
    ADD COLUMN IF NOT EXISTS audio_deleted_at TIMESTAMPTZ;

-- Candidate scan: GET /internal/v1/retention/candidates?institutionId&olderThan&kind=audio
CREATE INDEX IF NOT EXISTS idx_recording_sessions_audio_retention
    ON recording_sessions(institution_id, created_at)
    WHERE storage_path IS NOT NULL AND audio_deleted_at IS NULL;
