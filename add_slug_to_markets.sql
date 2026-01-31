-- Add slug column to markets table if it doesn't exist
ALTER TABLE markets ADD COLUMN IF NOT EXISTS slug text;

-- Backfill slugs from trades table
UPDATE markets m
SET slug = t.market_slug
FROM (
  SELECT DISTINCT market_id, market_slug
  FROM trades
  WHERE market_slug IS NOT NULL
) t
WHERE m.id = t.market_id
  AND m.slug IS NULL;

-- Create index for slug lookups
CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);

-- Verify the update
SELECT
  COUNT(*) as total_markets,
  COUNT(slug) as markets_with_slug,
  COUNT(*) FILTER (WHERE resolved = false) as unresolved_markets,
  COUNT(*) FILTER (WHERE winning_outcome IS NULL) as missing_winning_outcome
FROM markets;
