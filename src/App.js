import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  TrendingUp,
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
  const [traderSortBy, setTraderSortBy] = useState('total_pl'); // 'total_pl', 'hot_streak' - simplified sort options
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

  // Border color for bet cards based on amount
  const getBetBorderColor = (amount) => {
    const num = Number(amount || 0);
    if (num >= 100000) return 'border-rose-500/40 bg-rose-500/5';   // Mega Whale
    if (num >= 50000) return 'border-orange-500/40 bg-orange-500/5'; // Whale
    if (num >= 10000) return 'border-amber-500/30 bg-amber-500/5';   // Large
    return 'border-slate-800 hover:border-slate-700';
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

// Format bet description for spread/total markets to show the actual position
// e.g., "Spread: Celtics (-12.5)" + outcome "Bucks" → "Bucks +12.5"
const formatBetPosition = (marketTitle, outcome) => {
  if (!marketTitle || !outcome) return outcome || '—';

  // Check if it's a spread market: "Spread: Team (-X.X)" or "Spread: Team (+X.X)"
  const spreadMatch = marketTitle.match(/Spread:\s*(\w+(?:\s+\w+)*)\s*\(([+-]?\d+\.?\d*)\)/i);
  if (spreadMatch) {
    const favoredTeam = spreadMatch[1].trim();
    const spreadValue = parseFloat(spreadMatch[2]);

    // If outcome matches the favored team, they took the favorite (negative spread)
    if (outcome.toLowerCase() === favoredTeam.toLowerCase()) {
      return `${outcome} ${spreadValue >= 0 ? '+' : ''}${spreadValue}`;
    } else {
      // They took the underdog (opposite spread)
      const oppositeSpread = -spreadValue;
      return `${outcome} ${oppositeSpread >= 0 ? '+' : ''}${oppositeSpread}`;
    }
  }

  // Check if it's an over/under market: "Team vs Team: O/U X.X"
  const ouMatch = marketTitle.match(/O\/U\s*(\d+\.?\d*)/i);
  if (ouMatch && (outcome.toLowerCase() === 'over' || outcome.toLowerCase() === 'under')) {
    return `${outcome} ${ouMatch[1]}`;
  }

  // Default: just return the outcome
  return outcome;
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
        // Note: SQL function returns 'address' directly now, not 'trader_address'
        const mappedTraders = data.map(t => ({
          address: t.address || t.trader_address,
          total_volume: Number(t.total_volume || t.total_buy_cost || 0),
          total_bets: Number(t.total_bets || t.resolved_markets || 0),
          resolved_markets: t.resolved_markets,
          wins: Number(t.wins || 0),
          losses: Number(t.losses || 0),
          win_rate: Number(t.win_rate || 0),
          profit_wins: t.profit_wins,
          profit_losses: t.profit_losses,
          profitability_rate: Number(t.profitability_rate || 0),
          total_pl: Number(t.total_pl || 0),
          avg_bet_size: Number(t.total_volume || 0) / (t.total_bets || 1),
          unique_markets: t.resolved_markets,
          last_activity: t.last_activity || Date.now(),
          current_streak: t.current_streak || 0
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
        if (traderSortBy === 'hot_streak') {
          // Hot streak = combo of win streak + recent win rate + recent activity
          const aStreak = (a.current_streak || 0) + (a.win_rate || 0) * 10 + (a.wins || 0) * 0.5;
          const bStreak = (b.current_streak || 0) + (b.win_rate || 0) * 10 + (b.wins || 0) * 0.5;
          return bStreak - aStreak;
        } else if (traderSortBy === 'total_pl') {
          return (b.total_pl || 0) - (a.total_pl || 0);
        }
        return 0;
      });
    }

    return tradersToShow;
  }, [profitabilityTraders, recentActiveTraders, topTraders, searchAddress, traderSortBy]);

  // Phosphor sonar terminal palette - desaturated, selective brightness
  // Brightest = numbers only. Text = softer. Metadata = muted.
  const retroColors = {
    bg: '#080a08',                        // Deep black with green cast
    surface: '#0c0f0c',                   // Recessed panels
    border: 'rgba(80, 140, 100, 0.18)',   // Muted green border (less bright)
    borderActive: 'rgba(90, 160, 120, 0.3)', // Active - subtle, not glowing
    // NUMBERS: Dollar amounts, P/L, key metrics - brightest, slightly desaturated
    numbers: '#6AD99A',                   // Phosphor green for numbers only
    // PRIMARY: Market titles, section headers - softer than numbers
    textPrimary: '#5BB882',               // Readable but not glowing
    // SECONDARY: Body text, readable content
    text: '#4A9A6E',                      // Softer green, good contrast
    textBright: '#58A87A',                // Slight emphasis
    // TERTIARY: Timestamps, addresses, metadata - muted
    textDim: '#3A7A58',                   // Clearly dimmer
    // ACCENT: Headers - readable but not shouting
    accent: '#5BB882',                    // Same as textPrimary (headers don't shout)
    alert: '#5BB882',                     // Alerts match textPrimary
    warn: '#B8A050',                      // Muted amber (less saturated)
    danger: '#A07070',                    // Muted red
    // Win/loss - numbers tier brightness
    win: '#6AD99A',                       // Wins use numbers brightness
    loss: '#A06060',                      // Losses - muted red for clear distinction
    glow: 'rgba(90, 180, 130, 0.05)',     // Very subtle
  };

  return (
    <div className={`min-h-screen ${isRetro ? 'retro-container' : 'bg-slate-950 text-slate-100 trading-grid-bg'}`}
         style={isRetro ? { backgroundColor: retroColors.bg, color: retroColors.text, fontFamily: "'VT323', monospace" } : {}}>
      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${isRetro ? '' : 'bg-slate-900 border border-slate-800'}`}
                     style={isRetro ? { border: `1px solid ${retroColors.border}` } : {}}>
                  {isRetro ? (
                    <span style={{ color: retroColors.text, fontSize: '1.25rem' }}>▓</span>
                  ) : (
                    <TrendingUp className="w-5 h-5 text-slate-200" />
                  )}
                </div>
                <div>
                  <h1 className={`text-3xl font-semibold tracking-tight ${isRetro ? '' : 'text-slate-100'}`}
                      style={isRetro ? { color: retroColors.textBright, textShadow: 'none', letterSpacing: '0.05em' } : {}}>
                    {isRetro ? 'POLYMARKET TRACKER' : 'Polymarket Tracker'}
                  </h1>
                  <p className={`text-sm mt-1 ${isRetro ? '' : 'text-slate-400'}`}
                     style={isRetro ? { color: retroColors.textDim } : {}}>
                    {isRetro ? '> WHALE ACTIVITY MONITOR' : 'Large trade activity and trader watchlists'}
                  </p>
                </div>
              </div>
              <p className={`text-xs mt-3 ${isRetro ? '' : 'text-slate-500'}`}
                 style={isRetro ? { color: retroColors.textDim } : {}}>
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
                  color: retroColors.text,
                  border: `1px solid ${retroColors.textDim}`,
                  background: 'transparent'
                } : {}}
                onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textBright, e.currentTarget.style.color = retroColors.textBright, e.currentTarget.style.borderColor = retroColors.borderActive)}
                onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textDim, e.currentTarget.style.color = retroColors.text, e.currentTarget.style.borderColor = retroColors.border)}
              >
                <Bell className="w-4 h-4" />
                {isRetro ? 'ALERTS' : 'Alerts'}
                {alerts.length > 0 && (
                  <span className={`absolute -top-2 -right-2 text-xs rounded-full w-6 h-6 flex items-center justify-center font-semibold ${
                    isRetro ? '' : 'bg-cyan-600 text-slate-950'
                  }`}
                  style={isRetro ? { backgroundColor: retroColors.warn, color: retroColors.bg } : {}}>
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
                  color: retroColors.text,
                  border: `1px solid ${retroColors.textDim}`,
                  background: 'transparent'
                } : {}}
                onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textBright, e.currentTarget.style.color = retroColors.textBright, e.currentTarget.style.borderColor = retroColors.borderActive)}
                onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textDim, e.currentTarget.style.color = retroColors.text, e.currentTarget.style.borderColor = retroColors.border)}
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
                    color: retroColors.text,
                    border: `1px solid ${retroColors.textDim}`,
                    background: 'transparent'
                  } : {}}
                  onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textBright, e.currentTarget.style.color = retroColors.textBright, e.currentTarget.style.borderColor = retroColors.borderActive)}
                  onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textDim, e.currentTarget.style.color = retroColors.text, e.currentTarget.style.borderColor = retroColors.border)}
                >
                  <Coins className="w-4 h-4" style={isRetro ? { color: retroColors.warn } : {}} />
                  {isRetro ? 'TIP' : 'Tip'}
                </button>

                {showTipJar && (
                  <div className={`absolute right-0 mt-2 w-72 rounded-lg shadow-xl z-50 p-4 ${
                    isRetro ? '' : 'bg-slate-900 border border-slate-700'
                  }`}
                  style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}` } : {}}>
                    <div className={`text-sm mb-3 ${isRetro ? '' : 'text-slate-300'}`}
                         style={isRetro ? { color: retroColors.textDim } : {}}>
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
                             style={isRetro ? { color: retroColors.text } : {}}>Ko-fi</div>
                        <div className={`text-xs ${isRetro ? '' : 'text-slate-400'}`}
                             style={isRetro ? { color: retroColors.textDim } : {}}>Buy me a coffee</div>
                      </div>
                      <ExternalLink className="w-4 h-4" style={isRetro ? { color: retroColors.textDim } : {}} />
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
                          <span className="text-sm font-bold" style={isRetro ? { color: retroColors.text } : {}}>Ξ</span>
                        </div>
                        <div className="flex-1">
                          <div className={`font-medium ${isRetro ? '' : 'text-slate-100'}`}
                               style={isRetro ? { color: retroColors.text } : {}}>ETH / ERC-20</div>
                          <div className={`text-xs ${isRetro ? '' : 'text-slate-400'}`}
                               style={isRetro ? { color: retroColors.textDim } : {}}>Send crypto directly</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <code className={`flex-1 text-xs px-2 py-1.5 rounded truncate ${
                          isRetro ? '' : 'bg-slate-900 text-slate-300'
                        }`}
                        style={isRetro ? { backgroundColor: retroColors.bg, color: retroColors.text, border: `1px solid ${retroColors.border}` } : {}}>
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
                          style={isRetro ? { border: `1px solid ${retroColors.textDim}` } : {}}
                          title="Copy address"
                        >
                          {copiedWallet ? (
                            <Check className="w-4 h-4" style={isRetro ? { color: retroColors.textBright } : {}} />
                          ) : (
                            <Copy className="w-4 h-4" style={isRetro ? { color: retroColors.textDim } : {}} />
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
                  color: retroColors.text,
                  border: `1px solid ${retroColors.textDim}`,
                  background: 'transparent'
                } : {}}
                onMouseEnter={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textBright, e.currentTarget.style.color = retroColors.textBright, e.currentTarget.style.borderColor = retroColors.borderActive)}
                onMouseLeave={(e) => isRetro && (e.currentTarget.style.borderColor = retroColors.textDim, e.currentTarget.style.color = retroColors.text, e.currentTarget.style.borderColor = retroColors.border)}
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
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-semibold flex items-center gap-2 ${isRetro ? '' : 'text-sm'}`} style={isRetro ? { fontSize: '1.05rem', letterSpacing: '0.08em', fontWeight: 500 } : {}}>
                <Bell className="w-4 h-4" style={isRetro ? { color: retroColors.textDim } : {}} />
                <span style={isRetro ? { color: retroColors.textPrimary } : {}}>
                  {isRetro ? 'SIGNAL INTERCEPTS' : 'Signal Alerts'}
                </span>
                {isRetro && <span style={{ color: retroColors.textDim, fontSize: '0.7rem', marginLeft: '0.5rem', fontWeight: 400 }}>24H</span>}
              </h3>
              <button
                onClick={() => setAlerts([])}
                className={`text-xs transition-colors ${
                  isRetro ? '' : 'text-slate-400 hover:text-slate-200'
                }`}
                style={isRetro ? { color: retroColors.textDim } : {}}
              >
                {isRetro ? 'CLEAR' : 'Clear all'}
              </button>
            </div>

            {/* Alert Categories Legend */}
            <div className={`mb-4 p-3 rounded-lg text-xs ${
              isRetro ? '' : 'bg-slate-950/50'
            }`}
            style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}` } : {}}>
              <div className="font-medium mb-2" style={isRetro ? { color: retroColors.textDim } : {}}>
                {isRetro ? '> ALERT CLASSIFICATIONS:' : 'Alert Types:'}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.text}`, color: retroColors.text } : {}}>TOP TRADER</span>
                  <span style={isRetro ? { color: retroColors.textDim } : {}}>High-performing trader activity</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.text}`, color: retroColors.text } : {}}>WATCHLIST</span>
                  <span style={isRetro ? { color: retroColors.textDim } : {}}>Traders you're tracking</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.warn}`, color: retroColors.warn } : {}}>WHALE</span>
                  <span style={isRetro ? { color: retroColors.textDim } : {}}>Large position ($50k+)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.warn}`, color: retroColors.warn } : {}}>MEGA WHALE</span>
                  <span style={isRetro ? { color: retroColors.textDim } : {}}>Massive position ($100k+)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                    isRetro ? '' : 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                  }`}
                  style={isRetro ? { border: `1px solid ${retroColors.danger}`, color: retroColors.danger } : {}}>ISOLATED CONTACT</span>
                  <span style={isRetro ? { color: retroColors.textDim } : {}}>Low-activity trader, outsized bet in thin market</span>
                </div>
              </div>
            </div>

            {alerts.length === 0 ? (
              <p className="text-sm" style={isRetro ? { color: retroColors.textDim } : {}}>
                {isRetro
                  ? '> NO SIGNALS DETECTED. MONITORING...'
                  : 'No alerts yet. They\'ll appear when top traders, watchlist traders, or whales make trades.'}
              </p>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
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

                  // Retro-specific badge colors
                  const retroBadgeBorder = isTopTrader
                    ? retroColors.text
                    : isWatchlist
                      ? retroColors.text
                      : isMega
                        ? retroColors.warn
                        : isIsolatedContact
                          ? retroColors.danger
                          : retroColors.warn;

                  // Retro badge text (no emojis)
                  const retroBadgeText = isTopTrader
                    ? 'TOP TRADER'
                    : isWatchlist
                      ? 'WATCHLIST'
                      : isMega
                        ? 'MEGA WHALE'
                        : isIsolatedContact
                          ? 'ISOLATED CONTACT'
                          : 'WHALE';

                  return (
                    <div
                      key={idx}
                      className={`rounded-md border p-4 transition-all hover:scale-[1.01] ${isRetro ? '' : `bg-slate-950 ${borderClass}`} ${polymarketUrl ? 'cursor-pointer' : ''}`}
                      style={isRetro ? {
                        backgroundColor: retroColors.bg,
                        border: `1px solid ${retroBadgeBorder}`,
                        padding: '1rem',
                      } : {}}
                      onClick={() => polymarketUrl && window.open(polymarketUrl, '_blank')}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`font-bold px-2 py-1 rounded border uppercase tracking-wide ${isRetro ? '' : 'text-[10px]'} ${isRetro ? '' : badgeClass}`}
                          style={isRetro ? { border: `1px solid ${retroColors.textDim}`, color: retroColors.text, fontSize: '0.7rem' } : {}}
                        >
                          {isRetro ? retroBadgeText : badgeText}
                        </span>
                        {alert.outcome && (
                          <span
                            className={`text-[10px] font-bold px-2 py-1 rounded border uppercase tracking-wide ${isRetro ? '' : betBadgeClass}`}
                            style={isRetro ? {
                              border: `1px solid ${retroColors.textDim}`,
                              color: retroColors.text,
                              fontSize: '0.7rem'
                            } : {}}
                          >
                            {isRetro ? '' : (isBuy ? '📈' : '📉')} {alert.side || 'BUY'} {alert.outcome}{alert.price ? ` @ ${Math.round(alert.price * 100)}¢` : ''}
                          </span>
                        )}
                        <span
                          className="text-xs font-mono"
                          style={isRetro ? { color: retroColors.textDim, fontSize: '0.75rem' } : { color: 'rgb(100, 116, 139)' }}
                        >
                          {formatTimestamp(alert.created_at)}
                        </span>
                        {polymarketUrl && (
                          <span
                            className="text-xs ml-auto"
                            style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(34, 211, 238)' }}
                          >↗</span>
                        )}
                      </div>
                      <p
                        className={`mt-2 font-medium ${isRetro ? '' : 'text-sm'}`}
                        style={isRetro ? { color: retroColors.text, fontSize: '1rem', lineHeight: 1.4 } : { color: 'rgb(226, 232, 240)' }}
                      >
                        <span style={isRetro ? { color: retroColors.numbers, fontWeight: 600 } : {}}>${alert.amount ? Math.round(alert.amount).toLocaleString() : '?'}</span>
                        <span style={isRetro ? { color: retroColors.textDim } : {}}> on </span>
                        <span style={isRetro ? { color: retroColors.textPrimary } : {}}>{alert.market_title || 'Unknown market'}</span>
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Stats - background telemetry for $10k+ trades, last 24h */}
        {marketStats && (
          <div
            className={`mb-6 px-2 ${isRetro ? '' : 'text-slate-500'}`}
            style={isRetro ? { color: retroColors.textDim } : {}}
          >
            {isRetro && (
              <p className="text-center text-xs uppercase tracking-wider mb-3" style={{ color: retroColors.textDim }}>
                WHALE TRADES ≥$10K • LAST 24H
              </p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div className="text-center">
                <p className="text-xs uppercase tracking-wider mb-1" style={isRetro ? { color: retroColors.textDim } : { opacity: 0.6 }}>Volume</p>
                <p className="text-sm font-mono" style={isRetro ? { color: retroColors.text } : {}}>
                  {formatCurrency(marketStats.total_volume_24h)}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs uppercase tracking-wider mb-1" style={isRetro ? { color: retroColors.textDim } : { opacity: 0.6 }}>Trades</p>
                <p className="text-sm font-mono" style={isRetro ? { color: retroColors.text } : {}}>
                  {marketStats.total_trades_24h || 0}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs uppercase tracking-wider mb-1" style={isRetro ? { color: retroColors.textDim } : { opacity: 0.6 }}>Markets</p>
                <p className="text-sm font-mono" style={isRetro ? { color: retroColors.text } : {}}>
                  {marketStats.active_markets || 0}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs uppercase tracking-wider mb-1" style={isRetro ? { color: retroColors.textDim } : { opacity: 0.6 }}>Traders</p>
                <p className="text-sm font-mono" style={isRetro ? { color: retroColors.text } : {}}>
                  {marketStats.unique_traders_24h || 0}
                </p>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16">
            <div
              className="animate-spin rounded-full h-10 w-10 border-b-2 mx-auto"
              style={isRetro ? { borderColor: retroColors.textBright } : { borderColor: 'rgb(8, 145, 178)' }}
            />
            <p className="mt-4 text-sm" style={isRetro ? { color: retroColors.textDim } : {}}>
              {isRetro ? '> LOADING ACTIVITY...' : 'Loading activity…'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Large Bets Feed */}
            <div className="lg:col-span-2">
              <div
                className={`rounded-lg border p-6 flex flex-col h-[1200px] ${isRetro ? '' : 'bg-slate-900 border-slate-800'}`}
                style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}`, marginTop: '0.5rem' } : {}}
              >
                <div className="flex items-center justify-between mb-5">
                  <h2 className={`flex items-center gap-2 ${isRetro ? '' : 'text-lg font-semibold'}`} style={isRetro ? { color: retroColors.textPrimary, fontWeight: 500, letterSpacing: '0.08em', fontSize: '1.1rem' } : {}}>
                    <AlertCircle className="w-5 h-5" style={isRetro ? { color: retroColors.textDim } : {}} />
                    {isRetro ? 'LARGE BETS' : 'Large bets'}
                  </h2>
                  <div className="text-xs" style={isRetro ? { color: retroColors.textDim, fontSize: '0.8rem' } : {}}>
                    {filteredBets.length} trades (≥$5k)
                  </div>
                </div>

                {filteredBets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-sm" style={isRetro ? { color: retroColors.textDim } : {}}>
                      {isRetro ? '> NO TRADES ABOVE $5,000 YET. MONITORING...' : 'No trades above $5,000 yet. Data syncs automatically every few minutes.'}
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
                          className={`rounded-lg border p-3 transition-all hover:shadow-lg ${
                            isRetro
                              ? ''
                              : (isWatched ? 'bg-slate-950 border-cyan-500/30 shadow-cyan-500/10' : `bg-slate-950 ${getBetBorderColor(bet.amount)}`)
                          }`}
                          style={isRetro ? {
                            backgroundColor: retroColors.surface,
                            border: `1px solid ${isWatched ? retroColors.textBright : retroColors.border}`,
                            borderColor: isWatched ? retroColors.borderActive : retroColors.border
                          } : {}}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              {/* Row 1: Time + Size Badge + Watching */}
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <span className="text-xs font-mono" style={isRetro ? { color: retroColors.textDim } : {}}>
                                  {formatTimestamp(bet.timestamp)}
                                </span>
                                {sizeLabel && (
                                  <span
                                    className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide ${isRetro ? '' : sizeLabel.color}`}
                                    style={isRetro ? { border: `1px solid ${retroColors.warn}`, color: retroColors.warn } : {}}
                                  >
                                    {sizeLabel.label}
                                  </span>
                                )}
                                {isWatched && (
                                  <span
                                    className="inline-flex items-center gap-1 text-xs"
                                    style={isRetro ? { color: retroColors.textBright } : {}}
                                  >
                                    <Star className="w-3.5 h-3.5" style={isRetro ? { fill: retroColors.textBright, color: retroColors.textBright } : { fill: 'rgb(103, 232, 249)', color: 'rgb(103, 232, 249)' }} />
                                    {isRetro ? 'WATCHING' : 'Watching'}
                                  </span>
                                )}
                              </div>

                              {/* Market Title - softer than numbers */}
                              <a
                                href={bet.market_slug ? `https://polymarket.com/market/${bet.market_slug}` : undefined}
                                target="_blank"
                                rel="noreferrer"
                                className={`font-semibold mb-2 hover:underline block transition-colors line-clamp-2 ${isRetro ? '' : 'text-base hover:text-cyan-400'}`}
                                style={isRetro ? { color: retroColors.textPrimary, fontWeight: 500, fontSize: '1.05rem', lineHeight: 1.3 } : {}}
                              >
                                {bet.market_title || bet.market_slug || bet.market_id}
                              </a>

                              {/* Outcome badge - muted outlines, not glowing */}
                              <div
                                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm font-bold ${isRetro ? '' : (sideInfo.label === 'BUY' ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-rose-500/10 border-rose-500/40')}`}
                                style={isRetro ? {
                                  border: `1px solid ${sideInfo.label === 'BUY' ? retroColors.textDim : 'rgba(184, 160, 80, 0.5)'}`,
                                  backgroundColor: 'rgba(0,0,0,0.15)'
                                } : {}}
                              >
                                <span style={isRetro ? { color: sideInfo.label === 'BUY' ? retroColors.text : retroColors.warn } : { color: sideInfo.label === 'BUY' ? 'rgb(52, 211, 153)' : 'rgb(251, 113, 133)' }}>
                                  {sideInfo.label}
                                </span>
                                <span
                                  className="font-bold"
                                  style={isRetro ? { color: retroColors.text } : { color: 'rgb(226, 232, 240)' }}
                                >
                                  {formatBetPosition(bet.market_title, bet.outcome)}
                                </span>
                                <span style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(148, 163, 184)' }}>@</span>
                                <span className="font-mono" style={isRetro ? { color: retroColors.textDim } : {}}>
                                  {Number(bet.price) ? `${(Number(bet.price) * 100).toFixed(0)}¢` : '—'}
                                </span>
                              </div>

                              {/* Trader address - smaller, de-emphasized */}
                              <p className="text-[10px] mt-2" style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                                <span className="font-mono">
                                  {bet.trader_address?.slice(0, 6)}…{bet.trader_address?.slice(-4)}
                                </span>
                              </p>
                            </div>

                            <div className="text-right shrink-0">
                              <p
                                className={`font-bold font-mono ${isRetro ? '' : 'text-xl'}`}
                                style={isRetro ? { color: retroColors.numbers, fontWeight: 700, fontSize: '1.3rem' } : {}}
                              >
                                {formatCurrency(bet.amount)}
                              </p>
                              {bet.shares && (
                                <p className="text-xs mt-1" style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                                  {Number(bet.shares).toFixed(2)} shares
                                </p>
                              )}
                            </div>
                          </div>

                          <div
                            className="flex items-center justify-between text-xs mt-2.5 pt-2.5"
                            style={isRetro ? { borderTop: `1px solid ${retroColors.border}` } : { borderTop: '1px solid rgba(30, 41, 59, 0.5)' }}
                          >
                            <span style={isRetro ? { color: retroColors.textDim } : {}}>
                              Price:{' '}
                              <span className="font-mono font-semibold" style={isRetro ? { color: retroColors.text } : {}}>
                                {Number(bet.price) ? `${(Number(bet.price) * 100).toFixed(0)}¢` : '—'}
                              </span>
                            </span>
                            {Number(bet.price) && (
                              <div
                                className="flex-1 mx-3 h-1.5 rounded-full overflow-hidden"
                                style={isRetro ? { backgroundColor: 'rgba(0,0,0,0.3)' } : { backgroundColor: 'rgb(30, 41, 59)' }}
                              >
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${(Number(bet.price) * 100)}%`,
                                    backgroundColor: isRetro ? retroColors.textDim : 'rgb(6, 182, 212)'
                                  }}
                                />
                              </div>
                            )}
                            <span className="font-mono text-[10px]" style={isRetro ? { color: retroColors.textDim } : {}}>
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
              <div
                className={`rounded-lg border p-6 sticky top-6 flex flex-col h-[1200px] ${isRetro ? '' : 'bg-slate-900 border-slate-800'}`}
                style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}`, marginTop: '0.5rem' } : {}}
              >
                <div className="flex items-center justify-between mb-5">
                  <h2 className={`flex items-center gap-2 ${isRetro ? '' : 'text-lg font-semibold'}`} style={isRetro ? { color: retroColors.textPrimary, fontWeight: 500, letterSpacing: '0.08em', fontSize: '1.1rem' } : {}}>
                    <Trophy className="w-5 h-5" style={isRetro ? { color: retroColors.textDim } : {}} />
                    {isRetro
                      ? (profitabilityTraders.length >= 5 ? 'TOP PERFORMERS' : 'SMART MONEY')
                      : (profitabilityTraders.length >= 5 ? 'Top Performers' : 'Smart money (7d)')}
                  </h2>
                </div>

                <div className="mb-4 space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder={isRetro ? 'Search address...' : 'Search address…'}
                      value={searchAddress}
                      onChange={(e) => setSearchAddress(e.target.value)}
                      className={`flex-1 rounded-md px-3 py-2 text-sm focus:outline-none ${isRetro ? '' : 'bg-slate-950 border border-slate-800 text-slate-100 focus:ring-2 focus:ring-cyan-600/40'}`}
                      style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}`, color: retroColors.text } : {}}
                    />
                    <button
                      className={`px-3 py-2 rounded-md border transition-colors ${isRetro ? '' : 'bg-slate-950 hover:bg-slate-900 border-slate-800'}`}
                      style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}` } : {}}
                    >
                      <Search className="w-4 h-4" style={isRetro ? { color: retroColors.textDim } : {}} />
                    </button>
                  </div>

                  {profitabilityTraders.length >= 5 && (
                    <div className="space-y-2">
                      <div className="flex gap-1 text-xs">
                        <button
                          onClick={() => setTraderSortBy('total_pl')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            isRetro
                              ? ''
                              : (traderSortBy === 'total_pl'
                                ? 'bg-cyan-600 text-white'
                                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800')
                          }`}
                          style={isRetro ? {
                            backgroundColor: traderSortBy === 'total_pl' ? retroColors.textBright : retroColors.bg,
                            color: traderSortBy === 'total_pl' ? retroColors.bg : retroColors.textDim,
                            border: `1px solid ${traderSortBy === 'total_pl' ? retroColors.textBright : retroColors.border}`
                          } : {}}
                          title="Total realized profit/loss in USD from resolved markets"
                        >
                          {isRetro ? 'P/L' : 'Total P/L'}
                        </button>
                        <button
                          onClick={() => setTraderSortBy('hot_streak')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            isRetro
                              ? ''
                              : (traderSortBy === 'hot_streak'
                                ? 'bg-cyan-600 text-white'
                                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800')
                          }`}
                          style={isRetro ? {
                            backgroundColor: traderSortBy === 'hot_streak' ? retroColors.warn : retroColors.bg,
                            color: traderSortBy === 'hot_streak' ? retroColors.bg : retroColors.textDim,
                            border: `1px solid ${traderSortBy === 'hot_streak' ? retroColors.warn : retroColors.border}`
                          } : {}}
                          title="Traders on a hot streak - high recent win rate and consecutive wins"
                        >
                          {isRetro ? '🔥 HOT' : '🔥 Hot Streak'}
                        </button>
                      </div>
                      <p className="text-[10px] italic" style={isRetro ? { color: retroColors.textDim } : {}}>
                        {traderSortBy === 'total_pl' && (isRetro ? '> RANKED BY TOTAL PROFIT/LOSS' : '💰 Ranked by total realized P/L')}
                        {traderSortBy === 'hot_streak' && (isRetro ? '> RANKED BY WIN STREAK + ACCURACY' : '🔥 Ranked by winning streak + recent accuracy')}
                      </p>
                    </div>
                  )}

                </div>

                {visibleTraders.length === 0 ? (
                  <p className="text-sm text-center py-8" style={isRetro ? { color: retroColors.textDim } : {}}>
                    {isRetro ? '> NO TRADER DATA YET' : 'No trader data yet'}
                  </p>
                ) : (
                  <div className="flex-1 overflow-y-auto pr-2 space-y-2">
                    {visibleTraders.map((trader, index) => {
                      const isWatched = watchedTraders.includes(trader.address);
                      const rankColor = index === 0 ? (isRetro ? retroColors.warn : 'text-amber-400') : index === 1 ? (isRetro ? retroColors.text : 'text-slate-300') : index === 2 ? (isRetro ? retroColors.warn : 'text-orange-600') : (isRetro ? retroColors.textDim : 'text-slate-500');
                      return (
                        <div
                          key={trader.address}
                          className={`rounded-lg p-3 border cursor-pointer transition-all hover:scale-[1.02] ${
                            isRetro
                              ? ''
                              : (isWatched ? 'bg-slate-950 border-cyan-500/40 shadow-cyan-500/10' : 'bg-slate-950 border-slate-800 hover:border-slate-700')
                          }`}
                          style={isRetro ? {
                            backgroundColor: retroColors.bg,
                            border: `1px solid ${isWatched ? retroColors.textBright : retroColors.border}`,
                            borderColor: isWatched ? retroColors.borderActive : retroColors.border
                          } : {}}
                          onClick={() => {
                            setSelectedTrader(trader);
                            fetchTraderTrades(trader.address);
                          }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`text-sm font-bold min-w-[24px] ${isRetro ? '' : rankColor}`}
                                style={isRetro ? { color: rankColor } : {}}
                              >
                                #{index + 1}
                              </span>
                              <div className="min-w-0">
                                <p className="font-mono text-sm truncate" style={isRetro ? { color: retroColors.text } : {}}>
                                  {trader.address?.slice(0, 10)}…{trader.address?.slice(-4)}
                                </p>
                                <p className="text-xs mt-0.5 font-mono" style={isRetro ? { color: retroColors.textDim } : {}}>
                                  <span style={isRetro ? { color: retroColors.numbers } : { color: 'rgb(52, 211, 153)' }}>{trader.wins || 0}W</span>
                                  {' · '}
                                  <span style={isRetro ? { color: retroColors.loss } : { color: 'rgb(251, 113, 133)' }}>{trader.losses || 0}L</span>
                                </p>
                              </div>
                            </div>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleWatchTrader(trader.address);
                              }}
                              className="transition-all"
                              style={isRetro ? { color: isWatched ? retroColors.textBright : retroColors.textDim } : {}}
                              aria-label="Toggle watchlist"
                            >
                              <Star
                                className="w-4 h-4"
                                style={isRetro
                                  ? { fill: isWatched ? retroColors.textBright : 'transparent', color: isWatched ? retroColors.textBright : retroColors.textDim }
                                  : { fill: isWatched ? 'rgb(34, 211, 238)' : 'transparent', color: isWatched ? 'rgb(34, 211, 238)' : 'rgb(71, 85, 105)' }}
                              />
                            </button>
                          </div>

                          {/* Show profitability metrics if available */}
                          {trader.profitability_rate !== undefined ? (
                            <>
                              <div
                                className={isRetro ? 'grid grid-cols-2 gap-3 mt-3 pt-3' : 'grid grid-cols-2 gap-2 text-sm mt-2.5 pt-2.5 border-t border-slate-800/50'}
                                style={isRetro ? { borderTop: `1px solid ${retroColors.border}` } : {}}
                              >
                                <div>
                                  <p
                                    className={isRetro ? '' : 'text-[10px] text-slate-500 uppercase tracking-wide'}
                                    style={isRetro ? { fontSize: '0.7rem', color: retroColors.textDim, textTransform: 'uppercase', letterSpacing: '0.1em' } : {}}
                                  >
                                    Total P/L
                                  </p>
                                  <p
                                    className={isRetro ? 'font-mono' : `font-bold font-mono text-sm ${trader.total_pl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                                    style={isRetro ? { color: trader.total_pl >= 0 ? retroColors.numbers : retroColors.loss, fontWeight: 600, fontSize: '1rem' } : {}}
                                  >
                                    {trader.total_pl >= 0 ? '+' : ''}{formatCurrency(trader.total_pl)}
                                  </p>
                                </div>
                                <div>
                                  <p
                                    className={isRetro ? '' : 'text-[10px] text-slate-500 uppercase tracking-wide'}
                                    style={isRetro ? { fontSize: '0.7rem', color: retroColors.textDim, textTransform: 'uppercase', letterSpacing: '0.1em' } : {}}
                                  >
                                    Record
                                  </p>
                                  <p
                                    className={isRetro ? 'font-mono' : 'font-bold text-slate-100 font-mono text-sm'}
                                    style={isRetro ? { fontSize: '1rem', fontWeight: 500 } : {}}
                                  >
                                    <span style={isRetro ? { color: retroColors.numbers } : {}}>{trader.wins || 0}W</span>
                                    <span style={isRetro ? { color: retroColors.textDim } : {}}>-</span>
                                    <span style={isRetro ? { color: retroColors.loss } : {}}>{trader.losses || 0}L</span>
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
            <div
              className={isRetro ? '' : 'bg-slate-900 rounded-lg p-6 max-w-2xl w-full border border-slate-800'}
              style={isRetro ? {
                backgroundColor: retroColors.surface,
                border: `1px solid ${retroColors.border}`,
                borderRadius: '2px',
                padding: '1.5rem',
                maxWidth: '42rem',
                width: '100%',
                              } : {}}
            >
              <div className="flex items-start justify-between mb-5">
                <div className="min-w-0">
                  <h3
                    className={isRetro ? '' : 'text-lg font-semibold text-slate-100 break-all'}
                    style={isRetro ? { color: retroColors.text, fontSize: '1rem', wordBreak: 'break-all', fontFamily: 'monospace' } : {}}
                  >
                    {selectedTrader.address}
                  </h3>
                  <p
                    className={isRetro ? '' : 'text-sm text-slate-400 mt-1'}
                    style={isRetro ? { color: retroColors.textDim, fontSize: '0.9rem', marginTop: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.1em' } : {}}
                  >
                    Trader Profile
                  </p>
                </div>
                <button
                  onClick={() => {
                    setSelectedTrader(null);
                    setTraderTrades([]);
                  }}
                  className={isRetro ? '' : 'text-slate-400 hover:text-slate-200 text-2xl leading-none'}
                  style={isRetro ? { color: retroColors.textDim, fontSize: '1.5rem', lineHeight: 1 } : {}}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {selectedTrader.profitability_rate !== undefined ? (
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div
                    className={isRetro ? '' : 'bg-slate-950 rounded-md p-3 border border-slate-800'}
                    style={isRetro ? {
                      backgroundColor: retroColors.bg,
                      border: `1px solid ${retroColors.border}`,
                      borderRadius: '2px',
                      padding: '1rem',
                    } : {}}
                  >
                    <p style={isRetro ? { color: retroColors.textDim, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em' } : {}} className={isRetro ? '' : 'text-xs text-slate-500'}>Total P/L</p>
                    <p
                      className={isRetro ? '' : `text-xl font-semibold mt-1 ${selectedTrader.total_pl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                      style={isRetro ? {
                        color: selectedTrader.total_pl >= 0 ? retroColors.numbers : retroColors.loss,
                        fontSize: '1.5rem',
                        fontWeight: 600,
                        marginTop: '0.25rem',
                      } : {}}
                    >
                      {selectedTrader.total_pl >= 0 ? '+' : ''}{formatCurrency(selectedTrader.total_pl)}
                    </p>
                  </div>
                  <div
                    className={isRetro ? '' : 'bg-slate-950 rounded-md p-3 border border-slate-800'}
                    style={isRetro ? {
                      backgroundColor: retroColors.bg,
                      border: `1px solid ${retroColors.border}`,
                      borderRadius: '2px',
                      padding: '1rem',
                    } : {}}
                  >
                    <p style={isRetro ? { color: retroColors.textDim, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em' } : {}} className={isRetro ? '' : 'text-xs text-slate-500'}>Record</p>
                    <p
                      className={isRetro ? '' : 'text-xl font-semibold text-slate-100 mt-1'}
                      style={isRetro ? { fontSize: '1.35rem', marginTop: '0.25rem', fontWeight: 500 } : {}}
                    >
                      <span style={isRetro ? { color: retroColors.numbers } : {}}>{selectedTrader.wins || 0}W</span>
                      <span style={isRetro ? { color: retroColors.textDim } : {}}>-</span>
                      <span style={isRetro ? { color: retroColors.loss } : {}}>{selectedTrader.losses || 0}L</span>
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div
                    className={isRetro ? '' : 'bg-slate-950 rounded-md p-3 border border-slate-800'}
                    style={isRetro ? {
                      backgroundColor: retroColors.bg,
                      border: `1px solid ${retroColors.border}`,
                      borderRadius: '2px',
                      padding: '0.75rem',
                    } : {}}
                  >
                    <p style={isRetro ? { color: retroColors.textDim, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' } : {}} className={isRetro ? '' : 'text-xs text-slate-500'}>Total volume</p>
                    <p
                      className={isRetro ? '' : 'text-xl font-semibold text-slate-100 mt-1'}
                      style={isRetro ? { color: retroColors.textBright, fontSize: '1.25rem', marginTop: '0.25rem' } : {}}
                    >
                      {formatCurrency(selectedTrader.total_volume)}
                    </p>
                  </div>
                  <div
                    className={isRetro ? '' : 'bg-slate-950 rounded-md p-3 border border-slate-800'}
                    style={isRetro ? {
                      backgroundColor: retroColors.bg,
                      border: `1px solid ${retroColors.border}`,
                      borderRadius: '2px',
                      padding: '0.75rem',
                    } : {}}
                  >
                    <p style={isRetro ? { color: retroColors.textDim, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' } : {}} className={isRetro ? '' : 'text-xs text-slate-500'}>Total bets</p>
                    <p
                      className={isRetro ? '' : 'text-xl font-semibold text-slate-100 mt-1'}
                      style={isRetro ? { color: retroColors.textBright, fontSize: '1.25rem', marginTop: '0.25rem' } : {}}
                    >
                      {selectedTrader.total_bets}
                    </p>
                  </div>
                </div>
              )}

              {/* Trade History */}
              <div className="mb-6">
                <h4
                  className={isRetro ? 'flex items-center gap-2' : 'text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2'}
                  style={isRetro ? { color: retroColors.accent, fontSize: '1rem', marginBottom: '1rem', letterSpacing: '0.05em' } : {}}
                >
                  <Activity className="w-4 h-4" style={isRetro ? { color: retroColors.text } : {}} />
                  RECENT TRADES
                  <span style={isRetro ? { color: retroColors.textDim, fontSize: '0.8rem', fontWeight: 400 } : {}}>(last 100)</span>
                </h4>

                {loadingTrades ? (
                  <div className="text-center py-8">
                    <div
                      className={isRetro ? '' : 'animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-600 mx-auto'}
                      style={isRetro ? {
                        width: '2rem',
                        height: '2rem',
                        border: `2px solid ${retroColors.textDim}`,
                        borderBottomColor: retroColors.textBright,
                        borderRadius: '50%',
                        margin: '0 auto',
                        animation: 'spin 1s linear infinite',
                      } : {}}
                    />
                    <p
                      className={isRetro ? '' : 'mt-3 text-slate-400 text-sm'}
                      style={isRetro ? { color: retroColors.textDim, marginTop: '0.75rem', fontSize: '0.875rem' } : {}}
                    >
                      Loading trades...
                    </p>
                  </div>
                ) : traderTrades.length === 0 ? (
                  <p
                    className={isRetro ? 'text-center py-6' : 'text-slate-400 text-sm text-center py-6'}
                    style={isRetro ? { color: retroColors.textDim, fontSize: '0.875rem' } : {}}
                  >
                    No trades found
                  </p>
                ) : (
                  <div className="max-h-96 overflow-y-auto pr-2 space-y-3">
                    {traderTrades.map((trade, idx) => {
                      const tradeSideInfo = getSideLabel(trade.side);
                      // Determine if this trade was a win or loss based on market resolution
                      const isResolved = trade.market_resolved;
                      const isWin = isResolved && trade.winning_outcome === trade.outcome;
                      const isLoss = isResolved && trade.winning_outcome && trade.winning_outcome !== trade.outcome;

                      // Dynamic styling based on win/loss for Bridge View
                      const cardBorderClass = isWin
                        ? 'border-emerald-500/40 bg-emerald-500/5'
                        : isLoss
                          ? 'border-rose-500/40 bg-rose-500/5'
                          : 'border-slate-800';

                      // Retro styling with left border indicator
                      const retroCardStyle = isRetro ? {
                        backgroundColor: retroColors.bg,
                        border: `1px solid ${retroColors.border}`,
                        borderLeft: `3px solid ${isWin ? retroColors.win : isLoss ? retroColors.loss : retroColors.textDim}`,
                        borderRadius: '2px',
                        padding: '1rem',
                      } : {};

                      return (
                      <div
                        key={idx}
                        className={isRetro ? '' : `bg-slate-950 rounded-md border p-3 ${cardBorderClass}`}
                        style={retroCardStyle}
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="min-w-0 flex-1">
                            <a
                              href={trade.market_slug ? `https://polymarket.com/market/${trade.market_slug}` : undefined}
                              target="_blank"
                              rel="noreferrer"
                              className={isRetro ? 'block' : 'text-sm font-medium text-slate-200 hover:underline block truncate'}
                              style={isRetro ? { color: retroColors.textPrimary, fontSize: '0.95rem', fontWeight: 400, lineHeight: 1.3 } : {}}
                            >
                              {trade.market_title || trade.market_slug || trade.market_id}
                            </a>
                            <p
                              className={isRetro ? '' : 'text-xs text-slate-500 mt-1'}
                              style={isRetro ? { color: retroColors.textDim, fontSize: '0.75rem', marginTop: '0.35rem' } : {}}
                            >
                              {formatTimestamp(trade.timestamp)}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p
                              className={isRetro ? '' : 'text-sm font-semibold text-slate-100'}
                              style={isRetro ? { color: retroColors.numbers, fontSize: '1rem', fontWeight: 600 } : {}}
                            >
                              {formatCurrency(trade.amount)}
                            </p>
                            <span
                              className={isRetro ? '' : `text-xs font-semibold px-2 py-0.5 rounded mt-1 inline-block border ${tradeSideInfo.color}`}
                              style={isRetro ? {
                                display: 'inline-block',
                                marginTop: '0.25rem',
                                padding: '0.125rem 0.5rem',
                                fontSize: '0.65rem',
                                letterSpacing: '0.05em',
                                border: `1px solid ${retroColors.textDim}`,
                                color: retroColors.text,
                              } : {}}
                            >
                              {tradeSideInfo.label}
                            </span>
                          </div>
                        </div>
                        <div
                          className={isRetro ? 'flex items-center justify-between' : 'flex items-center justify-between text-xs'}
                          style={isRetro ? { fontSize: '0.8rem', marginTop: '0.5rem' } : {}}
                        >
                          <span style={isRetro ? { color: retroColors.textDim } : {}} className={isRetro ? '' : 'text-slate-500'}>
                            Bet: <span style={isRetro ? { color: isWin ? retroColors.numbers : isLoss ? retroColors.loss : retroColors.text, fontWeight: isWin ? 600 : 400 } : {}} className={isRetro ? '' : (isWin ? 'text-emerald-400' : isLoss ? 'text-rose-400' : 'text-slate-300')}>{formatBetPosition(trade.market_title, trade.outcome)}</span>
                            {isWin && <span style={isRetro ? { color: retroColors.numbers, marginLeft: '0.5rem', fontWeight: 600 } : {}} className={isRetro ? '' : 'ml-2 text-emerald-400 font-semibold'}>✓ WIN</span>}
                            {isLoss && <span style={isRetro ? { color: retroColors.loss, marginLeft: '0.5rem', fontWeight: 500 } : {}} className={isRetro ? '' : 'ml-2 text-rose-400 font-semibold'}>✗ LOSS</span>}
                            {!isResolved && <span style={isRetro ? { color: retroColors.textDim, marginLeft: '0.5rem' } : {}} className={isRetro ? '' : 'ml-2 text-slate-500'}>(Pending)</span>}
                          </span>
                          <span style={isRetro ? { color: retroColors.textDim } : {}} className={isRetro ? '' : 'text-slate-500'}>
                            Price: <span style={isRetro ? { color: retroColors.text } : {}} className={isRetro ? '' : 'text-slate-300'}>
                              {Number(trade.price) ? `${(Number(trade.price) * 100).toFixed(0)}¢` : '—'}
                            </span>
                          </span>
                          {trade.shares && (
                            <span style={isRetro ? { color: retroColors.textDim } : {}} className={isRetro ? '' : 'text-slate-500'}>
                              Shares: <span style={isRetro ? { color: retroColors.text } : {}} className={isRetro ? '' : 'text-slate-300'}>
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
                className={isRetro ? '' : `w-full px-4 py-3 rounded-md font-semibold transition-colors border ${
                  watchedTraders.includes(selectedTrader.address)
                    ? 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-100'
                    : 'bg-cyan-600 hover:bg-cyan-700 border-cyan-500/30 text-slate-950'
                }`}
                style={isRetro ? {
                  width: '100%',
                  padding: '0.75rem 1rem',
                  fontFamily: "'VT323', monospace",
                  fontSize: '1rem',
                  letterSpacing: '0.05em',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  background: watchedTraders.includes(selectedTrader.address) ? 'transparent' : `rgba(90, 138, 106, 0.1)`,
                  border: `1px solid ${watchedTraders.includes(selectedTrader.address) ? retroColors.textDim : retroColors.textBright}`,
                  color: watchedTraders.includes(selectedTrader.address) ? retroColors.textDim : retroColors.textBright,
                } : {}}
              >
                {watchedTraders.includes(selectedTrader.address)
                  ? 'Remove from watchlist'
                  : 'Add to watchlist'}
              </button>
            </div>
          </div>
        )}

        {/* Footer note */}
        <div
          className={`mt-6 rounded-lg p-4 ${isRetro ? '' : 'bg-slate-900 border border-slate-800'}`}
          style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}` } : {}}
        >
          <p className="text-sm" style={isRetro ? { color: retroColors.text } : {}}>
            Data syncs automatically every few minutes. <span className="font-semibold" style={isRetro ? { color: retroColors.textBright } : {}}>BUY</span> and <span className="font-semibold" style={isRetro ? { color: retroColors.warn } : {}}>SELL</span> trades are tracked separately.
          </p>
          <p className="text-sm mt-2" style={isRetro ? { color: retroColors.textDim } : {}}>
            Trader profitability accounts for both realized P/L from sells and settlement P/L from remaining shares.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PolymarketTracker;