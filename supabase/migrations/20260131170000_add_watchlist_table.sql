-- Create watchlist table for user-tracked traders
CREATE TABLE IF NOT EXISTS watchlist (
  id SERIAL PRIMARY KEY,
  trader_address TEXT NOT NULL UNIQUE,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes TEXT
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_watchlist_trader ON watchlist(trader_address);

-- Enable RLS but allow all operations for now (single user app)
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

-- Allow all operations (adjust if you add auth later)
CREATE POLICY "Allow all watchlist operations" ON watchlist
  FOR ALL USING (true) WITH CHECK (true);
