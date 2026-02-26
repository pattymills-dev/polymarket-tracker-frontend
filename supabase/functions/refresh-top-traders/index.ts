import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const PAGE_SIZE = 1000;
const MAX_TRADES_PER_TRADER = 10000;
const MARKET_CHUNK_SIZE = 200; // Supabase .in() limit
const MAX_CLI_SNAPSHOT_AGE_HOURS = 6; // Only trust recent CLI data

interface TraderStats {
  trader_address: string;
  wins: number;
  losses: number;
  resolved_count: number;
  total_buy_cost: number;
  realized_pl: number;
  source: "cli" | "trades"; // Track where the data came from
}

/**
 * Fetch latest CLI snapshots per trader (from the CLI integration).
 * Only returns snapshots within the freshness window.
 */
async function fetchCliStats(): Promise<Map<string, TraderStats>> {
  const cutoff = new Date(Date.now() - MAX_CLI_SNAPSHOT_AGE_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("latest_cli_trader_stats")
    .select("*")
    .gte("snapshot_at", cutoff);

  if (error) {
    console.error("Error fetching CLI stats:", error.message);
    return new Map();
  }

  const statsMap = new Map<string, TraderStats>();
  for (const row of data || []) {
    const wins = row.cli_wins || 0;
    const losses = row.cli_losses || 0;
    const resolvedCount = wins + losses;

    // Only use CLI data if we have meaningful win/loss counts
    if (resolvedCount > 0 && row.closed_pnl_usd != null) {
      statsMap.set(row.trader_address, {
        trader_address: row.trader_address,
        wins,
        losses,
        resolved_count: resolvedCount,
        total_buy_cost: row.open_value_usd || 0,
        realized_pl: row.closed_pnl_usd || 0,
        source: "cli",
      });
    }
  }

  return statsMap;
}

/**
 * Paginate through ALL trades for a trader (no truncation).
 * Returns up to MAX_TRADES_PER_TRADER rows.
 * FALLBACK: Only used for traders without CLI snapshot data.
 */
async function fetchAllTrades(
  traderAddress: string,
  selectColumns: string,
  extraFilters?: { minPrice?: number; maxPrice?: number }
): Promise<Record<string, unknown>[]> {
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;

  while (offset < MAX_TRADES_PER_TRADER) {
    let query = supabase
      .from("trades")
      .select(selectColumns)
      .eq("trader_address", traderAddress);

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

/**
 * Discover traders for FALLBACK computation (only those without CLI data).
 * Uses existing top_traders + limited trade discovery.
 */
async function discoverTradersForFallback(
  cliAddresses: Set<string>,
  maxTraders: number
): Promise<string[]> {
  const traderSet = new Set<string>();

  // 1) Include existing top_traders so they get re-evaluated
  const { data: existing } = await supabase
    .from("top_traders")
    .select("trader_address")
    .limit(200);

  for (const row of existing || []) {
    if (row.trader_address && !cliAddresses.has(row.trader_address)) {
      traderSet.add(row.trader_address);
    }
  }

  // 2) Only scan trades if we need more traders (lighter discovery)
  if (traderSet.size < maxTraders) {
    let offset = 0;
    const maxDiscoveryRows = 1000; // Reduced from 2000 — CLI handles primary discovery
    while (offset < maxDiscoveryRows) {
      const { data, error } = await supabase
        .from("trades")
        .select("trader_address")
        .gt("amount", 50)
        .order("amount", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error(`discoverTraders error at offset ${offset}:`, error.message);
        break;
      }
      if (!data || data.length === 0) break;

      for (const row of data) {
        if (row.trader_address && !cliAddresses.has(row.trader_address)) {
          traderSet.add(row.trader_address);
        }
      }
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  console.log(`Fallback discovery: ${traderSet.size} traders (excluding ${cliAddresses.size} with CLI data)`);
  return Array.from(traderSet).slice(0, maxTraders);
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const minResolved = parseInt(url.searchParams.get("min_resolved") || "5");

  console.log(`Refresh top traders (hybrid): limit=${limit}, min_resolved=${minResolved}`);

  try {
    // ── Phase 1: CLI ground-truth data (no trades table scanning) ──
    const cliStatsMap = await fetchCliStats();
    console.log(`CLI data available for ${cliStatsMap.size} traders`);

    const traderStats: TraderStats[] = [];
    let cliUsed = 0;

    // Use CLI data directly — these traders skip trades table entirely
    for (const [addr, stats] of cliStatsMap) {
      if (stats.resolved_count >= minResolved) {
        traderStats.push(stats);
        cliUsed++;
      }
    }
    console.log(`Using CLI data for ${cliUsed} traders (${minResolved}+ resolved)`);

    // ── Phase 2: Trade-based fallback for traders without CLI data ──
    const cliAddresses = new Set(cliStatsMap.keys());
    const fallbackTraders = await discoverTradersForFallback(cliAddresses, 100);
    let fallbackUsed = 0;

    for (const traderAddress of fallbackTraders) {
      // Skip if already have CLI data
      if (cliAddresses.has(traderAddress)) continue;

      // Paginate through ALL trades for this trader
      const trades = await fetchAllTrades(traderAddress, "market_id, outcome, amount, price", {
        minPrice: 0.05,
        maxPrice: 0.95,
      });

      if (trades.length === 0) continue;

      // Get unique market IDs
      const marketIds = [...new Set(trades.map((t) => t.market_id as string))];

      // Fetch resolved markets in chunks
      const resolvedMap = await fetchResolvedMarkets(marketIds);

      if (resolvedMap.size < minResolved) continue;

      // Calculate wins, losses, P/L - dedupe by market_id
      let wins = 0;
      let losses = 0;
      let totalBuyCost = 0;
      let realizedPl = 0;
      const seenMarkets = new Set<string>();

      for (const trade of trades) {
        const amount = (trade.amount as number) || 0;
        const price = trade.price as number;
        const marketId = trade.market_id as string;
        const outcome = trade.outcome as string;

        totalBuyCost += amount;

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
        source: "trades",
      });
      fallbackUsed++;
    }

    console.log(`Computed trade-based stats for ${fallbackUsed} additional traders`);
    console.log(`Total: ${traderStats.length} traders (${cliUsed} CLI + ${fallbackUsed} trades)`);

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
        mode: "hybrid",
        cli_traders: cliUsed,
        fallback_traders: fallbackUsed,
        updated: upsertCount,
        top5: topTraders.slice(0, 5).map(t => ({
          address: t.trader_address.slice(0, 10) + "...",
          wins: t.wins,
          losses: t.losses,
          pl: Math.round(t.realized_pl).toLocaleString(),
          source: t.source,
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
