-- Polymarket CLI integration tables
-- Store ground-truth portfolio data from the CLI for cross-referencing our computed rankings

-- 1. Trader portfolio snapshots: CLI P/L vs our computed P/L
CREATE TABLE IF NOT EXISTS trader_portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  trader_address TEXT NOT NULL,

  -- From polymarket data value
  portfolio_value_usd NUMERIC,

  -- From polymarket data positions
  open_positions_count INT,
  open_positions_json JSONB,

  -- From polymarket data closed-positions
  closed_positions_count INT,
  closed_pnl_usd NUMERIC,

  -- Delta: CLI ground truth vs our computed value
  our_computed_pl NUMERIC,
  pl_delta NUMERIC,           -- CLI P/L - our P/L (positive = we're undercounting)

  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tps_trader ON trader_portfolio_snapshots(trader_address);
CREATE INDEX IF NOT EXISTS idx_tps_snapshot_at ON trader_portfolio_snapshots(snapshot_at DESC);

COMMENT ON TABLE trader_portfolio_snapshots IS
  'Ground-truth portfolio data from Polymarket CLI, compared against our computed rankings';
COMMENT ON COLUMN trader_portfolio_snapshots.pl_delta IS
  'CLI P/L minus our computed P/L. Positive means we are undercounting their profits.';

-- 2. Polymarket leaderboard snapshots: official rankings for trader discovery
CREATE TABLE IF NOT EXISTS polymarket_leaderboard_snapshots (
  id BIGSERIAL PRIMARY KEY,
  trader_address TEXT NOT NULL,
  leaderboard_rank INT,
  leaderboard_pnl NUMERIC,
  leaderboard_volume NUMERIC,
  period TEXT NOT NULL DEFAULT 'month',
  in_our_rankings BOOLEAN,    -- do we already track this trader?
  our_rank INT,               -- their rank in our system (null if not tracked)
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pls_snapshot ON polymarket_leaderboard_snapshots(snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_pls_trader ON polymarket_leaderboard_snapshots(trader_address);

COMMENT ON TABLE polymarket_leaderboard_snapshots IS
  'Official Polymarket leaderboard data for discovering traders we might be missing';
