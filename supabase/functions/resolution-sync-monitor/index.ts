import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPPORTED_SPORTS_LEAGUES = [
  "nba", "nhl", "mlb", "nfl", "cbb", "cwbb", "ahl",
  "epl", "efl", "bun", "mls", "lal", "ser", "lig1",
  "copa", "mex", "bl2", "aus", "fl1", "ere", "elc", "sea", "spl", "cbl", "udi", "acm",
  "por", "tur", "egy1", "bra", "arg", "chi1", "col1", "rou1", "rusrp", "es2", "fr2", "itsb", "den",
  "wta", "atp", "ufc",
  "cs2", "val", "lol", "dota2", "rl", "lec", "lpl", "lck", "vct", "hok", "r6siege", "sc2", "codmw",
  "bkkbl", "bknbl", "euroleague", "shl", "khl",
  "crint", "wttmen", "wttwom", "scop", "cze1", "mwoh", "rusixnat",
];

const SPORTS_SLUG_REGEX = new RegExp(
  `^(${SUPPORTED_SPORTS_LEAGUES.join("|")})-(.+)-(\\d{4}-\\d{2}-\\d{2})(?:-.+)?$`,
  "i",
);

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatTs(value: string | null): string {
  if (!value) return "n/a";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "n/a";
}

function buildTopList(items: Array<{ label: string; ts: string | null }>, limit = 3): string {
  return items
    .slice(0, limit)
    .map((item) => `${item.label} (${formatTs(item.ts)})`)
    .join(", ") || "none";
}

function buildSportsPrefixOr(): string {
  return SUPPORTED_SPORTS_LEAGUES
    .map((league) => `slug.ilike.${league}-%`)
    .join(",");
}

function extractSportsDate(slug: string | null): string | null {
  if (typeof slug !== "string") return null;
  const match = slug.match(SPORTS_SLUG_REGEX);
  return match ? match[3] : null;
}

function isStaleResolutionTrade(tradeTs: string | null, resolutionCheckedAt: string | null, staleHours: number): boolean {
  const tradeMs = tradeTs ? Date.parse(tradeTs) : NaN;
  if (!Number.isFinite(tradeMs)) return false;
  if (Date.now() - tradeMs < staleHours * 60 * 60 * 1000) return false;

  if (!resolutionCheckedAt) return true;
  const checkedMs = Date.parse(resolutionCheckedAt);
  if (!Number.isFinite(checkedMs)) return true;
  return Date.now() - checkedMs >= 6 * 60 * 60 * 1000;
}

async function sendTelegramMessage(text: string): Promise<void> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    throw new Error("Telegram not configured (missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)");
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram API error: ${error}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUrl = new URL(req.url);
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const topTraderLimit = Math.max(1, Math.min(toNumber(requestUrl.searchParams.get("top_traders")) ?? 10, 25));
    const perTraderTradeLimit = Math.max(10, Math.min(toNumber(requestUrl.searchParams.get("per_trader_trades")) ?? 50, 100));
    const staleHours = Math.max(6, Math.min(toNumber(requestUrl.searchParams.get("stale_hours")) ?? 24, 168));
    const sportsDays = Math.max(1, Math.min(toNumber(requestUrl.searchParams.get("sports_days")) ?? 7, 14));

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: topTraders, error: tradersError } = await supabase
      .from("trader_rankings")
      .select("trader_address,copyable_rank_30d")
      .not("copyable_rank_30d", "is", null)
      .order("copyable_rank_30d", { ascending: true })
      .limit(topTraderLimit);

    if (tradersError) {
      throw new Error(`Failed to load top traders: ${tradersError.message}`);
    }

    let staleUiPending = 0;
    const staleUiExamples: Array<{ label: string; ts: string | null }> = [];

    for (const trader of topTraders || []) {
      const wallet = trader?.trader_address;
      if (typeof wallet !== "string" || wallet.length === 0) continue;

      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select("market_id,market_slug,timestamp")
        .eq("trader_address", wallet)
        .order("timestamp", { ascending: false })
        .limit(perTraderTradeLimit);

      if (tradesError) {
        console.warn(`Failed to load recent trades for ${wallet}:`, tradesError.message);
        continue;
      }

      const marketIds = Array.from(new Set((trades || []).map((trade: any) => trade.market_id).filter(Boolean)));
      const markets: any[] = [];
      for (let start = 0; start < marketIds.length; start += 40) {
        const chunk = marketIds.slice(start, start + 40);
        const { data: rows, error: marketsError } = await supabase
          .from("markets")
          .select("id,resolved,winning_outcome,resolution_checked_at")
          .in("id", chunk);
        if (marketsError) {
          console.warn(`Failed to load market rows for ${wallet}:`, marketsError.message);
          continue;
        }
        markets.push(...(rows || []));
      }

      const marketMap = new Map(markets.map((market) => [market.id, market]));
      const seenMarkets = new Set<string>();
      for (const trade of trades || []) {
        const marketId = (trade as any)?.market_id;
        if (typeof marketId !== "string" || seenMarkets.has(marketId)) continue;
        seenMarkets.add(marketId);

        const market = marketMap.get(marketId);
        const isResolved = Boolean(market?.resolved) || market?.winning_outcome != null;
        if (isResolved) continue;
        if (!isStaleResolutionTrade((trade as any)?.timestamp ?? null, market?.resolution_checked_at ?? null, staleHours)) continue;

        staleUiPending += 1;
        if (staleUiExamples.length < 5) {
          staleUiExamples.push({
            label: `${wallet.slice(0, 6)}… ${String((trade as any)?.market_slug || marketId)}`,
            ts: (trade as any)?.timestamp ?? null,
          });
        }
      }
    }

    const sportsPrefixOr = buildSportsPrefixOr();
    const { data: sportsMarkets, error: sportsError } = await supabase
      .from("markets")
      .select("slug,resolution_checked_at")
      .not("slug", "is", null)
      .is("winning_outcome", null)
      .or(sportsPrefixOr)
      .order("slug", { ascending: false })
      .limit(2000);

    if (sportsError) {
      throw new Error(`Failed to load recent sports markets: ${sportsError.message}`);
    }

    let staleSports = 0;
    const staleSportsExamples: Array<{ label: string; ts: string | null }> = [];
    for (const row of sportsMarkets || []) {
      const date = extractSportsDate((row as any)?.slug ?? null);
      if (!date) continue;
      const eventMs = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(eventMs)) continue;
      if (Date.now() - eventMs > sportsDays * 24 * 60 * 60 * 1000) continue;
      if (Date.now() - eventMs < staleHours * 60 * 60 * 1000) continue;

      staleSports += 1;
      if (staleSportsExamples.length < 5) {
        staleSportsExamples.push({
          label: String((row as any)?.slug),
          ts: (row as any)?.resolution_checked_at ?? null,
        });
      }
    }

    let message = "RESOLUTION SYNC HEALTH";
    message += `\nTop-trader stale pending: ${staleUiPending}`;
    message += `\nRecent sports stale unresolved: ${staleSports}`;
    if (staleUiExamples.length > 0) {
      message += `\nTrader examples: ${buildTopList(staleUiExamples)}`;
    }
    if (staleSportsExamples.length > 0) {
      message += `\nSports examples: ${buildTopList(staleSportsExamples)}`;
    }

    const shouldAlert = staleUiPending > 0 || staleSports > 0;
    if (shouldAlert && !dryRun) {
      await sendTelegramMessage(message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        top_trader_stale_pending: staleUiPending,
        recent_sports_stale_unresolved: staleSports,
        should_alert: shouldAlert,
        message,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("resolution-sync-monitor error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message || error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
