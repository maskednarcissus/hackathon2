-- =============================================================================
-- notifications — schema gaps found while writing the Postgres adapters
-- (integration stage §1). To be merged into V005__integration.sql.
-- Idempotent where PostgreSQL allows it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Identifier columns: actors and users are identity user ids (UUID in production),
--    but alerts are also acted on by service accounts / static admin tokens whose
--    actor is free text. Store them as TEXT in notifications-owned tables.
-- -----------------------------------------------------------------------------
ALTER TABLE alerts ALTER COLUMN acknowledged_by TYPE TEXT USING acknowledged_by::text;
ALTER TABLE alerts ALTER COLUMN resolved_by TYPE TEXT USING resolved_by::text;
ALTER TABLE alerts ALTER COLUMN assignee_id TYPE TEXT USING assignee_id::text;
ALTER TABLE incident_comments ALTER COLUMN actor_id TYPE TEXT USING actor_id::text;
ALTER TABLE incident_activity ALTER COLUMN actor_id TYPE TEXT USING actor_id::text;

ALTER TABLE user_notifications ALTER COLUMN user_id TYPE TEXT USING user_id::text;
ALTER TABLE notification_preferences ALTER COLUMN user_id TYPE TEXT USING user_id::text;
ALTER TABLE push_subscriptions ALTER COLUMN user_id TYPE TEXT USING user_id::text;

-- -----------------------------------------------------------------------------
-- 2. user_notifications: the dedup version is a string ("published",
--    "date:2026-11-17T19:00", "reminder:…:24h"); in_app = visible in the inbox
--    (false when the user disabled in_app for a non-critical category).
-- -----------------------------------------------------------------------------
ALTER TABLE user_notifications ALTER COLUMN version DROP DEFAULT;
ALTER TABLE user_notifications ALTER COLUMN version TYPE TEXT USING version::text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS in_app BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_user_notifications_inbox
    ON user_notifications(user_id, created_at DESC) WHERE in_app;

-- deferred (quiet hours) deliveries are notification_deliveries rows with
-- status 'deferred' and due_at; 'released' once picked up by the flusher.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
    ON notification_deliveries(notification_id, attempted_at);

-- -----------------------------------------------------------------------------
-- 2b. Insertion order for logs whose timestamps can tie (same request):
--     incident timeline, comments and delivery logs are ordered by (time, seq).
-- -----------------------------------------------------------------------------
ALTER TABLE incident_activity ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE incident_comments ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- -----------------------------------------------------------------------------
-- 3. Enrollment mirror owned by notifications (fed by POST /v1/sync/enrollments;
--    identity's enrollment_access_mirror belongs to identity).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_enrollments (
    user_id TEXT NOT NULL,
    student_id UUID NOT NULL,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    class_section_id UUID NOT NULL,
    email TEXT,
    status enrollment_status NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, class_section_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_enrollments_section
    ON notification_enrollments(class_section_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_notification_enrollments_student
    ON notification_enrollments(student_id);

-- -----------------------------------------------------------------------------
-- 4. Calendar events tracked for change detection ("Prazo alterado") and reminders.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_tracked_events (
    calendar_event_id UUID PRIMARY KEY,
    extracted_event_id UUID,
    institution_id UUID,
    class_section_id UUID NOT NULL,
    course_id UUID,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    event_date DATE NOT NULL,
    event_time TIME,
    timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_tracked_events_extracted
    ON notification_tracked_events(extracted_event_id);
CREATE INDEX IF NOT EXISTS idx_notification_tracked_events_date
    ON notification_tracked_events(event_date) WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- 5. Event-bus idempotency: eventIds already processed by /v1/lifecycle-events.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_processed_events (
    event_id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_processed_events_at
    ON notification_processed_events(processed_at);
