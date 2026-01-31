import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    console.log("Populating markets table from existing trades...");

    // Get unique market IDs from trades
    const { data: trades, error: tradesError } = await supabase
      .from("trades")
      .select("market_id, market_title, market_slug")
      .not("market_id", "is", null);

    if (tradesError) {
      throw new Error(`Failed to fetch trades: ${tradesError.message}`);
    }

    if (!trades || trades.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No trades found", inserted: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Group by market_id to get unique markets
    const marketMap = new Map();
    for (const trade of trades) {
      if (!marketMap.has(trade.market_id)) {
        marketMap.set(trade.market_id, {
          id: trade.market_id,
          question: trade.market_title || trade.market_slug || trade.market_id,
          slug: trade.market_slug,
          resolved: false,
        });
      }
    }

    const markets = Array.from(marketMap.values());
    console.log(`Found ${markets.length} unique markets from trades`);

    // Upsert markets (will skip if already exists)
    const { error: upsertError } = await supabase
      .from("markets")
      .upsert(markets, { onConflict: "id" });

    if (upsertError) {
      throw new Error(`Failed to upsert markets: ${upsertError.message}`);
    }

    console.log(`Successfully upserted ${markets.length} markets`);

    return new Response(
      JSON.stringify({
        success: true,
        inserted: markets.length,
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
