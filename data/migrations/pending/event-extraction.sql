-- event-extraction — schema gaps found while writing the Postgres adapters (integration stage).
-- Idempotent; to be merged by the coordinator into V005__integration.sql.

-- 1. Events extracted from inline segments (or before transcript-management persisted the
--    segment rows) cannot always resolve transcript_segments.id; the segment is identified by
--    (transcript_id, source_segment_index) and transcript_segment_id is filled when it exists.
ALTER TABLE extracted_events ALTER COLUMN transcript_segment_id DROP NOT NULL;
ALTER TABLE extracted_events ADD COLUMN IF NOT EXISTS source_segment_index INT;
CREATE INDEX IF NOT EXISTS idx_extracted_events_transcript
    ON extracted_events(transcript_id, source_segment_index);
-- Retention candidates scan (institution, created_at).
CREATE INDEX IF NOT EXISTS idx_extracted_events_institution_created
    ON extracted_events(institution_id, created_at);

-- 2. Deterministic ordering of mentions and of the change history (several records can share
--    the same timestamp inside one transaction).
ALTER TABLE extracted_event_mentions ADD COLUMN IF NOT EXISTS position INT;
ALTER TABLE event_changes ADD COLUMN IF NOT EXISTS sequence INT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_changes_sequence
    ON event_changes(extracted_event_id, sequence) WHERE sequence IS NOT NULL;

-- 3. event_changes.changed_by is a UUID; system / non-UUID actors are kept verbatim here.
ALTER TABLE event_changes ADD COLUMN IF NOT EXISTS actor_ref TEXT;
