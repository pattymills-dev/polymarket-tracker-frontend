-- Ensure refresh_all_trader_caches() refreshes every cached leaderboard/table we depend on.
--
-- This also avoids overload ambiguity by calling refresh_trader_open_exposure() with explicit args.
-- (If both 1-arg and 2-arg versions exist with defaults, calling with 0 args is ambiguous.)

CREATE OR REPLACE FUNCTION refresh_all_trader_caches()
RETURNS void AS $$
BEGIN
  PERFORM refresh_top_traders();
  PERFORM refresh_hot_streaks();
  PERFORM refresh_whale_volume_traders();
  PERFORM refresh_trader_open_exposure(1000::numeric, 0.000001::numeric);
  PERFORM refresh_copyable_traders();
END;
$$ LANGUAGE plpgsql;

