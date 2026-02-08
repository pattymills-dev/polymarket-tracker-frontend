-- Update isolated contact batch detection to use market stats + min size.

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
BEGIN
  FOR candidate IN SELECT * FROM jsonb_array_elements(p_candidates)
  LOOP
    v_trader := candidate->>'trader_address';
    v_market := candidate->>'market_id';
    v_trade_size := (candidate->>'trade_size')::NUMERIC;

    -- Rare trader: < 5 trades in last 30 days
    SELECT COUNT(*) INTO v_trader_count
    FROM trades
    WHERE trader_address = v_trader
      AND timestamp > NOW() - INTERVAL '30 days';

    v_is_rare := v_trader_count < 5;

    IF NOT v_is_rare THEN
      trader_address := v_trader;
      market_id := v_market;
      is_isolated := FALSE;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Thin market (uses market stats)
    v_is_thin := is_thin_market(v_market);

    IF NOT v_is_thin THEN
      trader_address := v_trader;
      market_id := v_market;
      is_isolated := FALSE;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Outsized trade relative to volume/liquidity with a hard size floor
    v_is_outsized := v_trade_size >= 10000 AND is_outsized_trade(v_market, v_trade_size);

    trader_address := v_trader;
    market_id := v_market;
    is_isolated := v_is_rare AND v_is_thin AND v_is_outsized;
    RETURN NEXT;
  END LOOP;
END;
$$;
