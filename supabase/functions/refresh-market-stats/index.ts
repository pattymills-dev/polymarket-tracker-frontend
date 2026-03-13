import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function toIsoIfValid(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

function buildOutcomeTokenMap(gammaData: any): Record<string, string> | null {
  const tokenMap: Record<string, string> = {};

  const tokensRaw = parseMaybeJson(gammaData?.tokens);
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

  if (Object.keys(tokenMap).length > 0) {
    return tokenMap;
  }

  const outcomesRaw = parseMaybeJson(gammaData?.outcomes);
  const clobTokenIdsRaw = parseMaybeJson(
    gammaData?.clobTokenIds ?? gammaData?.clobTokenIDs ?? gammaData?.clob_token_ids,
  );
  const outcomes = Array.isArray(outcomesRaw) ? outcomesRaw : [];
  const tokenIds = Array.isArray(clobTokenIdsRaw) ? clobTokenIdsRaw : [];
  if (outcomes.length === tokenIds.length && outcomes.length > 0) {
    outcomes.forEach((outcome, index) => {
      if (typeof outcome === "string" && typeof tokenIds[index] === "string") {
        tokenMap[outcome.trim()] = tokenIds[index].trim();
      }
    });
  }

  return Object.keys(tokenMap).length > 0 ? tokenMap : null;
}

/**
 * Refresh market stats (volume_24h, liquidity) from Polymarket Gamma API
 * This should run every 15 minutes via cron to keep market stats fresh
 * for Isolated Contact detection
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    console.log("Refreshing market stats from Polymarket Gamma API...");

    // Get all market IDs from our database that need stats
    // Focus on markets with hex conditionId format (0x...) - these are valid Polymarket IDs
    const { data: markets, error: marketsError } = await supabase
      .from("markets")
      .select("id, slug")
      .eq("resolved", false)  // Only active markets
      .like("id", "0x%")      // Only hex format IDs (valid conditionIds)
      .limit(500);  // Process in batches

    if (marketsError) {
      throw new Error(`Failed to fetch markets: ${marketsError.message}`);
    }

    if (!markets || markets.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No active markets to update", updated: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${markets.length} active markets to update`);

    // Fetch all active markets from Gamma API in one go, then match to our DB
    // This is more efficient than querying one-by-one
    let updated = 0;
    let errors = 0;

    try {
      // Fetch active markets from Gamma API (it returns up to 100 by default)
      // We'll need to paginate for more
      const allGammaMarkets: any[] = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore && offset < 1000) {  // Cap at 1000 markets
        const gammaUrl = `https://gamma-api.polymarket.com/markets?closed=false&limit=${limit}&offset=${offset}`;
        const response = await fetch(gammaUrl);

        if (!response.ok) {
          console.error(`Gamma API error: ${response.status}`);
          break;
        }

        const gammaMarkets = await response.json();

        if (!Array.isArray(gammaMarkets) || gammaMarkets.length === 0) {
          hasMore = false;
        } else {
          allGammaMarkets.push(...gammaMarkets);
          offset += limit;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      console.log(`Fetched ${allGammaMarkets.length} markets from Gamma API`);

      // Build a map of conditionId -> market data for fast lookup
      const gammaMap = new Map();
      const gammaSlugMap = new Map();
      for (const gm of allGammaMarkets) {
        if (typeof gm.conditionId === "string" && gm.conditionId.length > 0) {
          gammaMap.set(normalizeKey(gm.conditionId), gm);
        }
        if (typeof gm.slug === "string" && gm.slug.length > 0) {
          gammaSlugMap.set(normalizeKey(gm.slug), gm);
        }
      }

      // Update our markets with the Gamma data
      for (const market of markets) {
        const gammaData = gammaMap.get(normalizeKey(market.id)) ||
          (typeof market.slug === "string" && market.slug.length > 0
            ? gammaSlugMap.get(normalizeKey(market.slug))
            : null);

        if (gammaData) {
          const volume24h = parseFloat(gammaData.volume24hr) || 0;
          const liquidity = parseFloat(gammaData.liquidityNum) || parseFloat(gammaData.liquidity) || 0;
          const closeTime =
            toIsoIfValid(gammaData.endDateIso) ||
            toIsoIfValid(gammaData.end_date_iso) ||
            toIsoIfValid(gammaData.endDate) ||
            toIsoIfValid(gammaData.end_date) ||
            toIsoIfValid(gammaData.closeTime) ||
            toIsoIfValid(gammaData.closedTime) ||
            toIsoIfValid(gammaData.umaEndDate);
          const outcomeTokenMap = buildOutcomeTokenMap(gammaData);

          const { error: updateError } = await supabase
            .from("markets")
            .update({
              volume_24h: volume24h,
              liquidity: liquidity,
              close_time: closeTime,
              outcome_token_map: outcomeTokenMap,
              stats_updated_at: new Date().toISOString(),
            })
            .eq("id", market.id);

          if (updateError) {
            console.error(`Failed to update market ${market.id}:`, updateError);
            errors++;
          } else {
            updated++;
          }
        }
      }

    } catch (fetchError) {
      console.error(`Error fetching from Gamma API:`, fetchError);
      errors++;
    }

    // Also compute trade_count_24h from our trades table
    // This is more accurate for our filtered trades (>= $5k)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: tradeCounts, error: tradeCountError } = await supabase
      .rpc('get_market_trade_counts_24h', { since_timestamp: twentyFourHoursAgo });

    if (!tradeCountError && tradeCounts) {
      for (const tc of tradeCounts) {
        await supabase
          .from("markets")
          .update({ trade_count_24h: tc.trade_count })
          .eq("id", tc.market_id);
      }
      console.log(`Updated trade counts for ${tradeCounts.length} markets`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        updated,
        errors,
        totalMarkets: markets.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Function error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message ?? error) }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
