import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "supabase";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type GammaMarket = {
  conditionId?: string;
  slug?: string;
  question?: string;
  title?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") || "200", 10), 1),
      1000,
    );
    const chunkSize = Math.min(
      Math.max(parseInt(url.searchParams.get("chunk") || "50", 10), 1),
      200,
    );

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: markets, error } = await supabase
      .from("markets")
      .select("id")
      .or("slug.is.null,question.is.null")
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch markets: ${error.message}`);
    }

    if (!markets || markets.length === 0) {
      return new Response(
        JSON.stringify({ success: true, updated: 0, lookedUp: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let lookedUp = 0;
    let updated = 0;
    let gammaErrors = 0;

    for (let i = 0; i < markets.length; i += chunkSize) {
      const chunk = markets.slice(i, i + chunkSize);
      const ids = chunk.map((m: any) => m.id).filter(Boolean);
      if (ids.length === 0) continue;

      const gammaUrl = new URL("https://gamma-api.polymarket.com/markets");
      gammaUrl.searchParams.set("condition_ids", ids.join(","));

      const response = await fetch(gammaUrl.toString());
      if (!response.ok) {
        gammaErrors += 1;
        continue;
      }

      const gammaMarkets: GammaMarket[] = await response.json();
      lookedUp += ids.length;

      if (!Array.isArray(gammaMarkets) || gammaMarkets.length === 0) {
        continue;
      }

      const updates = gammaMarkets
        .filter((gm) => gm.conditionId && gm.slug)
        .map((gm) => ({
          id: gm.conditionId,
          slug: gm.slug ?? null,
          question: gm.question ?? gm.title ?? null,
        }));

      let batchUpdated = 0;
      if (updates.length > 0) {
        const { error: updateError } = await supabase
          .from("markets")
          .upsert(updates, { onConflict: "id" });

        if (updateError) {
          gammaErrors += 1;
        } else {
          updated += updates.length;
          batchUpdated = updates.length;
        }
      }

      // Fallback: if bulk lookup returned nothing, try per-conditionId lookup
      if (batchUpdated === 0) {
        for (const id of ids) {
          try {
            const fallbackUrl = `https://gamma-api.polymarket.com/markets/condition/${id}`;
            const fallbackResp = await fetch(fallbackUrl);
            if (!fallbackResp.ok) continue;

            const gm: GammaMarket = await fallbackResp.json();
            lookedUp += 1;

            if (!gm?.conditionId || !gm?.slug) continue;
            const row = {
              id: gm.conditionId,
              slug: gm.slug ?? null,
              question: gm.question ?? gm.title ?? null,
            };

            const { error: upsertError } = await supabase
              .from("markets")
              .upsert([row], { onConflict: "id" });

            if (upsertError) {
              gammaErrors += 1;
            } else {
              updated += 1;
            }
          } catch (_error) {
            gammaErrors += 1;
          }
        }
      }
    }

    // Backfill trade slugs/titles after updating markets
    const { data: backfillCount, error: backfillError } = await supabase
      .rpc("backfill_trade_slugs");

    if (backfillError) {
      console.error("Backfill trade slugs error:", backfillError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        lookedUp,
        updated,
        gammaErrors,
        tradeSlugsUpdated: backfillCount ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Function error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message ?? error) }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});
