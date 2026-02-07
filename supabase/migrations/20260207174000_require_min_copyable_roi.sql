-- Require a minimum realized ROI for "copyable" traders.
--
-- Without this, the leaderboard (and thus Telegram alerts) can include low-edge
-- grinders (e.g. ~0-5% ROI) which are not actually worth mirroring.
--
-- Note: ROI is computed using the v1 BUY-only resolved approximation.

CREATE OR REPLACE FUNCTION refresh_copyable_traders(
  p_days INT DEFAULT 30,
  p_trade_limit INT DEFAULT 100
)
RETURNS void AS $$
DECLARE
  cutoff_ts timestamptz := NOW() - (p_days || ' days')::interval;
BEGIN
  DELETE FROM copyable_traders WHERE TRUE;

  WITH active_traders AS (
    SELECT DISTINCT t.trader_address
    FROM trades t
    WHERE t.trader_address IS NOT NULL
      AND t.tx_hash IS NOT NULL
      AND t.market_id IS NOT NULL
      AND t.timestamp IS NOT NULL
      AND t.timestamp >= cutoff_ts
      AND (t.side IS NULL OR t.side = 'BUY')
      AND t.price IS NOT NULL
      AND t.price > 0
      AND t.price < 1
      AND t.amount IS NOT NULL
      AND t.amount > 0
      AND t.outcome IS NOT NULL
  ),
  trades_30d AS (
    SELECT
      t.tx_hash,
      t.trader_address,
      t.market_id,
      t.timestamp,
      COALESCE(t.side, 'BUY') as side,
      t.price::numeric as price,
      t.amount::numeric as amount,
      t.outcome
    FROM trades t
    JOIN active_traders a ON a.trader_address = t.trader_address
    WHERE t.tx_hash IS NOT NULL
      AND t.market_id IS NOT NULL
      AND t.timestamp IS NOT NULL
      AND t.timestamp >= cutoff_ts
      AND (t.side IS NULL OR t.side = 'BUY')
      AND t.price IS NOT NULL
      AND t.price > 0
      AND t.price < 1
      AND t.amount IS NOT NULL
      AND t.amount > 0
      AND t.outcome IS NOT NULL
  ),
  trades_last_n AS (
    SELECT
      t.tx_hash,
      t.trader_address,
      t.market_id,
      t.timestamp,
      COALESCE(t.side, 'BUY') as side,
      t.price::numeric as price,
      t.amount::numeric as amount,
      t.outcome
    FROM active_traders a
    JOIN LATERAL (
      SELECT
        tx_hash,
        trader_address,
        market_id,
        timestamp,
        side,
        price,
        amount,
        outcome
      FROM trades
      WHERE trader_address = a.trader_address
        AND tx_hash IS NOT NULL
        AND market_id IS NOT NULL
        AND timestamp IS NOT NULL
        AND (side IS NULL OR side = 'BUY')
        AND price IS NOT NULL
        AND price > 0
        AND price < 1
        AND amount IS NOT NULL
        AND amount > 0
        AND outcome IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT p_trade_limit
    ) t ON TRUE
  ),
  window_raw AS (
    SELECT * FROM trades_30d
    UNION ALL
    SELECT * FROM trades_last_n
  ),
  window_trades AS (
    SELECT DISTINCT ON (tx_hash)
      tx_hash,
      trader_address,
      market_id,
      timestamp,
      side,
      price,
      amount,
      outcome
    FROM window_raw
    ORDER BY tx_hash, timestamp DESC
  ),
  window_with_resolution AS (
    SELECT
      w.*,
      m.winning_outcome,
      (m.winning_outcome IS NOT NULL) as is_resolved
    FROM window_trades w
    LEFT JOIN markets m ON m.id = w.market_id
  ),
  prefilter_agg AS (
    SELECT
      trader_address,
      COUNT(*)::int as total_trades,
      COALESCE(
        AVG(CASE WHEN price >= 0.90 OR price <= 0.10 THEN 1.0 ELSE 0.0 END),
        0
      )::numeric as extreme_share
    FROM window_with_resolution
    GROUP BY trader_address
  ),
  filtered AS (
    SELECT *
    FROM window_with_resolution
    WHERE price > 0.05 AND price < 0.95
  ),
  per_trader_resolved AS (
    SELECT
      f.trader_address,
      COUNT(*) FILTER (WHERE f.is_resolved)::int as resolved_trades_count,
      COUNT(*) FILTER (WHERE f.is_resolved AND f.outcome = f.winning_outcome)::int as wins,
      COUNT(*) FILTER (WHERE f.is_resolved AND f.outcome <> f.winning_outcome)::int as losses,
      SUM(f.amount) FILTER (WHERE f.is_resolved)::numeric as resolved_notional,
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
  candidate_addrs AS (
    SELECT r.trader_address
    FROM per_trader_resolved r
    WHERE r.resolved_trades_count >= 5
      AND COALESCE(r.resolved_notional, 0) >= 5000
  ),
  per_trader_all AS (
    SELECT
      f.trader_address,
      COUNT(*)::int as total_trades_remaining,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY f.amount)::numeric as median_trade_notional,
      AVG(ABS(f.price - 0.5))::numeric as avg_abs_dist
    FROM filtered f
    JOIN candidate_addrs c ON c.trader_address = f.trader_address
    GROUP BY f.trader_address
  ),
  trader_metrics AS (
    SELECT
      a.trader_address,
      r.resolved_trades_count,
      r.wins,
      r.losses,
      COALESCE(r.wins::numeric / NULLIF(r.resolved_trades_count::numeric, 0), 0)::numeric as win_rate,
      COALESCE(r.resolved_notional, 0)::numeric as resolved_notional,
      COALESCE(r.realized_pl, 0)::numeric as realized_pl,
      COALESCE(r.realized_pl::numeric / NULLIF(r.resolved_notional::numeric, 0), 0)::numeric as realized_roi,
      a.median_trade_notional,
      a.avg_abs_dist,
      a.total_trades_remaining,
      COALESCE(p.extreme_share, 0)::numeric as extreme_share
    FROM per_trader_all a
    JOIN per_trader_resolved r ON r.trader_address = a.trader_address
    LEFT JOIN prefilter_agg p ON p.trader_address = a.trader_address
  ),
  candidates AS (
    SELECT
      m.*,
      -- Evidence + selectivity (penalize spam trading)
      GREATEST(
        LEAST(1 - ((m.total_trades_remaining::numeric / NULLIF(p_days::numeric, 0)) / 10), 1),
        0
      )::numeric as selectivity,
      GREATEST(LEAST(m.resolved_trades_count::numeric / 30, 1), 0)::numeric as evidence,
      -- ROI cap to reduce outlier domination
      LEAST(GREATEST(m.realized_roi, -0.5), 2.0)::numeric as realized_roi_capped,
      -- Whale dampener: log scaling
      log(10, 1 + m.median_trade_notional)::numeric as size_score,
      -- Optional penalty: bias toward extreme probabilities
      (1 - 0.5 * COALESCE(m.extreme_share, 0))::numeric as penalty
    FROM trader_metrics m
    WHERE m.median_trade_notional >= 1000
      AND m.realized_roi >= 0.10
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

