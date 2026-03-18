import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface SkipAnalysis {
  skip_reason: string;
  count: number;
  total_volume: number;
  avg_price: number;
  unique_traders: number;
  unique_markets: number;
  avg_staleness_minutes: number;
}

Deno.serve(async (req) => {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const url = new URL(req.url);
  const hours = parseInt(url.searchParams.get('hours') || '24');
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Get enabled copy traders
  const { data: enabledTraders } = await supabase
    .from('copy_traders')
    .select('trader_address')
    .eq('enabled', true);

  if (!enabledTraders?.length) {
    return new Response(JSON.stringify({ error: 'No enabled traders' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 400,
    });
  }

  const traderAddresses = enabledTraders.map(t => t.trader_address);

  // Get their recent trades
  const { data: trades } = await supabase
    .from('trades')
    .select(`
      id,
      wallet_address,
      market_id,
      amount,
      price,
      timestamp,
      markets (
        title,
        end_date_iso,
        resolved,
        winning_outcome
      )
    `)
    .in('wallet_address', traderAddresses)
    .gte('timestamp', cutoff)
    .gte('amount', 250)
    .order('timestamp', { ascending: false });

  if (!trades?.length) {
    return new Response(JSON.stringify({
      message: 'No qualifying trades found',
      hours,
      trader_count: traderAddresses.length
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get what was actually copied
  const { data: paperPositions } = await supabase
    .from('paper_positions')
    .select('source_trade_id')
    .in('source_trade_id', trades.map(t => t.id))
    .eq('portfolio_id', 'copy');

  const copiedTradeIds = new Set(paperPositions?.map(p => p.source_trade_id) || []);

  // Analyze skipped trades
  const MIN_PRICE = 0.45;
  const MAX_PRICE = 0.80;
  const MAX_STALE_MINUTES = 30;

  const skipped: Array<{
    trade: any;
    reason: string;
    staleness_minutes: number;
  }> = [];

  const now = Date.now();

  for (const trade of trades) {
    if (copiedTradeIds.has(trade.id)) continue;

    const tradeTime = new Date(trade.timestamp).getTime();
    const stalenessMinutes = (now - tradeTime) / (1000 * 60);

    let reason = 'unknown';

    if (stalenessMinutes > MAX_STALE_MINUTES) {
      reason = 'stale_trade';
    } else if (trade.price < MIN_PRICE) {
      reason = 'below_min_price';
    } else if (trade.price > MAX_PRICE) {
      reason = 'above_max_price';
    } else if (trade.markets?.resolved) {
      reason = 'already_resolved';
    } else if (trade.markets?.end_date_iso && new Date(trade.markets.end_date_iso) < new Date()) {
      reason = 'market_closed';
    } else {
      reason = 'other';
    }

    skipped.push({
      trade,
      reason,
      staleness_minutes: stalenessMinutes,
    });
  }

  // Aggregate by skip reason
  const reasonMap = new Map<string, SkipAnalysis>();

  for (const { trade, reason, staleness_minutes } of skipped) {
    if (!reasonMap.has(reason)) {
      reasonMap.set(reason, {
        skip_reason: reason,
        count: 0,
        total_volume: 0,
        avg_price: 0,
        unique_traders: new Set<string>() as any,
        unique_markets: new Set<string>() as any,
        avg_staleness_minutes: 0,
      });
    }

    const stats = reasonMap.get(reason)!;
    stats.count++;
    stats.total_volume += trade.amount;
    (stats.unique_traders as Set<string>).add(trade.wallet_address);
    (stats.unique_markets as Set<string>).add(trade.market_id);
    stats.avg_staleness_minutes += staleness_minutes;
  }

  // Finalize aggregations
  const analysis: SkipAnalysis[] = [];
  for (const [reason, stats] of reasonMap.entries()) {
    analysis.push({
      skip_reason: reason,
      count: stats.count,
      total_volume: Math.round(stats.total_volume),
      avg_price: stats.total_volume / stats.count,
      unique_traders: (stats.unique_traders as Set<string>).size,
      unique_markets: (stats.unique_markets as Set<string>).size,
      avg_staleness_minutes: Math.round(stats.avg_staleness_minutes / stats.count),
    });
  }

  // Sort by volume
  analysis.sort((a, b) => b.total_volume - a.total_volume);

  const summary = {
    hours,
    total_qualifying_trades: trades.length,
    copied_trades: copiedTradeIds.size,
    skipped_trades: skipped.length,
    copy_rate: `${((copiedTradeIds.size / trades.length) * 100).toFixed(1)}%`,
    analysis,
  };

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
});
