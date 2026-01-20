-- ============================================
-- FIX: Correct P/L Calculation Function
-- ============================================
-- Issue: The current function counts POSITIONS (trader+market+outcome) for wins/losses
-- but should count MARKETS. A trader can have multiple outcomes per market.
-- This leads to inflated win/loss counts and incorrect profitability rates.

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

      -- Total P/L for this position
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
  ),
  -- Aggregate P/L across all outcomes per market
  market_pl AS (
    SELECT
      trader_address,
      market_id,
      SUM(buy_cost) as total_buy_cost,
      SUM(sell_proceeds) as total_sell_proceeds,
      SUM(realized_pl) as realized_pl,
      SUM(settlement_pl) as settlement_pl,
      SUM(total_pl) as total_pl,
      -- Market is a win if ANY outcome won (trader made money)
      -- Market is profitable if total P/L > 0
      CASE WHEN SUM(total_pl) > 0 THEN true ELSE false END as is_profitable,
      -- For win rate, we consider if they bet on the winning outcome
      -- (even if they lost money due to poor entry/exit)
      BOOL_OR(is_win) as has_winning_position
    FROM position_pl
    GROUP BY trader_address, market_id
  )
  SELECT
    m.trader_address,
    SUM(m.total_buy_cost)::numeric as total_buy_cost,
    SUM(m.total_sell_proceeds)::numeric as total_sell_proceeds,
    COUNT(DISTINCT m.market_id)::bigint as resolved_markets,
    COUNT(*) FILTER (WHERE m.has_winning_position)::bigint as wins,
    COUNT(*) FILTER (WHERE NOT m.has_winning_position)::bigint as losses,
    COALESCE(COUNT(*) FILTER (WHERE m.has_winning_position)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as win_rate,
    COUNT(*) FILTER (WHERE m.is_profitable)::bigint as profit_wins,
    COUNT(*) FILTER (WHERE NOT m.is_profitable)::bigint as profit_losses,
    COALESCE(COUNT(*) FILTER (WHERE m.is_profitable)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as profitability_rate,
    SUM(m.total_pl)::numeric as total_pl,
    SUM(m.realized_pl)::numeric as realized_pl,
    SUM(m.settlement_pl)::numeric as settlement_pl
  FROM market_pl m
  GROUP BY m.trader_address
  HAVING COUNT(DISTINCT m.market_id) >= min_resolved_markets;
END;
$$ LANGUAGE plpgsql;

-- Test the function
SELECT * FROM calculate_trader_performance(1)
ORDER BY profitability_rate DESC
LIMIT 10;
