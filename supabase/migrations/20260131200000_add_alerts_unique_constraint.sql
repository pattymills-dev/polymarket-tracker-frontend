-- Add unique constraint to prevent duplicate alerts for the same trade
-- Using trader_address + market_id + amount as the unique key
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS trade_hash TEXT;

-- Create a unique index on trade_hash for deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_trade_hash ON alerts(trade_hash);

-- Clean up existing duplicates (keep the first one)
DELETE FROM alerts a
USING alerts b
WHERE a.id > b.id
  AND a.trader_address = b.trader_address
  AND a.market_id = b.market_id
  AND a.amount = b.amount;
