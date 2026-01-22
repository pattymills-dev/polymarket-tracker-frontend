-- Insert all missing markets from trades data
-- This will add the 1,230 orphaned market_ids to the markets table

INSERT INTO markets (id, question, resolved, created_at, updated_at)
SELECT DISTINCT
  t.market_id as id,
  COALESCE(t.market_title, t.market_slug, t.market_id) as question,
  false as resolved,
  NOW() as created_at,
  NOW() as updated_at
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id
WHERE m.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- Check how many we inserted
SELECT COUNT(*) as total_markets_now FROM markets;

-- Check orphaned count (should be 0 now)
SELECT COUNT(DISTINCT t.market_id) as orphaned_market_count
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id
WHERE m.id IS NULL;
