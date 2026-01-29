-- Diagnostic query to check winning_outcome population

-- 1. Check how many resolved markets have winning_outcome set
SELECT
  COUNT(*) as total_resolved,
  COUNT(winning_outcome) as has_winning_outcome,
  COUNT(*) - COUNT(winning_outcome) as missing_winning_outcome
FROM markets
WHERE resolved = true;

-- 2. Sample of resolved markets
SELECT
  id,
  question,
  resolved,
  winning_outcome,
  resolved_at
FROM markets
WHERE resolved = true
LIMIT 10;

-- 3. Check trades for a resolved market
SELECT
  m.question,
  m.winning_outcome,
  t.trader_address,
  t.outcome,
  t.side,
  t.shares,
  t.amount
FROM markets m
JOIN trades t ON m.id = t.market_id
WHERE m.resolved = true
  AND m.winning_outcome IS NOT NULL
LIMIT 20;

-- 4. Test the profitability function on a single trader
SELECT *
FROM calculate_trader_performance(1)
LIMIT 5;
