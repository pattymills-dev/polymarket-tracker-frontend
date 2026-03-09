-- Start a fresh profitability measurement window after March 9 strategy updates.
INSERT INTO paper_strategy_resets (portfolio_id, label, reset_at, notes)
VALUES (
  1,
  'profitability_update_2026_03_09',
  NOW(),
  'Post-lockdown baseline: compact Telegram format + early paper loss kill-switch.'
);

