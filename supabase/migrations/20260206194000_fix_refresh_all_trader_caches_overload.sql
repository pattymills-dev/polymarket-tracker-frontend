-- Resolve refresh_trader_open_exposure() overload ambiguity.
--
-- We previously had:
--   refresh_trader_open_exposure(p_min_amount numeric default 1000)
-- and later introduced:
--   refresh_trader_open_exposure(p_min_amount numeric default 1000, p_min_net_shares numeric default 0.000001)
--
-- Because both args are defaulted, calling refresh_trader_open_exposure() (no args) becomes ambiguous.
-- That breaks refresh_all_trader_caches() and any jobs that depend on it.

-- Drop the legacy 1-arg overload (safe: no callers should rely on it directly).
DROP FUNCTION IF EXISTS refresh_trader_open_exposure(numeric);

-- Recreate the cache refresher to call the 2-arg function explicitly.
CREATE OR REPLACE FUNCTION refresh_all_trader_caches()
RETURNS void AS $$
BEGIN
  PERFORM refresh_top_traders();
  PERFORM refresh_hot_streaks();
  PERFORM refresh_whale_volume_traders();
  PERFORM refresh_trader_open_exposure(1000::numeric, 0.000001::numeric);
END;
$$ LANGUAGE plpgsql;

