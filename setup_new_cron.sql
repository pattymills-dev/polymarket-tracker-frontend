-- First, list existing cron jobs to see what's there
SELECT jobid, jobname, schedule, active FROM cron.job;

-- Create a new cron job that cycles through offsets
-- Runs every 5 minutes and uses the minute to determine offset
SELECT cron.schedule(
    'sync-resolutions-rotating',
    '*/5 * * * *',
    $$
    SELECT net.http_post(
        url := 'https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?batch=20',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo'
        )
    ) AS request_id;
    $$
);

-- Verify job was created
SELECT jobid, jobname, schedule, active FROM cron.job;
