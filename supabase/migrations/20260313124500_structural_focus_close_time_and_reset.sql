-- Structural focus rollout:
-- 1) Persist market close times from Gamma for time-to-resolution filtering.
-- 2) Re-anchor the paper benchmark to a clean $500 structural-only baseline.

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS close_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_markets_close_time
  ON markets (close_time);

COMMENT ON COLUMN markets.close_time IS 'Expected market close/resolution time from Polymarket Gamma metadata';

UPDATE paper_portfolios
SET starting_usd = 500,
    fixed_usd_per_trade = LEAST(COALESCE(fixed_usd_per_trade, 10), 10),
    max_total_exposure_pct = LEAST(COALESCE(max_total_exposure_pct, 0.35), 0.35),
    market_exposure_cap_pct = LEAST(COALESCE(market_exposure_cap_pct, 0.12), 0.12),
    updated_at = NOW();

INSERT INTO paper_strategy_resets (portfolio_id, label, reset_at, notes)
SELECT
  p.id,
  'structural_focus_2026_03_13',
  NOW(),
  'Structural-only benchmark reset to $500 with close-time, liquidity, and buffered-entry execution gates.'
FROM paper_portfolios p
WHERE NOT EXISTS (
  SELECT 1
  FROM paper_strategy_resets r
  WHERE r.portfolio_id = p.id
    AND r.label = 'structural_focus_2026_03_13'
);
