import React, { useEffect, useMemo, useState } from 'react';
import {
  TrendingUp,
  DollarSign,
  Target,
  AlertCircle,
  Trophy,
  Filter,
  Bell,
  RefreshCw,
  Search,
  Star,
  Activity
} from 'lucide-react';

const PolymarketTracker = () => {
  const [largeBets, setLargeBets] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [watchedTraders, setWatchedTraders] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [marketStats, setMarketStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const [selectedCategory, setSelectedCategory] = useState('all'); // placeholder for future
  const [minBetSize, setMinBetSize] = useState(10);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [searchAddress, setSearchAddress] = useState('');
  const [alertThreshold, setAlertThreshold] = useState(50000);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAlerts, setShowAlerts] = useState(false);
  const [selectedTrader, setSelectedTrader] = useState(null);

  // Supabase Configuration
  const SUPABASE_URL = 'https://smuktlgclwvaxnduuinm.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo';

  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    }),
    [SUPABASE_ANON_KEY]
  );

  const formatCurrency = (amount) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(amount || 0));

  const toMs = (ts) => {
  if (ts == null) return null;

  // Date object
  if (ts instanceof Date) return ts.getTime();

  // Numeric string or ISO string
  if (typeof ts === "string") {
    // If it's an ISO-like string but missing timezone ("Z" or +/-hh:mm),
    // treat it as UTC by appending "Z".
    const looksIso = /^\d{4}-\d{2}-\d{2}T/.test(ts);
    const hasTz = /Z$|[+-]\d{2}:\d{2}$/.test(ts);
    const normalized = looksIso && !hasTz ? `${ts}Z` : ts;

    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;

    // If the string is actually a number like "1768412028"
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) ts = asNum;
    else return null;
  }

  // Number (seconds or ms)
  if (typeof ts === "number") {
    return ts < 1e12 ? ts * 1000 : ts; // seconds -> ms
  }

  return null;
};

const formatTimestamp = (ts) => {
  const ms = toMs(ts);
  if (!ms) return "N/A";

  const nowMs = Date.now();
  const diffSeconds = Math.floor((nowMs - ms) / 1000);
  const date = new Date(ms);

  // Future timestamps: never show "-123s ago"
  if (diffSeconds < 0) {
    // If it's only slightly ahead (indexing / block timing), call it "just now"
    if (diffSeconds > -300) return "just now";

    // Otherwise show absolute local time (so it’s obvious)
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;

  // Older than 24h -> show absolute local time
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

  const fetchData = async () => {
    try {
      setLoading(true);

      const tradesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?amount=gte.${minBetSize}&order=timestamp.desc&limit=100`,
        { headers }
      );
      const tradesJson = await tradesRes.json();

      if (!tradesRes.ok) {
        console.error('Trades error:', tradesJson);
        setLargeBets([]);
        return;
      }

      const tradersRes = await fetch(
        `${SUPABASE_URL}/rest/v1/traders?order=total_volume.desc&limit=20`,
        { headers }
      );
      const tradersJson = await tradersRes.json();

      if (!tradersRes.ok) {
        console.error('Traders error:', tradersJson);
        setTopTraders([]);
      } else {
        setTopTraders(Array.isArray(tradersJson) ? tradersJson : []);
      }

      const alertsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/alerts?order=created_at.desc&limit=50`,
        { headers }
      );
      const alertsJson = await alertsRes.json();

      if (!alertsRes.ok) {
        console.error('Alerts error:', alertsJson);
        setAlerts([]);
      } else {
        setAlerts(Array.isArray(alertsJson) ? alertsJson : []);
      }

      const trades = Array.isArray(tradesJson) ? tradesJson : [];
      setLargeBets(trades);

      const totalVol = trades.reduce((sum, t) => sum + Number(t.amount || 0), 0);
      setMarketStats({
        total_volume_24h: totalVol,
        total_trades_24h: trades.length,
        active_markets: 0,
        unique_traders_24h: new Set(trades.map((t) => t.trader_address)).size
      });

      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const syncData = async () => {
    try {
      const fnHeaders = {
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      };

      const marketsResp = await fetch(`${SUPABASE_URL}/functions/v1/fetch-markets`, {
        method: 'POST',
        headers: fnHeaders
      });

      const tradesResp = await fetch(`${SUPABASE_URL}/functions/v1/fetch-trades`, {
        method: 'POST',
        headers: fnHeaders
      });

      if (!marketsResp.ok) {
        console.error('fetch-markets failed', marketsResp.status, await marketsResp.text());
      }
      if (!tradesResp.ok) {
        console.error('fetch-trades failed', tradesResp.status, await tradesResp.text());
      }

      setTimeout(() => fetchData(), 1500);
    } catch (error) {
      console.error('Error syncing:', error);
    }
  };

  useEffect(() => {
    fetchData();
    if (!autoRefresh) return undefined;

    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, minBetSize, selectedCategory]);

  const toggleWatchTrader = (address) => {
    setWatchedTraders((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address]
    );
  };

  const filteredBets = useMemo(() => {
    return (largeBets || []).filter((bet) => Number(bet.amount || 0) >= Number(minBetSize || 0));
  }, [largeBets, minBetSize]);

  const visibleTraders = useMemo(() => {
    const q = (searchAddress || '').trim().toLowerCase();
    if (!q) return topTraders || [];
    return (topTraders || []).filter((t) => (t.address || '').toLowerCase().includes(q));
  }, [topTraders, searchAddress]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-slate-200" />
                </div>
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-slate-100">
                    Polymarket Tracker
                  </h1>
                  <p className="text-sm text-slate-400 mt-1">
                    Large trade activity and trader watchlists
                  </p>
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-3">
                Last updated: {lastUpdate.toLocaleTimeString()}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={syncData}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-md transition-colors flex items-center gap-2 text-sm font-medium"
              >
                <RefreshCw className="w-4 h-4" />
                Sync
              </button>

              <button
                onClick={() => setShowAlerts((v) => !v)}
                className="relative px-4 py-2 bg-slate-900 hover:bg-slate-800 rounded-md transition-colors flex items-center gap-2 text-sm font-medium border border-slate-800"
              >
                <Bell className="w-4 h-4" />
                Alerts
                {alerts.length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-cyan-600 text-slate-950 text-xs rounded-full w-6 h-6 flex items-center justify-center font-semibold">
                    {alerts.length}
                  </span>
                )}
              </button>

              <button
                onClick={fetchData}
                disabled={loading}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 rounded-md transition-colors flex items-center gap-2 text-sm font-medium border border-slate-800 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>
        </div>

        {/* Alerts Panel */}
        {showAlerts && (
          <div className="mb-6 bg-slate-900 rounded-lg border border-slate-800 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2 text-sm">
                <Bell className="w-4 h-4 text-slate-300" />
                Whale alerts
              </h3>
              <button
                onClick={() => setAlerts([])}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Clear
              </button>
            </div>

            {alerts.length === 0 ? (
              <p className="text-slate-400 text-sm">
                No alerts yet. They’ll appear when large trades are detected.
              </p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {alerts.slice(0, 20).map((alert, idx) => {
                  const isMega = alert.type === 'mega_whale';
                  return (
                    <div key={idx} className="bg-slate-950 rounded-md border border-slate-800 p-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[11px] font-semibold px-2 py-1 rounded-md border ${
                            isMega
                              ? 'bg-rose-500/10 text-rose-200 border-rose-500/20'
                              : 'bg-amber-500/10 text-amber-200 border-amber-500/20'
                          }`}
                        >
                          {isMega ? 'MEGA WHALE' : 'WHALE'}
                        </span>
                        <span className="text-xs text-slate-500">
                          {formatTimestamp(alert.created_at)}
                        </span>
                      </div>
                      <p className="text-sm mt-2 text-slate-200">{alert.message}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="bg-slate-900 rounded-lg border border-slate-800 p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-300" />
            <h3 className="font-semibold text-sm">Filters</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-2">Min bet size (USD)</label>
              <input
                type="number"
                value={minBetSize}
                onChange={(e) => setMinBetSize(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-600/40"
                step="10"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-2">Alert threshold (USD)</label>
              <input
                type="number"
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-600/40"
                step="10000"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                (Used by backend alerting logic, if configured.)
              </p>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-2">Auto refresh</label>
              <button
                onClick={() => setAutoRefresh((v) => !v)}
                className={`w-full px-3 py-2 rounded-md text-sm font-medium border transition-colors ${
                  autoRefresh
                    ? 'bg-cyan-600 hover:bg-cyan-700 border-cyan-500/30 text-slate-950'
                    : 'bg-slate-950 hover:bg-slate-900 border-slate-800 text-slate-200'
                }`}
              >
                {autoRefresh ? 'Enabled' : 'Disabled'}
              </button>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-2">Watched traders</label>
              <div className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-center font-semibold text-slate-100">
                {watchedTraders.length}
              </div>
            </div>
          </div>
        </div>

        {/* Stats */}
        {marketStats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-900 rounded-lg border border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-400">Total volume (current feed)</p>
                  <p className="text-2xl font-semibold mt-1">
                    {formatCurrency(marketStats.total_volume_24h)}
                  </p>
                </div>
                <DollarSign className="w-8 h-8 text-slate-400" />
              </div>
            </div>

            <div className="bg-slate-900 rounded-lg border border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-400">Large bets</p>
                  <p className="text-2xl font-semibold mt-1">
                    {marketStats.total_trades_24h || 0}
                  </p>
                </div>
                <Activity className="w-8 h-8 text-slate-400" />
              </div>
            </div>

            <div className="bg-slate-900 rounded-lg border border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-400">Active markets</p>
                  <p className="text-2xl font-semibold mt-1">
                    {marketStats.active_markets || 0}
                  </p>
                </div>
                <Target className="w-8 h-8 text-slate-400" />
              </div>
            </div>

            <div className="bg-slate-900 rounded-lg border border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-400">Unique traders</p>
                  <p className="text-2xl font-semibold mt-1">
                    {marketStats.unique_traders_24h || 0}
                  </p>
                </div>
                <Star className="w-8 h-8 text-slate-400" />
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-600 mx-auto" />
            <p className="mt-4 text-slate-400 text-sm">Loading activity…</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Large Bets Feed */}
            <div className="lg:col-span-2">
              <div className="bg-slate-900 rounded-lg border border-slate-800 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-slate-300" />
                    Large bets
                  </h2>
                  <div className="text-xs text-slate-500">
                    Showing {filteredBets.length} trades (≥ {formatCurrency(minBetSize)})
                  </div>
                </div>

                {filteredBets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400 text-sm">
                      No trades above this threshold yet. Click “Sync” to fetch new trades.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredBets.map((bet, idx) => {
                      const isWatched = watchedTraders.includes(bet.trader_address);
                      return (
                        <div
                          key={idx}
                          className={`bg-slate-950 rounded-lg border p-4 transition-colors ${
                            isWatched
                              ? 'border-cyan-500/30'
                              : 'border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-xs text-slate-500">
                                  {formatTimestamp(bet.timestamp)}
                                </span>
                                {isWatched && (
                                  <span className="inline-flex items-center gap-1 text-xs text-cyan-300">
                                    <Star className="w-3.5 h-3.5 fill-cyan-300 text-cyan-300" />
                                    Watching
                                  </span>
                                )}
                              </div>

                              <a
  href={bet.market_slug ? `https://polymarket.com/market/${bet.market_slug}` : undefined}
  target="_blank"
  rel="noreferrer"
  className="font-semibold text-lg mb-1 hover:underline block"
>
  {bet.market_title || bet.market_slug || bet.market_id}
</a>

                              <p className="text-sm text-slate-400 mt-2">
                                Trader:{' '}
                                <span className="font-mono text-slate-200">
                                  {bet.trader_address?.slice(0, 10)}…
                                </span>
                              </p>
                            </div>

                            <div className="text-right shrink-0">
                              <p className="text-xl font-semibold text-slate-100">
                                {formatCurrency(bet.amount)}
                              </p>
                              <p className="text-xs text-slate-400 mt-1">
                                Outcome: <span className="text-slate-200">{bet.outcome}</span>
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center justify-between text-xs mt-3 pt-3 border-t border-slate-800">
                            <span className="text-slate-500">
                              Price:{' '}
                              <span className="text-slate-200 font-medium">
                                {Number(bet.price) ? `${(Number(bet.price) * 100).toFixed(0)}¢` : '—'}
                              </span>
                            </span>
                            <span className="text-slate-600 font-mono">
                              {bet.tx_hash ? `${bet.tx_hash.slice(0, 10)}…` : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Top Traders */}
            <div className="lg:col-span-1">
              <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 sticky top-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-slate-300" />
                    Top traders
                  </h2>
                </div>

                <div className="mb-4">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Search address…"
                      value={searchAddress}
                      onChange={(e) => setSearchAddress(e.target.value)}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-600/40"
                    />
                    <button className="px-3 py-2 bg-slate-950 hover:bg-slate-900 rounded-md border border-slate-800 transition-colors">
                      <Search className="w-4 h-4 text-slate-300" />
                    </button>
                  </div>
                </div>

                {visibleTraders.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No trader data yet</p>
                ) : (
                  <div className="space-y-3">
                    {visibleTraders.map((trader, index) => {
                      const isWatched = watchedTraders.includes(trader.address);
                      return (
                        <div
                          key={trader.address}
                          className={`bg-slate-950 rounded-lg p-4 border cursor-pointer transition-colors ${
                            isWatched
                              ? 'border-cyan-500/30'
                              : 'border-slate-800 hover:border-slate-700'
                          }`}
                          onClick={() => setSelectedTrader(trader)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-semibold text-slate-300">
                                #{index + 1}
                              </span>
                              <div className="min-w-0">
                                <p className="font-mono text-sm text-slate-100 truncate">
                                  {trader.address?.slice(0, 12)}…
                                </p>
                                <p className="text-xs text-slate-500 mt-1">
                                  {formatTimestamp(trader.last_activity)}
                                </p>
                              </div>
                            </div>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleWatchTrader(trader.address);
                              }}
                              className={`transition-colors ${
                                isWatched ? 'text-cyan-300' : 'text-slate-600 hover:text-slate-300'
                              }`}
                              aria-label="Toggle watchlist"
                            >
                              <Star
                                className={`w-5 h-5 ${
                                  isWatched ? 'fill-cyan-300 text-cyan-300' : ''
                                }`}
                              />
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-sm mt-3">
                            <div>
                              <p className="text-xs text-slate-500">Volume</p>
                              <p className="font-semibold text-slate-100">
                                {formatCurrency(trader.total_volume)}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-slate-500">Bets</p>
                              <p className="font-semibold text-slate-100">{trader.total_bets}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-500">
                  Tip: click a trader to view their profile and add/remove from watchlist.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Trader Detail Modal */}
        {selectedTrader && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6">
            <div className="bg-slate-900 rounded-lg p-6 max-w-2xl w-full border border-slate-800">
              <div className="flex items-start justify-between mb-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-slate-100 break-all">
                    {selectedTrader.address}
                  </h3>
                  <p className="text-sm text-slate-400 mt-1">Trader profile</p>
                </div>
                <button
                  onClick={() => setSelectedTrader(null)}
                  className="text-slate-400 hover:text-slate-200 text-2xl leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-slate-950 rounded-md p-3 border border-slate-800">
                  <p className="text-xs text-slate-500">Total volume</p>
                  <p className="text-xl font-semibold text-slate-100 mt-1">
                    {formatCurrency(selectedTrader.total_volume)}
                  </p>
                </div>
                <div className="bg-slate-950 rounded-md p-3 border border-slate-800">
                  <p className="text-xs text-slate-500">Total bets</p>
                  <p className="text-xl font-semibold text-slate-100 mt-1">
                    {selectedTrader.total_bets}
                  </p>
                </div>
              </div>

              <button
                onClick={() => {
                  toggleWatchTrader(selectedTrader.address);
                  setSelectedTrader(null);
                }}
                className={`w-full px-4 py-3 rounded-md font-semibold transition-colors border ${
                  watchedTraders.includes(selectedTrader.address)
                    ? 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-100'
                    : 'bg-cyan-600 hover:bg-cyan-700 border-cyan-500/30 text-slate-950'
                }`}
              >
                {watchedTraders.includes(selectedTrader.address)
                  ? 'Remove from watchlist'
                  : 'Add to watchlist'}
              </button>
            </div>
          </div>
        )}

        {/* Footer note */}
        <div className="mt-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <p className="text-sm text-slate-300">
            Data is pulled from your Supabase tables. If something looks stale, hit “Sync” then
            “Refresh.”
          </p>
        </div>
      </div>
    </div>
  );
};

export default PolymarketTracker;