-- Store fee/latency-adjusted executable quotes for paper trading marks.

ALTER TABLE market_quotes
  ADD COLUMN IF NOT EXISTS fee_bps NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS latency_bps NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS bid_after_costs NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS ask_with_costs NUMERIC(10, 6);

DROP VIEW IF EXISTS paper_portfolio_pnl_summary;
DROP VIEW IF EXISTS paper_positions_with_price;

CREATE VIEW paper_positions_with_price AS
SELECT
  p.*,
  COALESCE(mq.bid_after_costs, mq.best_bid, mp.price) AS current_price,
  COALESCE(mq.quote_ts, mq.updated_at, mp.updated_at) AS price_ts,
  mq.best_bid,
  mq.best_ask,
  mq.bid_after_costs,
  mq.ask_with_costs,
  mq.midpoint,
  mq.token_id AS quote_token_id
FROM paper_positions p
LEFT JOIN market_quotes mq
  ON mq.market_id = p.market_id
  AND mq.outcome = p.outcome
LEFT JOIN market_prices mp
  ON mp.market_id = p.market_id
  AND mp.outcome = p.outcome;

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
