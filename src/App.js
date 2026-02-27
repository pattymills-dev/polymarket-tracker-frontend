import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  TrendingUp,
  Trophy,
  HelpCircle,
  Search,
  Star,
  Activity,
  Coins,
  Copy,
  Check,
  ExternalLink,
  Send,
  Anchor,
  Navigation,
  ChevronLeft
} from 'lucide-react';
import { useTheme } from './ThemeContext';
import SnakeGameModal from './snake/SnakeGameModal';

const PolymarketTracker = () => {
  const { isRetro, toggleTheme } = useTheme();
  const [largeBets, setLargeBets] = useState([]);
  const [recentTrades, setRecentTrades] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [whaleVolumeTraders, setWhaleVolumeTraders] = useState([]);
  const [watchedTraders, setWatchedTraders] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [marketStats, setMarketStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openExposureMap, setOpenExposureMap] = useState({});

  // const [selectedCategory, setSelectedCategory] = useState('all'); // placeholder for future
  const [minBetSize] = useState(5000); // UI filter for large bets (DB now stores >= $1k)
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [searchAddress, setSearchAddress] = useState('');
  const [betSearchQuery, setBetSearchQuery] = useState(''); // Search filter for large bets
  const [traderSortBy, setTraderSortBy] = useState('total_pl'); // 'total_pl', 'copyable', 'whale_volume'
  const [showSignalKey, setShowSignalKey] = useState(false);
  const [showTipJar, setShowTipJar] = useState(false);
  const [showSnake, setShowSnake] = useState(false);
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [feedFilter, setFeedFilter] = useState('anomaly'); // 'anomaly' | 'isolated' | 'top10' | 'top20' | 'large' | 'all'
  const [selectedFeedTrader, setSelectedFeedTrader] = useState(null); // selected trader address (UI highlight + panel)
  const [onlySelectedWallet, setOnlySelectedWallet] = useState(false); // explicit filter toggle for Activity Feed
  const [selectedTraderTab, setSelectedTraderTab] = useState('activity'); // 'activity' | 'record'
  const [selectedTraderTrades, setSelectedTraderTrades] = useState([]); // trades for Selected Trader panel
  const [selectedTraderRecord, setSelectedTraderRecord] = useState(null); // resolved outcomes for Record tab
  const [loadingSelectedTrader, setLoadingSelectedTrader] = useState(false); // loading state for panel
  const tipJarRef = useRef(null);
  const signalKeyRef = useRef(null);
  const largeBetsScrollRef = useRef(null);
  const tradersScrollRef = useRef(null);
  const [selectedTrader, setSelectedTrader] = useState(null);
  const [traderTrades, setTraderTrades] = useState([]);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [traderTradesDiag, setTraderTradesDiag] = useState(null);
  const [traderTradesLimit, setTraderTradesLimit] = useState(100);

  // Supabase Configuration
  const SUPABASE_URL =
    process.env.REACT_APP_SUPABASE_URL || 'https://smuktlgclwvaxnduuinm.supabase.co';
  const SUPABASE_PUBLIC_KEY =
    process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY ||
    process.env.REACT_APP_SUPABASE_ANON_KEY ||
    '';

  const headers = useMemo(() => {
    const h = {
      apikey: SUPABASE_PUBLIC_KEY,
      'Content-Type': 'application/json'
    };

    // Legacy anon/service_role keys are JWTs; publishable/secret keys are `sb_*` and must not be sent as Authorization bearer tokens.
    if (SUPABASE_PUBLIC_KEY && !SUPABASE_PUBLIC_KEY.startsWith('sb_')) {
      h.Authorization = `Bearer ${SUPABASE_PUBLIC_KEY}`;
    }

    return h;
  }, [SUPABASE_PUBLIC_KEY]);

  useEffect(() => {
    if (!SUPABASE_PUBLIC_KEY) {
      console.error(
        'Missing Supabase public key. Set REACT_APP_SUPABASE_PUBLISHABLE_KEY (preferred) or REACT_APP_SUPABASE_ANON_KEY.'
      );
    }
  }, [SUPABASE_PUBLIC_KEY]);

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

// Format game title for spread/O-U markets to show "Team vs Team" instead of "Spread: Team (-X.X)"
// Uses the slug to extract team codes and format them properly
// e.g., slug "nba-bkn-uta-2026-01-30-spread-home-2pt5" + title "Spread: Jazz (-2.5)" → "Nets vs Jazz"
const formatGameTitle = (marketTitle, marketSlug) => {
  if (!marketTitle) return marketTitle || '—';

  // If it's already a clean format like "Team vs. Team" or "Team vs Team", return as-is
  if (/vs\.?\s/i.test(marketTitle) && !marketTitle.toLowerCase().includes('spread') && !marketTitle.toLowerCase().includes('o/u')) {
    return marketTitle;
  }

  // Try to extract team info from slug for spread markets
  // Format: league-away-home-date-type (e.g., nba-bkn-uta-2026-01-30-spread-home-2pt5)
  if (marketSlug) {
    const slugMatch = marketSlug.match(/^(nba|nhl|mlb|nfl|cbb|cfb|ucl)-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/i);
    if (slugMatch) {
      const league = slugMatch[1].toUpperCase();
      const awayCode = slugMatch[2].toUpperCase();
      const homeCode = slugMatch[3].toUpperCase();

      // League-specific team code mappings
      const nbaTeams = {
        'ATL': 'Hawks', 'BOS': 'Celtics', 'BKN': 'Nets', 'CHA': 'Hornets', 'CHI': 'Bulls',
        'CLE': 'Cavaliers', 'DAL': 'Mavericks', 'DEN': 'Nuggets', 'DET': 'Pistons', 'GSW': 'Warriors',
        'HOU': 'Rockets', 'IND': 'Pacers', 'LAC': 'Clippers', 'LAL': 'Lakers', 'MEM': 'Grizzlies',
        'MIA': 'Heat', 'MIL': 'Bucks', 'MIN': 'Timberwolves', 'NOP': 'Pelicans', 'NYK': 'Knicks',
        'OKC': 'Thunder', 'ORL': 'Magic', 'PHI': '76ers', 'PHX': 'Suns', 'POR': 'Trail Blazers',
        'SAC': 'Kings', 'SAS': 'Spurs', 'TOR': 'Raptors', 'UTA': 'Jazz', 'WAS': 'Wizards',
      };
      const nhlTeams = {
        'ANA': 'Ducks', 'ARI': 'Coyotes', 'BOS': 'Bruins', 'BUF': 'Sabres', 'CAR': 'Hurricanes',
        'CBJ': 'Blue Jackets', 'CGY': 'Flames', 'CHI': 'Blackhawks', 'COL': 'Avalanche',
        'DAL': 'Stars', 'DET': 'Red Wings', 'EDM': 'Oilers', 'FLA': 'Panthers', 'LA': 'Kings',
        'LAS': 'Golden Knights', 'MIN': 'Wild', 'MTL': 'Canadiens', 'NJ': 'Devils', 'NSH': 'Predators',
        'NYI': 'Islanders', 'NYR': 'Rangers', 'OTT': 'Senators', 'PHI': 'Flyers', 'PIT': 'Penguins',
        'SEA': 'Kraken', 'SJ': 'Sharks', 'STL': 'Blues', 'TB': 'Lightning', 'TOR': 'Maple Leafs',
        'VAN': 'Canucks', 'WPG': 'Jets', 'WSH': 'Capitals',
      };

      // Choose the right mapping based on league
      const teamNames = league === 'NHL' ? nhlTeams : nbaTeams;
      const awayName = teamNames[awayCode] || awayCode;
      const homeName = teamNames[homeCode] || homeCode;

      return `${awayName} vs ${homeName}`;
    }
  }

  // Fallback: just return original title if we can't parse
  return marketTitle;
};

// Extract event key from a market slug for grouping sub-markets of the same event
// Sports: "nba-bkn-uta-2026-01-30-spread-home-2pt5" → "nba-bkn-uta-2026-01-30"
// Non-sports: "super-bowl-lix-halftime-show-lady-gaga" → "super-bowl-lix-halftime"
const extractEventKey = (slug) => {
  if (!slug) return null;
  // Sports / esports / combat: strip bet-type suffix after league-teams-date
  const sportsMatch = slug.match(
    /^(nba|nhl|mlb|nfl|cbb|cwbb|cfb|ahl|epl|efl|bun|mls|lal|ser|lig1|copa|mex|bl2|aus|fl1|ere|elc|sea|spl|cbl|udi|acm|por|tur|egy1|bra|arg|chi1|col1|rou1|rusrp|es2|fr2|itsb|den|wta|atp|ufc|cs2|val|lol|dota2|rl|lec|lpl|lck|vct|hok|r6siege|sc2|codmw|bkkbl|bknbl|euroleague|shl|khl|crint|wttmen|wttwom|scop|cze1|mwoh|rusixnat)-([a-z0-9]+-[a-z0-9]+)-(\d{4}-\d{2}-\d{2})/i
  );
  if (sportsMatch) return `${sportsMatch[1]}-${sportsMatch[2]}-${sportsMatch[3]}`.toLowerCase();
  // Non-sports events: keep all but last 2 segments as event key
  // This groups "super-bowl-lix-halftime-show-lady-gaga" and "super-bowl-lix-halftime-show-ricky-martin" together
  const parts = slug.split('-');
  if (parts.length >= 5) return parts.slice(0, parts.length - 2).join('-');
  if (parts.length === 4) return parts.slice(0, 3).join('-');
  return slug;
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
     const MIN_TRADE_AMOUNT = 5000; // Only fetch trades >= $5k for large bets
     const STATS_MIN_AMOUNT = 5000; // High-level stats should match large bets section
    const SMART_MONEY_MIN_AMOUNT = 1000; // Use >= $1k trades for smart money fallback
     const SMART_MONEY_LIMIT = 1000;
     const sevenDaysIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const tradesRes = await fetch(
  `${SUPABASE_URL}/rest/v1/trades?amount=gte.${MIN_TRADE_AMOUNT}&order=timestamp.desc&limit=${FEED_LIMIT}`,
  { headers }
);
      const tradesJson = await tradesRes.json();

      const recentTradesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?amount=gte.${SMART_MONEY_MIN_AMOUNT}&timestamp=gte.${sevenDaysIso}&order=timestamp.desc&limit=${SMART_MONEY_LIMIT}`,
        { headers }
      );
      const recentTradesJson = await recentTradesRes.json();

      if (!tradesRes.ok) {
        console.error('Trades error:', tradesJson);
        setMarketStats(null);
        setLargeBets([]);
        setRecentTrades([]);
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

      // Fetch large-bet stats (>= $5k, last 24h)
const statsRes = await fetch(
  `${SUPABASE_URL}/rest/v1/rpc/whale_stats_24h`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({ min_amount: STATS_MIN_AMOUNT }),
  }
);

const statsArr = await statsRes.json();
const stats = statsArr?.[0] ?? null;

      // Get count of active (unresolved) markets with recent activity
      const marketsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?select=market_id&amount=gte.${STATS_MIN_AMOUNT}&timestamp=gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}`,
        { headers }
      );
      const marketsJson = await marketsRes.json();
      const activeMarkets = marketsRes.ok && Array.isArray(marketsJson)
        ? new Set(marketsJson.map(t => t.market_id)).size
        : 0;

      const trades = Array.isArray(tradesJson) ? tradesJson : [];
      setLargeBets(trades);

      if (recentTradesRes.ok && Array.isArray(recentTradesJson)) {
        setRecentTrades(recentTradesJson);
      } else {
        if (!recentTradesRes.ok) {
          console.error('Recent trades error:', recentTradesJson);
        }
        setRecentTrades([]);
      }

      if (!statsRes.ok) {
  console.error("Stats error:", statsArr);
}

setMarketStats({
  // DB-computed: >= $5k, last 24h (matches large bets section)
  total_volume_24h: stats?.total_volume ?? 0,
  total_trades_24h: stats?.total_trades ?? 0,
  unique_traders_24h: stats?.unique_traders ?? 0,

  // Count of unique markets with trades >= $5k in last 24h
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
          `${SUPABASE_URL}/rest/v1/watchlist?select=trader_address,category`,
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

    // Auto-refresh every 2 minutes (reduced from 60s to improve UX)
    // Preserves scroll position during refresh
    const interval = setInterval(() => {
      // Save scroll positions before refresh
      const largeBetsScroll = largeBetsScrollRef.current?.scrollTop;
      const tradersScroll = tradersScrollRef.current?.scrollTop;

      // Fetch data (will trigger re-renders)
      Promise.all([
        fetchData(),
        fetchProfitability(),
        fetchCopyableTraders(),
        fetchWhaleVolumeTraders(),
        fetchOpenExposure(),
      ]).then(() => {
        // Restore scroll positions after data loads
        requestAnimationFrame(() => {
          if (largeBetsScrollRef.current && largeBetsScroll !== undefined) {
            largeBetsScrollRef.current.scrollTop = largeBetsScroll;
          }
          if (tradersScrollRef.current && tradersScroll !== undefined) {
            tradersScrollRef.current.scrollTop = tradersScroll;
          }
        });
      });
    }, 120000); // 2 minutes
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minBetSize]);

  const toggleWatchTrader = async (address, category = 'manual') => {
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
        // Add to watchlist with category
        await fetch(
          `${SUPABASE_URL}/rest/v1/watchlist`,
          {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ trader_address: address, category })
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

  const fetchTraderTrades = async (address, limit = 100) => {
    setLoadingTrades(true);
    setTraderTradesDiag(null);
    setTraderTradesLimit(limit);
    try {
      // Fetch trades first
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?trader_address=eq.${address}&order=timestamp.desc&limit=${limit}`,
        { headers }
      );
      const trades = await response.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        setTraderTrades([]);
        return;
      }

      // Get unique market IDs from trades
      const marketIds = [...new Set(trades.map(t => t.market_id).filter(Boolean))];

      // Fetch market resolution data separately.
      // IMPORTANT: chunk requests to avoid overly long URLs for active traders (can otherwise fail silently and mark everything as pending).
      const markets = [];
      const marketFetchErrors = [];
      const chunkSize = 40;
      for (let start = 0; start < marketIds.length; start += chunkSize) {
        const chunk = marketIds.slice(start, start + chunkSize);
        const url = `${SUPABASE_URL}/rest/v1/markets?id=in.(${chunk.join(',')})&select=id,resolved,winning_outcome`;
        const marketsResponse = await fetch(url, { headers });
        const data = await marketsResponse.json();

        if (!marketsResponse.ok) {
          console.error('Error fetching markets:', { status: marketsResponse.status, body: data });
          marketFetchErrors.push({ status: marketsResponse.status });
          continue;
        }
        if (Array.isArray(data)) {
          markets.push(...data);
        }
      }
      const marketMap = new Map((Array.isArray(markets) ? markets : []).map(m => [m.id, m]));

      if (marketFetchErrors.length > 0 || marketMap.size < marketIds.length) {
        setTraderTradesDiag({
          marketsRequested: marketIds.length,
          marketsReturned: marketMap.size,
          marketFetchErrors,
        });
      }

      // Merge market resolution data into trades
      const tradesWithResolution = trades.map(trade => {
        const market = marketMap.get(trade.market_id);
        const marketResolved = Boolean(market?.resolved) || market?.winning_outcome != null;
        return {
          ...trade,
          market_resolved: marketResolved,
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

  // Fetch trades + record for the Selected Trader panel
  const fetchSelectedTraderData = async (address) => {
    if (!address) return;
    setLoadingSelectedTrader(true);
    setSelectedTraderTab('activity');
    try {
      // Fetch recent trades (include small trades for fuller picture)
      const tradesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?trader_address=eq.${address}&order=timestamp.desc&limit=50`,
        { headers }
      );
      const trades = await tradesRes.json();

      if (!Array.isArray(trades) || trades.length === 0) {
        setSelectedTraderTrades([]);
        setSelectedTraderRecord({ wins: 0, losses: 0, pending: 0, resolvedTrades: [] });
        return;
      }

      // Fetch market resolution data for these trades
      const marketIds = [...new Set(trades.map(t => t.market_id).filter(Boolean))];
      const markets = [];
      const chunkSize = 40;
      for (let start = 0; start < marketIds.length; start += chunkSize) {
        const chunk = marketIds.slice(start, start + chunkSize);
        const url = `${SUPABASE_URL}/rest/v1/markets?id=in.(${chunk.join(',')})&select=id,resolved,winning_outcome`;
        const marketsResponse = await fetch(url, { headers });
        const data = await marketsResponse.json();
        if (marketsResponse.ok && Array.isArray(data)) {
          markets.push(...data);
        }
      }
      const marketMap = new Map(markets.map(m => [m.id, m]));

      // Merge resolution data
      const tradesWithResolution = trades.map(trade => {
        const market = marketMap.get(trade.market_id);
        const marketResolved = Boolean(market?.resolved) || market?.winning_outcome != null;
        return {
          ...trade,
          market_resolved: marketResolved,
          winning_outcome: market?.winning_outcome || null,
        };
      });

      setSelectedTraderTrades(tradesWithResolution);

      // Build record from resolved trades (dedupe by market_id)
      let wins = 0, losses = 0, pending = 0;
      const seenMarkets = new Set();
      const resolvedTrades = [];
      for (const trade of tradesWithResolution) {
        const marketId = trade.market_id;
        if (seenMarkets.has(marketId)) continue;
        seenMarkets.add(marketId);
        if (trade.market_resolved && trade.winning_outcome) {
          const isWin = trade.outcome === trade.winning_outcome;
          if (isWin) wins++;
          else losses++;
          resolvedTrades.push({
            market_title: trade.market_title,
            market_slug: trade.market_slug,
            outcome: trade.outcome,
            winning_outcome: trade.winning_outcome,
            amount: trade.amount,
            price: trade.price,
            timestamp: trade.timestamp,
            isWin,
          });
        } else {
          pending++;
        }
      }

      setSelectedTraderRecord({ wins, losses, pending, resolvedTrades });
    } catch (error) {
      console.error('Error fetching selected trader data:', error);
      setSelectedTraderTrades([]);
      setSelectedTraderRecord(null);
    } finally {
      setLoadingSelectedTrader(false);
    }
  };

  const fetchWhaleVolumeTraders = async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/whale_volume_traders?order=rank.asc&limit=50`,
        { headers }
      );
      const data = await response.json();

      if (response.ok && Array.isArray(data)) {
        const mapped = data.map((t) => ({
          address: t.trader_address,
          total_volume: Number(t.total_volume || 0),
          total_bets: Number(t.trade_count || 0),
          avg_bet_size: Number(t.avg_trade_size || 0),
          unique_markets: Number(t.unique_markets || 0),
          last_activity: t.last_trade_at || Date.now(),
        }));
        setWhaleVolumeTraders(mapped);
      } else {
        console.error('Whale volume error:', data);
        setWhaleVolumeTraders([]);
      }
    } catch (error) {
      console.error('Error fetching whale volume traders:', error);
      setWhaleVolumeTraders([]);
    }
  };

  const fetchOpenExposure = async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/trader_open_exposure?select=trader_address,open_markets,open_cost,open_abs_exposure`,
        { headers }
      );
      const data = await response.json();

      if (response.ok && Array.isArray(data)) {
        const map = {};
        data.forEach((row) => {
          if (!row.trader_address) return;
          map[row.trader_address.toLowerCase()] = {
            open_markets: Number(row.open_markets || 0),
            open_cost: Number(row.open_cost || 0),
            open_abs_exposure: Number(row.open_abs_exposure || 0),
          };
        });
        setOpenExposureMap(map);
      } else {
        console.error('Open exposure error:', data);
        setOpenExposureMap({});
      }
    } catch (error) {
      console.error('Error fetching open exposure:', error);
      setOpenExposureMap({});
    }
  };

  // Fetch trader profitability data
  const [profitabilityTraders, setProfitabilityTraders] = useState([]);
  const [copyableTraders, setCopyableTraders] = useState([]);

  const fetchProfitability = async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/trader_rankings?top_performer_rank_all_time=not.is.null&order=top_performer_rank_all_time.asc&limit=50`,
        { headers }
      );
      const data = await response.json();

      if (response.ok && Array.isArray(data)) {
        const mappedTraders = data.map(t => {
          const wins = Number(t.wins_all_time || 0);
          const losses = Number(t.losses_all_time || 0);
          const resolved = Number(t.resolved_markets_all_time || 0);
          return {
            address: t.trader_address,
            total_volume: Number(t.total_buy_cost_all_time || 0),
            total_buy_cost: Number(t.total_buy_cost_all_time || 0),
            total_bets: resolved,
            resolved_markets: resolved,
            wins,
            losses,
            win_rate: resolved > 0 ? wins / resolved : 0,
            profitability_rate: 0,
            total_pl: Number(t.realized_pl_all_time || 0),
            avg_bet_size: resolved > 0 ? Number(t.total_buy_cost_all_time || 0) / resolved : 0,
            unique_markets: resolved,
            last_activity: Date.now(),
            current_streak: 0,
            recent_win_rate: 0,
            recent_markets: 0,
            last_resolved_at: null
          };
        });
        setProfitabilityTraders(mappedTraders);
      } else {
        console.error('Profitability API error:', data);
      }
    } catch (error) {
      console.error('Error fetching profitability:', error);
    }
  };

  const fetchCopyableTraders = async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/trader_rankings?copyable_rank_30d=not.is.null&order=copyable_rank_30d.asc&limit=50`,
        { headers }
      );
      const data = await response.json();

      if (response.ok && Array.isArray(data)) {
        const mapped = data.map((t) => {
          const wins = Number(t.wins_30d || 0);
          const losses = Number(t.losses_30d || 0);
          const resolved = Number(t.resolved_trades_30d || 0);
          return {
            address: t.trader_address,
            total_pl: Number(t.realized_pl_30d || 0),
            total_buy_cost: Number(t.resolved_notional_30d || 0),
            resolved_markets: resolved,
            wins,
            losses,
            win_rate: resolved > 0 ? wins / resolved : 0,
            median_trade_notional: Number(t.median_bet_30d || 0),
            copy_score: Number(t.copy_score_30d || 0),
            copyable_rank: Number(t.copyable_rank_30d || 0),
            rank_24h_ago: t.rank_24h_ago_30d != null ? Number(t.rank_24h_ago_30d) : null,
            profitability_rate: 0,
          };
        });
        setCopyableTraders(mapped);
      } else {
        console.error('Copyable traders error:', data);
        setCopyableTraders([]);
      }
    } catch (error) {
      console.error('Error fetching copyable traders:', error);
      setCopyableTraders([]);
    }
  };

  useEffect(() => {
    fetchProfitability();
    fetchCopyableTraders();
    fetchWhaleVolumeTraders();
    fetchOpenExposure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived data for Activity Feed filters
  const top10Addresses = useMemo(() => {
    return new Set(copyableTraders.slice(0, 10).map(t => t.address));
  }, [copyableTraders]);

  const top20Addresses = useMemo(() => {
    return new Set(copyableTraders.slice(0, 20).map(t => t.address));
  }, [copyableTraders]);

  const top20MedianMap = useMemo(() => {
    const map = new Map();
    copyableTraders.slice(0, 20).forEach(t => {
      map.set(t.address, t.median_trade_notional || 0);
    });
    return map;
  }, [copyableTraders]);

  // Trader behavioral profiles — pre-computed from available trade data for anomaly detection
  const traderProfiles = useMemo(() => {
    const source = recentTrades.length > 0 ? recentTrades : largeBets;
    const profiles = new Map();
    for (const trade of source) {
      const addr = trade.trader_address;
      if (!profiles.has(addr)) {
        profiles.set(addr, { trades: [], eventSlugs: new Map(), totalVolume: 0 });
      }
      const p = profiles.get(addr);
      p.trades.push(trade);
      p.totalVolume += Number(trade.amount || 0);
      if (trade.market_slug) {
        const eventKey = extractEventKey(trade.market_slug);
        if (eventKey) {
          if (!p.eventSlugs.has(eventKey)) p.eventSlugs.set(eventKey, new Set());
          p.eventSlugs.get(eventKey).add(trade.market_id);
        }
      }
    }
    return profiles;
  }, [recentTrades, largeBets]);

  // Set of trader addresses from isolated_contact or dormant_whale alerts (for "Isolated" feed filter)
  const alertTraderSet = useMemo(() => {
    const set = new Set();
    for (const alert of alerts) {
      if (['isolated_contact', 'dormant_whale', 'tail_risk'].includes(alert.type) && alert.trader_address) {
        set.add(alert.trader_address);
      }
    }
    return set;
  }, [alerts]);

  // Multi-signal anomaly classifier — returns array of anomaly type strings
  // Types: 'tail_risk', 'size_spike', 'event_specialist', 'rapid_fire', 'watched', 'isolated'
  // IMPORTANT: Must be defined BEFORE filteredBets useMemo which calls it
  const classifyAnomaly = (bet) => {
    const labels = [];
    const amount = Number(bet.amount || 0);
    const price = Number(bet.price || 0);
    const addr = bet.trader_address;
    const profile = traderProfiles.get(addr);

    // 1. TAIL RISK: Large bet at extreme price (<10¢ or >90¢)
    if (price > 0 && price < 0.10 && amount >= 5000) {
      labels.push('tail_risk');
    } else if (price > 0.90 && price < 1.0 && amount >= 5000) {
      labels.push('tail_risk');
    }

    // 2. SIZE SPIKE: Ranked trader making 3x their median (existing logic, renamed)
    if (top20MedianMap.has(addr)) {
      const median = top20MedianMap.get(addr);
      const threshold = Math.max(median * 3, 1000);
      if (amount >= threshold && price >= 0.05 && price <= 0.95) {
        labels.push('size_spike');
      }
    }

    // 3. EVENT SPECIALIST: 3+ sub-markets of the same event from one trader
    if (profile) {
      const thisEventKey = extractEventKey(bet.market_slug);
      if (thisEventKey) {
        for (const [eventKey, marketIds] of profile.eventSlugs) {
          if (marketIds.size >= 3 && thisEventKey === eventKey) {
            labels.push('event_specialist');
            break;
          }
        }
      }
    }

    // 4. RAPID FIRE: 5+ trades within 10-minute window from same wallet
    if (profile && profile.trades.length >= 5) {
      const betTs = new Date(bet.timestamp).getTime();
      if (betTs) {
        const windowMs = 10 * 60 * 1000; // 10 minutes
        let nearbyCount = 0;
        for (const t of profile.trades) {
          const ts = new Date(t.timestamp).getTime();
          if (ts && Math.abs(ts - betTs) <= windowMs) {
            nearbyCount++;
            if (nearbyCount >= 5) {
              labels.push('rapid_fire');
              break;
            }
          }
        }
      }
    }

    // 5. ISOLATED: Trader appears in isolated_contact/dormant_whale/tail_risk alerts
    if (alertTraderSet.has(addr) && labels.length === 0) {
      labels.push('isolated');
    }

    // 6. WATCHED: Watchlisted trader making >= $1K trade (catch-all if no other signals)
    if (watchedTraders.includes(addr) && amount >= 1000 && labels.length === 0) {
      labels.push('watched');
    }

    return labels;
  };

  // Anomaly badge color mapping
  const anomalyBadgeStyles = {
    tail_risk:        { modern: 'border-rose-500/40 text-rose-300 bg-rose-500/10', label: 'TAIL RISK' },
    size_spike:       { modern: 'border-purple-500/40 text-purple-300 bg-purple-500/10', label: 'SIZE SPIKE' },
    event_specialist: { modern: 'border-amber-500/40 text-amber-300 bg-amber-500/10', label: 'EVENT SPECIALIST' },
    rapid_fire:       { modern: 'border-orange-500/40 text-orange-300 bg-orange-500/10', label: 'RAPID FIRE' },
    watched:          { modern: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10', label: 'WATCHED' },
    isolated:         { modern: 'border-purple-500/40 text-purple-300 bg-purple-500/10', label: 'ISOLATED' },
  };

  const anomalyRetroColors = {
    tail_risk:        { border: 'rgba(160, 112, 112, 0.4)', color: 'rgba(160, 112, 112, 0.9)' },
    size_spike:       { border: 'rgba(140, 120, 180, 0.3)', color: 'rgba(140, 120, 180, 0.9)' },
    event_specialist: { border: 'rgba(184, 160, 80, 0.4)', color: 'rgba(184, 160, 80, 0.9)' },
    rapid_fire:       { border: 'rgba(184, 160, 80, 0.4)', color: 'rgba(184, 160, 80, 0.9)' },
    watched:          { border: 'rgba(69, 160, 106, 0.4)', color: 'rgba(69, 160, 106, 0.9)' },
    isolated:         { border: 'rgba(160, 112, 112, 0.4)', color: 'rgba(160, 112, 112, 0.9)' },
  };

  // Activity Feed: filtered trades based on feedFilter + optional onlySelectedWallet + keyword search
  const filteredBets = useMemo(() => {
    const keywordFilter = (bets) => {
      if (!betSearchQuery.trim()) return bets;
      const query = betSearchQuery.toLowerCase().trim();
      return bets.filter(bet => {
        const title = (bet.market_title || '').toLowerCase();
        const outcome = (bet.outcome || '').toLowerCase();
        const slug = (bet.market_slug || '').toLowerCase();
        return title.includes(query) || outcome.includes(query) || slug.includes(query);
      });
    };

    // Wallet filter: only applied when both selectedFeedTrader is set AND onlySelectedWallet is toggled ON
    const walletFilter = (bets) => {
      if (onlySelectedWallet && selectedFeedTrader) {
        return bets.filter(bet => bet.trader_address === selectedFeedTrader);
      }
      return bets;
    };

    // Normal filter modes (no longer overridden by selectedFeedTrader)
    let result;
    switch (feedFilter) {
      case 'large':
        result = (largeBets || []).filter(bet => Number(bet.amount || 0) >= 5000);
        break;

      case 'top10':
        result = (recentTrades.length > 0 ? recentTrades : largeBets).filter(
          bet => top10Addresses.has(bet.trader_address)
        );
        break;

      case 'top20':
        result = (recentTrades.length > 0 ? recentTrades : largeBets).filter(
          bet => top20Addresses.has(bet.trader_address)
        );
        break;

      case 'anomaly':
        result = (recentTrades.length > 0 ? recentTrades : largeBets).filter(bet => {
          return classifyAnomaly(bet).length > 0;
        });
        break;

      case 'isolated':
        result = (recentTrades.length > 0 ? recentTrades : largeBets).filter(bet => {
          return alertTraderSet.has(bet.trader_address);
        });
        break;

      case 'all':
      default:
        result = recentTrades.length > 0 ? recentTrades : largeBets;
        break;
    }

    return keywordFilter(walletFilter(result));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [largeBets, recentTrades, feedFilter, onlySelectedWallet, selectedFeedTrader, betSearchQuery, top10Addresses, top20Addresses, top20MedianMap, traderProfiles, alertTraderSet, watchedTraders]);

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

  // Close signal key dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (signalKeyRef.current && !signalKeyRef.current.contains(event.target)) {
        setShowSignalKey(false);
      }
    };
    if (showSignalKey) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSignalKey]);

  // Calculate smart money metrics from recent trades (7-day fallback)
  const recentActiveTraders = useMemo(() => {
    const sourceTrades = recentTrades && recentTrades.length > 0 ? recentTrades : largeBets;
    if (!sourceTrades || sourceTrades.length === 0) return [];

    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

    // Group trades by trader address
    const traderMap = new Map();

    sourceTrades.forEach(bet => {
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
  }, [recentTrades, largeBets]);

  // Derive selected trader info from all available trader lists
  const selectedTraderInfo = useMemo(() => {
    if (!selectedFeedTrader) return null;
    const addr = selectedFeedTrader;

    // Search in all trader sources
    const allSources = [
      ...copyableTraders.map((t, i) => ({ ...t, sourceRank: i + 1, source: 'copyable' })),
      ...profitabilityTraders.map((t, i) => ({ ...t, sourceRank: i + 1, source: 'profitability' })),
      ...(whaleVolumeTraders || []).map((t, i) => ({ ...t, sourceRank: i + 1, source: 'whale' })),
      ...recentActiveTraders.map((t, i) => ({ ...t, sourceRank: i + 1, source: 'active' })),
    ];

    // Prefer copyable data (has most metrics)
    const match = allSources.find(t => t.address === addr && t.source === 'copyable')
      || allSources.find(t => t.address === addr);

    if (!match) return { address: addr };

    const totalBuyCost = Number(match.total_buy_cost ?? match.total_volume ?? 0);
    const roiPct = totalBuyCost ? (Number(match.total_pl || 0) / totalBuyCost) * 100 : null;

    return {
      address: addr,
      rank: match.source === 'copyable' ? match.sourceRank : null,
      rank_24h_ago: match.rank_24h_ago ?? null,
      total_pl: Number(match.total_pl || 0),
      roiPct,
      wins: Number(match.wins || 0),
      losses: Number(match.losses || 0),
      median_trade_notional: match.median_trade_notional || null,
      resolved_markets: Number(match.resolved_markets || 0),
      source: match.source,
    };
  }, [selectedFeedTrader, copyableTraders, profitabilityTraders, whaleVolumeTraders, recentActiveTraders]);

  const visibleTraders = useMemo(() => {
    const q = (searchAddress || '').trim().toLowerCase();
    const hasResolvedTraders = profitabilityTraders.length >= 5;
    const isCopyable = traderSortBy === 'copyable';
    const isWhale = traderSortBy === 'whale_volume';

    // Top Performers: by P/L
    let tradersToShow = hasResolvedTraders
      ? profitabilityTraders
      : recentActiveTraders.length > 0
        ? recentActiveTraders
        : topTraders || [];

    if (isCopyable) {
      tradersToShow = copyableTraders;
    }
    if (isWhale) {
      tradersToShow = whaleVolumeTraders;
    }

    // Filter by search query
    if (q) {
      tradersToShow = tradersToShow.filter((t) => (t.address || '').toLowerCase().includes(q));
    }

    // Apply sorting
    if (hasResolvedTraders && !isCopyable && !isWhale) {
      tradersToShow = [...tradersToShow].sort((a, b) => {
        if (traderSortBy === 'total_pl') {
          return (b.total_pl || 0) - (a.total_pl || 0);
        }
        return 0;
      });
    }

    return tradersToShow;
  }, [profitabilityTraders, copyableTraders, recentActiveTraders, topTraders, whaleVolumeTraders, searchAddress, traderSortBy]);

  // SONAR TERMINAL PALETTE - Unified token system
  // Desaturated phosphor green, NOT neon/LED. Brightest reserved for numbers only.
  const retroColors = {
    // Backgrounds
    bg: '#070907',                        // Near-black with subtle green cast
    surface: '#0a0d0a',                   // Slightly elevated panels
    surfaceDark: '#050705',               // Recessed/darker areas

    // Borders - etched, not glowing
    border: 'rgba(70, 120, 85, 0.15)',    // Very subtle structural borders
    borderActive: 'rgba(85, 140, 100, 0.25)', // Active states - still subtle
    borderEtched: 'rgba(60, 100, 75, 0.12)', // Pills/buttons - even more subtle

    // Text hierarchy (3 tiers by brightness, not glow)
    // TIER 1 - ACCENT: Dollar amounts, P/L, key numeric signals ONLY
    numbers: '#5FD090',                   // Phosphor green - brightest but desaturated

    // TIER 2 - PRIMARY: Section headers, market titles, important labels
    textPrimary: '#4FB878',               // Readable, slightly less bright than numbers

    // TIER 3 - SECONDARY: Body text, readable content
    text: '#45A06A',                      // Good contrast, clearly secondary
    textBright: '#4AAE70',                // Slight emphasis within secondary tier

    // TIER 4 - TERTIARY: Timestamps, addresses, metadata, helper text
    textDim: '#357A52',                   // Clearly dimmer but still legible
    textMuted: '#2D6846',                 // Lowest tier - microcopy

    // Section headers - slightly brighter than primary for anchoring
    header: '#52C080',                    // Headers should anchor sections

    // Status colors
    warn: '#B8A050',                      // Muted amber for pending
    danger: '#A07070',                    // Muted red

    // Win/loss - keep distinct per spec (don't change these)
    win: '#5FD090',                       // Matches numbers tier
    loss: '#A06060',                      // Muted red for clear distinction

    // Effects - very subtle
    glow: 'rgba(80, 160, 110, 0.04)',     // Nearly imperceptible
  };

  return (
    <div className={`min-h-screen ${isRetro ? 'retro-container' : 'bg-slate-950 text-slate-100 trading-grid-bg'}`}
         style={isRetro ? { backgroundColor: retroColors.bg, color: retroColors.text, fontFamily: "'VT323', monospace", fontSize: '1.05rem', lineHeight: 1.4 } : {}}>
      <div className="max-w-7xl mx-auto px-6 py-6">
        <SnakeGameModal open={showSnake} onClose={() => setShowSnake(false)} />

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
                    {isRetro ? 'SonarStack' : 'Polymarket Tracker'}
                  </h1>
                  <p className={`text-sm mt-1 ${isRetro ? '' : 'text-slate-400'}`}
                     style={isRetro ? { color: retroColors.textDim } : {}}>
                    {isRetro ? '> Prediction Market Whale Monitor' : 'Large trade activity and trader watchlists'}
                  </p>
                </div>
              </div>
              <p className={`text-xs mt-3 ${isRetro ? '' : 'text-slate-500'}`}
                 style={isRetro ? { color: retroColors.textDim } : {}}>
                {isRetro ? `> LAST UPDATE: ${lastUpdate.toLocaleTimeString()}` : `Last updated: ${lastUpdate.toLocaleTimeString()}`}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
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

              {/* Snake Game */}
              <button
                onClick={() => {
                  setShowTipJar(false);
                  setShowSnake(true);
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
                title={isRetro ? 'LAUNCH SNAKE' : 'Play Snake'}
              >
                <Activity className="w-4 h-4" style={isRetro ? { color: retroColors.textDim } : {}} />
                {isRetro ? 'SNAKE' : 'Snake'}
              </button>

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


        {/* Stats - background telemetry for $5k+ trades, last 24h */}
        {marketStats && (
          <div
            className={`mb-6 px-2 ${isRetro ? '' : 'text-slate-500'}`}
            style={isRetro ? { color: retroColors.textDim } : {}}
          >
            {isRetro && (
              <p className="text-center text-xs uppercase tracking-wider mb-3" style={{ color: retroColors.textDim }}>
                LARGE BETS ≥$5K • LAST 24H
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
                <div className="flex items-center justify-between mb-3">
                  <h2 className={`flex items-center gap-2 ${isRetro ? '' : 'text-lg font-semibold'}`} style={isRetro ? { color: retroColors.header, fontWeight: 500, letterSpacing: '0.08em', fontSize: '1.2rem' } : {}}>
                    <Activity className="w-5 h-5" style={isRetro ? { color: retroColors.textDim } : {}} />
                    {isRetro ? 'ACTIVITY FEED' : 'Activity Feed'}
                  </h2>
                  <div className="text-xs" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.85rem' } : {}}>
                    {filteredBets.length} trades
                    {onlySelectedWallet && selectedFeedTrader && ` by ${selectedFeedTrader.slice(0, 6)}...`}
                    {feedFilter === 'large' && ' (>=$5k)'}
                    {feedFilter === 'anomaly' && ' (anomaly)'}
                    {feedFilter === 'isolated' && ' (isolated)'}
                    {feedFilter === 'top10' && ' (top 10)'}
                    {feedFilter === 'top20' && ' (top 20)'}
                  </div>
                </div>

                {/* Feed filter pills */}
                <div className="flex items-center gap-1 mb-3 flex-wrap">
                  {[
                    { key: 'anomaly', label: isRetro ? 'ANOMALY' : 'Anomaly' },
                    { key: 'isolated', label: isRetro ? 'ISOLATED' : 'Isolated' },
                    { key: 'top10', label: isRetro ? 'TOP 10' : 'Top 10' },
                    { key: 'top20', label: isRetro ? 'TOP 20' : 'Top 20' },
                    { key: 'large', label: isRetro ? 'LARGE' : 'Large Bets' },
                    { key: 'all', label: isRetro ? 'ALL' : 'All Activity' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setFeedFilter(key)}
                      className={`px-3 py-1.5 rounded text-xs transition-colors ${
                        isRetro ? '' : (
                          feedFilter === key
                            ? 'bg-cyan-600 text-white'
                            : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                        )
                      }`}
                      style={isRetro ? {
                        backgroundColor: feedFilter === key ? retroColors.text : retroColors.bg,
                        color: feedFilter === key ? retroColors.bg : retroColors.textDim,
                        border: `1px solid ${feedFilter === key ? retroColors.text : retroColors.borderEtched}`,
                        fontSize: '0.9rem',
                      } : {}}
                    >
                      {label}
                    </button>
                  ))}
                  {/* Signal Key dropdown */}
                  <div className="relative ml-auto" ref={signalKeyRef}>
                    <button
                      onClick={() => setShowSignalKey(prev => !prev)}
                      className={`p-1.5 rounded transition-colors ${
                        isRetro ? '' : (
                          showSignalKey
                            ? 'bg-cyan-600/20 text-cyan-300'
                            : 'text-slate-500 hover:text-slate-300'
                        )
                      }`}
                      style={isRetro ? {
                        color: showSignalKey ? retroColors.text : retroColors.textDim,
                      } : {}}
                      title="Signal definitions"
                    >
                      <HelpCircle className="w-4 h-4" />
                    </button>
                    {showSignalKey && (
                      <div
                        className={`absolute right-0 mt-2 w-80 rounded-lg shadow-xl z-50 p-4 ${
                          isRetro ? '' : 'bg-slate-900 border border-slate-700'
                        }`}
                        style={isRetro ? {
                          backgroundColor: retroColors.surface,
                          border: `1px solid ${retroColors.border}`,
                        } : {}}
                      >
                        <div className="font-medium mb-3 text-xs" style={isRetro ? { color: retroColors.header, letterSpacing: '0.08em' } : { color: 'rgb(226, 232, 240)' }}>
                          {isRetro ? '> SIGNAL CLASSIFICATIONS' : 'Signal Classifications'}
                        </div>
                        <div className="space-y-2">
                          {[
                            { label: 'TAIL RISK', desc: '$5K+ bet at extreme odds (<10¢ or >90¢)', modern: 'border-rose-500/40 text-rose-300 bg-rose-500/10', retroColor: retroColors.danger },
                            { label: 'SIZE SPIKE', desc: 'Ranked trader betting 3x their median', modern: 'border-purple-500/40 text-purple-300 bg-purple-500/10', retroColor: retroColors.textDim },
                            { label: 'EVENT SPECIALIST', desc: '3+ sub-markets of same event from one wallet', modern: 'border-amber-500/40 text-amber-300 bg-amber-500/10', retroColor: retroColors.warn },
                            { label: 'RAPID FIRE', desc: '5+ trades within 10 minutes', modern: 'border-orange-500/40 text-orange-300 bg-orange-500/10', retroColor: retroColors.warn },
                            { label: 'ISOLATED', desc: 'Rare trader, outsized bet in thin market', modern: 'border-purple-500/40 text-purple-300 bg-purple-500/10', retroColor: retroColors.danger },
                            { label: 'DORMANT', desc: 'Wallet inactive 180+ days suddenly active', modern: 'border-amber-500/40 text-amber-300 bg-amber-500/10', retroColor: retroColors.warn },
                            { label: 'WATCHED', desc: 'Watchlisted trader making $1K+ trade', modern: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10', retroColor: retroColors.text },
                          ].map(({ label, desc, modern, retroColor }) => (
                            <div key={label} className="flex items-start gap-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap ${isRetro ? '' : modern}`}
                                style={isRetro ? { border: `1px solid ${retroColor}`, color: retroColor, fontSize: '0.7rem' } : {}}
                              >
                                {label}
                              </span>
                              <span className="text-xs leading-tight" style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(148, 163, 184)' }}>
                                {desc}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Only Selected Wallet toggle — appears when a trader is selected */}
                  {selectedFeedTrader && (
                    <button
                      onClick={() => setOnlySelectedWallet(prev => !prev)}
                      className={`px-3 py-1.5 rounded text-xs transition-colors ml-1 ${
                        isRetro ? '' : (
                          onlySelectedWallet
                            ? 'bg-purple-600 text-white border border-purple-500/50'
                            : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                        )
                      }`}
                      style={isRetro ? {
                        backgroundColor: onlySelectedWallet ? 'rgba(120, 100, 160, 0.25)' : retroColors.bg,
                        color: onlySelectedWallet ? '#B8A0D0' : retroColors.textDim,
                        border: `1px solid ${onlySelectedWallet ? 'rgba(120, 100, 160, 0.4)' : retroColors.borderEtched}`,
                        fontSize: '0.9rem',
                      } : {}}
                      title={`Filter feed to selected trader: ${selectedFeedTrader.slice(0, 8)}...`}
                    >
                      {isRetro
                        ? `${onlySelectedWallet ? '◉' : '○'} ${selectedFeedTrader.slice(0, 6)}…`
                        : `${onlySelectedWallet ? '◉' : '○'} ${selectedFeedTrader.slice(0, 6)}…`
                      }
                    </button>
                  )}
                </div>

                {/* Search filter */}
                <div className="mb-4">
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="Search markets (e.g. Iran, Bitcoin, Lakers)..."
                      value={betSearchQuery}
                      onChange={(e) => setBetSearchQuery(e.target.value)}
                      className={`w-full px-3 py-2 pl-9 rounded-lg border text-sm ${
                        isRetro
                          ? ''
                          : 'bg-slate-800/50 border-slate-700 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 focus:outline-none'
                      }`}
                      style={isRetro ? {
                        backgroundColor: retroColors.bg,
                        border: `1px solid ${retroColors.border}`,
                        color: retroColors.text,
                        fontSize: '0.9rem'
                      } : {}}
                    />
                    <svg
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                      style={{ color: isRetro ? retroColors.textMuted : 'rgb(100, 116, 139)' }}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {betSearchQuery && (
                      <button
                        onClick={() => setBetSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                        style={isRetro ? { color: retroColors.textMuted } : {}}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {filteredBets.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-sm" style={isRetro ? { color: retroColors.textDim } : {}}>
                      {betSearchQuery
                        ? (isRetro ? `> NO MATCHES FOR "${betSearchQuery.toUpperCase()}"` : `No trades matching "${betSearchQuery}" found.`)
                        : onlySelectedWallet && selectedFeedTrader
                          ? (isRetro ? '> NO TRADES FOUND FOR THIS TRADER' : 'No trades found for this trader in the current dataset.')
                          : feedFilter === 'anomaly'
                            ? (isRetro ? '> NO ANOMALIES DETECTED' : 'No anomalous trades detected right now.')
                            : feedFilter === 'isolated'
                              ? (isRetro ? '> NO ISOLATED CONTACTS DETECTED' : 'No recent isolated contact activity.')
                              : feedFilter === 'top10' || feedFilter === 'top20'
                              ? (isRetro ? '> NO RECENT TRADES FROM TOP TRADERS' : `No recent trades from ${feedFilter === 'top10' ? 'top 10' : 'top 20'} traders.`)
                              : feedFilter === 'large'
                                ? (isRetro ? '> NO TRADES ABOVE $5,000 YET. MONITORING...' : 'No trades above $5,000 yet.')
                                : (isRetro ? '> NO TRADES YET. MONITORING...' : 'No trades yet. Data syncs automatically.')
                      }
                    </p>
                    {(betSearchQuery || (onlySelectedWallet && selectedFeedTrader)) && (
                      <button
                        onClick={() => { setBetSearchQuery(''); setOnlySelectedWallet(false); }}
                        className="mt-3 text-sm px-4 py-1.5 rounded-lg"
                        style={isRetro
                          ? { color: retroColors.text, border: `1px solid ${retroColors.border}` }
                          : { color: 'rgb(148, 163, 184)', border: '1px solid rgb(51, 65, 85)' }
                        }
                      >
                        {isRetro ? 'CLEAR FILTER' : 'Clear filter'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div ref={largeBetsScrollRef} className="flex-1 overflow-y-auto pr-2 space-y-3">
                    {filteredBets.map((bet, idx) => {
                      const isWatched = watchedTraders.includes(bet.trader_address);
                      const sizeLabel = getBetSizeLabel(bet.amount);
                      const sideInfo = getSideLabel(bet.side);
                      const isSelectedTraderTrade = selectedFeedTrader && bet.trader_address === selectedFeedTrader;
                      const anomalyLabels = classifyAnomaly(bet);
                      return (
                        <div
                          key={idx}
                          className={`rounded-lg border p-3 transition-all hover:shadow-lg ${
                            isRetro
                              ? ''
                              : (isSelectedTraderTrade
                                ? 'bg-emerald-950/20 border-emerald-500/25 border-l-emerald-500/60'
                                : isWatched ? 'bg-slate-950 border-cyan-500/30 shadow-cyan-500/10' : `bg-slate-950 ${getBetBorderColor(bet.amount)}`)
                          }`}
                          style={{
                            ...(isRetro ? {
                              backgroundColor: isSelectedTraderTrade ? 'rgba(80, 160, 110, 0.08)' : retroColors.surface,
                              border: `1px solid ${isSelectedTraderTrade ? retroColors.borderActive : (isWatched ? retroColors.textBright : retroColors.border)}`,
                              borderLeft: isSelectedTraderTrade ? `3px solid ${retroColors.win}` : undefined,
                              borderColor: !isSelectedTraderTrade && isWatched ? retroColors.borderActive : undefined,
                            } : {
                              borderLeftWidth: isSelectedTraderTrade ? '3px' : undefined,
                            }),
                          }}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              {/* Row 1: Time + Size Badge + Watching */}
                              <div className="flex items-center gap-2 mb-2.5 flex-wrap">
                                <span className="text-xs font-mono" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.9rem' } : {}}>
                                  {formatTimestamp(bet.timestamp)}
                                </span>
                                {sizeLabel && (
                                  <span
                                    className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide ${isRetro ? '' : sizeLabel.color}`}
                                    style={isRetro ? { border: `1px solid rgba(184, 160, 80, 0.4)`, color: retroColors.warn, fontSize: '0.7rem' } : {}}
                                  >
                                    {sizeLabel.label}
                                  </span>
                                )}
                                {isWatched && (
                                  <span
                                    className="inline-flex items-center gap-1 text-xs"
                                    style={isRetro ? { color: retroColors.text } : {}}
                                  >
                                    <Star className="w-3.5 h-3.5" style={isRetro ? { fill: retroColors.text, color: retroColors.text } : { fill: 'rgb(103, 232, 249)', color: 'rgb(103, 232, 249)' }} />
                                    {isRetro ? 'WATCHING' : 'Watching'}
                                  </span>
                                )}
                                {anomalyLabels.slice(0, 2).map(label => {
                                  const style = anomalyBadgeStyles[label];
                                  const retroStyle = anomalyRetroColors[label];
                                  if (!style) return null;
                                  return (
                                    <span
                                      key={label}
                                      className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide ${
                                        isRetro ? '' : style.modern
                                      }`}
                                      style={isRetro ? {
                                        border: `1px solid ${retroStyle?.border || 'rgba(140, 120, 180, 0.3)'}`,
                                        color: retroStyle?.color || 'rgba(140, 120, 180, 0.9)',
                                        fontSize: '0.7rem',
                                      } : {}}
                                    >
                                      {style.label}
                                    </span>
                                  );
                                })}
                              </div>

                              {/* Market Title - primary tier, readable at a glance */}
                              <a
                                href={bet.market_slug ? `https://polymarket.com/market/${bet.market_slug}` : undefined}
                                target="_blank"
                                rel="noreferrer"
                                className={`font-semibold mb-2 hover:underline block transition-colors line-clamp-2 ${isRetro ? '' : 'text-base hover:text-cyan-400'}`}
                                style={isRetro ? { color: retroColors.textPrimary, fontWeight: 500, fontSize: '1.15rem', lineHeight: 1.35 } : {}}
                              >
                                {formatGameTitle(bet.market_title, bet.market_slug) || bet.market_id}
                              </a>

                              {/* Outcome badge - etched outlines, not glowing */}
                              <div
                                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm font-bold ${isRetro ? '' : (sideInfo.label === 'BUY' ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-rose-500/10 border-rose-500/40')}`}
                                style={isRetro ? {
                                  border: `1px solid ${sideInfo.label === 'BUY' ? retroColors.borderEtched : 'rgba(160, 140, 70, 0.3)'}`,
                                  backgroundColor: 'rgba(0,0,0,0.2)'
                                } : {}}
                              >
                                <span style={isRetro ? { color: sideInfo.label === 'BUY' ? retroColors.textDim : 'rgba(184, 160, 80, 0.8)', fontSize: '0.95rem' } : { color: sideInfo.label === 'BUY' ? 'rgb(52, 211, 153)' : 'rgb(251, 113, 133)' }}>
                                  {sideInfo.label}
                                </span>
                                <span
                                  className="font-bold"
                                  style={isRetro ? { color: retroColors.text, fontSize: '1rem' } : { color: 'rgb(226, 232, 240)' }}
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

            {/* Right Column: Top Traders or Selected Trader Panel */}
            <div className="lg:col-span-1 relative">
              {/* Top Traders - hidden when a trader is selected */}
              <div
                className={`rounded-lg border p-6 sticky top-6 flex flex-col h-[1200px] transition-all duration-200 ${
                  selectedFeedTrader ? 'hidden' : ''
                } ${isRetro ? '' : 'bg-slate-900 border-slate-800'}`}
                style={isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}`, marginTop: '0.5rem' } : {}}
              >
                <div className="flex items-center justify-between mb-5">
                  <h2 className={`flex items-center gap-2 ${isRetro ? '' : 'text-lg font-semibold'}`} style={isRetro ? { color: retroColors.header, fontWeight: 500, letterSpacing: '0.08em', fontSize: '1.2rem' } : {}}>
                    <Trophy className="w-5 h-5" style={isRetro ? { color: retroColors.textDim } : {}} />
                    {isRetro
                      ? (traderSortBy === 'whale_volume'
                        ? 'TOP SPENDERS'
                        : traderSortBy === 'copyable'
                          ? 'TOP TRADERS (30D)'
                          : (profitabilityTraders.length >= 5 ? 'TOP PERFORMERS' : 'SMART MONEY'))
                      : (traderSortBy === 'whale_volume'
                        ? 'Top Spenders'
                        : traderSortBy === 'copyable'
                          ? 'Top Traders (30D)'
                          : (profitabilityTraders.length >= 5 ? 'Top Performers' : 'Smart money (7d)'))}
                    {isRetro && (
                      <span style={{ color: retroColors.textMuted, fontSize: '0.75rem', marginLeft: '0.5rem', fontWeight: 400 }}>
                        {traderSortBy === 'whale_volume'
                          ? 'VOLUME (30D)'
                          : traderSortBy === 'copyable'
                            ? '30D ROI'
                            : (profitabilityTraders.length >= 5 ? 'RESOLVED (ALL-TIME)' : '7D')}
                      </span>
                    )}
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

                  {(profitabilityTraders.length >= 5 || whaleVolumeTraders.length > 0) && (
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
                            backgroundColor: traderSortBy === 'total_pl' ? retroColors.text : retroColors.bg,
                            color: traderSortBy === 'total_pl' ? retroColors.bg : retroColors.textDim,
                            border: `1px solid ${traderSortBy === 'total_pl' ? retroColors.text : retroColors.borderEtched}`,
                            fontSize: '0.9rem'
                          } : {}}
                          title="Total realized profit/loss in USD from resolved markets"
                        >
                          {isRetro ? 'P/L' : 'Total P/L'}
                        </button>
                        <button
                          onClick={() => setTraderSortBy('copyable')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            isRetro
                              ? ''
                              : (traderSortBy === 'copyable'
                                ? 'bg-cyan-600 text-white'
                                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800')
                          }`}
                          style={isRetro ? {
                            backgroundColor: traderSortBy === 'copyable' ? retroColors.text : retroColors.bg,
                            color: traderSortBy === 'copyable' ? retroColors.bg : retroColors.textDim,
                            border: `1px solid ${traderSortBy === 'copyable' ? retroColors.text : retroColors.borderEtched}`,
                            fontSize: '0.9rem'
                          } : {}}
                          title="Ranked by copyability score: ROI potential + meaningful size + evidence (excludes extreme-price trades)"
                        >
                          {isRetro ? '📈 ROI' : '📈 Copyable'}
                        </button>
                        <button
                          onClick={() => setTraderSortBy('whale_volume')}
                          className={`px-3 py-1.5 rounded transition-colors ${
                            isRetro
                              ? ''
                              : (traderSortBy === 'whale_volume'
                                ? 'bg-cyan-600 text-white'
                                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800')
                          }`}
                          style={isRetro ? {
                            backgroundColor: traderSortBy === 'whale_volume' ? retroColors.text : retroColors.bg,
                            color: traderSortBy === 'whale_volume' ? retroColors.bg : retroColors.textDim,
                            border: `1px solid ${traderSortBy === 'whale_volume' ? retroColors.text : retroColors.borderEtched}`,
                            fontSize: '0.9rem'
                          } : {}}
                          title="Biggest spenders by 30-day volume"
                        >
                          {isRetro ? '💸 VOL' : '💸 Volume'}
                        </button>
                      </div>
                      <p className="text-[10px] italic" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.8rem' } : {}}>
                        {traderSortBy === 'total_pl' && (isRetro ? '> RANKED BY TOTAL PROFIT/LOSS' : '💰 Ranked by total realized P/L')}
                        {traderSortBy === 'copyable' && (isRetro ? '> RANKED BY ROI POTENTIAL (EXCL. EXTREME-PRICE TRADES)' : '📈 Ranked by ROI potential (excludes extreme-price trades)')}
                        {traderSortBy === 'whale_volume' && (isRetro ? '> RANKED BY 30D VOLUME' : '💸 Ranked by 30-day volume')}
                      </p>
                    </div>
                  )}

                </div>

                {visibleTraders.length === 0 ? (
                  <p className="text-sm text-center py-8" style={isRetro ? { color: retroColors.textDim } : {}}>
                    {traderSortBy === 'copyable'
                      ? (isRetro ? '> NO COPYABLE DATA YET' : 'No copyable traders yet')
                      : traderSortBy === 'whale_volume'
                        ? (isRetro ? '> NO VOLUME DATA YET' : 'No volume data yet')
                        : (isRetro ? '> NO TRADER DATA YET' : 'No trader data yet')}
                  </p>
                ) : (
                  <div ref={tradersScrollRef} className="flex-1 overflow-y-auto pr-2 space-y-4">
                    {visibleTraders.map((trader, index) => {
                      const isWatched = watchedTraders.includes(trader.address);
                      const rankColor = index === 0 ? (isRetro ? retroColors.warn : 'text-amber-400') : index === 1 ? (isRetro ? retroColors.textDim : 'text-slate-300') : index === 2 ? (isRetro ? 'rgba(184, 160, 80, 0.7)' : 'text-orange-600') : (isRetro ? retroColors.textMuted : 'text-slate-500');
                      // Confidence calculation based on resolved trades
                      const resolvedCount = Number(trader.resolved_markets || 0);
                      const confidenceLevel = resolvedCount >= 30 ? 3 : resolvedCount >= 15 ? 2 : resolvedCount >= 10 ? 1 : 0;
                      const confidenceDots = `${'●'.repeat(confidenceLevel)}${'○'.repeat(Math.max(0, 3 - confidenceLevel))}` || '○○○';
                      const exposure = trader.address
                        ? openExposureMap[String(trader.address).toLowerCase()]
                        : null;
                      const openExposure = exposure?.open_abs_exposure;
                      const openMarkets = exposure?.open_markets;
                      const totalBuyCost = Number(trader.total_buy_cost ?? trader.total_volume ?? 0);
                      const roiPct = totalBuyCost ? (Number(trader.total_pl || 0) / totalBuyCost) * 100 : null;
                      const isSelectedForFeed = selectedFeedTrader === trader.address;
                      return (
                        <div
                          key={trader.address}
                          className={`rounded-xl p-4 border-2 cursor-pointer transition-all hover:scale-[1.01] shadow-sm ${
                            isRetro
                              ? ''
                              : (isSelectedForFeed
                                ? 'bg-cyan-950/40 border-cyan-500/60 shadow-cyan-500/20 ring-1 ring-cyan-500/30'
                                : isWatched ? 'bg-slate-900/80 border-cyan-500/50 shadow-cyan-500/10' : 'bg-slate-900/60 border-slate-700/60 hover:border-slate-600 hover:bg-slate-900/80')
                          }`}
                          style={isRetro ? {
                            backgroundColor: isSelectedForFeed ? 'rgba(80, 160, 110, 0.1)' : retroColors.surface,
                            border: `2px solid ${isSelectedForFeed ? retroColors.textBright : (isWatched ? retroColors.textBright : retroColors.border)}`,
                            borderColor: isSelectedForFeed ? retroColors.textBright : (isWatched ? retroColors.borderActive : retroColors.border),
                            boxShadow: isSelectedForFeed ? `0 0 12px ${retroColors.glow}` : '0 2px 8px rgba(0,0,0,0.3)'
                          } : {}}
                          onClick={() => {
                            const newSelection = selectedFeedTrader === trader.address ? null : trader.address;
                            setSelectedFeedTrader(newSelection);
                            if (!newSelection) {
                              setOnlySelectedWallet(false);
                              setSelectedTraderTrades([]);
                              setSelectedTraderRecord(null);
                            } else {
                              fetchSelectedTraderData(newSelection);
                            }
                          }}
                        >
                          {/* Header: Rank badge + Address + Star */}
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="flex items-center gap-3 min-w-0">
                              {/* Rank badge - more prominent */}
                              <div
                                className={`flex items-center justify-center rounded-lg font-bold text-sm min-w-[36px] h-[28px] ${
                                  isRetro ? '' : (index < 3 ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400')
                                }`}
                                style={isRetro ? {
                                  backgroundColor: index < 3 ? 'rgba(201, 168, 75, 0.15)' : retroColors.surfaceAlt,
                                  color: rankColor,
                                  border: `1px solid ${index < 3 ? 'rgba(201, 168, 75, 0.3)' : retroColors.border}`
                                } : {}}
                              >
                                #{index + 1}
                              </div>
                              {/* Rank delta indicator (30D only) */}
                              {traderSortBy === 'copyable' && trader.rank_24h_ago != null && (() => {
                                const currentRank = index + 1;
                                const delta = trader.rank_24h_ago - currentRank;
                                if (delta > 0) return (
                                  <span className="text-[10px] font-bold" style={isRetro ? { color: retroColors.win } : { color: 'rgb(52, 211, 153)' }}>
                                    ▲{delta}
                                  </span>
                                );
                                if (delta < 0) return (
                                  <span className="text-[10px] font-bold" style={isRetro ? { color: retroColors.loss } : { color: 'rgb(251, 113, 133)' }}>
                                    ▼{Math.abs(delta)}
                                  </span>
                                );
                                return (
                                  <span className="text-[10px]" style={isRetro ? { color: retroColors.textMuted } : { color: 'rgb(100, 116, 139)' }}>
                                    —
                                  </span>
                                );
                              })()}
                              {/* Address with truncation */}
                              <p className="font-mono text-sm truncate flex-1" style={isRetro ? { color: retroColors.text } : { color: 'rgb(226, 232, 240)' }}>
                                {trader.address?.slice(0, 10)}…{trader.address?.slice(-4)}
                              </p>
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

                          {/* Secondary row: Record + Median + Confidence */}
                          <p className="text-xs font-mono mt-1 mb-2" style={isRetro ? { fontSize: '0.85rem' } : {}}>
                            <span style={isRetro ? { color: retroColors.textBright, fontWeight: 500 } : { color: 'rgb(226, 232, 240)' }}>
                              {trader.wins || 0}W–{trader.losses || 0}L
                            </span>
                            {traderSortBy === 'copyable' && trader.median_trade_notional && (
                              <>
                                <span style={isRetro ? { color: retroColors.textMuted } : { color: 'rgb(100, 116, 139)' }}> · </span>
                                <span style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>Med </span>
                                <span style={isRetro ? { color: retroColors.textBright, fontWeight: 500 } : { color: 'rgb(226, 232, 240)' }}>
                                  {formatCurrency(trader.median_trade_notional)}
                                </span>
                              </>
                            )}
                            <span style={isRetro ? { color: retroColors.textMuted } : { color: 'rgb(100, 116, 139)' }}> · </span>
                            <span
                              title={`Confidence\n━━━━━━━━━━━━━━━━\nReliability based on sample size.\n\n• Resolved: ${resolvedCount} trades${traderSortBy === 'copyable' ? '\n• Timeframe: 30 days' : ''}\n\n●●● = 30+ trades\n●●○ = 15-29 trades\n●○○ = 10-14 trades\n○○○ = <10 trades`}
                              style={isRetro ? { color: retroColors.textMuted, cursor: 'help' } : { color: 'rgb(100, 116, 139)', cursor: 'help' }}
                            >
                              {confidenceDots}
                            </span>
                          </p>

                          {/* View Profile button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTrader(trader);
                              fetchTraderTrades(trader.address, 100);
                            }}
                            className={`text-[10px] px-2 py-1 rounded border transition-colors mb-1 ${
                              isRetro ? '' : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                            }`}
                            style={isRetro ? {
                              border: `1px solid ${retroColors.borderEtched}`,
                              color: retroColors.textDim,
                              fontSize: '0.8rem',
                            } : {}}
                          >
                            {isRetro ? 'PROFILE' : 'View Profile'}
                          </button>

                          {/* Show profitability metrics if available */}
                          {trader.profitability_rate !== undefined ? (
                            <>
                              <div
                                className={isRetro ? 'grid grid-cols-2 gap-3 mt-3 pt-3' : 'grid grid-cols-2 gap-2 mt-2.5 pt-2.5 border-t border-slate-800/50'}
                                style={isRetro ? { borderTop: `1px solid ${retroColors.border}` } : {}}
                              >
                                <div className="min-w-0">
                                  <p
                                    className={isRetro ? '' : 'text-xs text-slate-500 uppercase tracking-wide'}
                                    style={isRetro ? { fontSize: '0.7rem', color: retroColors.textDim, textTransform: 'uppercase', letterSpacing: '0.1em' } : {}}
                                  >
                                    {traderSortBy === 'copyable' ? 'P/L (30D)' : 'Total P/L'}
                                  </p>
                                  <p
                                    className={isRetro ? 'font-mono truncate' : `font-bold font-mono text-sm truncate ${trader.total_pl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                                    style={isRetro ? { color: trader.total_pl >= 0 ? retroColors.numbers : retroColors.loss, fontWeight: 600, fontSize: '0.95rem' } : {}}
                                  >
                                    {trader.total_pl >= 0 ? '+' : ''}{formatCurrency(trader.total_pl)}
                                  </p>
                                </div>
                                <div className="min-w-0">
                                  <p
                                    className={isRetro ? '' : 'text-xs text-slate-500 uppercase tracking-wide'}
                                    style={isRetro ? { fontSize: '0.7rem', color: retroColors.textDim, textTransform: 'uppercase', letterSpacing: '0.1em' } : {}}
                                  >
                                    {traderSortBy === 'copyable' ? 'ROI (30D)' : 'ROI'}
                                  </p>
                                  <p
                                    className={isRetro ? 'font-mono truncate' : 'font-bold font-mono text-sm truncate'}
                                    style={isRetro ? { fontSize: '0.95rem', fontWeight: 600, color: roiPct != null && roiPct >= 0 ? retroColors.numbers : retroColors.loss } : {}}
                                  >
                                    <span style={isRetro ? {} : { color: roiPct != null && roiPct >= 0 ? 'rgb(52, 211, 153)' : 'rgb(251, 113, 133)' }}>
                                      {roiPct == null ? '—' : `${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}%`}
                                    </span>
                                  </p>
                                </div>
                              </div>
                              {traderSortBy !== 'copyable' && openMarkets != null && Number(openMarkets) > 0 && (
                                <div
                                  className={isRetro ? 'mt-2 pt-2' : 'mt-2 pt-2'}
                                  style={isRetro ? { borderTop: `1px solid ${retroColors.border}` } : { borderTop: '1px solid rgba(30, 41, 59, 0.5)' }}
                                >
                                  <p
                                    className={isRetro ? 'font-mono' : 'font-mono text-xs text-slate-100'}
                                    style={isRetro ? { fontSize: '0.95rem', color: retroColors.text } : {}}
                                  >
                                    <span style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                                      Open
                                    </span>
                                    <span style={isRetro ? { color: retroColors.textMuted } : { color: 'rgb(100, 116, 139)' }}>:</span>
                                    <span style={isRetro ? { color: retroColors.textBright } : { color: 'rgb(226, 232, 240)' }}>
                                      {' '}{openMarkets || 0} mkts
                                    </span>
                                    <span style={isRetro ? { color: retroColors.textMuted } : { color: 'rgb(100, 116, 139)' }}> · </span>
                                    <span style={isRetro ? { color: retroColors.textBright } : { color: 'rgb(226, 232, 240)' }}>
                                      {formatCurrency(openExposure)}
                                    </span>
                                  </p>
                                </div>
                              )}
                              {/* Streaks removed from list view per spec - available in detail modal only */}
                            </>
                          ) : (
                            <>
                              {/* Top Spenders: Volume + Avg Trade as primary metrics */}
                              <div className="grid grid-cols-2 gap-2 mt-2.5 pt-2.5 border-t border-slate-800/50">
                                <div>
                                  <p className="text-xs text-slate-500 uppercase tracking-wide">
                                    {traderSortBy === 'whale_volume' ? 'Volume (30d)' : 'Volume (7d)'}
                                  </p>
                                  <p className="font-bold text-slate-100 font-mono text-base">
                                    {formatCurrency(trader.total_volume)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-slate-500 uppercase tracking-wide">
                                    {traderSortBy === 'whale_volume' ? 'Avg Trade' : 'Avg Bet'}
                                  </p>
                                  <p className="font-bold text-slate-100 font-mono text-base">
                                    {trader.avg_bet_size ? formatCurrency(trader.avg_bet_size) : formatCurrency(trader.total_volume / (trader.total_bets || 1))}
                                  </p>
                                </div>
                              </div>
                              {trader.unique_markets !== undefined && (
                                <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-slate-800/50">
                                  <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Markets</p>
                                    <p className="font-bold text-slate-100 font-mono text-sm">{trader.unique_markets}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Trades</p>
                                    <p className="font-bold text-slate-100 font-mono text-sm">{trader.total_bets}</p>
                                  </div>
                                </div>
                              )}
                              {openExposure != null && (
                                <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-slate-800/50">
                                  <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Open Exposure</p>
                                    <p className="font-bold text-slate-100 font-mono text-sm">
                                      {formatCurrency(openExposure)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Open Mkts</p>
                                    <p className="font-bold text-slate-100 font-mono text-sm">{openMarkets || 0}</p>
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
                  {traderSortBy === 'copyable' && copyableTraders.length > 0 ? (
                    <>
                      <p>Ranked by ROI potential (excludes extreme-price trades).</p>
                      <p className="mt-1">Realized P/L and ROI are resolved BUYs only (v1 approximation).</p>
                      <p className="mt-1">Click a trader to track in the right panel.</p>
                    </>
                  ) : profitabilityTraders.length > 0 ? (
                    <>
                      <p>Showing {profitabilityTraders.length} traders with resolved markets.</p>
                      <p className="mt-1">Click a trader to view activity and record.</p>
                      <p className="mt-2 text-amber-400/70">💡 Win rate shows 0% if markets lack winning_outcome data. Run sync to update.</p>
                      <p className="mt-1 text-amber-400/70">Profitability = realized P/L + settlement P/L.</p>
                    </>
                  ) : (
                    <>
                      <p>Showing most active traders from the last 7 days.</p>
                      <p className="mt-1">Click a trader to view activity and record.</p>
                      <p className="mt-2 text-amber-400/70">💡 Profitability data will appear as markets resolve.</p>
                    </>
                  )}
                </div>
              </div>

              {/* Selected Trader Panel - replaces Top Traders when active */}
              {selectedFeedTrader && (
                <div
                  className={`rounded-lg border sticky top-6 flex flex-col overflow-hidden ${isRetro ? '' : 'bg-slate-900 border-slate-800'}`}
                  style={{
                    height: 'calc(100vh - 3rem)',
                    maxHeight: '1200px',
                    animation: 'fadeSlideIn 200ms ease-out',
                    ...(isRetro ? { backgroundColor: retroColors.surface, border: `1px solid ${retroColors.border}`, marginTop: '0.5rem' } : {}),
                  }}
                >
                  {/* Panel Header: Back + Tracking label */}
                  <div
                    className={`px-4 py-3 border-b shrink-0 ${isRetro ? '' : 'border-slate-800'}`}
                    style={isRetro ? { borderBottom: `1px solid ${retroColors.border}` } : {}}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <button
                        onClick={() => {
                          setSelectedFeedTrader(null);
                          setOnlySelectedWallet(false);
                          setSelectedTraderTrades([]);
                          setSelectedTraderRecord(null);
                        }}
                        className={`flex items-center gap-1 text-xs transition-colors ${
                          isRetro ? '' : 'text-slate-400 hover:text-slate-200'
                        }`}
                        style={isRetro ? { color: retroColors.textDim } : {}}
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        {isRetro ? 'BACK TO RANKINGS' : 'Back to Rankings'}
                      </button>
                      <button
                        onClick={() => {
                          setSelectedFeedTrader(null);
                          setOnlySelectedWallet(false);
                          setSelectedTraderTrades([]);
                          setSelectedTraderRecord(null);
                        }}
                        className={`text-xs px-2 py-1 rounded transition-colors ${
                          isRetro ? '' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                        }`}
                        style={isRetro ? { color: retroColors.textMuted } : {}}
                      >
                        ✕
                      </button>
                    </div>
                    <p
                      className="text-[10px] uppercase tracking-widest mb-2"
                      style={isRetro ? { color: retroColors.textMuted, fontSize: '0.75rem' } : { color: 'rgb(100, 116, 139)' }}
                    >
                      {isRetro ? 'TRACKING' : 'Tracking'}
                    </p>
                    <p
                      className="font-mono text-sm truncate"
                      style={isRetro ? { color: retroColors.textBright, fontSize: '1rem' } : { color: 'rgb(226, 232, 240)' }}
                    >
                      {selectedFeedTrader.slice(0, 10)}…{selectedFeedTrader.slice(-6)}
                    </p>
                  </div>

                  {/* Stats Grid */}
                  {selectedTraderInfo && (selectedTraderInfo.rank || selectedTraderInfo.total_pl) && (
                    <div
                      className={`px-4 py-3 border-b shrink-0 ${isRetro ? '' : 'border-slate-800'}`}
                      style={isRetro ? { borderBottom: `1px solid ${retroColors.border}` } : {}}
                    >
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                        {selectedTraderInfo.rank && (
                          <div>
                            <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.7rem' } : { color: 'rgb(100, 116, 139)' }}>
                              Rank
                            </p>
                            <p className="text-sm font-bold font-mono flex items-center gap-1" style={isRetro ? { color: retroColors.numbers, fontSize: '1rem' } : {}}>
                              #{selectedTraderInfo.rank}
                              {selectedTraderInfo.rank_24h_ago != null && (() => {
                                const delta = selectedTraderInfo.rank_24h_ago - selectedTraderInfo.rank;
                                if (delta > 0) return <span className="text-[10px]" style={isRetro ? { color: retroColors.win } : { color: 'rgb(52, 211, 153)' }}>▲{delta}</span>;
                                if (delta < 0) return <span className="text-[10px]" style={isRetro ? { color: retroColors.loss } : { color: 'rgb(251, 113, 133)' }}>▼{Math.abs(delta)}</span>;
                                return <span className="text-[10px]" style={{ color: 'rgb(100, 116, 139)' }}>—</span>;
                              })()}
                            </p>
                          </div>
                        )}
                        <div>
                          <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.7rem' } : { color: 'rgb(100, 116, 139)' }}>
                            Record
                          </p>
                          <p className="text-sm font-bold font-mono" style={isRetro ? { fontSize: '1rem' } : {}}>
                            <span style={isRetro ? { color: retroColors.win } : { color: 'rgb(52, 211, 153)' }}>{selectedTraderInfo.wins}</span>
                            <span style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>W–</span>
                            <span style={isRetro ? { color: retroColors.loss } : { color: 'rgb(251, 113, 133)' }}>{selectedTraderInfo.losses}</span>
                            <span style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>L</span>
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.7rem' } : { color: 'rgb(100, 116, 139)' }}>
                            {selectedTraderInfo.source === 'copyable' ? 'P/L (30D)' : 'Total P/L'}
                          </p>
                          <p
                            className="text-sm font-bold font-mono"
                            style={isRetro
                              ? { color: selectedTraderInfo.total_pl >= 0 ? retroColors.numbers : retroColors.loss, fontSize: '1rem' }
                              : { color: selectedTraderInfo.total_pl >= 0 ? 'rgb(52, 211, 153)' : 'rgb(251, 113, 133)' }
                            }
                          >
                            {selectedTraderInfo.total_pl >= 0 ? '+' : ''}{formatCurrency(selectedTraderInfo.total_pl)}
                          </p>
                        </div>
                        {selectedTraderInfo.roiPct != null && (
                          <div>
                            <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.7rem' } : { color: 'rgb(100, 116, 139)' }}>
                              ROI
                            </p>
                            <p
                              className="text-sm font-bold font-mono"
                              style={isRetro
                                ? { color: selectedTraderInfo.roiPct >= 0 ? retroColors.numbers : retroColors.loss, fontSize: '1rem' }
                                : { color: selectedTraderInfo.roiPct >= 0 ? 'rgb(52, 211, 153)' : 'rgb(251, 113, 133)' }
                              }
                            >
                              {selectedTraderInfo.roiPct >= 0 ? '+' : ''}{selectedTraderInfo.roiPct.toFixed(1)}%
                            </p>
                          </div>
                        )}
                        {selectedTraderInfo.median_trade_notional && (
                          <div className="col-span-2">
                            <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.7rem' } : { color: 'rgb(100, 116, 139)' }}>
                              Median Bet
                            </p>
                            <p className="text-sm font-mono" style={isRetro ? { color: retroColors.text, fontSize: '0.95rem' } : { color: 'rgb(226, 232, 240)' }}>
                              {formatCurrency(selectedTraderInfo.median_trade_notional)}
                            </p>
                          </div>
                        )}
                        {/* Anomaly signals for this trader */}
                        {(() => {
                          const traderTrades = selectedTraderTrades.length > 0 ? selectedTraderTrades : (recentTrades.length > 0 ? recentTrades : largeBets).filter(t => t.trader_address === selectedFeedTrader);
                          const allLabels = new Set();
                          for (const trade of traderTrades.slice(0, 50)) {
                            for (const label of classifyAnomaly(trade)) {
                              allLabels.add(label);
                            }
                          }
                          if (allLabels.size === 0) return null;
                          return (
                            <div className="col-span-2">
                              <p className="text-[10px] uppercase tracking-wide mb-1" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.7rem' } : { color: 'rgb(100, 116, 139)' }}>
                                {isRetro ? 'SIGNALS' : 'Signals'}
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {[...allLabels].map(label => {
                                  const style = anomalyBadgeStyles[label];
                                  const retroStyle = anomalyRetroColors[label];
                                  if (!style) return null;
                                  return (
                                    <span
                                      key={label}
                                      className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide ${isRetro ? '' : style.modern}`}
                                      style={isRetro ? {
                                        border: `1px solid ${retroStyle?.border || 'rgba(140, 120, 180, 0.3)'}`,
                                        color: retroStyle?.color || 'rgba(140, 120, 180, 0.9)',
                                        fontSize: '0.7rem',
                                      } : {}}
                                    >
                                      {style.label}
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Tab pills */}
                  <div
                    className={`flex gap-1 px-4 py-2 border-b shrink-0 ${isRetro ? '' : 'border-slate-800'}`}
                    style={isRetro ? { borderBottom: `1px solid ${retroColors.border}` } : {}}
                  >
                    {[
                      { key: 'activity', label: isRetro ? 'ACTIVITY' : 'Activity' },
                      { key: 'record', label: isRetro ? 'RECORD' : 'Record' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setSelectedTraderTab(key)}
                        className={`px-3 py-1.5 rounded text-xs transition-colors ${
                          isRetro ? '' : (
                            selectedTraderTab === key
                              ? 'bg-cyan-600 text-white'
                              : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                          )
                        }`}
                        style={isRetro ? {
                          backgroundColor: selectedTraderTab === key ? retroColors.text : retroColors.bg,
                          color: selectedTraderTab === key ? retroColors.bg : retroColors.textDim,
                          border: `1px solid ${selectedTraderTab === key ? retroColors.text : retroColors.borderEtched}`,
                          fontSize: '0.9rem',
                        } : {}}
                      >
                        {label}
                      </button>
                    ))}
                    {/* View Full Profile button */}
                    {selectedTraderInfo && (
                      <button
                        onClick={() => {
                          const trader = visibleTraders.find(t => t.address === selectedFeedTrader)
                            || { address: selectedFeedTrader, ...selectedTraderInfo };
                          setSelectedTrader(trader);
                          fetchTraderTrades(selectedFeedTrader, 100);
                        }}
                        className={`ml-auto px-2 py-1 rounded text-[10px] transition-colors ${
                          isRetro ? '' : 'border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                        }`}
                        style={isRetro ? {
                          border: `1px solid ${retroColors.borderEtched}`,
                          color: retroColors.textDim,
                          fontSize: '0.75rem',
                        } : {}}
                      >
                        {isRetro ? 'PROFILE' : 'Profile'}
                      </button>
                    )}
                  </div>

                  {/* Panel Body - scrollable */}
                  <div className="flex-1 overflow-y-auto px-4 py-3">
                    {loadingSelectedTrader ? (
                      <div className="text-center py-12">
                        <div
                          className="animate-spin rounded-full h-7 w-7 border-b-2 mx-auto"
                          style={isRetro ? { borderColor: retroColors.textBright } : { borderColor: 'rgb(8, 145, 178)' }}
                        />
                        <p className="mt-3 text-xs" style={isRetro ? { color: retroColors.textDim } : {}}>
                          {isRetro ? '> LOADING...' : 'Loading…'}
                        </p>
                      </div>
                    ) : selectedTraderTab === 'activity' ? (
                      /* Activity Tab */
                      <div className="space-y-2">
                        {selectedTraderTrades.length === 0 ? (
                          <p className="text-sm text-center py-8" style={isRetro ? { color: retroColors.textDim } : {}}>
                            {isRetro ? '> NO TRADES FOUND' : 'No trades found.'}
                          </p>
                        ) : (
                          selectedTraderTrades.map((trade, idx) => {
                            const tradeSideInfo = getSideLabel(trade.side);
                            const isResolved = trade.market_resolved;
                            const isWin = isResolved && trade.winning_outcome === trade.outcome;
                            const isLoss = isResolved && trade.winning_outcome && trade.winning_outcome !== trade.outcome;

                            return (
                              <div
                                key={idx}
                                className={isRetro ? '' : `rounded-md border p-2.5 ${
                                  isWin ? 'border-emerald-500/25 bg-emerald-500/5'
                                    : isLoss ? 'border-rose-500/25 bg-rose-500/5'
                                    : 'bg-slate-950 border-slate-800'
                                }`}
                                style={isRetro ? {
                                  backgroundColor: retroColors.surfaceDark,
                                  border: `1px solid ${retroColors.border}`,
                                  borderLeft: `3px solid ${isWin ? retroColors.win : isLoss ? retroColors.loss : retroColors.warn}`,
                                  padding: '0.6rem 0.75rem',
                                } : {}}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <a
                                      href={trade.market_slug ? `https://polymarket.com/market/${trade.market_slug}` : undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                      className={isRetro ? 'block' : 'text-xs font-medium text-slate-200 hover:underline block truncate'}
                                      style={isRetro ? { color: retroColors.textPrimary, fontSize: '0.9rem', fontWeight: 500 } : {}}
                                    >
                                      {formatGameTitle(trade.market_title, trade.market_slug) || trade.market_id}
                                    </a>
                                    <div className="flex items-center gap-2 mt-1">
                                      <span className="text-[10px]" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.8rem' } : { color: 'rgb(100, 116, 139)' }}>
                                        {formatTimestamp(trade.timestamp)}
                                      </span>
                                      <span
                                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${isRetro ? '' : tradeSideInfo.color}`}
                                        style={isRetro ? {
                                          border: `1px solid ${retroColors.borderEtched}`,
                                          color: retroColors.textDim,
                                          fontSize: '0.65rem',
                                        } : {}}
                                      >
                                        {tradeSideInfo.label}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <p className="text-xs font-bold font-mono" style={isRetro ? { color: retroColors.numbers, fontSize: '0.9rem' } : {}}>
                                      {formatCurrency(trade.amount)}
                                    </p>
                                    <p className="text-[10px] font-mono mt-0.5" style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                                      {Number(trade.price) ? `${(Number(trade.price) * 100).toFixed(0)}¢` : '—'}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center text-[10px] mt-1.5" style={isRetro ? { fontSize: '0.8rem' } : {}}>
                                  <span style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                                    {formatBetPosition(trade.market_title, trade.outcome)}
                                  </span>
                                  {isWin && <span className="ml-1.5 font-bold" style={isRetro ? { color: retroColors.win } : { color: 'rgb(52, 211, 153)' }}>✓ WIN</span>}
                                  {isLoss && <span className="ml-1.5 font-bold" style={isRetro ? { color: retroColors.loss } : { color: 'rgb(251, 113, 133)' }}>✗ LOSS</span>}
                                  {!isResolved && <span className="ml-1.5" style={isRetro ? { color: retroColors.warn } : { color: 'rgb(251, 191, 36)' }}>(Pending)</span>}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    ) : (
                      /* Record Tab */
                      <div>
                        {selectedTraderRecord ? (
                          <>
                            {/* Summary stats */}
                            <div className="grid grid-cols-3 gap-2 mb-3">
                              <div
                                className={`rounded-md p-2 text-center ${isRetro ? '' : 'bg-slate-950 border border-slate-800'}`}
                                style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}` } : {}}
                              >
                                <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textDim, fontSize: '0.65rem' } : { color: 'rgb(100, 116, 139)' }}>Wins</p>
                                <p className="text-lg font-bold" style={isRetro ? { color: retroColors.win, fontSize: '1.3rem' } : { color: 'rgb(52, 211, 153)' }}>
                                  {selectedTraderRecord.wins}
                                </p>
                              </div>
                              <div
                                className={`rounded-md p-2 text-center ${isRetro ? '' : 'bg-slate-950 border border-slate-800'}`}
                                style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}` } : {}}
                              >
                                <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textDim, fontSize: '0.65rem' } : { color: 'rgb(100, 116, 139)' }}>Losses</p>
                                <p className="text-lg font-bold" style={isRetro ? { color: retroColors.loss, fontSize: '1.3rem' } : { color: 'rgb(251, 113, 133)' }}>
                                  {selectedTraderRecord.losses}
                                </p>
                              </div>
                              <div
                                className={`rounded-md p-2 text-center ${isRetro ? '' : 'bg-slate-950 border border-slate-800'}`}
                                style={isRetro ? { backgroundColor: retroColors.bg, border: `1px solid ${retroColors.border}` } : {}}
                              >
                                <p className="text-[10px] uppercase tracking-wide" style={isRetro ? { color: retroColors.textDim, fontSize: '0.65rem' } : { color: 'rgb(100, 116, 139)' }}>Pending</p>
                                <p className="text-lg font-bold" style={isRetro ? { color: retroColors.warn, fontSize: '1.3rem' } : { color: 'rgb(251, 191, 36)' }}>
                                  {selectedTraderRecord.pending}
                                </p>
                              </div>
                            </div>

                            {/* Win rate bar */}
                            {(selectedTraderRecord.wins + selectedTraderRecord.losses) > 0 && (
                              <div className="mb-3">
                                <div className="flex items-center justify-between text-[10px] mb-1">
                                  <span style={isRetro ? { color: retroColors.textDim, fontSize: '0.8rem' } : { color: 'rgb(100, 116, 139)' }}>
                                    {isRetro ? 'WIN RATE' : 'Win Rate'}
                                  </span>
                                  <span className="font-bold" style={isRetro ? { color: retroColors.numbers, fontSize: '0.85rem' } : { color: 'rgb(226, 232, 240)' }}>
                                    {((selectedTraderRecord.wins / (selectedTraderRecord.wins + selectedTraderRecord.losses)) * 100).toFixed(1)}%
                                  </span>
                                </div>
                                <div
                                  className={`h-1.5 rounded-full overflow-hidden ${isRetro ? '' : 'bg-slate-800'}`}
                                  style={isRetro ? { backgroundColor: retroColors.bg, height: '5px' } : {}}
                                >
                                  <div
                                    className="h-full rounded-full transition-all"
                                    style={{
                                      width: `${(selectedTraderRecord.wins / (selectedTraderRecord.wins + selectedTraderRecord.losses)) * 100}%`,
                                      backgroundColor: isRetro ? retroColors.win : 'rgb(52, 211, 153)',
                                    }}
                                  />
                                </div>
                              </div>
                            )}

                            {/* Resolved trades list */}
                            {selectedTraderRecord.resolvedTrades.length > 0 ? (
                              <div className="space-y-1.5">
                                <p className="text-[10px] uppercase tracking-wide mb-1" style={isRetro ? { color: retroColors.textDim, fontSize: '0.75rem', letterSpacing: '0.1em' } : { color: 'rgb(100, 116, 139)' }}>
                                  {isRetro ? 'RESOLVED OUTCOMES' : 'Resolved Outcomes'}
                                </p>
                                {selectedTraderRecord.resolvedTrades.map((trade, idx) => (
                                  <div
                                    key={idx}
                                    className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
                                      isRetro ? '' : (trade.isWin ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5')
                                    }`}
                                    style={isRetro ? {
                                      backgroundColor: retroColors.surfaceDark,
                                      border: `1px solid ${retroColors.border}`,
                                      borderLeft: `3px solid ${trade.isWin ? retroColors.win : retroColors.loss}`,
                                      padding: '0.4rem 0.6rem',
                                    } : {}}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <a
                                        href={trade.market_slug ? `https://polymarket.com/market/${trade.market_slug}` : undefined}
                                        target="_blank"
                                        rel="noreferrer"
                                        className={`text-xs truncate block hover:underline ${isRetro ? '' : 'text-slate-300'}`}
                                        style={isRetro ? { color: retroColors.text, fontSize: '0.85rem' } : {}}
                                      >
                                        {formatGameTitle(trade.market_title, trade.market_slug) || 'Unknown'}
                                      </a>
                                      <span className="text-[10px]" style={isRetro ? { color: retroColors.textMuted, fontSize: '0.75rem' } : { color: 'rgb(100, 116, 139)' }}>
                                        {formatBetPosition(trade.market_title, trade.outcome)} · {formatCurrency(trade.amount)}
                                      </span>
                                    </div>
                                    <span
                                      className="text-[10px] font-bold shrink-0"
                                      style={isRetro
                                        ? { color: trade.isWin ? retroColors.win : retroColors.loss, fontSize: '0.8rem' }
                                        : { color: trade.isWin ? 'rgb(52, 211, 153)' : 'rgb(251, 113, 133)' }
                                      }
                                    >
                                      {trade.isWin ? '✓ WIN' : '✗ LOSS'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-center py-6" style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                                {isRetro ? '> NO RESOLVED TRADES YET' : 'No resolved trades in recent history.'}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-center py-8" style={isRetro ? { color: retroColors.textDim } : { color: 'rgb(100, 116, 139)' }}>
                            {isRetro ? '> NO RECORD DATA' : 'No record data available.'}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
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
                    setTraderTradesLimit(100);
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
                  style={isRetro ? { color: retroColors.header, fontSize: '1.1rem', marginBottom: '1rem', letterSpacing: '0.05em' } : {}}
                >
                  <Activity className="w-4 h-4" style={isRetro ? { color: retroColors.textDim } : {}} />
                  RECENT TRADES
                  <span style={isRetro ? { color: retroColors.textMuted, fontSize: '0.8rem', fontWeight: 400 } : {}}>
                    (last {traderTradesLimit})
                  </span>
                </h4>

                {(() => {
                  const exposure = selectedTrader?.address
                    ? openExposureMap[String(selectedTrader.address).toLowerCase()]
                    : null;
                  const openMarkets = Number(exposure?.open_markets || 0);
                  const pendingInLoaded = Array.isArray(traderTrades)
                    ? traderTrades.filter((t) => !t.market_resolved).length
                    : 0;

                  if (!openMarkets || loadingTrades) return null;
                  if (pendingInLoaded > 0) return null;

                  return (
                    <div
                      className={isRetro ? '' : 'mb-3 text-xs text-amber-400/80'}
                      style={isRetro ? { color: retroColors.warn, fontSize: '0.9rem', marginBottom: '0.75rem' } : {}}
                    >
                      Trader has {openMarkets} open market(s) (>= $1k) but none appear in the last {traderTradesLimit} trades.
                      {' '}
                      <button
                        onClick={() => fetchTraderTrades(selectedTrader.address, 500)}
                        className={isRetro ? '' : 'underline hover:text-amber-300'}
                        style={isRetro ? { color: retroColors.textBright, textDecoration: 'underline' } : {}}
                      >
                        Load last 500
                      </button>
                      .
                    </div>
                  );
                })()}

                {traderTradesDiag ? (
                  <div
                    className={isRetro ? '' : 'mb-3 text-xs text-amber-400/80'}
                    style={isRetro ? { color: retroColors.warn, fontSize: '0.9rem', marginBottom: '0.75rem' } : {}}
                  >
                    Resolution lookup returned {traderTradesDiag.marketsReturned}/{traderTradesDiag.marketsRequested} markets
                    {Array.isArray(traderTradesDiag.marketFetchErrors) && traderTradesDiag.marketFetchErrors.length > 0
                      ? ` (${traderTradesDiag.marketFetchErrors.length} request error(s))`
                      : ''}.
                    {' '}Some trades may show (Pending) even if resolved upstream.
                  </div>
                ) : null}

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
                        backgroundColor: retroColors.surfaceDark,
                        border: `1px solid ${retroColors.border}`,
                        borderLeft: `3px solid ${isWin ? retroColors.win : isLoss ? retroColors.loss : retroColors.warn}`,
                        borderRadius: '2px',
                        padding: '1rem 1.25rem',
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
                              style={isRetro ? { color: retroColors.textPrimary, fontSize: '1.05rem', fontWeight: 500, lineHeight: 1.35 } : {}}
                            >
                              {formatGameTitle(trade.market_title, trade.market_slug) || trade.market_id}
                            </a>
                            <p
                              className={isRetro ? '' : 'text-xs text-slate-500 mt-1'}
                              style={isRetro ? { color: retroColors.textMuted, fontSize: '0.85rem', marginTop: '0.4rem' } : {}}
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
                                fontSize: '0.7rem',
                                letterSpacing: '0.05em',
                                border: `1px solid ${retroColors.borderEtched}`,
                                color: retroColors.textDim,
                              } : {}}
                            >
                              {tradeSideInfo.label}
                            </span>
                          </div>
                        </div>
                        <div
                          className={isRetro ? 'flex items-center justify-between' : 'flex items-center justify-between text-xs'}
                          style={isRetro ? { fontSize: '0.9rem', marginTop: '0.75rem' } : {}}
                        >
                          <span style={isRetro ? { color: retroColors.textDim } : {}} className={isRetro ? '' : 'text-slate-500'}>
                            Bet: <span style={isRetro ? { color: isWin ? retroColors.numbers : isLoss ? retroColors.loss : retroColors.text, fontWeight: isWin ? 600 : 400 } : {}} className={isRetro ? '' : (isWin ? 'text-emerald-400' : isLoss ? 'text-rose-400' : 'text-slate-400')}>{formatBetPosition(trade.market_title, trade.outcome)}</span>
                            {isWin && <span style={isRetro ? { color: retroColors.numbers, marginLeft: '0.5rem', fontWeight: 600 } : {}} className={isRetro ? '' : 'ml-2 text-emerald-400 font-semibold'}>✓ WIN</span>}
                            {isLoss && <span style={isRetro ? { color: retroColors.loss, marginLeft: '0.5rem', fontWeight: 500 } : {}} className={isRetro ? '' : 'ml-2 text-rose-400 font-semibold'}>✗ LOSS</span>}
                            {!isResolved && <span style={isRetro ? { color: retroColors.warn, marginLeft: '0.5rem' } : {}} className={isRetro ? '' : 'ml-2 text-amber-500'}>(Pending)</span>}
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
                  setTraderTradesLimit(100);
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
