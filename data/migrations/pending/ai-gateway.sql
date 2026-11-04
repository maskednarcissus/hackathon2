-- ai-gateway — integration stage schema gaps (to be merged into V005__integration.sql).

-- ai_calls is an append-only accounting log: a call must never be lost because the caller sent
-- an institution id that is not (yet) synchronised into `institutions`. Keep the column, drop the FK.
ALTER TABLE ai_calls DROP CONSTRAINT IF EXISTS ai_calls_institution_id_fkey;

