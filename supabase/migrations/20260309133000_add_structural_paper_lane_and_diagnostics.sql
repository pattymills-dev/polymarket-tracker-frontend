-- Phase 2: structural paper-trading lane + diagnostics for profitability iteration.

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS strategy_lane TEXT NOT NULL DEFAULT 'copy';

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS strategy_tag TEXT;

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS execution_type TEXT;

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS edge_bps NUMERIC;

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS structural_group_id TEXT;

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS exit_reason TEXT;

UPDATE paper_positions
SET strategy_lane = 'copy'
WHERE strategy_lane IS NULL;

CREATE INDEX IF NOT EXISTS idx_paper_positions_strategy_lane
  ON paper_positions (strategy_lane);

CREATE INDEX IF NOT EXISTS idx_paper_positions_structural_group
  ON paper_positions (structural_group_id);

CREATE INDEX IF NOT EXISTS idx_paper_positions_lane_status_entry
  ON paper_positions (strategy_lane, status, entry_ts DESC);

CREATE TABLE IF NOT EXISTS structural_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  portfolio_id BIGINT REFERENCES paper_portfolios(id) ON DELETE SET NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  markets_scanned INT NOT NULL DEFAULT 0,
  opportunities_found INT NOT NULL DEFAULT 0,
  groups_opened INT NOT NULL DEFAULT 0,
  legs_opened INT NOT NULL DEFAULT 0,
  groups_closed INT NOT NULL DEFAULT 0,
  legs_closed INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  skip_reasons JSONB,
  notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_structural_runs_started_at
  ON structural_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS paper_strategy_diagnostics (
  id BIGSERIAL PRIMARY KEY,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id BIGINT REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'since_reset',
  strategy_lane TEXT NOT NULL,
  positions_total INT NOT NULL DEFAULT 0,
  open_positions INT NOT NULL DEFAULT 0,
  settled_positions INT NOT NULL DEFAULT 0,
  exit_before_resolution_pct NUMERIC,
  median_hold_minutes NUMERIC,
  limit_order_pct NUMERIC,
  size_edge_correlation NUMERIC,
  realized_pnl NUMERIC NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC NOT NULL DEFAULT 0,
  projected_pnl NUMERIC NOT NULL DEFAULT 0,
  profit_source TEXT,
  notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_paper_strategy_diagnostics_computed
  ON paper_strategy_diagnostics (computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_strategy_diagnostics_lane
  ON paper_strategy_diagnostics (strategy_lane, computed_at DESC);

