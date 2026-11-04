-- =============================================================================
-- calendar — Phase 6 §6.9 external calendars (Google Calendar, Microsoft 365).
-- To be merged into the Phase 6 migration. Idempotent where PostgreSQL allows it.
-- Depends on pending/calendar.sql (calendar_events FK changes).
-- =============================================================================

-- One connection per student and provider. OAuth tokens are stored only as an
-- AES-256-GCM sealed blob (iv | tag | ciphertext, AAD = connection id); the key
-- (CALENDAR_TOKEN_KEY) lives in Secret Manager, never in the database.
CREATE TABLE IF NOT EXISTS external_calendar_connections (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'broken')),
    remote_calendar_id TEXT,
    token_ciphertext BYTEA,
    token_expires_at TIMESTAMPTZ,
    last_sync_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_external_calendar_connection UNIQUE (student_id, provider),
    -- a broken grant is discarded, never kept around
    CONSTRAINT ck_external_calendar_broken_no_tokens CHECK (status <> 'broken' OR token_ciphertext IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_external_calendar_connections_active
    ON external_calendar_connections(student_id) WHERE status = 'active';

-- OAuth authorization requests: single use, 10 minutes (state + PKCE verifier).
CREATE TABLE IF NOT EXISTS external_calendar_oauth_states (
    state TEXT PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
    code_verifier TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_external_calendar_oauth_states_expires
    ON external_calendar_oauth_states(expires_at);

-- Remote copy of each calendar event per connection: makes sync idempotent
-- (patch the stored remote id; skip when synced_version >= event version).
CREATE TABLE IF NOT EXISTS external_calendar_event_links (
    connection_id UUID NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
    calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    external_event_id TEXT NOT NULL,
    synced_version INT NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (connection_id, calendar_event_id)
);
CREATE INDEX IF NOT EXISTS idx_external_calendar_event_links_event
    ON external_calendar_event_links(calendar_event_id);

-- Event-bus consumption uses the shared processed_events table (V002) with
-- consumer = 'calendar-external-sync'; no new table needed.
