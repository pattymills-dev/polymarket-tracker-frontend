-- Some execution contexts (e.g. PostgREST RPC) can reject unconditional DELETEs.
-- Use `WHERE TRUE` to keep the refresh idempotent while satisfying "safe update" guards.

CREATE OR REPLACE FUNCTION refresh_hot_streaks()
RETURNS void AS $$
BEGIN
  DELETE FROM hot_streaks WHERE TRUE;

  INSERT INTO hot_streaks (
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate,
    wins,
    losses,
    rank,
    updated_at,
    current_streak,
    recent_win_rate,
    recent_markets,
    last_resolved_at
  )
  SELECT
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate * 100,
    wins,
    losses,
    ROW_NUMBER() OVER (
      ORDER BY
        current_streak DESC,
        recent_win_rate DESC,
        (total_pl / NULLIF(total_buy_cost, 0)) DESC,
        resolved_markets DESC
    ) as rank,
    NOW(),
    COALESCE(current_streak, 0),
    COALESCE(recent_win_rate, win_rate),
    COALESCE(recent_markets, resolved_markets),
    last_resolved_at
  FROM calculate_trader_performance_with_streaks(5)
  WHERE COALESCE(recent_markets, resolved_markets) >= 5
    AND COALESCE(recent_win_rate, win_rate) >= 0.70
    AND total_pl > 0
    AND total_buy_cost >= 5000
  ORDER BY
    current_streak DESC,
    recent_win_rate DESC,
    (total_pl / NULLIF(total_buy_cost, 0)) DESC,
    resolved_markets DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

