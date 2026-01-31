-- Create a table to cache top traders for alert matching
-- This gets refreshed periodically by a cron job

CREATE TABLE IF NOT EXISTS top_traders (
  trader_address TEXT PRIMARY KEY,
  total_pl NUMERIC,
  total_buy_cost NUMERIC,
  resolved_markets INTEGER,
  win_rate NUMERIC,
  rank INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for fast lookups during trade processing
CREATE INDEX IF NOT EXISTS idx_top_traders_rank ON top_traders(rank);

-- Add a column to alerts to distinguish alert sources
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_source TEXT DEFAULT 'whale';
-- Values: 'whale', 'top_trader', 'watchlist'

-- Add market_title to alerts for better messages
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS market_title TEXT;

-- Create a function to refresh top traders cache
CREATE OR REPLACE FUNCTION refresh_top_traders()
RETURNS void AS $$
BEGIN
  -- Clear existing cache
  DELETE FROM top_traders;

  -- Insert top 50 traders by P/L with at least 3 resolved markets
  INSERT INTO top_traders (trader_address, total_pl, total_buy_cost, resolved_markets, win_rate, rank, updated_at)
  SELECT
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate,
    ROW_NUMBER() OVER (ORDER BY total_pl DESC) as rank,
    NOW()
  FROM calculate_trader_performance(3)
  ORDER BY total_pl DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- Initial population
SELECT refresh_top_traders();

-- Schedule refresh every 15 minutes via pg_cron (if available)
-- This may need to be run separately if pg_cron isn't enabled
-- SELECT cron.schedule('refresh-top-traders', '*/15 * * * *', 'SELECT refresh_top_traders()');
