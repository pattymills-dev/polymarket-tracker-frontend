-- Add wins and losses columns to top_traders for alert messages
ALTER TABLE top_traders ADD COLUMN IF NOT EXISTS wins INTEGER DEFAULT 0;
ALTER TABLE top_traders ADD COLUMN IF NOT EXISTS losses INTEGER DEFAULT 0;

-- Update the refresh function to include wins and losses
CREATE OR REPLACE FUNCTION refresh_top_traders()
RETURNS void AS $$
BEGIN
  -- Clear existing cache
  DELETE FROM top_traders;

  -- Insert top 50 traders by P/L with at least 3 resolved markets
  INSERT INTO top_traders (trader_address, total_pl, total_buy_cost, resolved_markets, win_rate, wins, losses, rank, updated_at)
  SELECT
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate,
    -- Calculate wins from win_rate and resolved_markets
    ROUND(COALESCE(win_rate, 0) * COALESCE(resolved_markets, 0) / 100)::INTEGER as wins,
    -- Losses = resolved - wins
    COALESCE(resolved_markets, 0) - ROUND(COALESCE(win_rate, 0) * COALESCE(resolved_markets, 0) / 100)::INTEGER as losses,
    ROW_NUMBER() OVER (ORDER BY total_pl DESC) as rank,
    NOW()
  FROM calculate_trader_performance(3)
  ORDER BY total_pl DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- Refresh the cache with new columns
SELECT refresh_top_traders();
