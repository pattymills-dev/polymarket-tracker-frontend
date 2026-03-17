-- Reopen sports-derived markets for paper trading and start a fresh reporting window.

UPDATE paper_portfolios
SET starting_usd = 500,
    updated_at = NOW();

INSERT INTO paper_strategy_resets (portfolio_id, label, reset_at, notes)
SELECT
  p.id,
  'sports_reopen_2026_03_16',
  NOW(),
  'Restart paper tracking with sports, totals, spreads, moneyline, and other sports-derived markets reintroduced.'
FROM paper_portfolios p
WHERE NOT EXISTS (
  SELECT 1
  FROM paper_strategy_resets r
  WHERE r.portfolio_id = p.id
    AND r.label = 'sports_reopen_2026_03_16'
);
