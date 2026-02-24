-- Add category and tags columns to watchlist for anomaly classification
-- Categories: 'manual' (user-added), 'tail_risk', 'isolated_contact', 'dormant_whale', 'event_specialist'
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'manual';
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Index for filtering by category
CREATE INDEX IF NOT EXISTS idx_watchlist_category ON watchlist(category);
