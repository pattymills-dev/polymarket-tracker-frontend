/**
 * run-live-copy.mjs
 *
 * Live copy trading bot — mirrors validated paper positions to real Polymarket CLOB orders.
 *
 * Flow per run (every 15 min):
 *   1. EXIT: scan open live positions for take-profit / stop-loss triggers, place sell orders
 *   2. ENTRY: find new paper positions (last 20 min), place matching buy orders
 *
 * Required environment variables:
 *   SUPABASE_URL                 — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    — Supabase service role key
 *   POLYMARKET_PK                — Wallet private key (hex, with or without 0x prefix)
 *   POLYMARKET_API_KEY           — CLOB API key (derive once with derive-api-key.mjs)
 *   POLYMARKET_API_SECRET        — CLOB API secret
 *   POLYMARKET_API_PASSPHRASE    — CLOB API passphrase
 *   DRY_RUN                      — Set to "1" to log orders without placing them
 */

import { createClient } from "@supabase/supabase-js";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { ethers } from "ethers";

// ─── Config ──────────────────────────────────────────────────────────────────
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const TAKE_PROFIT_PCT = 0.40;   // Exit when up 40% on position value
const STOP_LOSS_PCT = -0.50;    // Exit when down 50% on position value
const STOP_LOSS_PRICE_FLOOR = 0.05; // Only stop-loss if market is still actively traded

const LIVE_MAX_USD = 20;        // Maximum USD per live trade
const LIVE_MIN_USD = 10;        // Minimum USD — skip below this
const LIVE_MIN_SHARES = 1;      // Minimum shares for CLOB order

const NEW_POSITION_LOOKBACK_MIN = 20; // Copy paper positions from last N minutes

const DRY_RUN = process.env.DRY_RUN === "1";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roundPrice(price) {
  // Polymarket CLOB uses 0.01 tick size
  return Math.round(price * 100) / 100;
}

function roundShares(shares) {
  // Round down to 2 decimal places
  return Math.floor(shares * 100) / 100;
}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Validate env
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "POLYMARKET_PK",
    "POLYMARKET_API_KEY",
    "POLYMARKET_API_SECRET",
    "POLYMARKET_API_PASSPHRASE",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing required env var: ${key}`);
      process.exit(1);
    }
  }

  log(`Starting live copy bot (DRY_RUN=${DRY_RUN})`);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const pk = process.env.POLYMARKET_PK.startsWith("0x")
    ? process.env.POLYMARKET_PK
    : `0x${process.env.POLYMARKET_PK}`;

  const wallet = new ethers.Wallet(pk);
  log(`Trading wallet: ${wallet.address}`);

  const clobApiKey = {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE,
  };

  const clob = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, clobApiKey);

  const summary = {
    exits_checked: 0,
    exits_placed: 0,
    exits_failed: 0,
    entries_checked: 0,
    entries_placed: 0,
    entries_failed: 0,
    entries_skipped: 0,
  };

  // ── 1. Process exits ────────────────────────────────────────────────────────
  await processExits(supabase, clob, summary);

  // ── 2. Process entries ──────────────────────────────────────────────────────
  await processEntries(supabase, clob, summary);

  log("Run complete:", JSON.stringify(summary, null, 2));
}

// ─── Exits ────────────────────────────────────────────────────────────────────

async function processExits(supabase, clob, summary) {
  log("Checking open positions for exits...");

  const { data: openPositions, error } = await supabase
    .from("live_positions")
    .select("*")
    .eq("status", "OPEN");

  if (error) {
    log("ERROR loading open live positions:", error.message);
    return;
  }

  if (!openPositions || openPositions.length === 0) {
    log("No open live positions.");
    return;
  }

  // Batch-fetch current prices from market_quotes
  const marketIds = [...new Set(openPositions.map((p) => p.market_id))];
  const { data: quotes } = await supabase
    .from("market_quotes")
    .select("market_id, outcome, best_bid, bid_after_costs, best_ask, ask_with_costs")
    .in("market_id", marketIds);

  const quoteMap = new Map();
  for (const q of quotes || []) {
    quoteMap.set(`${q.market_id}:${q.outcome}`, q);
  }

  const now = new Date().toISOString();

  for (const pos of openPositions) {
    summary.exits_checked++;

    const quote = quoteMap.get(`${pos.market_id}:${pos.outcome}`);
    const currentPrice = toNumber(quote?.bid_after_costs ?? quote?.best_bid);
    const entryPrice = toNumber(pos.entry_price ?? pos.source_price);

    if (currentPrice == null || entryPrice == null || entryPrice <= 0) {
      log(`SKIP exit ${pos.id}: missing price data (current=${currentPrice}, entry=${entryPrice})`);
      continue;
    }

    const pnlPct = currentPrice / entryPrice - 1;

    let exitReason = null;
    if (pnlPct >= TAKE_PROFIT_PCT) {
      exitReason = "live_take_profit";
    } else if (pnlPct <= STOP_LOSS_PCT && currentPrice > STOP_LOSS_PRICE_FLOOR) {
      exitReason = "live_stop_loss";
    }

    if (!exitReason) continue;

    const sellPrice = roundPrice(currentPrice);
    const sharesToSell = roundShares(toNumber(pos.shares) ?? 0);

    log(
      `EXIT ${pos.market_title} | ${pos.outcome} | ` +
      `entry=${entryPrice} current=${currentPrice} pnl=${(pnlPct * 100).toFixed(1)}% | ` +
      `reason=${exitReason} shares=${sharesToSell} price=${sellPrice}`,
    );

    if (sharesToSell < LIVE_MIN_SHARES) {
      log(`SKIP exit: shares ${sharesToSell} below minimum ${LIVE_MIN_SHARES}`);
      summary.exits_failed++;
      continue;
    }

    let exitOrderResponse = null;
    let exitOrderId = null;

    if (!DRY_RUN) {
      try {
        const sellOrder = await clob.createAndPostOrder({
          tokenID: pos.token_id,
          price: sellPrice,
          side: Side.SELL,
          size: sharesToSell,
          orderType: OrderType.GTC,
          feeRateBps: "0",
          nonce: "0",
        });
        exitOrderResponse = sellOrder;
        exitOrderId = sellOrder?.orderID ?? sellOrder?.id ?? null;
        log(`Sell order placed: orderId=${exitOrderId}`);
      } catch (err) {
        log(`ERROR placing sell order for position ${pos.id}:`, err.message);
        await supabase
          .from("live_positions")
          .update({ error_message: `Exit error: ${err.message}`, updated_at: now })
          .eq("id", pos.id);
        summary.exits_failed++;
        continue;
      }
    }

    const sharesVal = toNumber(pos.shares) ?? 0;
    const pnlUsd = sharesVal * currentPrice - toNumber(pos.usd_size);

    if (!DRY_RUN) {
      await supabase
        .from("live_positions")
        .update({
          status: "SETTLED",
          exit_ts: now,
          exit_price: sellPrice,
          exit_order_id: exitOrderId,
          pnl_usd: pnlUsd,
          exit_reason: exitReason,
          raw_exit_response: exitOrderResponse,
          updated_at: now,
        })
        .eq("id", pos.id);
    }

    summary.exits_placed++;
    log(`Position closed: pnl_usd=${pnlUsd?.toFixed(2)}`);
  }
}

// ─── Entries ─────────────────────────────────────────────────────────────────

async function processEntries(supabase, clob, summary) {
  log("Checking for new paper positions to copy...");

  const lookbackTs = new Date(
    Date.now() - NEW_POSITION_LOOKBACK_MIN * 60 * 1000,
  ).toISOString();

  // Load new paper positions
  const { data: paperPositions, error: ppError } = await supabase
    .from("paper_positions")
    .select(
      "id, source_wallet, source_trade_id, source_trade_ts, market_id, market_slug, " +
      "market_title, outcome, side, source_price, entry_price, usd_size, shares, entry_ts",
    )
    .eq("strategy_lane", "copy")
    .eq("status", "OPEN")
    .gte("entry_ts", lookbackTs)
    .order("entry_ts", { ascending: true });

  if (ppError) {
    log("ERROR loading paper positions:", ppError.message);
    return;
  }

  if (!paperPositions || paperPositions.length === 0) {
    log("No new paper positions in the last", NEW_POSITION_LOOKBACK_MIN, "minutes.");
    return;
  }

  log(`Found ${paperPositions.length} new paper position(s) to evaluate.`);

  // Load already-copied source_trade_ids to avoid duplicates
  const sourceTxIds = paperPositions
    .map((p) => p.source_trade_id)
    .filter(Boolean);

  const { data: existingLive } = await supabase
    .from("live_positions")
    .select("source_trade_id")
    .in("source_trade_id", sourceTxIds);

  const alreadyCopied = new Set(
    (existingLive || []).map((r) => r.source_trade_id),
  );

  // Batch-load market token maps and current ask prices
  const marketIds = [...new Set(paperPositions.map((p) => p.market_id))];

  const { data: markets } = await supabase
    .from("markets")
    .select("id, outcome_token_map")
    .in("id", marketIds);

  const marketMap = new Map((markets || []).map((m) => [m.id, m]));

  const { data: quotes } = await supabase
    .from("market_quotes")
    .select("market_id, outcome, best_ask, ask_with_costs, best_bid, bid_after_costs")
    .in("market_id", marketIds);

  const quoteMap = new Map();
  for (const q of quotes || []) {
    quoteMap.set(`${q.market_id}:${q.outcome}`, q);
  }

  const now = new Date().toISOString();

  for (const paper of paperPositions) {
    summary.entries_checked++;

    // Dedup check
    if (alreadyCopied.has(paper.source_trade_id)) {
      log(`SKIP: already copied source_trade_id=${paper.source_trade_id}`);
      summary.entries_skipped++;
      continue;
    }

    // Token ID lookup
    const market = marketMap.get(paper.market_id);
    if (!market?.outcome_token_map) {
      log(`SKIP: no outcome_token_map for market ${paper.market_id}`);
      summary.entries_skipped++;
      continue;
    }

    const tokenId = market.outcome_token_map[paper.outcome];
    if (!tokenId) {
      log(`SKIP: outcome "${paper.outcome}" not found in token map for market ${paper.market_id}`);
      log(`  Available outcomes: ${Object.keys(market.outcome_token_map).join(", ")}`);
      summary.entries_skipped++;
      continue;
    }

    // Current ask price (use this for live entry rather than stale paper price)
    const quote = quoteMap.get(`${paper.market_id}:${paper.outcome}`);
    const askPrice = toNumber(quote?.ask_with_costs ?? quote?.best_ask);

    if (askPrice == null || askPrice <= 0.01 || askPrice >= 0.99) {
      log(`SKIP: invalid ask price (${askPrice}) for market ${paper.market_id} / ${paper.outcome}`);
      summary.entries_skipped++;
      continue;
    }

    // Size calculation
    const usdSize = Math.min(
      Math.max(toNumber(paper.usd_size) ?? LIVE_MIN_USD, LIVE_MIN_USD),
      LIVE_MAX_USD,
    );
    const entryPrice = roundPrice(askPrice);
    const shares = roundShares(usdSize / entryPrice);

    if (shares < LIVE_MIN_SHARES) {
      log(`SKIP: shares (${shares}) below minimum ${LIVE_MIN_SHARES}`);
      summary.entries_skipped++;
      continue;
    }

    log(
      `ENTRY ${paper.market_title} | ${paper.outcome} | ` +
      `paper_price=${paper.source_price} ask=${askPrice} entry=${entryPrice} ` +
      `usd=${usdSize} shares=${shares}`,
    );

    let orderResponse = null;
    let orderId = null;

    if (!DRY_RUN) {
      try {
        const buyOrder = await clob.createAndPostOrder({
          tokenID: String(tokenId),
          price: entryPrice,
          side: Side.BUY,
          size: shares,
          orderType: OrderType.GTC,
          feeRateBps: "0",
          nonce: "0",
        });
        orderResponse = buyOrder;
        orderId = buyOrder?.orderID ?? buyOrder?.id ?? null;
        log(`Buy order placed: orderId=${orderId}`);
      } catch (err) {
        log(`ERROR placing buy order for market ${paper.market_id}:`, err.message);
        // Record the failure in live_positions so we can debug
        await supabase.from("live_positions").insert({
          paper_position_id: paper.id,
          source_wallet: paper.source_wallet,
          source_trade_id: paper.source_trade_id,
          source_trade_ts: paper.source_trade_ts,
          market_id: paper.market_id,
          market_slug: paper.market_slug,
          market_title: paper.market_title,
          outcome: paper.outcome,
          side: paper.side ?? "BUY",
          token_id: String(tokenId),
          source_price: paper.source_price,
          entry_price: entryPrice,
          usd_size: usdSize,
          shares,
          status: "FAILED",
          entry_ts: now,
          error_message: err.message,
          updated_at: now,
        });
        summary.entries_failed++;
        continue;
      }
    }

    // Insert live position record
    const liveRow = {
      paper_position_id: paper.id,
      source_wallet: paper.source_wallet,
      source_trade_id: paper.source_trade_id,
      source_trade_ts: paper.source_trade_ts,
      market_id: paper.market_id,
      market_slug: paper.market_slug,
      market_title: paper.market_title,
      outcome: paper.outcome,
      side: paper.side ?? "BUY",
      token_id: String(tokenId),
      source_price: paper.source_price,
      entry_price: entryPrice,
      order_id: orderId,
      usd_size: usdSize,
      shares,
      status: "OPEN",
      entry_ts: paper.entry_ts ?? now,
      raw_entry_response: orderResponse,
      updated_at: now,
    };

    if (!DRY_RUN) {
      const { error: insertError } = await supabase
        .from("live_positions")
        .insert(liveRow);

      if (insertError) {
        log(`ERROR inserting live_position:`, insertError.message);
        summary.entries_failed++;
        continue;
      }
    } else {
      log(`[DRY RUN] Would insert live position:`, JSON.stringify(liveRow, null, 2));
    }

    summary.entries_placed++;
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
