-- ============================================
-- TROUBLESHOOTING: Why only 1 resolved market?
-- ============================================

-- 1. Check how many markets we have total
SELECT COUNT(*) as total_markets FROM markets;

-- 2. Check how many are marked as resolved
SELECT COUNT(*) as resolved_markets FROM markets WHERE resolved = true;

-- 3. Check how many are marked as NOT resolved
SELECT COUNT(*) as unresolved_markets FROM markets WHERE resolved = false;

-- 4. Sample some unresolved markets to see if they should be resolved
SELECT id, title, question, resolved, created_at, updated_at
FROM markets
WHERE resolved = false
ORDER BY created_at DESC
LIMIT 10;

-- 5. Check if markets have trades
SELECT
  COUNT(DISTINCT m.id) as markets_with_trades,
  COUNT(DISTINCT CASE WHEN m.resolved = true THEN m.id END) as resolved_markets_with_trades
FROM markets m
INNER JOIN trades t ON t.market_id = m.id;

-- 6. Look at the 1 resolved market we have
SELECT id, title, question, resolved, winning_outcome, resolved_at, created_at
FROM markets
WHERE resolved = true;

-- 7. Check if we're tracking the right market IDs
-- Compare market IDs in trades vs markets table
SELECT
  COUNT(DISTINCT t.market_id) as unique_market_ids_in_trades,
  COUNT(DISTINCT m.id) as unique_market_ids_in_markets_table,
  COUNT(DISTINCT CASE WHEN m.id IS NULL THEN t.market_id END) as orphaned_trade_market_ids
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id;

-- 8. Sample some trades to see what market_ids look like
SELECT market_id, COUNT(*) as trade_count
FROM trades
GROUP BY market_id
ORDER BY trade_count DESC
LIMIT 10;
