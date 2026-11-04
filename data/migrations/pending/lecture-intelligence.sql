-- lecture-intelligence — integration stage schema gaps (to be merged into V005__integration.sql).

-- Idempotent event consumption (integration stage §2): one row per (consumer, eventId).
-- Generic on purpose so every Python/TS consumer can share it.
CREATE TABLE IF NOT EXISTS event_inbox (
    consumer TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (consumer, event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_inbox_processed_at ON event_inbox (processed_at);

-- Retention (kind "summary") scans by age; library and "latest per class" read by class + recency.
CREATE INDEX IF NOT EXISTS idx_lecture_summaries_created_at ON lecture_summaries (created_at);
CREATE INDEX IF NOT EXISTS idx_lecture_summaries_class_created
    ON lecture_summaries (scheduled_class_id, created_at DESC);

-- Assistant: DSR lookups by student, memory by conversation + turn.
CREATE INDEX IF NOT EXISTS idx_assistant_conversations_student ON assistant_conversations (student_id);
CREATE INDEX IF NOT EXISTS idx_assistant_answers_student ON assistant_answers (student_id);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_student ON assistant_feedback (student_id);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_answer ON assistant_feedback (answer_id);
