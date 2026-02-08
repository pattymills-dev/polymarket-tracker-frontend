-- Ensure canonical trader_rankings is refreshed with other caches.

CREATE OR REPLACE FUNCTION refresh_all_trader_caches()
RETURNS void AS $$
BEGIN
  PERFORM refresh_top_traders();
  PERFORM refresh_hot_streaks();
  PERFORM refresh_whale_volume_traders();
  PERFORM refresh_trader_open_exposure(1000::numeric, 0.000001::numeric);
  PERFORM refresh_copyable_traders();
  PERFORM refresh_trader_rankings();
END;
$$ LANGUAGE plpgsql;
