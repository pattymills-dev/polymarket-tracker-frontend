-- Schedule refresh-market-stats to run every 15 minutes
-- This keeps market volume and liquidity data fresh for Isolated Contact detection

-- Note: pg_cron and pg_net should already be enabled on Supabase

-- Schedule the job to call the Edge Function every 15 minutes
-- Using net.http_post to call the Edge Function
SELECT cron.schedule(
  'refresh-market-stats',  -- job name
  '*/15 * * * *',          -- every 15 minutes
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/refresh-market-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Also schedule recalculate_trader_stats to run periodically
SELECT cron.schedule(
  'recalculate-trader-stats',  -- job name
  '5,20,35,50 * * * *',        -- at 5, 20, 35, 50 minutes past each hour
  $$
  SELECT recalculate_trader_stats();
  $$
);
