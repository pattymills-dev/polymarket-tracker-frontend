-- Profitability tuning + clean paper budget refresh.
-- 1) Enforce higher minimum entry price for non-pinned copy traders.
-- 2) Keep sync_top_copyable_traders defaults aligned with runtime strategy.
-- 3) Reset effective paper equity baseline to $500 and cancel open positions.

-- Align table default with runtime min price filter.
ALTER TABLE copy_traders
  ALTER COLUMN min_price SET DEFAULT 0.45;

-- Rebuild sync function with min_price = 0.45 (was 0.05) for non-pinned traders.
CREATE OR REPLACE FUNCTION sync_top_copyable_traders(
  p_limit INT DEFAULT 10
)
RETURNS INT AS $$
DECLARE
  v_upserts INT := 0;
  v_disabled INT := 0;
BEGIN
  -- Disable non-top traders, but keep pinned traders untouched.
  WITH top_copyable AS (
    SELECT trader_address
    FROM copyable_traders
    WHERE rank IS NOT NULL
    ORDER BY rank ASC
    LIMIT p_limit
  )
  UPDATE copy_traders ct
  SET enabled = false,
      updated_at = NOW()
  WHERE ct.enabled = true
    AND ct.pinned = false
    AND NOT EXISTS (
      SELECT 1 FROM top_copyable t
      WHERE t.trader_address = ct.wallet
    );

  GET DIAGNOSTICS v_disabled = ROW_COUNT;

  IF v_disabled > 0 THEN
    RAISE NOTICE 'Disabled % traders who fell out of top %', v_disabled, p_limit;
  END IF;

  -- Enable/upsert current top traders.
  -- Do not overwrite custom pinned trader configs.
  WITH top_copyable AS (
    SELECT trader_address
    FROM copyable_traders
    WHERE rank IS NOT NULL
    ORDER BY rank ASC
    LIMIT p_limit
  ),
  upserted AS (
    INSERT INTO copy_traders (
      wallet,
      enabled,
      allow_sells,
      min_price,
      max_price,
      price_penalty,
      per_trader_cooldown_minutes,
      copy_factor,
      min_usd,
      max_usd,
      max_trader_exposure_pct,
      updated_at
    )
    SELECT
      trader_address,
      true,
      false,
      0.45,
      0.80,
      0.01,
      0,
      0.10,
      3,
      20,
      0.25,
      NOW()
    FROM top_copyable
    ON CONFLICT (wallet) DO UPDATE SET
      enabled = true,
      allow_sells = false,
      min_price = 0.45,
      max_price = 0.80,
      price_penalty = 0.01,
      per_trader_cooldown_minutes = 0,
      copy_factor = 0.10,
      min_usd = 3,
      max_usd = 20,
      max_trader_exposure_pct = 0.25,
      updated_at = NOW()
    WHERE copy_traders.pinned = false
    RETURNING wallet
  )
  SELECT COUNT(*) INTO v_upserts FROM upserted;

  RETURN v_upserts;
END;
$$ LANGUAGE plpgsql;

-- Bring non-pinned trader configs in line immediately.
UPDATE copy_traders
SET min_price = GREATEST(COALESCE(min_price, 0.45), 0.45),
    updated_at = NOW()
WHERE pinned = false;

-- Refresh effective paper bankroll to $500 baseline.
-- We offset historical settled P/L into starting_usd so current equity resets to $500.
WITH realized AS (
  SELECT
    p.id AS portfolio_id,
    COALESCE(
      SUM(pp.pnl_usd) FILTER (WHERE pp.status = 'SETTLED'),
      0
    )::NUMERIC AS realized_pnl
  FROM paper_portfolios p
  LEFT JOIN paper_positions pp
    ON pp.portfolio_id = p.id
  GROUP BY p.id
)
UPDATE paper_portfolios p
SET starting_usd = 500 - r.realized_pnl,
    updated_at = NOW()
FROM realized r
WHERE p.id = r.portfolio_id;

-- Cancel open positions to start the next test window cleanly.
UPDATE paper_positions
SET status = 'CANCELED',
    exit_ts = COALESCE(exit_ts, NOW()),
    updated_at = NOW()
WHERE status = 'OPEN';

