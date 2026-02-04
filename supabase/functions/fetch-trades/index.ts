import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    console.log("Fetching trades from Polymarket Data API...");

    // Fetch recent trades - optimized for 15-minute intervals
    // Polymarket Data API enforces low limit/offset caps, so we filter server-side.
    const PAGE_SIZE = 500;
    const MAX_PAGES = 10;  // Stop early if API returns 400/404 (offset cap)

    // Only store trades >= $1k to keep data manageable while improving coverage
    const MIN_TRADE_SIZE = 1_000;
    const WHALE_THRESHOLD = 10_000;
    const MEGA_WHALE_THRESHOLD = 50_000;

    let fetchedTotal = 0;
    let upsertedTrades = 0;
    let insertedAlerts = 0;
    const tradeMetaByHash = new Map<string, TradeMeta>();
    let pageCount = 0;
    let stoppedByEmptyPage = false;

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

      // Fetch top 20 traders (by P/L) and hot streaks (by win rate) for smart alerts
      const { data: topTraders } = await supabase
        .from("top_traders")
        .select("trader_address, rank, total_pl, wins, losses, resolved_markets, win_rate")
        .lte("rank", 20);  // Only alert for top 20 by P/L

      const { data: hotStreaks } = await supabase
        .from("hot_streaks")
        .select("trader_address, rank, total_pl, wins, losses, resolved_markets, win_rate")
        .lte("rank", 20);  // Only alert for top 20 by win rate

      const { data: watchlist } = await supabase
        .from("watchlist")
        .select("trader_address");

      const topTraderAddresses = new Set((topTraders || []).map((t: any) => t.trader_address?.toLowerCase()));
      const hotStreakAddresses = new Set((hotStreaks || []).map((t: any) => t.trader_address?.toLowerCase()));
      const watchlistAddresses = new Set((watchlist || []).map((t: any) => t.trader_address?.toLowerCase()));
      const topTraderMap = new Map((topTraders || []).map((t: any) => [t.trader_address?.toLowerCase(), t]));
      const hotStreakMap = new Map((hotStreaks || []).map((t: any) => [t.trader_address?.toLowerCase(), t]));

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
      // 1. Top trader trades >= $5k (by P/L)
      // 2. Hot streak trades >= $5k (by win rate, if not already top trader)
      // 3. Watchlist trades >= $5k
      // 4. Regular whale trades >= $10k (existing behavior)
      // 5. Isolated Contact: rare trader + thin market + outsized trade
      const alertRows: any[] = [];

      for (const r of rows) {
        if (typeof r.amount !== "number") continue;

        const traderLower = r.trader_address?.toLowerCase();
        const isTopTrader = topTraderAddresses.has(traderLower);
        const isHotStreak = hotStreakAddresses.has(traderLower);
        const isWatchlist = watchlistAddresses.has(traderLower);
        const topTraderInfo = topTraderMap.get(traderLower);
        const hotStreakInfo = hotStreakMap.get(traderLower);

        // Format bet direction for display (e.g., "BUY Yes @ 65¢" or "SELL No @ 35¢")
        const betDirection = r.outcome ? `${r.side || 'BUY'} ${r.outcome}${r.price ? ` @ ${Math.round(r.price * 100)}¢` : ''}` : '';

        // Format resolved record (e.g., "12-3" for 12 wins, 3 losses)
        const formatRecord = (info: any) => {
          if (!info) return '';
          const wins = info.wins || 0;
          const losses = info.losses || 0;
          return ` [${wins}-${losses}]`;
        };

        // Top trader alert (>= $5k) - only top 20 by P/L
        if (isTopTrader && r.amount >= MIN_TRADE_SIZE) {
          const record = formatRecord(topTraderInfo);
          alertRows.push({
            type: "top_trader",
            alert_source: "top_trader",
            trade_hash: r.tx_hash, // Use tx_hash for deduplication
            trader_address: r.trader_address,
            market_id: r.market_id,
            market_title: r.market_title,
            market_slug: r.market_slug,
            outcome: r.outcome,
            side: r.side || 'BUY',
            price: r.price,
            amount: r.amount,
            message: `🏆 TOP TRADER #${topTraderInfo?.rank || '?'}${record} ($${Math.round(topTraderInfo?.total_pl || 0).toLocaleString()} P/L): $${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id}`,
            sent: false,
          });
        }
        // Hot streak alert (>= $5k) - only top 20 by win rate (if not already a top trader)
        else if (isHotStreak && !isTopTrader && r.amount >= MIN_TRADE_SIZE) {
          const record = formatRecord(hotStreakInfo);
          const winRate = Math.round(hotStreakInfo?.win_rate || 0);
          alertRows.push({
            type: "hot_streak",
            alert_source: "hot_streak",
            trade_hash: r.tx_hash,
            trader_address: r.trader_address,
            market_id: r.market_id,
            market_title: r.market_title,
            market_slug: r.market_slug,
            outcome: r.outcome,
            side: r.side || 'BUY',
            price: r.price,
            amount: r.amount,
            message: `🔥 HOT STREAK #${hotStreakInfo?.rank || '?'}${record} (${winRate}% win rate): $${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id}`,
            sent: false,
          });
        }
        // Watchlist alert (>= $5k)
        else if (isWatchlist && r.amount >= MIN_TRADE_SIZE) {
          alertRows.push({
            type: "watchlist",
            alert_source: "watchlist",
            trade_hash: r.tx_hash, // Use tx_hash for deduplication
            trader_address: r.trader_address,
            market_id: r.market_id,
            market_title: r.market_title,
            market_slug: r.market_slug,
            outcome: r.outcome,
            side: r.side || 'BUY',
            price: r.price,
            amount: r.amount,
            message: `👀 WATCHLIST: $${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id}`,
            sent: false,
          });
        }
        // Regular whale alert (>= $10k, but not already alerted as top trader/watchlist)
        else if (r.amount >= WHALE_THRESHOLD) {
          alertRows.push({
            type: r.amount >= MEGA_WHALE_THRESHOLD ? "mega_whale" : "whale",
            alert_source: "whale",
            trade_hash: r.tx_hash, // Use tx_hash for deduplication
            trader_address: r.trader_address,
            market_id: r.market_id,
            market_title: r.market_title,
            market_slug: r.market_slug,
            outcome: r.outcome,
            side: r.side || 'BUY',
            price: r.price,
            amount: r.amount,
            message: `${r.amount >= MEGA_WHALE_THRESHOLD ? "🐋 MEGA " : "🐋 "}WHALE: $${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id}`,
            sent: false,
          });
        }

        // Collect candidates for Isolated Contact (will batch check after loop)
        if (r.amount >= MIN_TRADE_SIZE && !isTopTrader && !isHotStreak && !isWatchlist && r.amount < WHALE_THRESHOLD) {
          isolatedContactCandidates.push({ trade: r, betDirection });
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
                if (candidate) {
                  const r = candidate.trade;
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
                    message: `📡 ISOLATED CONTACT: $${Math.round(r.amount).toLocaleString()} ${candidate.betDirection} on ${r.market_title || r.market_id}`,
                    sent: false,
                  });
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
                  (alert.type === 'top_trader' || alert.type === 'hot_streak' || alert.type === 'watchlist' || alert.type === 'mega_whale' || alert.type === 'isolated_contact')) {
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
            minTradeSize: MIN_TRADE_SIZE,
            whaleThreshold: WHALE_THRESHOLD,
            megaWhaleThreshold: MEGA_WHALE_THRESHOLD,
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
            dedupedCount,
            apiFilters: {
              takerOnly: false,
              filterType: "CASH",
              filterAmount: MIN_TRADE_SIZE,
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
