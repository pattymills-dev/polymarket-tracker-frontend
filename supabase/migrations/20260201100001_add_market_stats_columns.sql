-- Add volume and liquidity columns to markets table for Isolated Contact detection
-- These will be refreshed periodically from Polymarket Gamma API

ALTER TABLE markets
ADD COLUMN IF NOT EXISTS volume_24h NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS liquidity NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS trade_count_24h INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ;

-- Index for finding thin markets
CREATE INDEX IF NOT EXISTS idx_markets_volume_24h ON markets(volume_24h);
CREATE INDEX IF NOT EXISTS idx_markets_liquidity ON markets(liquidity);

COMMENT ON COLUMN markets.volume_24h IS '24-hour trading volume from Polymarket API';
COMMENT ON COLUMN markets.liquidity IS 'Current market liquidity from Polymarket API';
COMMENT ON COLUMN markets.trade_count_24h IS 'Number of trades in last 24 hours';
COMMENT ON COLUMN markets.stats_updated_at IS 'When market stats were last refreshed from API';
