-- RPC function to get trade counts per market in the last 24 hours
-- Used by refresh-market-stats to populate trade_count_24h

CREATE OR REPLACE FUNCTION get_market_trade_counts_24h(since_timestamp TIMESTAMPTZ)
RETURNS TABLE (
  market_id TEXT,
  trade_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.market_id,
    COUNT(*)::BIGINT as trade_count
  FROM trades t
  WHERE t.timestamp >= since_timestamp
    AND t.market_id IS NOT NULL
  GROUP BY t.market_id;
END;
$$ LANGUAGE plpgsql;
