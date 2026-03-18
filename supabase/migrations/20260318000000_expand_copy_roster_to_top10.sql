-- Expand copy trading roster from top 3 to top 10
-- Auto-enable top P/L traders with quality gates
--
-- Criteria (same as before, but top 10 instead of top 3):
-- - Top P/L
-- - ROI >= 20%
-- - Resolved trades >= 25
-- - Confidence >= 2
-- - Recent activity (last 7 days)
-- - copyable_rank_30d <= 25

BEGIN;

-- First, disable all traders to start fresh
UPDATE copy_traders SET enabled = false;

-- Re-enable top 10 traders that meet criteria
WITH eligible_traders AS (
  SELECT
    tr.trader_address,
    tr.realized_pl_30d,
    tr.realized_roi_30d,
    tr.resolved_trades_30d,
    tr.confidence_30d,
    tr.copyable_rank_30d,
    tr.computed_at,
    COALESCE(
      (
        SELECT MAX(t.timestamp)
        FROM trades t
        WHERE t.wallet_address = tr.trader_address
      ),
      '1970-01-01'::timestamptz
    ) as last_trade_at,
    ROW_NUMBER() OVER (ORDER BY tr.realized_pl_30d DESC) as pl_rank
  FROM trader_rankings tr
  WHERE tr.realized_roi_30d >= 0.20           -- 20% ROI floor
    AND tr.resolved_trades_30d >= 25          -- Min sample size
    AND tr.confidence_30d >= 2                -- Min confidence
    AND tr.copyable_rank_30d <= 25            -- Must be in top 25
    AND tr.computed_at > NOW() - INTERVAL '48 hours'  -- Fresh rankings
),
recently_active AS (
  SELECT
    et.*
  FROM eligible_traders et
  WHERE et.last_trade_at > NOW() - INTERVAL '7 days'  -- Active in last week
    AND et.pl_rank <= 10                               -- Top 10 only
),
top10 AS (
  SELECT trader_address FROM recently_active
  ORDER BY realized_pl_30d DESC
  LIMIT 10
)
UPDATE copy_traders
SET enabled = true
WHERE trader_address IN (SELECT trader_address FROM top10);

-- Insert any missing traders from top 10 with default config
INSERT INTO copy_traders (
  trader_address,
  enabled,
  copy_factor,
  min_usd,
  max_usd,
  max_trader_exposure_pct,
  per_trader_cooldown_minutes,
  min_price,
  max_price,
  price_penalty,
  allow_sells,
  cooldown_minutes,
  max_copyable_rank_30d,
  min_realized_roi_30d,
  min_realized_pl_30d,
  min_median_bet_30d,
  min_resolved_trades_30d,
  min_confidence_30d,
  max_open_positions,
  previous_rank_30d
)
SELECT
  tr.trader_address,
  true as enabled,
  0.1 as copy_factor,
  10 as min_usd,
  500 as max_usd,
  0.25 as max_trader_exposure_pct,
  5 as per_trader_cooldown_minutes,
  0.30 as min_price,        -- Lowered from 0.45
  0.85 as max_price,        -- Raised from 0.80
  0.01 as price_penalty,
  false as allow_sells,
  1 as cooldown_minutes,
  25 as max_copyable_rank_30d,
  0.20 as min_realized_roi_30d,
  200 as min_realized_pl_30d,
  25 as min_median_bet_30d,
  25 as min_resolved_trades_30d,
  2.0 as min_confidence_30d,
  8 as max_open_positions,
  tr.copyable_rank_30d as previous_rank_30d
FROM (
  SELECT
    tr2.trader_address,
    tr2.copyable_rank_30d,
    ROW_NUMBER() OVER (ORDER BY tr2.realized_pl_30d DESC) as pl_rank
  FROM trader_rankings tr2
  WHERE tr2.realized_roi_30d >= 0.20
    AND tr2.resolved_trades_30d >= 25
    AND tr2.confidence_30d >= 2
    AND tr2.copyable_rank_30d <= 25
    AND tr2.computed_at > NOW() - INTERVAL '48 hours'
    AND EXISTS (
      SELECT 1 FROM trades t
      WHERE t.wallet_address = tr2.trader_address
        AND t.timestamp > NOW() - INTERVAL '7 days'
    )
) tr
WHERE tr.pl_rank <= 10
  AND NOT EXISTS (
    SELECT 1 FROM copy_traders ct
    WHERE ct.trader_address = tr.trader_address
  );

COMMIT;

-- Report the active roster
SELECT
  ct.trader_address,
  tr.realized_pl_30d,
  tr.realized_roi_30d,
  tr.resolved_trades_30d,
  tr.copyable_rank_30d,
  ct.enabled
FROM copy_traders ct
LEFT JOIN trader_rankings tr ON tr.trader_address = ct.trader_address
WHERE ct.enabled = true
ORDER BY tr.realized_pl_30d DESC NULLS LAST;
