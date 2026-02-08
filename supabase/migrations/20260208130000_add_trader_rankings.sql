-- Canonical trader rankings used by website + Telegram
-- This table unifies copyable (30D) and top performer (all-time) metrics.

CREATE TABLE IF NOT EXISTS trader_rankings (
  trader_address TEXT PRIMARY KEY,

  -- Copyable (30D) ranking + metrics
  copyable_rank_30d INT,
  copy_score_30d NUMERIC,
  realized_pl_30d NUMERIC,
  realized_roi_30d NUMERIC,
  resolved_notional_30d NUMERIC,
  median_bet_30d NUMERIC,
  wins_30d INT,
  losses_30d INT,
  resolved_trades_30d INT,
  confidence_30d SMALLINT,

  -- Top performer (all-time) ranking + metrics
  top_performer_rank_all_time INT,
  realized_pl_all_time NUMERIC,
  realized_roi_all_time NUMERIC,
  total_buy_cost_all_time NUMERIC,
  wins_all_time INT,
  losses_all_time INT,
  resolved_markets_all_time INT,

  computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_rankings_copyable_rank
  ON trader_rankings (copyable_rank_30d);

CREATE INDEX IF NOT EXISTS idx_trader_rankings_top_rank
  ON trader_rankings (top_performer_rank_all_time);

CREATE OR REPLACE FUNCTION refresh_trader_rankings()
RETURNS void AS $$
BEGIN
  DELETE FROM trader_rankings WHERE TRUE;

  WITH copyable_raw AS (
    SELECT
      trader_address,
      copy_score AS copy_score_30d,
      realized_pl AS realized_pl_30d,
      realized_roi AS realized_roi_30d,
      resolved_notional AS resolved_notional_30d,
      median_trade_notional AS median_bet_30d,
      wins AS wins_30d,
      losses AS losses_30d,
      resolved_trades_count AS resolved_trades_30d,
      CASE
        WHEN resolved_trades_count >= 30 THEN 3
        WHEN resolved_trades_count >= 15 THEN 2
        WHEN resolved_trades_count >= 10 THEN 1
        ELSE 0
      END::SMALLINT AS confidence_30d
    FROM copyable_traders
    WHERE realized_roi >= 0.10
      AND realized_pl >= 1000
      AND median_trade_notional >= 250
      AND resolved_trades_count >= 10
  ),
  copyable AS (
    SELECT
      *,
      ROW_NUMBER() OVER (ORDER BY copy_score_30d DESC, realized_pl_30d DESC) AS copyable_rank_30d
    FROM copyable_raw
  ),
  top AS (
    SELECT
      trader_address,
      rank AS top_performer_rank_all_time,
      total_pl AS realized_pl_all_time,
      CASE
        WHEN total_buy_cost > 0 THEN total_pl / total_buy_cost
        ELSE 0
      END AS realized_roi_all_time,
      total_buy_cost AS total_buy_cost_all_time,
      wins AS wins_all_time,
      losses AS losses_all_time,
      resolved_markets AS resolved_markets_all_time
    FROM top_traders
  )
  INSERT INTO trader_rankings (
    trader_address,
    copyable_rank_30d,
    copy_score_30d,
    realized_pl_30d,
    realized_roi_30d,
    resolved_notional_30d,
    median_bet_30d,
    wins_30d,
    losses_30d,
    resolved_trades_30d,
    confidence_30d,
    top_performer_rank_all_time,
    realized_pl_all_time,
    realized_roi_all_time,
    total_buy_cost_all_time,
    wins_all_time,
    losses_all_time,
    resolved_markets_all_time,
    computed_at
  )
  SELECT
    COALESCE(c.trader_address, t.trader_address) AS trader_address,
    c.copyable_rank_30d,
    c.copy_score_30d,
    c.realized_pl_30d,
    c.realized_roi_30d,
    c.resolved_notional_30d,
    c.median_bet_30d,
    c.wins_30d,
    c.losses_30d,
    c.resolved_trades_30d,
    c.confidence_30d,
    t.top_performer_rank_all_time,
    t.realized_pl_all_time,
    t.realized_roi_all_time,
    t.total_buy_cost_all_time,
    t.wins_all_time,
    t.losses_all_time,
    t.resolved_markets_all_time,
    NOW()
  FROM copyable c
  FULL OUTER JOIN top t
    ON t.trader_address = c.trader_address;
END;
$$ LANGUAGE plpgsql;
