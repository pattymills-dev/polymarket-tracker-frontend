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
    // Focus on markets with recent activity (last 7 days) to avoid stale markets
    const { data: markets, error: marketsError } = await supabase
      .from("markets")
      .select("id, slug")
      .eq("resolved", false)  // Only active markets
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

    // Fetch market data from Gamma API in batches
    // The Gamma API supports fetching by condition ID
    const BATCH_SIZE = 50;
    let updated = 0;
    let errors = 0;

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const batch = markets.slice(i, i + BATCH_SIZE);
      const conditionIds = batch.map(m => m.id).filter(Boolean);

      if (conditionIds.length === 0) continue;

      try {
        // Fetch market data from Gamma API
        // The API accepts comma-separated condition IDs
        const gammaUrl = `https://gamma-api.polymarket.com/markets?` +
          conditionIds.map(id => `id=${id}`).join('&');

        const response = await fetch(gammaUrl);

        if (!response.ok) {
          console.error(`Gamma API error: ${response.status}`);
          errors++;
          continue;
        }

        const gammaMarkets = await response.json();

        if (!Array.isArray(gammaMarkets)) {
          console.error("Gamma API returned non-array response");
          continue;
        }

        // Update each market's stats
        for (const gm of gammaMarkets) {
          const volume24h = parseFloat(gm.volume24hr) || 0;
          const liquidity = parseFloat(gm.liquidityNum) || parseFloat(gm.liquidity) || 0;

          const { error: updateError } = await supabase
            .from("markets")
            .update({
              volume_24h: volume24h,
              liquidity: liquidity,
              stats_updated_at: new Date().toISOString(),
            })
            .eq("id", gm.conditionId);

          if (updateError) {
            console.error(`Failed to update market ${gm.conditionId}:`, updateError);
            errors++;
          } else {
            updated++;
          }
        }

        console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: Updated ${gammaMarkets.length} markets`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (batchError) {
        console.error(`Batch error:`, batchError);
        errors++;
      }
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
