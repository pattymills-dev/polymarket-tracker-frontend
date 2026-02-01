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

// Build Polymarket URL from slug - handles sports bets and regular events
function buildPolymarketUrl(slug: string | null): string | null {
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

// Send Telegram notification for important alerts
async function sendTelegramAlert(alert: any): Promise<void> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!botToken || !chatId) {
    console.log("Telegram not configured, skipping notification");
    return;
  }

  try {
    const polymarketUrl = buildPolymarketUrl(alert.market_slug);

    const polymarketLink = polymarketUrl
      ? `\n\n🔗 <a href="${polymarketUrl}">View on Polymarket</a>`
      : '';

    const text = `${alert.message}${polymarketLink}`;

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !serviceRole) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole);

    console.log("Fetching trades from Polymarket Data API...");

    // Fetch ~150,000 trades per run (~4-5 min of data) to capture whale activity
    // With ~1 whale trade per 2 min, this ensures we catch all whales in 15-min interval
    const PAGE_SIZE = 500;
    const MAX_PAGES = 300;

    // Only store trades >= $5k to save database space
    const MIN_TRADE_SIZE = 5_000;
    const WHALE_THRESHOLD = 10_000;
    const MEGA_WHALE_THRESHOLD = 50_000;

    let fetchedTotal = 0;
    let upsertedTrades = 0;
    let insertedAlerts = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url =
        `https://data-api.polymarket.com/trades?limit=${PAGE_SIZE}&offset=${offset}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Data API returned ${response.status} for ${url}`);
      }

      const trades = await response.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        console.log(`No trades returned at offset=${offset}. Stopping.`);
        break;
      }

      fetchedTotal += trades.length;

      // 1) Map into your DB schema
      const rowsRaw = trades.map((t: any) => {
        const size = safeNumber(t.size);
        const price = safeNumber(t.price);
        const ts = safeNumber(t.timestamp);

        // "Cash" amount ≈ size * price
        const amount = size != null && price != null ? size * price : null;

        return {
          tx_hash: t.transactionHash ?? null,
          market_id: t.conditionId ?? null, // use conditionId
          market_slug: t.slug ?? null,
          market_title: t.title ?? null,
          trader_address: t.proxyWallet ?? null,
          outcome: t.outcome ?? null,
          amount,
          price,
          timestamp: ts != null ? new Date(ts * 1000).toISOString() : null,
        };
      });

      // 2) Filter out invalid rows AND trades below $5k threshold
      const rowsFiltered = rowsRaw.filter((r: any) =>
        r.tx_hash && r.market_id && r.trader_address && r.timestamp &&
        typeof r.amount === "number" && r.amount >= MIN_TRADE_SIZE
      );

      // 3) Dedupe by tx_hash within this batch to avoid:
      //    "ON CONFLICT DO UPDATE command cannot affect row a second time"
      const seen = new Set<string>();
      const rows: any[] = [];
      for (const r of rowsFiltered) {
        if (seen.has(r.tx_hash)) continue;
        seen.add(r.tx_hash);
        rows.push(r);
      }

      console.log(
        `Page ${page + 1}/${MAX_PAGES} offset=${offset}: raw=${rowsRaw.length} filtered_$5k+=${rowsFiltered.length} deduped=${rows.length}`,
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

      // Helper function to check Isolated Contact conditions
      // Returns { isIsolatedContact, reasons } where reasons contains which conditions triggered
      async function checkIsolatedContact(tradeAmount: number, traderAddress: string, marketId: string): Promise<{ isIsolatedContact: boolean; reasons: string[] }> {
        const reasons: string[] = [];

        // Skip if trader is already a known top trader or on watchlist (they're not "isolated")
        if (topTraderAddresses.has(traderAddress.toLowerCase()) ||
            hotStreakAddresses.has(traderAddress.toLowerCase()) ||
            watchlistAddresses.has(traderAddress.toLowerCase())) {
          return { isIsolatedContact: false, reasons };
        }

        try {
          // 1) Check if rare trader
          const { data: isRare } = await supabase.rpc('is_rare_trader', { p_trader_address: traderAddress });
          if (!isRare) {
            return { isIsolatedContact: false, reasons };
          }
          reasons.push('rare_trader');

          // 2) Check if thin market
          const { data: isThin } = await supabase.rpc('is_thin_market', { p_market_id: marketId });
          if (!isThin) {
            return { isIsolatedContact: false, reasons };
          }
          reasons.push('thin_market');

          // 3) Check if outsized trade
          const { data: isOutsized } = await supabase.rpc('is_outsized_trade', {
            p_market_id: marketId,
            p_trade_size: tradeAmount
          });
          if (!isOutsized) {
            return { isIsolatedContact: false, reasons };
          }
          reasons.push('outsized_trade');

          // All three conditions met
          return { isIsolatedContact: true, reasons };
        } catch (error) {
          console.error('Error checking Isolated Contact conditions:', error);
          return { isIsolatedContact: false, reasons };
        }
      }

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

        // 5. Isolated Contact detection (rare trader + thin market + outsized trade)
        // Only check for trades >= $5k that haven't already triggered another alert type
        if (r.amount >= MIN_TRADE_SIZE && !isTopTrader && !isHotStreak && !isWatchlist && r.amount < WHALE_THRESHOLD) {
          const { isIsolatedContact, reasons } = await checkIsolatedContact(r.amount, r.trader_address, r.market_id);

          if (isIsolatedContact) {
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
              message: `📡 ISOLATED CONTACT: $${Math.round(r.amount).toLocaleString()} ${betDirection} on ${r.market_title || r.market_id} [${reasons.join(', ')}]`,
              sent: false,
            });
          }
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
                await sendTelegramAlert(alert);
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

    return new Response(
      JSON.stringify({
        success: true,
        fetched: fetchedTotal,
        stored: upsertedTrades,
        alertsInserted: insertedAlerts,
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