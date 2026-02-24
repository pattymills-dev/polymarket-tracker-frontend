import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "supabase";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function safeNumber(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type PolymarketUrlInput = {
  eventSlug?: string | null;
  marketSlug?: string | null;
};

// Build Polymarket URL from eventSlug or market slug - handles sports bets and regular events
function buildPolymarketUrl(input: PolymarketUrlInput): string | null {
  const eventSlug = cleanString(input.eventSlug);
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`;
  }

  const slug = cleanString(input.marketSlug);
  if (!slug) return null;

  // Check if it's a sports bet (has league prefix like nba-, nhl-, cbb-, epl-, etc.)
  const sportsMatch = slug.match(/^(nba|nhl|mlb|nfl|cbb|epl|bun|mls|wta|atp)-(.+)-(\d{4}-\d{2}-\d{2})(?:-.+)?$/i);
  if (sportsMatch) {
    const [, league, teams, date] = sportsMatch;
    // Return sports game page URL
    return `https://polymarket.com/sports/${league.toLowerCase()}/games/week/1/${league.toLowerCase()}-${teams}-${date}`;
  }

  // For non-sports, strip any suffix after the date
  const cleanSlug = slug.replace(/(-\d{4}-\d{2}-\d{2})-[a-z0-9]+$/i, '$1');
  return `https://polymarket.com/event/${cleanSlug}`;
}

type TradeMeta = {
  eventSlug?: string | null;
  traderName?: string | null;
  traderPseudonym?: string | null;
  traderAddress?: string | null;
};

function formatTraderLine(meta: TradeMeta | null): string {
  if (!meta) return "";
  const address = cleanString(meta.traderAddress);
  const name = cleanString(meta.traderPseudonym) ?? cleanString(meta.traderName);

  if (!address && !name) return "";
  if (name && address) return `\n👤 Trader: ${name} (${address})`;
  return `\n👤 Trader: ${name ?? address}`;
}

// Send Telegram notification for important alerts
async function sendTelegramAlert(alert: any, meta: TradeMeta | null): Promise<void> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    console.log("Telegram not configured, skipping notification");
    return;
  }

  try {
    const polymarketUrl = buildPolymarketUrl({
      eventSlug: meta?.eventSlug ?? null,
      marketSlug: alert.market_slug,
    });
    const traderLine = formatTraderLine(meta);

    const polymarketLink = polymarketUrl
      ? `\n\n🔗 <a href="${polymarketUrl}">View on Polymarket</a>`
      : '';

    const text = `${alert.message}${traderLine}${polymarketLink}`;

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Telegram API error:", error);
    } else {
      console.log(`Telegram notification sent for ${alert.type} alert`);
    }
  } catch (error) {
    console.error("Failed to send Telegram notification:", error);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestUrl = new URL(req.url);
    const diagnosticsEnabled =
      requestUrl.searchParams.get("diagnostics") === "1";
    const debugTrader = requestUrl.searchParams.get("debug_trader");
    const mode = requestUrl.searchParams.get("mode");
    const maxPagesParam = parseInt(requestUrl.searchParams.get("max_pages") || "", 10);
    const pageSizeParam = parseInt(requestUrl.searchParams.get("page_size") || "", 10);
    const minTradeSizeParam = parseFloat(requestUrl.searchParams.get("min_trade_size") || "");
    const startOffsetParam = parseInt(requestUrl.searchParams.get("start_offset") || "0", 10);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    // Debug mode: return canonical ranking + eligibility flags for a trader.
    if (mode === "debug" && debugTrader) {
      const addr = String(debugTrader).toLowerCase();
      const { data: ranking } = await supabase
        .from("trader_rankings")
        .select("*")
        .eq("trader_address", addr)
        .maybeSingle();

      const { data: lastAlert } = await supabase
        .from("alerts")
        .select("type, alert_source, created_at, message")
        .eq("trader_address", addr)
        .order("created_at", { ascending: false })
        .limit(1);

      const copyableReasons: string[] = [];
      if (!ranking?.copyable_rank_30d || ranking.copyable_rank_30d > 50) {
        copyableReasons.push("rank");
      }
      if ((safeNumber(ranking?.realized_roi_30d) ?? 0) < 0.10) {
        copyableReasons.push("roi");
      }
      if ((safeNumber(ranking?.realized_pl_30d) ?? 0) < 1000) {
        copyableReasons.push("pl");
      }
      if ((safeNumber(ranking?.median_bet_30d) ?? 0) < 250) {
        copyableReasons.push("median_bet");
      }

      const computedAt = ranking?.computed_at ? new Date(ranking.computed_at).getTime() : null;
      const staleMs = 2 * 60 * 60 * 1000;
      const isStale = !computedAt || (Date.now() - computedAt) > staleMs;
      if (isStale) copyableReasons.push("stale_ranking");

      return new Response(
        JSON.stringify({
          trader: addr,
          ranking,
          copyableEligible: copyableReasons.length === 0,
          copyableReasons,
          lastAlert: lastAlert?.[0] ?? null,
          snapshotAt: ranking?.computed_at ?? null
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log("Fetching trades from Polymarket Data API...");

    // Fetch recent trades - optimized for 15-minute intervals
    // Polymarket Data API enforces low limit/offset caps, so we filter server-side.
    const PAGE_SIZE = Number.isFinite(pageSizeParam) && pageSizeParam > 0 ? pageSizeParam : 500;
    const MAX_PAGES = Number.isFinite(maxPagesParam) && maxPagesParam > 0 ? maxPagesParam : 10;  // Stop early if API returns 400/404 (offset cap)
    const START_OFFSET = Number.isFinite(startOffsetParam) && startOffsetParam > 0 ? startOffsetParam : 0;

    // Store ALL trades >= $100 for better position tracking (lowered from $1k)
    const MIN_TRADE_SIZE = Number.isFinite(minTradeSizeParam) && minTradeSizeParam > 0 ? minTradeSizeParam : 100;
    // Copyable trader alert gates (30D) - Balanced for quality + availability
    const COPYABLE_RANK_CUTOFF = 15;          // Top 15 (expanded for availability)
    const MIN_COPYABLE_TRADER_ROI = 0.15;     // 15% realized ROI
    const MIN_COPYABLE_TRADER_PL = 2_500;     // $2.5k realized P/L (lowered)
    const MIN_COPYABLE_MEDIAN_BET = 250;      // $250 median bet (lowered - many good traders use smaller bets)
    const MIN_COPYABLE_RESOLVED_TRADES = 10;  // 10 trades (lowered for availability)
    const MIN_COPYABLE_CONFIDENCE = 1;        // Confidence >= 1 (lowered)
    const MIN_COPYABLE_WIN_RATE = 0.55;       // 55% win rate (lowered slightly)
    const COPYABLE_ALERT_MIN_TRADE_SIZE = 250;
    const COPYABLE_ALERT_COOLDOWN_HOURS = 6;
    const RANKING_STALE_HOURS = 2;
    // Heater-aware dedupe thresholds
    const HEATER_RANK_JUMP_THRESHOLD = 10;   // Re-alert if rank improved by 10+
    const HEATER_SCORE_JUMP_THRESHOLD = 0.05; // Re-alert if score improved by 0.05+

    // Global alert throttles
    const GLOBAL_ALERTS_PER_HOUR = 15; // Increased to accommodate new alert types
    const ISOLATED_CONTACT_MIN_SIZE = 10_000;
    const ISOLATED_CONTACT_EXTREME_MIN = 100_000;

    // New: Position aggregation thresholds for split-trade detection
    const AGGREGATED_POSITION_ALERT_MIN = 50_000;  // Alert if cumulative position >= $50k
    const RAPID_ACCUMULATION_MIN = 20_000;         // Alert if $20k+ in <1 hour
    const DORMANT_WALLET_DAYS = 180;               // Consider wallet dormant if 180+ days inactive
    const DORMANT_WALLET_ANY_TRADE_ALERT = true;   // Alert on ANY trade from dormant wallet
    // Hard cut: exclude extreme entry prices entirely (regardless of ROI).
    // This removes "penny stackers" in both directions (>=95c and <=5c).
    const ALERT_PRICE_MAX = 0.95;
    const ALERT_PRICE_MIN = 0.05;

    let fetchedTotal = 0;
    let upsertedTrades = 0;
    let insertedAlerts = 0;
    const tradeMetaByHash = new Map<string, TradeMeta>();
    let pageCount = 0;
    let stoppedByEmptyPage = false;
    let hitMaxPages = false;

    let rawMissingAddress = 0;
    let rawMissingTraderName = 0;
    let rawWithEventSlug = 0;
    let rawMissingMarketSlug = 0;

    let droppedMissingTxHash = 0;
    let droppedMissingMarketId = 0;
    let droppedMissingAddress = 0;
    let droppedMissingTimestamp = 0;
    let droppedInvalidAmount = 0;
    let droppedBelowMin = 0;
    let suppressedExtremePriceAlerts = 0;
    let dedupedCount = 0;

    console.log(
      JSON.stringify({
        event: "fetch_trades_config",
        page_size: PAGE_SIZE,
        max_pages: MAX_PAGES,
        start_offset: START_OFFSET,
        min_trade_size: MIN_TRADE_SIZE,
      }),
    );

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = START_OFFSET + page * PAGE_SIZE;
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        takerOnly: "false",              // include maker trades
        filterType: "CASH",              // filter by cash amount
        filterAmount: String(MIN_TRADE_SIZE),
      });
      const url = `https://data-api.polymarket.com/trades?${params.toString()}`;

      const response = await fetch(url);
      if (!response.ok) {
        // Polymarket data API sometimes returns 400 at high offsets.
        // Treat as end-of-data instead of failing the whole job.
        if (response.status === 400 || response.status === 404) {
          console.warn(`Data API returned ${response.status} for ${url}. Stopping pagination.`);
          stoppedByEmptyPage = true;
          break;
        }
        throw new Error(`Data API returned ${response.status} for ${url}`);
      }

      const trades = await response.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        console.log(`No trades returned at offset=${offset}. Stopping.`);
        stoppedByEmptyPage = true;
        break;
      }

      fetchedTotal += trades.length;
      pageCount += 1;

      // 1) Map into your DB schema
      const rowsRaw = trades.map((t: any) => {
        const size = safeNumber(t.size);
        const price = safeNumber(t.price);
        const ts = safeNumber(t.timestamp);
        const txHash = t.transactionHash ?? null;

        // "Cash" amount ≈ size * price
        const amount = size != null && price != null ? size * price : null;

        // Polymarket API: side is "BUY" or "SELL" (or "buy"/"sell")
        const side = t.side ? t.side.toUpperCase() : null;

        if (!t.proxyWallet) {
          rawMissingAddress += 1;
        }
        if (!t.pseudonym && !t.name) {
          rawMissingTraderName += 1;
        }
        if (t.eventSlug) {
          rawWithEventSlug += 1;
        }
        if (!t.slug) {
          rawMissingMarketSlug += 1;
        }

        if (txHash) {
          tradeMetaByHash.set(txHash, {
            eventSlug: t.eventSlug ?? null,
            traderName: t.name ?? null,
            traderPseudonym: t.pseudonym ?? null,
            traderAddress: t.proxyWallet ?? null,
          });
        }

        return {
          tx_hash: txHash,
          market_id: t.conditionId ?? null, // use conditionId
          market_slug: t.slug ?? null,
          market_title: t.title ?? null,
          trader_address: t.proxyWallet ?? null,
          outcome: t.outcome ?? null,
          side,
          amount,
          price,
          timestamp: ts != null ? new Date(ts * 1000).toISOString() : null,
        };
      });

      // 2) Filter out invalid rows AND trades below $5k threshold
      // Note: each dropped counter is mutually exclusive based on first failure.
      const rowsFiltered: any[] = [];
      for (const r of rowsRaw) {
        if (!r.tx_hash) {
          droppedMissingTxHash += 1;
          continue;
        }
        if (!r.market_id) {
          droppedMissingMarketId += 1;
          continue;
        }
        if (!r.trader_address) {
          droppedMissingAddress += 1;
          continue;
        }
        if (!r.timestamp) {
          droppedMissingTimestamp += 1;
          continue;
        }
        if (typeof r.amount !== "number") {
          droppedInvalidAmount += 1;
          continue;
        }
        if (r.amount < MIN_TRADE_SIZE) {
          droppedBelowMin += 1;
          continue;
        }
        rowsFiltered.push(r);
      }

      // 3) Dedupe by tx_hash within this batch to avoid:
      //    "ON CONFLICT DO UPDATE command cannot affect row a second time"
      const seen = new Set<string>();
      const rows: any[] = [];
      for (const r of rowsFiltered) {
        if (seen.has(r.tx_hash)) continue;
        seen.add(r.tx_hash);
        rows.push(r);
      }
      dedupedCount += rowsFiltered.length - rows.length;

      console.log(
        `Page ${page + 1}/${MAX_PAGES} offset=${offset}: raw=${rowsRaw.length} filtered_min=${rowsFiltered.length} deduped=${rows.length}`,
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

      // Ensure markets table includes any new markets from these trades
      const marketMap = new Map<string, any>();
      for (const r of rows) {
        if (!r.market_id) continue;
        const marketRow: any = { id: r.market_id };
        if (r.market_title || r.market_slug) {
          marketRow.question = r.market_title || r.market_slug;
        }
        if (r.market_slug) {
          marketRow.slug = r.market_slug;
        }
        marketMap.set(r.market_id, marketRow);
      }

      if (marketMap.size > 0) {
        const marketRows = Array.from(marketMap.values());
        const { error: marketError } = await supabase
          .from("markets")
          .upsert(marketRows, { onConflict: "id" });
        if (marketError) {
          console.error("Market upsert error:", marketError);
        }
      }

      // Update market_prices table for paper trading unrealized P/L calculations
      const priceUpdates = new Map<string, { market_id: string; outcome: string; price: number; timestamp: string }>();
      for (const r of rows) {
        if (!r.market_id || !r.outcome || typeof r.price !== 'number' || r.price <= 0 || r.price >= 1) continue;
        const key = `${r.market_id}:${r.outcome}`;
        const existing = priceUpdates.get(key);
        // Keep the most recent price per market/outcome
        if (!existing || r.timestamp > existing.timestamp) {
          priceUpdates.set(key, { market_id: r.market_id, outcome: r.outcome, price: r.price, timestamp: r.timestamp });
        }
      }

      if (priceUpdates.size > 0) {
        const priceRows = Array.from(priceUpdates.values()).map(p => ({
          market_id: p.market_id,
          outcome: p.outcome,
          price: p.price,
          updated_at: p.timestamp,
        }));
        const { error: priceError } = await supabase
          .from("market_prices")
          .upsert(priceRows, { onConflict: "market_id,outcome" });
        if (priceError) {
          console.error("Market prices upsert error:", priceError);
        }
      }

      // Fetch canonical rankings for alerts (single source of truth)
      const { data: copyableRankings } = await supabase
        .from("trader_rankings")
        .select("trader_address, copyable_rank_30d, copy_score_30d, realized_roi_30d, realized_pl_30d, median_bet_30d, wins_30d, losses_30d, resolved_trades_30d, confidence_30d, computed_at")
        .not("copyable_rank_30d", "is", null)
        .lte("copyable_rank_30d", COPYABLE_RANK_CUTOFF);

      const copyableAddresses = new Set((copyableRankings || []).map((t: any) => t.trader_address?.toLowerCase()));
      const copyableMap = new Map((copyableRankings || []).map((t: any) => [t.trader_address?.toLowerCase(), t]));

      // Global alert rate limit (only for alerts that go to Telegram)
      // whale_position alerts are stored but NOT sent to Telegram, so don't count them
      const globalSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentGlobalAlerts } = await supabase
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .gte("created_at", globalSince)
        .in("type", ["copyable", "dormant_whale", "isolated_contact"])
        .not("type", "eq", "whale_position");  // Exclude whale_position from rate limit
      let globalRemaining = Math.max(0, GLOBAL_ALERTS_PER_HOUR - (recentGlobalAlerts || 0));

      // Heater-aware dedupe: fetch recent alerts with rank/score for material-change detection
      const copyableCooldownSince = new Date(Date.now() - COPYABLE_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
      type RecentAlertInfo = { lastRank: number | null; lastScore: number | null; marketIds: Set<string> };
      const recentAlertsByTrader = new Map<string, RecentAlertInfo>();

      if (copyableRankings && copyableRankings.length > 0) {
        const addrList = (copyableRankings || [])
          .map((t: any) => t.trader_address)
          .filter(Boolean);
        if (addrList.length > 0) {
          const { data: recentCopyableAlerts } = await supabase
            .from("alerts")
            .select("trader_address, market_id, rank_at_alert, score_at_alert, created_at")
            .eq("alert_source", "copyable")
            .gte("created_at", copyableCooldownSince)
            .in("trader_address", addrList);

          for (const alert of (recentCopyableAlerts || [])) {
            const addr = String(alert.trader_address).toLowerCase();
            if (!recentAlertsByTrader.has(addr)) {
              recentAlertsByTrader.set(addr, { lastRank: null, lastScore: null, marketIds: new Set() });
            }
            const info = recentAlertsByTrader.get(addr)!;
            // Track the most recent rank/score
            if (alert.rank_at_alert != null) info.lastRank = alert.rank_at_alert;
            if (alert.score_at_alert != null) info.lastScore = alert.score_at_alert;
            if (alert.market_id) info.marketIds.add(alert.market_id);
          }
        }
      }

      // Isolated contact dedupe: track recently alerted markets
      const isolatedContactSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: recentIsolatedAlerts } = await supabase
        .from("alerts")
        .select("market_id, trader_address")
        .eq("alert_source", "isolated_contact")
        .gte("created_at", isolatedContactSince);
      const recentIsolatedMarkets = new Set((recentIsolatedAlerts || []).map((a: any) => a.market_id));
      const recentIsolatedTraders = new Set((recentIsolatedAlerts || []).map((a: any) => a.trader_address?.toLowerCase()));

      // NEW: Update position aggregation and wallet activity
      // Optimized: Only process trades >= $500 to reduce API calls
      const dormantWalletAlerts: Array<{ trade: any; dormantDays: number; betDirection: string }> = [];
      const aggregatedPositionAlerts: Array<{ trade: any; totalAmount: number; totalTrades: number; triggerType: string; reason: string; betDirection: string }> = [];

      // Batch position updates - only for trades >= $500 to reduce load
      const positionUpdateTrades = rows.filter(r => r.trader_address && r.market_id && (r.amount || 0) >= 500);

      // Process in smaller batches to avoid timeouts
      const BATCH_SIZE = 50;
      for (let i = 0; i < positionUpdateTrades.length; i += BATCH_SIZE) {
        const batch = positionUpdateTrades.slice(i, i + BATCH_SIZE);

        // Process batch in parallel
        await Promise.all(batch.map(async (r) => {
          // Update position aggregation
          try {
            await supabase.rpc('update_trader_market_position', {
              p_trader_address: r.trader_address,
              p_market_id: r.market_id,
              p_market_title: r.market_title,
              p_market_slug: r.market_slug,
              p_amount: r.amount || 0,
              p_price: r.price || 0,
              p_outcome: r.outcome,
              p_side: r.side,
              p_timestamp: r.timestamp,
            });
          } catch (err) {
            // Silent fail for position tracking
          }

          // Update wallet activity and check for dormancy
          try {
            const { data: walletResult } = await supabase.rpc('update_wallet_activity', {
              p_trader_address: r.trader_address,
              p_timestamp: r.timestamp,
              p_amount: r.amount || 0,
            });

            // Check if this is a dormant wallet reactivation
            if (walletResult && walletResult[0]?.was_dormant && walletResult[0]?.dormant_days_count >= DORMANT_WALLET_DAYS) {
              const betDirection = r.outcome ? `${r.side || 'BUY'} ${r.outcome}${r.price ? ` @ ${Math.round(r.price * 100)}¢` : ''}` : '';
              dormantWalletAlerts.push({
                trade: r,
                dormantDays: walletResult[0].dormant_days_count,
                betDirection,
              });
              console.log(JSON.stringify({
                event: 'dormant_wallet_detected',
                trader_address: r.trader_address,
                dormant_days: walletResult[0].dormant_days_count,
                amount: r.amount,
                market: r.market_title,
              }));
            }
          } catch (err) {
            // Silent fail
          }

          // Check for aggregated position triggers (only for trades >= $1k)
          if ((r.amount || 0) >= 1000) {
            try {
              const { data: triggerResult } = await supabase.rpc('check_isolated_contact_triggers', {
                p_trader_address: r.trader_address,
                p_market_id: r.market_id,
                p_amount: r.amount || 0,
                p_timestamp: r.timestamp,
              });

              if (triggerResult && triggerResult[0]) {
                const trigger = triggerResult[0];
                const betDirection = r.outcome ? `${r.side || 'BUY'} ${r.outcome}${r.price ? ` @ ${Math.round(r.price * 100)}¢` : ''}` : '';
                aggregatedPositionAlerts.push({
                  trade: r,
                  totalAmount: trigger.position_total,
                  totalTrades: trigger.position_trades,
                  triggerType: trigger.trigger_type,
                  reason: trigger.trigger_reason,
                  betDirection,
                });
                console.log(JSON.stringify({
                  event: 'aggregated_position_trigger',
                  trigger_type: trigger.trigger_type,
                  trader_address: r.trader_address,
                  position_total: trigger.position_total,
                }));
              }
            } catch (err) {
              // Silent fail
            }
          }
        }));
      }

      // Batch check for Isolated Contact - collect candidates first, then check in one query
      // A trade is "isolated contact" if:
      // 1. Trader is rare (< 5 trades in last 30 days)
      // 2. Market is thin (< 10 trades in last 24h)
      // 3. Trade is outsized (> 2x avg trade size for that market)
      const isolatedContactCandidates: Array<{
        trade: any;
        betDirection: string;
      }> = [];

      // Create alerts for:
      // 1. High ROI / Copyable traders (30D)
      // 2. Isolated Contact: rare trader + thin market + outsized trade
      const alertRows: any[] = [];

      for (const r of rows) {
        if (typeof r.amount !== "number") continue;

        const traderLower = r.trader_address?.toLowerCase();
        const priceNum = safeNumber(r.price);
        const isExtremePrice =
          priceNum != null &&
          (priceNum >= ALERT_PRICE_MAX || priceNum <= ALERT_PRICE_MIN);
        const isCopyable = copyableAddresses.has(traderLower);
        const copyableInfo = copyableMap.get(traderLower);

        // Format bet direction for display (e.g., "BUY Yes @ 65¢" or "SELL No @ 35¢")
        const betDirection = r.outcome ? `${r.side || 'BUY'} ${r.outcome}${r.price ? ` @ ${Math.round(r.price * 100)}¢` : ''}` : '';

        // Format resolved record (e.g., "12-3" for 12 wins, 3 losses)
        const formatRecord = (info: any) => {
          if (!info) return '';
          const wins = info.wins || 0;
          const losses = info.losses || 0;
          return ` [${wins}-${losses}]`;
        };

        // Copyable alert (30D) with heater-aware dedupe
        if (isCopyable && r.amount >= COPYABLE_ALERT_MIN_TRADE_SIZE && globalRemaining > 0) {
          const rank = safeNumber(copyableInfo?.copyable_rank_30d) || 0;
          const score = safeNumber(copyableInfo?.copy_score_30d) || 0;
          const copyableTraderRoi = safeNumber(copyableInfo?.realized_roi_30d);
          const copyableTraderPl = safeNumber(copyableInfo?.realized_pl_30d);
          const copyableMedian = safeNumber(copyableInfo?.median_bet_30d);
          const resolvedTrades = safeNumber(copyableInfo?.resolved_trades_30d) || 0;
          const confidence = safeNumber(copyableInfo?.confidence_30d) || 0;
          const wins = copyableInfo?.wins_30d || 0;
          const losses = copyableInfo?.losses_30d || 0;
          const computedAt = copyableInfo?.computed_at ? new Date(copyableInfo.computed_at).getTime() : null;
          const snapshotAgeHours = computedAt ? (Date.now() - computedAt) / 3600000 : null;

          // Debug logging for alert decisions
          const logDecision = (outcome: string, reason?: string) => {
            console.log(JSON.stringify({
              event: 'alert_decision',
              trader_address: traderLower,
              trade_hash: r.tx_hash,
              alert_type: outcome === 'sent' ? 'copyable' : 'skipped',
              gating: {
                rank, roi: copyableTraderRoi, pl: copyableTraderPl, median_bet: copyableMedian,
                resolved_trades: resolvedTrades, confidence,
                is_extreme_price: isExtremePrice,
                trade_amount: r.amount,
              },
              snapshot_age_hours: snapshotAgeHours,
              outcome,
              reason,
            }));
          };

          // Gate 1: Extreme price filter
          if (isExtremePrice) {
            suppressedExtremePriceAlerts += 1;
            logDecision('skipped_extreme_price');
            continue;
          }

          // Gate 2: Stale ranking check
          const staleMs = RANKING_STALE_HOURS * 60 * 60 * 1000;
          if (!computedAt || (Date.now() - computedAt) > staleMs) {
            logDecision('skipped_stale', `Snapshot age: ${snapshotAgeHours?.toFixed(1)}h`);
            continue;
          }

          // Gate 3: Evidence gate (15 trades OR confidence >= 2)
          const hasEvidence = resolvedTrades >= MIN_COPYABLE_RESOLVED_TRADES || confidence >= MIN_COPYABLE_CONFIDENCE;
          if (!hasEvidence) {
            logDecision('skipped_evidence', `resolved=${resolvedTrades}, confidence=${confidence}`);
            continue;
          }

          // Gate 4: ROI, P/L, Median bet thresholds
          if (
            copyableTraderRoi == null || copyableTraderRoi < MIN_COPYABLE_TRADER_ROI ||
            copyableTraderPl == null || copyableTraderPl < MIN_COPYABLE_TRADER_PL ||
            copyableMedian == null || copyableMedian < MIN_COPYABLE_MEDIAN_BET
          ) {
            logDecision('skipped_threshold', `roi=${copyableTraderRoi}, pl=${copyableTraderPl}, median=${copyableMedian}`);
            continue;
          }

          // Gate 5: Win rate check (60% minimum for consistency)
          const winRate = wins / (wins + losses);
          if (!Number.isFinite(winRate) || winRate < MIN_COPYABLE_WIN_RATE) {
            logDecision('skipped_win_rate', `winRate=${(winRate * 100).toFixed(1)}%, required=${MIN_COPYABLE_WIN_RATE * 100}%`);
            continue;
          }

          // Heater-aware dedupe: check for material changes
          const recentInfo = recentAlertsByTrader.get(traderLower);
          if (recentInfo) {
            const isNewMarket = !recentInfo.marketIds.has(r.market_id);
            const isSizeSpike = r.amount >= 2 * (copyableMedian || 0);
            const isRankJump = recentInfo.lastRank != null && (recentInfo.lastRank - rank) >= HEATER_RANK_JUMP_THRESHOLD;
            const isScoreJump = recentInfo.lastScore != null && (score - recentInfo.lastScore) >= HEATER_SCORE_JUMP_THRESHOLD;

            const hasMaterialChange = isNewMarket || isSizeSpike || isRankJump || isScoreJump;

            if (!hasMaterialChange) {
              logDecision('skipped_cooldown', `No material change: newMarket=${isNewMarket}, sizeSpike=${isSizeSpike}, rankJump=${isRankJump}, scoreJump=${isScoreJump}`);
              continue;
            }
            // Log what triggered the re-alert
            console.log(JSON.stringify({
              event: 'heater_trigger',
              trader_address: traderLower,
              triggers: { isNewMarket, isSizeSpike, isRankJump, isScoreJump },
              current: { rank, score, amount: r.amount },
              previous: { rank: recentInfo.lastRank, score: recentInfo.lastScore },
            }));
          }

          // Build alert message with confidence dots
          const record = `${wins}-${losses}`;
          const winRatePct = Math.round(winRate * 100);
          const confidenceDots = confidence >= 3 ? '●●●' : confidence >= 2 ? '●●○' : confidence >= 1 ? '●○○' : '○○○';
          const roiPct = Math.round(copyableTraderRoi * 100);
          const plText = Math.round(copyableTraderPl).toLocaleString();

          alertRows.push({
            type: "copyable",
            alert_source: "copyable",
            trade_hash: r.tx_hash,
            trader_address: r.trader_address,
            market_id: r.market_id,
            market_title: r.market_title,
            market_slug: r.market_slug,
            outcome: r.outcome,
            side: r.side || 'BUY',
            price: r.price,
            amount: r.amount,
            rank_at_alert: rank,
            score_at_alert: score,
            message: `🎯 ELITE TRADER #${rank} (30D) ${confidenceDots}\n[${record}] ${winRatePct}% Win | ROI ${roiPct}% | P/L $${plText}\n$${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id}`,
            sent: false,
          });
          globalRemaining -= 1;
        }

        // Collect candidates for Isolated Contact (will batch check after loop)
        if (globalRemaining > 0 && !isCopyable) {
          const isExtreme = isExtremePrice;
          const minIsolated = isExtreme ? ISOLATED_CONTACT_EXTREME_MIN : ISOLATED_CONTACT_MIN_SIZE;
          if (r.amount >= minIsolated) {
            isolatedContactCandidates.push({ trade: r, betDirection });
          }
        }

        // TAIL RISK: Large bet at extreme price (<10¢ or >90¢) — any trader, any status
        // This DELIBERATELY triggers on extreme prices (the opposite of copyable alerts which SUPPRESS them)
        if (globalRemaining > 0 && r.amount >= 5000 && priceNum != null) {
          if (priceNum < 0.10 || priceNum > 0.90) {
            alertRows.push({
              type: "tail_risk",
              alert_source: "tail_risk",
              trade_hash: r.tx_hash,
              trader_address: r.trader_address,
              market_id: r.market_id,
              market_title: r.market_title,
              market_slug: r.market_slug,
              outcome: r.outcome,
              side: r.side || 'BUY',
              price: r.price,
              amount: r.amount,
              message: `🔥 TAIL RISK: $${Math.round(r.amount).toLocaleString()} ${betDirection} at ${Math.round(priceNum * 100)}¢ on ${r.market_title || r.market_id}`,
              sent: false,
            });
            globalRemaining -= 1;
          }
        }
      }

      // Batch check Isolated Contact candidates with a single RPC call
      if (isolatedContactCandidates.length > 0) {
        try {
          const candidateData = isolatedContactCandidates.map(c => ({
            trader_address: c.trade.trader_address,
            market_id: c.trade.market_id,
            trade_size: c.trade.amount
          }));

          const { data: isolatedResults } = await supabase.rpc('check_isolated_contacts_batch', {
            p_candidates: candidateData
          });

          if (isolatedResults && Array.isArray(isolatedResults)) {
            for (const result of isolatedResults) {
              if (result.is_isolated) {
                const candidate = isolatedContactCandidates.find(
                  c => c.trade.trader_address === result.trader_address &&
                       c.trade.market_id === result.market_id
                );
                if (candidate && globalRemaining > 0) {
                  const r = candidate.trade;

                  // Isolated contact dedupe: max 1 alert per market per hour
                  if (recentIsolatedMarkets.has(r.market_id)) {
                    console.log(JSON.stringify({
                      event: 'alert_decision',
                      trader_address: r.trader_address,
                      trade_hash: r.tx_hash,
                      alert_type: 'isolated_contact',
                      outcome: 'skipped_market_dedupe',
                      reason: `Market ${r.market_id} already had isolated contact alert in last hour`,
                    }));
                    continue;
                  }

                  const reason = `Low activity + thin market + outsized bet`;
                  alertRows.push({
                    type: "isolated_contact",
                    alert_source: "isolated_contact",
                    trade_hash: r.tx_hash,
                    trader_address: r.trader_address,
                    market_id: r.market_id,
                    market_title: r.market_title,
                    market_slug: r.market_slug,
                    outcome: r.outcome,
                    side: r.side || 'BUY',
                    price: r.price,
                    amount: r.amount,
                    message: `ISOLATED CONTACT: ${reason}: $${Math.round(r.amount).toLocaleString()} ${candidate.betDirection} on ${r.market_title || r.market_id}`,
                    sent: false,
                  });

                  // Add to set to prevent duplicate alerts within this batch
                  recentIsolatedMarkets.add(r.market_id);

                  console.log(JSON.stringify({
                    event: 'alert_decision',
                    trader_address: r.trader_address,
                    trade_hash: r.tx_hash,
                    alert_type: 'isolated_contact',
                    outcome: 'sent',
                    market_id: r.market_id,
                    amount: r.amount,
                  }));

                  globalRemaining -= 1;
                }
              }
            }
          }
        } catch (error) {
          console.error('Error batch checking Isolated Contacts:', error);
        }
      }

      // NEW: Process dormant wallet alerts (any trade from wallet inactive 180+ days)
      // These are HIGH PRIORITY - potential insider signal, always send to Telegram
      for (const dwAlert of dormantWalletAlerts) {
        if (globalRemaining <= 0) break;

        const r = dwAlert.trade;
        const traderLower = r.trader_address?.toLowerCase();

        // Dedupe: max 1 alert per trader per hour for dormant wallet
        if (recentIsolatedTraders.has(traderLower)) {
          console.log(JSON.stringify({
            event: 'alert_decision',
            trader_address: r.trader_address,
            alert_type: 'dormant_wallet',
            outcome: 'skipped_trader_dedupe',
            reason: `Trader ${r.trader_address} already had isolated contact alert in last hour`,
          }));
          continue;
        }

        alertRows.push({
          type: "dormant_whale",  // Distinct type for Telegram routing
          alert_source: "isolated_contact",
          trade_hash: r.tx_hash,
          trader_address: r.trader_address,
          market_id: r.market_id,
          market_title: r.market_title,
          market_slug: r.market_slug,
          outcome: r.outcome,
          side: r.side || 'BUY',
          price: r.price,
          amount: r.amount,
          message: `🚨 DORMANT WHALE: Wallet inactive for ${dwAlert.dormantDays.toLocaleString()} days just placed $${Math.round(r.amount).toLocaleString()} ${dwAlert.betDirection} on ${r.market_title || r.market_id}`,
          sent: false,
        });

        recentIsolatedTraders.add(traderLower);
        globalRemaining -= 1;

        console.log(JSON.stringify({
          event: 'alert_decision',
          trader_address: r.trader_address,
          trade_hash: r.tx_hash,
          alert_type: 'dormant_whale',
          outcome: 'sent',
          dormant_days: dwAlert.dormantDays,
          amount: r.amount,
        }));
      }

      // NEW: Process aggregated position alerts (split-trade whale detection)
      // These are STORED in DB only - NOT sent to Telegram (too spammy, user can view on website)
      const alertedPositions = new Set<string>(); // Dedupe by trader+market combo
      for (const apAlert of aggregatedPositionAlerts) {
        // Skip dormant_whale here - already handled above with Telegram priority
        if (apAlert.triggerType === 'dormant_whale') continue;

        const r = apAlert.trade;
        const positionKey = `${r.trader_address?.toLowerCase()}_${r.market_id}`;

        // Dedupe: max 1 alert per position per hour
        if (alertedPositions.has(positionKey)) continue;
        if (recentIsolatedMarkets.has(r.market_id) && recentIsolatedTraders.has(r.trader_address?.toLowerCase())) {
          continue; // Already alerted this trader+market combo
        }

        const alertEmoji = apAlert.triggerType === 'rapid_accumulation' ? '⚡' : '🐋';

        alertRows.push({
          type: "whale_position",  // Distinct type - NOT routed to Telegram
          alert_source: "isolated_contact",
          trade_hash: r.tx_hash,
          trader_address: r.trader_address,
          market_id: r.market_id,
          market_title: r.market_title,
          market_slug: r.market_slug,
          outcome: r.outcome,
          side: r.side || 'BUY',
          price: r.price,
          amount: apAlert.totalAmount,
          message: `${alertEmoji} WHALE POSITION: ${apAlert.reason} on ${r.market_title || r.market_id}\nLatest: $${Math.round(r.amount).toLocaleString()} ${apAlert.betDirection}`,
          sent: false,
        });

        alertedPositions.add(positionKey);
        recentIsolatedMarkets.add(r.market_id);
        // Don't decrement globalRemaining - these don't count toward Telegram rate limit

        console.log(JSON.stringify({
          event: 'alert_decision',
          trader_address: r.trader_address,
          trade_hash: r.tx_hash,
          alert_type: 'whale_position',
          trigger_type: apAlert.triggerType,
          outcome: 'stored_no_telegram',
          position_total: apAlert.totalAmount,
          position_trades: apAlert.totalTrades,
        }));
      }

      if (alertRows.length) {
        // Use upsert with ignoreDuplicates to prevent duplicate alerts for the same trade
        const { data: insertedData, error: alertError } = await supabase
          .from("alerts")
          .upsert(alertRows, { onConflict: "trade_hash", ignoreDuplicates: true })
          .select('trade_hash, type');

        if (alertError) {
          // Don't fail the whole sync if alerts fail
          console.error("Alert upsert error:", alertError);
        } else {
          const newAlerts = insertedData || [];
          insertedAlerts += newAlerts.length;

          // Only send Telegram for NEWLY inserted alerts (not duplicates)
          if (newAlerts.length > 0) {
            // Build a set of newly inserted trade_hashes
            const insertedHashes = new Set(newAlerts.map((a: any) => a.trade_hash));

            // Send Telegram for:
            // 1. copyable - High ROI traders worth tailing
            // 2. dormant_whale - Potential insider signal (wallet inactive 180+ days)
            // 3. isolated_contact - Rare trader + thin market + outsized bet
            // 4. tail_risk - Large bet at extreme price (<10¢ or >90¢)
            // NOT sent: whale_position (too spammy, viewable on website only)
            for (const alert of alertRows) {
              if (insertedHashes.has(alert.trade_hash) &&
                  (alert.type === 'copyable' || alert.type === 'dormant_whale' || alert.type === 'isolated_contact' || alert.type === 'tail_risk')) {
                const meta = tradeMetaByHash.get(alert.trade_hash) ?? null;
                await sendTelegramAlert(alert, meta);
              }
            }

            // Auto-add anomaly traders to watchlist for ongoing monitoring
            const autoWatchTypes = ['tail_risk', 'isolated_contact', 'dormant_whale'];
            const autoWatchCandidates = alertRows
              .filter(a => insertedHashes.has(a.trade_hash) && autoWatchTypes.includes(a.type) && a.trader_address)
              .map(a => ({
                trader_address: a.trader_address,
                category: a.type,
                notes: `Auto-added from ${a.type} alert on ${new Date().toISOString().slice(0, 10)}`,
              }));
            // Dedupe by trader_address within this batch
            const seenWatchAddrs = new Set<string>();
            const uniqueWatchCandidates = autoWatchCandidates.filter(c => {
              if (seenWatchAddrs.has(c.trader_address)) return false;
              seenWatchAddrs.add(c.trader_address);
              return true;
            });
            if (uniqueWatchCandidates.length > 0) {
              const { error: watchlistError } = await supabase
                .from('watchlist')
                .upsert(uniqueWatchCandidates, { onConflict: 'trader_address', ignoreDuplicates: true });
              if (watchlistError) {
                console.error('Auto-watchlist upsert error:', watchlistError);
              } else {
                console.log(`Auto-watchlisted ${uniqueWatchCandidates.length} traders from anomaly alerts`);
              }
            }
          }
        }
      }

      console.log(
        `Page ${page + 1}/${MAX_PAGES}: fetched=${trades.length}, stored=${rows.length}`,
      );
    }

    hitMaxPages = pageCount >= MAX_PAGES && !stoppedByEmptyPage;

    // Recalculate trader stats after storing all trades
    const { error: statsError } = await supabase.rpc('recalculate_trader_stats');
    if (statsError) {
      console.error("Error recalculating trader stats:", statsError);
    } else {
      console.log("Trader stats recalculated successfully");
    }

    // Refresh trader rankings (critical for alerts)
    const { error: rankingsError } = await supabase.rpc('refresh_trader_rankings');
    if (rankingsError) {
      console.error("Error refreshing trader rankings:", rankingsError);
    } else {
      console.log("Trader rankings refreshed successfully");
    }

    // Note: refresh_all_trader_caches removed - it times out on free tier
    // The refresh-copyable-traders edge function handles this on a schedule instead
    console.log("Skipping refresh_all_trader_caches (handled by scheduled edge function)");

    return new Response(
      JSON.stringify({
        success: true,
        fetched: fetchedTotal,
        stored: upsertedTrades,
        alertsInserted: insertedAlerts,
        diagnostics: diagnosticsEnabled
          ? {
            pageSize: PAGE_SIZE,
            maxPages: MAX_PAGES,
            pagesFetched: pageCount,
            stoppedByEmptyPage,
            hitMaxPages,
            minTradeSize: MIN_TRADE_SIZE,
            rawMissingAddress,
            rawMissingTraderName,
            rawWithEventSlug,
            rawMissingMarketSlug,
            droppedMissingTxHash,
            droppedMissingMarketId,
            droppedMissingAddress,
            droppedMissingTimestamp,
            droppedInvalidAmount,
            droppedBelowMin,
            suppressedExtremePriceAlerts,
            dedupedCount,
            apiFilters: {
              takerOnly: false,
              filterType: "CASH",
              filterAmount: MIN_TRADE_SIZE,
            },
            alertFilters: {
              excludedPriceGte: ALERT_PRICE_MAX,
              excludedPriceLte: ALERT_PRICE_MIN,
            },
          }
          : undefined,
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
