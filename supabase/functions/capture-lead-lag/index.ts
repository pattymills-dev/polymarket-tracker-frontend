import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CLOB_URL = "https://clob.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";
const MARKET_LIMIT = 250;
const MIN_LIQUIDITY = 50000;
const MAX_GROUP_SIZE = 4;

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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
  return null;
}

function getOutcomeTokenId(tokenMap: Record<string, string> | null, outcome: string): string | null {
  if (!tokenMap) return null;
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

function midpoint(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid == null || bestAsk == null) return null;
  return (bestBid + bestAsk) / 2;
}

function spreadBps(bestBid: number | null, bestAsk: number | null): number | null {
  const mid = midpoint(bestBid, bestAsk);
  if (mid == null || mid <= 0 || bestBid == null || bestAsk == null) return null;
  return ((bestAsk - bestBid) / mid) * 10_000;
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

type MarketMeta = {
  id: string;
  question: string | null;
  slug: string | null;
  winning_outcome: string | null;
  liquidity: number | string | null;
  close_time: string | null;
  outcome_token_map: unknown;
};

type Quote = {
  bestBid: number | null;
  bestAsk: number | null;
};

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

async function enrichMarketsFromGamma(markets: MarketMeta[]): Promise<Map<string, Partial<MarketMeta>>> {
  const updates = new Map<string, Partial<MarketMeta>>();
  for (const market of markets) {
    const hasTokenMap = parseOutcomeTokenMap(market.outcome_token_map);
    if (hasTokenMap) continue;
    let gammaMarket: any = null;
    if (market.slug) {
      try {
        gammaMarket = await fetchJson(`${GAMMA_URL}/markets/slug/${market.slug}`);
      } catch {
        gammaMarket = null;
      }
    }
    if (!gammaMarket) continue;
    updates.set(market.id, {
      outcome_token_map: buildOutcomeTokenMap(gammaMarket),
      close_time:
        toIsoIfValid(gammaMarket.endDateIso) ||
        toIsoIfValid(gammaMarket.end_date_iso) ||
        toIsoIfValid(gammaMarket.endDate) ||
        toIsoIfValid(gammaMarket.end_date) ||
        toIsoIfValid(gammaMarket.closeTime),
    });
  }
  return updates;
}

async function fetchBook(tokenId: string): Promise<Quote | null> {
  try {
    const book = await fetchJson(`${CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
    const bids = Array.isArray((book as any)?.bids) ? (book as any).bids : [];
    const asks = Array.isArray((book as any)?.asks) ? (book as any).asks : [];
    return {
      bestBid: toNumber(bids[0]?.price),
      bestAsk: toNumber(asks[0]?.price),
    };
  } catch (error) {
    console.warn(`Failed to fetch lead-lag book for ${tokenId}:`, String(error));
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const requestUrl = new URL(req.url);
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRole) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: markets, error: marketsError } = await supabase
      .from("markets")
      .select("id, question, slug, winning_outcome, liquidity, close_time, outcome_token_map")
      .is("winning_outcome", null)
      .order("liquidity", { ascending: false })
      .limit(MARKET_LIMIT);
    if (marketsError) throw new Error(`Failed to load markets: ${marketsError.message}`);

    const marketRows = ((markets || []) as MarketMeta[]).filter((row) => (toNumber(row.liquidity) ?? 0) >= MIN_LIQUIDITY && row.slug);
    const gammaUpdates = await enrichMarketsFromGamma(marketRows);
    for (const [marketId, patch] of gammaUpdates.entries()) {
      const existing = marketRows.find((row) => row.id === marketId);
      if (!existing) continue;
      existing.outcome_token_map = patch.outcome_token_map ?? existing.outcome_token_map;
      existing.close_time = (patch.close_time as string | null) ?? existing.close_time;
    }

    const groups = new Map<string, MarketMeta[]>();
    for (const market of marketRows) {
      const eventKey = extractEventKey(market.slug);
      if (!eventKey) continue;
      const tokenMap = parseOutcomeTokenMap(market.outcome_token_map);
      if (!tokenMap || !getOutcomeTokenId(tokenMap, "Yes")) continue;
      if (!groups.has(eventKey)) groups.set(eventKey, []);
      groups.get(eventKey)!.push(market);
    }

    const rows: Record<string, unknown>[] = [];
    for (const [eventKey, group] of groups.entries()) {
      if (group.length < 2) continue;
      const sorted = [...group]
        .sort((a, b) => (toNumber(b.liquidity) ?? 0) - (toNumber(a.liquidity) ?? 0))
        .slice(0, MAX_GROUP_SIZE);
      const leader = sorted[0];
      const leaderTokenMap = parseOutcomeTokenMap(leader.outcome_token_map);
      const leaderYesToken = getOutcomeTokenId(leaderTokenMap, "Yes");
      if (!leaderYesToken) continue;
      const leaderQuote = await fetchBook(leaderYesToken);
      if (!leaderQuote) continue;

      for (const follower of sorted.slice(1)) {
        const followerTokenMap = parseOutcomeTokenMap(follower.outcome_token_map);
        const followerYesToken = getOutcomeTokenId(followerTokenMap, "Yes");
        if (!followerYesToken) continue;
        const followerQuote = await fetchBook(followerYesToken);
        if (!followerQuote) continue;
        rows.push({
          captured_at: new Date().toISOString(),
          event_key: eventKey,
          leader_market_id: leader.id,
          leader_market_slug: leader.slug,
          leader_market_title: leader.question,
          leader_liquidity: toNumber(leader.liquidity),
          leader_mid: midpoint(leaderQuote.bestBid, leaderQuote.bestAsk),
          leader_best_bid: leaderQuote.bestBid,
          leader_best_ask: leaderQuote.bestAsk,
          leader_spread_bps: spreadBps(leaderQuote.bestBid, leaderQuote.bestAsk),
          follower_market_id: follower.id,
          follower_market_slug: follower.slug,
          follower_market_title: follower.question,
          follower_liquidity: toNumber(follower.liquidity),
          follower_mid: midpoint(followerQuote.bestBid, followerQuote.bestAsk),
          follower_best_bid: followerQuote.bestBid,
          follower_best_ask: followerQuote.bestAsk,
          follower_spread_bps: spreadBps(followerQuote.bestBid, followerQuote.bestAsk),
          mid_gap: ((midpoint(leaderQuote.bestBid, leaderQuote.bestAsk) ?? 0) - (midpoint(followerQuote.bestBid, followerQuote.bestAsk) ?? 0)),
          notes: {
            basis: "yes_mid",
            leader_close_time: leader.close_time,
            follower_close_time: follower.close_time,
          },
        });
      }
    }

    if (!dryRun && rows.length > 0) {
      const { error: insertError } = await supabase.from("lead_lag_snapshots").insert(rows);
      if (insertError) throw new Error(`Failed to insert lead_lag_snapshots: ${insertError.message}`);
    }

    return new Response(JSON.stringify({ success: true, dry_run: dryRun, snapshots_captured: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("capture-lead-lag error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error?.message || error) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
