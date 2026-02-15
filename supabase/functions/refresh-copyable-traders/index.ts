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
  resolved_notional: number;
  realized_pl: number;
  median_bet: number;
}

// Calculate stats for a single trader
async function calculateTraderStats(
  traderAddress: string,
  cutoffTs: string
): Promise<TraderStats | null> {
  // Get trader's trades
  const { data: trades, error: tradesErr } = await supabase
    .from("trades")
    .select("market_id, outcome, amount, price")
    .eq("trader_address", traderAddress)
    .gte("timestamp", cutoffTs)
    .gt("price", 0.05)
    .lt("price", 0.95)
    .limit(500);

  if (tradesErr || !trades || trades.length === 0) {
    return null;
  }

  // Get unique market IDs
  const marketIds = [...new Set(trades.map((t) => t.market_id))];

  // Fetch resolved markets separately
  const { data: markets, error: marketsErr } = await supabase
    .from("markets")
    .select("id, resolved, winning_outcome")
    .in("id", marketIds)
    .eq("resolved", true);

  if (marketsErr) {
    return null;
  }

  // Create a map of resolved markets
  const resolvedMap = new Map<string, string>();
  for (const m of markets || []) {
    if (m.winning_outcome) {
      resolvedMap.set(m.id, m.winning_outcome);
    }
  }

  if (resolvedMap.size === 0) {
    return null;
  }

  // Calculate wins, losses, P/L - dedupe by market_id
  let wins = 0;
  let losses = 0;
  let totalAmount = 0;
  let realizedPl = 0;
  const amounts: number[] = [];
  const seenMarkets = new Set<string>();

  for (const trade of trades) {
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
    totalAmount += trade.amount;
    amounts.push(trade.amount);
  }

  const resolvedCount = wins + losses;
  if (resolvedCount < 3) return null; // Need at least 3 resolved trades

  // Calculate median bet
  amounts.sort((a, b) => a - b);
  const medianBet = amounts.length > 0 ? amounts[Math.floor(amounts.length / 2)] : 0;

  return {
    trader_address: traderAddress,
    wins,
    losses,
    resolved_count: resolvedCount,
    resolved_notional: totalAmount,
    realized_pl: realizedPl,
    median_bet: medianBet,
  };
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "top"; // "top" or "existing"
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const daysBack = parseInt(url.searchParams.get("days") || "30");

  console.log(`Refresh copyable traders: mode=${mode}, limit=${limit}, days=${daysBack}`);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  const cutoffTs = cutoffDate.toISOString();

  try {
    let tradersToProcess: string[] = [];

    if (mode === "existing") {
      // Mode: Refresh existing top N traders in copyable_traders table
      const { data: existing, error: existingErr } = await supabase
        .from("copyable_traders")
        .select("trader_address")
        .order("rank", { ascending: true })
        .limit(limit);

      if (existingErr) {
        return new Response(JSON.stringify({ error: existingErr.message }), { status: 500 });
      }

      tradersToProcess = (existing || []).map((t) => t.trader_address);
      console.log(`Processing ${tradersToProcess.length} existing top traders`);
    } else {
      // Mode: Find top traders by recent activity
      const { data: topTraders, error: tradersError } = await supabase
        .from("trades")
        .select("trader_address")
        .gte("timestamp", cutoffTs)
        .gt("amount", 0)
        .gt("price", 0.05)
        .lt("price", 0.95)
        .order("amount", { ascending: false })
        .limit(500);

      if (tradersError) {
        return new Response(JSON.stringify({ error: tradersError.message }), { status: 500 });
      }

      // Dedupe traders and take top N by frequency
      const traderCounts = new Map<string, number>();
      for (const t of topTraders || []) {
        traderCounts.set(t.trader_address, (traderCounts.get(t.trader_address) || 0) + 1);
      }

      tradersToProcess = Array.from(traderCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([addr]) => addr);

      console.log(`Processing ${tradersToProcess.length} traders by activity`);
    }

    // Calculate stats for each trader
    const traderStats: TraderStats[] = [];
    for (const traderAddress of tradersToProcess) {
      const stats = await calculateTraderStats(traderAddress, cutoffTs);
      if (stats) {
        traderStats.push(stats);
      }
    }

    console.log(`Calculated stats for ${traderStats.length} traders with 3+ resolved trades`);

    // Sort by copy_score and assign ranks
    const withScores = traderStats.map((t) => ({
      ...t,
      roi: t.resolved_notional > 0 ? t.realized_pl / t.resolved_notional : 0,
      copy_score:
        t.resolved_notional > 0
          ? (t.realized_pl / t.resolved_notional) * Math.sqrt(t.resolved_count)
          : 0,
    }));

    withScores.sort((a, b) => b.copy_score - a.copy_score);

    // Upsert into copyable_traders
    let upsertCount = 0;
    for (let i = 0; i < withScores.length; i++) {
      const t = withScores[i];
      const rank = i + 1;

      const { error: upsertErr } = await supabase.from("copyable_traders").upsert(
        {
          trader_address: t.trader_address,
          wins: t.wins,
          losses: t.losses,
          resolved_trades_count: t.resolved_count,
          resolved_notional: t.resolved_notional,
          realized_pl: t.realized_pl,
          realized_roi: t.roi,
          median_trade_notional: t.median_bet,
          copy_score: t.copy_score,
          rank: rank,
          win_rate: t.resolved_count > 0 ? t.wins / t.resolved_count : 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "trader_address" }
      );

      if (upsertErr) {
        console.error(`Error upserting ${t.trader_address}:`, upsertErr);
      } else {
        upsertCount++;
      }
    }

    console.log(`Upserted ${upsertCount} traders`);

    // Clean up: remove traders outside top 50 to keep table small
    if (mode === "top" && withScores.length > 0) {
      const topAddresses = withScores.slice(0, 50).map((t) => t.trader_address);
      const { error: deleteErr } = await supabase
        .from("copyable_traders")
        .delete()
        .not("trader_address", "in", `(${topAddresses.join(",")})`);

      if (deleteErr) {
        console.log("Could not clean up old traders:", deleteErr.message);
      } else {
        console.log("Cleaned up traders outside top 50");
      }
    }

    // Refresh trader_rankings
    try {
      await supabase.rpc("refresh_trader_rankings");
    } catch (e) {
      console.log("Could not refresh trader_rankings");
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode,
        processed: tradersToProcess.length,
        updated: upsertCount,
        top3: withScores.slice(0, 3).map((t) => ({
          address: t.trader_address.slice(0, 10) + "...",
          wins: t.wins,
          losses: t.losses,
          roi: (t.roi * 100).toFixed(1) + "%",
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
