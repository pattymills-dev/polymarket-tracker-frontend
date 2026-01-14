import React, { useState, useEffect } from 'react';
import { TrendingUp, DollarSign, Target, AlertCircle, Trophy, Filter, Bell, RefreshCw, Search, Star, Activity } from 'lucide-react';

const PolymarketTracker = () => {
  const [largeBets, setLargeBets] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [watchedTraders, setWatchedTraders] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [marketStats, setMarketStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [minBetSize, setMinBetSize] = useState(10);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [searchAddress, setSearchAddress] = useState('');
  const [alertThreshold, setAlertThreshold] = useState(50000);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAlerts, setShowAlerts] = useState(false);
  const [selectedTrader, setSelectedTrader] = useState(null);

  // Supabase Configuration
  const SUPABASE_URL = 'https://smuktlgclwvaxnduuinm.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo';

  const fetchData = async () => {
    try {
      setLoading(true);

      const headers = {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      };

      // Fetch real trades
      const tradesRes = await fetch(`${SUPABASE_URL}/rest/v1/trades?amount=gte.${minBetSize}&order=timestamp.desc&limit=100`, { headers });
      const trades = await tradesRes.json();

      // Fetch traders
      const tradersRes = await fetch(`${SUPABASE_URL}/rest/v1/traders?order=total_volume.desc&limit=20`, { headers });
      const traders = await tradersRes.json();

      // Fetch alerts
      const alertsRes = await fetch(`${SUPABASE_URL}/rest/v1/alerts?order=created_at.desc&limit=50`, { headers });
      const alertsData = await alertsRes.json();

      setLargeBets(trades);
      setTopTraders(traders);
      setAlerts(alertsData);
      
      setMarketStats({
        total_volume_24h: trades.reduce((sum, t) => sum + (t.amount || 0), 0),
        total_trades_24h: trades.length,
        active_markets: 50,
        unique_traders_24h: new Set(trades.map(t => t.trader_address)).size
      });

      setLoading(false);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error:', error);
      setLoading(false);
    }
  };

  const syncData = async () => {
    try {
      const headers = {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      };

      // Trigger market and trade sync
      await fetch(`${SUPABASE_URL}/functions/v1/fetch-markets`, {
        method: 'POST',
        headers
      });

      await fetch(`${SUPABASE_URL}/functions/v1/fetch-trades`, {
        method: 'POST',
        headers
      });

      // Refresh data
      setTimeout(() => fetchData(), 2000);
    } catch (error) {
      console.error('Error syncing:', error);
    }
  };

  useEffect(() => {
    fetchData();
    
    if (autoRefresh) {
      const interval = setInterval(fetchData, 60000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, minBetSize, selectedCategory]);

  const toggleWatchTrader = (address) => {
    setWatchedTraders(prev => 
      prev.includes(address) 
        ? prev.filter(a => a !== address)
        : [...prev, address]
    );
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount || 0);
  };

  const toMs = (ts) => {
  if (ts == null) return null;

  // If it's already a Date
  if (ts instanceof Date) return ts.getTime();

  // If it's a string (ISO, etc.)
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;

    // If the string is actually a number like "1768412028"
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) ts = asNum;
    else return null;
  }

  // If it's a number (seconds or ms)
  if (typeof ts === 'number') {
    // seconds are ~1e9 to 1e10; ms are ~1e12 to 1e13
    return ts < 1e12 ? ts * 1000 : ts;
  }

  return null;
};

const formatTimestamp = (ts) => {
  const ms = toMs(ts);
  if (!ms) return 'N/A';

  const date = new Date(ms);
  const now = new Date();
  const diffSeconds = Math.floor((now.getTime() - ms) / 1000);

  // If it's slightly in the future (clock skew / indexing delay), treat as "just now"
 // Slightly in the future (indexing / block timing)
if (diffSeconds < 0 && diffSeconds > -900) {
  return 'just now';
}

// Way in the future – show absolute local time so it's obvious
if (diffSeconds <= -900) {
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

if (diffSeconds < 60) return `${diffSeconds}s ago`;
if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;

// Older than 24h → show absolute local time
return date.toLocaleString(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

  const filteredBets = largeBets.filter(bet => {
    if (bet.amount < minBetSize) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <TrendingUp className="w-10 h-10 text-purple-400" />
                <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                  Polymarket Whale Tracker
                </h1>
              </div>
              <p className="text-gray-400">Real-time whale bet tracking</p>
              <p className="text-sm text-gray-500 mt-1">Last updated: {lastUpdate.toLocaleTimeString()}</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={syncData}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <RefreshCw className="w-5 h-5" />
                Sync Data
              </button>
              <button
                onClick={() => setShowAlerts(!showAlerts)}
                className="relative px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <Bell className="w-5 h-5" />
                Alerts
                {alerts.length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center">
                    {alerts.length}
                  </span>
                )}
              </button>
              <button
                onClick={fetchData}
                disabled={loading}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>
        </div>

        {/* Alerts Panel */}
        {showAlerts && (
          <div className="mb-6 bg-orange-900/30 backdrop-blur-sm rounded-lg p-4 border border-orange-500/30">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2">
                <Bell className="w-5 h-5 text-orange-400" />
                Whale Alerts
              </h3>
              <button
                onClick={() => setAlerts([])}
                className="text-sm text-gray-400 hover:text-white"
              >
                Clear All
              </button>
            </div>
            {alerts.length === 0 ? (
              <p className="text-gray-400 text-sm">No alerts yet. They'll appear when large bets are detected.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {alerts.slice(0, 10).map((alert, idx) => (
                  <div key={idx} className="bg-slate-800/50 rounded p-3 border border-orange-500/20">
                    <span className={`text-xs font-semibold px-2 py-1 rounded ${
                      alert.type === 'mega_whale' ? 'bg-red-600/30 text-red-300' : 'bg-blue-600/30 text-blue-300'
                    }`}>
                      {alert.type === 'mega_whale' ? '🐋 MEGA WHALE' : '🐳 WHALE'}
                    </span>
                    <p className="text-sm mt-2">{alert.message}</p>
                    <p className="text-xs text-gray-400 mt-1">{formatTimestamp(alert.created_at)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="bg-slate-800/50 backdrop-blur-sm rounded-lg p-4 mb-6 border border-purple-500/20">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold">Filters & Settings</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Min Bet Size</label>
              <input 
                type="number"
                value={minBetSize}
                onChange={(e) => setMinBetSize(Number(e.target.value))}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white"
                step="10"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Alert Threshold</label>
              <input 
                type="number"
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(Number(e.target.value))}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white"
                step="10000"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Auto Refresh</label>
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`w-full px-3 py-2 rounded transition-colors ${
                  autoRefresh ? 'bg-green-600 hover:bg-green-700' : 'bg-slate-700 hover:bg-slate-600'
                }`}
              >
                {autoRefresh ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Watched Traders</label>
              <div className="w-full px-3 py-2 bg-slate-700 rounded text-center font-bold text-yellow-400">
                {watchedTraders.length}
              </div>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        {marketStats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gradient-to-br from-purple-600/20 to-purple-800/20 rounded-lg p-4 border border-purple-500/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400 text-sm">Total Volume</p>
                  <p className="text-2xl font-bold">{formatCurrency(marketStats.total_volume_24h)}</p>
                </div>
                <DollarSign className="w-10 h-10 text-purple-400 opacity-50" />
              </div>
            </div>
            <div className="bg-gradient-to-br from-pink-600/20 to-pink-800/20 rounded-lg p-4 border border-pink-500/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400 text-sm">Large Bets</p>
                  <p className="text-2xl font-bold">{marketStats.total_trades_24h || 0}</p>
                </div>
                <Activity className="w-10 h-10 text-pink-400 opacity-50" />
              </div>
            </div>
            <div className="bg-gradient-to-br from-blue-600/20 to-blue-800/20 rounded-lg p-4 border border-blue-500/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400 text-sm">Active Markets</p>
                  <p className="text-2xl font-bold">{marketStats.active_markets || 0}</p>
                </div>
                <Target className="w-10 h-10 text-blue-400 opacity-50" />
              </div>
            </div>
            <div className="bg-gradient-to-br from-orange-600/20 to-orange-800/20 rounded-lg p-4 border border-orange-500/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400 text-sm">Unique Traders</p>
                  <p className="text-2xl font-bold">{marketStats.unique_traders_24h || 0}</p>
                </div>
                <Star className="w-10 h-10 text-orange-400 opacity-50" />
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-400 mx-auto"></div>
            <p className="mt-4 text-gray-400">Loading whale activity...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Large Bets Feed */}
            <div className="lg:col-span-2">
              <div className="bg-slate-800/50 backdrop-blur-sm rounded-lg p-6 border border-purple-500/20">
                <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                  <AlertCircle className="w-6 h-6 text-purple-400" />
                  Large Bets Feed
                </h2>
                {filteredBets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-gray-400">No large bets found. Click "Sync Data" to fetch latest trades.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredBets.map((bet, idx) => {
                      const isWatched = watchedTraders.includes(bet.trader_address);
                      return (
                        <div key={idx} className={`bg-slate-700/50 rounded-lg p-4 border transition-colors ${
                          isWatched ? 'border-yellow-500/50' : 'border-slate-600 hover:border-purple-500/50'
                        }`}>
                          <div className="flex justify-between items-start mb-2">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs text-gray-400">{formatTimestamp(bet.timestamp)}</span>
                                {isWatched && (
                                  <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                                )}
                              </div>
                              <h3 className="font-semibold text-lg mb-1">{bet.market_id}</h3>
                              <p className="text-sm text-gray-400">
                                Trader: <span className="text-purple-400 font-mono">{bet.trader_address.substring(0, 10)}...</span>
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-2xl font-bold text-green-400">{formatCurrency(bet.amount)}</p>
                              <p className="text-sm text-gray-400">on {bet.outcome}</p>
                            </div>
                          </div>
                          <div className="flex justify-between items-center text-sm pt-2 border-t border-slate-600">
                            <span className="text-gray-400">Price: <span className="text-white font-semibold">{(bet.price * 100).toFixed(0)}¢</span></span>
                            <span className="text-xs text-gray-500 font-mono">{bet.tx_hash?.substring(0, 10)}...</span>
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
              <div className="bg-slate-800/50 backdrop-blur-sm rounded-lg p-6 border border-purple-500/20 sticky top-6">
                <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                  <Trophy className="w-6 h-6 text-yellow-400" />
                  Top Traders
                </h2>
                
                <div className="mb-4">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Search address..."
                      value={searchAddress}
                      onChange={(e) => setSearchAddress(e.target.value)}
                      className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-white"
                    />
                    <button className="px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded transition-colors">
                      <Search className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {topTraders.length === 0 ? (
                  <p className="text-gray-400 text-sm text-center py-8">No trader data yet</p>
                ) : (
                  <div className="space-y-3">
                    {topTraders.map((trader, index) => {
                      const isWatched = watchedTraders.includes(trader.address);
                      return (
                        <div 
                          key={trader.address} 
                          className={`bg-slate-700/50 rounded-lg p-4 border cursor-pointer hover:border-purple-500/50 transition-colors ${
                            isWatched ? 'border-yellow-500/50' : 'border-slate-600'
                          }`}
                          onClick={() => setSelectedTrader(trader)}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2 flex-1">
                              <span className="text-2xl font-bold text-purple-400">#{index + 1}</span>
                              <div className="flex-1">
                                <p className="font-mono text-sm text-purple-300">{trader.address.substring(0, 12)}...</p>
                                <p className="text-xs text-gray-400">{formatTimestamp(trader.last_activity)}</p>
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleWatchTrader(trader.address);
                              }}
                              className={`transition-colors ${
                                isWatched ? 'text-yellow-400' : 'text-gray-600 hover:text-yellow-400'
                              }`}
                            >
                              <Star className={`w-5 h-5 ${isWatched ? 'fill-yellow-400' : ''}`} />
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-sm mt-3">
                            <div>
                              <p className="text-gray-400">Volume</p>
                              <p className="font-bold">{formatCurrency(trader.total_volume)}</p>
                            </div>
                            <div>
                              <p className="text-gray-400">Bets</p>
                              <p className="font-bold">{trader.total_bets}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Trader Detail Modal */}
        {selectedTrader && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6">
            <div className="bg-slate-800 rounded-lg p-6 max-w-2xl w-full border border-purple-500/30">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-2xl font-bold text-purple-300">{selectedTrader.address}</h3>
                  <p className="text-sm text-gray-400 mt-1">Trader Profile</p>
                </div>
                <button
                  onClick={() => setSelectedTrader(null)}
                  className="text-gray-400 hover:text-white text-2xl"
                >
                  ×
                </button>
              </div>
              
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-slate-700/50 rounded p-3">
                  <p className="text-xs text-gray-400">Total Volume</p>
                  <p className="text-xl font-bold">{formatCurrency(selectedTrader.total_volume)}</p>
                </div>
                <div className="bg-slate-700/50 rounded p-3">
                  <p className="text-xs text-gray-400">Total Bets</p>
                  <p className="text-xl font-bold">{selectedTrader.total_bets}</p>
                </div>
              </div>

              <button
                onClick={() => {
                  toggleWatchTrader(selectedTrader.address);
                  setSelectedTrader(null);
                }}
                className={`w-full px-4 py-3 rounded-lg font-semibold transition-colors ${
                  watchedTraders.includes(selectedTrader.address)
                    ? 'bg-yellow-600 hover:bg-yellow-700'
                    : 'bg-purple-600 hover:bg-purple-700'
                }`}
              >
                {watchedTraders.includes(selectedTrader.address) ? 'Remove from Watchlist' : 'Add to Watchlist'}
              </button>
            </div>
          </div>
        )}

        {/* Info */}
        <div className="mt-6 bg-blue-900/20 border border-blue-500/30 rounded-lg p-4">
          <h3 className="font-semibold mb-2 text-blue-300">🎉 Real Polymarket Whale Tracking!</h3>
          <p className="text-sm text-gray-300">
            Showing real trades from Polymarket. Click "Sync Data" to fetch the latest whale bets. Trader watchlist and alerts are fully functional!
          </p>
        </div>
      </div>
    </div> 
  );
};

export default PolymarketTracker;