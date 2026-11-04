-- pending/transcription-phase6.sql — Phase 6.4 additional lecture languages.
-- Idempotent and independent of pending/transcription.sql (either order applies).

-- Speech-adaptation phrase sets are per language (pt-BR default; en-US, es-ES, es-419, fr-FR).
ALTER TABLE transcription_vocabularies
    ADD COLUMN IF NOT EXISTS language VARCHAR(10) NOT NULL DEFAULT 'pt-BR';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_transcription_vocab_language') THEN
        ALTER TABLE transcription_vocabularies
            ADD CONSTRAINT ck_transcription_vocab_language
                CHECK (language IN ('pt-BR', 'en-US', 'es-ES', 'es-419', 'fr-FR'));
    END IF;
END $$;

DROP INDEX IF EXISTS idx_transcription_vocab_institution;
CREATE INDEX IF NOT EXISTS idx_transcription_vocab_lookup
    ON transcription_vocabularies (language, institution_id, discipline);

-- Effective language of each job (also inside request JSONB) for reporting per language.
ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS language VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_language ON transcription_jobs (language);
