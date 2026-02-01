# Polymarket Tracker Frontend - Claude Memory

## Critical Knowledge

### Win/Loss Data Display

**The Problem:** Trade cards show "Pending" instead of WIN/LOSS status because the backend's `markets` table is missing resolution data.

**Root Cause:** The backend needs:
1. `markets.resolved` column (BOOLEAN)
2. `markets.winning_outcome` column (TEXT)
3. A `sync-resolutions` edge function to populate this data from Polymarket API

**Frontend Logic:** (in App.js around line 366-373)
```javascript
const tradesWithResolution = trades.map(trade => {
  const market = marketMap.get(trade.market_id);
  return {
    ...trade,
    market_resolved: market?.resolved || false,
    winning_outcome: market?.winning_outcome || null
  };
});
```

**If trades show "Pending":** The backend's `sync-resolutions` function needs to run to update market resolution data.

### Theme System (Below Deck / Bridge View)

**retroColors palette:**
```javascript
const retroColors = {
  bg: '#060908',           // Near-black, green cast
  surface: '#0b100d',      // Recessed panels
  surfaceAlt: '#0e1410',   // Raised elements
  border: 'rgba(90, 200, 140, 0.12)',
  borderHover: 'rgba(90, 200, 140, 0.25)',
  primary: '#5a8a6a',      // Main text
  bright: '#6ddb8a',       // Emphasis, wins
  dim: '#3a5a48',          // Secondary text
  accent: '#c9a84b',       // Gold highlights
  danger: '#b85c5c',       // Errors, losses
  glow: 'rgba(109, 219, 138, 0.15)',
};
```

**NO BLUE/CYAN in Below Deck mode!** All blue colors must be replaced with retroColors equivalents.

### Market Links

**The Problem:** Links go to sport category instead of specific market.

**Solution:** The backend must store the full `slug` from Polymarket API. URL format:
- `https://polymarket.com/event/{event-slug}` for events
- `https://polymarket.com/market/{market-slug}` for markets

### Leaderboard Sorting

Current options:
- **P/L** (total_pl): Total realized profit/loss
- **Hot Streak** (hot_streak): Combo of win streak + recent accuracy

Removed options (per user request):
- Profit % (profitability)
- Win % (win_rate)

### Supabase Endpoints Used

```javascript
const SUPABASE_URL = 'https://smuktlgclwvaxnduuinm.supabase.co';

// Trades feed
`${SUPABASE_URL}/rest/v1/trades?amount=gte.${MIN_TRADE_AMOUNT}&order=timestamp.desc&limit=${FEED_LIMIT}`

// Markets (for resolution data)
`${SUPABASE_URL}/rest/v1/markets?id=in.(${marketIds.join(',')})&select=id,resolved,winning_outcome`

// Trader performance RPC
`${SUPABASE_URL}/rest/v1/rpc/calculate_trader_performance`
```

## Common Issues

1. **"Win/loss data not showing"** → Backend needs `sync-resolutions` function to run
2. **"Blue colors in Below Deck mode"** → Replace with retroColors equivalents
3. **"Market links wrong"** → Backend needs to store full `slug` not just `id`
