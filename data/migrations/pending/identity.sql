-- =============================================================================
-- identity — schema gaps found while writing the Postgres adapters
-- (integration stage §1). To be merged into V005__integration.sql.
-- Idempotent where PostgreSQL allows it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Refresh-token rotation grace window (10 s): the successor pair issued for a
--    rotated token is replayed to a concurrent refresh from the same client, on
--    any replica. The pair is sealed with AES-256-GCM (AAD = previous token id) by
--    the service; plaintext tokens never reach the database. Rows live seconds and
--    are pruned on write.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_token_grace (
    previous_token_id UUID PRIMARY KEY REFERENCES refresh_tokens(id) ON DELETE CASCADE,
    successor_id UUID NOT NULL REFERENCES refresh_tokens(id) ON DELETE CASCADE,
    payload BYTEA NOT NULL,                    -- iv(12) | tag(16) | ciphertext
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_token_grace_expires ON refresh_token_grace(expires_at);

-- -----------------------------------------------------------------------------
-- 2. DSR timeline ordering: several events share the same instant (one execution
--    writes started / service_* / completed together), so `at` alone does not
--    give a stable order. Insertion order is the timeline order.
-- -----------------------------------------------------------------------------
ALTER TABLE dsr_events ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE INDEX IF NOT EXISTS idx_dsr_events_request_seq ON dsr_events(request_id, at, seq);

-- -----------------------------------------------------------------------------
-- 3. One open request per *account* and type. V004's uq_dsr_requests_open keys on
--    subject_id, which differs for the same person filed as subject_type 'user'
--    (user id) vs 'student' (student id); the service resolves both to
--    subject_user_id and enforces uniqueness there.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_dsr_requests_open_user ON dsr_requests(institution_id, subject_user_id, type)
    WHERE status IN ('received', 'verifying', 'in_progress');

-- -----------------------------------------------------------------------------
-- 4. Expired-row pruning support (revoked JTIs and OIDC states are looked up by
--    key and filtered by expiry; a periodic DELETE uses these indexes).
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_revoked_access_tokens_expires ON revoked_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oidc_auth_states_expires ON oidc_auth_states(expires_at);
