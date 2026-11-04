-- device-management — Phase 6 (6.10 second-generation devices). Idempotent; requires
-- pending/device-management.sql. Merged by the coordinator into the next V00x migration.

-- Hardware key attestation verified at registration (ci-attest-v1) and the capability set the
-- firmware reports in heartbeats.
ALTER TABLE capture_devices
    ADD COLUMN IF NOT EXISTS attestation JSONB,
    ADD COLUMN IF NOT EXISTS reported_capabilities JSONB;
CREATE INDEX IF NOT EXISTS idx_capture_devices_model ON capture_devices(model);

-- Signed OTA releases with staged rollout per model.
CREATE TABLE IF NOT EXISTS firmware_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model VARCHAR(100) NOT NULL,
    version VARCHAR(50) NOT NULL,
    manifest TEXT NOT NULL,                 -- compact signed manifest served verbatim to devices
    manifest_payload JSONB NOT NULL,        -- decoded copy for queries
    key_id TEXT NOT NULL,
    rollout_percent INT NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
    halted BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_firmware_release_version UNIQUE (model, version)
);
CREATE INDEX IF NOT EXISTS idx_firmware_releases_model ON firmware_releases(model, created_at DESC);

-- Latest update state per device and release (rollout monitoring).
CREATE TABLE IF NOT EXISTS device_firmware_update_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES capture_devices(id) ON DELETE CASCADE,
    release_id UUID NOT NULL REFERENCES firmware_releases(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('downloading', 'staged', 'installed', 'failed')),
    error TEXT,
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_firmware_update_report UNIQUE (device_id, release_id)
);
CREATE INDEX IF NOT EXISTS idx_firmware_update_reports_release ON device_firmware_update_reports(release_id);
