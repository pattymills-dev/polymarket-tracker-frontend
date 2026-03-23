import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeFixedStakeUsdSize, computeKellyUsdSize } from "./sizing.ts";

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type CopyTrader = {
  wallet: string | null;
  enabled: boolean | null;
  pinned: boolean | null;
  copy_factor: number | string | null;
  min_usd: number | string | null;
  max_usd: number | string | null;
  max_trader_exposure_pct: number | string | null;
  per_trader_cooldown_minutes: number | string | null;
  min_price: number | string | null;
  max_price: number | string | null;
  price_penalty: number | string | null;
  allow_sells: boolean | null;
  cooldown_minutes: number | string | null;
  start_from_ts: string | null;
  max_copyable_rank_30d: number | string | null;
  min_realized_roi_30d: number | string | null;
  min_realized_pl_30d: number | string | null;
  min_median_bet_30d: number | string | null;
  min_resolved_trades_30d: number | string | null;
  min_confidence_30d: number | string | null;
  max_open_positions: number | string | null; // Hard cap on concurrent positions
  previous_rank_30d: number | string | null;  // Track rank decay
};

type PaperPortfolio = {
  id: number | string | null;
  starting_usd: number | string | null;
  max_trade_risk_pct: number | string | null;
  max_total_exposure_pct: number | string | null;
  market_exposure_cap_pct: number | string | null;
  fixed_usd_per_trade: number | string | null;
};

type OpenCopyPositionWithPrice = {
  id: string;
  source_wallet: string | null;
  market_id: string | null;
  shares: number | string | null;
  usd_size: number | string | null;
  current_price: number | string | null;
  entry_ts: string | null;
};

const DEFAULT_COPY_FACTOR = 0.1;
const DEFAULT_PRICE_PENALTY = 0.01;
const DEFAULT_MIN_PRICE = 0.15; // Let curated top traders express moderate underdog conviction without reopening deep longshot bleed.
const DEFAULT_MAX_PRICE = 0.92; // Allow late, high-conviction entries from elite traders near resolution.
const DEFAULT_MAX_TRADE_RISK_PCT = 0.03;
const DEFAULT_MAX_TRADER_EXPOSURE_PCT = 0.25;
const DEFAULT_MAX_TOTAL_EXPOSURE_PCT = 0.35;
const DEFAULT_MARKET_EXPOSURE_CAP_PCT = 0.08;
const DEFAULT_FIXED_USD_PER_TRADE = 25;
const SAFETY_MAX_FIXED_USD_PER_TRADE = 200; // Raised — was hard-capped at $10, blocking DB config
// Quarter-Kelly sizing bounds
const KELLY_FRACTION = 0.25;
const KELLY_MIN_USD = 15;   // Never bet less than $15
const KELLY_MAX_USD = 150;  // Never bet more than $150 per trade
const DEFAULT_LOOKBACK_SECONDS = 1;
const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_TRADE_AGE_MINUTES = 120; // Wide window to avoid missing trades between workflow runs.
const MAX_NEW_POSITIONS_PER_RUN = 6; // Keep activity focused and avoid burst overtrading
const SIZING_METHOD = "quarter_kelly";
const PRICE_RULE = "source_price_plus_penalty";

// Data freshness check - don't copy if rankings are stale
const MAX_RANKINGS_AGE_HOURS = 24; // Skip copying if data is older than 24 hours

// Position limits per trader - keep exposure concentrated within the curated shortlist.
const DEFAULT_MAX_OPEN_POSITIONS_PER_TRADER = 3;

// Default shortlist gates - runtime fallback if a copy_traders row is missing explicit thresholds.
const DEFAULT_MAX_COPYABLE_RANK = 25;
const DEFAULT_MIN_RESOLVED_TRADES_30D = 10;
const DEFAULT_MIN_CONFIDENCE_30D = 2;
const DEFAULT_PER_TRADER_COOLDOWN_MINUTES = 240;
const DEFAULT_MAX_ENTRIES_PER_TRADER_MARKET_24H = 1;

// Rank decay threshold - if a trader falls this many spots, flag them
const RANK_DECAY_WARNING_THRESHOLD = 10;

// Paper win-rate auto-gate - DISABLED: paper P/L driven by bad stop-loss/time-exit mechanics,
// not trader skill. Gates were blocking all 3 enabled traders. Re-evaluate after fixing exits.
const PAPER_WIN_RATE_MIN = 0.0;             // Disabled (was 0.50)
const PAPER_WIN_RATE_MIN_POSITIONS = 9999;  // Disabled (was 10)
const PAPER_LOSS_GATE_MIN_POSITIONS = 9999; // Disabled (was 4)
const PAPER_REALIZED_LOSS_GATE_USD = -9999; // Disabled (was -20)

// Copy lane risk controls: close before resolution when drift edge is captured/lost.
const COPY_TAKE_PROFIT_PCT = 0.12;
const COPY_STOP_LOSS_PCT = -0.22;
const COPY_SOFT_MAX_HOLD_HOURS = 24;  // Was 8 — too short for sports bets placed before game time
const COPY_HARD_MAX_HOLD_HOURS = 48;  // Was 20 — allow full 48h for game + resolution to settle

// Market category filters - esports markets have been unprofitable
// Blacklist slugs that start with these prefixes
const BLACKLISTED_SLUG_PREFIXES = [
  "lol-",      // League of Legends
  "cs2-",      // Counter-Strike 2
  "val-",      // Valorant
  "dota2-",    // Dota 2
  "rl-",       // Rocket League
  "lec-",      // LoL European Championship
  "lpl-",      // LoL Pro League
  "lck-",      // LoL Champions Korea
  "vct-",      // Valorant Champions Tour
  "hok-",      // Honor of Kings
  "r6siege-",  // Rainbow Six Siege
];

// Helper to check if a market slug is blacklisted
function isBlacklistedMarket(slug: string | null): boolean {
  if (!slug) return false;
  const lowerSlug = slug.toLowerCase();
  return BLACKLISTED_SLUG_PREFIXES.some(prefix => lowerSlug.startsWith(prefix));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUrl = new URL(req.url);
    const dryRun = requestUrl.searchParams.get("dry_run") === "1";
    const limitParam = toNumber(requestUrl.searchParams.get("limit"));
    const maxTradeAgeMinutesParam = toNumber(
      requestUrl.searchParams.get("max_trade_age_minutes"),
    );
    const maxTradesPerWallet =
      limitParam && limitParam > 0 ? Math.floor(limitParam) : DEFAULT_LIMIT;
    const maxTradeAgeMinutes =
      maxTradeAgeMinutesParam && maxTradeAgeMinutesParam > 0
        ? Math.floor(maxTradeAgeMinutesParam)
        : DEFAULT_MAX_TRADE_AGE_MINUTES;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    const { data: traders, error: tradersError } = await supabase
      .from("copy_traders")
      .select("*")
      .eq("enabled", true);

    if (tradersError) {
      throw new Error(`Failed to load copy_traders: ${tradersError.message}`);
    }

    if (!traders || traders.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No enabled copy_traders" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const wallets = traders
      .map((t) => t.wallet?.toLowerCase())
      .filter((w): w is string => Boolean(w));

    const rankingMap = new Map<string, any>();
    if (wallets.length > 0) {
      const { data: rankings, error: rankingsError } = await supabase
        .from("trader_rankings")
        .select(
          "trader_address, copyable_rank_30d, realized_roi_30d, realized_pl_30d, median_bet_30d, resolved_trades_30d, confidence_30d, computed_at",
        )
        .in("trader_address", wallets);

      if (rankingsError) {
        console.warn("Failed to load trader_rankings:", rankingsError.message);
      } else {
        // Check data freshness - find the most recent computed_at
        let mostRecentUpdate: Date | null = null;
        for (const ranking of rankings || []) {
          if (ranking?.trader_address) {
            rankingMap.set(
              String(ranking.trader_address).toLowerCase(),
              ranking,
            );
            if (ranking.computed_at) {
              const computedAt = new Date(ranking.computed_at);
              if (!mostRecentUpdate || computedAt > mostRecentUpdate) {
                mostRecentUpdate = computedAt;
              }
            }
          }
        }

        // SAFETY CHECK: Skip copying if rankings data is stale
        if (mostRecentUpdate) {
          const ageHours = (Date.now() - mostRecentUpdate.getTime()) / (1000 * 60 * 60);
          if (ageHours > MAX_RANKINGS_AGE_HOURS) {
            console.error(`STALE DATA WARNING: trader_rankings last updated ${ageHours.toFixed(1)} hours ago (max ${MAX_RANKINGS_AGE_HOURS}h). Skipping copy trades.`);
            return new Response(
              JSON.stringify({
                success: false,
                error: "stale_rankings_data",
                message: `Rankings data is ${ageHours.toFixed(1)} hours old. Refresh required before copying.`,
                last_updated: mostRecentUpdate.toISOString(),
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 503 },
            );
          }
          console.log(`Rankings data freshness: ${ageHours.toFixed(1)} hours old (limit: ${MAX_RANKINGS_AGE_HOURS}h)`);
        }
      }
    }

    const { data: portfolio, error: portfolioError } = await supabase
      .from("paper_portfolios")
      .select(
        "id, starting_usd, max_trade_risk_pct, max_total_exposure_pct, market_exposure_cap_pct, fixed_usd_per_trade",
      )
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (portfolioError) {
      throw new Error(
        `Failed to load paper_portfolios: ${portfolioError.message}`,
      );
    }

    if (!portfolio?.id) {
      throw new Error(
        "No paper_portfolios row found. Insert one before running paper copy.",
      );
    }

    const portfolioId = Number(portfolio.id);
    if (!Number.isFinite(portfolioId)) {
      throw new Error("Invalid paper_portfolios.id");
    }

    const startingUsd = toNumber(portfolio.starting_usd) ?? 0;

    const { data: equityRow, error: equityError } = await supabase
      .from("paper_portfolio_equity")
      .select("portfolio_id, equity_usd")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();

    if (equityError) {
      console.warn("Failed to load portfolio equity:", equityError.message);
    }

    const portfolioEquityUsd =
      toNumber(equityRow?.equity_usd) ?? startingUsd;

    const { data: openTotalRow, error: openTotalError } = await supabase
      .from("paper_open_exposure_total")
      .select("open_usd")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();

    if (openTotalError) {
      console.warn("Failed to load open exposure total:", openTotalError.message);
    }

    let openTotalUsd = toNumber(openTotalRow?.open_usd) ?? 0;

    const openTraderMap = new Map<string, number>();
    const openPositionCountMap = new Map<string, number>(); // Track position count per trader
    if (wallets.length > 0) {
      const { data: openByTrader, error: openByTraderError } = await supabase
        .from("paper_open_exposure_by_trader")
        .select("source_wallet, open_usd")
        .eq("portfolio_id", portfolioId)
        .in("source_wallet", wallets);

      if (openByTraderError) {
        console.warn(
          "Failed to load open exposure by trader:",
          openByTraderError.message,
        );
      } else {
        for (const row of openByTrader || []) {
          if (row?.source_wallet) {
            openTraderMap.set(
              String(row.source_wallet).toLowerCase(),
              toNumber(row.open_usd) ?? 0,
            );
          }
        }
      }

      // Count open positions per trader
      const { data: openPositionCounts, error: positionCountError } = await supabase
        .from("paper_positions")
        .select("source_wallet")
        .eq("portfolio_id", portfolioId)
        .eq("status", "OPEN")
        .in("source_wallet", wallets);

      if (positionCountError) {
        console.warn(
          "Failed to load open position counts:",
          positionCountError.message,
        );
      } else {
        for (const row of openPositionCounts || []) {
          if (row?.source_wallet) {
            const wallet = String(row.source_wallet).toLowerCase();
            openPositionCountMap.set(wallet, (openPositionCountMap.get(wallet) ?? 0) + 1);
          }
        }
      }
    }

    // Load paper win/loss counts per trader for the win-rate gate
    const paperWinRateMap = new Map<string, {
      wins: number;
      losses: number;
      total: number;
      winRate: number;
      realizedPnl: number;
    }>();
    if (wallets.length > 0) {
      const { data: settledPositions, error: settledError } = await supabase
        .from("paper_positions")
        .select("source_wallet, pnl_usd")
        .eq("portfolio_id", portfolioId)
        .eq("status", "SETTLED")
        .in("source_wallet", wallets);

      if (settledError) {
        console.warn("Failed to load paper performance:", settledError.message);
      } else {
        for (const pos of settledPositions || []) {
          if (pos?.source_wallet) {
            const w = String(pos.source_wallet).toLowerCase();
            const pnl = toNumber(pos.pnl_usd) ?? 0;
            const current = paperWinRateMap.get(w) ?? {
              wins: 0,
              losses: 0,
              total: 0,
              winRate: 0,
              realizedPnl: 0,
            };
            current.total += 1;
            if (pnl > 0) {
              current.wins += 1;
            } else {
              current.losses += 1;
            }
            current.realizedPnl += pnl;
            current.winRate = current.total > 0 ? current.wins / current.total : 0;
            paperWinRateMap.set(w, current);
          }
        }
        // Log paper performance for diagnostics
        for (const [w, stats] of paperWinRateMap) {
          console.log(
            `Paper performance ${w.slice(0, 10)}...: ${stats.wins}W-${stats.losses}L (${(stats.winRate * 100).toFixed(1)}%) from ${stats.total} settled, pnl=${stats.realizedPnl.toFixed(2)}`,
          );
        }
      }
    }

    const openMarketMap = new Map<string, number>();
    const getMarketOpenExposure = async (
      marketId: string,
    ): Promise<number> => {
      if (openMarketMap.has(marketId)) {
        return openMarketMap.get(marketId) ?? 0;
      }
      const { data, error } = await supabase
        .from("paper_open_exposure_by_market")
        .select("open_usd")
        .eq("portfolio_id", portfolioId)
        .eq("market_id", marketId)
        .maybeSingle();
      if (error) {
        console.warn(
          `Failed to load open exposure for market ${marketId}:`,
          error.message,
        );
      }
      const openUsd = toNumber(data?.open_usd) ?? 0;
      openMarketMap.set(marketId, openUsd);
      return openUsd;
    };

    const portfolioMaxTradeRiskPct =
      toNumber(portfolio.max_trade_risk_pct) ?? DEFAULT_MAX_TRADE_RISK_PCT;
    const portfolioMaxTotalExposurePct =
      toNumber(portfolio.max_total_exposure_pct) ??
        DEFAULT_MAX_TOTAL_EXPOSURE_PCT;
    const portfolioMarketExposureCapPct =
      toNumber(portfolio.market_exposure_cap_pct) ??
        DEFAULT_MARKET_EXPOSURE_CAP_PCT;
    const configuredFixedUsdPerTrade = toNumber(portfolio.fixed_usd_per_trade) ??
      DEFAULT_FIXED_USD_PER_TRADE;
    const fixedUsdPerTrade = Math.min(
      configuredFixedUsdPerTrade,
      SAFETY_MAX_FIXED_USD_PER_TRADE,
    );

    const now = new Date();
    let copyRunId: string | null = null;
    const summary = {
      success: true,
      dry_run: dryRun,
      wallets_processed: 0,
      trades_scanned: 0,
      positions_created: 0,
      positions_closed_risk: 0,
      cursors_updated: 0,
      skipped: 0,
      skip_reasons: {} as Record<string, number>,
    };

    if (!dryRun) {
      const { data: runRow, error: runError } = await supabase
        .from("copy_runs")
        .insert({
          started_at: now.toISOString(),
          portfolio_id: portfolioId,
          sizing_method: SIZING_METHOD,
          price_rule: PRICE_RULE,
          fixed_usd_per_trade: fixedUsdPerTrade,
          max_trade_risk_pct: portfolioMaxTradeRiskPct,
          max_total_exposure_pct: portfolioMaxTotalExposurePct,
          market_exposure_cap_pct: portfolioMarketExposureCapPct,
          copy_traders_count: traders.length,
        })
        .select("id")
        .maybeSingle();

      if (runError) {
        console.warn("Failed to create copy_runs row:", runError.message);
      } else {
        copyRunId = runRow?.id ?? null;
      }
    }

    const noteSkip = (reason: string) => {
      summary.skipped += 1;
      summary.skip_reasons[reason] = (summary.skip_reasons[reason] || 0) + 1;
    };

    const recordDecision = async (payload: Record<string, unknown>) => {
      if (dryRun || !copyRunId) return;
      const { error } = await supabase
        .from("copy_trade_decisions")
        .insert({ copy_run_id: copyRunId, ...payload });
      if (error) {
        console.warn("Failed to record decision:", error.message);
      }
    };

    const logTradeSkip = (
      tradeId: string | null,
      wallet: string,
      marketId: string | null,
      reason: string,
    ) => {
      noteSkip(reason);
      console.log(
        `skip trade ${tradeId ?? "unknown"} wallet=${wallet} market=${
          marketId ?? "unknown"
        }: ${reason}`,
      );
    };

    const copiedSignalKeysThisRun = new Set<string>();

    // Risk-first behavior: close copy positions pre-resolution when edge is captured/lost.
    const { data: openCopyRows, error: openCopyRowsError } = await supabase
      .from("paper_positions_with_price")
      .select("id,source_wallet,market_id,shares,usd_size,current_price,entry_ts")
      .eq("portfolio_id", portfolioId)
      .eq("strategy_lane", "copy")
      .eq("status", "OPEN")
      .limit(5000);

    if (openCopyRowsError) {
      console.warn("Failed to load open copy positions for risk manager:", openCopyRowsError.message);
    } else {
      const nowIso = now.toISOString();
      for (const row of (openCopyRows || []) as OpenCopyPositionWithPrice[]) {
        const currentPrice = toNumber(row.current_price);
        const shares = toNumber(row.shares) ?? 0;
        const usdSize = toNumber(row.usd_size) ?? 0;
        if (currentPrice == null || usdSize <= 0 || shares <= 0) continue;

        const pnlUsd = shares * currentPrice - usdSize;
        const pnlPct = pnlUsd / usdSize;
        const holdHours = row.entry_ts
          ? (now.getTime() - new Date(row.entry_ts).getTime()) / (1000 * 60 * 60)
          : 0;

        let exitReason: string | null = null;
        if (pnlPct >= COPY_TAKE_PROFIT_PCT) {
          exitReason = "copy_take_profit";
          // Stop loss removed: for binary sports markets it fired after the market
          // had already crashed, providing no protection while locking in worst-case
          // exits. Positions now ride to resolution or hard time-stop.
        } else if (holdHours >= COPY_HARD_MAX_HOLD_HOURS) {
          exitReason = "copy_time_stop";
        } else if (holdHours >= COPY_SOFT_MAX_HOLD_HOURS && pnlPct >= -0.02) {
          exitReason = "copy_time_exit";
        }
        if (!exitReason) continue;

        if (!dryRun) {
          const { error: closeError } = await supabase
            .from("paper_positions")
            .update({
              status: "SETTLED",
              exit_price: currentPrice,
              exit_ts: nowIso,
              pnl_usd: pnlUsd,
              exit_reason: exitReason,
              updated_at: nowIso,
            })
            .eq("id", row.id)
            .eq("status", "OPEN")
            .eq("strategy_lane", "copy");
          if (closeError) {
            console.warn(`Failed to risk-close copy position ${row.id}:`, closeError.message);
            noteSkip("copy_risk_close_failed");
            continue;
          }
        }

        summary.positions_closed_risk += 1;
        openTotalUsd = Math.max(0, openTotalUsd - usdSize);
        const rowWallet = row.source_wallet?.toLowerCase();
        if (rowWallet) {
          const nextExposure = Math.max(0, (openTraderMap.get(rowWallet) ?? 0) - usdSize);
          openTraderMap.set(rowWallet, nextExposure);
          const nextCount = Math.max(0, (openPositionCountMap.get(rowWallet) ?? 0) - 1);
          openPositionCountMap.set(rowWallet, nextCount);
        }
        if (row.market_id && openMarketMap.has(row.market_id)) {
          openMarketMap.set(
            row.market_id,
            Math.max(0, (openMarketMap.get(row.market_id) ?? 0) - usdSize),
          );
        }
      }
    }

    for (const traderRaw of traders as CopyTrader[]) {
      const wallet = traderRaw.wallet?.toLowerCase() ?? null;
      if (!wallet) {
        noteSkip("missing_wallet");
        continue;
      }

      summary.wallets_processed += 1;

      const { data: state, error: stateError } = await supabase
        .from("copy_state")
        .select("wallet, last_seen_ts")
        .eq("wallet", wallet)
        .maybeSingle();

      if (stateError) {
        console.warn("Failed to load copy_state:", stateError.message);
        noteSkip("state_lookup_failed");
        continue;
      }

      let lastSeen = state?.last_seen_ts
        ? new Date(state.last_seen_ts)
        : null;

      if (!lastSeen) {
        const startFrom = traderRaw.start_from_ts
          ? new Date(traderRaw.start_from_ts)
          : null;
        // Initialize cursor to max_trade_age_minutes ago so newly enabled traders
        // immediately pick up recent trades instead of starting from now.
        const defaultLookback = new Date(now.getTime() - maxTradeAgeMinutes * 60 * 1000);
        const initTs = startFrom ?? defaultLookback;

        if (!dryRun) {
          const { error: initError } = await supabase
            .from("copy_state")
            .upsert({
              wallet,
              last_seen_ts: initTs.toISOString(),
              updated_at: now.toISOString(),
            });

          if (initError) {
            console.warn("Failed to initialize copy_state:", initError.message);
          } else {
            summary.cursors_updated += 1;
          }
        }

        if (!startFrom) {
          // No backfill requested; begin tracking from now.
          continue;
        }

        lastSeen = startFrom;
      }

      const lookbackSeconds = DEFAULT_LOOKBACK_SECONDS;
      const sinceTs = new Date(lastSeen.getTime() - lookbackSeconds * 1000);

      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select(
          "tx_hash, market_id, market_slug, market_title, outcome, side, price, amount, timestamp",
        )
        .eq("trader_address", wallet)
        .gte("timestamp", sinceTs.toISOString())
        .order("timestamp", { ascending: true })
        .limit(maxTradesPerWallet);

      if (tradesError) {
        console.warn("Failed to load trades:", tradesError.message);
        noteSkip("trades_lookup_failed");
        continue;
      }

      if (!trades || trades.length === 0) {
        continue;
      }

      summary.trades_scanned += trades.length;

      // Two-sided bet detection: if a trader bets BOTH outcomes on the same market
      // within 30 minutes, it's a market-making strategy — skip all sides.
      // Key example: 0x2a2c53bd27 bets $400K YES and $130K NO on the same CBB game.
      const twoSidedMarkets = new Set<string>();
      {
        type BetEntry = { outcome: string; ts: number };
        const marketBets = new Map<string, BetEntry[]>();
        for (const t of trades) {
          if (!t.market_id || !t.outcome || !t.timestamp) continue;
          const ts = new Date(t.timestamp).getTime();
          const list = marketBets.get(t.market_id) ?? [];
          list.push({ outcome: t.outcome, ts });
          marketBets.set(t.market_id, list);
        }
        for (const [mId, bets] of marketBets) {
          const outcomes = new Set(bets.map((b) => b.outcome));
          if (outcomes.size < 2) continue;
          const times = bets.map((b) => b.ts).sort((a, b) => a - b);
          const windowMs = 30 * 60 * 1000;
          if (times[times.length - 1] - times[0] <= windowMs) {
            twoSidedMarkets.add(mId);
          }
        }
      }

      let maxSeen = lastSeen;
      let earliestRetryableTradeTs: Date | null = null;

      for (const trade of trades) {
        if (summary.positions_created >= MAX_NEW_POSITIONS_PER_RUN) {
          logTradeSkip(
            trade.tx_hash ?? null,
            wallet,
            trade.market_id ?? null,
            "run_position_cap",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: "run_position_cap",
            source_trade_id: trade.tx_hash ?? null,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id ?? null,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: trade.price ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
          });
          continue;
        }

        const tradeTs = trade.timestamp ? new Date(trade.timestamp) : null;
        if (tradeTs && tradeTs > maxSeen) maxSeen = tradeTs;

        if (!tradeTs || Number.isNaN(tradeTs.getTime())) {
          logTradeSkip(
            trade.tx_hash ?? null,
            wallet,
            trade.market_id ?? null,
            "missing_trade_timestamp",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: "missing_trade_timestamp",
            source_trade_id: trade.tx_hash ?? null,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id ?? null,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: trade.price ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
          });
          continue;
        }

        const tradeAgeMinutes = (now.getTime() - tradeTs.getTime()) / (1000 * 60);
        if (tradeAgeMinutes > maxTradeAgeMinutes) {
          logTradeSkip(
            trade.tx_hash ?? null,
            wallet,
            trade.market_id ?? null,
            "stale_trade",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: "stale_trade",
            source_trade_id: trade.tx_hash ?? null,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id ?? null,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: trade.price ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
          });
          continue;
        }

        const ranking = rankingMap.get(wallet);
        const rankingSnapshot = ranking
          ? {
            copyable_rank_30d: ranking.copyable_rank_30d,
            realized_roi_30d: ranking.realized_roi_30d,
            realized_pl_30d: ranking.realized_pl_30d,
            median_bet_30d: ranking.median_bet_30d,
            resolved_trades_30d: ranking.resolved_trades_30d,
            confidence_30d: ranking.confidence_30d,
            computed_at: ranking.computed_at,
          }
          : null;

        const minPrice = toNumber(traderRaw.min_price) ?? DEFAULT_MIN_PRICE;
        const maxPrice = toNumber(traderRaw.max_price) ?? DEFAULT_MAX_PRICE;
        const allowSells = traderRaw.allow_sells ?? false;
        const copyFactor = toNumber(traderRaw.copy_factor) ??
          DEFAULT_COPY_FACTOR;
        const maxTraderExposurePct = toNumber(
          traderRaw.max_trader_exposure_pct,
        ) ?? DEFAULT_MAX_TRADER_EXPOSURE_PCT;
        const penalty = toNumber(traderRaw.price_penalty) ??
          DEFAULT_PRICE_PENALTY;

        // Two-sided bet filter: skip if trader placed opposing bets within 30 min
        if (trade.market_id && twoSidedMarkets.has(trade.market_id)) {
          logTradeSkip(trade.tx_hash ?? null, wallet, trade.market_id, "two_sided_bet");
          await recordDecision({
            decision: "SKIPPED",
            reason: "two_sided_bet",
            source_trade_id: trade.tx_hash ?? null,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: toNumber(trade.price) ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
          });
          continue;
        }

        if (!trade.tx_hash || !trade.market_id) {
          logTradeSkip(trade.tx_hash ?? null, wallet, trade.market_id ?? null, "missing_trade_fields");
          await recordDecision({
            decision: "SKIPPED",
            reason: "missing_trade_fields",
            source_trade_id: trade.tx_hash ?? null,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id ?? null,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: trade.price ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const amount = toNumber(trade.amount);
        if (amount == null || amount <= 0) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "invalid_amount");
          await recordDecision({
            decision: "SKIPPED",
            reason: "invalid_amount",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: trade.price ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const price = toNumber(trade.price);
        if (price == null || price <= 0 || price >= 1) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "invalid_price");
          await recordDecision({
            decision: "SKIPPED",
            reason: "invalid_price",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: price ?? null,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        if (minPrice != null && price < minPrice) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "below_min_price");
          await recordDecision({
            decision: "SKIPPED",
            reason: "below_min_price",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }
        if (maxPrice != null && price > maxPrice) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "above_max_price");
          await recordDecision({
            decision: "SKIPPED",
            reason: "above_max_price",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side: trade.side ?? null,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const side = (trade.side ?? "BUY").toUpperCase();
        if (side === "SELL" && !allowSells) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "sell_not_allowed");
          await recordDecision({
            decision: "SKIPPED",
            reason: "sell_not_allowed",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        // Filter out blacklisted market categories (esports have been unprofitable)
        if (isBlacklistedMarket(trade.market_slug)) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "blacklisted_market_category");
          await recordDecision({
            decision: "SKIPPED",
            reason: "blacklisted_market_category",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const signalKey = `${wallet}:${trade.market_id}:${(trade.outcome ?? "").toLowerCase()}:${side}`;
        if (copiedSignalKeysThisRun.has(signalKey)) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "duplicate_signal_same_run");
          await recordDecision({
            decision: "SKIPPED",
            reason: "duplicate_signal_same_run",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        // Position cap check - prevent too many concurrent positions from one trader
        const maxOpenPositions = toNumber(traderRaw.max_open_positions) ?? DEFAULT_MAX_OPEN_POSITIONS_PER_TRADER;
        const currentPositionCount = openPositionCountMap.get(wallet) ?? 0;
        if (currentPositionCount >= maxOpenPositions) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "position_cap_reached");
          await recordDecision({
            decision: "SKIPPED",
            reason: "position_cap_reached",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
            current_position_count: currentPositionCount,
            max_open_positions: maxOpenPositions,
          });
          continue;
        }

        // Rank gate — only enforced when max_copyable_rank_30d is explicitly set.
        // Null means "no rank requirement" (manually curated traders).
        const configuredMaxRank = toNumber(traderRaw.max_copyable_rank_30d);
        const maxRank = configuredMaxRank ?? DEFAULT_MAX_COPYABLE_RANK;
        const currentRank = toNumber(ranking?.copyable_rank_30d);
        if (configuredMaxRank !== null && (currentRank == null || currentRank > maxRank)) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "rank_gate");
          await recordDecision({
            decision: "SKIPPED",
            reason: "rank_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
            current_rank: currentRank,
            max_rank: maxRank,
          });
          continue;
        }

        // Rank decay detection - warn if trader has fallen significantly
        const previousRank = toNumber(traderRaw.previous_rank_30d);
        if (previousRank != null && currentRank != null) {
          const rankDrop = currentRank - previousRank;
          if (rankDrop >= RANK_DECAY_WARNING_THRESHOLD) {
            console.warn(`RANK DECAY: ${wallet} dropped from #${previousRank} to #${currentRank} (${rankDrop} spots)`);
            // Log but don't skip - the rank gate above will handle if they've fallen out of range
          }
        }

        // Paper win-rate gate - auto-skip traders with poor paper performance
        const paperStats = paperWinRateMap.get(wallet);
        if (paperStats && paperStats.total >= PAPER_WIN_RATE_MIN_POSITIONS && paperStats.winRate < PAPER_WIN_RATE_MIN) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "paper_win_rate_gate");
          await recordDecision({
            decision: "SKIPPED",
            reason: "paper_win_rate_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
            paper_wins: paperStats.wins,
            paper_losses: paperStats.losses,
            paper_win_rate: paperStats.winRate,
            paper_min_positions: PAPER_WIN_RATE_MIN_POSITIONS,
            paper_min_win_rate: PAPER_WIN_RATE_MIN,
          });
          continue;
        }

        if (
          paperStats &&
          paperStats.total >= PAPER_LOSS_GATE_MIN_POSITIONS &&
          paperStats.realizedPnl <= PAPER_REALIZED_LOSS_GATE_USD
        ) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "paper_realized_loss_gate");
          await recordDecision({
            decision: "SKIPPED",
            reason: "paper_realized_loss_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
            paper_positions: paperStats.total,
            paper_realized_pnl: paperStats.realizedPnl,
            paper_loss_gate_usd: PAPER_REALIZED_LOSS_GATE_USD,
          });
          continue;
        }

        const minRoi = toNumber(traderRaw.min_realized_roi_30d);
        if (
          minRoi != null &&
          (!ranking || toNumber(ranking.realized_roi_30d) == null ||
            toNumber(ranking.realized_roi_30d)! < minRoi)
        ) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "roi_gate");
          await recordDecision({
            decision: "SKIPPED",
            reason: "roi_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const minPl = toNumber(traderRaw.min_realized_pl_30d);
        if (
          minPl != null &&
          (!ranking || toNumber(ranking.realized_pl_30d) == null ||
            toNumber(ranking.realized_pl_30d)! < minPl)
        ) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "pl_gate");
          await recordDecision({
            decision: "SKIPPED",
            reason: "pl_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const minMedian = toNumber(traderRaw.min_median_bet_30d);
        if (
          minMedian != null &&
          (!ranking || toNumber(ranking.median_bet_30d) == null ||
            toNumber(ranking.median_bet_30d)! < minMedian)
        ) {
          logTradeSkip(trade.tx_hash, wallet, trade.market_id, "median_gate");
          await recordDecision({
            decision: "SKIPPED",
            reason: "median_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const minResolvedTrades = toNumber(traderRaw.min_resolved_trades_30d) ??
          DEFAULT_MIN_RESOLVED_TRADES_30D;
        if (
          minResolvedTrades != null &&
          (!ranking || toNumber(ranking.resolved_trades_30d) == null ||
            toNumber(ranking.resolved_trades_30d)! < minResolvedTrades)
        ) {
          logTradeSkip(
            trade.tx_hash,
            wallet,
            trade.market_id,
            "resolved_trades_gate",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: "resolved_trades_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const minConfidence = toNumber(traderRaw.min_confidence_30d) ??
          DEFAULT_MIN_CONFIDENCE_30D;
        if (
          minConfidence != null &&
          (!ranking || toNumber(ranking.confidence_30d) == null ||
            toNumber(ranking.confidence_30d)! < minConfidence)
        ) {
          logTradeSkip(
            trade.tx_hash,
            wallet,
            trade.market_id,
            "confidence_gate",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: "confidence_gate",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const currentTraderExposure = openTraderMap.get(wallet) ?? 0;
        const currentMarketExposure = await getMarketOpenExposure(
          trade.market_id,
        );

        const roiEdge = toNumber(ranking?.realized_roi_30d) ?? 0.10; // default 10% edge if no ranking
        const sizingResult = computeKellyUsdSize({
          sourcePrice: price,
          roiEdge,
          kellyFraction: KELLY_FRACTION,
          minUsd: KELLY_MIN_USD,
          maxUsd: KELLY_MAX_USD,
          equityUsd: portfolioEquityUsd,
          maxTotalExposurePct: portfolioMaxTotalExposurePct,
          marketExposureCapPct: portfolioMarketExposureCapPct,
          maxTraderExposurePct,
          currentOpenExposureTotal: openTotalUsd,
          currentOpenExposureForTrader: currentTraderExposure,
          currentOpenExposureForMarket: currentMarketExposure,
        });

        if (sizingResult.usdSize <= 0) {
          logTradeSkip(
            trade.tx_hash,
            wallet,
            trade.market_id,
            sizingResult.reason ?? "sizing_rejected",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: sizingResult.reason ?? "sizing_rejected",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            usd_size: sizingResult.usdSize,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const usdSize = sizingResult.usdSize;

        const entryPrice = clamp(
          price + (side === "SELL" ? -penalty : penalty),
          0.01,
          0.99,
        );

        if (entryPrice <= 0 || entryPrice >= 1) {
          logTradeSkip(
            trade.tx_hash,
            wallet,
            trade.market_id,
            "entry_price_out_of_bounds",
          );
          await recordDecision({
            decision: "SKIPPED",
            reason: "entry_price_out_of_bounds",
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            entry_price: entryPrice,
            price_penalty: penalty,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            usd_size: usdSize,
            ranking_snapshot: rankingSnapshot,
          });
          continue;
        }

        const configuredCooldownMinutes = toNumber(
          traderRaw.per_trader_cooldown_minutes ?? traderRaw.cooldown_minutes,
        );
        const cooldownMinutes = configuredCooldownMinutes != null &&
            configuredCooldownMinutes > 0
          ? configuredCooldownMinutes
          : DEFAULT_PER_TRADER_COOLDOWN_MINUTES;

        if (tradeTs) {
          const dailyCutoff = new Date(
            tradeTs.getTime() - 24 * 60 * 60 * 1000,
          ).toISOString();
          const { data: recentDayEntries, error: dailyCapError } = await supabase
            .from("paper_positions")
            .select("id")
            .eq("portfolio_id", portfolioId)
            .eq("source_wallet", wallet)
            .eq("market_id", trade.market_id)
            .neq("status", "CANCELED")
            .gte("entry_ts", dailyCutoff)
            .limit(DEFAULT_MAX_ENTRIES_PER_TRADER_MARKET_24H);

          if (dailyCapError) {
            console.warn("Daily trader/market cap lookup failed:", dailyCapError.message);
          } else if (
            recentDayEntries &&
            recentDayEntries.length >= DEFAULT_MAX_ENTRIES_PER_TRADER_MARKET_24H
          ) {
            logTradeSkip(
              trade.tx_hash,
              wallet,
              trade.market_id,
              "trader_market_daily_cap",
            );
            await recordDecision({
              decision: "SKIPPED",
              reason: "trader_market_daily_cap",
              source_trade_id: trade.tx_hash,
              source_wallet: wallet,
              source_trade_ts: trade.timestamp ?? null,
              market_id: trade.market_id,
              market_slug: trade.market_slug ?? null,
              market_title: trade.market_title ?? null,
              outcome: trade.outcome ?? null,
              side,
              source_price: price,
              entry_price: entryPrice,
              price_penalty: penalty,
              sizing_method: SIZING_METHOD,
              fixed_usd_per_trade: fixedUsdPerTrade,
              copy_factor: copyFactor,
              max_trader_exposure_pct: maxTraderExposurePct,
              min_price: minPrice,
              max_price: maxPrice,
              allow_sells: allowSells,
              usd_size: usdSize,
              ranking_snapshot: rankingSnapshot,
            });
            continue;
          }
        }

        if (cooldownMinutes > 0 && tradeTs) {
          const cutoff = new Date(
            tradeTs.getTime() - cooldownMinutes * 60 * 1000,
          ).toISOString();

          const { data: recent, error: recentError } = await supabase
            .from("paper_positions")
            .select("id")
            .eq("portfolio_id", portfolioId)
            .eq("source_wallet", wallet)
            .eq("market_id", trade.market_id)
            .neq("status", "CANCELED")
            .gte("entry_ts", cutoff)
            .limit(1);

          if (recentError) {
            console.warn("Cooldown lookup failed:", recentError.message);
          } else if (recent && recent.length > 0) {
            logTradeSkip(
              trade.tx_hash,
              wallet,
              trade.market_id,
              "cooldown_gate",
            );
            await recordDecision({
              decision: "SKIPPED",
              reason: "cooldown_gate",
              source_trade_id: trade.tx_hash,
              source_wallet: wallet,
              source_trade_ts: trade.timestamp ?? null,
              market_id: trade.market_id,
              market_slug: trade.market_slug ?? null,
              market_title: trade.market_title ?? null,
              outcome: trade.outcome ?? null,
              side,
              source_price: price,
              entry_price: entryPrice,
              price_penalty: penalty,
              sizing_method: SIZING_METHOD,
              fixed_usd_per_trade: fixedUsdPerTrade,
              copy_factor: copyFactor,
              max_trader_exposure_pct: maxTraderExposurePct,
              min_price: minPrice,
              max_price: maxPrice,
              allow_sells: allowSells,
              usd_size: usdSize,
              ranking_snapshot: rankingSnapshot,
            });
            continue;
          }
        }

        const shares = usdSize / entryPrice;
        const row = {
          portfolio_id: portfolioId,
          source_wallet: wallet,
          source_trade_id: trade.tx_hash,
          source_trade_ts: trade.timestamp,
          market_id: trade.market_id,
          market_slug: trade.market_slug ?? null,
          market_title: trade.market_title ?? null,
          outcome: trade.outcome ?? null,
          side,
          source_price: price,
          entry_price: entryPrice,
          price_penalty: penalty,
          copy_factor: copyFactor,
          sizing_method: SIZING_METHOD,
          fixed_usd_per_trade: fixedUsdPerTrade,
          strategy_lane: "copy",
          strategy_tag: "copy_trader",
          execution_type: "market_copy",
          copy_run_id: copyRunId,
          usd_size: usdSize,
          shares,
          status: "OPEN",
          entry_ts: trade.timestamp ?? now.toISOString(),
          updated_at: now.toISOString(),
          // Store rank at entry for post-analysis of rank decay correlation
          rank_at_entry: currentRank,
          roi_at_entry: toNumber(ranking?.realized_roi_30d),
          pl_at_entry: toNumber(ranking?.realized_pl_30d),
        };

        if (!dryRun) {
          const { data: inserted, error: insertError } = await supabase
            .from("paper_positions")
            .upsert(row, {
              onConflict: "source_trade_id",
              ignoreDuplicates: true,
            })
            .select("id");

          if (insertError) {
            console.warn("Insert failed:", insertError.message);
            if (
              !earliestRetryableTradeTs ||
              tradeTs < earliestRetryableTradeTs
            ) {
              earliestRetryableTradeTs = tradeTs;
            }
            logTradeSkip(
              trade.tx_hash,
              wallet,
              trade.market_id,
              "insert_failed",
            );
            await recordDecision({
              decision: "SKIPPED",
              reason: "insert_failed",
              source_trade_id: trade.tx_hash,
              source_wallet: wallet,
              source_trade_ts: trade.timestamp ?? null,
              market_id: trade.market_id,
              market_slug: trade.market_slug ?? null,
              market_title: trade.market_title ?? null,
              outcome: trade.outcome ?? null,
              side,
              source_price: price,
              entry_price: entryPrice,
              price_penalty: penalty,
              sizing_method: SIZING_METHOD,
              fixed_usd_per_trade: fixedUsdPerTrade,
              copy_factor: copyFactor,
              max_trader_exposure_pct: maxTraderExposurePct,
              min_price: minPrice,
              max_price: maxPrice,
              allow_sells: allowSells,
              usd_size: usdSize,
              shares,
              ranking_snapshot: rankingSnapshot,
            });
            continue;
          }

          if (inserted && inserted.length > 0) {
            summary.positions_created += 1;
            copiedSignalKeysThisRun.add(signalKey);
            openTotalUsd += usdSize;
            openTraderMap.set(wallet, currentTraderExposure + usdSize);
            openMarketMap.set(trade.market_id, currentMarketExposure + usdSize);
            // Update position count for this trader
            openPositionCountMap.set(wallet, (openPositionCountMap.get(wallet) ?? 0) + 1);
            await recordDecision({
              decision: "COPIED",
              reason: null,
              source_trade_id: trade.tx_hash,
              source_wallet: wallet,
              source_trade_ts: trade.timestamp ?? null,
              market_id: trade.market_id,
              market_slug: trade.market_slug ?? null,
              market_title: trade.market_title ?? null,
              outcome: trade.outcome ?? null,
              side,
              source_price: price,
              entry_price: entryPrice,
              price_penalty: penalty,
              sizing_method: SIZING_METHOD,
              fixed_usd_per_trade: fixedUsdPerTrade,
              copy_factor: copyFactor,
              max_trader_exposure_pct: maxTraderExposurePct,
              min_price: minPrice,
              max_price: maxPrice,
              allow_sells: allowSells,
              usd_size: usdSize,
              shares,
              ranking_snapshot: rankingSnapshot,
            });
          } else {
            logTradeSkip(
              trade.tx_hash,
              wallet,
              trade.market_id,
              "duplicate_trade",
            );
            await recordDecision({
              decision: "SKIPPED",
              reason: "duplicate_trade",
              source_trade_id: trade.tx_hash,
              source_wallet: wallet,
              source_trade_ts: trade.timestamp ?? null,
              market_id: trade.market_id,
              market_slug: trade.market_slug ?? null,
              market_title: trade.market_title ?? null,
              outcome: trade.outcome ?? null,
              side,
              source_price: price,
              entry_price: entryPrice,
              price_penalty: penalty,
              sizing_method: SIZING_METHOD,
              fixed_usd_per_trade: fixedUsdPerTrade,
              copy_factor: copyFactor,
              max_trader_exposure_pct: maxTraderExposurePct,
              min_price: minPrice,
              max_price: maxPrice,
              allow_sells: allowSells,
              usd_size: usdSize,
              shares,
              ranking_snapshot: rankingSnapshot,
            });
          }
        } else {
          summary.positions_created += 1;
          copiedSignalKeysThisRun.add(signalKey);
          openTotalUsd += usdSize;
          openTraderMap.set(wallet, currentTraderExposure + usdSize);
          openMarketMap.set(trade.market_id, currentMarketExposure + usdSize);
          // Update position count for this trader (dry run)
          openPositionCountMap.set(wallet, (openPositionCountMap.get(wallet) ?? 0) + 1);
          await recordDecision({
            decision: "COPIED",
            reason: null,
            source_trade_id: trade.tx_hash,
            source_wallet: wallet,
            source_trade_ts: trade.timestamp ?? null,
            market_id: trade.market_id,
            market_slug: trade.market_slug ?? null,
            market_title: trade.market_title ?? null,
            outcome: trade.outcome ?? null,
            side,
            source_price: price,
            entry_price: entryPrice,
            price_penalty: penalty,
            sizing_method: SIZING_METHOD,
            fixed_usd_per_trade: fixedUsdPerTrade,
            copy_factor: copyFactor,
            max_trader_exposure_pct: maxTraderExposurePct,
            min_price: minPrice,
            max_price: maxPrice,
            allow_sells: allowSells,
            usd_size: usdSize,
            shares,
            ranking_snapshot: rankingSnapshot,
          });
        }
      }

      if (!dryRun && maxSeen && maxSeen > lastSeen) {
        let safeCursor = maxSeen;
        if (earliestRetryableTradeTs) {
          const rewind = new Date(earliestRetryableTradeTs.getTime() - 1000);
          if (rewind < safeCursor) {
            safeCursor = rewind;
          }
          console.warn(
            `Retryable copy failure for ${wallet}; rewinding cursor to ${safeCursor.toISOString()}`,
          );
        }

        if (safeCursor <= lastSeen) {
          continue;
        }

        const { error: updateError } = await supabase
          .from("copy_state")
          .upsert({
            wallet,
            last_seen_ts: safeCursor.toISOString(),
            updated_at: now.toISOString(),
          });

        if (updateError) {
          console.warn("Failed to update copy_state:", updateError.message);
        } else {
          summary.cursors_updated += 1;
        }
      }
    }

    if (!dryRun && copyRunId) {
      const { error: runUpdateError } = await supabase
        .from("copy_runs")
        .update({
          finished_at: new Date().toISOString(),
          trades_scanned: summary.trades_scanned,
          positions_created: summary.positions_created,
          skipped: summary.skipped,
          skip_reasons: summary.skip_reasons,
        })
        .eq("id", copyRunId);
      if (runUpdateError) {
        console.warn(
          "Failed to update copy_runs summary:",
          runUpdateError.message,
        );
      }
    }

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-paper-copy error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error?.message || error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
