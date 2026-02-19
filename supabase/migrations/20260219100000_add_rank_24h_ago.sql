-- Add rank delta tracking to copyable_traders and trader_rankings

-- 1. Add snapshot columns to copyable_traders
ALTER TABLE copyable_traders
ADD COLUMN IF NOT EXISTS rank_24h_ago INTEGER,
ADD COLUMN IF NOT EXISTS rank_snapshot_at TIMESTAMPTZ;

-- 2. Add rank_24h_ago to trader_rankings so frontend can read it
ALTER TABLE trader_rankings
ADD COLUMN IF NOT EXISTS rank_24h_ago_30d INTEGER;

-- 3. Snapshot function: copies current rank → rank_24h_ago atomically
CREATE OR REPLACE FUNCTION snapshot_copyable_ranks()
RETURNS void AS $$
BEGIN
  UPDATE copyable_traders
  SET rank_24h_ago = rank,
      rank_snapshot_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- 4. Update refresh_trader_rankings() to propagate rank_24h_ago
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
      rank_24h_ago,
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
    rank_24h_ago_30d,
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
    c.rank_24h_ago,
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
