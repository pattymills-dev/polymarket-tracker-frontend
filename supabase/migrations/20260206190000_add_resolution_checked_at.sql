-- Track when we last checked a market for resolution.
-- NOTE: `updated_at` is frequently mutated by other jobs (e.g., trade/slug upserts),
-- so it is not a reliable scheduling signal for resolution sync.

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS resolution_checked_at TIMESTAMPTZ;

-- Backfill from updated_at when available so we don't immediately recheck everything.
UPDATE markets
SET resolution_checked_at = updated_at
WHERE resolution_checked_at IS NULL
  AND updated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_markets_resolution_checked_at
  ON markets (resolution_checked_at);

