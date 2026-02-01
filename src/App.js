import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  TrendingUp,
  DollarSign,
  Target,
  AlertCircle,
  Trophy,
  Bell,
  Search,
  Star,
  Activity,
  Coins,
  Copy,
  Check,
  ExternalLink,
  Send,
  Anchor,
  Navigation
} from 'lucide-react';
import { useTheme } from './ThemeContext';

const PolymarketTracker = () => {
  const { isRetro, toggleTheme } = useTheme();
  const [largeBets, setLargeBets] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [watchedTraders, setWatchedTraders] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [marketStats, setMarketStats] = useState(null);
  const [loading, setLoading] = useState(true);

  // const [selectedCategory, setSelectedCategory] = useState('all'); // placeholder for future
  const [minBetSize] = useState(5000); // UI filter (DB already filters to $5k+)
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [searchAddress, setSearchAddress] = useState('');
  const [traderSortBy, setTraderSortBy] = useState('total_pl'); // 'profitability', 'win_rate', 'total_pl' - default to P/L for meaningful rankings
  const [showAlerts, setShowAlerts] = useState(false);
  const [showTipJar, setShowTipJar] = useState(false);
  const [copiedWallet, setCopiedWallet] = useState(false);
  const tipJarRef = useRef(null);
  const [selectedTrader, setSelectedTrader] = useState(null);
  const [traderTrades, setTraderTrades] = useState([]);
  const [loadingTrades, setLoadingTrades] = useState(false);

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

  // Heat map color coding for bet amounts
  const getBetAmountColor = (amount) => {
    const num = Number(amount || 0);
    if (num >= 100000) return 'text-rose-400 font-bold';      // Mega Whale
    if (num >= 50000) return 'text-orange-400 font-semibold'; // Whale
    if (num >= 10000) return 'text-amber-400 font-medium';    // Large
    return 'text-slate-100';
  };

  const getBetBorderColor = (amount) => {
    const num = Number(amount || 0);
    if (num >= 100000) return 'border-rose-500/40 bg-rose-500/5';   // Mega Whale
    if (num >= 50000) return 'border-orange-500/40 bg-orange-500/5'; // Whale
    if (num >= 10000) return 'border-amber-500/30 bg-amber-500/5';   // Large
    return 'border-slate-800 hover:border-slate-700';
  };

  const getOutcomeColor = (outcome) => {
    if (!outcome) return 'text-slate-400';
    const normalized = outcome.toLowerCase();
    if (normalized.includes('yes')) return 'text-emerald-400';
    if (normalized.includes('no')) return 'text-rose-400';
    return 'text-cyan-400';
  };

  const getBetSizeLabel = (amount) => {
    const num = Number(amount || 0);
    if (num >= 100000) return { label: '🐋 MEGA WHALE', color: 'bg-rose-500/20 text-rose-300 border-rose-500/50' };
    if (num >= 50000) return { label: '🐋 WHALE', color: 'bg-orange-500/20 text-orange-300 border-orange-500/50' };
    if (num >= 10000) return { label: 'LARGE', color: 'bg-amber-500/20 text-amber-300 border-amber-500/50' };
    return null; // No label for trades under $10k
  };

  const getSideLabel = (side) => {
    const normalizedSide = (side || 'BUY').toUpperCase();
    if (normalizedSide === 'SELL') {
      return {
        label: 'SELL',
        color: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
        textColor: 'text-amber-400',
        verb: 'Sold'
      };
    }
    return {
      label: 'BUY',
      color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50',
      textColor: 'text-cyan-400',
      verb: 'Bought'
    };
  };

  const toMs = (ts) => {
  if (ts == null) return null;

  // Date object
  if (ts instanceof Date) return ts.getTime();

  // String
  if (typeof ts === "string") {
    let s = ts.trim();

    // If Postgres-style "YYYY-MM-DD HH:MM:SS" (no timezone), normalize to ISO.
    // We assume it's UTC because your backend creates ISO strings from epoch seconds (UTC).
    // Supabase may drop the "T" and "Z" depending on column type/format.
    const looksPg = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s);
    if (looksPg) {
      s = s.replace(" ", "T");
    }

    // If it's ISO-like but missing timezone, treat as UTC by appending "Z"
    const looksIso = /^\d{4}-\d{2}-\d{2}T/.test(s);
    const hasTz = /Z$|[+-]\d{2}:\d{2}$/.test(s);
    if (looksIso && !hasTz) s = `${s}Z`;

    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return parsed;

    // Numeric string fallback
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) ts = asNum;
    else return null;
  }

  // Number (seconds or ms)
  if (typeof ts === "number") {
    return ts < 1e12 ? ts * 1000 : ts;
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

     const FEED_LIMIT = 500;
     const MIN_TRADE_AMOUNT = 5000; // Only fetch trades >= $5k

const tradesRes = await fetch(
  `${SUPABASE_URL}/rest/v1/trades?amount=gte.${MIN_TRADE_AMOUNT}&order=timestamp.desc&limit=${FEED_LIMIT}`,
  { headers }
);
      const tradesJson = await tradesRes.json();

      if (!tradesRes.ok) {
        console.error('Trades error:', tradesJson);
        setMarketStats(null);
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

      // Fetch whale stats (>= $10k, last 24h)
const statsRes = await fetch(
  `${SUPABASE_URL}/rest/v1/rpc/whale_stats_24h`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({ min_amount: 10000 }),
  }
);

const statsArr = await statsRes.json();
const stats = statsArr?.[0] ?? null;

      // Get count of active (unresolved) markets with recent activity
      const marketsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?select=market_id&timestamp=gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}`,
        { headers }
      );
      const marketsJson = await marketsRes.json();
      const activeMarkets = marketsRes.ok && Array.isArray(marketsJson)
        ? new Set(marketsJson.map(t => t.market_id)).size
        : 0;

      const trades = Array.isArray(tradesJson) ? tradesJson : [];
      setLargeBets(trades);

      if (!statsRes.ok) {
  console.error("Stats error:", statsArr);
}

setMarketStats({
  // DB-computed: >= $10k, last 24h (does NOT depend on minBetSize)
  total_volume_24h: stats?.total_volume ?? 0,
  total_trades_24h: stats?.total_trades ?? 0,
  unique_traders_24h: stats?.unique_traders ?? 0,

  // Count of unique markets with trades in last 24h
  active_markets: activeMarkets,
});

      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  // Load watchlist from database on startup
  useEffect(() => {
    const loadWatchlist = async () => {
      try {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/watchlist?select=trader_address`,
          { headers }
        );
        const data = await response.json();
        if (response.ok && Array.isArray(data)) {
          setWatchedTraders(data.map(w => w.trader_address));
        }
      } catch (error) {
        console.error('Error loading watchlist:', error);
      }
    };
    loadWatchlist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchData();

    // Auto-refresh every 60 seconds (always enabled)
    const interval = setInterval(() => {
      fetchData();
      fetchProfitability();
    }, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minBetSize]);

  const toggleWatchTrader = async (address) => {
    const isCurrentlyWatched = watchedTraders.includes(address);

    // Optimistically update UI
    setWatchedTraders((prev) =>
      isCurrentlyWatched ? prev.filter((a) => a !== address) : [...prev, address]
    );

    // Sync to database for alert matching
    try {
      if (isCurrentlyWatched) {
        // Remove from watchlist
        await fetch(
          `${SUPABASE_URL}/rest/v1/watchlist?trader_address=eq.${address}`,
          { method: 'DELETE', headers }
        );
      } else {
        // Add to watchlist
        await fetch(
          `${SUPABASE_URL}/rest/v1/watchlist`,
          {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ trader_address: address })
          }
        );
      }
    } catch (error) {
      console.error('Error syncing watchlist:', error);
      // Revert on error
      setWatchedTraders((prev) =>
        isCurrentlyWatched ? [...prev, address] : prev.filter((a) => a !== address)
      );
    }
  };

  const fetchTraderTrades = async (address) => {
    setLoadingTrades(true);
    try {
      // Fetch trades first
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?trader_address=eq.${address}&order=timestamp.desc&limit=100`,
        { headers }
      );
      const trades = await response.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        setTraderTrades([]);
        return;
      }

      // Get unique market IDs from trades
      const marketIds = [...new Set(trades.map(t => t.market_id).filter(Boolean))];

      // Fetch market resolution data separately
      const marketsResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/markets?id=in.(${marketIds.join(',')})&select=id,resolved,winning_outcome`,
        { headers }
      );
      const markets = await marketsResponse.json();
      const marketMap = new Map((Array.isArray(markets) ? markets : []).map(m => [m.id, m]));

      // Merge market resolution data into trades
      const tradesWithResolution = trades.map(trade => {
        const market = marketMap.get(trade.market_id);
        return {
          ...trade,
          market_resolved: market?.resolved || false,
          winning_outcome: market?.winning_outcome || null
        };
      });

      setTraderTrades(tradesWithResolution);
    } catch (error) {
      console.error('Error fetching trader trades:', error);
      setTraderTrades([]);
    } finally {
      setLoadingTrades(false);
    }
  };

  const filteredBets = useMemo(() => {
    return (largeBets || []).filter((bet) => Number(bet.amount || 0) >= Number(minBetSize || 0));
  }, [largeBets, minBetSize]);

  // Fetch trader profitability data
  const [profitabilityTraders, setProfitabilityTraders] = useState([]);

  const fetchProfitability = async () => {
    try {
      const headers = {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      };

      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/calculate_trader_performance`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ min_resolved_markets: 3 })  // Require at least 3 resolved markets for meaningful stats
        }
      );

      const data = await response.json();
      console.log('Profitability API response:', {
        status: response.status,
        ok: response.ok,
        dataLength: Array.isArray(data) ? data.length : 'not array',
        sampleData: Array.isArray(data) ? data.slice(0, 3) : data,
        firstTraderWins: data[0]?.wins,
        firstTraderLosses: data[0]?.losses,
        firstTraderWinRate: data[0]?.win_rate
      });

      if (response.ok && Array.isArray(data)) {
        // Map to match the existing trader card structure
        const mappedTraders = data.map(t => ({
          address: t.trader_address,
          total_volume: Number(t.total_buy_cost || 0) + Number(t.total_sell_proceeds || 0),
          total_bets: t.resolved_markets,
          resolved_markets: t.resolved_markets,
          wins: t.wins,
          losses: t.losses,
          win_rate: Number(t.win_rate || 0),
          profit_wins: t.profit_wins,
          profit_losses: t.profit_losses,
          profitability_rate: Number(t.profitability_rate || 0),
          total_pl: Number(t.total_pl || 0),
          avg_bet_size: Number(t.total_buy_cost || 0) / (t.resolved_markets || 1),
          unique_markets: t.resolved_markets,
          last_activity: Date.now() // placeholder
        }));
        console.log('Mapped profitability traders:', mappedTraders.length, mappedTraders);
        setProfitabilityTraders(mappedTraders);
      } else {
        console.error('Profitability API error:', data);
      }
    } catch (error) {
      console.error('Error fetching profitability:', error);
    }
  };

  useEffect(() => {
    fetchProfitability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close tip jar dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (tipJarRef.current && !tipJarRef.current.contains(event.target)) {
        setShowTipJar(false);
      }
    };

    if (showTipJar) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showTipJar]);

  // Calculate smart money metrics from recent trades (7-day fallback)
  const recentActiveTraders = useMemo(() => {
    if (!largeBets || largeBets.length === 0) return [];

    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

    // Group trades by trader address
    const traderMap = new Map();

    largeBets.forEach(bet => {
      const betTime = toMs(bet.timestamp);
      if (!betTime || betTime < sevenDaysAgo) return; // Only last 7 days

      const addr = bet.trader_address;
      if (!addr) return;

      if (!traderMap.has(addr)) {
        traderMap.set(addr, {
          address: addr,
          trades: [],
          total_volume: 0,
          total_bets: 0,
          avg_bet_size: 0,
          unique_markets: new Set(),
          last_activity: betTime
        });
      }

      const trader = traderMap.get(addr);
      trader.trades.push(bet);
      trader.total_volume += Number(bet.amount || 0);
      trader.total_bets += 1;
      trader.unique_markets.add(bet.market_id);
      if (betTime > trader.last_activity) {
        trader.last_activity = betTime;
      }
    });

    // Convert to array and calculate metrics
    const traders = Array.from(traderMap.values()).map(trader => ({
      address: trader.address,
      total_volume: trader.total_volume,
      total_bets: trader.total_bets,
      avg_bet_size: trader.total_volume / trader.total_bets,
      unique_markets: trader.unique_markets.size,
      last_activity: trader.last_activity,
      // Smart money score: combination of volume, bet size, and activity
      smart_score: (trader.total_volume / 1000) + (trader.avg_bet_size / 100) + (trader.total_bets * 2)
    }));

    // Sort by smart money score
    return traders.sort((a, b) => b.smart_score - a.smart_score).slice(0, 20);
  }, [largeBets]);

  const visibleTraders = useMemo(() => {
    const q = (searchAddress || '').trim().toLowerCase();

    // Top Performers: by P/L
    let tradersToShow = profitabilityTraders.length >= 5
      ? profitabilityTraders
      : recentActiveTraders.length > 0
        ? recentActiveTraders
        : topTraders || [];

    // Filter by search query
    if (q) {
      tradersToShow = tradersToShow.filter((t) => (t.address || '').toLowerCase().includes(q));
    }

    // Apply sorting
    if (profitabilityTraders.length >= 5) {
      tradersToShow = [...tradersToShow].sort((a, b) => {
        if (traderSortBy === 'profitability') {
          return (b.profitability_rate || 0) - (a.profitability_rate || 0);
        } else if (traderSortBy === 'win_rate') {
          return (b.win_rate || 0) - (a.win_rate || 0);
        } else if (traderSortBy === 'total_pl') {
          return (b.total_pl || 0) - (a.total_pl || 0);
        }
        return 0;
      });
    }

    return tradersToShow;
  }, [profitabilityTraders, recentActiveTraders, topTraders, searchAddress, traderSortBy]);

  // Unified console palette - no blue, green-biased darks
  const retroColors = {
    bg: '#060908',                        // Near-black, green cast
    surface: '#0b100d',                   // Recessed panels
    surfaceAlt: '#0e1410',                // Slightly raised
    border: 'rgba(90, 200, 140, 0.12)',   // Subtle green border
    borderHover: 'rgba(90, 200, 140, 0.25)',
    primary: '#5a8a6a',                   // Muted operational green
    bright: '#6ddb8a',                    // Phosphor green - emphasis only
    dim: '#3a5a48',                       // Secondary text
    accent: '#c9a84b',                    // Warm amber for warnings
    danger: '#b85c5c',                    // Muted red
    glow: 'rgba(109, 219, 138, 0.15)',    // Subtle glow
  };

  return (
    <div className={`min-h-screen ${isRetro ? 'retro-container' : 'bg-slate-950 text-slate-100 trading-grid-bg'}`}
         style={isRetro ? { backgroundColor: retroColors.bg, color: retroColors.primary, fontFamily: "'VT323', monospace" } : {}}>
      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${isRetro ? '' : 'bg-slate-900 border border-slate-800'}`}
                     style={isRetro ? { border: `1px solid ${retroColors.border}` } : {}}>
                  {isRetro ? (
                    <span style={{ color: retroColors.primary, fontSize: '1.25rem' }}>▓</span>
                  ) : (
                    <TrendingUp className="w-5 h-5 text-slate-200" />
                  )}
                </div>
                <div>
                  <h1 className={`text-3xl font-semibold tracking-tight ${isRetro ? '' : 'text-slate-100'}`}
                      style={isRetro ? { color: retroColors.bright, textShadow: 'none', letterSpacing: '0.05em' } : {}}>
                    {isRetro ? 'POLYMARKET TRACKER' : 'Polymarket Tracker'}
                  </h1>
                  <p className={`text-sm mt-1 ${isRetro ? '' : 'text-slate-400'}`}
                     style={isRetro ? { color: retroColors.dim } : {}}>
                    {isRetro ? '> WHALE ACTIVITY MONITOR' : 'Large trade activity and trader watchlists'}
                  </p>
                </div>
              </div>
              <p className={`text-xs mt-3 ${isRetro ? '' : 'text-slate-500'}`}
                 style={isRetro ? { color: retroColors.dim } : {}}>
                {isRetro ? `> LAST UPDATE: ${lastUpdate.toLocaleTimeString()}` : `Last updated: ${lastUpdate.toLocaleTimeString()}`}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {/* Alerts Button */}
              <button
                onClick={() => setShowAlerts((v) => !v)}
                className={`relative px-4 py-2 rounded-md transition-all flex items-center gap-2 text-sm font-medium border ${
                  isRetro
                    ? ''
                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800'
                }`}
                style={isRetro ? {
                  color: retroColors.primary,
                  border: `1px solid ${retroColors.dim}`,
                  background: 'transparent'
                } : {}}
                onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.bright, e.currentTarget.style.color = retroColors.bright, e.currentTarget.style.boxShadow = `0 0 8px rgba(124, 255, 155, 0.2)`)}
                onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.dim, e.currentTarget.style.color = retroColors.primary, e.currentTarget.style.boxShadow = 'none')}
              >
                <Bell className="w-4 h-4" />
                {isRetro ? 'ALERTS' : 'Alerts'}
                {alerts.length > 0 && (
                  <span className={`absolute -top-2 -right-2 text-xs rounded-full w-6 h-6 flex items-center justify-center font-semibold ${
                    isRetro ? '' : 'bg-cyan-600 text-slate-950'
                  }`}
                  style={isRetro ? { backgroundColor: retroColors.accent, color: retroColors.bg } : {}}>
                    {alerts.length}
                  </span>
                )}
              </button>

              {/* Telegram Bot Link */}
              <a
                href="https://t.me/sonarstack_bot"
                target="_blank"
                rel="noopener noreferrer"
                className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 text-sm font-medium border ${
                  isRetro
                    ? ''
                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800'
                }`}
                style={isRetro ? {
                  color: retroColors.primary,
                  border: `1px solid ${retroColors.dim}`,
                  background: 'transparent'
                } : {}}
                onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.bright, e.currentTarget.style.color = retroColors.bright, e.currentTarget.style.boxShadow = `0 0 8px rgba(124, 255, 155, 0.2)`)}
                onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.dim, e.currentTarget.style.color = retroColors.primary, e.currentTarget.style.boxShadow = 'none')}
              >
                <Send className="w-4 h-4" />
                {isRetro ? 'TELEGRAM BOT' : 'Telegram Bot'}
              </a>

              {/* Tip Jar Button */}
              <div className="relative" ref={tipJarRef}>
                <button
                  onClick={() => setShowTipJar((v) => !v)}
                  className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 text-sm font-medium border ${
                    isRetro
                      ? ''
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-800'
                  }`}
                  style={isRetro ? {
                    color: retroColors.primary,
                    border: `1px solid ${retroColors.dim}`,
                    background: 'transparent'
                  } : {}}
                  onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.bright, e.currentTarget.style.color = retroColors.bright, e.currentTarget.style.boxShadow = `0 0 8px rgba(124, 255, 155, 0.2)`)}
                  onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.dim, e.currentTarget.style.color = retroColors.primary, e.currentTarget.style.boxShadow = 'none')}
                >
                  <Coins className="w-4 h-4" style={isRetro ? { color: retroColors.accent } : {}} />
                  {isRetro ? 'TIP' : 'Tip'}
                </button>

                {showTipJar && (
                  <div className={`absolute right-0 mt-2 w-72 rounded-lg shadow-xl z-50 p-4 ${
                    isRetro ? '' : 'bg-slate-900 border border-slate-700'
                  }`}
                  style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}` } : {}}>
                    <div className={`text-sm mb-3 ${isRetro ? '' : 'text-slate-300'}`}
                         style={isRetro ? { color: retroColors.dim } : {}}>
                      {isRetro ? '> TIP YOUR OPERATOR:' : 'Tip your operator:'}
                    </div>

                    {/* Ko-fi Link */}
                    <a
                      href="https://ko-fi.com/pattymills"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center gap-3 p-3 rounded-lg transition-colors mb-3 ${
                        isRetro ? '' : 'bg-slate-800 hover:bg-slate-700'
                      }`}
                      style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}` } : {}}
                    >
                      <div className="w-8 h-8 bg-[#FF5E5B] rounded-lg flex items-center justify-center">
                        <span className="text-white text-lg">☕</span>
                      </div>
                      <div className="flex-1">
                        <div className={`font-medium ${isRetro ? '' : 'text-slate-100'}`}
                             style={isRetro ? { color: retroColors.primary } : {}}>Ko-fi</div>
                        <div className={`text-xs ${isRetro ? '' : 'text-slate-400'}`}
                             style={isRetro ? { color: retroColors.dim } : {}}>Buy me a coffee</div>
                      </div>
                      <ExternalLink className="w-4 h-4" style={isRetro ? { color: retroColors.dim } : {}} />
                    </a>

                    {/* Crypto Wallet */}
                    <div className={`p-3 rounded-lg ${
                      isRetro ? '' : 'bg-slate-800'
                    }`}
                    style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}` } : {}}>
                      <div className="flex items-center gap-3 mb-2">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                          isRetro ? '' : 'bg-gradient-to-br from-blue-500 to-purple-600'
                        }`}
                        style={isRetro ? { border: `1px solid ${retroColors.border}` } : {}}>
                          <span className="text-sm font-bold" style={isRetro ? { color: retroColors.primary } : {}}>Ξ</span>
                        </div>
                        <div className="flex-1">
                          <div className={`font-medium ${isRetro ? '' : 'text-slate-100'}`}
                               style={isRetro ? { color: retroColors.primary } : {}}>ETH / ERC-20</div>
                          <div className={`text-xs ${isRetro ? '' : 'text-slate-400'}`}
                               style={isRetro ? { color: retroColors.dim } : {}}>Send crypto directly</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <code className={`flex-1 text-xs px-2 py-1.5 rounded truncate ${
                          isRetro ? '' : 'bg-slate-900 text-slate-300'
                        }`}
                        style={isRetro ? { backgroundColor: retroColors.bg, color: retroColors.primary, border: `1px solid ${retroColors.border}` } : {}}>
                          0xF30BCb8d980dD3674dE9B64875E63260765a9472
                        </code>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText('0xF30BCb8d980dD3674dE9B64875E63260765a9472');
                            setCopiedWallet(true);
                            setTimeout(() => setCopiedWallet(false), 2000);
                          }}
                          className={`p-1.5 rounded transition-colors ${
                            isRetro ? '' : 'bg-slate-700 hover:bg-slate-600'
                          }`}
                          style={isRetro ? { border: `1px solid ${retroColors.dim}` } : {}}
                          title="Copy address"
                        >
                          {copiedWallet ? (
                            <Check className="w-4 h-4" style={isRetro ? { color: retroColors.bright } : {}} />
                          ) : (
                            <Copy className="w-4 h-4" style={isRetro ? { color: retroColors.dim } : {}} />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Theme Toggle - Far Right */}
              <button
                onClick={() => {
                  // Clear session storage when switching to Below Deck to show intro again
                  if (!isRetro) {
                    sessionStorage.removeItem('retro-boot-complete');
                    sessionStorage.removeItem('whale-interstitial-shown');
                  }
                  toggleTheme();
                }}
                className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 text-sm font-medium border ${
                  isRetro
                    ? ''
                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800'
                }`}
                style={isRetro ? {
                  color: retroColors.primary,
                  border: `1px solid ${retroColors.dim}`,
                  background: 'transparent'
                } : {}}
                onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.bright, e.currentTarget.style.color = retroColors.bright, e.currentTarget.style.boxShadow = `0 0 8px rgba(124, 255, 155, 0.2)`)}
                onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.dim, e.currentTarget.style.color = retroColors.primary, e.currentTarget.style.boxShadow = 'none')}
                title={isRetro ? 'Switch to Bridge View (clean UI)' : 'Switch to Below Deck (sonar theme)'}
              >
                {isRetro ? (
                  <>
                    <Navigation className="w-4 h-4" />
                    BRIDGE VIEW
                  </>
                ) : (
                  <>
                    <Anchor className="w-4 h-4 text-emerald-400" />
                    Below Deck
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Alerts Panel */}
        {showAlerts && (
          <div className={`mb-6 backdrop-blur rounded-lg p-4 ${
            isRetro
              ? ''
              : 'bg-slate-900/80 border border-amber-500/30 shadow-amber-500/10'
          }`}
          style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}` } : {}}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2 text-sm">
                <Bell className="w-4 h-4" style={isRetro ? { color: retroColors.accent } : {}} />
                <span style={isRetro ? { color: retroColors.accent } : {}}>
                  {isRetro ? '> SIGNAL INTERCEPTS' : 'Signal Alerts'}
                </span>
              </h3>
              <button
                onClick={() => setAlerts([])}
                className={`text-xs transition-colors ${
                  isRetro ? '' : 'text-slate-400 hover:text-slate-200'
                }`}
                style={isRetro ? { color: retroColors.dim } : {}}
              >
                {isRetro ? 'CLEAR' : 'Clear all'}
              </button>
            </div>

            {/* Alert Categories Legend */}
            <div className={`mb-4 p-3 rounded-lg text-xs ${
              isRetro ? '' : 'bg-slate-950/50'
            }`}
            style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}` } : {}}>
              <div className="font-medium mb-2" style={isRetro ? { color: retroColors.dim } : {}}>
                {isRetro ? '> ALERT CLASSIFICATIONS:' : 'Alert Types:'}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.primary}`, color: retroColors.primary } : {}}>TOP TRADER</span>
                  <span style={isRetro ? { color: retroColors.dim } : {}}>High-performing trader activity</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.primary}`, color: retroColors.primary } : {}}>WATCHLIST</span>
                  <span style={isRetro ? { color: retroColors.dim } : {}}>Traders you're tracking</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.accent}`, color: retroColors.accent } : {}}>WHALE</span>
                  <span style={isRetro ? { color: retroColors.dim } : {}}>Large position ($50k+)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.accent}`, color: retroColors.accent } : {}}>MEGA WHALE</span>
                  <span style={isRetro ? { color: retroColors.dim } : {}}>Massive position ($100k+)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.danger}`, color: retroColors.danger } : {}}>ISOLATED CONTACT</span>
                  <span style={isRetro ? { color: retroColors.dim } : {}}>Low-activity trader, outsized bet in thin market</span>
                </div>
              </div>
            </div>

            {alerts.length === 0 ? (
              <p className="text-sm" style={isRetro ? { color: retroColors.dim } : {}}>
                {isRetro
                  ? '> NO SIGNALS DETECTED. MONITORING...'
                  : 'No alerts yet. They\'ll appear when top traders, watchlist traders, or whales make trades.'}
              </p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {alerts.slice(0, 20).map((alert, idx) => {
                  const isTopTrader = alert.type === 'top_trader';
                  const isWatchlist = alert.type === 'watchlist';
                  const isMega = alert.type === 'mega_whale';
                  const isIsolatedContact = alert.type === 'isolated_contact';

                  // Dynamic styling based on alert type
                  const borderClass = isTopTrader
                    ? 'border-emerald-500/40 bg-emerald-500/5 shadow-emerald-500/20'
                    : isWatchlist
                      ? 'border-cyan-500/40 bg-cyan-500/5 shadow-cyan-500/20'
                      : isMega
                        ? 'border-rose-500/40 bg-rose-500/5 shadow-rose-500/20'
                        : isIsolatedContact
                          ? 'border-purple-500/40 bg-purple-500/5 shadow-purple-500/20'
                          : 'border-amber-500/40 bg-amber-500/5 shadow-amber-500/20';

                  const badgeClass = isTopTrader
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : isWatchlist
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                      : isMega
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 animate-pulse'
                        : isIsolatedContact
                          ? 'bg-purple-500/20 text-purple-300 border-purple-500/50 animate-pulse'
                          : 'bg-amber-500/20 text-amber-300 border-amber-500/50';

                  const badgeText = isTopTrader
                    ? '🏆 TOP TRADER'
                    : isWatchlist
                      ? '👀 WATCHLIST'
                      : isMega
                        ? '🐋 MEGA WHALE'
                        : isIsolatedContact
                          ? '📡 ISOLATED CONTACT'
                          : '🐋 WHALE';

                  // Build Polymarket URL from slug
                  // For sports bets, link to the game page; for others, link to the event
                  const buildPolymarketUrl = (slug) => {
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
                  };
                  const polymarketUrl = buildPolymarketUrl(alert.market_slug);

                  // Determine bet direction styling
                  const isBuy = !alert.side || alert.side === 'BUY';
                  const betBadgeClass = isBuy
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-rose-500/20 text-rose-300 border-rose-500/50';

                  return (
                    <div
                      key={idx}
                      className={`bg-slate-950 rounded-md border p-3 transition-all hover:scale-[1.02] ${borderClass} ${polymarketUrl ? 'cursor-pointer' : ''}`}
                      onClick={() => polymarketUrl && window.open(polymarketUrl, '_blank')}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-bold px-2 py-1 rounded border uppercase tracking-wide ${badgeClass}`}>
                          {badgeText}
                        </span>
                        {alert.outcome && (
                          <span className={`text-[10px] font-bold px-2 py-1 rounded border uppercase tracking-wide ${betBadgeClass}`}>
                            {isBuy ? '📈' : '📉'} {alert.side || 'BUY'} {alert.outcome}{alert.price ? ` @ ${Math.round(alert.price * 100)}¢` : ''}
                          </span>
                        )}
                        <span className="text-xs text-slate-500 font-mono">
                          {formatTimestamp(alert.created_at)}
                        </span>
                        {polymarketUrl && (
                          <span className="text-xs text-cyan-400 ml-auto">↗</span>
                        )}
                      </div>
                      <p className="text-sm mt-2 text-slate-200 font-medium">
                        ${alert.amount ? Math.round(alert.amount).toLocaleString() : '?'} on {alert.market_title || 'Unknown market'}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Stats */}
        {marketStats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-900/80 backdrop-blur rounded-lg border border-slate-700 p-4 hover:border-cyan-500/50 transition-all">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Last 24 hours</p>
                  <p className="text-xs text-slate-400 uppercase tracking-wide">Volume ≥ $10k</p>
                  <p className="text-2xl font-bold mt-1 font-mono text-cyan-400">
                    {formatCurrency(marketStats.total_volume_24h)}
                  </p>
                </div>
                <DollarSign className="w-8 h-8 text-cyan-500/40" />
              </div>
            </div>

            <div className="bg-slate-900/80 backdrop-blur rounded-lg border border-slate-700 p-4 hover:border-cyan-500/50 transition-all">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Last 24 hours</p>
                  <p className="text-xs text-slate-400 uppercase tracking-wide">Trades ≥ $10k</p>
                  <p className="text-2xl font-bold mt-1 font-mono text-cyan-400">
                    {marketStats.total_trades_24h || 0}
                  </p>
                </div>
                <Activity className="w-8 h-8 text-cyan-500/40" />
              </div>
            </div>

            <div className="bg-slate-900/80 backdrop-blur rounded-lg border border-slate-700 p-4 hover:border-cyan-500/50 transition-all">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Last 24 hours</p>
                  <p className="text-xs text-slate-400 uppercase tracking-wide">Active markets</p>
                  <p className="text-2xl font-bold mt-1 font-mono text-cyan-400">
                    {marketStats.active_markets || 0}
                  </p>
                </div>
                <Target className="w-8 h-8 text-cyan-500/40" />
              </div>
            </div>

            <div className="bg-slate-900/80 backdrop-blur rounded-lg border border-slate-700 p-4 hover:border-cyan-500/50 transition-all">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Last 24 hours</p>
                  <p className="text-xs text-slate-400 uppercase tracking-wide">Traders ≥ $10k</p>
                  <p className="text-2xl font-bold mt-1 font-mono text-cyan-400">
                    {marketStats.unique_traders_24h || 0}
                  </p>
                </div>
                <Star className="w-8 h-8 text-cyan-500/40" />
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
              <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 flex flex-col h-[1200px]">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-slate-300" />
                    Large bets
                  </h2>
                  <div className="text-xs text-slate-500">
                    {filteredBets.length} trades (≥ $5,000)
                  </div>
                </div>

                {filteredBets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400 text-sm">
                      No trades above $5,000 yet. Data syncs automatically every few minutes.
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto pr-2 space-y-2">
                    {filteredBets.map((bet, idx) => {
                      const isWatched = watchedTraders.includes(bet.trader_address);
                      const sizeLabel = getBetSizeLabel(bet.amount);
                      const sideInfo = getSideLabel(bet.side);
                      return (
                        <div
                          key={idx}
                          className={`bg-slate-950 rounded-lg border p-3 transition-all hover:shadow-lg ${
                            isWatched
                              ? 'border-cyan-500/30 shadow-cyan-500/10'
                              : getBetBorderColor(bet.amount)
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <span className="text-xs text-slate-500 font-mono">
                                  {formatTimestamp(bet.timestamp)}
                                </span>
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${sideInfo.color} uppercase tracking-wide`}>
                                  {sideInfo.label}
                                </span>
                                {sizeLabel && (
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${sizeLabel.color} uppercase tracking-wide`}>
                                    {sizeLabel.label}
                                  </span>
                                )}
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
  className="font-semibold text-base mb-1 hover:text-cyan-400 hover:underline block transition-colors line-clamp-2"
>
  {bet.market_title || bet.market_slug || bet.market_id}
</a>

                              <p className="text-xs mt-1">
                                <span className={sideInfo.textColor}>{sideInfo.verb} {formatCurrency(bet.amount)}</span>
                                <span className="text-slate-400"> of </span>
                                <span className={getOutcomeColor(bet.outcome)}>{bet.outcome}</span>
                              </p>

                              <p className="text-xs text-slate-400 mt-1.5">
                                Trader:{' '}
                                <span className="font-mono text-slate-300 text-xs">
                                  {bet.trader_address?.slice(0, 10)}…{bet.trader_address?.slice(-6)}
                                </span>
                              </p>
                            </div>

                            <div className="text-right shrink-0">
                              <p className={`text-xl font-bold font-mono ${getBetAmountColor(bet.amount)}`}>
                                {formatCurrency(bet.amount)}
                              </p>
                              {bet.shares && (
                                <p className="text-xs text-slate-500 mt-1">
                                  {Number(bet.shares).toFixed(2)} shares
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-between text-xs mt-2.5 pt-2.5 border-t border-slate-800/50">
                            <span className="text-slate-500">
                              Price:{' '}
                              <span className="text-slate-300 font-mono font-semibold">
                                {Number(bet.price) ? `${(Number(bet.price) * 100).toFixed(0)}¢` : '—'}
                              </span>
                            </span>
                            {Number(bet.price) && (
                              <div className="flex-1 mx-3 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 rounded-full"
                                  style={{ width: `${(Number(bet.price) * 100)}%` }}
                                />
                              </div>
                            )}
                            <span className="text-slate-600 font-mono text-[10px]">
                              {bet.tx_hash ? `${bet.tx_hash.slice(0, 8)}…` : ''}
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
              <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 sticky top-6 flex flex-col h-[1200px]">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-slate-300" />
                    {profitabilityTraders.length >= 5 ? 'Top Performers' : 'Smart money (7d)'}
                  </h2>
                </div>

                <div className="mb-4 space-y-3">
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

                  {profitabilityTraders.length >= 5 && (
                    <div className="space-y-2">
                      <div className="flex gap-1 text-xs">
                        <button
                          onClick={() => setTraderSortBy('profitability')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            traderSortBy === 'profitability'
                              ? 'bg-cyan-600 text-white'
                              : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                          }`}
                          title="Return on investment - profit divided by total amount wagered"
                        >
                          Profit %
                        </button>
                        <button
                          onClick={() => setTraderSortBy('win_rate')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            traderSortBy === 'win_rate'
                              ? 'bg-cyan-600 text-white'
                              : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                          }`}
                          title="Percentage of resolved bets where the trader picked the winning outcome"
                        >
                          Win %
                        </button>
                        <button
                          onClick={() => setTraderSortBy('total_pl')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            traderSortBy === 'total_pl'
                              ? 'bg-cyan-600 text-white'
                              : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                          }`}
                          title="Total realized profit/loss in USD from resolved markets"
                        >
                          Total P/L
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 italic">
                        {traderSortBy === 'profitability' && '📊 Profit % = Total P/L ÷ Amount Wagered (ROI)'}
                        {traderSortBy === 'win_rate' && '🎯 Win % = Winning Bets ÷ Total Resolved Bets'}
                        {traderSortBy === 'total_pl' && '💰 Total P/L = Sum of all realized profits and losses'}
                      </p>
                    </div>
                  )}

                </div>

                {visibleTraders.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No trader data yet</p>
                ) : (
                  <div className="flex-1 overflow-y-auto pr-2 space-y-2">
                    {visibleTraders.map((trader, index) => {
                      const isWatched = watchedTraders.includes(trader.address);
                      const rankColor = index === 0 ? 'text-amber-400' : index === 1 ? 'text-slate-300' : index === 2 ? 'text-orange-600' : 'text-slate-500';
                      return (
                        <div
                          key={trader.address}
                          className={`bg-slate-950 rounded-lg p-3 border cursor-pointer transition-all hover:scale-[1.02] ${
                            isWatched
                              ? 'border-cyan-500/40 shadow-cyan-500/10'
                              : 'border-slate-800 hover:border-slate-700'
                          }`}
                          onClick={() => {
                            setSelectedTrader(trader);
                            fetchTraderTrades(trader.address);
                          }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`text-sm font-bold ${rankColor} min-w-[24px]`}>
                                #{index + 1}
                              </span>
                              <div className="min-w-0">
                                <p className="font-mono text-sm text-slate-100 truncate">
                                  {trader.address?.slice(0, 10)}…{trader.address?.slice(-4)}
                                </p>
                                <p className="text-xs text-slate-500 mt-0.5 font-mono">
                                  {formatTimestamp(trader.last_activity)}
                                </p>
                              </div>
                            </div>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleWatchTrader(trader.address);
                              }}
                              className={`transition-all ${
                                isWatched ? 'text-cyan-400 scale-110' : 'text-slate-600 hover:text-slate-300 hover:scale-110'
                              }`}
                              aria-label="Toggle watchlist"
                            >
                              <Star
                                className={`w-4 h-4 ${
                                  isWatched ? 'fill-cyan-400 text-cyan-400' : ''
                                }`}
                              />
                            </button>
                          </div>

                          {/* Show profitability metrics if available */}
                          {trader.profitability_rate !== undefined ? (
                            <>
                              <div className="grid grid-cols-2 gap-2 text-sm mt-2.5 pt-2.5 border-t border-slate-800/50">
                                <div>
                                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Total P/L</p>
                                  <p className={`font-bold font-mono text-sm ${trader.total_pl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {trader.total_pl >= 0 ? '+' : ''}{formatCurrency(trader.total_pl)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Record</p>
                                  <p className="font-bold text-slate-100 font-mono text-sm">
                                    {trader.wins || 0}W-{trader.losses || 0}L
                                    <span className={`ml-1 text-xs ${trader.win_rate > 0.5 ? 'text-emerald-400' : trader.win_rate > 0 ? 'text-amber-400' : 'text-rose-400'}`}>
                                      ({(trader.win_rate * 100).toFixed(0)}%)
                                    </span>
                                  </p>
                                </div>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="grid grid-cols-2 gap-2 text-sm mt-2.5 pt-2.5 border-t border-slate-800/50">
                                <div>
                                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Volume (7d)</p>
                                  <p className="font-bold text-slate-100 font-mono text-sm">
                                    {formatCurrency(trader.total_volume)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Avg Bet</p>
                                  <p className="font-bold text-slate-100 font-mono text-sm">
                                    {trader.avg_bet_size ? formatCurrency(trader.avg_bet_size) : formatCurrency(trader.total_volume / (trader.total_bets || 1))}
                                  </p>
                                </div>
                              </div>
                              {trader.unique_markets !== undefined && (
                                <div className="grid grid-cols-2 gap-2 text-sm mt-2 pt-2 border-t border-slate-800/50">
                                  <div>
                                    <p className="text-[10px] text-slate-500 uppercase tracking-wide">Markets</p>
                                    <p className="font-bold text-slate-100 font-mono text-sm">{trader.unique_markets}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-500 uppercase tracking-wide">Trades</p>
                                    <p className="font-bold text-slate-100 font-mono text-sm">{trader.total_bets}</p>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-500">
                  {profitabilityTraders.length > 0 ? (
                    <>
                      <p>Showing {profitabilityTraders.length} traders with resolved markets.</p>
                      <p className="mt-1">Click a trader to view details and watchlist.</p>
                      <p className="mt-2 text-amber-400/70">💡 Win rate shows 0% if markets lack winning_outcome data. Run sync to update.</p>
                      <p className="mt-1 text-amber-400/70">Profitability = realized P/L + settlement P/L.</p>
                    </>
                  ) : (
                    <>
                      <p>Showing most active traders from the last 7 days.</p>
                      <p className="mt-1">Click a trader to view details and watchlist.</p>
                      <p className="mt-2 text-amber-400/70">💡 Profitability data will appear as markets resolve.</p>
                    </>
                  )}
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
                  onClick={() => {
                    setSelectedTrader(null);
                    setTraderTrades([]);
                  }}
                  className="text-slate-400 hover:text-slate-200 text-2xl leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {selectedTrader.profitability_rate !== undefined ? (
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="bg-slate-950 rounded-md p-3 border border-slate-800">
                    <p className="text-xs text-slate-500">Profitability Rate</p>
                    <p className={`text-xl font-semibold mt-1 ${selectedTrader.profitability_rate > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {(selectedTrader.profitability_rate * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-slate-950 rounded-md p-3 border border-slate-800">
                    <p className="text-xs text-slate-500">Win Rate</p>
                    <p className={`text-xl font-semibold mt-1 ${selectedTrader.win_rate > 0.5 ? 'text-emerald-400' : selectedTrader.win_rate > 0 ? 'text-amber-400' : 'text-rose-400'}`}>
                      {(selectedTrader.win_rate * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-slate-950 rounded-md p-3 border border-slate-800">
                    <p className="text-xs text-slate-500">Total P/L</p>
                    <p className={`text-xl font-semibold mt-1 ${selectedTrader.total_pl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {selectedTrader.total_pl >= 0 ? '+' : ''}{formatCurrency(selectedTrader.total_pl)}
                    </p>
                  </div>
                  <div className="bg-slate-950 rounded-md p-3 border border-slate-800">
                    <p className="text-xs text-slate-500">Record</p>
                    <p className="text-xl font-semibold text-slate-100 mt-1">
                      {selectedTrader.wins || 0}W-{selectedTrader.losses || 0}L
                    </p>
                  </div>
                </div>
              ) : (
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
              )}

              {/* Trade History */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
                  <Activity className="w-4 h-4" />
                  Recent trades (last 100)
                </h4>

                {loadingTrades ? (
                  <div className="text-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-600 mx-auto" />
                    <p className="mt-3 text-slate-400 text-sm">Loading trades...</p>
                  </div>
                ) : traderTrades.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-6">No trades found</p>
                ) : (
                  <div className="max-h-96 overflow-y-auto pr-2 space-y-2">
                    {traderTrades.map((trade, idx) => {
                      const tradeSideInfo = getSideLabel(trade.side);
                      // Determine if this trade was a win or loss based on market resolution
                      const isResolved = trade.market_resolved;
                      const isWin = isResolved && trade.winning_outcome === trade.outcome;
                      const isLoss = isResolved && trade.winning_outcome && trade.winning_outcome !== trade.outcome;

                      // Dynamic styling based on win/loss
                      const cardBorderClass = isWin
                        ? 'border-emerald-500/40 bg-emerald-500/5'
                        : isLoss
                          ? 'border-rose-500/40 bg-rose-500/5'
                          : 'border-slate-800';

                      return (
                      <div key={idx} className={`bg-slate-950 rounded-md border p-3 ${cardBorderClass}`}>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="min-w-0 flex-1">
                            <a
                              href={trade.market_slug ? `https://polymarket.com/market/${trade.market_slug}` : undefined}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm font-medium text-slate-200 hover:underline block truncate"
                            >
                              {trade.market_title || trade.market_slug || trade.market_id}
                            </a>
                            <p className="text-xs text-slate-500 mt-1">
                              {formatTimestamp(trade.timestamp)}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-semibold text-slate-100">
                              {formatCurrency(trade.amount)}
                            </p>
                            <span
                              className={`text-xs font-semibold px-2 py-0.5 rounded mt-1 inline-block border ${tradeSideInfo.color}`}
                            >
                              {tradeSideInfo.label}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500">
                            Outcome: <span className={isWin ? 'text-emerald-400' : isLoss ? 'text-rose-400' : 'text-slate-300'}>{trade.outcome}</span>
                            {isWin && <span className="ml-2 text-emerald-400 font-semibold">✓ WIN</span>}
                            {isLoss && <span className="ml-2 text-rose-400 font-semibold">✗ LOSS</span>}
                            {!isResolved && <span className="ml-2 text-slate-500">(Pending)</span>}
                          </span>
                          <span className="text-slate-500">
                            Price: <span className="text-slate-300">
                              {Number(trade.price) ? `${(Number(trade.price) * 100).toFixed(0)}¢` : '—'}
                            </span>
                          </span>
                          {trade.shares && (
                            <span className="text-slate-500">
                              Shares: <span className="text-slate-300">
                                {Number(trade.shares).toFixed(2)}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    );
                    })}
                  </div>
                )}
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
            Data syncs automatically every few minutes. <span className="font-semibold text-cyan-400">BUY</span> and <span className="font-semibold text-amber-400">SELL</span> trades are tracked separately.
          </p>
          <p className="text-sm text-slate-400 mt-2">
            Trader profitability accounts for both realized P/L from sells and settlement P/L from remaining shares.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PolymarketTracker;