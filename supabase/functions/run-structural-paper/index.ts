import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const STRATEGY_WALLET = "structural_parity_engine";
const STRATEGY_LANE = "structural";
const STRATEGY_TAG = "yes_no_parity";
const EXECUTION_TYPE = "clob_book_sim";

const CLOB_URL = "https://clob.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";

const MAX_PRICE_AGE_MINUTES = 30;
const MAX_NEW_GROUPS_PER_RUN = 3;
const DAILY_GROUP_CAP = 12;
const MAX_STRUCTURAL_EXPOSURE_PCT = 0.35;
const MIN_ENTRY_EDGE = 0.02;
const MIN_NET_ENTRY_EDGE = 0.015;
const MAX_ENTRY_SUM = 0.97;
const MIN_OUTCOME_PRICE = 0.03;
const MAX_OUTCOME_PRICE = 0.97;
const MIN_MARKET_LIQUIDITY = 10000;
const MIN_MINUTES_TO_CLOSE = 180;
const FORCE_EXIT_MINUTES_TO_CLOSE = 45;

const TAKE_PROFIT_SUM_DELTA = 0.015;
const STOP_LOSS_SUM_DELTA = 0.03;
const SOFT_MAX_HOLD_HOURS = 6;
const HARD_MAX_HOLD_HOURS = 12;

const MIN_STRUCTURAL_USD = 4;
const MAX_STRUCTURAL_USD = 20;
const DEFAULT_BASE_USD = 10;

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 0 || varY <= 0) return null;
  return cov / Math.sqrt(varX * varY);
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

function looksIntradayMarket(slug: string | null, title: string | null): boolean {
  const haystack = `${slug ?? ""} ${title ?? ""}`.toLowerCase();
  return /up-or-down|15m|30m|1h|this hour|today at|by \d{1,2}(am|pm)\b/.test(haystack);
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
      if (outcome && tokenId) {
        tokenMap[outcome] = tokenId;
      }
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

function getOutcomeTokenId(
  tokenMap: Record<string, string> | null,
  outcome: string | null,
): string | null {
  if (!tokenMap || !outcome) return null;
  if (tokenMap[outcome]) return tokenMap[outcome];
  const normalizedOutcome = normalizeKey(outcome);
  for (const [label, tokenId] of Object.entries(tokenMap)) {
    if (normalizeKey(label) === normalizedOutcome) return tokenId;
  }
  return null;
}

type OrderBookLevel = {
  price: number;
  size: number;
};

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
    if (remaining <= 1e-9) {
      return cost / sharesNeeded;
    }
  }
  return null;
}

function midpoint(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid == null || bestAsk == null) return null;
  return (bestBid + bestAsk) / 2;
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.json();
}

type PaperPortfolio = {
  id: number | string | null;
  starting_usd: number | string | null;
  fixed_usd_per_trade: number | string | null;
  max_total_exposure_pct: number | string | null;
};

type OpenPosition = {
  id: string;
  market_id: string;
  market_title: string | null;
  market_slug: string | null;
  outcome: string;
  shares: number | string | null;
  usd_size: number | string | null;
  entry_ts: string | null;
  structural_group_id: string | null;
};

type MarketPrice = {
  market_id: string;
  outcome: string;
  price: number | string | null;
  updated_at: string | null;
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

type QuoteSummary = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  midpoint: number | null;
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
  quoteTs: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

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
        const rows = await fetchJson(
          `${GAMMA_URL}/markets?condition_ids=${encodeURIComponent(market.id)}`,
        );
        if (Array.isArray(rows) && rows[0]) {
          gammaMarket = rows[0];
        }
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
  for (const tokenId of tokenIds) {
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
        bidDepth: totalDepth(bids),
        askDepth: totalDepth(asks),
        midpoint: midpoint(bestBid, bestAsk),
        tickSize: toNumber((book as any)?.tick_size),
        minOrderSize: toNumber((book as any)?.min_order_size),
        negRisk: typeof (book as any)?.neg_risk === "boolean" ? (book as any).neg_risk : null,
        quoteTs: new Date().toISOString(),
        bids,
        asks,
      });
    } catch (error) {
      console.warn(`Failed to fetch order book for token ${tokenId}:`, String(error));
    }
  }
  return quotes;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUrl = new URL(req.url);
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const maxNewGroupsParam = toNumber(requestUrl.searchParams.get("max_new_groups"));
    const maxNewGroups = maxNewGroupsParam && maxNewGroupsParam > 0
      ? Math.floor(maxNewGroupsParam)
      : MAX_NEW_GROUPS_PER_RUN;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: portfolio, error: portfolioError } = await supabase
      .from("paper_portfolios")
      .select("id, starting_usd, fixed_usd_per_trade, max_total_exposure_pct")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (portfolioError || !portfolio) {
      throw new Error(`Failed to load paper_portfolios: ${portfolioError?.message ?? "not found"}`);
    }

    const portfolioId = Number((portfolio as PaperPortfolio).id);
    if (!Number.isFinite(portfolioId)) {
      throw new Error("Invalid paper portfolio id");
    }

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

    const startingUsd = toNumber((portfolio as PaperPortfolio).starting_usd) ?? 500;
    const portfolioEquityUsd = toNumber(equityRow?.equity_usd) ?? startingUsd;
    let openTotalUsd = toNumber(openRow?.open_usd) ?? 0;
    const configuredExposurePct = toNumber((portfolio as PaperPortfolio).max_total_exposure_pct) ?? 0.6;
    const maxTotalExposurePct = Math.min(configuredExposurePct, MAX_STRUCTURAL_EXPOSURE_PCT);
    const baseUsd = Math.min(
      toNumber((portfolio as PaperPortfolio).fixed_usd_per_trade) ?? DEFAULT_BASE_USD,
      DEFAULT_BASE_USD,
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const staleCutoffIso = new Date(
      now.getTime() - MAX_PRICE_AGE_MINUTES * 60 * 1000,
    ).toISOString();
    const dailyCutoffIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const maxOpenExposureUsd = portfolioEquityUsd * maxTotalExposurePct;
    const dailyGroupCap = Math.max(
      DAILY_GROUP_CAP,
      Math.floor(maxOpenExposureUsd / Math.max(baseUsd, MIN_STRUCTURAL_USD)),
    );

    let structuralRunId: string | null = null;
    const summary = {
      success: true,
      dry_run: dryRun,
      markets_scanned: 0,
      opportunities_found: 0,
      groups_opened: 0,
      legs_opened: 0,
      groups_closed: 0,
      legs_closed: 0,
      skipped: 0,
      skip_reasons: {} as Record<string, number>,
    };

    const noteSkip = (reason: string) => {
      summary.skipped += 1;
      summary.skip_reasons[reason] = (summary.skip_reasons[reason] || 0) + 1;
    };

    if (!dryRun) {
      const { data: runRow, error: runError } = await supabase
        .from("structural_runs")
        .insert({
          started_at: nowIso,
          portfolio_id: portfolioId,
          dry_run: false,
          notes: {
            strategy: STRATEGY_TAG,
            max_new_groups: maxNewGroups,
            daily_group_cap: dailyGroupCap,
            stale_cutoff_minutes: MAX_PRICE_AGE_MINUTES,
            min_net_edge: MIN_NET_ENTRY_EDGE,
            min_market_liquidity: MIN_MARKET_LIQUIDITY,
            min_minutes_to_close: MIN_MINUTES_TO_CLOSE,
            quote_source: EXECUTION_TYPE,
          },
        })
        .select("id")
        .maybeSingle();
      if (runError) {
        console.warn("Failed to create structural_runs row:", runError.message);
      } else {
        structuralRunId = runRow?.id ?? null;
      }
    }

    const { data: openPositions, error: openPositionsError } = await supabase
      .from("paper_positions")
      .select("id, market_id, market_slug, market_title, outcome, shares, usd_size, entry_ts, structural_group_id")
      .eq("portfolio_id", portfolioId)
      .eq("strategy_lane", STRATEGY_LANE)
      .eq("status", "OPEN")
      .order("entry_ts", { ascending: true })
      .limit(5000);
    if (openPositionsError) {
      console.warn("Failed to load open structural positions:", openPositionsError.message);
    }
    const openRows = (openPositions || []) as OpenPosition[];

    const openGroups = new Map<string, OpenPosition[]>();
    for (const pos of openRows) {
      const groupId = pos.structural_group_id || `${pos.market_id}:legacy`;
      if (!openGroups.has(groupId)) openGroups.set(groupId, []);
      openGroups.get(groupId)!.push(pos);
    }

    const openMarketIds = Array.from(new Set(openRows.map((r) => r.market_id).filter(Boolean)));
    const resolvedMarketSet = new Set<string>();
    const openMarketMetaMap = new Map<string, MarketMeta>();
    if (openMarketIds.length > 0) {
      const { data: openMarkets, error: openMarketsError } = await supabase
        .from("markets")
        .select("id, winning_outcome, close_time, question, slug, liquidity, stats_updated_at, outcome_token_map")
        .in("id", openMarketIds);
      if (openMarketsError) {
        console.warn("Failed to load market resolution for open groups:", openMarketsError.message);
      } else {
        for (const row of (openMarkets || []) as MarketMeta[]) {
          openMarketMetaMap.set(row.id, row);
          if (row?.id && row?.winning_outcome) {
            resolvedMarketSet.add(String(row.id));
          }
        }
      }
    }

    const { data: recentLaneRows, error: recentLaneError } = await supabase
      .from("paper_positions")
      .select("market_id, structural_group_id")
      .eq("portfolio_id", portfolioId)
      .eq("strategy_lane", STRATEGY_LANE)
      .gte("entry_ts", dailyCutoffIso)
      .limit(5000);
    if (recentLaneError) {
      console.warn("Failed to load recent structural positions:", recentLaneError.message);
    }

    const recentMarkets = new Set(
      (recentLaneRows || [])
        .map((row) => row.market_id)
        .filter((v): v is string => Boolean(v)),
    );
    const recentGroups = new Set(
      (recentLaneRows || [])
        .map((row) => row.structural_group_id)
        .filter((v): v is string => Boolean(v)),
    );

    const { data: recentPrices, error: recentPricesError } = await supabase
      .from("market_prices")
      .select("market_id, outcome, price, updated_at")
      .gte("updated_at", staleCutoffIso)
      .order("updated_at", { ascending: false })
      .limit(5000);
    if (recentPricesError) {
      throw new Error(`Failed to load market_prices: ${recentPricesError.message}`);
    }

    const pricesByMarket = new Map<string, MarketPrice[]>();
    for (const row of (recentPrices || []) as MarketPrice[]) {
      if (!row.market_id || !row.outcome) continue;
      if (!pricesByMarket.has(row.market_id)) pricesByMarket.set(row.market_id, []);
      pricesByMarket.get(row.market_id)!.push(row);
    }

    const candidateMarkets: Array<{
      market_id: string;
      outcomes: MarketPrice[];
      sum_price: number;
      edge: number;
    }> = [];

    for (const [marketId, rows] of pricesByMarket.entries()) {
      const dedup = new Map<string, MarketPrice>();
      for (const row of rows) {
        if (!dedup.has(row.outcome)) dedup.set(row.outcome, row);
      }
      const outcomes = Array.from(dedup.values());
      if (outcomes.length !== 2) continue;
      const p0 = toNumber(outcomes[0].price);
      const p1 = toNumber(outcomes[1].price);
      if (p0 == null || p1 == null) continue;
      if (p0 <= MIN_OUTCOME_PRICE || p1 <= MIN_OUTCOME_PRICE) continue;
      if (p0 >= MAX_OUTCOME_PRICE || p1 >= MAX_OUTCOME_PRICE) continue;
      const sumPrice = p0 + p1;
      const edge = 1 - sumPrice;
      if (sumPrice > MAX_ENTRY_SUM || edge < MIN_ENTRY_EDGE) continue;
      candidateMarkets.push({
        market_id: marketId,
        outcomes,
        sum_price: sumPrice,
        edge,
      });
    }

    summary.markets_scanned = pricesByMarket.size;
    summary.opportunities_found = candidateMarkets.length;

    const candidateIds = candidateMarkets.map((c) => c.market_id);
    const marketMetaMap = new Map<string, MarketMeta>();
    const allMetaIds = Array.from(new Set([...openMarketIds, ...candidateIds]));
    if (allMetaIds.length > 0) {
      for (let i = 0; i < allMetaIds.length; i += 200) {
        const batch = allMetaIds.slice(i, i + 200);
        const { data: marketsBatch, error: marketsError } = await supabase
          .from("markets")
          .select("id, question, slug, winning_outcome, liquidity, stats_updated_at, close_time, outcome_token_map")
          .in("id", batch);
        if (marketsError) {
          console.warn("Failed to load markets for structural scan:", marketsError.message);
          continue;
        }
        for (const row of (marketsBatch || []) as MarketMeta[]) {
          marketMetaMap.set(row.id, row);
          if (openMarketMetaMap.has(row.id)) {
            openMarketMetaMap.set(row.id, row);
          }
        }
      }
    }

    const enrichUpdates = await enrichMarketsFromGamma(Array.from(marketMetaMap.values()));
    if (enrichUpdates.size > 0) {
      const updateRows: Array<Record<string, unknown>> = [];
      for (const [marketId, patch] of enrichUpdates.entries()) {
        const existing = marketMetaMap.get(marketId);
        const merged: MarketMeta = {
          id: marketId,
          question: (patch.question as string | null) ?? existing?.question ?? null,
          slug: (patch.slug as string | null) ?? existing?.slug ?? null,
          winning_outcome: existing?.winning_outcome ?? null,
          liquidity: patch.liquidity ?? existing?.liquidity ?? null,
          stats_updated_at: existing?.stats_updated_at ?? null,
          close_time: (patch.close_time as string | null) ?? existing?.close_time ?? null,
          outcome_token_map: patch.outcome_token_map ?? existing?.outcome_token_map ?? null,
        };
        marketMetaMap.set(marketId, merged);
        if (openMarketMetaMap.has(marketId)) {
          openMarketMetaMap.set(marketId, merged);
        }
        updateRows.push({
          id: marketId,
          question: merged.question,
          slug: merged.slug,
          liquidity: merged.liquidity,
          close_time: merged.close_time,
          outcome_token_map: merged.outcome_token_map,
        });
      }

      if (!dryRun && updateRows.length > 0) {
        const { error: updateMetaError } = await supabase
          .from("markets")
          .upsert(updateRows, { onConflict: "id" });
        if (updateMetaError) {
          console.warn("Failed to persist enriched market metadata:", updateMetaError.message);
        }
      }
    }

    const quoteTargets = new Map<string, { market_id: string; outcome: string; token_id: string }>();
    for (const pos of openRows) {
      const tokenMap = parseOutcomeTokenMap(openMarketMetaMap.get(pos.market_id)?.outcome_token_map ?? null);
      const tokenId = getOutcomeTokenId(tokenMap, pos.outcome);
      if (!tokenId) continue;
      quoteTargets.set(`${pos.market_id}:${pos.outcome}`, {
        market_id: pos.market_id,
        outcome: pos.outcome,
        token_id: tokenId,
      });
    }
    for (const candidate of candidateMarkets) {
      const meta = marketMetaMap.get(candidate.market_id);
      const tokenMap = parseOutcomeTokenMap(meta?.outcome_token_map ?? null);
      for (const outcomeRow of candidate.outcomes) {
        const tokenId = getOutcomeTokenId(tokenMap, outcomeRow.outcome);
        if (!tokenId) continue;
        quoteTargets.set(`${candidate.market_id}:${outcomeRow.outcome}`, {
          market_id: candidate.market_id,
          outcome: outcomeRow.outcome,
          token_id: tokenId,
        });
      }
    }

    const quoteMap = await fetchOrderBooks(Array.from(new Set(Array.from(quoteTargets.values()).map((q) => q.token_id))));

    if (!dryRun && quoteTargets.size > 0) {
      const quoteRows = Array.from(quoteTargets.values()).map((target) => {
        const quote = quoteMap.get(target.token_id);
        return {
          market_id: target.market_id,
          outcome: target.outcome,
          token_id: target.token_id,
          best_bid: quote?.bestBid ?? null,
          best_ask: quote?.bestAsk ?? null,
          bid_depth: quote?.bidDepth ?? null,
          ask_depth: quote?.askDepth ?? null,
          midpoint: quote?.midpoint ?? null,
          last_trade_price: null,
          tick_size: quote?.tickSize ?? null,
          min_order_size: quote?.minOrderSize ?? null,
          neg_risk: quote?.negRisk ?? null,
          quote_ts: quote?.quoteTs ?? nowIso,
          updated_at: nowIso,
        };
      });
      const { error: quotesError } = await supabase
        .from("market_quotes")
        .upsert(quoteRows, { onConflict: "market_id,outcome" });
      if (quotesError) {
        console.warn("Failed to upsert market quotes:", quotesError.message);
      }
    }

    for (const [, legs] of openGroups.entries()) {
      if (legs.length !== 2) {
        noteSkip("invalid_open_group_legs");
        continue;
      }
      const marketId = legs[0].market_id;
      if (!marketId) {
        noteSkip("invalid_open_group_market");
        continue;
      }

      if (resolvedMarketSet.has(marketId)) {
        noteSkip("resolved_market_wait_for_settlement");
        continue;
      }

      const marketMeta = openMarketMetaMap.get(marketId);
      const tokenMap = parseOutcomeTokenMap(marketMeta?.outcome_token_map ?? null);
      const quote0 = quoteMap.get(getOutcomeTokenId(tokenMap, legs[0].outcome) ?? "");
      const quote1 = quoteMap.get(getOutcomeTokenId(tokenMap, legs[1].outcome) ?? "");
      if (!quote0 || !quote1) {
        noteSkip("missing_open_leg_quote");
        continue;
      }

      const shares0 = toNumber(legs[0].shares) ?? 0;
      const shares1 = toNumber(legs[1].shares) ?? 0;
      const exitPx0 = weightedAveragePrice(quote0.bids, shares0);
      const exitPx1 = weightedAveragePrice(quote1.bids, shares1);
      if (exitPx0 == null || exitPx1 == null) {
        noteSkip("insufficient_exit_depth");
        continue;
      }

      const totalUsd = legs.reduce((acc, row) => acc + (toNumber(row.usd_size) ?? 0), 0);
      const minShares = Math.min(...legs.map((row) => toNumber(row.shares) ?? Number.POSITIVE_INFINITY));
      if (!Number.isFinite(minShares) || minShares <= 0 || totalUsd <= 0) {
        noteSkip("invalid_open_leg_size");
        continue;
      }

      const entryTs = legs
        .map((row) => row.entry_ts)
        .filter((v): v is string => Boolean(v))
        .sort()[0];
      const holdHours = entryTs
        ? (now.getTime() - new Date(entryTs).getTime()) / (1000 * 60 * 60)
        : 0;
      const entrySum = totalUsd / minShares;
      const currentSum = exitPx0 + exitPx1;
      const minutesToClose = getMinutesUntil(now, toIsoIfValid(marketMeta?.close_time ?? null));

      let exitReason: string | null = null;
      if (currentSum >= entrySum + TAKE_PROFIT_SUM_DELTA) {
        exitReason = "take_profit";
      } else if (currentSum <= entrySum - STOP_LOSS_SUM_DELTA) {
        exitReason = "stop_loss";
      } else if (minutesToClose != null && minutesToClose <= FORCE_EXIT_MINUTES_TO_CLOSE) {
        exitReason = "close_time_guard";
      } else if (holdHours >= HARD_MAX_HOLD_HOURS) {
        exitReason = "time_stop";
      } else if (holdHours >= SOFT_MAX_HOLD_HOURS && currentSum > entrySum) {
        exitReason = "time_take_profit";
      }
      if (!exitReason) continue;

      if (!dryRun) {
        for (const leg of legs) {
          const shares = toNumber(leg.shares) ?? 0;
          const usdSize = toNumber(leg.usd_size) ?? 0;
          const exitPrice = leg.outcome === legs[0].outcome ? exitPx0 : exitPx1;
          const pnlUsd = shares * exitPrice - usdSize;
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
            .eq("id", leg.id)
            .eq("status", "OPEN");
          if (closeError) {
            console.warn(`Failed to close structural leg ${leg.id}:`, closeError.message);
            noteSkip("close_update_failed");
            continue;
          }
          summary.legs_closed += 1;
        }
      } else {
        summary.legs_closed += 2;
      }
      openTotalUsd = Math.max(0, openTotalUsd - totalUsd);
      summary.groups_closed += 1;
    }

    candidateMarkets.sort((a, b) => b.edge - a.edge);

    for (const candidate of candidateMarkets) {
      if (summary.groups_opened >= maxNewGroups) break;
      if (recentGroups.size + summary.groups_opened >= dailyGroupCap) {
        noteSkip("daily_group_cap");
        break;
      }
      if (recentMarkets.has(candidate.market_id)) {
        noteSkip("market_already_traded_24h");
        continue;
      }
      if (openMarketIds.includes(candidate.market_id)) {
        noteSkip("market_already_open");
        continue;
      }

      const marketMeta = marketMetaMap.get(candidate.market_id);
      if (!marketMeta) {
        noteSkip("missing_market_metadata");
        continue;
      }
      if (marketMeta.winning_outcome) {
        noteSkip("market_already_resolved");
        continue;
      }
      const marketLiquidity = toNumber(marketMeta.liquidity) ?? 0;
      if (marketLiquidity > 0 && marketLiquidity < MIN_MARKET_LIQUIDITY) {
        noteSkip("thin_market");
        continue;
      }
      const minutesToClose = getMinutesUntil(now, toIsoIfValid(marketMeta.close_time));
      if (minutesToClose != null && minutesToClose <= MIN_MINUTES_TO_CLOSE) {
        noteSkip("too_close_to_resolution");
        continue;
      }
      if (minutesToClose == null && looksIntradayMarket(marketMeta.slug, marketMeta.question)) {
        noteSkip("intraday_market");
        continue;
      }

      const tokenMap = parseOutcomeTokenMap(marketMeta.outcome_token_map);
      if (!tokenMap) {
        noteSkip("missing_token_map");
        continue;
      }

      const legQuotes = candidate.outcomes.map((outcomeRow) => {
        const tokenId = getOutcomeTokenId(tokenMap, outcomeRow.outcome);
        return {
          outcome: outcomeRow.outcome,
          tokenId,
          quote: tokenId ? quoteMap.get(tokenId) ?? null : null,
        };
      });

      if (legQuotes.some((leg) => !leg.tokenId || !leg.quote)) {
        noteSkip("missing_order_book");
        continue;
      }

      const bestAskSum = legQuotes.reduce((acc, leg) => acc + ((leg.quote?.bestAsk) ?? Number.NaN), 0);
      if (!Number.isFinite(bestAskSum) || bestAskSum > MAX_ENTRY_SUM) {
        noteSkip("entry_sum_too_high");
        continue;
      }

      const indicativeEdge = 1 - bestAskSum;
      if (indicativeEdge < MIN_NET_ENTRY_EDGE) {
        noteSkip("net_edge_too_small");
        continue;
      }

      const sizeFactor = clamp(indicativeEdge / MIN_NET_ENTRY_EDGE, 0.60, 2.20);
      const liquidityCapUsd = marketLiquidity > 0
        ? clamp(marketLiquidity * 0.0005, MIN_STRUCTURAL_USD, MAX_STRUCTURAL_USD)
        : baseUsd;
      let totalUsd = clamp(
        Math.min(baseUsd * sizeFactor, liquidityCapUsd),
        MIN_STRUCTURAL_USD,
        MAX_STRUCTURAL_USD,
      );

      if (openTotalUsd + totalUsd > maxOpenExposureUsd) {
        noteSkip("total_exposure_cap");
        continue;
      }

      let shares = totalUsd / bestAskSum;
      const actualAsks = legQuotes.map((leg) => weightedAveragePrice(leg.quote!.asks, shares));
      if (actualAsks.some((px) => px == null)) {
        noteSkip("insufficient_entry_depth");
        continue;
      }
      const actualAskSum = actualAsks.reduce((acc, px) => acc + (px ?? 0), 0);
      const actualEdge = 1 - actualAskSum;
      if (actualEdge < MIN_NET_ENTRY_EDGE) {
        noteSkip("net_edge_too_small");
        continue;
      }

      totalUsd = clamp(
        Math.min(baseUsd * clamp(actualEdge / MIN_NET_ENTRY_EDGE, 0.60, 2.20), liquidityCapUsd),
        MIN_STRUCTURAL_USD,
        MAX_STRUCTURAL_USD,
      );
      if (openTotalUsd + totalUsd > maxOpenExposureUsd) {
        noteSkip("total_exposure_cap");
        continue;
      }

      shares = totalUsd / actualAskSum;
      const entryPrices = legQuotes.map((leg) => weightedAveragePrice(leg.quote!.asks, shares));
      if (entryPrices.some((px) => px == null)) {
        noteSkip("insufficient_entry_depth");
        continue;
      }
      const finalEntrySum = entryPrices.reduce((acc, px) => acc + (px ?? 0), 0);
      const finalEdge = 1 - finalEntrySum;
      if (finalEdge < MIN_NET_ENTRY_EDGE) {
        noteSkip("net_edge_too_small");
        continue;
      }

      const groupId = `${STRATEGY_WALLET}:${candidate.market_id}:${Date.now()}:${summary.groups_opened + 1}`;
      const legs = candidate.outcomes.map((outcomeRow, idx) => {
        const marketQuote = legQuotes[idx].quote!;
        const bestAsk = marketQuote.bestAsk ?? entryPrices[idx] ?? 0;
        const entryPrice = entryPrices[idx] ?? bestAsk;
        return {
          portfolio_id: portfolioId,
          source_wallet: STRATEGY_WALLET,
          source_trade_id: `${groupId}:${idx + 1}`,
          source_trade_ts: nowIso,
          market_id: candidate.market_id,
          market_slug: marketMeta.slug ?? null,
          market_title: marketMeta.question ?? null,
          outcome: outcomeRow.outcome,
          side: "BUY",
          source_price: bestAsk,
          entry_price: entryPrice,
          price_penalty: entryPrice - bestAsk,
          copy_factor: null,
          entry_ts: nowIso,
          usd_size: shares * entryPrice,
          shares,
          status: "OPEN",
          sizing_method: "structural_parity_clob_book",
          fixed_usd_per_trade: baseUsd,
          strategy_lane: STRATEGY_LANE,
          strategy_tag: STRATEGY_TAG,
          execution_type: EXECUTION_TYPE,
          edge_bps: finalEdge * 10000,
          structural_group_id: groupId,
          updated_at: nowIso,
        };
      });

      if (!dryRun) {
        const { error: insertError } = await supabase
          .from("paper_positions")
          .insert(legs);
        if (insertError) {
          console.warn("Failed to insert structural legs:", insertError.message);
          noteSkip("insert_failed");
          continue;
        }
      }

      openTotalUsd += totalUsd;
      recentMarkets.add(candidate.market_id);
      recentGroups.add(groupId);
      summary.groups_opened += 1;
      summary.legs_opened += legs.length;
    }

    if (!dryRun) {
      const { data: resetRows, error: resetError } = await supabase
        .from("paper_strategy_resets")
        .select("reset_at")
        .eq("portfolio_id", portfolioId)
        .order("reset_at", { ascending: false })
        .limit(1);
      if (resetError) {
        console.warn("Failed to load reset marker for diagnostics:", resetError.message);
      }
      const resetAt = resetRows?.[0]?.reset_at ?? "1970-01-01T00:00:00.000Z";

      const { data: diagRows, error: diagError } = await supabase
        .from("paper_positions_with_price")
        .select("strategy_lane,status,usd_size,shares,pnl_usd,current_price,entry_ts,exit_ts,execution_type,edge_bps,exit_reason")
        .eq("portfolio_id", portfolioId)
        .gte("entry_ts", resetAt)
        .neq("status", "CANCELED")
        .limit(10000);
      if (diagError) {
        console.warn("Failed to load paper positions for diagnostics:", diagError.message);
      } else {
        const rows = diagRows || [];
        const lanes = ["copy", "structural"];
        const inserts: Array<Record<string, unknown>> = [];
        for (const lane of lanes) {
          const laneRows = rows.filter((r: any) => (r.strategy_lane || "copy") === lane);
          const settled = laneRows.filter((r: any) => r.status === "SETTLED");
          const open = laneRows.filter((r: any) => r.status === "OPEN");

          const realized = settled.reduce((acc: number, r: any) => acc + (toNumber(r.pnl_usd) ?? 0), 0);
          const unrealized = open.reduce((acc: number, r: any) => {
            const shares = toNumber(r.shares) ?? 0;
            const currentPrice = toNumber(r.current_price);
            const usdSize = toNumber(r.usd_size) ?? 0;
            if (currentPrice == null) return acc;
            return acc + (shares * currentPrice - usdSize);
          }, 0);

          const holdMinutes = settled
            .map((r: any) => {
              if (!r.entry_ts || !r.exit_ts) return null;
              const mins = (new Date(r.exit_ts).getTime() - new Date(r.entry_ts).getTime()) / (1000 * 60);
              return Number.isFinite(mins) && mins >= 0 ? mins : null;
            })
            .filter((v: any): v is number => v != null);

          const edgeRows = laneRows
            .map((r: any) => ({
              size: toNumber(r.usd_size),
              edge: toNumber(r.edge_bps),
            }))
            .filter((r: any) => r.size != null && r.edge != null) as Array<{ size: number; edge: number }>;

          const limitRows = laneRows.filter((r: any) => String(r.execution_type || "").toLowerCase().includes("clob"));
          const preResolutionSettles = settled.filter((r: any) => r.exit_reason != null);
          const resolutionPnl = settled
            .filter((r: any) => r.exit_reason == null)
            .reduce((acc: number, r: any) => acc + (toNumber(r.pnl_usd) ?? 0), 0);
          const structuralPnl = settled
            .filter((r: any) => r.exit_reason != null)
            .reduce((acc: number, r: any) => acc + (toNumber(r.pnl_usd) ?? 0), 0);

          let profitSource = "none";
          if (Math.abs(structuralPnl) > Math.abs(resolutionPnl) && Math.abs(structuralPnl) > 0) {
            profitSource = "structural";
          } else if (Math.abs(resolutionPnl) > 0) {
            profitSource = "resolution";
          }

          inserts.push({
            computed_at: nowIso,
            portfolio_id: portfolioId,
            scope: "since_reset",
            strategy_lane: lane,
            positions_total: laneRows.length,
            open_positions: open.length,
            settled_positions: settled.length,
            exit_before_resolution_pct: settled.length > 0
              ? preResolutionSettles.length / settled.length
              : null,
            median_hold_minutes: median(holdMinutes),
            limit_order_pct: laneRows.length > 0 ? limitRows.length / laneRows.length : null,
            size_edge_correlation: edgeRows.length >= 3
              ? pearsonCorrelation(
                edgeRows.map((r) => r.size),
                edgeRows.map((r) => r.edge),
              )
              : null,
            realized_pnl: realized,
            unrealized_pnl: unrealized,
            projected_pnl: realized + unrealized,
            profit_source: profitSource,
            notes: {
              reset_at: resetAt,
              structural_run_id: structuralRunId,
              resolution_pnl: resolutionPnl,
              structural_pnl: structuralPnl,
            },
          });
        }

        if (inserts.length > 0) {
          const { error: insertDiagError } = await supabase
            .from("paper_strategy_diagnostics")
            .insert(inserts);
          if (insertDiagError) {
            console.warn("Failed to insert strategy diagnostics:", insertDiagError.message);
          }
        }
      }
    }

    if (!dryRun && structuralRunId) {
      const { error: runUpdateError } = await supabase
        .from("structural_runs")
        .update({
          finished_at: new Date().toISOString(),
          markets_scanned: summary.markets_scanned,
          opportunities_found: summary.opportunities_found,
          groups_opened: summary.groups_opened,
          legs_opened: summary.legs_opened,
          groups_closed: summary.groups_closed,
          legs_closed: summary.legs_closed,
          skipped: summary.skipped,
          skip_reasons: summary.skip_reasons,
        })
        .eq("id", structuralRunId);
      if (runUpdateError) {
        console.warn("Failed to update structural_runs summary:", runUpdateError.message);
      }
    }

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-structural-paper error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message || error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
