-- Add pinned flag to copy_traders so manual selections survive auto-rotation.
-- Also lower default max_price from 0.95 → 0.80 in the sync function.

-- 1. Add pinned column (default false so existing traders are unaffected)
ALTER TABLE copy_traders
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN copy_traders.pinned IS
  'When true, sync_top_copyable_traders will not auto-disable this trader';

-- 2. Rebuild sync function to respect pinned flag and use lower max_price
CREATE OR REPLACE FUNCTION sync_top_copyable_traders(
  p_limit INT DEFAULT 10
)
RETURNS INT AS $$
DECLARE
  v_upserts INT := 0;
  v_disabled INT := 0;
BEGIN
  -- Disable non-top traders, but SKIP pinned ones
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
    AND ct.pinned = false          -- NEW: never auto-disable pinned traders
    AND NOT EXISTS (
      SELECT 1 FROM top_copyable t
      WHERE t.trader_address = ct.wallet
    );

  GET DIAGNOSTICS v_disabled = ROW_COUNT;

  IF v_disabled > 0 THEN
    RAISE NOTICE 'Disabled % traders who fell out of top %', v_disabled, p_limit;
  END IF;

  -- Enable/upsert the top traders (skip if already pinned with custom config)
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
      0.05,
      0.80,       -- was 0.95, lowered to match strategy
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
      min_price = 0.05,
      max_price = 0.80,   -- was 0.95
      price_penalty = 0.01,
      per_trader_cooldown_minutes = 0,
      copy_factor = 0.10,
      min_usd = 3,
      max_usd = 20,
      max_trader_exposure_pct = 0.25,
      updated_at = NOW()
    WHERE copy_traders.pinned = false  -- don't overwrite pinned trader config
    RETURNING wallet
  )
  SELECT COUNT(*) INTO v_upserts FROM upserted;

  RETURN v_upserts;
END;
$$ LANGUAGE plpgsql;

-- 3. Pin the three best paper performers and enable them
UPDATE copy_traders
SET pinned = true,
    enabled = true,
    max_price = 0.80,
    max_open_positions = 3,
    updated_at = NOW()
WHERE wallet IN (
  '0xdc876e6873772d38716fda7f2452a78d426d7ab6',  -- 11-0, +$87
  '0x83d22814af497297b3023897a6e3a25cfcf7d196',  -- 7-0, +$64
  '0x7af9bac9328c7cec1f9d07786e59576b608db408'   -- 6-1, +$36
);

-- 4. Disable the 0-12 loser
UPDATE copy_traders
SET enabled = false,
    pinned = true,          -- pin as disabled so cron doesn't re-enable
    updated_at = NOW()
WHERE wallet = '0x9cb990f1862568a63d8601efeebe0304225c32f2';  -- 0-12, -$120

-- 5. Update all other enabled (non-pinned) traders to new max_price and position cap
UPDATE copy_traders
SET max_price = 0.80,
    max_open_positions = 3,
    updated_at = NOW()
WHERE enabled = true
  AND pinned = false;

-- 6. Run the sync once with new logic
SELECT sync_top_copyable_traders(10);

-- Verify
DO $$
DECLARE
  v_enabled INT;
  v_pinned INT;
BEGIN
  SELECT COUNT(*) INTO v_enabled FROM copy_traders WHERE enabled = true;
  SELECT COUNT(*) INTO v_pinned FROM copy_traders WHERE pinned = true;
  RAISE NOTICE 'Enabled: %, Pinned: %', v_enabled, v_pinned;
END $$;
