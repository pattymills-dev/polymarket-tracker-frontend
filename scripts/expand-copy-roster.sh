#!/bin/bash
set -e

SUPABASE_URL="https://smuktlgclwvaxnduuinm.supabase.co"

if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "Error: SUPABASE_SERVICE_ROLE_KEY environment variable not set"
  echo "Please set it with: export SUPABASE_SERVICE_ROLE_KEY=your_key_here"
  exit 1
fi

echo "🔄 Expanding copy trader roster from top 3 to top 10..."
echo ""

# Step 1: Disable all current traders
echo "1️⃣  Disabling all existing traders..."
curl -s -X PATCH "$SUPABASE_URL/rest/v1/copy_traders" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{"enabled": false}' > /dev/null

echo "✓ Disabled all traders"
echo ""

# Step 2: Get eligible traders (top P/L with quality gates)
echo "2️⃣  Finding top 10 eligible traders..."

cutoff_date=$(date -u -d '48 hours ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-48H +"%Y-%m-%dT%H:%M:%SZ")
activity_cutoff=$(date -u -d '7 days ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-7d +"%Y-%m-%dT%H:%M:%SZ")

# Get top 20 by P/L with quality filters
traders_json=$(curl -s "$SUPABASE_URL/rest/v1/trader_rankings?select=trader_address,realized_pl_30d,realized_roi_30d,resolved_trades_30d,confidence_30d,copyable_rank_30d&realized_roi_30d=gte.0.20&resolved_trades_30d=gte.25&confidence_30d=gte.2&copyable_rank_30d=lte.25&computed_at=gte.$cutoff_date&order=realized_pl_30d.desc&limit=20" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY")

# Parse and check each for recent activity
eligible_traders=()
count=0

echo "$traders_json" | jq -r '.[] | @base64' | while IFS= read -r trader_b64; do
  if [ $count -ge 10 ]; then
    break
  fi

  trader=$(echo "$trader_b64" | base64 --decode)
  address=$(echo "$trader" | jq -r '.trader_address')

  # Check for recent trades
  recent_trades=$(curl -s "$SUPABASE_URL/rest/v1/trades?select=id&wallet_address=eq.$address&timestamp=gte.$activity_cutoff&limit=1" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY")

  trade_count=$(echo "$recent_trades" | jq 'length')

  if [ "$trade_count" -gt 0 ]; then
    echo "$trader" >> /tmp/eligible_traders.json
    count=$((count + 1))

    pl=$(echo "$trader" | jq -r '.realized_pl_30d')
    roi=$(echo "$trader" | jq -r '.realized_roi_30d')
    rank=$(echo "$trader" | jq -r '.copyable_rank_30d')
    echo "  ✓ $address (P/L: \$$pl, ROI: ${roi}%, Rank: $rank)"
  fi
done

# Read eligible traders
if [ ! -f /tmp/eligible_traders.json ]; then
  echo "❌ No eligible traders found meeting all criteria"
  exit 1
fi

eligible_count=$(wc -l < /tmp/eligible_traders.json)
echo ""
echo "✓ Found $eligible_count eligible traders"
echo ""

# Step 3: Enable each trader (and upsert if missing)
echo "3️⃣  Enabling traders..."

while IFS= read -r trader; do
  address=$(echo "$trader" | jq -r '.trader_address')
  rank=$(echo "$trader" | jq -r '.copyable_rank_30d')

  # Upsert trader with config
  curl -s -X POST "$SUPABASE_URL/rest/v1/copy_traders" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates,return=minimal" \
    -d "{
      \"trader_address\": \"$address\",
      \"enabled\": true,
      \"copy_factor\": 0.1,
      \"min_usd\": 10,
      \"max_usd\": 500,
      \"max_trader_exposure_pct\": 0.25,
      \"per_trader_cooldown_minutes\": 5,
      \"min_price\": 0.30,
      \"max_price\": 0.85,
      \"price_penalty\": 0.01,
      \"allow_sells\": false,
      \"cooldown_minutes\": 1,
      \"max_copyable_rank_30d\": 25,
      \"min_realized_roi_30d\": 0.20,
      \"min_realized_pl_30d\": 200,
      \"min_median_bet_30d\": 25,
      \"min_resolved_trades_30d\": 25,
      \"min_confidence_30d\": 2.0,
      \"max_open_positions\": 8,
      \"previous_rank_30d\": $rank
    }" > /dev/null 2>&1 || {
      # If upsert fails, try update
      curl -s -X PATCH "$SUPABASE_URL/rest/v1/copy_traders?trader_address=eq.$address" \
        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Content-Type: application/json" \
        -H "Prefer: return=minimal" \
        -d "{\"enabled\": true, \"previous_rank_30d\": $rank, \"min_price\": 0.30, \"max_price\": 0.85}" > /dev/null
    }

  echo "  ✓ Enabled $address"
done < /tmp/eligible_traders.json

echo ""
echo "✅ Migration complete!"
echo ""

# Step 4: Show final roster
echo "📋 Active Copy Trading Roster:"
echo ""

roster=$(curl -s "$SUPABASE_URL/rest/v1/copy_traders?select=trader_address&enabled=eq.true" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY")

echo "$roster" | jq -r '.[] | .trader_address' | while read -r address; do
  stats=$(curl -s "$SUPABASE_URL/rest/v1/trader_rankings?select=realized_pl_30d,realized_roi_30d,copyable_rank_30d&trader_address=eq.$address" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" | jq '.[0]')

  pl=$(echo "$stats" | jq -r '.realized_pl_30d // 0')
  roi=$(echo "$stats" | jq -r '.realized_roi_30d // 0')
  rank=$(echo "$stats" | jq -r '.copyable_rank_30d // 999')

  printf "  %s (Rank #%d, P/L: \$%d, ROI: %.1f%%)\n" "$address" "$rank" "$pl" "$roi"
done

# Cleanup
rm -f /tmp/eligible_traders.json

echo ""
echo "🎯 Next sync (in ~5 min) will start copying from these traders"
