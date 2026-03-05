-- Persist strategy reset markers and send paper PnL alerts relative to latest reset.

CREATE TABLE IF NOT EXISTS paper_strategy_resets (
  id BIGSERIAL PRIMARY KEY,
  portfolio_id BIGINT REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_strategy_resets_portfolio_reset_at
  ON paper_strategy_resets (portfolio_id, reset_at DESC);

-- Seed a marker for the March 5, 2026 profitability update (once).
INSERT INTO paper_strategy_resets (portfolio_id, label, reset_at, notes)
SELECT
  p.id,
  'profitability_update_2026_03_05',
  NOW(),
  'Baseline refresh to $500 with updated copy filters and execution safety.'
FROM paper_portfolios p
WHERE NOT EXISTS (
  SELECT 1
  FROM paper_strategy_resets r
  WHERE r.label = 'profitability_update_2026_03_05'
    AND r.portfolio_id = p.id
);

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job not available, skipping paper PnL alert reschedule';
    RETURN;
  END IF;

  -- Replace existing alert job to track post-reset performance by default.
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'paper-pnl-telegram-alert';

  PERFORM cron.schedule(
    'paper-pnl-telegram-alert',
    '0 */4 * * *',
    $cmd$
    SELECT net.http_post(
      url := current_setting('app.settings.supabase_url', true) || '/functions/v1/paper-pnl-telegram-alert?scope=since_reset',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := '{}'::jsonb
    );
    $cmd$
  );
END $$;

