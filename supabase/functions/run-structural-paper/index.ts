import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const STRATEGY_WALLET = "structural_parity_engine";
const STRATEGY_LANE = "structural";
const STRATEGY_TAG = "yes_no_parity";
const EXECUTION_TYPE = "limit_sim";

const MAX_PRICE_AGE_MINUTES = 30;
const MAX_NEW_GROUPS_PER_RUN = 2;
const DAILY_GROUP_CAP = 6;
const MIN_ENTRY_EDGE = 0.02;
const MAX_ENTRY_SUM = 0.97;
const MIN_OUTCOME_PRICE = 0.03;
const MAX_OUTCOME_PRICE = 0.97;

const TAKE_PROFIT_SUM_DELTA = 0.015;
const STOP_LOSS_SUM_DELTA = 0.03;
const SOFT_MAX_HOLD_HOURS = 6;
const HARD_MAX_HOLD_HOURS = 12;

const MIN_STRUCTURAL_USD = 4;
const MAX_STRUCTURAL_USD = 20;
const DEFAULT_BASE_USD = 10;

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 0 || varY <= 0) return null;
  return cov / Math.sqrt(varX * varY);
}

type PaperPortfolio = {
  id: number | string | null;
  starting_usd: number | string | null;
  fixed_usd_per_trade: number | string | null;
  max_total_exposure_pct: number | string | null;
};

type OpenPosition = {
  id: string;
  market_id: string;
  market_title: string | null;
  market_slug: string | null;
  outcome: string;
  shares: number | string | null;
  usd_size: number | string | null;
  entry_ts: string | null;
  structural_group_id: string | null;
};

type MarketPrice = {
  market_id: string;
  outcome: string;
  price: number | string | null;
  updated_at: string | null;
};

type MarketMeta = {
  id: string;
  question: string | null;
  slug: string | null;
  winning_outcome: string | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUrl = new URL(req.url);
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const maxNewGroupsParam = toNumber(requestUrl.searchParams.get("max_new_groups"));
    const maxNewGroups = maxNewGroupsParam && maxNewGroupsParam > 0
      ? Math.floor(maxNewGroupsParam)
      : MAX_NEW_GROUPS_PER_RUN;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: portfolio, error: portfolioError } = await supabase
      .from("paper_portfolios")
      .select("id, starting_usd, fixed_usd_per_trade, max_total_exposure_pct")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (portfolioError || !portfolio) {
      throw new Error(`Failed to load paper_portfolios: ${portfolioError?.message ?? "not found"}`);
    }

    const portfolioId = Number((portfolio as PaperPortfolio).id);
    if (!Number.isFinite(portfolioId)) {
      throw new Error("Invalid paper portfolio id");
    }

    const { data: equityRow } = await supabase
      .from("paper_portfolio_equity")
      .select("equity_usd")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();
    const { data: openRow } = await supabase
      .from("paper_open_exposure_total")
      .select("open_usd")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();

    const startingUsd = toNumber((portfolio as PaperPortfolio).starting_usd) ?? 500;
    const portfolioEquityUsd = toNumber(equityRow?.equity_usd) ?? startingUsd;
    let openTotalUsd = toNumber(openRow?.open_usd) ?? 0;
    const maxTotalExposurePct = toNumber((portfolio as PaperPortfolio).max_total_exposure_pct) ?? 0.6;
    const baseUsd = Math.min(
      toNumber((portfolio as PaperPortfolio).fixed_usd_per_trade) ?? DEFAULT_BASE_USD,
      DEFAULT_BASE_USD,
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const staleCutoffIso = new Date(
      now.getTime() - MAX_PRICE_AGE_MINUTES * 60 * 1000,
    ).toISOString();
    const dailyCutoffIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    let structuralRunId: string | null = null;
    const summary = {
      success: true,
      dry_run: dryRun,
      markets_scanned: 0,
      opportunities_found: 0,
      groups_opened: 0,
      legs_opened: 0,
      groups_closed: 0,
      legs_closed: 0,
      skipped: 0,
      skip_reasons: {} as Record<string, number>,
    };

    const noteSkip = (reason: string) => {
      summary.skipped += 1;
      summary.skip_reasons[reason] = (summary.skip_reasons[reason] || 0) + 1;
    };

    if (!dryRun) {
      const { data: runRow, error: runError } = await supabase
        .from("structural_runs")
        .insert({
          started_at: nowIso,
          portfolio_id: portfolioId,
          dry_run: false,
          notes: {
            strategy: STRATEGY_TAG,
            max_new_groups: maxNewGroups,
            stale_cutoff_minutes: MAX_PRICE_AGE_MINUTES,
          },
        })
        .select("id")
        .maybeSingle();
      if (runError) {
        console.warn("Failed to create structural_runs row:", runError.message);
      } else {
        structuralRunId = runRow?.id ?? null;
      }
    }

    const { data: openPositions, error: openPositionsError } = await supabase
      .from("paper_positions")
      .select("id, market_id, market_slug, market_title, outcome, shares, usd_size, entry_ts, structural_group_id")
      .eq("portfolio_id", portfolioId)
      .eq("strategy_lane", STRATEGY_LANE)
      .eq("status", "OPEN")
      .order("entry_ts", { ascending: true })
      .limit(5000);
    if (openPositionsError) {
      console.warn("Failed to load open structural positions:", openPositionsError.message);
    }
    const openRows = (openPositions || []) as OpenPosition[];

    const openGroups = new Map<string, OpenPosition[]>();
    for (const pos of openRows) {
      const groupId = pos.structural_group_id || `${pos.market_id}:legacy`;
      if (!openGroups.has(groupId)) openGroups.set(groupId, []);
      openGroups.get(groupId)!.push(pos);
    }

    const openMarketIds = Array.from(new Set(openRows.map((r) => r.market_id).filter(Boolean)));
    const priceMap = new Map<string, MarketPrice>();
    if (openMarketIds.length > 0) {
      const { data: pricesForOpen, error: pricesForOpenError } = await supabase
        .from("market_prices")
        .select("market_id, outcome, price, updated_at")
        .in("market_id", openMarketIds);
      if (pricesForOpenError) {
        console.warn("Failed to load prices for open structural groups:", pricesForOpenError.message);
      } else {
        for (const row of (pricesForOpen || []) as MarketPrice[]) {
          priceMap.set(`${row.market_id}:${row.outcome}`, row);
        }
      }
    }

    const resolvedMarketSet = new Set<string>();
    if (openMarketIds.length > 0) {
      const { data: openMarkets, error: openMarketsError } = await supabase
        .from("markets")
        .select("id, winning_outcome")
        .in("id", openMarketIds);
      if (openMarketsError) {
        console.warn("Failed to load market resolution for open groups:", openMarketsError.message);
      } else {
        for (const row of openMarkets || []) {
          if (row?.id && row?.winning_outcome) {
            resolvedMarketSet.add(String(row.id));
          }
        }
      }
    }

    for (const [, legs] of openGroups.entries()) {
      if (legs.length !== 2) {
        noteSkip("invalid_open_group_legs");
        continue;
      }
      const marketId = legs[0].market_id;
      if (!marketId) {
        noteSkip("invalid_open_group_market");
        continue;
      }

      if (resolvedMarketSet.has(marketId)) {
        noteSkip("resolved_market_wait_for_settlement");
        continue;
      }

      const p0 = priceMap.get(`${marketId}:${legs[0].outcome}`);
      const p1 = priceMap.get(`${marketId}:${legs[1].outcome}`);
      const px0 = toNumber(p0?.price);
      const px1 = toNumber(p1?.price);
      if (px0 == null || px1 == null) {
        noteSkip("missing_open_leg_price");
        continue;
      }
      const ts0 = p0?.updated_at ? new Date(p0.updated_at) : null;
      const ts1 = p1?.updated_at ? new Date(p1.updated_at) : null;
      if (!ts0 || !ts1 || ts0.toISOString() < staleCutoffIso || ts1.toISOString() < staleCutoffIso) {
        noteSkip("stale_open_leg_price");
        continue;
      }

      const totalUsd = legs.reduce((acc, row) => acc + (toNumber(row.usd_size) ?? 0), 0);
      const minShares = Math.min(...legs.map((row) => toNumber(row.shares) ?? Number.POSITIVE_INFINITY));
      if (!Number.isFinite(minShares) || minShares <= 0 || totalUsd <= 0) {
        noteSkip("invalid_open_leg_size");
        continue;
      }

      const entryTs = legs
        .map((row) => row.entry_ts)
        .filter((v): v is string => Boolean(v))
        .sort()[0];
      const holdHours = entryTs
        ? (now.getTime() - new Date(entryTs).getTime()) / (1000 * 60 * 60)
        : 0;
      const entrySum = totalUsd / minShares;
      const currentSum = px0 + px1;

      let exitReason: string | null = null;
      if (currentSum >= entrySum + TAKE_PROFIT_SUM_DELTA) {
        exitReason = "take_profit";
      } else if (currentSum <= entrySum - STOP_LOSS_SUM_DELTA) {
        exitReason = "stop_loss";
      } else if (holdHours >= HARD_MAX_HOLD_HOURS) {
        exitReason = "time_stop";
      } else if (holdHours >= SOFT_MAX_HOLD_HOURS && currentSum > entrySum) {
        exitReason = "time_take_profit";
      }
      if (!exitReason) continue;

      if (!dryRun) {
        for (const leg of legs) {
          const currentPx = leg.outcome === legs[0].outcome ? px0 : px1;
          const shares = toNumber(leg.shares) ?? 0;
          const usdSize = toNumber(leg.usd_size) ?? 0;
          const pnlUsd = shares * currentPx - usdSize;
          const { error: closeError } = await supabase
            .from("paper_positions")
            .update({
              status: "SETTLED",
              exit_price: currentPx,
              exit_ts: nowIso,
              pnl_usd: pnlUsd,
              exit_reason: exitReason,
              updated_at: nowIso,
            })
            .eq("id", leg.id)
            .eq("status", "OPEN");
          if (closeError) {
            console.warn(`Failed to close structural leg ${leg.id}:`, closeError.message);
            noteSkip("close_update_failed");
            continue;
          }
          summary.legs_closed += 1;
        }
      } else {
        summary.legs_closed += 2;
      }
      openTotalUsd = Math.max(0, openTotalUsd - totalUsd);
      summary.groups_closed += 1;
    }

    const { data: recentLaneRows, error: recentLaneError } = await supabase
      .from("paper_positions")
      .select("market_id, structural_group_id")
      .eq("portfolio_id", portfolioId)
      .eq("strategy_lane", STRATEGY_LANE)
      .gte("entry_ts", dailyCutoffIso)
      .limit(5000);
    if (recentLaneError) {
      console.warn("Failed to load recent structural positions:", recentLaneError.message);
    }

    const recentMarkets = new Set(
      (recentLaneRows || [])
        .map((row) => row.market_id)
        .filter((v): v is string => Boolean(v)),
    );
    const recentGroups = new Set(
      (recentLaneRows || [])
        .map((row) => row.structural_group_id)
        .filter((v): v is string => Boolean(v)),
    );

    const { data: recentPrices, error: recentPricesError } = await supabase
      .from("market_prices")
      .select("market_id, outcome, price, updated_at")
      .gte("updated_at", staleCutoffIso)
      .order("updated_at", { ascending: false })
      .limit(5000);
    if (recentPricesError) {
      throw new Error(`Failed to load market_prices: ${recentPricesError.message}`);
    }

    const pricesByMarket = new Map<string, MarketPrice[]>();
    for (const row of (recentPrices || []) as MarketPrice[]) {
      if (!row.market_id || !row.outcome) continue;
      if (!pricesByMarket.has(row.market_id)) pricesByMarket.set(row.market_id, []);
      pricesByMarket.get(row.market_id)!.push(row);
    }

    const candidateMarkets: Array<{
      market_id: string;
      outcomes: MarketPrice[];
      sum_price: number;
      edge: number;
    }> = [];

    for (const [marketId, rows] of pricesByMarket.entries()) {
      const dedup = new Map<string, MarketPrice>();
      for (const row of rows) {
        if (!dedup.has(row.outcome)) dedup.set(row.outcome, row);
      }
      const outcomes = Array.from(dedup.values());
      if (outcomes.length !== 2) continue;
      const p0 = toNumber(outcomes[0].price);
      const p1 = toNumber(outcomes[1].price);
      if (p0 == null || p1 == null) continue;
      if (p0 <= MIN_OUTCOME_PRICE || p1 <= MIN_OUTCOME_PRICE) continue;
      if (p0 >= MAX_OUTCOME_PRICE || p1 >= MAX_OUTCOME_PRICE) continue;
      const sumPrice = p0 + p1;
      const edge = 1 - sumPrice;
      if (sumPrice > MAX_ENTRY_SUM || edge < MIN_ENTRY_EDGE) continue;
      candidateMarkets.push({
        market_id: marketId,
        outcomes,
        sum_price: sumPrice,
        edge,
      });
    }

    summary.markets_scanned = pricesByMarket.size;
    summary.opportunities_found = candidateMarkets.length;

    const candidateIds = candidateMarkets.map((c) => c.market_id);
    const marketMetaMap = new Map<string, MarketMeta>();
    if (candidateIds.length > 0) {
      for (let i = 0; i < candidateIds.length; i += 200) {
        const batch = candidateIds.slice(i, i + 200);
        const { data: marketsBatch, error: marketsError } = await supabase
          .from("markets")
          .select("id, question, slug, winning_outcome")
          .in("id", batch);
        if (marketsError) {
          console.warn("Failed to load markets for structural scan:", marketsError.message);
          continue;
        }
        for (const row of (marketsBatch || []) as MarketMeta[]) {
          marketMetaMap.set(row.id, row);
        }
      }
    }

    candidateMarkets.sort((a, b) => b.edge - a.edge);
    const maxOpenExposureUsd = portfolioEquityUsd * maxTotalExposurePct;

    for (const candidate of candidateMarkets) {
      if (summary.groups_opened >= maxNewGroups) break;
      if (recentGroups.size + summary.groups_opened >= DAILY_GROUP_CAP) {
        noteSkip("daily_group_cap");
        break;
      }
      if (recentMarkets.has(candidate.market_id)) {
        noteSkip("market_already_traded_24h");
        continue;
      }
      if (openMarketIds.includes(candidate.market_id)) {
        noteSkip("market_already_open");
        continue;
      }

      const marketMeta = marketMetaMap.get(candidate.market_id);
      if (!marketMeta) {
        noteSkip("missing_market_metadata");
        continue;
      }
      if (marketMeta.winning_outcome) {
        noteSkip("market_already_resolved");
        continue;
      }

      const kellyLike = clamp(candidate.edge / 0.05, 0.25, 1.5);
      const totalUsd = clamp(baseUsd * kellyLike, MIN_STRUCTURAL_USD, MAX_STRUCTURAL_USD);
      if (openTotalUsd + totalUsd > maxOpenExposureUsd) {
        noteSkip("total_exposure_cap");
        continue;
      }

      const shares = totalUsd / candidate.sum_price;
      if (!Number.isFinite(shares) || shares <= 0) {
        noteSkip("invalid_share_size");
        continue;
      }

      const groupId = `${STRATEGY_WALLET}:${candidate.market_id}:${Date.now()}:${summary.groups_opened + 1}`;
      const legs = candidate.outcomes.map((outcomeRow, idx) => {
        const px = toNumber(outcomeRow.price) ?? 0;
        return {
          portfolio_id: portfolioId,
          source_wallet: STRATEGY_WALLET,
          source_trade_id: `${groupId}:${idx + 1}`,
          source_trade_ts: nowIso,
          market_id: candidate.market_id,
          market_slug: marketMeta.slug ?? null,
          market_title: marketMeta.question ?? null,
          outcome: outcomeRow.outcome,
          side: "BUY",
          source_price: px,
          entry_price: px,
          price_penalty: 0,
          copy_factor: null,
          entry_ts: nowIso,
          usd_size: shares * px,
          shares,
          status: "OPEN",
          sizing_method: "structural_parity_fractional_kelly",
          fixed_usd_per_trade: baseUsd,
          strategy_lane: STRATEGY_LANE,
          strategy_tag: STRATEGY_TAG,
          execution_type: EXECUTION_TYPE,
          edge_bps: candidate.edge * 10000,
          structural_group_id: groupId,
          updated_at: nowIso,
        };
      });

      if (!dryRun) {
        const { error: insertError } = await supabase
          .from("paper_positions")
          .insert(legs);
        if (insertError) {
          console.warn("Failed to insert structural legs:", insertError.message);
          noteSkip("insert_failed");
          continue;
        }
      }

      openTotalUsd += totalUsd;
      recentMarkets.add(candidate.market_id);
      recentGroups.add(groupId);
      summary.groups_opened += 1;
      summary.legs_opened += legs.length;
    }

    if (!dryRun) {
      const { data: resetRows, error: resetError } = await supabase
        .from("paper_strategy_resets")
        .select("reset_at")
        .eq("portfolio_id", portfolioId)
        .order("reset_at", { ascending: false })
        .limit(1);
      if (resetError) {
        console.warn("Failed to load reset marker for diagnostics:", resetError.message);
      }
      const resetAt = resetRows?.[0]?.reset_at ?? "1970-01-01T00:00:00.000Z";

      const { data: diagRows, error: diagError } = await supabase
        .from("paper_positions_with_price")
        .select("strategy_lane,status,usd_size,shares,pnl_usd,current_price,entry_ts,exit_ts,execution_type,edge_bps,exit_reason")
        .eq("portfolio_id", portfolioId)
        .gte("entry_ts", resetAt)
        .neq("status", "CANCELED")
        .limit(10000);
      if (diagError) {
        console.warn("Failed to load paper positions for diagnostics:", diagError.message);
      } else {
        const rows = diagRows || [];
        const lanes = ["copy", "structural"];
        const inserts: Array<Record<string, unknown>> = [];
        for (const lane of lanes) {
          const laneRows = rows.filter((r) => (r.strategy_lane || "copy") === lane);
          const settled = laneRows.filter((r) => r.status === "SETTLED");
          const open = laneRows.filter((r) => r.status === "OPEN");

          const realized = settled.reduce((acc, r) => acc + (toNumber(r.pnl_usd) ?? 0), 0);
          const unrealized = open.reduce((acc, r) => {
            const shares = toNumber(r.shares) ?? 0;
            const currentPrice = toNumber(r.current_price);
            const usdSize = toNumber(r.usd_size) ?? 0;
            if (currentPrice == null) return acc;
            return acc + (shares * currentPrice - usdSize);
          }, 0);

          const holdMinutes = settled
            .map((r) => {
              if (!r.entry_ts || !r.exit_ts) return null;
              const mins = (new Date(r.exit_ts).getTime() - new Date(r.entry_ts).getTime()) / (1000 * 60);
              return Number.isFinite(mins) && mins >= 0 ? mins : null;
            })
            .filter((v): v is number => v != null);

          const edgeRows = laneRows
            .map((r) => ({
              size: toNumber(r.usd_size),
              edge: toNumber(r.edge_bps),
            }))
            .filter((r) => r.size != null && r.edge != null) as Array<{ size: number; edge: number }>;

          const limitRows = laneRows.filter((r) => String(r.execution_type || "").toLowerCase().includes("limit"));
          const preResolutionSettles = settled.filter((r) => r.exit_reason != null);
          const resolutionPnl = settled
            .filter((r) => r.exit_reason == null)
            .reduce((acc, r) => acc + (toNumber(r.pnl_usd) ?? 0), 0);
          const structuralPnl = settled
            .filter((r) => r.exit_reason != null)
            .reduce((acc, r) => acc + (toNumber(r.pnl_usd) ?? 0), 0);

          let profitSource = "none";
          if (Math.abs(structuralPnl) > Math.abs(resolutionPnl) && Math.abs(structuralPnl) > 0) {
            profitSource = "structural";
          } else if (Math.abs(resolutionPnl) > 0) {
            profitSource = "resolution";
          }

          inserts.push({
            computed_at: nowIso,
            portfolio_id: portfolioId,
            scope: "since_reset",
            strategy_lane: lane,
            positions_total: laneRows.length,
            open_positions: open.length,
            settled_positions: settled.length,
            exit_before_resolution_pct: settled.length > 0
              ? preResolutionSettles.length / settled.length
              : null,
            median_hold_minutes: median(holdMinutes),
            limit_order_pct: laneRows.length > 0 ? limitRows.length / laneRows.length : null,
            size_edge_correlation: edgeRows.length >= 3
              ? pearsonCorrelation(
                edgeRows.map((r) => r.size),
                edgeRows.map((r) => r.edge),
              )
              : null,
            realized_pnl: realized,
            unrealized_pnl: unrealized,
            projected_pnl: realized + unrealized,
            profit_source: profitSource,
            notes: {
              reset_at: resetAt,
              structural_run_id: structuralRunId,
              resolution_pnl: resolutionPnl,
              structural_pnl: structuralPnl,
            },
          });
        }

        if (inserts.length > 0) {
          const { error: insertDiagError } = await supabase
            .from("paper_strategy_diagnostics")
            .insert(inserts);
          if (insertDiagError) {
            console.warn("Failed to insert strategy diagnostics:", insertDiagError.message);
          }
        }
      }
    }

    if (!dryRun && structuralRunId) {
      const { error: runUpdateError } = await supabase
        .from("structural_runs")
        .update({
          finished_at: new Date().toISOString(),
          markets_scanned: summary.markets_scanned,
          opportunities_found: summary.opportunities_found,
          groups_opened: summary.groups_opened,
          legs_opened: summary.legs_opened,
          groups_closed: summary.groups_closed,
          legs_closed: summary.legs_closed,
          skipped: summary.skipped,
          skip_reasons: summary.skip_reasons,
        })
        .eq("id", structuralRunId);
      if (runUpdateError) {
        console.warn("Failed to update structural_runs summary:", runUpdateError.message);
      }
    }

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-structural-paper error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message || error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
