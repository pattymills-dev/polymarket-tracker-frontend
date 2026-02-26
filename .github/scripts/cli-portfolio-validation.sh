#!/usr/bin/env bash
set -euo pipefail

# CLI Portfolio Validation & Leaderboard Cross-Reference (v2 — Hybrid Approach)
# Computes aggregate stats from CLI ground-truth data for use by refresh functions.
# Stores aggregates instead of raw JSON to save Supabase storage.
#
# Called by sync-trades.yml after refresh-top-traders.
# Rotates through top traders (5 per run), fetching ground-truth
# portfolio data from the Polymarket CLI.
#
# Environment variables (set by workflow):
#   SUPABASE_URL — Supabase project URL
#   SUPABASE_KEY — Service role key

SUPABASE_URL="${SUPABASE_URL:?SUPABASE_URL not set}"
SUPABASE_KEY="${SUPABASE_KEY:?SUPABASE_KEY not set}"

AUTH_HEADERS=(-H "Authorization: Bearer ${SUPABASE_KEY}" -H "apikey: ${SUPABASE_KEY}")
CONTENT_TYPE=(-H "Content-Type: application/json")
TRADERS_PER_RUN=5
CLI_TIMEOUT=25

echo "=== Polymarket CLI Portfolio Validation v2 ==="
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

    # ── Open Positions ──
    # Try with --count flag first (more positions), fall back to default
    POSITIONS_JSON=$(timeout ${CLI_TIMEOUT}s polymarket -o json data positions "$ADDR" --count 500 2>/dev/null || \
      timeout ${CLI_TIMEOUT}s polymarket -o json data positions "$ADDR" 2>/dev/null || echo "[]")

    OPEN_COUNT=0
    OPEN_VALUE=0
    if echo "$POSITIONS_JSON" | jq -e 'type == "array"' &>/dev/null; then
      OPEN_COUNT=$(echo "$POSITIONS_JSON" | jq 'length')
      # Sum current_value across all open positions
      OPEN_VALUE=$(echo "$POSITIONS_JSON" | jq \
        '[.[] | (.current_value // "0" | tostring | tonumber)] | add // 0' 2>/dev/null || echo "0")
    fi

    # ── Closed Positions ──
    CLOSED_JSON=$(timeout ${CLI_TIMEOUT}s polymarket -o json data closed-positions "$ADDR" --count 500 2>/dev/null || \
      timeout ${CLI_TIMEOUT}s polymarket -o json data closed-positions "$ADDR" 2>/dev/null || echo "[]")

    CLOSED_COUNT=0
    CLOSED_PNL=0
    CLI_WINS=0
    CLI_LOSSES=0
    if echo "$CLOSED_JSON" | jq -e 'type == "array"' &>/dev/null; then
      CLOSED_COUNT=$(echo "$CLOSED_JSON" | jq 'length')

      # Try multiple field names for P/L (CLI JSON isn't fully documented)
      CLOSED_PNL=$(echo "$CLOSED_JSON" | jq '
        [.[] | (
          .cash_pnl // .pnl // .profit // .realized_pnl // "0"
          | tostring | tonumber
        )] | add // 0
      ' 2>/dev/null || echo "0")

      # Count wins (positive P/L) and losses (negative P/L)
      CLI_WINS=$(echo "$CLOSED_JSON" | jq '
        [.[] | select((
          .cash_pnl // .pnl // .profit // .realized_pnl // "0"
          | tostring | tonumber
        ) > 0)] | length
      ' 2>/dev/null || echo "0")

      CLI_LOSSES=$(echo "$CLOSED_JSON" | jq '
        [.[] | select((
          .cash_pnl // .pnl // .profit // .realized_pnl // "0"
          | tostring | tonumber
        ) < 0)] | length
      ' 2>/dev/null || echo "0")
    fi

    # Compute delta and win rate
    PL_DELTA=$(echo "$CLOSED_PNL $OUR_PL" | awk '{printf "%.2f", $1 - $2}')
    CLI_RESOLVED=$((CLI_WINS + CLI_LOSSES))
    CLI_WIN_RATE="0"
    if [ "$CLI_RESOLVED" -gt 0 ]; then
      CLI_WIN_RATE=$(echo "$CLI_WINS $CLI_RESOLVED" | awk '{printf "%.4f", $1 / $2}')
    fi

    echo "  Open: $OPEN_COUNT (value: \$$OPEN_VALUE) | Closed: $CLOSED_COUNT"
    echo "  CLI P/L: \$$CLOSED_PNL | W/L: ${CLI_WINS}/${CLI_LOSSES} (${CLI_WIN_RATE})"
    echo "  Our P/L: \$$OUR_PL | Delta: \$$PL_DELTA"

    # Store snapshot with aggregates (NO raw positions JSON — saves storage)
    SNAPSHOT=$(jq -n \
      --arg addr "$ADDR" \
      --argjson oc "${OPEN_COUNT:-0}" \
      --argjson ov "${OPEN_VALUE:-0}" \
      --argjson cc "${CLOSED_COUNT:-0}" \
      --argjson cpnl "${CLOSED_PNL:-0}" \
      --argjson cw "${CLI_WINS:-0}" \
      --argjson cl "${CLI_LOSSES:-0}" \
      --argjson cwr "${CLI_WIN_RATE:-0}" \
      --argjson opl "${OUR_PL:-0}" \
      --argjson delta "${PL_DELTA:-0}" \
      '{
        trader_address: $addr,
        open_positions_count: $oc,
        open_value_usd: $ov,
        closed_positions_count: $cc,
        closed_pnl_usd: $cpnl,
        cli_wins: $cw,
        cli_losses: $cl,
        cli_win_rate: $cwr,
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

# Try multiple command variations (CLI flag format isn't fully documented)
LEADERBOARD_JSON="[]"
TRIED_CMDS=""
for PERIOD_FLAG in "--period month" "--period=month" ""; do
  for COUNT_FLAG in "--count 25" "--limit 25" ""; do
    CMD="polymarket -o json data leaderboard ${PERIOD_FLAG} ${COUNT_FLAG}"
    CMD=$(echo "$CMD" | xargs)  # Trim extra spaces
    TRIED_CMDS="${TRIED_CMDS}\n  ${CMD}"
    RESULT=$(timeout ${CLI_TIMEOUT}s $CMD 2>/dev/null || echo "")
    if echo "$RESULT" | jq -e 'type == "array" and length > 0' &>/dev/null 2>&1; then
      LEADERBOARD_JSON="$RESULT"
      echo "Leaderboard fetched with: $CMD"
      break 2
    fi
  done
done

LB_COUNT=$(echo "$LEADERBOARD_JSON" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo "0")
echo "Leaderboard entries: $LB_COUNT"

if [ "$LB_COUNT" -eq 0 ]; then
  echo "No leaderboard data returned"
  echo "Tried commands:${TRIED_CMDS}"
  # Log the actual CLI help for debugging
  echo "--- CLI data leaderboard help ---"
  timeout 10s polymarket data leaderboard --help 2>&1 | head -30 || echo "(no help available)"
  echo "--- CLI data help ---"
  timeout 10s polymarket data --help 2>&1 | head -30 || echo "(no help available)"
else
  # Get all our tracked trader addresses for cross-reference (batch query)
  OUR_ADDRESSES=$(curl -sf \
    "${AUTH_HEADERS[@]}" \
    "${SUPABASE_URL}/rest/v1/trader_rankings?select=trader_address,copyable_rank_30d" \
    2>/dev/null || echo "[]")

  echo "$LEADERBOARD_JSON" | jq -c '.[]' | head -25 | while IFS= read -r LB_ENTRY; do
    # Try multiple possible field names for the address
    LB_ADDR=$(echo "$LB_ENTRY" | jq -r '.address // .wallet // .trader // .proxyWallet // .proxy_wallet // empty' 2>/dev/null || echo "")
    if [ -z "$LB_ADDR" ]; then
      # Log the entry structure for debugging
      echo "  SKIP: no address field found in: $(echo "$LB_ENTRY" | jq -c 'keys')"
      continue
    fi

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

# ──────────────────────────────────────────────
# Phase 3: Cleanup old snapshots (data retention)
# ──────────────────────────────────────────────
echo ""
echo "--- Phase 3: Data retention cleanup ---"

CLEANUP_RESULT=$(curl -sf -X POST \
  "${AUTH_HEADERS[@]}" \
  "${CONTENT_TYPE[@]}" \
  -d '{}' \
  "${SUPABASE_URL}/rest/v1/rpc/cleanup_old_cli_snapshots" \
  2>/dev/null || echo "cleanup_failed")

if [ "$CLEANUP_RESULT" = "cleanup_failed" ]; then
  echo "WARNING: Retention cleanup failed (function may not exist yet)"
else
  echo "Cleanup complete: removed $CLEANUP_RESULT old snapshots"
fi

echo ""
echo "=== CLI Portfolio Validation v2 complete ==="
