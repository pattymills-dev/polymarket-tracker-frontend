# SELL Trades Implementation Guide

## Overview
This guide provides step-by-step instructions to fix SELL trade handling end-to-end.

---

## 1. Update Supabase Edge Function: `fetch-trades`

### Location
Your Supabase Edge Functions (backend repository or Supabase dashboard)

### Changes Required

```typescript
// fetch-trades/index.ts

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Fetch trades from Polymarket API
    const response = await fetch(
      'https://data-api.polymarket.com/trades?limit=500',
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    )

    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status}`)
    }

    const trades = await response.json()

    // 🔍 AUDIT: Count BUY vs SELL
    let buyCount = 0
    let sellCount = 0
    const sellExamples = []

    // Process and map trades
    const mappedTrades = trades.map((t: any) => {
      const side = t.side?.toUpperCase() || 'BUY'
      const shares = parseFloat(t.size || t.shares || 0)
      const price = parseFloat(t.price || 0)
      const amount = shares * price

      // Count for audit
      if (side === 'BUY') {
        buyCount++
      } else if (side === 'SELL') {
        sellCount++
        if (sellExamples.length < 5) {
          sellExamples.push({
            tx: t.transactionHash?.slice(0, 10),
            side,
            shares,
            price,
            amount,
            outcome: t.outcome
          })
        }
      }

      return {
        tx_hash: t.transactionHash,
        market_id: t.market_id || t.asset_id,
        trader_address: t.maker_address || t.trader_address,
        outcome: t.outcome,
        side, // ✅ Store side
        shares, // ✅ Store shares explicitly
        price,
        amount, // Notional value
        timestamp: t.timestamp || new Date().toISOString(),
        market_slug: t.market_slug,
        market_title: t.market_title || t.title
      }
    })

    // 🔧 IMPROVED DEDUPING: Use composite key if needed
    // If multiple trades share same tx_hash, we need better deduping
    const uniqueTrades = []
    const seen = new Set()

    for (const trade of mappedTrades) {
      // Create composite key: tx_hash + outcome + side
      // This allows multiple trades per tx if they differ in outcome/side
      const key = `${trade.tx_hash}-${trade.outcome}-${trade.side}`

      if (!seen.has(key) && trade.tx_hash) {
        seen.add(key)
        uniqueTrades.push(trade)
      }
    }

    // Upsert to database
    const { error: upsertError } = await supabaseClient
      .from('trades')
      .upsert(uniqueTrades, {
        onConflict: 'tx_hash', // Or use composite unique constraint
        ignoreDuplicates: false
      })

    if (upsertError) {
      console.error('Upsert error:', upsertError)
      throw upsertError
    }

    // ✅ Return audit counts
    return new Response(
      JSON.stringify({
        success: true,
        fetched: trades.length,
        stored: uniqueTrades.length,
        buyCount,
        sellCount,
        sellExamples,
        message: `Stored ${uniqueTrades.length} trades (${buyCount} buys, ${sellCount} sells)`
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})
```

---

## 2. Update Database Schema

### Run in Supabase SQL Editor

```sql
-- Add shares column if missing
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS shares numeric;

-- Ensure side column exists
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS side text;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_trades_side ON trades(side);
CREATE INDEX IF NOT EXISTS idx_trades_amount_desc ON trades(amount DESC);

-- Update constraint to allow composite uniqueness (optional)
-- This allows multiple trades per tx_hash if they differ
-- Only do this if Polymarket returns multiple rows per tx_hash
/*
ALTER TABLE trades
DROP CONSTRAINT IF EXISTS trades_tx_hash_key;

ALTER TABLE trades
ADD CONSTRAINT trades_unique_trade
UNIQUE (tx_hash, outcome, side);
*/

-- Backfill shares from amount/price where shares is null
UPDATE trades
SET shares = CASE
  WHEN price > 0 THEN amount / price
  ELSE 0
END
WHERE shares IS NULL AND amount IS NOT NULL;
```

---

## 3. Verify Sells Exist (Sanity Check)

### Run in Supabase SQL Editor

```sql
-- Check side distribution
SELECT
  side,
  COUNT(*) as trade_count,
  SUM(amount)::numeric::money as total_volume
FROM trades
GROUP BY side
ORDER BY trade_count DESC;

-- Check large sells
SELECT
  market_title,
  trader_address,
  side,
  shares,
  price,
  amount,
  timestamp
FROM trades
WHERE side = 'SELL'
  AND amount >= 10000
ORDER BY amount DESC
LIMIT 20;

-- Check if we have both buys and sells for same trader
SELECT
  trader_address,
  COUNT(CASE WHEN side = 'BUY' THEN 1 END) as buys,
  COUNT(CASE WHEN side = 'SELL' THEN 1 END) as sells,
  SUM(CASE WHEN side = 'BUY' THEN amount ELSE 0 END)::numeric::money as buy_volume,
  SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END)::numeric::money as sell_volume
FROM trades
GROUP BY trader_address
HAVING COUNT(CASE WHEN side = 'SELL' THEN 1 END) > 0
ORDER BY sells DESC
LIMIT 20;
```

---

## 4. Update Trader Position View

### Create/Update in Supabase SQL Editor

```sql
-- Create or replace view for trader positions
CREATE OR REPLACE VIEW trader_market_positions AS
SELECT
  trader_address,
  market_id,
  outcome,

  -- Share tracking
  SUM(CASE WHEN side = 'BUY' THEN shares ELSE 0 END) as buy_shares,
  SUM(CASE WHEN side = 'SELL' THEN shares ELSE 0 END) as sell_shares,
  SUM(CASE WHEN side = 'BUY' THEN shares ELSE 0 END) -
    SUM(CASE WHEN side = 'SELL' THEN shares ELSE 0 END) as net_shares,

  -- Cost tracking
  SUM(CASE WHEN side = 'BUY' THEN amount ELSE 0 END) as buy_cost,
  SUM(CASE WHEN side = 'SELL' THEN amount ELSE 0 END) as sell_proceeds,

  -- Average prices
  AVG(CASE WHEN side = 'BUY' THEN price END) as avg_buy_price,
  AVG(CASE WHEN side = 'SELL' THEN price END) as avg_sell_price,

  -- Trade counts
  COUNT(CASE WHEN side = 'BUY' THEN 1 END) as buy_count,
  COUNT(CASE WHEN side = 'SELL' THEN 1 END) as sell_count,

  MAX(timestamp) as last_trade_time
FROM trades
WHERE trader_address IS NOT NULL
GROUP BY trader_address, market_id, outcome;
```

---

## 5. Update P/L Calculation Function

### Create/Update in Supabase SQL Editor

```sql
-- Update or create function for trader performance
CREATE OR REPLACE FUNCTION calculate_trader_performance(min_resolved_markets int DEFAULT 1)
RETURNS TABLE (
  trader_address text,
  total_buy_cost numeric,
  total_sell_proceeds numeric,
  resolved_markets bigint,
  wins bigint,
  losses bigint,
  win_rate numeric,
  profit_wins bigint,
  profit_losses bigint,
  profitability_rate numeric,
  total_pl numeric,
  realized_pl numeric,
  settlement_pl numeric
) AS $$
BEGIN
  RETURN QUERY
  WITH resolved_positions AS (
    SELECT
      t.trader_address,
      t.market_id,
      t.outcome,
      m.resolved,
      m.winning_outcome,

      -- Share aggregation
      SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END) as buy_shares,
      SUM(CASE WHEN t.side = 'SELL' THEN t.shares ELSE 0 END) as sell_shares,
      SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END) -
        SUM(CASE WHEN t.side = 'SELL' THEN t.shares ELSE 0 END) as net_shares,

      -- Cost tracking
      SUM(CASE WHEN t.side = 'BUY' THEN t.amount ELSE 0 END) as buy_cost,
      SUM(CASE WHEN t.side = 'SELL' THEN t.amount ELSE 0 END) as sell_proceeds,

      -- Average cost basis
      CASE
        WHEN SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END) > 0
        THEN SUM(CASE WHEN t.side = 'BUY' THEN t.amount ELSE 0 END) /
             SUM(CASE WHEN t.side = 'BUY' THEN t.shares ELSE 0 END)
        ELSE 0
      END as avg_buy_price

    FROM trades t
    LEFT JOIN markets m ON t.market_id = m.market_id
    WHERE m.resolved = true
    GROUP BY t.trader_address, t.market_id, t.outcome, m.resolved, m.winning_outcome
  ),
  position_pl AS (
    SELECT
      trader_address,
      market_id,
      outcome,
      buy_shares,
      sell_shares,
      net_shares,
      buy_cost,
      sell_proceeds,
      avg_buy_price,

      -- Realized P/L from sells (simplified: avg cost basis)
      sell_proceeds - (sell_shares * avg_buy_price) as realized_pl,

      -- Settlement P/L from remaining shares
      CASE
        WHEN winning_outcome = outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
        ELSE 0 - (net_shares * avg_buy_price)
      END as settlement_pl,

      -- Total P/L
      (sell_proceeds - (sell_shares * avg_buy_price)) +
      CASE
        WHEN winning_outcome = outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
        ELSE 0 - (net_shares * avg_buy_price)
      END as total_pl,

      -- Win/loss flags
      CASE
        WHEN winning_outcome = outcome THEN true
        ELSE false
      END as is_win,

      -- Profit flags (considering both realized and settlement)
      CASE
        WHEN (sell_proceeds - (sell_shares * avg_buy_price)) +
             CASE
               WHEN winning_outcome = outcome THEN net_shares * 1.0 - (net_shares * avg_buy_price)
               ELSE 0 - (net_shares * avg_buy_price)
             END > 0 THEN true
        ELSE false
      END as is_profitable

    FROM resolved_positions
  )
  SELECT
    p.trader_address,
    SUM(p.buy_cost)::numeric as total_buy_cost,
    SUM(p.sell_proceeds)::numeric as total_sell_proceeds,
    COUNT(DISTINCT p.market_id)::bigint as resolved_markets,
    COUNT(*) FILTER (WHERE p.is_win)::bigint as wins,
    COUNT(*) FILTER (WHERE NOT p.is_win)::bigint as losses,
    COALESCE(COUNT(*) FILTER (WHERE p.is_win)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as win_rate,
    COUNT(*) FILTER (WHERE p.is_profitable)::bigint as profit_wins,
    COUNT(*) FILTER (WHERE NOT p.is_profitable)::bigint as profit_losses,
    COALESCE(COUNT(*) FILTER (WHERE p.is_profitable)::numeric / NULLIF(COUNT(*)::numeric, 0), 0) as profitability_rate,
    SUM(p.total_pl)::numeric as total_pl,
    SUM(p.realized_pl)::numeric as realized_pl,
    SUM(p.settlement_pl)::numeric as settlement_pl
  FROM position_pl p
  GROUP BY p.trader_address
  HAVING COUNT(DISTINCT p.market_id) >= min_resolved_markets;
END;
$$ LANGUAGE plpgsql;
```

---

## 6. Test the Changes

### Step 1: Run sync and check response
After updating the Edge Function, run "Sync Polymarket" in the UI and check the browser console for the response. You should see:

```json
{
  "success": true,
  "fetched": 500,
  "stored": 485,
  "buyCount": 320,
  "sellCount": 165,
  "sellExamples": [
    {
      "tx": "0x1234...",
      "side": "SELL",
      "shares": 100.5,
      "price": 0.65,
      "amount": 65.325,
      "outcome": "Yes"
    }
  ]
}
```

### Step 2: Verify in database
Run the sanity check queries from section 3.

### Step 3: Check UI
After the frontend updates are deployed, you should see:
- SELL trades in "Large bets" feed
- Different visual styling for BUY vs SELL
- Proper labels showing direction

---

## Next Steps

1. **Update the Edge Function** with the code from section 1
2. **Run the SQL migrations** from section 2
3. **Verify sells exist** using queries from section 3
4. **Update views/functions** from sections 4-5
5. **Wait for frontend updates** (being implemented separately)
6. **Test end-to-end** using section 6

