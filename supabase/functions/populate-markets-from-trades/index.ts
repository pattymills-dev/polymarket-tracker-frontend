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

    // Paginate through all trades to get unique markets
    const marketMap = new Map();
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;
    let pagesProcessed = 0;
    const maxPages = 50; // Safety limit - covers up to 50k trades

    while (hasMore && pagesProcessed < maxPages) {
      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select("market_id, market_title, market_slug")
        .not("market_id", "is", null)
        .range(offset, offset + pageSize - 1);

      if (tradesError) {
        throw new Error(`Failed to fetch trades: ${tradesError.message}`);
      }

      if (!trades || trades.length === 0) {
        hasMore = false;
        break;
      }

      for (const trade of trades) {
        if (!marketMap.has(trade.market_id)) {
          marketMap.set(trade.market_id, {
            id: trade.market_id,
            question: trade.market_title || trade.market_slug || trade.market_id,
            slug: trade.market_slug,
            // Don't set resolved here - let the upsert preserve existing value
          });
        }
      }

      pagesProcessed++;
      console.log(`Page ${pagesProcessed}: ${trades.length} trades, ${marketMap.size} unique markets`);

      if (trades.length < pageSize) {
        hasMore = false;
      } else {
        offset += pageSize;
      }
    }

    if (marketMap.size === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No trades found", inserted: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const markets = Array.from(marketMap.values());
    console.log(`Found ${markets.length} unique markets from ${pagesProcessed} pages`);

    // Insert new markets only - don't update existing ones to preserve resolved/winning_outcome
    const { error: upsertError } = await supabase
      .from("markets")
      .upsert(markets, { onConflict: "id", ignoreDuplicates: true });

    if (upsertError) {
      throw new Error(`Failed to upsert markets: ${upsertError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        inserted: markets.length,
        slugsUpdated: markets.filter(m => m.slug).length,
        pagesProcessed,
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
