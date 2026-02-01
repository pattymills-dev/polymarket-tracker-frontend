-- Add columns to alerts for bet details and Polymarket link
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS side TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS market_slug TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS price NUMERIC;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_alerts_market_slug ON alerts(market_slug);
