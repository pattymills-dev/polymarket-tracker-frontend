#!/usr/bin/env bash
set -euo pipefail

# CLI Portfolio Validation & Leaderboard Cross-Reference
# Called by sync-trades.yml after refresh-top-traders.
# Rotates through top 20 traders (5 per run), fetching ground-truth
# portfolio data from the Polymarket CLI and comparing to our computed P/L.
#
# Environment variables (set by workflow):
#   SUPABASE_URL — Supabase project URL
#   SUPABASE_KEY — Service role key

SUPABASE_URL="${SUPABASE_URL:?SUPABASE_URL not set}"
SUPABASE_KEY="${SUPABASE_KEY:?SUPABASE_KEY not set}"

AUTH_HEADERS=(-H "Authorization: Bearer ${SUPABASE_KEY}" -H "apikey: ${SUPABASE_KEY}")
CONTENT_TYPE=(-H "Content-Type: application/json")
TRADERS_PER_RUN=5
CLI_TIMEOUT=20

echo "=== Polymarket CLI Portfolio Validation ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Verify CLI is available
if ! command -v polymarket &>/dev/null; then
  # Try common install locations
  export PATH="$HOME/.polymarket/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
  if ! command -v polymarket &>/dev/null; then
    echo "ERROR: polymarket CLI not found in PATH"
    exit 1
  fi
fi
echo "CLI version: $(polymarket --version 2>/dev/null || echo 'unknown')"

# ──────────────────────────────────────────────
# Phase 1: Trader Portfolio Snapshots
# ──────────────────────────────────────────────

# Rotate through top 20: slot 0→offset 0, slot 1→offset 5, etc.
SLOT=$(( ($(date +%s) / 900) % 4 ))
OFFSET=$(( SLOT * TRADERS_PER_RUN ))
echo ""
echo "--- Phase 1: Portfolio snapshots (slot=$SLOT, offset=$OFFSET) ---"

# Fetch trader addresses + our computed P/L from trader_rankings
TRADERS_JSON=$(curl -sf \
  "${AUTH_HEADERS[@]}" \
  "${SUPABASE_URL}/rest/v1/trader_rankings?copyable_rank_30d=not.is.null&select=trader_address,realized_pl_all_time,copyable_rank_30d&order=copyable_rank_30d.asc&limit=${TRADERS_PER_RUN}&offset=${OFFSET}" \
  2>/dev/null || echo "[]")

TRADER_COUNT=$(echo "$TRADERS_JSON" | jq 'length')
echo "Fetched $TRADER_COUNT traders from rankings"

if [ "$TRADER_COUNT" -eq 0 ]; then
  echo "No traders to validate at this offset, skipping phase 1"
else
  echo "$TRADERS_JSON" | jq -c '.[]' | while IFS= read -r TRADER_ROW; do
    ADDR=$(echo "$TRADER_ROW" | jq -r '.trader_address')
    OUR_PL=$(echo "$TRADER_ROW" | jq -r '.realized_pl_all_time // 0')
    OUR_RANK=$(echo "$TRADER_ROW" | jq -r '.copyable_rank_30d // null')

    echo ""
    echo "Trader: ${ADDR:0:10}... (our rank: $OUR_RANK, our P/L: $OUR_PL)"

    # Fetch portfolio value
    VALUE_JSON=$(timeout ${CLI_TIMEOUT}s polymarket -o json data value "$ADDR" 2>/dev/null || echo "{}")
    PORTFOLIO_VALUE=$(echo "$VALUE_JSON" | jq -r '.value // .total // .portfolio_value // null' 2>/dev/null || echo "null")

    # Fetch open positions
    POSITIONS_JSON=$(timeout ${CLI_TIMEOUT}s polymarket -o json data positions "$ADDR" 2>/dev/null || echo "[]")
    OPEN_COUNT=$(echo "$POSITIONS_JSON" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo "0")

    # Fetch closed positions
    CLOSED_JSON=$(timeout ${CLI_TIMEOUT}s polymarket -o json data closed-positions "$ADDR" 2>/dev/null || echo "[]")
    CLOSED_COUNT=$(echo "$CLOSED_JSON" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo "0")

    # Try to extract P/L from closed positions
    # The CLI JSON format is not fully documented, so we try multiple paths
    CLOSED_PNL=$(echo "$CLOSED_JSON" | jq '
      if type == "array" then
        [.[] | (.pnl // .profit // .realized_pnl // 0) | tonumber] | add // 0
      else
        0
      end
    ' 2>/dev/null || echo "0")

    # Compute delta
    PL_DELTA=$(echo "$CLOSED_PNL $OUR_PL" | awk '{printf "%.2f", $1 - $2}')

    echo "  Portfolio value: $PORTFOLIO_VALUE | Open: $OPEN_COUNT | Closed: $CLOSED_COUNT"
    echo "  CLI P/L: $CLOSED_PNL | Our P/L: $OUR_PL | Delta: $PL_DELTA"

    # Upsert snapshot to Supabase
    SNAPSHOT=$(jq -n \
      --arg addr "$ADDR" \
      --argjson pv "${PORTFOLIO_VALUE:-null}" \
      --argjson oc "${OPEN_COUNT:-0}" \
      --argjson cc "${CLOSED_COUNT:-0}" \
      --argjson cpnl "${CLOSED_PNL:-0}" \
      --argjson opl "${OUR_PL:-0}" \
      --argjson delta "${PL_DELTA:-0}" \
      --argjson positions "$POSITIONS_JSON" \
      '{
        trader_address: $addr,
        portfolio_value_usd: $pv,
        open_positions_count: $oc,
        open_positions_json: $positions,
        closed_positions_count: $cc,
        closed_pnl_usd: $cpnl,
        our_computed_pl: $opl,
        pl_delta: $delta
      }')

    INSERT_RESULT=$(curl -sf -X POST \
      "${AUTH_HEADERS[@]}" \
      "${CONTENT_TYPE[@]}" \
      -d "$SNAPSHOT" \
      "${SUPABASE_URL}/rest/v1/trader_portfolio_snapshots" \
      2>/dev/null || echo "insert_failed")

    if [ "$INSERT_RESULT" = "insert_failed" ]; then
      echo "  WARNING: Failed to store snapshot"
    else
      echo "  Snapshot stored"
    fi

    sleep 2  # Rate limit
  done
fi

# ──────────────────────────────────────────────
# Phase 2: Leaderboard Cross-Reference
# ──────────────────────────────────────────────
echo ""
echo "--- Phase 2: Leaderboard cross-reference ---"

LEADERBOARD_JSON=$(timeout ${CLI_TIMEOUT}s polymarket -o json data leaderboard --period month --order-by pnl --limit 20 2>/dev/null || echo "[]")
LB_COUNT=$(echo "$LEADERBOARD_JSON" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo "0")
echo "Leaderboard entries: $LB_COUNT"

if [ "$LB_COUNT" -eq 0 ]; then
  echo "No leaderboard data returned, skipping phase 2"
else
  # Get all our tracked trader addresses for cross-reference (batch query)
  OUR_ADDRESSES=$(curl -sf \
    "${AUTH_HEADERS[@]}" \
    "${SUPABASE_URL}/rest/v1/trader_rankings?select=trader_address,copyable_rank_30d" \
    2>/dev/null || echo "[]")

  echo "$LEADERBOARD_JSON" | jq -c '.[]' | head -20 | while IFS= read -r LB_ENTRY; do
    # Try multiple possible field names for the address
    LB_ADDR=$(echo "$LB_ENTRY" | jq -r '.address // .wallet // .trader // .proxyWallet // empty' 2>/dev/null || echo "")
    if [ -z "$LB_ADDR" ]; then continue; fi

    LB_RANK=$(echo "$LB_ENTRY" | jq -r '.rank // .position // null' 2>/dev/null || echo "null")
    LB_PNL=$(echo "$LB_ENTRY" | jq -r '.pnl // .profit // .total_pnl // 0' 2>/dev/null || echo "0")
    LB_VOLUME=$(echo "$LB_ENTRY" | jq -r '.volume // .total_volume // 0' 2>/dev/null || echo "0")

    # Check if this trader is in our rankings
    IN_OURS=$(echo "$OUR_ADDRESSES" | jq --arg addr "$LB_ADDR" '[.[] | select(.trader_address == $addr)] | length > 0')
    OUR_R=$(echo "$OUR_ADDRESSES" | jq --arg addr "$LB_ADDR" '[.[] | select(.trader_address == $addr)][0].copyable_rank_30d // null')

    if [ "$IN_OURS" = "true" ]; then
      echo "  Rank $LB_RANK: ${LB_ADDR:0:10}... P/L: $LB_PNL (IN OUR RANKINGS at #$OUR_R)"
    else
      echo "  Rank $LB_RANK: ${LB_ADDR:0:10}... P/L: $LB_PNL (NOT TRACKED)"
    fi

    # Store snapshot
    LB_SNAPSHOT=$(jq -n \
      --arg addr "$LB_ADDR" \
      --argjson rank "${LB_RANK:-null}" \
      --argjson pnl "${LB_PNL:-0}" \
      --argjson vol "${LB_VOLUME:-0}" \
      --argjson in_ours "$IN_OURS" \
      --argjson our_rank "$OUR_R" \
      '{
        trader_address: $addr,
        leaderboard_rank: $rank,
        leaderboard_pnl: $pnl,
        leaderboard_volume: $vol,
        in_our_rankings: $in_ours,
        our_rank: $our_rank
      }')

    curl -sf -X POST \
      "${AUTH_HEADERS[@]}" \
      "${CONTENT_TYPE[@]}" \
      -d "$LB_SNAPSHOT" \
      "${SUPABASE_URL}/rest/v1/polymarket_leaderboard_snapshots" \
      2>/dev/null || echo "  WARNING: Failed to store leaderboard snapshot for $LB_ADDR"
  done
fi

echo ""
echo "=== CLI Portfolio Validation complete ==="
