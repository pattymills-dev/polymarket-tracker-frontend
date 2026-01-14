import React, { useState, useEffect } from 'react';
import { TrendingUp, DollarSign, Target, AlertCircle, Trophy, Filter, Bell, RefreshCw, Search, Star, BarChart3, Activity } from 'lucide-react';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const PolymarketTracker = () => {
  const [largeBets, setLargeBets] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [watchedTraders, setWatchedTraders] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [marketStats, setMarketStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [minBetSize, setMinBetSize] = useState(10000);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [searchAddress, setSearchAddress] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [selectedTrader, setSelectedTrader] = useState(null);

  // Supabase Configuration
  const SUPABASE_URL = 'https://smuktlgclwvaxnduuinm.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo';

  // Fetch data from Supabase
  const fetchData = async () => {
    try {
      setLoading(true);

      const headers = {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      };

      // Fetch markets directly from database
      const marketsRes = await fetch(`${SUPABASE_URL}/rest/v1/markets?order=updated_at.desc&limit=50`, { headers });
      const markets = await marketsRes.json();

      // Display as bets
      const displayBets = markets.map((market, idx) => ({
        id: market.id,
        markets: {
          question: market.question,
          category: market.category
        },
        trader_address: 'N/A',
        amount: market.volume || 0,
        outcome: 'Active',
        price: 0,
        timestamp: market.updated_at,
        tx_hash: market.id
      }));

      setLargeBets(displayBets);
      
      setMarketStats({
        total_volume_24h: 0,
        total_trades_24h: 0,
        active_markets: markets.length,
        unique_traders_24h: 0
      });

      setLoading(false);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error:', error);
      setLoading(false);
    }
  };

  // Trigger data sync
  const syncData = async () => {
    try {
      const headers = {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      };

      // Trigger market sync
      await fetch(`${SUPABASE_URL}/functions/v1/fetch-markets`, {
        method: 'POST',
        headers
      });

      // Refresh data
      await fetchData();
    } catch (error) {
      console.error('Error syncing data:', error);
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
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount || 0);
  };

  const formatTimestamp = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const filteredBets = largeBets.filter(bet => {
    if (selectedCategory === 'all') return true;
    return bet.markets?.category === selectedCategory;
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
              <p className="text-gray-400">Real-time tracking powered by Supabase</p>
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

        {/* Filters */}
        <div className="bg-slate-800/50 backdrop-blur-sm rounded-lg p-4 mb-6 border border-purple-500/20">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold">Filters & Settings</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Category</label>
              <select 
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white"
              >
                <option value="all">All Markets</option>
                <option value="politics">Politics</option>
                <option value="sports">Sports</option>
                <option value="crypto">Crypto</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Min Volume</label>
              <input 
                type="number"
                value={minBetSize}
                onChange={(e) => setMinBetSize(Number(e.target.value))}
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white"
                step="5000"
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
          </div>
        </div>

        {/* Stats Cards */}
        {marketStats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gradient-to-br from-purple-600/20 to-purple-800/20 rounded-lg p-4 border border-purple-500/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400 text-sm">Total Volume (24h)</p>
                  <p className="text-2xl font-bold">{formatCurrency(marketStats.total_volume_24h)}</p>
                </div>
                <DollarSign className="w-10 h-10 text-purple-400 opacity-50" />
              </div>
            </div>
            <div className="bg-gradient-to-br from-pink-600/20 to-pink-800/20 rounded-lg p-4 border border-pink-500/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400 text-sm">Trades (24h)</p>
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
            <p className="mt-4 text-gray-400">Loading markets...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6">
            {/* Markets Feed */}
            <div>
              <div className="bg-slate-800/50 backdrop-blur-sm rounded-lg p-6 border border-purple-500/20">
                <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                  <AlertCircle className="w-6 h-6 text-purple-400" />
                  Active Markets
                </h2>
                {filteredBets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-gray-400">No markets found. Click "Sync Data" to fetch latest markets.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredBets.map((bet, idx) => (
                      <div key={idx} className="bg-slate-700/50 rounded-lg p-4 border border-slate-600 hover:border-purple-500/50 transition-colors">
                        <div className="mb-2">
                          <span className="px-2 py-0.5 bg-purple-600/30 rounded text-xs font-semibold uppercase">
                            {bet.markets?.category || 'other'}
                          </span>
                        </div>
                        <h3 className="font-semibold text-lg mb-2">{bet.markets?.question || 'Market'}</h3>
                        <div className="flex justify-between items-center text-sm text-gray-400">
                          <span>Volume: {formatCurrency(bet.amount)}</span>
                          <span>{formatTimestamp(bet.timestamp)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Info Note */}
        <div className="mt-6 bg-blue-900/20 border border-blue-500/30 rounded-lg p-4">
          <h3 className="font-semibold mb-2 text-blue-300">🎉 Live Polymarket Data!</h3>
          <p className="text-sm text-gray-300">
            Showing current active markets from Polymarket. Click "Sync Data" to fetch the latest markets from Polymarket's API.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PolymarketTracker;