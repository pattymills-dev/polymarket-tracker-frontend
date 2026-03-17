-- Curate the paper copy lane around a rotating top-P/L shortlist.
-- Strategy:
-- - choose the top 3 traders by 30D realized P/L
-- - require solid ROI, enough resolved trades, current activity, and decent confidence
-- - allow specialists; rotate the roster as rankings change instead of filtering them out
-- - remove pinned exceptions so the shortlist becomes the live source of truth

ALTER TABLE copy_traders
  ALTER COLUMN min_price SET DEFAULT 0.15;

ALTER TABLE copy_traders
  ALTER COLUMN max_price SET DEFAULT 0.92;

ALTER TABLE copy_traders
  ALTER COLUMN max_copyable_rank_30d SET DEFAULT 25;

ALTER TABLE copy_traders
  ALTER COLUMN min_realized_roi_30d SET DEFAULT 0.20;

ALTER TABLE copy_traders
  ALTER COLUMN min_realized_pl_30d SET DEFAULT 150000;

ALTER TABLE copy_traders
  ALTER COLUMN min_resolved_trades_30d SET DEFAULT 25;

ALTER TABLE copy_traders
  ALTER COLUMN min_confidence_30d SET DEFAULT 2;

CREATE OR REPLACE FUNCTION sync_top_copyable_traders(
  p_limit INT DEFAULT 3
)
RETURNS INT AS $$
DECLARE
  v_upserts INT := 0;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 3), 1), 3);
BEGIN
  WITH recent_activity AS (
    SELECT
      t.trader_address,
      COUNT(*) FILTER (
        WHERE t.timestamp >= NOW() - INTERVAL '7 days'
      )::INT AS recent_trades_7d
    FROM trades t
    GROUP BY t.trader_address
  ),
  shortlist AS (
    SELECT
      tr.trader_address,
      tr.copyable_rank_30d,
      tr.realized_pl_30d,
      tr.realized_roi_30d,
      tr.resolved_trades_30d,
      tr.confidence_30d,
      COALESCE(ra.recent_trades_7d, 0) AS recent_trades_7d
    FROM trader_rankings tr
    LEFT JOIN recent_activity ra
      ON ra.trader_address = tr.trader_address
    WHERE tr.copyable_rank_30d IS NOT NULL
      AND COALESCE(tr.copyable_rank_30d, 9999) <= 25
      AND COALESCE(tr.realized_pl_30d, 0) >= 150000
      AND COALESCE(tr.realized_roi_30d, 0) >= 0.20
      AND COALESCE(tr.resolved_trades_30d, 0) >= 25
      AND COALESCE(tr.confidence_30d, 0) >= 2
      AND COALESCE(ra.recent_trades_7d, 0) >= 10
    ORDER BY
      tr.realized_pl_30d DESC,
      tr.realized_roi_30d DESC,
      tr.resolved_trades_30d DESC,
      tr.copyable_rank_30d ASC
    LIMIT v_limit
  ),
  disabled AS (
    UPDATE copy_traders ct
    SET enabled = false,
        pinned = false,
        updated_at = NOW()
    WHERE (ct.enabled = true OR ct.pinned = true)
      AND NOT EXISTS (
        SELECT 1
        FROM shortlist s
        WHERE s.trader_address = ct.wallet
      )
    RETURNING ct.wallet
  ),
  upserted AS (
    INSERT INTO copy_traders (
      wallet,
      enabled,
      pinned,
      allow_sells,
      min_price,
      max_price,
      price_penalty,
      per_trader_cooldown_minutes,
      copy_factor,
      min_usd,
      max_usd,
      max_trader_exposure_pct,
      max_open_positions,
      max_copyable_rank_30d,
      min_realized_roi_30d,
      min_realized_pl_30d,
      min_resolved_trades_30d,
      min_confidence_30d,
      updated_at
    )
    SELECT
      s.trader_address,
      true,
      false,
      false,
      0.15,
      0.92,
      0.01,
      120,
      0.10,
      5,
      20,
      0.25,
      3,
      25,
      0.20,
      150000,
      25,
      2,
      NOW()
    FROM shortlist s
    ON CONFLICT (wallet) DO UPDATE SET
      enabled = true,
      pinned = false,
      allow_sells = false,
      min_price = 0.15,
      max_price = 0.92,
      price_penalty = 0.01,
      per_trader_cooldown_minutes = 120,
      copy_factor = 0.10,
      min_usd = 5,
      max_usd = 20,
      max_trader_exposure_pct = 0.25,
      max_open_positions = 3,
      max_copyable_rank_30d = 25,
      min_realized_roi_30d = 0.20,
      min_realized_pl_30d = 150000,
      min_resolved_trades_30d = 25,
      min_confidence_30d = 2,
      updated_at = NOW()
    RETURNING wallet
  ),
  reset_state AS (
    INSERT INTO copy_state (wallet, last_seen_ts, updated_at)
    SELECT
      s.trader_address,
      NOW(),
      NOW()
    FROM shortlist s
    ON CONFLICT (wallet) DO UPDATE SET
      last_seen_ts = EXCLUDED.last_seen_ts,
      updated_at = EXCLUDED.updated_at
    RETURNING wallet
  )
  SELECT COUNT(*) INTO v_upserts FROM upserted;

  RETURN v_upserts;
END;
$$ LANGUAGE plpgsql;

SELECT sync_top_copyable_traders(3);

INSERT INTO paper_strategy_resets (portfolio_id, label, reset_at, notes)
SELECT
  p.id,
  'copy_top_pl_shortlist_2026_03_16',
  NOW(),
  'Restarted paper copy trading around a rotating top-P/L shortlist with quality gates and automatic roster rotation.'
FROM paper_portfolios p
WHERE NOT EXISTS (
  SELECT 1
  FROM paper_strategy_resets r
  WHERE r.portfolio_id = p.id
    AND r.label = 'copy_top_pl_shortlist_2026_03_16'
);
