-- Create hot_streaks table for traders with high win rates
-- These are traders "on a heater" - high accuracy but maybe not huge P/L yet

CREATE TABLE IF NOT EXISTS hot_streaks (
  trader_address TEXT PRIMARY KEY,
  total_pl NUMERIC,
  total_buy_cost NUMERIC,
  resolved_markets INTEGER,
  win_rate NUMERIC,
  wins INTEGER,
  losses INTEGER,
  rank INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_hot_streaks_rank ON hot_streaks(rank);

-- Create function to refresh hot streaks cache
-- Criteria: 70%+ win rate, 5+ resolved markets, sorted by win rate
CREATE OR REPLACE FUNCTION refresh_hot_streaks()
RETURNS void AS $$
BEGIN
  -- Clear existing cache
  DELETE FROM hot_streaks;

  -- Insert top 50 traders by win rate with at least 5 resolved markets and 70%+ win rate
  INSERT INTO hot_streaks (trader_address, total_pl, total_buy_cost, resolved_markets, win_rate, wins, losses, rank, updated_at)
  SELECT
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate * 100, -- Convert to percentage
    wins,
    losses,
    ROW_NUMBER() OVER (ORDER BY win_rate DESC, resolved_markets DESC) as rank,
    NOW()
  FROM calculate_trader_performance(5)  -- Minimum 5 resolved markets
  WHERE win_rate >= 0.70  -- 70%+ win rate
  ORDER BY win_rate DESC, resolved_markets DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- Initial population
SELECT refresh_hot_streaks();

-- Update the main refresh to also refresh hot streaks
CREATE OR REPLACE FUNCTION refresh_all_trader_caches()
RETURNS void AS $$
BEGIN
  PERFORM refresh_top_traders();
  PERFORM refresh_hot_streaks();
END;
$$ LANGUAGE plpgsql;
