-- Safe deletes for cache refresh functions when called via PostgREST.

CREATE OR REPLACE FUNCTION refresh_top_traders()
RETURNS void AS $$
BEGIN
  DELETE FROM top_traders WHERE TRUE;

  INSERT INTO top_traders (trader_address, total_pl, total_buy_cost, resolved_markets, win_rate, wins, losses, rank, updated_at)
  SELECT
    trader_address,
    total_pl,
    total_buy_cost,
    resolved_markets,
    win_rate * 100,
    wins,
    losses,
    ROW_NUMBER() OVER (ORDER BY total_pl DESC) as rank,
    NOW()
  FROM calculate_trader_performance(3)
  ORDER BY total_pl DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_whale_volume_traders(
  p_min_amount NUMERIC DEFAULT 1000,
  p_days INT DEFAULT 30
)
RETURNS void AS $$
BEGIN
  DELETE FROM whale_volume_traders WHERE TRUE;

  INSERT INTO whale_volume_traders (
    trader_address,
    total_volume,
    trade_count,
    avg_trade_size,
    unique_markets,
    last_trade_at,
    rank,
    updated_at
  )
  SELECT
    trader_address,
    SUM(amount) AS total_volume,
    COUNT(*)::INT AS trade_count,
    AVG(amount) AS avg_trade_size,
    COUNT(DISTINCT market_id)::INT AS unique_markets,
    MAX(timestamp) AS last_trade_at,
    ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC) AS rank,
    NOW()
  FROM trades
  WHERE trader_address IS NOT NULL
    AND amount >= p_min_amount
    AND timestamp >= NOW() - (p_days || ' days')::interval
  GROUP BY trader_address
  ORDER BY SUM(amount) DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_trader_open_exposure(
  p_min_amount NUMERIC DEFAULT 1000,
  p_min_net_shares NUMERIC DEFAULT 0.000001
)
RETURNS void AS $$
BEGIN
  DELETE FROM trader_open_exposure WHERE TRUE;

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
