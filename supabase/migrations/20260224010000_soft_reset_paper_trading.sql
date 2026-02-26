-- Soft reset paper trading for strategy v2 (80¢ max, 3 positions, pinned traders).
-- Preserves all historical positions as epoch 1, new trades start as epoch 2.

-- 1. Add epoch column to paper_positions
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS epoch INT NOT NULL DEFAULT 2;

COMMENT ON COLUMN paper_positions.epoch IS
  'Strategy epoch. 1 = original (95¢ max, 5 pos), 2 = tuned (80¢ max, 3 pos, pinned)';

-- 2. Mark all existing positions as epoch 1
UPDATE paper_positions SET epoch = 1;

-- 3. Cancel all currently OPEN positions (entered under old rules)
UPDATE paper_positions
SET status = 'CANCELED'
WHERE status = 'OPEN';

-- 4. Recreate paper_positions_with_price so it includes the new epoch column
--    Must DROP first because column order changed (epoch added to paper_positions)
DROP VIEW IF EXISTS paper_portfolio_pnl_summary;
DROP VIEW IF EXISTS paper_positions_with_price;

CREATE VIEW paper_positions_with_price AS
SELECT
  p.*,
  mp.price AS current_price,
  mp.updated_at AS price_ts
FROM paper_positions p
LEFT JOIN market_prices mp
  ON mp.market_id = p.market_id
  AND mp.outcome = p.outcome;

-- 5. Rebuild the P/L summary view to only count current epoch
CREATE VIEW paper_portfolio_pnl_summary AS
WITH current_epoch AS (
  SELECT MAX(epoch) AS epoch FROM paper_positions
),
realized AS (
  SELECT
    pp.portfolio_id,
    COUNT(*) FILTER (WHERE pp.status <> 'CANCELED')::INT AS total_positions,
    COALESCE(SUM(pp.usd_size) FILTER (WHERE pp.status <> 'CANCELED'), 0)::NUMERIC AS total_paper_staked,
    COALESCE(SUM(pp.usd_size) FILTER (WHERE pp.status = 'OPEN'), 0)::NUMERIC AS open_exposure,
    COALESCE(SUM(pp.pnl_usd) FILTER (WHERE pp.status = 'SETTLED'), 0)::NUMERIC AS realized_pnl
  FROM paper_positions pp
  CROSS JOIN current_epoch ce
  WHERE pp.epoch = ce.epoch
  GROUP BY pp.portfolio_id
),
unrealized AS (
  SELECT
    pw.portfolio_id,
    COALESCE(SUM(
      CASE
        WHEN pw.status = 'OPEN' AND pw.current_price IS NOT NULL
        THEN pw.shares * pw.current_price - pw.usd_size
        ELSE 0
      END
    ), 0)::NUMERIC AS projected_unrealized_pnl,
    COUNT(*) FILTER (WHERE pw.status = 'OPEN' AND pw.current_price IS NULL)::INT AS open_missing_price
  FROM paper_positions_with_price pw
  CROSS JOIN current_epoch ce
  WHERE pw.epoch = ce.epoch
  GROUP BY pw.portfolio_id
)
SELECT
  p.id AS portfolio_id,
  p.starting_usd,
  p.fixed_usd_per_trade,
  COALESCE(r.total_positions, 0) AS total_positions,
  COALESCE(r.total_paper_staked, 0) AS total_paper_staked,
  COALESCE(r.open_exposure, 0) AS open_exposure,
  COALESCE(r.realized_pnl, 0) AS realized_pnl,
  COALESCE(u.projected_unrealized_pnl, 0) AS projected_unrealized_pnl,
  (COALESCE(r.realized_pnl, 0) + COALESCE(u.projected_unrealized_pnl, 0)) AS projected_total_pnl,
  COALESCE(u.open_missing_price, 0) AS open_missing_price
FROM paper_portfolios p
LEFT JOIN realized r ON r.portfolio_id = p.id
LEFT JOIN unrealized u ON u.portfolio_id = p.id;

-- 6. Reset starting_usd to $500 (clean baseline)
UPDATE paper_portfolios SET starting_usd = 500;

-- Verify
DO $$
DECLARE
  v_canceled INT;
  v_epoch1 INT;
BEGIN
  SELECT COUNT(*) INTO v_canceled FROM paper_positions WHERE status = 'CANCELED' AND epoch = 1;
  SELECT COUNT(*) INTO v_epoch1 FROM paper_positions WHERE epoch = 1;
  RAISE NOTICE 'Epoch 1 positions: % (% canceled by reset)', v_epoch1, v_canceled;
END $$;
