-- device-management — schema gaps found while writing the Postgres adapter (integration stage).
-- Idempotent; merged by the coordinator into V005__integration.sql.

-- Heartbeat fields added in Phase 1 follow-up (firmware ↔ server alignment).
ALTER TABLE device_heartbeats
    ADD COLUMN IF NOT EXISTS evicted_recordings INT CHECK (evicted_recordings >= 0),
    ADD COLUMN IF NOT EXISTS clock_skew_ms INT,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Heartbeats are telemetry reported by the device: the scheduled class it believes it is
-- recording may not be (or no longer be) known to this database, and a heartbeat must never be
-- rejected for it. Keep the column, drop the cross-service foreign key.
ALTER TABLE device_heartbeats
    DROP CONSTRAINT IF EXISTS device_heartbeats_current_scheduled_class_id_fkey;

-- Stable ordering for commands issued within the same millisecond (history, delivery order).
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
CREATE INDEX IF NOT EXISTS idx_device_commands_device_seq
    ON device_commands(device_id, issued_at DESC, seq DESC);
