-- pending/speaker-diarization-phase6.sql — Phase 6.1 diarization v2 (overlap, confidence).
-- Idempotent and independent of pending/speaker-diarization.sql (either order applies).

-- v2 turns: overlapped speech (two voices at once) and per-turn confidence (mean posterior).
ALTER TABLE speaker_turns
    ADD COLUMN IF NOT EXISTS overlap BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_speaker_turns_confidence') THEN
        ALTER TABLE speaker_turns
            ADD CONSTRAINT ck_speaker_turns_confidence
                CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1);
    END IF;
END $$;

-- Overlapping turns of different speakers may start together: uniqueness is per speaker.
DROP INDEX IF EXISTS uq_speaker_turns_transcript_start;
CREATE UNIQUE INDEX IF NOT EXISTS uq_speaker_turns_transcript_speaker_start
    ON speaker_turns (transcript_id, speaker_label, start_ms);

-- Overlap review queries ("where did two people talk at once?").
CREATE INDEX IF NOT EXISTS idx_speaker_turns_overlap
    ON speaker_turns (transcript_id) WHERE overlap;
