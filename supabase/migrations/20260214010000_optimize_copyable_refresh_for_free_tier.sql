-- Optimize copyable_traders refresh for Supabase free tier (8s statement timeout)
-- Break into smaller batches and use incremental updates instead of full refresh

-- Create an incremental refresh that only updates changed data
CREATE OR REPLACE FUNCTION refresh_copyable_traders_incremental()
RETURNS INT AS $$
DECLARE
  cutoff_ts timestamptz := NOW() - INTERVAL '30 days';
  v_count INT := 0;
BEGIN
  -- Step 1: Get top 100 active traders by volume in last 30 days
  CREATE TEMP TABLE IF NOT EXISTS _active_traders AS
  SELECT trader_address, SUM(amount) as vol
  FROM trades
  WHERE timestamp >= cutoff_ts
    AND (side IS NULL OR side = 'BUY')
    AND amount > 0
    AND price > 0.05 AND price < 0.95
  GROUP BY trader_address
  ORDER BY vol DESC
  LIMIT 100;

  -- Step 2: Calculate wins/losses for these traders
  WITH trader_markets AS (
    SELECT DISTINCT
      t.trader_address,
      t.market_id,
      t.outcome,
      t.amount,
      t.price
    FROM trades t
    JOIN _active_traders a ON a.trader_address = t.trader_address
    WHERE t.timestamp >= cutoff_ts
      AND (t.side IS NULL OR t.side = 'BUY')
      AND t.price > 0.05 AND t.price < 0.95
  ),
  resolved AS (
    SELECT
      tm.trader_address,
      COUNT(*) FILTER (WHERE m.resolved AND tm.outcome = m.winning_outcome) as wins,
      COUNT(*) FILTER (WHERE m.resolved AND tm.outcome <> m.winning_outcome) as losses,
      COUNT(*) FILTER (WHERE m.resolved) as resolved_count,
      SUM(tm.amount) FILTER (WHERE m.resolved) as resolved_notional,
      SUM(
        CASE
          WHEN m.resolved AND tm.outcome = m.winning_outcome
          THEN tm.amount * (1 / NULLIF(tm.price, 0) - 1)
          WHEN m.resolved AND tm.outcome <> m.winning_outcome
          THEN -tm.amount
          ELSE 0
        END
      ) as realized_pl,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY tm.amount) as median_bet
    FROM trader_markets tm
    LEFT JOIN markets m ON m.id = tm.market_id
    GROUP BY tm.trader_address
    HAVING COUNT(*) FILTER (WHERE m.resolved) >= 5
  )
  -- Step 3: Upsert into copyable_traders
  INSERT INTO copyable_traders (
    trader_address,
    wins, losses, resolved_trades_count,
    resolved_notional, realized_pl, realized_roi,
    median_trade_notional, copy_score, rank,
    win_rate, avg_abs_dist, extreme_share, selectivity, evidence,
    updated_at
  )
  SELECT
    r.trader_address,
    r.wins,
    r.losses,
    r.resolved_count,
    COALESCE(r.resolved_notional, 0),
    COALESCE(r.realized_pl, 0),
    CASE WHEN r.resolved_notional > 0 THEN r.realized_pl / r.resolved_notional ELSE 0 END,
    COALESCE(r.median_bet, 0),
    -- Simple copy score: ROI * sqrt(resolved_count)
    CASE WHEN r.resolved_notional > 0
      THEN (r.realized_pl / r.resolved_notional) * sqrt(r.resolved_count::numeric)
      ELSE 0
    END,
    ROW_NUMBER() OVER (ORDER BY
      CASE WHEN r.resolved_notional > 0
        THEN (r.realized_pl / r.resolved_notional) * sqrt(r.resolved_count::numeric)
        ELSE 0
      END DESC
    ),
    CASE WHEN r.resolved_count > 0 THEN r.wins::numeric / r.resolved_count ELSE 0 END,
    0, 0, 0, 0,
    NOW()
  FROM resolved r
  WHERE r.resolved_notional >= 1000
    AND r.resolved_count >= 5
  ON CONFLICT (trader_address) DO UPDATE SET
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    resolved_trades_count = EXCLUDED.resolved_trades_count,
    resolved_notional = EXCLUDED.resolved_notional,
    realized_pl = EXCLUDED.realized_pl,
    realized_roi = EXCLUDED.realized_roi,
    median_trade_notional = EXCLUDED.median_trade_notional,
    copy_score = EXCLUDED.copy_score,
    win_rate = EXCLUDED.win_rate,
    updated_at = NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Cleanup temp table
  DROP TABLE IF EXISTS _active_traders;

  -- Update ranks based on copy_score
  WITH ranked AS (
    SELECT trader_address, ROW_NUMBER() OVER (ORDER BY copy_score DESC, realized_pl DESC) as new_rank
    FROM copyable_traders
  )
  UPDATE copyable_traders c
  SET rank = r.new_rank
  FROM ranked r
  WHERE c.trader_address = r.trader_address;

  -- Also refresh trader_rankings
  PERFORM refresh_trader_rankings();

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Update the cron to use incremental refresh
DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'refresh-all-trader-caches';

  -- Run incremental refresh every 2 hours
  PERFORM cron.schedule(
    'refresh-copyable-incremental',
    '20 */2 * * *',
    'SELECT refresh_copyable_traders_incremental();'
  );
END $$;
