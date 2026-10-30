-- The scoring model produces a breakdown, not just a number. Storing it means
-- GET /devices/:id/risk can serve the "why" without recomputing, and a score
-- computed under an older model version stays identifiable.

ALTER TABLE risk_scores ADD COLUMN factors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE risk_scores ADD COLUMN model_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE risk_scores ADD COLUMN window_hours INTEGER;
