-- transcript-management (integration stage)
-- Retention kind `transcript` deletes transcripts (segments, corrections, embeddings cascade).
-- Downstream rows must not block or be destroyed by that deletion: lecture summaries have their own,
-- longer retention (`summary`), and extracted events copy their provenance quote, so both keep the
-- row and lose only the link.
ALTER TABLE lecture_summaries ALTER COLUMN transcript_id DROP NOT NULL;
ALTER TABLE lecture_summaries DROP CONSTRAINT IF EXISTS lecture_summaries_transcript_id_fkey;
ALTER TABLE lecture_summaries
    ADD CONSTRAINT lecture_summaries_transcript_id_fkey
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE SET NULL;

ALTER TABLE extracted_events ALTER COLUMN transcript_segment_id DROP NOT NULL;
ALTER TABLE extracted_events DROP CONSTRAINT IF EXISTS extracted_events_transcript_segment_id_fkey;
ALTER TABLE extracted_events
    ADD CONSTRAINT extracted_events_transcript_segment_id_fkey
    FOREIGN KEY (transcript_segment_id) REFERENCES transcript_segments(id) ON DELETE SET NULL;

-- Retention candidates are selected per institution and age.
CREATE INDEX IF NOT EXISTS idx_transcripts_institution_created ON transcripts(institution_id, created_at);
-- DSR requests look corrections up by author.
CREATE INDEX IF NOT EXISTS idx_transcript_corrections_author ON transcript_corrections(corrected_by);
