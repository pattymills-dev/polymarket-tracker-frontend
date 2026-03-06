-- Phase 1 profitability lockdown:
-- - tighten copy quality thresholds
-- - enforce non-pinned trader cooldown defaults
-- - keep fixed paper stake at $10 while we stabilize edge

ALTER TABLE copy_traders
  ALTER COLUMN per_trader_cooldown_minutes SET DEFAULT 240;

ALTER TABLE copy_traders
  ALTER COLUMN max_copyable_rank_30d SET DEFAULT 15;

ALTER TABLE copy_traders
  ALTER COLUMN min_resolved_trades_30d SET DEFAULT 40;

ALTER TABLE copy_traders
  ALTER COLUMN min_confidence_30d SET DEFAULT 0.60;

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
      max_open_positions,
      max_copyable_rank_30d,
      min_resolved_trades_30d,
      min_confidence_30d,
      updated_at
    )
    SELECT
      trader_address,
      true,
      false,
      0.45,
      0.80,
      0.01,
      240,
      0.10,
      3,
      20,
      0.25,
      2,
      15,
      40,
      0.60,
      NOW()
    FROM top_copyable
    ON CONFLICT (wallet) DO UPDATE SET
      enabled = true,
      allow_sells = false,
      min_price = 0.45,
      max_price = 0.80,
      price_penalty = 0.01,
      per_trader_cooldown_minutes = 240,
      copy_factor = 0.10,
      min_usd = 3,
      max_usd = 20,
      max_trader_exposure_pct = 0.25,
      max_open_positions = 2,
      max_copyable_rank_30d = 15,
      min_resolved_trades_30d = 40,
      min_confidence_30d = 0.60,
      updated_at = NOW()
    WHERE copy_traders.pinned = false
    RETURNING wallet
  )
  SELECT COUNT(*) INTO v_upserts FROM upserted;

  RETURN v_upserts;
END;
$$ LANGUAGE plpgsql;

-- Align existing non-pinned traders with stricter controls.
UPDATE copy_traders
SET min_price = GREATEST(COALESCE(min_price, 0.45), 0.45),
    max_price = LEAST(COALESCE(max_price, 0.80), 0.80),
    per_trader_cooldown_minutes = CASE
      WHEN COALESCE(per_trader_cooldown_minutes, 0) <= 0 THEN 240
      ELSE per_trader_cooldown_minutes
    END,
    max_open_positions = LEAST(COALESCE(max_open_positions, 2), 2),
    max_copyable_rank_30d = LEAST(COALESCE(max_copyable_rank_30d, 15), 15),
    min_resolved_trades_30d = GREATEST(COALESCE(min_resolved_trades_30d, 40), 40),
    min_confidence_30d = GREATEST(COALESCE(min_confidence_30d, 0.60), 0.60),
    updated_at = NOW()
WHERE pinned = false;

-- Keep fixed paper size in defensive mode while edge is revalidated.
UPDATE paper_portfolios
SET fixed_usd_per_trade = LEAST(COALESCE(fixed_usd_per_trade, 10), 10),
    updated_at = NOW();

