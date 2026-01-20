import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function safeNumber(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    console.log("Fetching trades from Polymarket Data API...");

    // Fetch ~10,000 trades per run to capture more whale activity
    const PAGE_SIZE = 500;
    const MAX_PAGES = 20;

    // Only store trades >= $5k to save database space
    const MIN_TRADE_SIZE = 5_000;
    const WHALE_THRESHOLD = 10_000;
    const MEGA_WHALE_THRESHOLD = 50_000;

    let fetchedTotal = 0;
    let upsertedTrades = 0;
    let insertedAlerts = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url =
        `https://data-api.polymarket.com/trades?limit=${PAGE_SIZE}&offset=${offset}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Data API returned ${response.status} for ${url}`);
      }

      const trades = await response.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        console.log(`No trades returned at offset=${offset}. Stopping.`);
        break;
      }

      fetchedTotal += trades.length;

      // 1) Map into your DB schema
      const rowsRaw = trades.map((t: any) => {
        const size = safeNumber(t.size);
        const price = safeNumber(t.price);
        const ts = safeNumber(t.timestamp);

        // "Cash" amount ≈ size * price
        const amount = size != null && price != null ? size * price : null;

        return {
          tx_hash: t.transactionHash ?? null,
          market_id: t.conditionId ?? null, // use conditionId
          market_slug: t.slug ?? null,
          market_title: t.title ?? null,
          trader_address: t.proxyWallet ?? null,
          outcome: t.outcome ?? null,
          amount,
          price,
          timestamp: ts != null ? new Date(ts * 1000).toISOString() : null,
        };
      });

      // 2) Filter out invalid rows AND trades below $5k threshold
      const rowsFiltered = rowsRaw.filter((r: any) =>
        r.tx_hash && r.market_id && r.trader_address && r.timestamp &&
        typeof r.amount === "number" && r.amount >= MIN_TRADE_SIZE
      );

      // 3) Dedupe by tx_hash within this batch to avoid:
      //    "ON CONFLICT DO UPDATE command cannot affect row a second time"
      const seen = new Set<string>();
      const rows: any[] = [];
      for (const r of rowsFiltered) {
        if (seen.has(r.tx_hash)) continue;
        seen.add(r.tx_hash);
        rows.push(r);
      }

      console.log(
        `Page ${page + 1}/${MAX_PAGES} offset=${offset}: raw=${rowsRaw.length} filtered_$5k+=${rowsFiltered.length} deduped=${rows.length}`,
      );

      if (rows.length === 0) {
        console.log(`Page offset=${offset}: nothing valid to store.`);
        continue;
      }

      // Upsert trades (deduped)
      const { error: tradeError } = await supabase
        .from("trades")
        .upsert(rows, { onConflict: "tx_hash" });

      if (tradeError) {
        console.error("Trade upsert error:", tradeError);
        throw new Error(`Trade upsert failed: ${tradeError.message}`);
      }

      upsertedTrades += rows.length;

      // Alerts (optional): create alerts for whale trades
      const alertRows = rows
        .filter((r: any) =>
          typeof r.amount === "number" && r.amount >= WHALE_THRESHOLD
        )
        .map((r: any) => ({
          type: r.amount >= MEGA_WHALE_THRESHOLD ? "mega_whale" : "whale",
          trader_address: r.trader_address,
          market_id: r.market_id,
          amount: r.amount,
          message:
            `${r.amount >= MEGA_WHALE_THRESHOLD ? "MEGA " : ""}WHALE: $${Math.round(r.amount)} trade on ${r.market_id}`,
          sent: false,
        }));

      if (alertRows.length) {
        const { error: alertError } = await supabase.from("alerts").insert(
          alertRows,
        );
        if (alertError) {
          // Don’t fail the whole sync if alerts fail
          console.error("Alert insert error:", alertError);
        } else {
          insertedAlerts += alertRows.length;
        }
      }

      console.log(
        `Page ${page + 1}/${MAX_PAGES}: fetched=${trades.length}, stored=${rows.length}`,
      );
    }

    // Recalculate trader stats after storing all trades
    const { error: statsError } = await supabase.rpc('recalculate_trader_stats');
    if (statsError) {
      console.error("Error recalculating trader stats:", statsError);
    } else {
      console.log("Trader stats recalculated successfully");
    }

    return new Response(
      JSON.stringify({
        success: true,
        fetched: fetchedTotal,
        stored: upsertedTrades,
        alertsInserted: insertedAlerts,
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