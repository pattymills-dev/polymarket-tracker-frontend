-- Fix trader_open_exposure to reflect *actual open positions* in unresolved markets.
--
-- Issues addressed:
-- 1) Using `(m.resolved = false OR m.winning_outcome IS NULL)` can incorrectly include resolved markets
--    when `resolved` lags behind. We use `m.winning_outcome IS NULL` as the source of truth.
-- 2) Counting markets where net_shares = 0 inflates "open markets" (position fully closed).

CREATE OR REPLACE FUNCTION refresh_trader_open_exposure(
  p_min_amount NUMERIC DEFAULT 1000,
  p_min_net_shares NUMERIC DEFAULT 0.000001
)
RETURNS void AS $$
BEGIN
  DELETE FROM trader_open_exposure;

  WITH open_positions AS (
    SELECT
      t.trader_address,
      t.market_id,
      t.outcome,
      SUM(
        CASE
          WHEN COALESCE(t.side, 'BUY') = 'BUY'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END
      ) AS buy_shares,
      SUM(
        CASE
          WHEN t.side = 'SELL'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END
      ) AS sell_shares,
      CASE
        WHEN SUM(
          CASE
            WHEN COALESCE(t.side, 'BUY') = 'BUY'
            THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
            ELSE 0
          END
        ) > 0
        THEN
          SUM(CASE WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0 END) /
          SUM(
            CASE
              WHEN COALESCE(t.side, 'BUY') = 'BUY'
              THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
              ELSE 0
            END
          )
        ELSE 0
      END AS avg_buy_price,
      MAX(t.timestamp) AS last_trade_at
    FROM trades t
    JOIN markets m ON m.id = t.market_id
    WHERE m.winning_outcome IS NULL
      AND t.trader_address IS NOT NULL
      AND t.amount >= p_min_amount
    GROUP BY t.trader_address, t.market_id, t.outcome
  ),
  position_net AS (
    SELECT
      trader_address,
      market_id,
      (buy_shares - sell_shares) AS net_shares,
      avg_buy_price,
      last_trade_at
    FROM open_positions
    WHERE ABS(buy_shares - sell_shares) > p_min_net_shares
  ),
  market_agg AS (
    SELECT
      trader_address,
      COUNT(DISTINCT market_id)::INT AS open_markets,
      SUM((net_shares * avg_buy_price))::NUMERIC AS open_cost,
      SUM(ABS(net_shares) * avg_buy_price)::NUMERIC AS open_abs_exposure,
      MAX(last_trade_at) AS last_trade_at
    FROM position_net
    GROUP BY trader_address
  )
  INSERT INTO trader_open_exposure (
    trader_address,
    open_markets,
    open_cost,
    open_abs_exposure,
    last_trade_at,
    updated_at
  )
  SELECT
    trader_address,
    open_markets,
    open_cost,
    open_abs_exposure,
    last_trade_at,
    NOW()
  FROM market_agg;
END;
$$ LANGUAGE plpgsql;

