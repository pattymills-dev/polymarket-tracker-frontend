-- ============================================
-- SELL TRADES: Database Migrations
-- Run these in Supabase SQL Editor
-- ============================================

-- ============================================
-- STEP 1: Schema Updates
-- ============================================

-- Add shares column if missing
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS shares numeric;

-- Ensure side column exists
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS side text;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_trades_side ON trades(side);
CREATE INDEX IF NOT EXISTS idx_trades_amount_desc ON trades(amount DESC);
CREATE INDEX IF NOT EXISTS idx_trades_trader_side ON trades(trader_address, side);

-- Backfill shares from amount/price where shares is null
UPDATE trades
SET shares = CASE
  WHEN price > 0 THEN amount / price
  ELSE 0
END
WHERE shares IS NULL AND amount IS NOT NULL;

-- Set default side to BUY where null (backward compatibility)
UPDATE trades
SET side = 'BUY'
WHERE side IS NULL;


-- ============================================
-- STEP 2: Sanity Check Queries
-- ============================================

-- Check side distribution
SELECT
  side,
  COUNT(*) as trade_count,
  SUM(amount)::numeric::money as total_volume,
  AVG(amount)::numeric::money as avg_trade_size
FROM trades
GROUP BY side
ORDER BY trade_count DESC;

-- Check large sells exist
SELECT
  market_title,
  trader_address,
  side,
  shares,
  price,
  amount,
  timestamp
FROM trades
WHERE side = 'SELL'
  AND amount >= 10000
ORDER BY amount DESC
LIMIT 20;

-- Check traders with both buys and sells
SELECT
  trader_address,
  COUNT(CASE WHEN side = 'BUY' THEN 1 END) as buys,
  COUNT(CASE WHEN side = 'SELL' THEN 1 END) as sells,
  SUM(CASE WHEN side = 'BUY' THEN amount ELSE 0 END)::numeric::money as buy_volume,
  SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END)::numeric::money as sell_volume
FROM trades
GROUP BY trader_address
HAVING COUNT(CASE WHEN side = 'SELL' THEN 1 END) > 0
ORDER BY sells DESC
LIMIT 20;

-- Check if shares are populated
SELECT
  COUNT(*) as total_trades,
  COUNT(shares) as trades_with_shares,
  COUNT(*) - COUNT(shares) as missing_shares,
  AVG(shares) as avg_shares
FROM trades;


-- ============================================
-- STEP 3: Create Trader Positions View
-- ============================================

CREATE OR REPLACE VIEW trader_market_positions AS
SELECT
  trader_address,
  market_id,
  outcome,

  -- Share tracking
  SUM(CASE WHEN side = 'BUY' THEN shares ELSE 0 END) as buy_shares,
  SUM(CASE WHEN side = 'SELL' THEN shares ELSE 0 END) as sell_shares,
  SUM(CASE WHEN side = 'BUY' THEN shares ELSE 0 END) -
    SUM(CASE WHEN side = 'SELL' THEN shares ELSE 0 END) as net_shares,

  -- Cost tracking
  SUM(CASE WHEN side = 'BUY' THEN amount ELSE 0 END) as buy_cost,
  SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END) as sell_proceeds,

  -- Average prices
  CASE
    WHEN SUM(CASE WHEN side = 'BUY' THEN shares ELSE 0 END) > 0
    THEN SUM(CASE WHEN side = 'BUY' THEN amount ELSE 0 END) /
         SUM(CASE WHEN side = 'BUY' THEN shares ELSE 0 END)
    ELSE 0
  END as avg_buy_price,

  CASE
    WHEN SUM(CASE WHEN side = 'SELL' THEN shares ELSE 0 END) > 0
    THEN SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END) /
         SUM(CASE WHEN side = 'SELL' THEN shares ELSE 0 END)
    ELSE 0
  END as avg_sell_price,

  -- Trade counts
  COUNT(CASE WHEN side = 'BUY' THEN 1 END) as buy_count,
  COUNT(CASE WHEN side = 'SELL' THEN 1 END) as sell_count,

  MAX(timestamp) as last_trade_time
FROM trades
WHERE trader_address IS NOT NULL
GROUP BY trader_address, market_id, outcome;

-- Test the view
SELECT * FROM trader_market_positions
WHERE sell_shares > 0
ORDER BY (buy_cost + sell_proceeds) DESC
LIMIT 10;


-- ============================================
-- STEP 4: Update P/L Calculation Function
-- ============================================

CREATE OR REPLACE FUNCTION calculate_trader_performance(min_resolved_markets int DEFAULT 1)
RETURNS TABLE (
  trader_address text,
  total_buy_cost numeric,
  total_sell_proceeds numeric,
  resolved_markets bigint,
  wins bigint,
  losses bigint,
  win_rate numeric,
  profit_wins bigint,
  profit_losses bigint,
  profitability_rate numeric,
  total_pl numeric,
  realized_pl numeric,
  settlement_pl numeric
) AS $$
BEGIN
  RETURN QUERY
  WITH resolved_positions AS (
    SELECT
      t.trader_address,
      t.market_id,
      t.outcome,
      m.resolved,
      m.winning_outcome,

      -- Share aggregation
      SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END) as buy_shares,
      SUM(CASE WHEN t.side = 'SELL' THEN t.shares ELSE 0 END) as sell_shares,
      SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END) -
        SUM(CASE WHEN t.side = 'SELL' THEN t.shares ELSE 0 END) as net_shares,

      -- Cost tracking
      SUM(CASE WHEN t.side = 'BUY' THEN t.amount ELSE 0 END) as buy_cost,
      SUM(CASE WHEN t.side = 'SELL' THEN t.amount ELSE 0 END) as sell_proceeds,

      -- Average cost basis
      CASE
        WHEN SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END) > 0
        THEN SUM(CASE WHEN t.side = 'BUY' THEN t.amount ELSE 0 END) /
             SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END)
        ELSE 0
      END as avg_buy_price

    FROM trades t
    LEFT JOIN markets m ON t.market_id = m.market_id
    WHERE m.resolved = true
    GROUP BY t.trader_address, t.market_id, t.outcome, m.resolved, m.winning_outcome
  ),
  position_pl AS (
    SELECT
      trader_address,
      market_id,
      outcome,
      buy_shares,
      sell_shares,
      net_shares,
      buy_cost,
      sell_proceeds,
      avg_buy_price,

      -- Realized P/L from sells (simplified: avg cost basis)
      sell_proceeds - (sell_shares * avg_buy_price) as realized_pl,

      -- Settlement P/L from remaining shares
      CASE
        WHEN winning_outcome = outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
        ELSE 0 - (net_shares * avg_buy_price)
      END as settlement_pl,

      -- Total P/L
      (sell_proceeds - (sell_shares * avg_buy_price)) +
      CASE
        WHEN winning_outcome = outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
        ELSE 0 - (net_shares * avg_buy_price)
      END as total_pl,

      -- Win/loss flags
      CASE
        WHEN winning_outcome = outcome THEN true
        ELSE false
      END as is_win,

      -- Profit flags (considering both realized and settlement)
      CASE
        WHEN (sell_proceeds - (sell_shares * avg_buy_price)) +
             CASE
               WHEN winning_outcome = outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
               ELSE 0 - (net_shares * avg_buy_price)
             END > 0 THEN true
        ELSE false
      END as is_profitable

    FROM resolved_positions
  )
  SELECT
    p.trader_address,
    SUM(p.buy_cost)::numeric as total_buy_cost,
    SUM(p.sell_proceeds)::numeric as total_sell_proceeds,
    COUNT(DISTINCT p.market_id)::bigint as resolved_markets,
    COUNT(*) FILTER (WHERE p.is_win)::bigint as wins,
    COUNT(*) FILTER (WHERE NOT p.is_win)::bigint as losses,
    COALESCE(COUNT(*) FILTER (WHERE p.is_win)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as win_rate,
    COUNT(*) FILTER (WHERE p.is_profitable)::bigint as profit_wins,
    COUNT(*) FILTER (WHERE NOT p.is_profitable)::bigint as profit_losses,
    COALESCE(COUNT(*) FILTER (WHERE p.is_profitable)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as profitability_rate,
    SUM(p.total_pl)::numeric as total_pl,
    SUM(p.realized_pl)::numeric as realized_pl,
    SUM(p.settlement_pl)::numeric as settlement_pl
  FROM position_pl p
  GROUP BY p.trader_address
  HAVING COUNT(DISTINCT p.market_id) >= min_resolved_markets;
END;
$$ LANGUAGE plpgsql;

-- Test the function
SELECT * FROM calculate_trader_performance(1)
ORDER BY profitability_rate DESC
LIMIT 10;


-- ============================================
-- STEP 5: Additional Useful Queries
-- ============================================

-- Top traders by realized P/L (from sells only)
SELECT
  trader_address,
  SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END) -
    SUM(CASE WHEN side = 'BUY' THEN amount ELSE 0 END) as simple_pl,
  COUNT(*) as total_trades,
  COUNT(CASE WHEN side = 'SELL' THEN 1 END) as sell_count
FROM trades
GROUP BY trader_address
HAVING COUNT(CASE WHEN side = 'SELL' THEN 1 END) > 0
ORDER BY simple_pl DESC
LIMIT 20;

-- Markets with most sell activity
SELECT
  market_title,
  market_id,
  COUNT(CASE WHEN side = 'SELL' THEN 1 END) as sell_count,
  SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END)::money as sell_volume
FROM trades
WHERE side = 'SELL'
GROUP BY market_title, market_id
ORDER BY sell_count DESC
LIMIT 20;

-- Recent sell activity
SELECT
  timestamp,
  market_title,
  trader_address,
  outcome,
  shares,
  price,
  amount
FROM trades
WHERE side = 'SELL'
ORDER BY timestamp DESC
LIMIT 50;

