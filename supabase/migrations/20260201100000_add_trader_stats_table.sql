-- Create trader_stats table for fast lookups of trader activity
-- Used for Isolated Contact detection (rare trader identification)

CREATE TABLE IF NOT EXISTS trader_stats (
  trader_address TEXT PRIMARY KEY,
  lifetime_trade_count INT DEFAULT 0,
  last_trade_at TIMESTAMPTZ,
  total_volume NUMERIC DEFAULT 0,
  first_trade_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for finding rare/inactive traders
CREATE INDEX IF NOT EXISTS idx_trader_stats_last_trade ON trader_stats(last_trade_at);
CREATE INDEX IF NOT EXISTS idx_trader_stats_trade_count ON trader_stats(lifetime_trade_count);

-- Function to update trader stats on trade insert
-- This will be called from the Edge Function, not a trigger (for better control)

COMMENT ON TABLE trader_stats IS 'Aggregated trader statistics for fast lookups. Updated by fetch-trades function.';
COMMENT ON COLUMN trader_stats.lifetime_trade_count IS 'Total number of trades by this trader (trades >= $5k)';
COMMENT ON COLUMN trader_stats.last_trade_at IS 'Timestamp of most recent trade';
COMMENT ON COLUMN trader_stats.total_volume IS 'Total USD volume traded';
