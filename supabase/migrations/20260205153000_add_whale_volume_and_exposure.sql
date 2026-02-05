-- Add whale volume leaderboard + open exposure cache + slug backfill helper

-- Whale volume leaderboard (30d, >= $1k by default)
CREATE TABLE IF NOT EXISTS whale_volume_traders (
  trader_address TEXT PRIMARY KEY,
  total_volume NUMERIC,
  trade_count INTEGER,
  avg_trade_size NUMERIC,
  unique_markets INTEGER,
  last_trade_at TIMESTAMPTZ,
  rank INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whale_volume_traders_rank ON whale_volume_traders(rank);

-- Open exposure summary (unresolved markets)
CREATE TABLE IF NOT EXISTS trader_open_exposure (
  trader_address TEXT PRIMARY KEY,
  open_markets INTEGER,
  open_cost NUMERIC,
  open_abs_exposure NUMERIC,
  last_trade_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_open_exposure_abs ON trader_open_exposure(open_abs_exposure);

-- Refresh whale volume leaderboard
CREATE OR REPLACE FUNCTION refresh_whale_volume_traders(
  p_min_amount NUMERIC DEFAULT 1000,
  p_days INT DEFAULT 30
)
RETURNS void AS $$
BEGIN
  DELETE FROM whale_volume_traders;

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

-- Refresh open exposure cache
CREATE OR REPLACE FUNCTION refresh_trader_open_exposure(
  p_min_amount NUMERIC DEFAULT 1000
)
RETURNS void AS $$
BEGIN
  DELETE FROM trader_open_exposure;

  WITH open_positions AS (
    SELECT
      t.trader_address,
      t.market_id,
      t.outcome,
      SUM(CASE
        WHEN COALESCE(t.side, 'BUY') = 'BUY'
        THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
        ELSE 0
      END) AS buy_shares,
      SUM(CASE
        WHEN t.side = 'SELL'
        THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
        ELSE 0
      END) AS sell_shares,
      SUM(CASE
        WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0
      END) AS buy_cost,
      SUM(CASE WHEN t.side = 'SELL' THEN t.amount ELSE 0 END) AS sell_proceeds,
      CASE
        WHEN SUM(CASE
          WHEN COALESCE(t.side, 'BUY') = 'BUY'
          THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
          ELSE 0
        END) > 0
        THEN SUM(CASE WHEN COALESCE(t.side, 'BUY') = 'BUY' THEN t.amount ELSE 0 END) /
             SUM(CASE
               WHEN COALESCE(t.side, 'BUY') = 'BUY'
               THEN COALESCE(t.shares, t.amount / NULLIF(t.price, 0))
               ELSE 0
             END)
        ELSE 0
      END AS avg_buy_price,
      MAX(t.timestamp) AS last_trade_at
    FROM trades t
    JOIN markets m ON m.id = t.market_id
    WHERE (m.resolved = false OR m.winning_outcome IS NULL)
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
    WHERE buy_shares > 0 OR sell_shares > 0
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

-- Backfill missing trade slugs from markets table
CREATE OR REPLACE FUNCTION backfill_trade_slugs()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE trades t
  SET
    market_slug = COALESCE(t.market_slug, m.slug),
    market_title = COALESCE(t.market_title, m.question)
  FROM markets m
  WHERE t.market_id = m.id
    AND (t.market_slug IS NULL OR t.market_title IS NULL);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- Refresh all trader caches (extend existing)
CREATE OR REPLACE FUNCTION refresh_all_trader_caches()
RETURNS void AS $$
BEGIN
  PERFORM refresh_top_traders();
  PERFORM refresh_hot_streaks();
  PERFORM refresh_whale_volume_traders();
  PERFORM refresh_trader_open_exposure();
END;
$$ LANGUAGE plpgsql;
