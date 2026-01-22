-- Find market_ids in trades that DON'T exist in markets table
SELECT DISTINCT t.market_id
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id
WHERE m.id IS NULL
LIMIT 20;

-- Count how many orphaned market_ids there are
SELECT COUNT(DISTINCT t.market_id) as orphaned_market_count
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id
WHERE m.id IS NULL;

-- Sample some of these orphaned trades to see what they look like
SELECT t.market_id, t.market_title, t.market_slug, COUNT(*) as trade_count
FROM trades t
LEFT JOIN markets m ON t.market_id = m.id
WHERE m.id IS NULL
GROUP BY t.market_id, t.market_title, t.market_slug
ORDER BY trade_count DESC
LIMIT 10;
