-- Update cron job to use batch size 20 (to avoid URL too large errors)

-- Remove old job
SELECT cron.unschedule('sync-market-resolutions-every-15min');

-- Create new job with batch=20
SELECT cron.schedule(
    'sync-market-resolutions-every-15min',
    '*/15 * * * *',
    $$
    SELECT
      net.http_post(
        url := 'https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?batch=20',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo'
        )
      ) AS request_id;
    $$
);

-- Verify
SELECT jobid, schedule, active, jobname
FROM cron.job
WHERE jobname = 'sync-market-resolutions-every-15min';
