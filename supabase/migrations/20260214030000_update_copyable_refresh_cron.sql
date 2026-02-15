-- Update cron schedule for copyable traders refresh
-- - Every 6 hours: refresh existing top 50 traders (mode=existing)
-- - Once daily: discover new top traders (mode=top)

DO $$
DECLARE
  v_url TEXT := 'https://smuktlgclwvaxnduuinm.supabase.co';
  v_key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODMzMjQxNCwiZXhwIjoyMDgzOTA4NDE0fQ.YE_X-OV9jdZxoKclphcCCxfzrgrHSN-nmAHLBQtptN0';
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job not available, skipping';
    RETURN;
  END IF;

  -- Remove old cron job
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'refresh-copyable-traders-edge',
    'refresh-copyable-incremental'
  );

  -- Every 6 hours: refresh stats for existing top 50 traders
  -- Runs at 00:30, 06:30, 12:30, 18:30 UTC
  PERFORM cron.schedule(
    'refresh-copyable-existing',
    '30 0,6,12,18 * * *',
    format($cmd$
      SELECT net.http_post(
        url := '%s/functions/v1/refresh-copyable-traders?mode=existing&limit=50&days=30',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := '{}'::jsonb
      );
    $cmd$, v_url, v_key)
  );

  -- Once daily at 03:00 UTC: discover new top traders
  PERFORM cron.schedule(
    'refresh-copyable-discover',
    '0 3 * * *',
    format($cmd$
      SELECT net.http_post(
        url := '%s/functions/v1/refresh-copyable-traders?mode=top&limit=50&days=30',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := '{}'::jsonb
      );
    $cmd$, v_url, v_key)
  );

  RAISE NOTICE 'Scheduled copyable traders crons: existing (every 6h), discover (daily)';
END $$;
