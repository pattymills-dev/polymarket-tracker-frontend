-- Diagnostic queries to understand the data

-- 1. Check how many resolved markets exist
SELECT COUNT(*) as total_resolved_markets
FROM markets
WHERE resolved = true;

-- 2. Check how many traders have trades in resolved markets
SELECT COUNT(DISTINCT t.trader_address) as traders_with_resolved_market_trades
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id
WHERE m.resolved = true;

-- 3. Check total number of unique traders (all markets)
SELECT COUNT(DISTINCT trader_address) as total_unique_traders
FROM trades;

-- 4. Check total number of markets
SELECT COUNT(*) as total_markets
FROM markets;

-- 5. List all resolved markets
SELECT id, title, resolved, winning_outcome, created_at
FROM markets
WHERE resolved = true
ORDER BY created_at DESC;

-- 6. Check if there are trades but no resolved markets
SELECT
  COUNT(*) as total_trades,
  COUNT(DISTINCT trader_address) as unique_traders,
  COUNT(DISTINCT market_id) as unique_markets
FROM trades;
