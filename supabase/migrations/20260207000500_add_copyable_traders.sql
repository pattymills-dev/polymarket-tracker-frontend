-- Copyable traders leaderboard: "High ROI / Copyable Traders"
--
-- v1:
-- - BUY-only, resolved-only approximation
-- - Excludes extreme entry probabilities (<= 5c or >= 95c)
-- - Uses (last 30 days OR last 100 trades) per trader
-- - Scores traders by ROI + P/L + size + selectivity + evidence, with a penalty for extreme-probability bias

CREATE TABLE IF NOT EXISTS copyable_traders (
  trader_address TEXT PRIMARY KEY,
  copy_score NUMERIC,
  realized_pl NUMERIC,
  resolved_notional NUMERIC,
  realized_roi NUMERIC,
  median_trade_notional NUMERIC,
  resolved_trades_count INTEGER,
  wins INTEGER,
  losses INTEGER,
  win_rate NUMERIC,
  avg_abs_dist NUMERIC,
  extreme_share NUMERIC,
  selectivity NUMERIC,
  evidence NUMERIC,
  rank INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copyable_traders_rank ON copyable_traders(rank);

CREATE OR REPLACE FUNCTION refresh_copyable_traders(
  p_days INT DEFAULT 30,
  p_trade_limit INT DEFAULT 100
)
RETURNS void AS $$
DECLARE
  cutoff_ts timestamptz := NOW() - (p_days || ' days')::interval;
BEGIN
  DELETE FROM copyable_traders WHERE TRUE;

  WITH base AS (
    SELECT
      t.trader_address,
      t.market_id,
      t.timestamp,
      COALESCE(t.side, 'BUY') as side,
      t.price::numeric as price,
      t.amount::numeric as amount,
      t.outcome,
      m.winning_outcome,
      (m.winning_outcome IS NOT NULL) as is_resolved,
      ROW_NUMBER() OVER (PARTITION BY t.trader_address ORDER BY t.timestamp DESC) as rn
    FROM trades t
    LEFT JOIN markets m ON m.id = t.market_id
    WHERE t.trader_address IS NOT NULL
      AND t.market_id IS NOT NULL
      AND t.timestamp IS NOT NULL
      AND COALESCE(t.side, 'BUY') = 'BUY'
      AND t.price IS NOT NULL
      AND t.price > 0
      AND t.price < 1
      AND t.amount IS NOT NULL
      AND t.amount > 0
      AND t.outcome IS NOT NULL
  ),
  window_trades AS (
    SELECT *
    FROM base
    WHERE timestamp >= cutoff_ts OR rn <= p_trade_limit
  ),
  prefilter_agg AS (
    SELECT
      trader_address,
      COUNT(*)::int as total_trades,
      COALESCE(
        AVG(CASE WHEN price >= 0.90 OR price <= 0.10 THEN 1.0 ELSE 0.0 END),
        0
      )::numeric as extreme_share
    FROM window_trades
    GROUP BY trader_address
  ),
  filtered AS (
    SELECT *
    FROM window_trades
    WHERE price > 0.05 AND price < 0.95
  ),
  per_trader_all AS (
    SELECT
      f.trader_address,
      COUNT(*)::int as total_trades_remaining,
      MIN(f.timestamp) as min_ts,
      MAX(f.timestamp) as max_ts,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.amount)::numeric as median_trade_notional,
      AVG(ABS(f.price - 0.5))::numeric as avg_abs_dist
    FROM filtered f
    GROUP BY f.trader_address
  ),
  per_trader_resolved AS (
    SELECT
      f.trader_address,
      COUNT(*) FILTER (WHERE f.is_resolved)::int as resolved_trades_count,
      COUNT(*) FILTER (WHERE f.is_resolved AND f.outcome = f.winning_outcome)::int as wins,
      COUNT(*) FILTER (WHERE f.is_resolved AND f.outcome <> f.winning_outcome)::int as losses,
      SUM(f.amount) FILTER (WHERE f.is_resolved)::numeric as resolved_notional,
      -- BUY-only realized P/L approximation (resolved only):
      -- shares = amount / price, payout per share is 1 if correct else 0
      -- profit = shares * payout - amount = amount * (payout/price - 1)
      SUM(
        CASE
          WHEN f.outcome = f.winning_outcome
          THEN f.amount * (1 / NULLIF(f.price, 0) - 1)
          ELSE 0 - f.amount
        END
      ) FILTER (WHERE f.is_resolved)::numeric as realized_pl
    FROM filtered f
    GROUP BY f.trader_address
  ),
  trader_metrics AS (
    SELECT
      a.trader_address,
      COALESCE(r.resolved_trades_count, 0)::int as resolved_trades_count,
      COALESCE(r.wins, 0)::int as wins,
      COALESCE(r.losses, 0)::int as losses,
      COALESCE(COALESCE(r.wins, 0)::numeric / NULLIF(COALESCE(r.resolved_trades_count, 0)::numeric, 0), 0)::numeric as win_rate,
      COALESCE(r.resolved_notional, 0)::numeric as resolved_notional,
      COALESCE(r.realized_pl, 0)::numeric as realized_pl,
      COALESCE(COALESCE(r.realized_pl, 0)::numeric / NULLIF(COALESCE(r.resolved_notional, 0)::numeric, 0), 0)::numeric as realized_roi,
      a.median_trade_notional,
      a.avg_abs_dist,
      a.total_trades_remaining,
      GREATEST(1, EXTRACT(EPOCH FROM (a.max_ts - a.min_ts)) / 86400)::numeric as days_span
    FROM per_trader_all a
    LEFT JOIN per_trader_resolved r ON r.trader_address = a.trader_address
  ),
  candidates AS (
    SELECT
      m.*,
      p.extreme_share,
      -- Evidence + selectivity (penalize spam trading)
      GREATEST(
        LEAST(1 - (((m.total_trades_remaining::numeric / NULLIF(m.days_span, 0)) / 10)), 1),
        0
      )::numeric as selectivity,
      GREATEST(LEAST(m.resolved_trades_count::numeric / 30, 1), 0)::numeric as evidence,
      -- ROI cap to reduce outlier domination
      LEAST(GREATEST(m.realized_roi, -0.5), 2.0)::numeric as realized_roi_capped,
      -- Whale dampener: log scaling
      log(10, 1 + m.median_trade_notional)::numeric as size_score,
      -- Optional penalty: bias toward extreme probabilities
      (1 - 0.5 * COALESCE(p.extreme_share, 0))::numeric as penalty
    FROM trader_metrics m
    LEFT JOIN prefilter_agg p ON p.trader_address = m.trader_address
    WHERE m.avg_abs_dist >= 0.10
      AND m.resolved_trades_count >= 10
      AND m.median_trade_notional >= 100
      AND (m.realized_pl >= 250 OR m.resolved_notional >= 10000)
  ),
  normalized AS (
    SELECT
      c.*,
      MIN(c.realized_roi_capped) OVER () as roi_min,
      MAX(c.realized_roi_capped) OVER () as roi_max,
      MIN(c.realized_pl) OVER () as pl_min,
      MAX(c.realized_pl) OVER () as pl_max,
      MIN(c.size_score) OVER () as size_min,
      MAX(c.size_score) OVER () as size_max
    FROM candidates c
  ),
  scored AS (
    SELECT
      n.*,
      CASE
        WHEN n.roi_max = n.roi_min THEN 0.5
        ELSE (n.realized_roi_capped - n.roi_min) / NULLIF(n.roi_max - n.roi_min, 0)
      END as roi_norm,
      CASE
        WHEN n.pl_max = n.pl_min THEN 0.5
        ELSE (n.realized_pl - n.pl_min) / NULLIF(n.pl_max - n.pl_min, 0)
      END as pl_norm,
      CASE
        WHEN n.size_max = n.size_min THEN 0.5
        ELSE (n.size_score - n.size_min) / NULLIF(n.size_max - n.size_min, 0)
      END as size_norm
    FROM normalized n
  ),
  ranked AS (
    SELECT
      trader_address,
      (0.45 * roi_norm +
       0.20 * pl_norm +
       0.15 * size_norm +
       0.10 * selectivity +
       0.10 * evidence
      )::numeric * COALESCE(penalty, 1)::numeric as copy_score,
      realized_pl,
      resolved_notional,
      realized_roi,
      median_trade_notional,
      resolved_trades_count,
      wins,
      losses,
      win_rate,
      avg_abs_dist,
      extreme_share,
      selectivity,
      evidence
    FROM scored
  )
  INSERT INTO copyable_traders (
    trader_address,
    copy_score,
    realized_pl,
    resolved_notional,
    realized_roi,
    median_trade_notional,
    resolved_trades_count,
    wins,
    losses,
    win_rate,
    avg_abs_dist,
    extreme_share,
    selectivity,
    evidence,
    rank,
    updated_at
  )
  SELECT
    r.trader_address,
    r.copy_score,
    r.realized_pl,
    r.resolved_notional,
    r.realized_roi,
    r.median_trade_notional,
    r.resolved_trades_count,
    r.wins,
    r.losses,
    r.win_rate,
    r.avg_abs_dist,
    r.extreme_share,
    r.selectivity,
    r.evidence,
    ROW_NUMBER() OVER (ORDER BY r.copy_score DESC, r.realized_pl DESC) as rank,
    NOW()
  FROM ranked r
  ORDER BY r.copy_score DESC, r.realized_pl DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- Extend cache refresh to include copyable traders. Keep signatures explicit to avoid overload ambiguity.
CREATE OR REPLACE FUNCTION refresh_all_trader_caches()
RETURNS void AS $$
BEGIN
  PERFORM refresh_top_traders();
  PERFORM refresh_hot_streaks();
  PERFORM refresh_whale_volume_traders();
  PERFORM refresh_trader_open_exposure(1000::numeric, 0.000001::numeric);
  PERFORM refresh_copyable_traders();
END;
$$ LANGUAGE plpgsql;
