-- pending/transcription.sql — schema gaps found while writing the transcription Postgres adapters.
-- Idempotent; to be merged into V005__integration.sql by the coordinator.

-- Platform-wide speech-adaptation phrase sets (e.g. generic pt-BR academic vocabulary, or a
-- discipline list shared by every institution) have no institution: allow NULL.
ALTER TABLE transcription_vocabularies ALTER COLUMN institution_id DROP NOT NULL;

-- Phrase lists must not be empty and boosts stay in the provider's accepted range (0–20).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_transcription_vocab_phrases') THEN
        ALTER TABLE transcription_vocabularies
            ADD CONSTRAINT ck_transcription_vocab_phrases CHECK (cardinality(phrases) > 0),
            ADD CONSTRAINT ck_transcription_vocab_boost CHECK (boost >= 0 AND boost <= 20);
    END IF;
END $$;

-- Lookup by (institution, discipline) including platform-wide rows.
CREATE INDEX IF NOT EXISTS idx_transcription_vocab_platform
    ON transcription_vocabularies (discipline) WHERE institution_id IS NULL;

-- Job listing / reaping of jobs stuck in 'running' after a crash.
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_status_started
    ON transcription_jobs (status, started_at);
