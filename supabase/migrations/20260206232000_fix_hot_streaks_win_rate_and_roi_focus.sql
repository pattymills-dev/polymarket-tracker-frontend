-- Fix HOT streak cache semantics + focus HOT on profitable, higher-upside traders.
--
-- Problems observed:
-- 1) `hot_streaks.win_rate` was being stored as *recent* win rate (last 10) rather than overall,
--    which can show "Acc 100%" next to a record that includes losses.
-- 2) HOT should not surface low-upside scalping behavior; align HOT quality filter with alerts.

-- Tighten low-upside filter used by HOT metrics (max ROI threshold).
CREATE OR REPLACE FUNCTION calculate_trader_performance_with_streaks(min_resolved_markets int DEFAULT 1)
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
DECLARE
  -- Require at least 10% max ROI for a market to count toward HOT metrics.
  -- BUY: (1 - avg_buy_price) / avg_buy_price
  -- SELL: avg_sell_price / (1 - avg_sell_price)
  min_market_max_roi numeric := 0.10;
BEGIN
  RETURN QUERY
  WITH resolved_positions AS (
    SELECT
      t.trader_address as pos_trader_address,
      t.market_id as pos_market_id,
      t.outcome as pos_outcome,
      m.winning_outcome,
      SUM(
        CASE
          WHEN COALESCE(t.side, 'BUY') = 'BUY'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END
      ) as buy_shares,
      SUM(
        CASE
          WHEN t.side = 'SELL'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END
      ) as sell_shares,
      SUM(
        CASE
          WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0
        END
      ) as buy_cost,
      SUM(
        CASE
          WHEN t.side = 'SELL' THEN t.amount ELSE 0
        END
      ) as sell_proceeds,
      CASE
        WHEN SUM(
          CASE
            WHEN COALESCE(t.side, 'BUY') = 'BUY'
            THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
            ELSE 0
          END
        ) > 0
        THEN
          SUM(CASE WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0 END) /
          SUM(
            CASE
              WHEN COALESCE(t.side, 'BUY') = 'BUY'
              THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
              ELSE 0
            END
          )
        ELSE 0
      END as avg_buy_price,
      MAX(COALESCE(m.resolved_at, m.updated_at))::timestamptz as resolved_at
    FROM trades t
    LEFT JOIN markets m ON t.market_id = m.id
    WHERE m.winning_outcome IS NOT NULL
    GROUP BY t.trader_address, t.market_id, t.outcome, m.winning_outcome
  ),
  position_pl AS (
    SELECT
      pos_trader_address,
      pos_market_id,
      pos_outcome,
      buy_shares,
      sell_shares,
      buy_cost,
      sell_proceeds,
      avg_buy_price,
      winning_outcome,
      resolved_at,
      (buy_shares - sell_shares) as net_shares,
      CASE
        WHEN sell_shares > 0 THEN sell_proceeds / NULLIF(sell_shares, 0)
        ELSE 0
      END as avg_sell_price,
      GREATEST(
        CASE
          WHEN buy_shares > 0 AND avg_buy_price > 0 AND avg_buy_price < 1
          THEN (1 - avg_buy_price) / avg_buy_price
          ELSE 0
        END,
        CASE
          WHEN sell_shares > 0
            AND (sell_proceeds / NULLIF(sell_shares, 0)) > 0
            AND (sell_proceeds / NULLIF(sell_shares, 0)) < 1
          THEN (sell_proceeds / NULLIF(sell_shares, 0)) / (1 - (sell_proceeds / NULLIF(sell_shares, 0)))
          ELSE 0
        END
      )::numeric as pos_max_roi,
      sell_proceeds - (sell_shares * avg_buy_price) as pos_realized_pl,
      CASE
        WHEN winning_outcome = pos_outcome THEN (buy_shares - sell_shares) * 1.0 - ((buy_shares - sell_shares) * avg_buy_price)
        ELSE 0 - ((buy_shares - sell_shares) * avg_buy_price)
      END as pos_settlement_pl,
      (sell_proceeds - (sell_shares * avg_buy_price)) +
      CASE
        WHEN winning_outcome = pos_outcome THEN (buy_shares - sell_shares) * 1.0 - ((buy_shares - sell_shares) * avg_buy_price)
        ELSE 0 - ((buy_shares - sell_shares) * avg_buy_price)
      END as pos_total_pl,
      CASE WHEN winning_outcome = pos_outcome THEN true ELSE false END as is_win,
      CASE
        WHEN (sell_proceeds - (sell_shares * avg_buy_price)) +
             CASE
               WHEN winning_outcome = pos_outcome THEN (buy_shares - sell_shares) * 1.0 - ((buy_shares - sell_shares) * avg_buy_price)
               ELSE 0 - ((buy_shares - sell_shares) * avg_buy_price)
             END > 0
        THEN true
        ELSE false
      END as is_profitable
    FROM resolved_positions
    WHERE buy_shares > 0 OR sell_shares > 0
  ),
  market_pl AS (
    SELECT
      pos_trader_address,
      pos_market_id,
      MAX(resolved_at) as resolved_at,
      SUM(buy_cost) as mkt_total_buy_cost,
      SUM(sell_proceeds) as mkt_total_sell_proceeds,
      SUM(pos_realized_pl) as mkt_realized_pl,
      SUM(pos_settlement_pl) as mkt_settlement_pl,
      SUM(pos_total_pl) as mkt_total_pl,
      MAX(pos_max_roi) as mkt_max_roi,
      CASE WHEN SUM(pos_total_pl) > 0 THEN true ELSE false END as is_profitable,
      BOOL_OR(is_win) as has_winning_position
    FROM position_pl
    GROUP BY pos_trader_address, pos_market_id
  ),
  quality_market_pl AS (
    SELECT *
    FROM market_pl
    WHERE COALESCE(mkt_max_roi, 0) >= min_market_max_roi
  ),
  ordered_markets AS (
    SELECT
      *,
      ROW_NUMBER() OVER (PARTITION BY pos_trader_address ORDER BY resolved_at DESC NULLS LAST) as rn,
      CASE WHEN has_winning_position THEN 1 ELSE 0 END as win_flag
    FROM quality_market_pl
  ),
  streak_summary AS (
    SELECT
      pos_trader_address,
      MAX(resolved_at) as last_resolved_at,
      SUM(CASE WHEN rn <= 10 THEN win_flag ELSE 0 END)::numeric /
        NULLIF(SUM(CASE WHEN rn <= 10 THEN 1 ELSE 0 END), 0) as recent_win_rate,
      SUM(CASE WHEN rn <= 10 THEN 1 ELSE 0 END)::int as recent_markets,
      CASE
        WHEN MIN(CASE WHEN win_flag = 0 THEN rn END) IS NULL THEN COUNT(*)::int
        ELSE GREATEST(MIN(CASE WHEN win_flag = 0 THEN rn END) - 1, 0)::int
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
    FROM quality_market_pl
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

-- Store overall win_rate in hot_streaks.win_rate (percentage) and keep recent in hot_streaks.recent_win_rate (ratio).
-- Also exclude unprofitable traders from HOT to align with the goal of finding high-ROI traders.
CREATE OR REPLACE FUNCTION refresh_hot_streaks()
RETURNS void AS $$
BEGIN
  DELETE FROM hot_streaks;

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
    win_rate * 100, -- overall win rate as percentage
    wins,
    losses,
    ROW_NUMBER() OVER (
      ORDER BY
        current_streak DESC,
        recent_win_rate DESC,
        (total_pl / NULLIF(total_buy_cost, 0)) DESC,
        resolved_markets DESC
    ) as rank,
    NOW(),
    COALESCE(current_streak, 0),
    COALESCE(recent_win_rate, win_rate),
    COALESCE(recent_markets, resolved_markets),
    last_resolved_at
  FROM calculate_trader_performance_with_streaks(5)
  WHERE COALESCE(recent_markets, resolved_markets) >= 5
    AND COALESCE(recent_win_rate, win_rate) >= 0.70
    AND total_pl > 0
    AND total_buy_cost >= 5000
  ORDER BY
    current_streak DESC,
    recent_win_rate DESC,
    (total_pl / NULLIF(total_buy_cost, 0)) DESC,
    resolved_markets DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

