-- Manual check: Let's see how many markets we have now and check if any should be resolved
-- Run these queries one by one

-- 1. Total markets now (should be ~2613 = 2406 + 207)
SELECT COUNT(*) as total_markets FROM markets;

-- 2. How many unresolved
SELECT COUNT(*) as unresolved FROM markets WHERE resolved = false;

-- 3. How many resolved
SELECT COUNT(*) as resolved FROM markets WHERE resolved = true;

-- 4. Check traders with resolved markets now
SELECT COUNT(DISTINCT t.trader_address) as traders_with_resolved_market_trades
FROM trades t
INNER JOIN markets m ON t.market_id = m.id
WHERE m.resolved = true;
