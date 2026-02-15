-- Fix: copyable_traders (with wins/losses) was not being refreshed
-- recalculate_trader_stats() only updates trader_stats (volume, counts)
-- We need refresh_all_trader_caches() to update copyable_traders & rankings

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job not available, skipping';
    RETURN;
  END IF;

  -- Remove the old recalculate-trader-stats job (wrong function)
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'recalculate-trader-stats';

  -- Add job to refresh ALL trader caches including copyable_traders (wins/losses)
  -- Run every 2 hours to stay within free tier limits
  PERFORM cron.schedule(
    'refresh-all-trader-caches',
    '20 */2 * * *',
    'SELECT refresh_all_trader_caches();'
  );

  RAISE NOTICE 'Added refresh-all-trader-caches cron (every 2 hours)';
END $$;

-- Run immediately to fix stale data
SELECT refresh_all_trader_caches();
