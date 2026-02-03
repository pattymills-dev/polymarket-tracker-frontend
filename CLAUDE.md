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

### Sports Bet Title Formatting

**The Problem:** Sports spread bets display titles like "Spread: Jazz (-2.5)" instead of "Nets vs Jazz".

**Solution:** The `formatGameTitle()` function in App.js parses the market slug to extract team codes and displays them as "Away vs Home" format.

**Slug Format:** `{league}-{away_code}-{home_code}-{date}-{type}`
- Example: `nba-bkn-uta-2026-01-30-spread-home-2pt5` → "Nets vs Jazz"

**Team Code Mapping:** The function includes NBA and NHL team code mappings (e.g., `BKN` → `Nets`, `UTA` → `Jazz`).

### Market Resolution Sync

**The Problem:** Games that have already completed still show "(Pending)" because the resolution data hasn't synced.

**Root Cause:** The `sync-market-resolutions` edge function runs every 15 minutes via GitHub Actions, but:
1. It only processes 50 markets per run (configurable via `?batch=X`)
2. It prioritizes markets with recent trades (`mode=recent`)
3. Older markets may take time to get processed

**How Resolution Works:**
1. The function queries unresolved markets from the `markets` table
2. For each market, it fetches data from `https://gamma-api.polymarket.com/markets/slug/{slug}`
3. If the Gamma API shows `closed: true` with `outcomePrices`, it extracts the winning outcome (highest price = winner)
4. It updates the `markets` table with `resolved=true` and `winning_outcome`

**Gamma API Response Example:**
```json
{
  "closed": true,
  "outcomes": "[\"Jazz\", \"Nets\"]",
  "outcomePrices": "[\"0\", \"1\"]",  // Nets won (index 1 has price 1)
  "events": [{ "title": "Nets vs. Jazz", "score": "109-99" }]
}
```

**If trades still show "Pending" after game ended:**
1. Check if the market exists in `markets` table with correct `slug`
2. Manually trigger the sync: `POST /functions/v1/sync-market-resolutions?batch=100`
3. Verify the Gamma API returns `closed: true` for that market

## Common Issues

1. **"Win/loss data not showing"** → Backend needs `sync-resolutions` function to run
2. **"Blue colors in Below Deck mode"** → Replace with retroColors equivalents
3. **"Market links wrong"** → Backend needs to store full `slug` not just `id`
4. **"Sports bet title shows 'Spread: Team'"** → `formatGameTitle()` converts slug to "Team vs Team" format
5. **"Game ended but still Pending"** → Market resolution hasn't synced yet; check Gamma API and manually trigger sync if needed
