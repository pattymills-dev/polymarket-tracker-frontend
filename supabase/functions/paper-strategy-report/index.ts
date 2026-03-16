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

type PositionRow = {
  strategy_lane: string | null;
  status: string | null;
  usd_size: number | string | null;
  shares: number | string | null;
  pnl_usd: number | string | null;
  current_price: number | string | null;
  exit_ts: string | null;
};

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
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const portfolioIdParam = toNumber(requestUrl.searchParams.get("portfolio_id"));

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    const supabase = createClient(supabaseUrl, serviceRole);

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
      throw new Error(`Failed to load reset marker: ${resetError.message}`);
    }

    const reset = resetRows?.[0];
    if (!reset?.reset_at) {
      const message = "PAPER STRATEGY SPLIT\nNo reset marker found.";
      if (!dryRun) await sendTelegramMessage(message);
      return new Response(JSON.stringify({ success: true, dry_run: dryRun, message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let positionsQuery = supabase
      .from("paper_positions_with_price")
      .select("strategy_lane,status,usd_size,shares,pnl_usd,current_price,exit_ts")
      .gte("entry_ts", reset.reset_at)
      .neq("status", "CANCELED")
      .limit(10000);
    if (portfolioIdParam != null && portfolioIdParam > 0) {
      positionsQuery = positionsQuery.eq("portfolio_id", portfolioIdParam);
    }
    const { data: positions, error: positionsError } = await positionsQuery;
    if (positionsError) {
      throw new Error(`Failed to load paper positions: ${positionsError.message}`);
    }

    const now = new Date();
    const h24Cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const lanes = Array.from(
      new Set(
        ((positions || []) as PositionRow[])
          .map((r) => (r.strategy_lane || "copy").toLowerCase()),
      ),
    );
    for (const defaultLane of ["copy", "structural", "anomaly"]) {
      if (!lanes.includes(defaultLane)) lanes.push(defaultLane);
    }
    const laneMetrics: Record<string, Record<string, number>> = {};

    for (const lane of lanes) {
      const rows = ((positions || []) as PositionRow[]).filter(
        (r) => (r.strategy_lane || "copy").toLowerCase() === lane,
      );
      const openRows = rows.filter((r) => r.status === "OPEN");
      const settledRows = rows.filter((r) => r.status === "SETTLED");
      const realized = settledRows.reduce((acc, r) => acc + (toNumber(r.pnl_usd) ?? 0), 0);
      const unrealized = openRows.reduce((acc, r) => {
        const shares = toNumber(r.shares) ?? 0;
        const currentPrice = toNumber(r.current_price);
        const usdSize = toNumber(r.usd_size) ?? 0;
        if (currentPrice == null) return acc;
        return acc + (shares * currentPrice - usdSize);
      }, 0);
      const realized24h = settledRows
        .filter((r) => r.exit_ts && r.exit_ts >= h24Cutoff)
        .reduce((acc, r) => acc + (toNumber(r.pnl_usd) ?? 0), 0);

      laneMetrics[lane] = {
        trades: rows.length,
        open: openRows.length,
        settled: settledRows.length,
        realized,
        unrealized,
        projected: realized + unrealized,
        realized24h,
      };
    }

    let message = "PAPER STRATEGY SPLIT (since reset)";
    message += `\nLabel: ${reset.label ?? "n/a"}`;
    for (const lane of lanes) {
      const metrics = laneMetrics[lane];
      message += `\n${lane}: trades ${metrics.trades} | open ${metrics.open} | settled ${metrics.settled} | projected ${formatUsd(metrics.projected)}`;
    }
    const realized24hLine = lanes
      .map((lane) => `${lane} ${formatUsd(laneMetrics[lane].realized24h)}`)
      .join(" | ");
    message += `\n24h realized: ${realized24hLine}`;

    if (!dryRun) {
      await sendTelegramMessage(message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        reset,
        lanes: laneMetrics,
        message,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("paper-strategy-report error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message || error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
