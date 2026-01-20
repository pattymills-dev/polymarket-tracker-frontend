# SELL Trades Implementation Checklist

## ✅ Completed (Frontend)

- [x] Added side filter (All / Buys / Sells) to Large Bets section
- [x] Added `getSideLabel()` helper function for consistent styling
- [x] Updated bet cards to show BUY/SELL badges with color coding
- [x] Added descriptive text: "Bought $X of Yes" / "Sold $X of No"
- [x] Display shares count in bet cards
- [x] Updated trader detail modal with consistent BUY/SELL styling
- [x] Added shares display in trader trade history
- [x] Added tooltips explaining P/L calculation includes sells
- [x] Added footer note about BUY/SELL tracking
- [x] Tested build - no errors

## ⏳ TODO (Backend - Your Action Required)

### 1. Update Supabase Edge Function: fetch-trades

**File**: `supabase/functions/fetch-trades/index.ts` (or similar path)

- [ ] Add audit logging for BUY vs SELL counts
- [ ] Map `t.size` or `t.shares` from API to `shares` column
- [ ] Map `t.side` from API to `side` column (uppercase BUY/SELL)
- [ ] Calculate `amount = shares * price` as notional
- [ ] Improve deduping if needed (composite key: tx_hash + outcome + side)
- [ ] Return audit info in response:
  ```typescript
  {
    success: true,
    fetched: 500,
    stored: 485,
    buyCount: 320,
    sellCount: 165,
    sellExamples: [...]
  }
  ```

**Reference**: See `SELL_TRADES_IMPLEMENTATION.md` Section 1

### 2. Update Database Schema

**Where**: Supabase SQL Editor

- [ ] Run schema migrations from `sql_migrations.sql` (Lines 1-50)
- [ ] Verify `shares` column exists: `\d trades`
- [ ] Verify `side` column exists: `\d trades`
- [ ] Check indexes created successfully
- [ ] Verify backfill worked: `SELECT COUNT(*) FROM trades WHERE shares IS NULL;`

**Reference**: See `sql_migrations.sql` Section 1

### 3. Verify Sells Exist in Database

**Where**: Supabase SQL Editor

- [ ] Run sanity check queries from `sql_migrations.sql` (Lines 51-110)
- [ ] Verify side distribution shows both BUY and SELL
- [ ] Verify large sells query returns results
- [ ] Verify traders with both buys and sells exist

Expected output:
```
side | trade_count | total_volume
-----|-------------|-------------
BUY  | 320         | $1,234,567
SELL | 165         | $567,890
```

If `SELL` count is 0, the Polymarket API is not returning sells. You may need to:
- Check API endpoint parameters
- Try different Polymarket API endpoints
- Review Polymarket API documentation

**Reference**: See `sql_migrations.sql` Section 2

### 4. Create/Update Database Views and Functions

**Where**: Supabase SQL Editor

- [ ] Create `trader_market_positions` view from `sql_migrations.sql` (Lines 112-165)
- [ ] Test the view returns data with sells
- [ ] Update `calculate_trader_performance` function from `sql_migrations.sql` (Lines 167-300)
- [ ] Test the function returns profitability data
- [ ] Verify function output includes `realized_pl` and `settlement_pl`

**Reference**: See `sql_migrations.sql` Sections 3-4

### 5. Test End-to-End

**Frontend Testing**:

- [ ] Run `npm start` to start dev server
- [ ] Click "Sync Polymarket" button
- [ ] Open browser console (F12)
- [ ] Verify response shows `buyCount` and `sellCount` > 0
- [ ] Click "Refresh" button to reload data
- [ ] Verify "Large bets" feed shows both BUY and SELL badges
- [ ] Test filter buttons (All / Buys / Sells)
- [ ] Verify trade descriptions show "Bought/Sold" with amounts
- [ ] Click on a trader card
- [ ] Verify trader detail modal shows BUY/SELL badges in trade history
- [ ] Verify shares are displayed when available

**Backend Testing**:

- [ ] Check Supabase logs for Edge Function execution
- [ ] Verify no errors in function logs
- [ ] Verify trades table has recent data
- [ ] Run performance queries from `sql_migrations.sql` Section 5

### 6. Validate P/L Calculations

- [ ] Find a trader who has both buys and sells
- [ ] Manually calculate their P/L:
  - Realized P/L = sell_proceeds - (sell_shares * avg_buy_price)
  - Settlement P/L = (winning shares * $1) - (losing shares * avg_buy_price)
  - Total P/L = Realized + Settlement
- [ ] Compare with database query results
- [ ] Verify profitability_rate accounts for both components

## 🚨 Troubleshooting

### Issue: No sells showing in UI after implementation

**Diagnosis**:
1. Check sync response in browser console for `sellCount`
2. If `sellCount: 0`, run database query:
   ```sql
   SELECT side, COUNT(*) FROM trades GROUP BY side;
   ```
3. If database shows sells, it's a frontend filter issue
4. If database shows no sells, it's a backend ingestion issue

**Solutions**:
- Frontend issue: Check `sideFilter` state and `filteredBets` logic in App.js:360-372
- Backend issue: Check Edge Function is storing `side` correctly
- API issue: Polymarket may not be returning sells - check API endpoint

### Issue: Sells exist but P/L is wrong

**Diagnosis**:
1. Check `calculate_trader_performance` function
2. Verify `shares` column is populated
3. Check `avg_buy_price` calculation

**Solutions**:
- Run `SELECT * FROM trader_market_positions WHERE sell_shares > 0 LIMIT 10;`
- Verify realized_pl calculation logic
- Check if winning_outcome matches outcome correctly

### Issue: Duplicate trades appearing

**Diagnosis**:
- Multiple rows with same tx_hash but different outcomes/sides

**Solutions**:
- Update deduping strategy in Edge Function
- Use composite unique constraint: (tx_hash, outcome, side)
- See `SELL_TRADES_IMPLEMENTATION.md` Section 1

## 📊 Success Criteria

You'll know it's working when:

1. ✅ "Sync Polymarket" returns `sellCount > 0`
2. ✅ Database query shows SELL trades exist
3. ✅ UI displays both BUY and SELL badges with different colors
4. ✅ Filter buttons work (can view only sells)
5. ✅ Trader profitability reflects sells (some traders profitable even with losing outcomes)
6. ✅ Trade descriptions show "Sold $X of Y"
7. ✅ Shares are displayed in trade cards
8. ✅ Trader detail modal shows BUY/SELL badges consistently

## 📚 Reference Files

- `SELL_TRADES_IMPLEMENTATION.md` - Detailed backend implementation guide
- `SELL_TRADES_SUMMARY.md` - High-level overview and testing guide
- `sql_migrations.sql` - All SQL queries to run in Supabase
- `src/App.js` - Updated frontend with SELL support

## 🎯 Quick Start

**Fastest path to get this working:**

1. Run all SQL migrations from `sql_migrations.sql` in Supabase SQL Editor
2. Update your Edge Function with code from `SELL_TRADES_IMPLEMENTATION.md` Section 1
3. Deploy the Edge Function
4. Click "Sync Polymarket" in the UI
5. Check browser console for `sellCount`
6. If `sellCount > 0`, click "Refresh" and verify UI shows sells
7. If `sellCount = 0`, review Polymarket API response for sells

## ⏭️ Future Enhancements

Consider adding later:
- [ ] Realized P/L column in trader cards
- [ ] Settlement P/L column in trader cards
- [ ] Net shares display in trader positions
- [ ] Buy/Sell volume charts
- [ ] Filter by outcome + side (e.g., "YES Buys only")
- [ ] Export trade history with sells

