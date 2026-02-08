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
    const PAGE_SIZE = 500;
    const MAX_PAGES = 10;  // Stop early if API returns 400/404 (offset cap)

    // Only store trades >= $1k to keep data manageable while improving coverage
    const MIN_TRADE_SIZE = 1_000;
    // Copyable trader alert gates (30D)
    const COPYABLE_RANK_CUTOFF = 50;
    const MIN_COPYABLE_TRADER_ROI = 0.10; // 10% realized ROI
    const MIN_COPYABLE_TRADER_PL = 1_000; // $1k realized P/L
    const MIN_COPYABLE_MEDIAN_BET = 250;  // $250 median bet
    const COPYABLE_ALERT_MIN_TRADE_SIZE = 250;
    const COPYABLE_ALERT_COOLDOWN_HOURS = 6;
    const RANKING_STALE_HOURS = 2;

    // Global alert throttles
    const GLOBAL_ALERTS_PER_HOUR = 10;
    const ISOLATED_CONTACT_MIN_SIZE = 10_000;
    const ISOLATED_CONTACT_EXTREME_MIN = 100_000;
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

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
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

      // Fetch canonical rankings for alerts (single source of truth)
      const { data: copyableRankings } = await supabase
        .from("trader_rankings")
        .select("trader_address, copyable_rank_30d, realized_roi_30d, realized_pl_30d, median_bet_30d, wins_30d, losses_30d, resolved_trades_30d, computed_at")
        .not("copyable_rank_30d", "is", null)
        .lte("copyable_rank_30d", COPYABLE_RANK_CUTOFF);

      const copyableAddresses = new Set((copyableRankings || []).map((t: any) => t.trader_address?.toLowerCase()));
      const copyableMap = new Map((copyableRankings || []).map((t: any) => [t.trader_address?.toLowerCase(), t]));

      // Global alert rate limit (copyable + isolated contact)
      const globalSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentGlobalAlerts } = await supabase
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .gte("created_at", globalSince)
        .in("alert_source", ["copyable", "isolated_contact"]);
      let globalRemaining = Math.max(0, GLOBAL_ALERTS_PER_HOUR - (recentGlobalAlerts || 0));

      // Per-trader cooldown for copyable alerts
      const copyableCooldownSince = new Date(Date.now() - COPYABLE_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
      let recentCopyableByTrader = new Set<string>();
      if (copyableRankings && copyableRankings.length > 0) {
        const addrList = (copyableRankings || [])
          .map((t: any) => t.trader_address)
          .filter(Boolean);
        if (addrList.length > 0) {
          const { data: recentCopyableAlerts } = await supabase
            .from("alerts")
            .select("trader_address, created_at")
            .eq("alert_source", "copyable")
            .gte("created_at", copyableCooldownSince)
            .in("trader_address", addrList);
          recentCopyableByTrader = new Set((recentCopyableAlerts || []).map((a: any) => String(a.trader_address).toLowerCase()));
        }
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

        // Skip alerting on extreme entry prices entirely (even if ROI looks high).
        const priceNum = safeNumber(r.price);
        if (priceNum != null && (priceNum >= ALERT_PRICE_MAX || priceNum <= ALERT_PRICE_MIN)) {
          suppressedExtremePriceAlerts += 1;
          continue;
        }

        const traderLower = r.trader_address?.toLowerCase();
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

        // Copyable alert (30D)
        if (isCopyable && r.amount >= COPYABLE_ALERT_MIN_TRADE_SIZE && globalRemaining > 0) {
          const computedAt = copyableInfo?.computed_at ? new Date(copyableInfo.computed_at).getTime() : null;
          const staleMs = RANKING_STALE_HOURS * 60 * 60 * 1000;
          if (!computedAt || (Date.now() - computedAt) > staleMs) {
            continue;
          }

          if (recentCopyableByTrader.has(traderLower)) {
            continue;
          }

          const copyableTraderRoi = safeNumber(copyableInfo?.realized_roi_30d);
          const copyableTraderPl = safeNumber(copyableInfo?.realized_pl_30d);
          const copyableMedian = safeNumber(copyableInfo?.median_bet_30d);

          if (
            copyableTraderRoi == null || copyableTraderRoi < MIN_COPYABLE_TRADER_ROI ||
            copyableTraderPl == null || copyableTraderPl < MIN_COPYABLE_TRADER_PL ||
            copyableMedian == null || copyableMedian < MIN_COPYABLE_MEDIAN_BET
          ) {
            continue;
          }

          const record = formatRecord({
            wins: copyableInfo?.wins_30d,
            losses: copyableInfo?.losses_30d
          });
          const roiPct = Math.round(copyableTraderRoi * 100);
          const plText = Math.round(copyableTraderPl).toLocaleString();
          const medianText = Math.round(copyableMedian).toLocaleString();
          const rank = copyableInfo?.copyable_rank_30d ?? '?';

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
            message: `HIGH ROI / COPYABLE #${rank} (30D)${record} [ROI ${roiPct}% · P/L $${plText} · Median $${medianText}]: $${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id}`,
            sent: false,
          });
          globalRemaining -= 1;
        }

        // Collect candidates for Isolated Contact (will batch check after loop)
        if (globalRemaining > 0 && !isCopyable) {
          const priceNum = safeNumber(r.price);
          const isExtreme = priceNum != null && (priceNum >= ALERT_PRICE_MAX || priceNum <= ALERT_PRICE_MIN);
          const minIsolated = isExtreme ? ISOLATED_CONTACT_EXTREME_MIN : ISOLATED_CONTACT_MIN_SIZE;
          if (r.amount >= minIsolated) {
            isolatedContactCandidates.push({ trade: r, betDirection });
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
                  globalRemaining -= 1;
                }
              }
            }
          }
        } catch (error) {
          console.error('Error batch checking Isolated Contacts:', error);
        }
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

            // Send Telegram only for high-priority alerts that were actually inserted
            for (const alert of alertRows) {
              if (insertedHashes.has(alert.trade_hash) &&
                  (alert.type === 'copyable' || alert.type === 'isolated_contact')) {
                const meta = tradeMetaByHash.get(alert.trade_hash) ?? null;
                await sendTelegramAlert(alert, meta);
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

    // Refresh top traders + hot streak caches for UI/alerts
    const { error: cacheError } = await supabase.rpc('refresh_all_trader_caches');
    if (cacheError) {
      console.error("Error refreshing trader caches:", cacheError);
    } else {
      console.log("Trader caches refreshed successfully");
    }

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
