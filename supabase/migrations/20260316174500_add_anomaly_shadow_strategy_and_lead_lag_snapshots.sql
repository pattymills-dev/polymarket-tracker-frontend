-- Add anomaly-follow paper strategy tracking and lead/lag snapshot instrumentation.

CREATE TABLE IF NOT EXISTS anomaly_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  portfolio_id BIGINT REFERENCES paper_portfolios(id) ON DELETE SET NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  traders_scanned INT NOT NULL DEFAULT 0,
  trades_scanned INT NOT NULL DEFAULT 0,
  candidates_considered INT NOT NULL DEFAULT 0,
  positions_opened INT NOT NULL DEFAULT 0,
  positions_closed INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  skip_reasons JSONB,
  notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_anomaly_runs_started_at
  ON anomaly_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS anomaly_trade_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anomaly_run_id UUID REFERENCES anomaly_runs(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('OPENED', 'SKIPPED', 'CLOSED')),
  reason TEXT,
  source_trade_id TEXT,
  source_wallet TEXT,
  source_trade_ts TIMESTAMPTZ,
  market_id TEXT,
  market_slug TEXT,
  market_title TEXT,
  outcome TEXT,
  side TEXT,
  source_price NUMERIC,
  entry_price NUMERIC,
  exit_price NUMERIC,
  usd_size NUMERIC,
  shares NUMERIC,
  signal_score NUMERIC,
  signal_features JSONB,
  ranking_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_trade_decisions_run
  ON anomaly_trade_decisions (anomaly_run_id);

CREATE INDEX IF NOT EXISTS idx_anomaly_trade_decisions_wallet
  ON anomaly_trade_decisions (source_wallet);

CREATE INDEX IF NOT EXISTS idx_anomaly_trade_decisions_market
  ON anomaly_trade_decisions (market_id);

CREATE TABLE IF NOT EXISTS anomaly_state (
  wallet TEXT PRIMARY KEY,
  last_seen_ts TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_lag_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_key TEXT NOT NULL,
  leader_market_id TEXT NOT NULL,
  leader_market_slug TEXT,
  leader_market_title TEXT,
  leader_liquidity NUMERIC,
  leader_mid NUMERIC,
  leader_best_bid NUMERIC,
  leader_best_ask NUMERIC,
  leader_spread_bps NUMERIC,
  follower_market_id TEXT NOT NULL,
  follower_market_slug TEXT,
  follower_market_title TEXT,
  follower_liquidity NUMERIC,
  follower_mid NUMERIC,
  follower_best_bid NUMERIC,
  follower_best_ask NUMERIC,
  follower_spread_bps NUMERIC,
  mid_gap NUMERIC,
  notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_lead_lag_snapshots_captured_at
  ON lead_lag_snapshots (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_lag_snapshots_event_key
  ON lead_lag_snapshots (event_key, captured_at DESC);

-- Fresh evaluation window for the anomaly strategy shadow test.
UPDATE paper_portfolios
SET starting_usd = 500,
    fixed_usd_per_trade = 8,
    max_total_exposure_pct = LEAST(COALESCE(max_total_exposure_pct, 0.6), 0.25),
    market_exposure_cap_pct = LEAST(COALESCE(market_exposure_cap_pct, 0.2), 0.08)
WHERE id = 1;

INSERT INTO paper_strategy_resets (portfolio_id, label, reset_at)
SELECT 1, 'anomaly_shadow_2026_03_16', NOW()
WHERE NOT EXISTS (
  SELECT 1
  FROM paper_strategy_resets
  WHERE label = 'anomaly_shadow_2026_03_16'
);
