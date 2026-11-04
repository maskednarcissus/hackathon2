-- audit (integration stage)
-- Global insertion order used for cursor pagination of GET /v1/audit-events.
-- An identity column added to an existing table is filled by the table rewrite, so the
-- append-only UPDATE trigger (trg_audit_events_immutable) is not fired.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS position BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_position ON audit_events(position);
-- Analytics reads events per (tenant, action, time window).
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_action_time
    ON audit_events(tenant_institution_id, action, occurred_at);
-- DSR access requests list events by actor.
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_position ON audit_events(actor_id, position);

-- Phase 5 role. ALTER TYPE … ADD VALUE must stay its own statement and the new value is not used
-- elsewhere in this file (it cannot be referenced in the transaction that adds it).
ALTER TYPE actor_type ADD VALUE IF NOT EXISTS 'group_executive';
