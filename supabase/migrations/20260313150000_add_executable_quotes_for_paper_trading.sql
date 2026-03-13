-- Add executable quote storage for paper trading and expose bid-side marks in views.

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS outcome_token_map JSONB;

COMMENT ON COLUMN markets.outcome_token_map IS
  'JSON object mapping outcome label to CLOB token_id for executable quote lookups';

CREATE TABLE IF NOT EXISTS market_quotes (
  market_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  token_id TEXT,
  best_bid NUMERIC(10, 6),
  best_ask NUMERIC(10, 6),
  bid_depth NUMERIC(18, 6),
  ask_depth NUMERIC(18, 6),
  midpoint NUMERIC(10, 6),
  last_trade_price NUMERIC(10, 6),
  tick_size NUMERIC(10, 6),
  min_order_size NUMERIC(18, 6),
  neg_risk BOOLEAN,
  quote_ts TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (market_id, outcome)
);

CREATE INDEX IF NOT EXISTS idx_market_quotes_market
  ON market_quotes (market_id);

DROP VIEW IF EXISTS paper_portfolio_pnl_summary;
DROP VIEW IF EXISTS paper_positions_with_price;

CREATE VIEW paper_positions_with_price AS
SELECT
  p.*,
  COALESCE(mq.best_bid, mp.price) AS current_price,
  COALESCE(mq.quote_ts, mq.updated_at, mp.updated_at) AS price_ts,
  mq.best_bid,
  mq.best_ask,
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
