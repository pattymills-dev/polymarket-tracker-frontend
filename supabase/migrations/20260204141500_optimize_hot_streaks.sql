-- Optimize hot streaks and enrich trader performance metrics

-- Extend hot_streaks cache with streak metadata
ALTER TABLE hot_streaks
ADD COLUMN IF NOT EXISTS current_streak INTEGER DEFAULT 0;

ALTER TABLE hot_streaks
ADD COLUMN IF NOT EXISTS recent_win_rate NUMERIC;

ALTER TABLE hot_streaks
ADD COLUMN IF NOT EXISTS recent_markets INTEGER;

ALTER TABLE hot_streaks
ADD COLUMN IF NOT EXISTS last_resolved_at TIMESTAMPTZ;

-- Enriched performance function with streak + recency metrics
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
  settlement_pl numeric,
  current_streak int,
  recent_win_rate numeric,
  recent_markets int,
  last_resolved_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  WITH resolved_positions AS (
    SELECT
      t.trader_address as pos_trader_address,
      t.market_id as pos_market_id,
      t.outcome as pos_outcome,
      m.resolved,
      m.winning_outcome,

      -- Calculate shares from amount/price if shares is null
      -- Use COALESCE(side, 'BUY') to default to BUY when side is null
      SUM(CASE
        WHEN COALESCE(t.side, 'BUY') = 'BUY'
        THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
        ELSE 0
      END) as buy_shares,
      SUM(CASE
        WHEN t.side = 'SELL'
        THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
        ELSE 0
      END) as sell_shares,
      SUM(CASE
        WHEN COALESCE(t.side, 'BUY') = 'BUY'
        THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
        ELSE 0
      END) -
        SUM(CASE
          WHEN t.side = 'SELL'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END) as net_shares,

      -- Cost tracking
      SUM(CASE WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0 END) as buy_cost,
      SUM(CASE WHEN t.side = 'SELL' THEN t.amount ELSE 0 END) as sell_proceeds,

      -- Average cost basis
      CASE
        WHEN SUM(CASE
          WHEN COALESCE(t.side, 'BUY') = 'BUY'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END) > 0
        THEN SUM(CASE WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0 END) /
             SUM(CASE
               WHEN COALESCE(t.side, 'BUY') = 'BUY'
               THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
               ELSE 0
             END)
        ELSE 0
      END as avg_buy_price

    FROM trades t
    LEFT JOIN markets m ON t.market_id = m.id
    WHERE m.resolved = true
    GROUP BY t.trader_address, t.market_id, t.outcome, m.resolved, m.winning_outcome
  ),
  position_pl AS (
    SELECT
      pos_trader_address,
      pos_market_id,
      pos_outcome,
      buy_shares,
      sell_shares,
      net_shares,
      buy_cost,
      sell_proceeds,
      avg_buy_price,
      winning_outcome,

      -- Realized P/L from sells (simplified: avg cost basis)
      sell_proceeds - (sell_shares * avg_buy_price) as pos_realized_pl,

      -- Settlement P/L from remaining shares
      CASE
        WHEN winning_outcome = pos_outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
        ELSE 0 - (net_shares * avg_buy_price)
      END as pos_settlement_pl,

      -- Total P/L for this position
      (sell_proceeds - (sell_shares * avg_buy_price)) +
      CASE
        WHEN winning_outcome = pos_outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
        ELSE 0 - (net_shares * avg_buy_price)
      END as pos_total_pl,

      -- Win/loss flags
      CASE
        WHEN winning_outcome = pos_outcome THEN true
        ELSE false
      END as is_win,

      -- Profit flags (considering both realized and settlement)
      CASE
        WHEN (sell_proceeds - (sell_shares * avg_buy_price)) +
             CASE
               WHEN winning_outcome = pos_outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
               ELSE 0 - (net_shares * avg_buy_price)
             END > 0 THEN true
        ELSE false
      END as is_profitable

    FROM resolved_positions
    WHERE buy_shares > 0 OR sell_shares > 0  -- Only include positions with actual activity
  ),
  -- Aggregate P/L across all outcomes per market
  market_pl AS (
    SELECT
      pos_trader_address,
      pos_market_id,
      MAX(COALESCE(m.resolved_at, m.updated_at))::timestamptz as resolved_at,
      SUM(buy_cost) as mkt_total_buy_cost,
      SUM(sell_proceeds) as mkt_total_sell_proceeds,
      SUM(pos_realized_pl) as mkt_realized_pl,
      SUM(pos_settlement_pl) as mkt_settlement_pl,
      SUM(pos_total_pl) as mkt_total_pl,
      -- Market is profitable if total P/L > 0
      CASE WHEN SUM(pos_total_pl) > 0 THEN true ELSE false END as is_profitable,
      -- For win rate, we consider if they bet on the winning outcome
      BOOL_OR(is_win) as has_winning_position
    FROM position_pl p
    JOIN markets m ON m.id = p.pos_market_id
    GROUP BY pos_trader_address, pos_market_id
  ),
  ordered_markets AS (
    SELECT
      *,
      ROW_NUMBER() OVER (PARTITION BY pos_trader_address ORDER BY resolved_at DESC NULLS LAST) as rn,
      CASE WHEN has_winning_position THEN 1 ELSE 0 END as win_flag
    FROM market_pl
  ),
  streak_summary AS (
    SELECT
      pos_trader_address,
      MAX(resolved_at) as last_resolved_at,
      SUM(CASE WHEN rn <= 10 THEN win_flag ELSE 0 END)::numeric /
        NULLIF(SUM(CASE WHEN rn <= 10 THEN 1 ELSE 0 END), 0) as recent_win_rate,
      SUM(CASE WHEN rn <= 10 THEN 1 ELSE 0 END)::int as recent_markets,
      CASE
        WHEN MIN(CASE WHEN win_flag = 0 THEN rn END) IS NULL THEN COUNT(*)
        ELSE GREATEST(MIN(CASE WHEN win_flag = 0 THEN rn END) - 1, 0)
      END as current_streak
    FROM ordered_markets
    GROUP BY pos_trader_address
  ),
  market_agg AS (
    SELECT
      pos_trader_address::text as trader_address,
      SUM(mkt_total_buy_cost)::numeric as total_buy_cost,
      SUM(mkt_total_sell_proceeds)::numeric as total_sell_proceeds,
      COUNT(DISTINCT pos_market_id)::bigint as resolved_markets,
      COUNT(*) FILTER (WHERE has_winning_position)::bigint as wins,
      COUNT(*) FILTER (WHERE NOT has_winning_position)::bigint as losses,
      COALESCE(COUNT(*) FILTER (WHERE has_winning_position)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as win_rate,
      COUNT(*) FILTER (WHERE is_profitable)::bigint as profit_wins,
      COUNT(*) FILTER (WHERE NOT is_profitable)::bigint as profit_losses,
      COALESCE(COUNT(*) FILTER (WHERE is_profitable)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as profitability_rate,
      SUM(mkt_total_pl)::numeric as total_pl,
      SUM(mkt_realized_pl)::numeric as realized_pl,
      SUM(mkt_settlement_pl)::numeric as settlement_pl
    FROM market_pl
    GROUP BY pos_trader_address
  )
  SELECT
    m.trader_address,
    m.total_buy_cost,
    m.total_sell_proceeds,
    m.resolved_markets,
    m.wins,
    m.losses,
    m.win_rate,
    m.profit_wins,
    m.profit_losses,
    m.profitability_rate,
    m.total_pl,
    m.realized_pl,
    m.settlement_pl,
    COALESCE(s.current_streak, 0) as current_streak,
    COALESCE(s.recent_win_rate, 0) as recent_win_rate,
    COALESCE(s.recent_markets, 0) as recent_markets,
    s.last_resolved_at
  FROM market_agg m
  LEFT JOIN streak_summary s ON s.pos_trader_address = m.trader_address
  WHERE m.resolved_markets >= min_resolved_markets;
END;
$$ LANGUAGE plpgsql;

-- Update hot streaks to use recency and streak metrics
CREATE OR REPLACE FUNCTION refresh_hot_streaks()
RETURNS void AS $$
BEGIN
  -- Clear existing cache
  DELETE FROM hot_streaks;

  -- Insert top 50 traders by streak + recent win rate (minimum 5 resolved markets)
  INSERT INTO hot_streaks (
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate,
    wins,
    losses,
    rank,
    updated_at,
    current_streak,
    recent_win_rate,
    recent_markets,
    last_resolved_at
  )
  SELECT
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    COALESCE(recent_win_rate, win_rate) * 100, -- Store as percentage
    wins,
    losses,
    ROW_NUMBER() OVER (
      ORDER BY current_streak DESC,
               recent_win_rate DESC,
               resolved_markets DESC
    ) as rank,
    NOW(),
    COALESCE(current_streak, 0),
    COALESCE(recent_win_rate, win_rate),
    COALESCE(recent_markets, resolved_markets),
    last_resolved_at
  FROM calculate_trader_performance(5)  -- Minimum 5 resolved markets
  WHERE COALESCE(recent_markets, resolved_markets) >= 5
    AND COALESCE(recent_win_rate, win_rate) >= 0.70
  ORDER BY current_streak DESC, recent_win_rate DESC, resolved_markets DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;
