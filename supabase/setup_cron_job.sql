-- Setup Supabase Cron Job for Market Resolution Sync
-- This script sets up a cron job to automatically sync market resolutions every 15 minutes
--
-- To execute this script:
-- 1. Go to your Supabase Dashboard: https://supabase.com/dashboard/project/smuktlgclwvaxnduuinm
-- 2. Navigate to SQL Editor
-- 3. Create a new query and paste this entire script
-- 4. Run the script
-- 5. Verify the job is created by checking the output

-- Enable pg_cron extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant necessary permissions to the postgres role for http extension
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- Schedule the sync-market-resolutions function to run every 15 minutes
-- Remove any existing job with the same name first
SELECT cron.unschedule('sync-market-resolutions-every-15min');

-- Create the new cron job
-- This will call the Edge Function every 15 minutes with batch size of 250
SELECT cron.schedule(
    'sync-market-resolutions-every-15min',  -- Job name
    '*/15 * * * *',                          -- Every 15 minutes (cron format)
    $$
    SELECT
      net.http_post(
        url := 'https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?batch=250',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo'
        )
      ) AS request_id;
    $$
);

-- Verify the job was created
SELECT
    jobid,
    schedule,
    command,
    nodename,
    nodeport,
    database,
    username,
    active,
    jobname
FROM cron.job
WHERE jobname = 'sync-market-resolutions-every-15min';

-- Optional: View all cron jobs
-- SELECT * FROM cron.job;

-- Optional: Manually trigger the job to test (uncomment to use)
-- SELECT cron.schedule('manual-test', 'now', $$
--   SELECT net.http_post(
--     url := 'https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?batch=250',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo'
--     )
--   ) AS request_id;
-- $$);

-- Optional: To unschedule/remove the job (uncomment to use)
-- SELECT cron.unschedule('sync-market-resolutions-every-15min');
