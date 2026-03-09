import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatAbsUsd(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

function buildTopList(map: Map<string, number>, limit = 5): string {
  const items = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => `${label} ${formatUsd(value)}`);

  return items.length > 0 ? items.join(", ") : "none";
}

type AlertScope = "window" | "all_time" | "since_reset";

type PositionWithPriceRow = {
  source_wallet: string | null;
  market_id: string | null;
  market_title: string | null;
  status: string | null;
  usd_size: number | string | null;
  shares: number | string | null;
  pnl_usd: number | string | null;
  current_price: number | string | null;
};

type AggregateMetrics = {
  countPositions: number;
  openCount: number;
  settledCount: number;
  totalStaked: number;
  realizedPnl: number;
  unrealizedPnl: number;
  projectedTotal: number;
  missingPrices: number;
  pnlByTrader: Map<string, number>;
  pnlByMarket: Map<string, number>;
};

function aggregatePositions(rows: PositionWithPriceRow[]): AggregateMetrics {
  let countPositions = 0;
  let openCount = 0;
  let settledCount = 0;
  let totalStaked = 0;
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let missingPrices = 0;
  const pnlByTrader = new Map<string, number>();
  const pnlByMarket = new Map<string, number>();

  for (const row of rows || []) {
    if (row.status === "CANCELED") continue;
    countPositions += 1;
    const usdSize = toNumber(row.usd_size) ?? 0;
    totalStaked += usdSize;

    let pnlContribution = 0;
    if (row.status === "SETTLED") {
      settledCount += 1;
      const pnl = toNumber(row.pnl_usd) ?? 0;
      realizedPnl += pnl;
      pnlContribution = pnl;
    } else if (row.status === "OPEN") {
      openCount += 1;
      const currentPrice = toNumber(row.current_price);
      const shares = toNumber(row.shares) ?? 0;
      if (currentPrice == null) {
        missingPrices += 1;
        continue;
      }
      const pnl = shares * currentPrice - usdSize;
      unrealizedPnl += pnl;
      pnlContribution = pnl;
    }

    if (pnlContribution !== 0) {
      const trader = row.source_wallet ?? "unknown";
      pnlByTrader.set(trader, (pnlByTrader.get(trader) || 0) + pnlContribution);

      const marketLabel = row.market_title || row.market_id || "unknown";
      pnlByMarket.set(
        marketLabel,
        (pnlByMarket.get(marketLabel) || 0) + pnlContribution,
      );
    }
  }

  return {
    countPositions,
    openCount,
    settledCount,
    totalStaked,
    realizedPnl,
    unrealizedPnl,
    projectedTotal: realizedPnl + unrealizedPnl,
    missingPrices,
    pnlByTrader,
    pnlByMarket,
  };
}

async function sendTelegramMessage(text: string): Promise<void> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    throw new Error("Telegram not configured (missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)");
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram API error: ${error}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUrl = new URL(req.url);
    const hoursParam = toNumber(requestUrl.searchParams.get("hours"));
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const scopeParam = requestUrl.searchParams.get("scope");
    const scope: AlertScope = scopeParam === "all_time"
      ? "all_time"
      : scopeParam === "since_reset"
      ? "since_reset"
      : "window";
    const portfolioIdParam = toNumber(requestUrl.searchParams.get("portfolio_id"));
    const windowHours = hoursParam && hoursParam > 0
      ? Math.min(hoursParam, 48)
      : 6;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    if (scope === "all_time") {
      let summaryQuery = supabase
        .from("paper_portfolio_pnl_summary")
        .select(
          "portfolio_id,total_positions,total_paper_staked,open_exposure,realized_pnl,projected_unrealized_pnl,projected_total_pnl,open_missing_price",
        )
        .order("portfolio_id", { ascending: true })
        .limit(1);

      if (portfolioIdParam != null && portfolioIdParam > 0) {
        summaryQuery = summaryQuery.eq("portfolio_id", portfolioIdParam);
      }

      const { data: summaryRows, error: summaryError } = await summaryQuery;

      if (summaryError) {
        throw new Error(`Failed to load paper_portfolio_pnl_summary: ${summaryError.message}`);
      }

      const summary = summaryRows?.[0];
      if (!summary) {
        const message = "PAPER COPY (all-time)\nNo paper portfolio summary available.";
        if (!dryRun) await sendTelegramMessage(message);
        return new Response(
          JSON.stringify({ success: true, dry_run: dryRun, scope, message }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const totalPositions = toNumber(summary.total_positions) ?? 0;
      const totalStaked = toNumber(summary.total_paper_staked) ?? 0;
      const openExposure = toNumber(summary.open_exposure) ?? 0;
      const realizedPnl = toNumber(summary.realized_pnl) ?? 0;
      const projectedUnrealized = toNumber(summary.projected_unrealized_pnl) ?? 0;
      const projectedTotal = toNumber(summary.projected_total_pnl) ?? 0;
      const missingPrices = toNumber(summary.open_missing_price) ?? 0;

      let message = "PAPER COPY (all-time)";
      message += `\nTotal positions: ${totalPositions}`;
      message += `\nTotal paper staked: ${formatAbsUsd(totalStaked)}`;
      message += `\nOpen exposure: ${formatAbsUsd(openExposure)}`;
      message += `\nRealized P/L: ${formatUsd(realizedPnl)}`;
      message += `\nProjected total P/L: ${formatUsd(projectedTotal)} (unrealized: ${formatUsd(projectedUnrealized)})`;
      message += `\nMissing prices on open positions: ${missingPrices}`;

      if (!dryRun) {
        await sendTelegramMessage(message);
      }

      return new Response(
        JSON.stringify({
          success: true,
          dry_run: dryRun,
          scope,
          portfolio_id: summary.portfolio_id,
          total_positions: totalPositions,
          total_staked: totalStaked,
          open_exposure: openExposure,
          realized_pnl: realizedPnl,
          unrealized_pnl: projectedUnrealized,
          projected_total_pnl: projectedTotal,
          missing_prices: missingPrices,
          message,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (scope === "since_reset") {
      let resetQuery = supabase
        .from("paper_strategy_resets")
        .select("id, portfolio_id, label, reset_at")
        .order("reset_at", { ascending: false })
        .limit(1);

      if (portfolioIdParam != null && portfolioIdParam > 0) {
        resetQuery = resetQuery.eq("portfolio_id", portfolioIdParam);
      }

      const { data: resetRows, error: resetError } = await resetQuery;
      if (resetError) {
        throw new Error(`Failed to load paper strategy reset marker: ${resetError.message}`);
      }

      const reset = resetRows?.[0];
      if (!reset?.reset_at) {
        const message = "PAPER COPY (since reset)\nNo reset marker found.";
        if (!dryRun) await sendTelegramMessage(message);
        return new Response(
          JSON.stringify({ success: true, dry_run: dryRun, scope, message }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let sinceResetQuery = supabase
        .from("paper_positions_with_price")
        .select(
          "portfolio_id,source_wallet,market_id,market_title,status,usd_size,shares,pnl_usd,entry_ts,current_price",
        )
        .gte("entry_ts", reset.reset_at)
        .order("entry_ts", { ascending: false })
        .limit(5000);

      if (portfolioIdParam != null && portfolioIdParam > 0) {
        sinceResetQuery = sinceResetQuery.eq("portfolio_id", portfolioIdParam);
      }

      const { data: positions, error: positionsError } = await sinceResetQuery;
      if (positionsError) {
        throw new Error(`Failed to load since-reset positions: ${positionsError.message}`);
      }

      const metrics = aggregatePositions((positions || []) as PositionWithPriceRow[]);

      let message = "PAPER COPY (since reset)";
      message += `\nCopied trades: ${metrics.countPositions}`;
      message += `\nOpen positions: ${metrics.openCount} | Settled: ${metrics.settledCount}`;
      message += `\nProjected P/L: ${formatUsd(metrics.projectedTotal)} (Realized: ${formatUsd(metrics.realizedPnl)}, Unrealized: ${formatUsd(metrics.unrealizedPnl)})`;

      if (!dryRun) {
        await sendTelegramMessage(message);
      }

      return new Response(
        JSON.stringify({
          success: true,
          dry_run: dryRun,
          scope,
          reset: {
            id: reset.id ?? null,
            portfolio_id: reset.portfolio_id ?? null,
            label: reset.label ?? null,
            reset_at: new Date(reset.reset_at).toISOString(),
          },
          count_positions: metrics.countPositions,
          open_count: metrics.openCount,
          settled_count: metrics.settledCount,
          total_staked: metrics.totalStaked,
          realized_pnl: metrics.realizedPnl,
          unrealized_pnl: metrics.unrealizedPnl,
          projected_total_pnl: metrics.projectedTotal,
          missing_prices: metrics.missingPrices,
          message,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: enabledTraders, error: tradersError } = await supabase
      .from("copy_traders")
      .select("wallet")
      .eq("enabled", true);

    if (tradersError) {
      throw new Error(`Failed to load copy_traders: ${tradersError.message}`);
    }

    const wallets = (enabledTraders || [])
      .map((row) => row.wallet)
      .filter((wallet): wallet is string => Boolean(wallet));

    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    if (wallets.length === 0) {
      const message = `PAPER COPY (last ${windowHours}h)\nNo enabled copy_traders found.`;
      if (!dryRun) await sendTelegramMessage(message);
      return new Response(
        JSON.stringify({ success: true, dry_run: dryRun, message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: positions, error: positionsError } = await supabase
      .from("paper_positions_with_price")
      .select(
        "id, source_wallet, market_id, market_title, outcome, status, usd_size, shares, pnl_usd, entry_ts, current_price",
      )
      .gte("entry_ts", since.toISOString())
      .in("source_wallet", wallets)
      .order("entry_ts", { ascending: false })
      .limit(2000);

    if (positionsError) {
      throw new Error(`Failed to load paper positions: ${positionsError.message}`);
    }

    const metrics = aggregatePositions((positions || []) as PositionWithPriceRow[]);

    let message = `PAPER COPY (last ${windowHours}h)`;
    message += `\nCopied trades: ${metrics.countPositions}`;
    message += `\nStaked: ${formatAbsUsd(metrics.totalStaked)}`;
    message += `\nOpen: ${metrics.openCount} | Settled: ${metrics.settledCount}`;
    message += `\nProjected P/L: ${formatUsd(metrics.projectedTotal)} (Realized: ${formatUsd(metrics.realizedPnl)}, Unrealized: ${formatUsd(metrics.unrealizedPnl)})`;

    if (metrics.missingPrices > 0) {
      message += `\nMissing prices: ${metrics.missingPrices}`;
    }

    message += `\nTop traders: ${buildTopList(metrics.pnlByTrader)}`;
    message += `\nTop markets: ${buildTopList(metrics.pnlByMarket)}`;

    if (!dryRun) {
      await sendTelegramMessage(message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        window_hours: windowHours,
        count_positions: metrics.countPositions,
        open_count: metrics.openCount,
        settled_count: metrics.settledCount,
        total_staked: metrics.totalStaked,
        realized_pnl: metrics.realizedPnl,
        unrealized_pnl: metrics.unrealizedPnl,
        projected_total_pnl: metrics.projectedTotal,
        missing_prices: metrics.missingPrices,
        message,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("paper-pnl-telegram-alert error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message || error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
