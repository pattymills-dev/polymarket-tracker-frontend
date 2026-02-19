import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const PAGE_SIZE = 1000;
const MAX_TRADES_PER_TRADER = 10000;
const MARKET_CHUNK_SIZE = 200; // Supabase .in() limit

interface TraderStats {
  trader_address: string;
  wins: number;
  losses: number;
  resolved_count: number;
  resolved_notional: number;
  realized_pl: number;
  median_bet: number;
}

/**
 * Paginate through ALL trades for a trader within a time window (no truncation).
 * Returns up to MAX_TRADES_PER_TRADER rows.
 */
async function fetchAllTrades(
  traderAddress: string,
  selectColumns: string,
  cutoffTs?: string,
  extraFilters?: { minPrice?: number; maxPrice?: number }
): Promise<Record<string, unknown>[]> {
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;

  while (offset < MAX_TRADES_PER_TRADER) {
    let query = supabase
      .from("trades")
      .select(selectColumns)
      .eq("trader_address", traderAddress);

    if (cutoffTs) {
      query = query.gte("timestamp", cutoffTs);
    }
    if (extraFilters?.minPrice != null) {
      query = query.gt("price", extraFilters.minPrice);
    }
    if (extraFilters?.maxPrice != null) {
      query = query.lt("price", extraFilters.maxPrice);
    }

    query = query
      .order("timestamp", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) {
      console.error(`fetchAllTrades error for ${traderAddress} at offset ${offset}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    allRows.push(...data);
    if (data.length < PAGE_SIZE) break; // last page
    offset += PAGE_SIZE;
  }

  return allRows;
}

/**
 * Fetch resolved markets in chunks (Supabase .in() has array size limits).
 */
async function fetchResolvedMarkets(
  marketIds: string[]
): Promise<Map<string, string>> {
  const resolvedMap = new Map<string, string>();

  for (let i = 0; i < marketIds.length; i += MARKET_CHUNK_SIZE) {
    const chunk = marketIds.slice(i, i + MARKET_CHUNK_SIZE);
    const { data: markets, error } = await supabase
      .from("markets")
      .select("id, resolved, winning_outcome")
      .in("id", chunk)
      .eq("resolved", true);

    if (error) {
      console.error(`fetchResolvedMarkets error at chunk ${i}:`, error.message);
      continue;
    }

    for (const m of markets || []) {
      if (m.winning_outcome) {
        resolvedMap.set(m.id, m.winning_outcome);
      }
    }
  }

  return resolvedMap;
}

// Calculate stats for a single trader with paginated trade fetching
async function calculateTraderStats(
  traderAddress: string,
  cutoffTs: string
): Promise<TraderStats | null> {
  // Paginate through ALL trades within the time window
  const trades = await fetchAllTrades(
    traderAddress,
    "market_id, outcome, amount, price",
    cutoffTs,
    { minPrice: 0.05, maxPrice: 0.95 }
  );

  if (trades.length === 0) {
    return null;
  }

  // Get unique market IDs
  const marketIds = [...new Set(trades.map((t) => t.market_id as string))];

  // Fetch resolved markets in chunks
  const resolvedMap = await fetchResolvedMarkets(marketIds);

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
    const amount = (trade.amount as number) || 0;
    const price = trade.price as number;
    const marketId = trade.market_id as string;
    const outcome = trade.outcome as string;

    const winningOutcome = resolvedMap.get(marketId);
    if (!winningOutcome || seenMarkets.has(marketId)) continue;
    seenMarkets.add(marketId);

    const isWin = outcome === winningOutcome;
    if (isWin) {
      wins++;
      realizedPl += amount * (1 / price - 1);
    } else {
      losses++;
      realizedPl -= amount;
    }
    totalAmount += amount;
    amounts.push(amount);
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
    // --- Rank snapshot logic: preserve current ranks before re-computing ---
    // Only snapshot if >= 20 hours since last snapshot (avoid overwriting every 15min)
    const { data: snapshotCheck } = await supabase
      .from("copyable_traders")
      .select("rank_snapshot_at")
      .not("rank_snapshot_at", "is", null)
      .order("rank_snapshot_at", { ascending: false })
      .limit(1);

    const lastSnapshotAt = snapshotCheck?.[0]?.rank_snapshot_at;
    const hoursSinceSnapshot = lastSnapshotAt
      ? (Date.now() - new Date(lastSnapshotAt).getTime()) / (1000 * 60 * 60)
      : Infinity;

    if (hoursSinceSnapshot >= 20) {
      console.log(`Snapshotting ranks (last snapshot ${hoursSinceSnapshot === Infinity ? 'never' : hoursSinceSnapshot.toFixed(1) + 'h ago'})`);
      const { error: snapErr } = await supabase.rpc("snapshot_copyable_ranks");
      if (snapErr) {
        console.error("Rank snapshot error:", snapErr.message);
      } else {
        console.log("Rank snapshot saved successfully");
      }
    } else {
      console.log(`Skipping rank snapshot (${hoursSinceSnapshot.toFixed(1)}h since last)`);
    }

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
      // Mode: Find top traders by recent activity — paginate discovery
      const traderSet = new Set<string>();
      let offset = 0;
      const maxDiscoveryRows = 3000;

      while (offset < maxDiscoveryRows) {
        const { data, error } = await supabase
          .from("trades")
          .select("trader_address")
          .gte("timestamp", cutoffTs)
          .gt("amount", 0)
          .gt("price", 0.05)
          .lt("price", 0.95)
          .order("amount", { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
          console.error(`Discovery error at offset ${offset}:`, error.message);
          break;
        }
        if (!data || data.length === 0) break;

        for (const row of data) {
          if (row.trader_address) traderSet.add(row.trader_address);
        }
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      // Also include existing copyable_traders so they get re-evaluated
      const { data: existingCopyable } = await supabase
        .from("copyable_traders")
        .select("trader_address")
        .limit(100);

      for (const row of existingCopyable || []) {
        if (row.trader_address) traderSet.add(row.trader_address);
      }

      tradersToProcess = Array.from(traderSet).slice(0, Math.max(limit, 200));
      console.log(`Processing ${tradersToProcess.length} traders by activity (discovered ${traderSet.size})`);
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
