-- Hybrid CLI Rankings: use CLI ground-truth P/L as primary data source
-- Saves Supabase resources by eliminating trades table scans for all-time rankings

-- 1. Add aggregate columns to CLI snapshots
ALTER TABLE trader_portfolio_snapshots
  ADD COLUMN IF NOT EXISTS open_value_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS cli_wins INT,
  ADD COLUMN IF NOT EXISTS cli_losses INT,
  ADD COLUMN IF NOT EXISTS cli_win_rate NUMERIC;

COMMENT ON COLUMN trader_portfolio_snapshots.open_value_usd IS
  'Total current value of open positions from CLI';
COMMENT ON COLUMN trader_portfolio_snapshots.cli_wins IS
  'Count of profitable closed positions from CLI';
COMMENT ON COLUMN trader_portfolio_snapshots.cli_losses IS
  'Count of unprofitable closed positions from CLI';
COMMENT ON COLUMN trader_portfolio_snapshots.cli_win_rate IS
  'Win rate computed from CLI closed positions';

-- 2. View: latest snapshot per trader (for use by refresh functions)
CREATE OR REPLACE VIEW latest_cli_trader_stats AS
SELECT DISTINCT ON (trader_address)
  trader_address,
  closed_pnl_usd,
  cli_wins,
  cli_losses,
  cli_win_rate,
  open_positions_count,
  open_value_usd,
  closed_positions_count,
  our_computed_pl,
  pl_delta,
  snapshot_at
FROM trader_portfolio_snapshots
ORDER BY trader_address, snapshot_at DESC;

COMMENT ON VIEW latest_cli_trader_stats IS
  'Most recent CLI snapshot per trader for hybrid ranking approach';

-- 3. Retention: keep only the 5 most recent snapshots per trader
--    Saves ~80% storage as snapshot count grows
CREATE OR REPLACE FUNCTION cleanup_old_cli_snapshots()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM trader_portfolio_snapshots
  WHERE id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY trader_address ORDER BY snapshot_at DESC
      ) AS rn
      FROM trader_portfolio_snapshots
    ) ranked
    WHERE rn <= 5
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_cli_snapshots IS
  'Retain only 5 most recent snapshots per trader. Returns count of deleted rows.';

-- 4. Null out old raw JSON to reclaim storage (positions data now computed as aggregates)
UPDATE trader_portfolio_snapshots SET open_positions_json = NULL;

-- 5. Index for the view's DISTINCT ON query
CREATE INDEX IF NOT EXISTS idx_tps_trader_snapshot
  ON trader_portfolio_snapshots(trader_address, snapshot_at DESC);
