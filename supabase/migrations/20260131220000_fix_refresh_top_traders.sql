-- Fix the refresh function to use wins/losses from calculate_trader_performance directly
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
    win_rate * 100, -- Convert to percentage
    wins,
    losses,
    ROW_NUMBER() OVER (ORDER BY total_pl DESC) as rank,
    NOW()
  FROM calculate_trader_performance(3)
  ORDER BY total_pl DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- Refresh the cache with corrected data
SELECT refresh_top_traders();
