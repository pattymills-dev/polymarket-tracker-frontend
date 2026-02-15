import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface TraderStats {
  trader_address: string;
  wins: number;
  losses: number;
  resolved_count: number;
  total_buy_cost: number;
  realized_pl: number;
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const minResolved = parseInt(url.searchParams.get("min_resolved") || "5");

  console.log(`Refresh top traders (all-time): limit=${limit}, min_resolved=${minResolved}`);

  try {
    // Get all traders with significant volume
    const { data: activeTraders, error: tradersError } = await supabase
      .from("trades")
      .select("trader_address")
      .gt("amount", 100)
      .order("amount", { ascending: false })
      .limit(1000);

    if (tradersError) {
      return new Response(JSON.stringify({ error: tradersError.message }), { status: 500 });
    }

    // Dedupe traders
    const uniqueTraders = [...new Set((activeTraders || []).map(t => t.trader_address))].slice(0, 200);
    console.log(`Processing ${uniqueTraders.length} unique traders`);

    const traderStats: TraderStats[] = [];

    for (const traderAddress of uniqueTraders) {
      // Get ALL trades for this trader (not limited by time)
      const { data: trades, error: tradesErr } = await supabase
        .from("trades")
        .select("market_id, outcome, amount, price")
        .eq("trader_address", traderAddress)
        .gt("price", 0.05)
        .lt("price", 0.95)
        .limit(1000);

      if (tradesErr || !trades || trades.length === 0) continue;

      // Get unique market IDs
      const marketIds = [...new Set(trades.map(t => t.market_id))];

      // Fetch resolved markets
      const { data: markets, error: marketsErr } = await supabase
        .from("markets")
        .select("id, resolved, winning_outcome")
        .in("id", marketIds)
        .eq("resolved", true);

      if (marketsErr) continue;

      // Create map of resolved markets
      const resolvedMap = new Map<string, string>();
      for (const m of markets || []) {
        if (m.winning_outcome) {
          resolvedMap.set(m.id, m.winning_outcome);
        }
      }

      if (resolvedMap.size < minResolved) continue;

      // Calculate wins, losses, P/L - dedupe by market_id
      let wins = 0;
      let losses = 0;
      let totalBuyCost = 0;
      let realizedPl = 0;
      const seenMarkets = new Set<string>();

      for (const trade of trades) {
        totalBuyCost += trade.amount || 0;

        const winningOutcome = resolvedMap.get(trade.market_id);
        if (!winningOutcome || seenMarkets.has(trade.market_id)) continue;
        seenMarkets.add(trade.market_id);

        const isWin = trade.outcome === winningOutcome;
        if (isWin) {
          wins++;
          realizedPl += trade.amount * (1 / trade.price - 1);
        } else {
          losses++;
          realizedPl -= trade.amount;
        }
      }

      const resolvedCount = wins + losses;
      if (resolvedCount < minResolved) continue;

      traderStats.push({
        trader_address: traderAddress,
        wins,
        losses,
        resolved_count: resolvedCount,
        total_buy_cost: totalBuyCost,
        realized_pl: realizedPl,
      });
    }

    console.log(`Calculated stats for ${traderStats.length} traders with ${minResolved}+ resolved markets`);

    // Sort by realized P/L and assign ranks
    traderStats.sort((a, b) => b.realized_pl - a.realized_pl);
    const topTraders = traderStats.slice(0, limit);

    // Upsert into top_traders
    let upsertCount = 0;

    // First, delete existing entries
    await supabase.from("top_traders").delete().neq("trader_address", "");

    for (let i = 0; i < topTraders.length; i++) {
      const t = topTraders[i];
      const rank = i + 1;
      const winRate = t.resolved_count > 0 ? t.wins / t.resolved_count : 0;

      const { error: upsertErr } = await supabase.from("top_traders").upsert({
        trader_address: t.trader_address,
        total_pl: t.realized_pl,
        total_buy_cost: t.total_buy_cost,
        resolved_markets: t.resolved_count,
        wins: t.wins,
        losses: t.losses,
        win_rate: winRate,
        rank: rank,
        updated_at: new Date().toISOString(),
      }, { onConflict: "trader_address" });

      if (upsertErr) {
        console.error(`Error upserting ${t.trader_address}:`, upsertErr);
      } else {
        upsertCount++;
      }
    }

    console.log(`Upserted ${upsertCount} top traders`);

    // Refresh trader_rankings to pull in the new data
    try {
      await supabase.rpc("refresh_trader_rankings");
      console.log("Refreshed trader_rankings");
    } catch (e) {
      console.log("Could not refresh trader_rankings");
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: uniqueTraders.length,
        updated: upsertCount,
        top3: topTraders.slice(0, 3).map(t => ({
          address: t.trader_address.slice(0, 10) + "...",
          wins: t.wins,
          losses: t.losses,
          pl: Math.round(t.realized_pl).toLocaleString(),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
