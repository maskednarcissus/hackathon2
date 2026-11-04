-- pending/speaker-diarization.sql — schema gaps found while writing the diarization Postgres adapter.
-- Idempotent; to be merged into V005__integration.sql by the coordinator.

-- Provenance of speaker turns (which diarization build produced them, and when). Turns are
-- replaced as a whole on re-diarization, so one version per transcript at a time.
ALTER TABLE speaker_turns
    ADD COLUMN IF NOT EXISTS processing_version TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Turns of one transcript never share a start time (built from ordered, non-overlapping windows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_speaker_turns_transcript_start
    ON speaker_turns (transcript_id, start_ms);
