-- Check if the cron job exists and is active
SELECT
    jobid,
    schedule,
    jobname,
    active,
    database
FROM cron.job
WHERE jobname = 'sync-market-resolutions-every-15min';

-- If the above returns no rows, the cron job was never set up
-- You'll need to run setup_cron_job.sql to create it
