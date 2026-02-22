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
4. **Non-sports markets (UFC, esports, soccer, etc.) are NOT covered by `events_window` mode** - only NBA/NHL/MLB/NFL/etc.

**How Resolution Works:**
1. The function queries unresolved markets from the `markets` table
2. For each market, it fetches data from `https://gamma-api.polymarket.com/markets/slug/{slug}`
3. If the Gamma API shows `closed: true` with `outcomePrices`, it extracts the winning outcome (highest price = winner)
4. It updates the `markets` table with `resolved=true` and `winning_outcome`

**Resolution Decision Logic** (in `computeResolutionDecision`):
```javascript
// A market is resolved if ANY of these are true:
const isResolved =
  gammaMarket.resolved === true ||           // Explicitly marked resolved
  isResolvedByStatus ||                       // umaResolutionStatus === 'resolved'
  Boolean(winningOutcomeRaw) ||               // Has winningOutcome field
  (looksSettledPrices && isClosed)            // Prices are 0/1 and market closed

// Winner is inferred from outcomePrices when not explicit:
// outcomePrices: ["0", "1"] with outcomes: ["Pacers", "Raptors"] → winner = "Raptors"
```

**Gamma API Response Example:**
```json
{
  "closed": true,
  "outcomes": "[\"Jazz\", \"Nets\"]",
  "outcomePrices": "[\"0\", \"1\"]",  // Nets won (index 1 has price 1)
  "umaResolutionStatus": "resolved",
  "events": [{ "title": "Nets vs. Jazz", "score": "109-99" }]
}
```

**Supported Event Types (with date-based slugs):**
- **US Sports:** `nba`, `nhl`, `mlb`, `nfl`, `cbb`, `cwbb` (women's), `ahl`
- **Soccer - Major:** `epl`, `efl`, `bun`, `mls`, `lal` (La Liga), `ser` (Serie A), `lig1`
- **Soccer - Other:** `copa`, `mex`, `bl2`, `aus`, `fl1`, `ere`, `elc`, `sea`, `spl`, `cbl`, `udi`, `acm`, `por`, `tur`, `egy1`, `bra`, `arg`, `chi1`, `col1`, `rou1`, `rusrp`, `es2`, `fr2`, `itsb`, `den`
- **Tennis:** `wta`, `atp`
- **UFC/Combat:** `ufc`
- **Esports:** `cs2`, `val`, `lol`, `dota2`, `rl`, `lec`, `lpl`, `lck`, `vct`, `hok` (Honor of Kings), `r6siege`
- **Basketball - Intl:** `bkkbl`, `bknbl`, `euroleague`, `shl`
- **Cricket:** `crint`

**NOT covered (no date-based slug pattern):**
- Weather markets (`highest-temperature-in-...`)
- Prediction markets (`will-...`, `bitcoin-up-or-down-...`)
- These resolve through `mode=due` when they close on Polymarket

**Sync Modes Available:**
- `mode=recent` - Markets with recent trades (default)
- `mode=events_recent` - Event-based markets from recent trades
- `mode=events_window&days=5` - Event-based markets in date window (bumped from 3→5 days)
- `mode=events_due` - Unresolved event markets not recently checked
- `mode=paper_open` - **PRIORITY**: Markets with OPEN paper positions (prevents exposure cap deadlock)
- `mode=due` - Any unresolved markets not checked in `recheck_hours`
- `mode=updown_window` - Crypto updown markets near close
- `event_slug=xxx` - Sync specific event by slug
- `market_id=xxx` - Sync specific market by conditionId

**Manual Sync Commands:**
```bash
# Sync specific event (sports, esports, UFC, etc.)
curl -X POST "https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?event_slug=nba-ind-tor-2026-02-08"
curl -X POST "https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?event_slug=cs2-vit-mouz-2026-02-07"
curl -X POST "https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?event_slug=ufc-mic1-mar14-2026-02-07"

# Sync by market_id (fallback for markets without proper slugs)
curl -X POST "https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?market_id=0x..."

# Batch sync unresolved markets
curl -X POST "https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/sync-market-resolutions?mode=due&batch=100&recheck_hours=0"
```

**If trades still show "Pending" after event ended:**
1. Get the market's `conditionId` from the `trades` table
2. Check if market has a `slug` in the `markets` table
3. Verify Gamma API returns resolution data: `curl https://gamma-api.polymarket.com/markets?condition_ids=0x...`
4. If Gamma shows resolved, manually trigger sync with `market_id` parameter
5. If no slug exists, the sync will use the conditionId fallback lookup

### Trades Table — Pagination & Query Pitfalls

**⚠️ CRITICAL: The `trades` table is large and has bitten us multiple times. Always paginate.**

**The Problem (fixed 2026-02-19):** `refresh-top-traders` and `refresh-copyable-traders` used `.limit(1000)` and `.limit(500)` respectively when fetching trades per trader. Active traders with 2,000+ trades had their win/loss counts silently undercounted because Supabase returns at most `limit` rows with no warning.

**Example:** Trader 0xe90b had 2,366+ trades but only 1,000 were fetched → 22 markets completely missed → wrong win/loss record and rank.

**The Fix:** Both functions now use paginated fetching:
```typescript
// fetchAllTrades() — paginate with .range(), PAGE_SIZE=1000, cap at 10,000
while (offset < MAX_TRADES_PER_TRADER) {
  query = query.range(offset, offset + PAGE_SIZE - 1);
  // ... break when data.length < PAGE_SIZE
  offset += PAGE_SIZE;
}

// fetchResolvedMarkets() — chunk .in() queries, 200 IDs per chunk
for (let i = 0; i < marketIds.length; i += MARKET_CHUNK_SIZE) {
  const chunk = marketIds.slice(i, i + MARKET_CHUNK_SIZE);
  // ... query with .in("id", chunk)
}
```

**Rules for querying the trades table:**
1. **NEVER use `.limit()` without pagination** — you will silently lose data for active traders
2. **Always use `.range(offset, offset + PAGE_SIZE - 1)`** and loop until `data.length < PAGE_SIZE`
3. **Supabase REST API has a default 1,000-row cap** even without `.limit()` — you MUST paginate
4. **`.in()` has array size limits** — chunk market ID arrays into batches of 200
5. **Trader discovery queries are also biased** — ordering by `amount DESC` only finds traders with big single trades, not frequent medium-size traders. Paginate discovery too and include existing ranked traders for re-evaluation.
6. **The `trades` table has no row-count endpoint** — you can't know in advance how many rows a trader has. Always paginate defensively.

**Current pagination constants (in both refresh functions):**
- `PAGE_SIZE = 1000` (rows per page)
- `MAX_TRADES_PER_TRADER = 10000` (safety cap)
- `MARKET_CHUNK_SIZE = 200` (for `.in()` queries)
- Discovery: 5,000 rows for top-traders, 3,000 for copyable-traders

**Files with pagination:**
- `supabase/functions/refresh-top-traders/index.ts` — `fetchAllTrades()`, `fetchResolvedMarkets()`, `discoverTraders()`
- `supabase/functions/refresh-copyable-traders/index.ts` — `fetchAllTrades()`, `fetchResolvedMarkets()`, paginated discovery in serve handler

**If win/loss counts look wrong or stale:**
1. Check if the trader has more trades than the pagination cap (unlikely but possible)
2. Check if the refresh functions ran recently: `top_traders.updated_at`, `copyable_traders.updated_at`
3. Check if markets are resolved: some "missing" wins/losses are actually unresolved markets, not pagination bugs
4. Run a manual refresh: `curl -X POST .../refresh-top-traders?limit=50&min_resolved=5`

### Copy Trading System

**Paper copy trading** runs every 15 minutes via GitHub Actions (in `sync-trades.yml`).

**Pipeline order (all sequential in the workflow):**
1. `fetch-trades` — Sync trades from Polymarket API
2. `populate-markets-from-trades` — Ensure markets table has entries for all traded markets
3. `sync-market-resolutions` (multiple modes) — Resolve settled markets
4. `refresh-copyable-traders` — Update 30-day rankings
5. `refresh-top-traders` — Update all-time rankings
6. `run-paper-copy` — Execute paper copy trades based on enabled traders
7. `sync-market-resolutions?mode=paper_open` — **PRIORITY**: Resolve markets with OPEN paper positions
8. `settle-paper-positions` — Settle paper positions on resolved markets

**Copy trading safeguards (added 2026-02-17):**
- **Rank gate:** Only copies from traders within top N rankings (`max_copyable_rank_30d`, default 20)
- **Position cap:** Max concurrent open positions per trader (`max_open_positions`, default 5)
- **Rank decay detection:** Warns when trader falls 10+ spots from `previous_rank_30d`
- **Staleness check:** Won't copy if rankings are >24 hours old (`MAX_RANKINGS_AGE_HOURS`)
- **Rank at entry tracking:** `paper_positions.rank_at_entry`, `roi_at_entry`, `pl_at_entry` for post-analysis

**Key tables:**
- `copy_traders` — Enabled traders with per-trader config (`max_copyable_rank_30d`, `max_open_positions`, `previous_rank_30d`)
- `paper_positions` — Paper trade positions with status (OPEN/SETTLED/CANCELED)
- `paper_portfolio_pnl_summary` — Aggregated P/L view
- `paper_positions_with_price` — Positions joined with current market prices

**Relevant migration:** `20260217000000_add_rank_tracking_to_paper_positions.sql`

## Common Issues

1. **"Win/loss data not showing"** → Backend needs `sync-resolutions` function to run
2. **"Blue colors in Below Deck mode"** → Replace with retroColors equivalents
3. **"Market links wrong"** → Backend needs to store full `slug` not just `id`
4. **"Sports bet title shows 'Spread: Team'"** → `formatGameTitle()` converts slug to "Team vs Team" format
5. **"Game ended but still Pending"** → Market resolution hasn't synced yet; check Gamma API and manually trigger sync if needed
6. **"Win/loss counts seem too low for active traders"** → Likely a pagination bug. Check that the refresh functions use `fetchAllTrades()` with `.range()` pagination, NOT `.limit()`. See "Trades Table — Pagination & Query Pitfalls" above.
7. **"Leaderboard not updating"** → Check `trader_rankings.computed_at` — if stale, the refresh functions may be failing. Check GitHub Actions logs.
8. **"Copy trader using outdated rankings"** → `run-paper-copy` has a 24-hour staleness check. If rankings haven't refreshed, it returns 503 and skips copying.
9. **"Paper P/L frozen / no new positions despite Telegram wagers"** → **Exposure cap deadlock.** Stale OPEN positions for already-resolved markets lock up exposure, preventing new trades. The `mode=paper_open` sync step (added to the workflow before `settle-paper-positions`) prevents this by prioritizing resolution of markets with OPEN paper positions. If it recurs: check `paper_positions WHERE status='OPEN'` and verify their markets are resolved. Manual fix: `curl -X POST .../sync-market-resolutions?mode=paper_open&recheck_hours=0` then `curl -X POST .../settle-paper-positions`.
10. **"Events window missing older games"** → `events_window` days was bumped from 3→5 to catch games that take a few days to resolve (UCL midweek games checked on weekend, etc.).
