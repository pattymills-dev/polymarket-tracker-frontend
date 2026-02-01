import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
      for (const gm of allGammaMarkets) {
        if (gm.conditionId) {
          gammaMap.set(gm.conditionId, gm);
        }
      }

      // Update our markets with the Gamma data
      for (const market of markets) {
        const gammaData = gammaMap.get(market.id);

        if (gammaData) {
          const volume24h = parseFloat(gammaData.volume24hr) || 0;
          const liquidity = parseFloat(gammaData.liquidityNum) || parseFloat(gammaData.liquidity) || 0;

          const { error: updateError } = await supabase
            .from("markets")
            .update({
              volume_24h: volume24h,
              liquidity: liquidity,
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
