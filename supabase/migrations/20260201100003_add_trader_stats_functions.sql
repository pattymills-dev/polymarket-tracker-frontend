-- Function to recalculate trader stats from trades table
-- Called after batch trade inserts to keep stats fresh

CREATE OR REPLACE FUNCTION recalculate_trader_stats()
RETURNS void AS $$
BEGIN
  -- Upsert aggregated stats for all traders
  INSERT INTO trader_stats (
    trader_address,
    lifetime_trade_count,
    last_trade_at,
    total_volume,
    first_trade_at,
    updated_at
  )
  SELECT
    trader_address,
    COUNT(*)::INT as lifetime_trade_count,
    MAX(timestamp) as last_trade_at,
    SUM(amount) as total_volume,
    MIN(timestamp) as first_trade_at,
    NOW() as updated_at
  FROM trades
  WHERE trader_address IS NOT NULL
  GROUP BY trader_address
  ON CONFLICT (trader_address) DO UPDATE SET
    lifetime_trade_count = EXCLUDED.lifetime_trade_count,
    last_trade_at = EXCLUDED.last_trade_at,
    total_volume = EXCLUDED.total_volume,
    first_trade_at = COALESCE(trader_stats.first_trade_at, EXCLUDED.first_trade_at),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to get trader stats for a specific address (used by Isolated Contact detection)
CREATE OR REPLACE FUNCTION get_trader_stats(p_trader_address TEXT)
RETURNS TABLE (
  lifetime_trade_count INT,
  last_trade_at TIMESTAMPTZ,
  total_volume NUMERIC,
  days_since_last_trade INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.lifetime_trade_count,
    ts.last_trade_at,
    ts.total_volume,
    EXTRACT(DAY FROM (NOW() - ts.last_trade_at))::INT as days_since_last_trade
  FROM trader_stats ts
  WHERE ts.trader_address = p_trader_address;
END;
$$ LANGUAGE plpgsql;

-- Function to check if a trader is "rare" (for Isolated Contact detection)
-- Returns true if: lifetime_trade_count < 10 OR last_trade_at > 30 days ago
CREATE OR REPLACE FUNCTION is_rare_trader(p_trader_address TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_trade_count INT;
  v_last_trade TIMESTAMPTZ;
BEGIN
  SELECT lifetime_trade_count, last_trade_at
  INTO v_trade_count, v_last_trade
  FROM trader_stats
  WHERE trader_address = p_trader_address;

  -- If no record exists, trader is definitely rare (new trader)
  IF NOT FOUND THEN
    RETURN true;
  END IF;

  -- Check conditions: < 10 trades OR > 30 days since last trade
  RETURN (v_trade_count < 10) OR (v_last_trade < NOW() - INTERVAL '30 days');
END;
$$ LANGUAGE plpgsql;

-- Function to check if a market is "thin" (for Isolated Contact detection)
-- Returns true if: volume_24h < 5000 OR trade_count_24h < 20
CREATE OR REPLACE FUNCTION is_thin_market(p_market_id TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_volume_24h NUMERIC;
  v_trade_count_24h INT;
BEGIN
  SELECT volume_24h, trade_count_24h
  INTO v_volume_24h, v_trade_count_24h
  FROM markets
  WHERE id = p_market_id;

  -- If no record exists, consider it thin (unknown market)
  IF NOT FOUND THEN
    RETURN true;
  END IF;

  -- Check conditions: volume < $5000 OR trade count < 20
  RETURN (COALESCE(v_volume_24h, 0) < 5000) OR (COALESCE(v_trade_count_24h, 0) < 20);
END;
$$ LANGUAGE plpgsql;

-- Function to check if a trade is "outsized" relative to market (for Isolated Contact detection)
-- Returns true if: trade_size >= 10% of volume_24h OR trade_size >= 5% of liquidity
CREATE OR REPLACE FUNCTION is_outsized_trade(p_market_id TEXT, p_trade_size NUMERIC)
RETURNS BOOLEAN AS $$
DECLARE
  v_volume_24h NUMERIC;
  v_liquidity NUMERIC;
BEGIN
  SELECT volume_24h, liquidity
  INTO v_volume_24h, v_liquidity
  FROM markets
  WHERE id = p_market_id;

  -- If no record exists, can't determine if outsized
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Check conditions: >= 10% of 24h volume OR >= 5% of liquidity
  RETURN (v_volume_24h > 0 AND p_trade_size >= v_volume_24h * 0.10)
      OR (v_liquidity > 0 AND p_trade_size >= v_liquidity * 0.05);
END;
$$ LANGUAGE plpgsql;
