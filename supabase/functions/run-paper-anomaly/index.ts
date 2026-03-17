import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeFixedStakeUsdSize } from "../run-paper-copy/sizing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STRATEGY_LANE = "anomaly";
const STRATEGY_TAG = "ranked_anomaly_follow";
const EXECUTION_TYPE = "clob_book_follow";
const CLOB_URL = "https://clob.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";

const DEFAULT_MAX_TRADE_AGE_MINUTES = 15;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 20;
const MAX_NEW_POSITIONS_PER_RUN = 4;
const MAX_WALLETS = 12;
const MAX_RANK = 12;
const MIN_CONFIDENCE = 2;
const MIN_RESOLVED_TRADES = 20;
const MIN_ROI = 0.2;
const MIN_REALIZED_PL = 10000;
const MIN_PRICE = 0.12;
const MAX_PRICE = 0.88;
const MIN_MARKET_LIQUIDITY = 50000;
const MIN_MINUTES_TO_CLOSE = 20;
const MAX_MINUTES_TO_CLOSE = 36 * 60;
const COOLDOWN_HOURS = 12;
const RAPID_FIRE_WINDOW_MINUTES = 10;
const RAPID_FIRE_MIN_COUNT = 3;
const EVENT_SWEEP_WINDOW_HOURS = 6;
const EVENT_SWEEP_MIN_MARKETS = 2;
const MAX_TOTAL_EXPOSURE_PCT = 0.25;
const MAX_TRADER_EXPOSURE_PCT = 0.10;
const MAX_MARKET_EXPOSURE_PCT = 0.08;
const BASE_FIXED_USD = 8;
const MIN_FIXED_USD = 6;
const MAX_FIXED_USD = 12;
const TAKE_PROFIT_PCT = 0.08;
const STOP_LOSS_PCT = -0.12;
const SOFT_MAX_HOLD_HOURS = 4;
const HARD_MAX_HOLD_HOURS = 12;
const CLOSE_TIME_GUARD_MINUTES = 30;
const LATENCY_BPS = 12;
const DEFAULT_FEE_BPS = 0;

const BLACKLISTED_SLUG_PREFIXES = [
  "lol-",
  "cs2-",
  "val-",
  "dota2-",
  "rl-",
  "lec-",
  "lpl-",
  "lck-",
  "vct-",
  "hok-",
  "r6siege-",
  "btc-updown-",
  "eth-updown-",
  "sol-updown-",
];

const ALERT_WEIGHTS: Record<string, number> = {
  dormant_whale: 4,
  isolated_contact: 4,
  whale_position: 2,
  tail_risk: 1,
};

type RankingRow = {
  trader_address: string | null;
  copyable_rank_30d: number | string | null;
  realized_roi_30d: number | string | null;
  realized_pl_30d: number | string | null;
  median_bet_30d: number | string | null;
  resolved_trades_30d: number | string | null;
  confidence_30d: number | string | null;
  computed_at: string | null;
};

type TradeRow = {
  tx_hash: string | null;
  trader_address: string | null;
  market_id: string | null;
  market_slug: string | null;
  market_title: string | null;
  outcome: string | null;
  side: string | null;
  price: number | string | null;
  amount: number | string | null;
  timestamp: string | null;
};

type AlertRow = {
  trade_hash: string | null;
  trader_address: string | null;
  type: string | null;
};

type PaperPortfolio = {
  id: number | string | null;
  starting_usd: number | string | null;
  max_trade_risk_pct: number | string | null;
  max_total_exposure_pct: number | string | null;
  market_exposure_cap_pct: number | string | null;
  fixed_usd_per_trade: number | string | null;
};

type OpenPosition = {
  id: string;
  source_wallet: string | null;
  market_id: string | null;
  market_slug: string | null;
  market_title: string | null;
  outcome: string | null;
  shares: number | string | null;
  usd_size: number | string | null;
  entry_ts: string | null;
};

type MarketMeta = {
  id: string;
  question: string | null;
  slug: string | null;
  winning_outcome: string | null;
  liquidity: number | string | null;
  stats_updated_at: string | null;
  close_time: string | null;
  outcome_token_map: unknown;
};

type OrderBookLevel = { price: number; size: number };

type QuoteSummary = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  feeBps: number;
  latencyBps: number;
  bidAfterCosts: number | null;
  askWithCosts: number | null;
  bidDepth: number;
  askDepth: number;
  midpoint: number | null;
  quoteTs: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

type Candidate = {
  wallet: string;
  ranking: RankingRow;
  trade: TradeRow;
  rank: number;
  anomalyScore: number;
  signalFeatures: Record<string, unknown>;
  traderRecentAlertScore: number;
};

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseMaybeJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseOutcomeTokenMap(value: unknown): Record<string, string> | null {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const tokenMap: Record<string, string> = {};
  for (const [outcome, tokenId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof outcome === "string" && typeof tokenId === "string" && outcome.trim() && tokenId.trim()) {
      tokenMap[outcome.trim()] = tokenId.trim();
    }
  }
  return Object.keys(tokenMap).length > 0 ? tokenMap : null;
}

function buildOutcomeTokenMap(raw: any): Record<string, string> | null {
  const tokenMap: Record<string, string> = {};
  const tokensRaw = parseMaybeJson(raw?.tokens);
  if (Array.isArray(tokensRaw)) {
    for (const token of tokensRaw) {
      const outcome = typeof token?.outcome === "string" ? token.outcome.trim() : "";
      const tokenId = typeof token?.token_id === "string"
        ? token.token_id.trim()
        : typeof token?.tokenId === "string"
        ? token.tokenId.trim()
        : "";
      if (outcome && tokenId) tokenMap[outcome] = tokenId;
    }
  }
  if (Object.keys(tokenMap).length > 0) return tokenMap;

  const outcomesRaw = parseMaybeJson(raw?.outcomes);
  const tokenIdsRaw = parseMaybeJson(raw?.clobTokenIds ?? raw?.clobTokenIDs ?? raw?.clob_token_ids);
  const outcomes = Array.isArray(outcomesRaw) ? outcomesRaw : [];
  const tokenIds = Array.isArray(tokenIdsRaw) ? tokenIdsRaw : [];
  if (outcomes.length === tokenIds.length && outcomes.length > 0) {
    for (let i = 0; i < outcomes.length; i++) {
      if (typeof outcomes[i] === "string" && typeof tokenIds[i] === "string") {
        tokenMap[outcomes[i].trim()] = tokenIds[i].trim();
      }
    }
  }
  return Object.keys(tokenMap).length > 0 ? tokenMap : null;
}

function getOutcomeTokenId(tokenMap: Record<string, string> | null, outcome: string | null): string | null {
  if (!tokenMap || !outcome) return null;
  if (tokenMap[outcome]) return tokenMap[outcome];
  const normalizedOutcome = normalizeKey(outcome);
  for (const [label, tokenId] of Object.entries(tokenMap)) {
    if (normalizeKey(label) === normalizedOutcome) return tokenId;
  }
  return null;
}

function toIsoIfValid(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function getMinutesUntil(now: Date, isoValue: string | null): number | null {
  if (!isoValue) return null;
  const ts = Date.parse(isoValue);
  if (!Number.isFinite(ts)) return null;
  return (ts - now.getTime()) / (1000 * 60);
}

function extractEventKey(slug: string | null): string | null {
  if (!slug) return null;
  const sportsMatch = slug.match(
    /^(nba|nhl|mlb|nfl|cbb|cwbb|cfb|ahl|epl|efl|bun|mls|lal|ser|lig1|copa|mex|bl2|aus|fl1|ere|elc|sea|spl|cbl|udi|acm|por|tur|egy1|bra|arg|chi1|col1|rou1|rusrp|es2|fr2|itsb|den|wta|atp|ufc|cs2|val|lol|dota2|rl|lec|lpl|lck|vct|hok|r6siege)-([a-z0-9]+-[a-z0-9]+)-([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  );
  if (sportsMatch) return `${sportsMatch[1]}-${sportsMatch[2]}-${sportsMatch[3]}`.toLowerCase();
  const parts = slug.split("-");
  if (parts.length >= 5) return parts.slice(0, parts.length - 2).join("-").toLowerCase();
  if (parts.length === 4) return parts.slice(0, 3).join("-").toLowerCase();
  return slug.toLowerCase();
}

function parseLevels(levels: unknown): OrderBookLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => ({
      price: toNumber((level as any)?.price),
      size: toNumber((level as any)?.size),
    }))
    .filter((level): level is OrderBookLevel => level.price != null && level.size != null && level.size > 0);
}

function totalDepth(levels: OrderBookLevel[]): number {
  return levels.reduce((acc, level) => acc + level.size, 0);
}

function weightedAveragePrice(levels: OrderBookLevel[], sharesNeeded: number): number | null {
  if (!Number.isFinite(sharesNeeded) || sharesNeeded <= 0) return null;
  let remaining = sharesNeeded;
  let cost = 0;
  for (const level of levels) {
    const take = Math.min(level.size, remaining);
    cost += take * level.price;
    remaining -= take;
    if (remaining <= 1e-9) return cost / sharesNeeded;
  }
  return null;
}

function midpoint(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid == null || bestAsk == null) return null;
  return (bestBid + bestAsk) / 2;
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

function normalizeFeeBps(value: unknown): number {
  const n = toNumber(value);
  if (n == null || n < 0) return DEFAULT_FEE_BPS;
  if (n <= 1) return n * 10_000;
  return n;
}

function applyBuyCosts(price: number, feeBps: number, latencyBps: number): number {
  return price * (1 + (feeBps + latencyBps) / 10_000);
}

function applySellCosts(price: number, feeBps: number, latencyBps: number): number {
  return price * Math.max(0, 1 - (feeBps + latencyBps) / 10_000);
}

function isBlacklistedMarket(slug: string | null): boolean {
  if (!slug) return false;
  const lowerSlug = slug.toLowerCase();
  return BLACKLISTED_SLUG_PREFIXES.some((prefix) => lowerSlug.startsWith(prefix));
}

async function enrichMarketsFromGamma(markets: MarketMeta[]): Promise<Map<string, Partial<MarketMeta>>> {
  const updates = new Map<string, Partial<MarketMeta>>();
  for (const market of markets) {
    const hasTokenMap = parseOutcomeTokenMap(market.outcome_token_map);
    if (hasTokenMap && market.close_time) continue;

    let gammaMarket: any = null;
    if (market.slug) {
      try {
        gammaMarket = await fetchJson(`${GAMMA_URL}/markets/slug/${market.slug}`);
      } catch {
        gammaMarket = null;
      }
    }
    if (!gammaMarket && market.id) {
      try {
        const rows = await fetchJson(`${GAMMA_URL}/markets?condition_ids=${encodeURIComponent(market.id)}`);
        if (Array.isArray(rows) && rows[0]) gammaMarket = rows[0];
      } catch {
        gammaMarket = null;
      }
    }
    if (!gammaMarket) continue;

    updates.set(market.id, {
      question: market.question ?? gammaMarket.question ?? gammaMarket.title ?? null,
      slug: market.slug ?? gammaMarket.slug ?? null,
      liquidity: toNumber(gammaMarket.liquidityNum) ?? toNumber(gammaMarket.liquidity),
      close_time:
        toIsoIfValid(gammaMarket.endDateIso) ||
        toIsoIfValid(gammaMarket.end_date_iso) ||
        toIsoIfValid(gammaMarket.endDate) ||
        toIsoIfValid(gammaMarket.end_date) ||
        toIsoIfValid(gammaMarket.closeTime) ||
        toIsoIfValid(gammaMarket.closedTime) ||
        toIsoIfValid(gammaMarket.umaEndDate),
      outcome_token_map: buildOutcomeTokenMap(gammaMarket),
    });
  }
  return updates;
}

async function fetchOrderBooks(tokenIds: string[]): Promise<Map<string, QuoteSummary>> {
  const quotes = new Map<string, QuoteSummary>();
  if (tokenIds.length === 0) return quotes;

  const loadSingle = async (tokenId: string) => {
    try {
      const book = await fetchJson(`${CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
      const bids = parseLevels((book as any)?.bids);
      const asks = parseLevels((book as any)?.asks);
      const bestBid = bids[0]?.price ?? null;
      const bestAsk = asks[0]?.price ?? null;
      quotes.set(tokenId, {
        tokenId,
        bestBid,
        bestAsk,
        feeBps: DEFAULT_FEE_BPS,
        latencyBps: LATENCY_BPS,
        bidAfterCosts: bestBid,
        askWithCosts: bestAsk,
        bidDepth: totalDepth(bids),
        askDepth: totalDepth(asks),
        midpoint: midpoint(bestBid, bestAsk),
        quoteTs: new Date().toISOString(),
        bids,
        asks,
      });
    } catch (error) {
      console.warn(`Failed to fetch order book for token ${tokenId}:`, String(error));
    }
  };

  try {
    const response = await fetch(`${CLOB_URL}/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_ids: tokenIds }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const books = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as any)?.books)
      ? (payload as any).books
      : [];
    for (const book of books) {
      const tokenId = typeof (book as any)?.asset_id === "string"
        ? (book as any).asset_id
        : typeof (book as any)?.token_id === "string"
        ? (book as any).token_id
        : typeof (book as any)?.tokenId === "string"
        ? (book as any).tokenId
        : null;
      if (!tokenId) continue;
      const bids = parseLevels((book as any)?.bids);
      const asks = parseLevels((book as any)?.asks);
      const bestBid = bids[0]?.price ?? null;
      const bestAsk = asks[0]?.price ?? null;
      quotes.set(tokenId, {
        tokenId,
        bestBid,
        bestAsk,
        feeBps: DEFAULT_FEE_BPS,
        latencyBps: LATENCY_BPS,
        bidAfterCosts: bestBid,
        askWithCosts: bestAsk,
        bidDepth: totalDepth(bids),
        askDepth: totalDepth(asks),
        midpoint: midpoint(bestBid, bestAsk),
        quoteTs: new Date().toISOString(),
        bids,
        asks,
      });
    }
  } catch (error) {
    console.warn("Batch order book fetch failed, falling back to single-book requests:", String(error));
  }

  const missing = tokenIds.filter((tokenId) => !quotes.has(tokenId));
  for (const tokenId of missing) {
    await loadSingle(tokenId);
  }
  return quotes;
}

async function fetchFeeRates(tokenIds: string[]): Promise<Map<string, number>> {
  const feeRates = new Map<string, number>();
  for (const tokenId of tokenIds) {
    try {
      const payload = await fetchJson(`${CLOB_URL}/fee-rate?token_id=${encodeURIComponent(tokenId)}`);
      feeRates.set(
        tokenId,
        normalizeFeeBps(
          (payload as any)?.fee_rate_bps ??
            (payload as any)?.feeRateBps ??
            (payload as any)?.fee_rate ??
            (payload as any)?.feeRate,
        ),
      );
    } catch {
      feeRates.set(tokenId, DEFAULT_FEE_BPS);
    }
  }
  return feeRates;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const requestUrl = new URL(req.url);
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const maxTradeAgeMinutes = clamp(
      toNumber(requestUrl.searchParams.get("max_trade_age_minutes")) ?? DEFAULT_MAX_TRADE_AGE_MINUTES,
      3,
      60,
    );

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: portfolio, error: portfolioError } = await supabase
      .from("paper_portfolios")
      .select("id, starting_usd, max_trade_risk_pct, max_total_exposure_pct, market_exposure_cap_pct, fixed_usd_per_trade")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (portfolioError || !portfolio) {
      throw new Error(`Failed to load paper_portfolios: ${portfolioError?.message ?? "not found"}`);
    }

    const portfolioId = Number((portfolio as PaperPortfolio).id);
    const startingUsd = toNumber((portfolio as PaperPortfolio).starting_usd) ?? 500;

    const { data: equityRow } = await supabase
      .from("paper_portfolio_equity")
      .select("equity_usd")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();
    const { data: openRow } = await supabase
      .from("paper_open_exposure_total")
      .select("open_usd")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();

    const portfolioEquityUsd = toNumber(equityRow?.equity_usd) ?? startingUsd;
    let openTotalUsd = toNumber(openRow?.open_usd) ?? 0;
    const fixedUsdPerTrade = Math.min(toNumber((portfolio as PaperPortfolio).fixed_usd_per_trade) ?? BASE_FIXED_USD, BASE_FIXED_USD);
    const portfolioMaxTradeRiskPct = toNumber((portfolio as PaperPortfolio).max_trade_risk_pct) ?? 0.03;
    const portfolioMaxTotalExposurePct = Math.min(
      toNumber((portfolio as PaperPortfolio).max_total_exposure_pct) ?? MAX_TOTAL_EXPOSURE_PCT,
      MAX_TOTAL_EXPOSURE_PCT,
    );
    const portfolioMarketExposureCapPct = Math.min(
      toNumber((portfolio as PaperPortfolio).market_exposure_cap_pct) ?? MAX_MARKET_EXPOSURE_PCT,
      MAX_MARKET_EXPOSURE_PCT,
    );

    const now = new Date();
    const nowIso = now.toISOString();
    let runId: string | null = null;
    const summary = {
      success: true,
      dry_run: dryRun,
      traders_scanned: 0,
      trades_scanned: 0,
      candidates_considered: 0,
      positions_opened: 0,
      positions_closed: 0,
      skipped: 0,
      skip_reasons: {} as Record<string, number>,
    };

    const noteSkip = (reason: string) => {
      summary.skipped += 1;
      summary.skip_reasons[reason] = (summary.skip_reasons[reason] || 0) + 1;
    };

    if (!dryRun) {
      const { data: runRow, error: runError } = await supabase
        .from("anomaly_runs")
        .insert({
          started_at: nowIso,
          portfolio_id: portfolioId,
          dry_run: false,
          notes: {
            strategy: STRATEGY_TAG,
            max_rank: MAX_RANK,
            min_confidence: MIN_CONFIDENCE,
            min_resolved_trades: MIN_RESOLVED_TRADES,
            min_roi: MIN_ROI,
            min_market_liquidity: MIN_MARKET_LIQUIDITY,
            max_trade_age_minutes: maxTradeAgeMinutes,
            quote_source: EXECUTION_TYPE,
          },
        })
        .select("id")
        .maybeSingle();
      if (!runError) runId = runRow?.id ?? null;
    }

    const recordDecision = async (payload: Record<string, unknown>) => {
      if (dryRun || !runId) return;
      const { error } = await supabase.from("anomaly_trade_decisions").insert({ anomaly_run_id: runId, ...payload });
      if (error) console.warn("Failed to record anomaly decision:", error.message);
    };

    const { data: rankings, error: rankingsError } = await supabase
      .from("trader_rankings")
      .select("trader_address, copyable_rank_30d, realized_roi_30d, realized_pl_30d, median_bet_30d, resolved_trades_30d, confidence_30d, computed_at")
      .not("copyable_rank_30d", "is", null)
      .lte("copyable_rank_30d", MAX_RANK)
      .order("copyable_rank_30d", { ascending: true })
      .limit(MAX_WALLETS);
    if (rankingsError) throw new Error(`Failed to load trader_rankings: ${rankingsError.message}`);

    const eligibleRankings = ((rankings || []) as RankingRow[]).filter((row) => {
      const wallet = row.trader_address?.toLowerCase();
      const rank = toNumber(row.copyable_rank_30d) ?? Number.POSITIVE_INFINITY;
      const confidence = toNumber(row.confidence_30d) ?? 0;
      const resolved = toNumber(row.resolved_trades_30d) ?? 0;
      const roi = toNumber(row.realized_roi_30d) ?? 0;
      const pl = toNumber(row.realized_pl_30d) ?? 0;
      return Boolean(wallet) && rank <= MAX_RANK && confidence >= MIN_CONFIDENCE && resolved >= MIN_RESOLVED_TRADES && roi >= MIN_ROI && pl >= MIN_REALIZED_PL;
    });
    const wallets = eligibleRankings.map((row) => String(row.trader_address).toLowerCase());
    summary.traders_scanned = wallets.length;

    const openTraderMap = new Map<string, number>();
    const openMarketMap = new Map<string, number>();
    const openOutcomeSet = new Set<string>();

    if (wallets.length > 0) {
      const { data: openByTrader } = await supabase
        .from("paper_open_exposure_by_trader")
        .select("source_wallet, open_usd")
        .eq("portfolio_id", portfolioId)
        .in("source_wallet", wallets);
      for (const row of openByTrader || []) {
        if (row?.source_wallet) openTraderMap.set(String(row.source_wallet).toLowerCase(), toNumber(row.open_usd) ?? 0);
      }
    }

    const { data: openAnomalyRows, error: openAnomalyError } = await supabase
      .from("paper_positions")
      .select("id, source_wallet, market_id, market_slug, market_title, outcome, shares, usd_size, entry_ts")
      .eq("portfolio_id", portfolioId)
      .eq("strategy_lane", STRATEGY_LANE)
      .eq("status", "OPEN")
      .limit(5000);
    if (openAnomalyError) console.warn("Failed to load open anomaly positions:", openAnomalyError.message);
    const openRows = (openAnomalyRows || []) as OpenPosition[];
    for (const row of openRows) {
      if (row.market_id) openMarketMap.set(row.market_id, (openMarketMap.get(row.market_id) ?? 0) + (toNumber(row.usd_size) ?? 0));
      if (row.market_id && row.outcome) openOutcomeSet.add(`${row.market_id}:${normalizeKey(row.outcome)}`);
    }

    const openMarketIds = Array.from(new Set(openRows.map((row) => row.market_id).filter((v): v is string => Boolean(v))));
    const resolvedMarketSet = new Set<string>();
    const marketMetaMap = new Map<string, MarketMeta>();
    if (openMarketIds.length > 0) {
      const { data: openMarkets } = await supabase
        .from("markets")
        .select("id, question, slug, winning_outcome, liquidity, stats_updated_at, close_time, outcome_token_map")
        .in("id", openMarketIds);
      for (const row of (openMarkets || []) as MarketMeta[]) {
        marketMetaMap.set(row.id, row);
        if (row.winning_outcome) resolvedMarketSet.add(row.id);
      }
    }

    const walletState = new Map<string, string>();
    if (wallets.length > 0) {
      const { data: stateRows } = await supabase
        .from("anomaly_state")
        .select("wallet,last_seen_ts")
        .in("wallet", wallets);
      for (const row of stateRows || []) {
        if (row?.wallet && row?.last_seen_ts) walletState.set(String(row.wallet).toLowerCase(), String(row.last_seen_ts));
      }
    }

    const alertCutoffIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const directAlertByTrade = new Map<string, string[]>();
    const recentAlertScoreByWallet = new Map<string, number>();
    if (wallets.length > 0) {
      const { data: alertRows } = await supabase
        .from("alerts")
        .select("trade_hash,trader_address,type")
        .in("trader_address", wallets)
        .gte("created_at", alertCutoffIso)
        .limit(2000);
      for (const alert of (alertRows || []) as AlertRow[]) {
        const type = alert.type ?? "";
        const weight = ALERT_WEIGHTS[type] ?? 0;
        const wallet = alert.trader_address?.toLowerCase();
        if (wallet && weight > 0) recentAlertScoreByWallet.set(wallet, (recentAlertScoreByWallet.get(wallet) ?? 0) + weight);
        if (alert.trade_hash) {
          const key = alert.trade_hash;
          const existing = directAlertByTrade.get(key) ?? [];
          existing.push(type);
          directAlertByTrade.set(key, existing);
        }
      }
    }

    const candidateRows: Candidate[] = [];
    const cursorUpdates = new Map<string, string>();

    for (const ranking of eligibleRankings) {
      const wallet = String(ranking.trader_address).toLowerCase();
      const rank = toNumber(ranking.copyable_rank_30d) ?? Number.POSITIVE_INFINITY;
      const lastSeenIso = walletState.get(wallet);
      const sinceIso = lastSeenIso
        ? new Date(Math.max(Date.parse(lastSeenIso) - 1000, now.getTime() - 24 * 60 * 60 * 1000)).toISOString()
        : new Date(now.getTime() - DEFAULT_INITIAL_LOOKBACK_MINUTES * 60 * 1000).toISOString();
      const profileSinceIso = new Date(now.getTime() - EVENT_SWEEP_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

      const { data: profileTrades } = await supabase
        .from("trades")
        .select("tx_hash,trader_address,market_id,market_slug,market_title,outcome,side,price,amount,timestamp")
        .eq("trader_address", wallet)
        .gte("timestamp", profileSinceIso)
        .order("timestamp", { ascending: false })
        .limit(120);

      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select("tx_hash,trader_address,market_id,market_slug,market_title,outcome,side,price,amount,timestamp")
        .eq("trader_address", wallet)
        .gte("timestamp", sinceIso)
        .order("timestamp", { ascending: true })
        .limit(120);
      if (tradesError) {
        console.warn(`Failed to load anomaly trades for ${wallet}:`, tradesError.message);
        noteSkip("trades_lookup_failed");
        continue;
      }

      const history = (profileTrades || []) as TradeRow[];
      let maxSeenIso = lastSeenIso ?? sinceIso;
      for (const trade of (trades || []) as TradeRow[]) {
        summary.trades_scanned += 1;
        if (trade.timestamp && trade.timestamp > maxSeenIso) maxSeenIso = trade.timestamp;

        const tradeTs = trade.timestamp ? new Date(trade.timestamp) : null;
        const tradeAgeMinutes = tradeTs ? (now.getTime() - tradeTs.getTime()) / (1000 * 60) : null;
        const price = toNumber(trade.price);
        const amount = toNumber(trade.amount);
        const side = (trade.side ?? "BUY").toUpperCase();
        if (!trade.tx_hash || !trade.market_id || !trade.outcome || !tradeTs || tradeAgeMinutes == null || tradeAgeMinutes > maxTradeAgeMinutes) continue;
        if (side !== "BUY" || price == null || price <= 0 || price >= 1 || amount == null || amount <= 0) continue;
        if (price < MIN_PRICE || price > MAX_PRICE) continue;
        if (isBlacklistedMarket(trade.market_slug)) continue;

        const medianBet = Math.max(toNumber(ranking.median_bet_30d) ?? 0, 1);
        const sizeRatio = amount / medianBet;
        const sizeSpikeScore = sizeRatio >= 3 || amount >= 10000 ? 2 : sizeRatio >= 1.75 || amount >= 5000 ? 1 : 0;

        const eventKey = extractEventKey(trade.market_slug);
        const nearbyTrades = history.filter((row) => {
          if (!row.timestamp) return false;
          const ts = Date.parse(row.timestamp);
          return Number.isFinite(ts) && Math.abs(ts - tradeTs.getTime()) <= RAPID_FIRE_WINDOW_MINUTES * 60 * 1000;
        });
        const rapidFireCount = nearbyTrades.length;
        const rapidFireScore = rapidFireCount >= RAPID_FIRE_MIN_COUNT ? 1 : 0;

        let eventSweepMarkets = 0;
        if (eventKey) {
          const markets = new Set<string>();
          for (const row of history) {
            const rowEventKey = extractEventKey(row.market_slug);
            if (rowEventKey === eventKey && row.market_id) markets.add(row.market_id);
          }
          eventSweepMarkets = markets.size;
        }
        const eventSweepScore = eventSweepMarkets >= EVENT_SWEEP_MIN_MARKETS ? 1 : 0;

        const directAlertTypes = directAlertByTrade.get(trade.tx_hash) ?? [];
        const directAlertScore = directAlertTypes.reduce((acc, type) => acc + (ALERT_WEIGHTS[type] ?? 0), 0);
        const traderAlertScore = Math.min(3, recentAlertScoreByWallet.get(wallet) ?? 0);
        const rankScore = rank <= 5 ? 2 : rank <= 10 ? 1 : 0;
        const anomalyScore = directAlertScore + traderAlertScore + sizeSpikeScore + rapidFireScore + eventSweepScore + rankScore;

        if (anomalyScore < 4 || (sizeSpikeScore === 0 && directAlertScore === 0 && traderAlertScore === 0)) continue;

        candidateRows.push({
          wallet,
          ranking,
          trade,
          rank,
          anomalyScore,
          traderRecentAlertScore: traderAlertScore,
          signalFeatures: {
            rank,
            median_bet_30d: toNumber(ranking.median_bet_30d),
            size_ratio: Number(sizeRatio.toFixed(2)),
            direct_alert_types: directAlertTypes,
            direct_alert_score: directAlertScore,
            trader_alert_score: traderAlertScore,
            rapid_fire_count: rapidFireCount,
            event_sweep_markets: eventSweepMarkets,
            anomaly_score: anomalyScore,
          },
        });
      }

      cursorUpdates.set(wallet, maxSeenIso);
    }

    candidateRows.sort((a, b) => b.anomalyScore - a.anomalyScore || String(b.trade.timestamp).localeCompare(String(a.trade.timestamp)));
    summary.candidates_considered = candidateRows.length;

    const candidateMarketIds = Array.from(new Set(candidateRows.map((row) => row.trade.market_id).filter((v): v is string => Boolean(v))));
    if (candidateMarketIds.length > 0) {
      const missingMarketIds = candidateMarketIds.filter((id) => !marketMetaMap.has(id));
      if (missingMarketIds.length > 0) {
        const { data: marketRows } = await supabase
          .from("markets")
          .select("id, question, slug, winning_outcome, liquidity, stats_updated_at, close_time, outcome_token_map")
          .in("id", missingMarketIds);
        for (const row of (marketRows || []) as MarketMeta[]) {
          marketMetaMap.set(row.id, row);
          if (row.winning_outcome) resolvedMarketSet.add(row.id);
        }
      }
    }

    const gammaUpdates = await enrichMarketsFromGamma(Array.from(marketMetaMap.values()));
    if (gammaUpdates.size > 0) {
      const upsertRows: Record<string, unknown>[] = [];
      for (const [marketId, patch] of gammaUpdates.entries()) {
        const existing = marketMetaMap.get(marketId);
        const merged = {
          id: marketId,
          question: (patch.question as string | null) ?? existing?.question ?? null,
          slug: (patch.slug as string | null) ?? existing?.slug ?? null,
          winning_outcome: existing?.winning_outcome ?? null,
          liquidity: toNumber(patch.liquidity) ?? toNumber(existing?.liquidity),
          stats_updated_at: nowIso,
          close_time: (patch.close_time as string | null) ?? existing?.close_time ?? null,
          outcome_token_map: patch.outcome_token_map ?? existing?.outcome_token_map ?? null,
        } satisfies MarketMeta;
        marketMetaMap.set(marketId, merged);
        upsertRows.push({
          id: marketId,
          question: merged.question,
          slug: merged.slug,
          liquidity: merged.liquidity,
          stats_updated_at: merged.stats_updated_at,
          close_time: merged.close_time,
          outcome_token_map: merged.outcome_token_map,
        });
      }
      if (!dryRun && upsertRows.length > 0) {
        const { error: marketUpsertError } = await supabase.from("markets").upsert(upsertRows, { onConflict: "id" });
        if (marketUpsertError) console.warn("Failed to upsert Gamma market enrichments:", marketUpsertError.message);
      }
    }

    const quoteTargets = new Map<string, { market_id: string; outcome: string; token_id: string }>();
    for (const row of openRows) {
      const meta = row.market_id ? marketMetaMap.get(row.market_id) : null;
      const tokenMap = parseOutcomeTokenMap(meta?.outcome_token_map ?? null);
      const tokenId = getOutcomeTokenId(tokenMap, row.outcome ?? null);
      if (row.market_id && row.outcome && tokenId) {
        quoteTargets.set(`${row.market_id}:${normalizeKey(row.outcome)}`, { market_id: row.market_id, outcome: row.outcome, token_id: tokenId });
      }
    }
    for (const candidate of candidateRows) {
      const marketId = candidate.trade.market_id;
      const outcome = candidate.trade.outcome;
      if (!marketId || !outcome) continue;
      const meta = marketMetaMap.get(marketId);
      const tokenMap = parseOutcomeTokenMap(meta?.outcome_token_map ?? null);
      const tokenId = getOutcomeTokenId(tokenMap, outcome);
      if (tokenId) quoteTargets.set(`${marketId}:${normalizeKey(outcome)}`, { market_id: marketId, outcome, token_id: tokenId });
    }

    const tokenIds = Array.from(new Set(Array.from(quoteTargets.values()).map((target) => target.token_id)));
    const quoteMap = await fetchOrderBooks(tokenIds);
    const feeMap = await fetchFeeRates(tokenIds);
    for (const quote of quoteMap.values()) {
      const feeBps = feeMap.get(quote.tokenId) ?? DEFAULT_FEE_BPS;
      quote.feeBps = feeBps;
      quote.latencyBps = LATENCY_BPS;
      quote.bidAfterCosts = quote.bestBid == null ? null : applySellCosts(quote.bestBid, feeBps, LATENCY_BPS);
      quote.askWithCosts = quote.bestAsk == null ? null : applyBuyCosts(quote.bestAsk, feeBps, LATENCY_BPS);
    }

    if (!dryRun && quoteTargets.size > 0) {
      const quoteRows = Array.from(quoteTargets.values()).map((target) => {
        const quote = quoteMap.get(target.token_id);
        return {
          market_id: target.market_id,
          outcome: target.outcome,
          token_id: target.token_id,
          best_bid: quote?.bestBid ?? null,
          best_ask: quote?.bestAsk ?? null,
          fee_bps: quote?.feeBps ?? DEFAULT_FEE_BPS,
          latency_bps: quote?.latencyBps ?? LATENCY_BPS,
          bid_after_costs: quote?.bidAfterCosts ?? quote?.bestBid ?? null,
          ask_with_costs: quote?.askWithCosts ?? quote?.bestAsk ?? null,
          bid_depth: quote?.bidDepth ?? null,
          ask_depth: quote?.askDepth ?? null,
          midpoint: quote?.midpoint ?? null,
          last_trade_price: null,
          quote_ts: quote?.quoteTs ?? nowIso,
          updated_at: nowIso,
        };
      });
      const { error: quoteError } = await supabase.from("market_quotes").upsert(quoteRows, { onConflict: "market_id,outcome" });
      if (quoteError) console.warn("Failed to upsert market quotes:", quoteError.message);
    }

    for (const row of openRows) {
      const marketId = row.market_id;
      const outcome = row.outcome;
      if (!marketId || !outcome) {
        noteSkip("invalid_open_position");
        continue;
      }
      if (resolvedMarketSet.has(marketId)) {
        noteSkip("resolved_market_wait_for_settlement");
        continue;
      }
      const meta = marketMetaMap.get(marketId);
      const tokenMap = parseOutcomeTokenMap(meta?.outcome_token_map ?? null);
      const tokenId = getOutcomeTokenId(tokenMap, outcome);
      const quote = tokenId ? quoteMap.get(tokenId) : null;
      if (!quote) {
        noteSkip("missing_open_quote");
        continue;
      }
      const shares = toNumber(row.shares) ?? 0;
      const usdSize = toNumber(row.usd_size) ?? 0;
      const rawExitPx = weightedAveragePrice(quote.bids, shares);
      if (rawExitPx == null) {
        noteSkip("insufficient_exit_depth");
        continue;
      }
      const exitPrice = applySellCosts(rawExitPx, quote.feeBps, quote.latencyBps);
      const pnlUsd = shares * exitPrice - usdSize;
      const pnlPct = usdSize > 0 ? pnlUsd / usdSize : 0;
      const holdHours = row.entry_ts ? (now.getTime() - new Date(row.entry_ts).getTime()) / (1000 * 60 * 60) : 0;
      const minutesToClose = getMinutesUntil(now, toIsoIfValid(meta?.close_time ?? null));
      let exitReason: string | null = null;
      if (pnlPct >= TAKE_PROFIT_PCT) exitReason = "anomaly_take_profit";
      else if (pnlPct <= STOP_LOSS_PCT) exitReason = "anomaly_stop_loss";
      else if (minutesToClose != null && minutesToClose <= CLOSE_TIME_GUARD_MINUTES) exitReason = "anomaly_close_time_guard";
      else if (holdHours >= HARD_MAX_HOLD_HOURS) exitReason = "anomaly_time_stop";
      else if (holdHours >= SOFT_MAX_HOLD_HOURS && pnlPct >= 0) exitReason = "anomaly_time_exit";
      if (!exitReason) continue;

      if (!dryRun) {
        const { error: closeError } = await supabase
          .from("paper_positions")
          .update({
            status: "SETTLED",
            exit_price: exitPrice,
            exit_ts: nowIso,
            pnl_usd: pnlUsd,
            exit_reason: exitReason,
            updated_at: nowIso,
          })
          .eq("id", row.id)
          .eq("status", "OPEN")
          .eq("strategy_lane", STRATEGY_LANE);
        if (closeError) {
          console.warn(`Failed to close anomaly leg ${row.id}:`, closeError.message);
          noteSkip("close_update_failed");
          continue;
        }
      }
      summary.positions_closed += 1;
      openTotalUsd = Math.max(0, openTotalUsd - usdSize);
      if (row.source_wallet) {
        const key = row.source_wallet.toLowerCase();
        openTraderMap.set(key, Math.max(0, (openTraderMap.get(key) ?? 0) - usdSize));
      }
      openMarketMap.set(marketId, Math.max(0, (openMarketMap.get(marketId) ?? 0) - usdSize));
      openOutcomeSet.delete(`${marketId}:${normalizeKey(outcome)}`);
      await recordDecision({
        decision: "CLOSED",
        reason: exitReason,
        source_trade_id: row.id,
        source_wallet: row.source_wallet,
        market_id: marketId,
        market_slug: row.market_slug,
        market_title: row.market_title,
        outcome,
        exit_price: exitPrice,
        usd_size: usdSize,
        shares,
      });
    }

    for (const candidate of candidateRows) {
      if (summary.positions_opened >= MAX_NEW_POSITIONS_PER_RUN) {
        noteSkip("run_position_cap");
        break;
      }
      const trade = candidate.trade;
      const marketId = trade.market_id;
      const outcome = trade.outcome;
      if (!marketId || !outcome || !trade.tx_hash) continue;

      const meta = marketMetaMap.get(marketId);
      if (!meta) {
        noteSkip("missing_market_meta");
        await recordDecision({ decision: "SKIPPED", reason: "missing_market_meta", source_trade_id: trade.tx_hash, source_wallet: candidate.wallet, market_id: marketId, market_slug: trade.market_slug, market_title: trade.market_title, outcome });
        continue;
      }
      if (meta.winning_outcome) {
        noteSkip("market_already_resolved");
        continue;
      }
      const marketLiquidity = toNumber(meta.liquidity) ?? 0;
      if (marketLiquidity > 0 && marketLiquidity < MIN_MARKET_LIQUIDITY) {
        noteSkip("thin_market");
        continue;
      }
      const minutesToClose = getMinutesUntil(now, toIsoIfValid(meta.close_time));
      if (minutesToClose != null && minutesToClose < MIN_MINUTES_TO_CLOSE) {
        noteSkip("too_close_to_resolution");
        continue;
      }
      if (minutesToClose != null && minutesToClose > MAX_MINUTES_TO_CLOSE) {
        noteSkip("too_far_from_resolution");
        continue;
      }

      const tokenMap = parseOutcomeTokenMap(meta.outcome_token_map);
      const tokenId = getOutcomeTokenId(tokenMap, outcome);
      const quote = tokenId ? quoteMap.get(tokenId) : null;
      if (!quote) {
        noteSkip("missing_candidate_quote");
        continue;
      }
      if (openOutcomeSet.has(`${marketId}:${normalizeKey(outcome)}`)) {
        noteSkip("already_open_same_outcome");
        continue;
      }

      const price = toNumber(trade.price) ?? 0;
      const scoreSizeUsd = clamp(fixedUsdPerTrade + (candidate.anomalyScore - 4) * 1.5, MIN_FIXED_USD, MAX_FIXED_USD);
      const currentTraderExposure = openTraderMap.get(candidate.wallet) ?? 0;
      const currentMarketExposure = openMarketMap.get(marketId) ?? 0;
      const sizing = computeFixedStakeUsdSize({
        fixedUsd: scoreSizeUsd,
        equityUsd: portfolioEquityUsd,
        maxTradeRiskPct: portfolioMaxTradeRiskPct,
        maxTotalExposurePct: portfolioMaxTotalExposurePct,
        marketExposureCapPct: portfolioMarketExposureCapPct,
        maxTraderExposurePct: MAX_TRADER_EXPOSURE_PCT,
        currentOpenExposureTotal: openTotalUsd,
        currentOpenExposureForTrader: currentTraderExposure,
        currentOpenExposureForMarket: currentMarketExposure,
      });
      if (sizing.usdSize <= 0) {
        noteSkip(sizing.reason ?? "sizing_rejected");
        await recordDecision({
          decision: "SKIPPED",
          reason: sizing.reason ?? "sizing_rejected",
          source_trade_id: trade.tx_hash,
          source_wallet: candidate.wallet,
          source_trade_ts: trade.timestamp,
          market_id: marketId,
          market_slug: trade.market_slug,
          market_title: trade.market_title,
          outcome,
          side: trade.side,
          source_price: price,
          signal_score: candidate.anomalyScore,
          signal_features: candidate.signalFeatures,
        });
        continue;
      }

      const { data: recentEntries } = await supabase
        .from("paper_positions")
        .select("id")
        .eq("portfolio_id", portfolioId)
        .eq("strategy_lane", STRATEGY_LANE)
        .eq("source_wallet", candidate.wallet)
        .eq("market_id", marketId)
        .gte("entry_ts", new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString())
        .limit(1);
      if ((recentEntries || []).length > 0) {
        noteSkip("cooldown_gate");
        continue;
      }

      const approxEntryPrice = quote.askWithCosts ?? quote.bestAsk;
      if (approxEntryPrice == null || approxEntryPrice <= 0 || approxEntryPrice >= 1) {
        noteSkip("invalid_entry_quote");
        continue;
      }
      const approxShares = sizing.usdSize / approxEntryPrice;
      const rawAsk = weightedAveragePrice(quote.asks, approxShares);
      if (rawAsk == null) {
        noteSkip("insufficient_entry_depth");
        continue;
      }
      const entryPrice = applyBuyCosts(rawAsk, quote.feeBps, quote.latencyBps);
      if (entryPrice <= 0 || entryPrice >= 1) {
        noteSkip("entry_price_out_of_bounds");
        continue;
      }
      const shares = sizing.usdSize / entryPrice;
      const sourceTradeId = `${trade.tx_hash}:anomaly`;
      const rankingSnapshot = {
        copyable_rank_30d: candidate.ranking.copyable_rank_30d,
        realized_roi_30d: candidate.ranking.realized_roi_30d,
        realized_pl_30d: candidate.ranking.realized_pl_30d,
        median_bet_30d: candidate.ranking.median_bet_30d,
        resolved_trades_30d: candidate.ranking.resolved_trades_30d,
        confidence_30d: candidate.ranking.confidence_30d,
        computed_at: candidate.ranking.computed_at,
      };

      const row = {
        portfolio_id: portfolioId,
        source_wallet: candidate.wallet,
        source_trade_id: sourceTradeId,
        source_trade_ts: trade.timestamp,
        market_id: marketId,
        market_slug: trade.market_slug ?? null,
        market_title: trade.market_title ?? null,
        outcome,
        side: "BUY",
        source_price: price,
        entry_price: entryPrice,
        price_penalty: entryPrice - price,
        copy_factor: null,
        sizing_method: "fixed_stake",
        fixed_usd_per_trade: sizing.usdSize,
        strategy_lane: STRATEGY_LANE,
        strategy_tag: STRATEGY_TAG,
        execution_type: EXECUTION_TYPE,
        copy_run_id: null,
        usd_size: sizing.usdSize,
        shares,
        status: "OPEN",
        entry_ts: trade.timestamp ?? nowIso,
        updated_at: nowIso,
        rank_at_entry: candidate.rank,
        roi_at_entry: toNumber(candidate.ranking.realized_roi_30d),
        pl_at_entry: toNumber(candidate.ranking.realized_pl_30d),
        edge_bps: candidate.anomalyScore * 100,
      };

      if (!dryRun) {
        const { data: inserted, error: insertError } = await supabase
          .from("paper_positions")
          .upsert(row, { onConflict: "source_trade_id", ignoreDuplicates: true })
          .select("id");
        if (insertError) {
          console.warn("Failed to insert anomaly position:", insertError.message);
          noteSkip("insert_failed");
          continue;
        }
        if (!inserted || inserted.length === 0) {
          noteSkip("duplicate_trade");
          continue;
        }
      }

      summary.positions_opened += 1;
      openTotalUsd += sizing.usdSize;
      openTraderMap.set(candidate.wallet, currentTraderExposure + sizing.usdSize);
      openMarketMap.set(marketId, currentMarketExposure + sizing.usdSize);
      openOutcomeSet.add(`${marketId}:${normalizeKey(outcome)}`);
      await recordDecision({
        decision: "OPENED",
        reason: null,
        source_trade_id: trade.tx_hash,
        source_wallet: candidate.wallet,
        source_trade_ts: trade.timestamp,
        market_id: marketId,
        market_slug: trade.market_slug,
        market_title: trade.market_title,
        outcome,
        side: trade.side,
        source_price: price,
        entry_price: entryPrice,
        usd_size: sizing.usdSize,
        shares,
        signal_score: candidate.anomalyScore,
        signal_features: candidate.signalFeatures,
        ranking_snapshot: rankingSnapshot,
      });
    }

    if (!dryRun) {
      for (const [wallet, lastSeenTs] of cursorUpdates.entries()) {
        const { error } = await supabase
          .from("anomaly_state")
          .upsert({ wallet, last_seen_ts: lastSeenTs, updated_at: nowIso }, { onConflict: "wallet" });
        if (error) console.warn(`Failed to update anomaly_state for ${wallet}:`, error.message);
      }
    }

    if (!dryRun) {
      const notes = { strategy: STRATEGY_TAG, quote_source: EXECUTION_TYPE };
      const { error: runUpdateError } = await supabase
        .from("anomaly_runs")
        .update({
          finished_at: new Date().toISOString(),
          traders_scanned: summary.traders_scanned,
          trades_scanned: summary.trades_scanned,
          candidates_considered: summary.candidates_considered,
          positions_opened: summary.positions_opened,
          positions_closed: summary.positions_closed,
          skipped: summary.skipped,
          skip_reasons: summary.skip_reasons,
          notes,
        })
        .eq("id", runId);
      if (runUpdateError) console.warn("Failed to update anomaly_runs summary:", runUpdateError.message);

      const { data: diagRows } = await supabase
        .from("paper_positions_with_price")
        .select("status,pnl_usd,shares,usd_size,current_price")
        .eq("portfolio_id", portfolioId)
        .eq("strategy_lane", STRATEGY_LANE)
        .limit(10000);
      const openDiag = (diagRows || []).filter((row) => row.status === "OPEN");
      const settledDiag = (diagRows || []).filter((row) => row.status === "SETTLED");
      const realized = settledDiag.reduce((acc, row) => acc + (toNumber(row.pnl_usd) ?? 0), 0);
      const unrealized = openDiag.reduce((acc, row) => {
        const currentPrice = toNumber((row as any).current_price);
        const shares = toNumber((row as any).shares) ?? 0;
        const usdSize = toNumber((row as any).usd_size) ?? 0;
        if (currentPrice == null) return acc;
        return acc + (shares * currentPrice - usdSize);
      }, 0);
      const { error: diagError } = await supabase.from("paper_strategy_diagnostics").insert({
        computed_at: nowIso,
        portfolio_id: portfolioId,
        scope: "since_reset",
        strategy_lane: STRATEGY_LANE,
        positions_total: (diagRows || []).length,
        open_positions: openDiag.length,
        settled_positions: settledDiag.length,
        realized_pnl: realized,
        unrealized_pnl: unrealized,
        projected_pnl: realized + unrealized,
        profit_source: "ranked_anomaly_follow",
        notes: {
          max_rank: MAX_RANK,
          max_trade_age_minutes: maxTradeAgeMinutes,
          price_band: [MIN_PRICE, MAX_PRICE],
          max_market_exposure_pct: MAX_MARKET_EXPOSURE_PCT,
        },
      });
      if (diagError) console.warn("Failed to insert anomaly diagnostics:", diagError.message);
    }

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-paper-anomaly error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error?.message || error) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
