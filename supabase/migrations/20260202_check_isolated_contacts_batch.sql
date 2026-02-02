-- Batch function to check multiple trades for Isolated Contact status
-- This replaces 3 separate RPC calls per trade with a single batch call

CREATE OR REPLACE FUNCTION check_isolated_contacts_batch(
  p_candidates JSONB
)
RETURNS TABLE (
  trader_address TEXT,
  market_id TEXT,
  is_isolated BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  candidate JSONB;
  v_trader TEXT;
  v_market TEXT;
  v_trade_size NUMERIC;
  v_is_rare BOOLEAN;
  v_is_thin BOOLEAN;
  v_is_outsized BOOLEAN;
  v_trader_count INT;
  v_market_count INT;
  v_avg_trade_size NUMERIC;
BEGIN
  FOR candidate IN SELECT * FROM jsonb_array_elements(p_candidates)
  LOOP
    v_trader := candidate->>'trader_address';
    v_market := candidate->>'market_id';
    v_trade_size := (candidate->>'trade_size')::NUMERIC;

    -- Check if rare trader (< 5 trades in last 30 days)
    SELECT COUNT(*) INTO v_trader_count
    FROM trades
    WHERE trader_address = v_trader
      AND timestamp > NOW() - INTERVAL '30 days';

    v_is_rare := v_trader_count < 5;

    -- Only continue if trader is rare
    IF NOT v_is_rare THEN
      trader_address := v_trader;
      market_id := v_market;
      is_isolated := FALSE;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Check if thin market (< 10 trades in last 24h)
    SELECT COUNT(*) INTO v_market_count
    FROM trades
    WHERE market_id = v_market
      AND timestamp > NOW() - INTERVAL '24 hours';

    v_is_thin := v_market_count < 10;

    -- Only continue if market is thin
    IF NOT v_is_thin THEN
      trader_address := v_trader;
      market_id := v_market;
      is_isolated := FALSE;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Check if outsized trade (> 2x avg trade size for that market)
    SELECT COALESCE(AVG(amount), 0) INTO v_avg_trade_size
    FROM trades
    WHERE market_id = v_market
      AND timestamp > NOW() - INTERVAL '7 days';

    v_is_outsized := v_avg_trade_size > 0 AND v_trade_size > (v_avg_trade_size * 2);

    -- Return result
    trader_address := v_trader;
    market_id := v_market;
    is_isolated := v_is_rare AND v_is_thin AND v_is_outsized;
    RETURN NEXT;
  END LOOP;
END;
$$;
