-- Add columns to track trader ranking at entry time for post-analysis
-- This helps correlate rank decay with losses

-- Add rank tracking columns to paper_positions
ALTER TABLE paper_positions
ADD COLUMN IF NOT EXISTS rank_at_entry INTEGER,
ADD COLUMN IF NOT EXISTS roi_at_entry NUMERIC,
ADD COLUMN IF NOT EXISTS pl_at_entry NUMERIC;

-- Add index for analyzing by rank at entry
CREATE INDEX IF NOT EXISTS idx_paper_positions_rank_at_entry
ON paper_positions(rank_at_entry)
WHERE rank_at_entry IS NOT NULL;

-- Add column to copy_traders for tracking previous rank (for decay detection)
ALTER TABLE copy_traders
ADD COLUMN IF NOT EXISTS max_open_positions INTEGER DEFAULT 5,
ADD COLUMN IF NOT EXISTS previous_rank_30d INTEGER;

-- Comment explaining the new columns
COMMENT ON COLUMN paper_positions.rank_at_entry IS 'Copyable rank (30d) of the trader when this position was opened';
COMMENT ON COLUMN paper_positions.roi_at_entry IS 'ROI (30d) of the trader when this position was opened';
COMMENT ON COLUMN paper_positions.pl_at_entry IS 'P/L (30d) of the trader when this position was opened';
COMMENT ON COLUMN copy_traders.max_open_positions IS 'Maximum concurrent open positions allowed from this trader';
COMMENT ON COLUMN copy_traders.previous_rank_30d IS 'Previous rank used for detecting rank decay';
