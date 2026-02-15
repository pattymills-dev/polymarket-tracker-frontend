-- Schedule the edge function to refresh copyable traders every 2 hours
-- This replaces the SQL-based refresh that was timing out

DO $$
DECLARE
  v_url TEXT := 'https://smuktlgclwvaxnduuinm.supabase.co';
  v_key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODMzMjQxNCwiZXhwIjoyMDgzOTA4NDE0fQ.YE_X-OV9jdZxoKclphcCCxfzrgrHSN-nmAHLBQtptN0';
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job not available, skipping job schedule';
    RETURN;
  END IF;

  -- Remove old SQL-based refresh jobs that were timing out
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'refresh-copyable-incremental',
    'refresh-all-trader-caches'
  );

  -- Schedule edge function to refresh copyable traders every 2 hours
  -- Uses batch=100 to process top 100 active traders
  PERFORM cron.schedule(
    'refresh-copyable-traders-edge',
    '30 */2 * * *',
    format($cmd$
      SELECT net.http_post(
        url := '%s/functions/v1/refresh-copyable-traders?batch=100&days=30',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := '{}'::jsonb
      );
    $cmd$, v_url, v_key)
  );

  RAISE NOTICE 'Scheduled refresh-copyable-traders-edge cron (every 2 hours at :30)';
END $$;
