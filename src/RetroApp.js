import React, { useEffect, useMemo, useState, useCallback } from 'react';

const RetroApp = () => {
  const [largeBets, setLargeBets] = useState([]);
  const [profitabilityTraders, setProfitabilityTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bootComplete, setBootComplete] = useState(false);
  const [bootMessages, setBootMessages] = useState([]);

  // Supabase Configuration
  const SUPABASE_URL =
    process.env.REACT_APP_SUPABASE_URL || 'https://smuktlgclwvaxnduuinm.supabase.co';
  const SUPABASE_PUBLIC_KEY =
    process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY ||
    process.env.REACT_APP_SUPABASE_ANON_KEY ||
    '';

  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${SUPABASE_PUBLIC_KEY}`,
      apikey: SUPABASE_PUBLIC_KEY,
      'Content-Type': 'application/json'
    }),
    [SUPABASE_PUBLIC_KEY]
  );

  useEffect(() => {
    if (!SUPABASE_PUBLIC_KEY) {
      console.error(
        'Missing Supabase public key. Set REACT_APP_SUPABASE_PUBLISHABLE_KEY (preferred) or REACT_APP_SUPABASE_ANON_KEY.'
      );
    }
  }, [SUPABASE_PUBLIC_KEY]);

  // Boot sequence
  useEffect(() => {
    const messages = [
      'POLYMARKET TERMINAL v1.0',
      'INITIALIZING MARKET SCANNER...',
      'LOADING WHALE DETECTOR...',
      'CALIBRATING PREDICTION MODELS...',
      'ESTABLISHING DATABASE LINK...',
      'SYSTEM READY',
      ''
    ];

    let index = 0;
    const interval = setInterval(() => {
      if (index < messages.length) {
        setBootMessages(prev => [...prev, messages[index]]);
        index++;
      } else {
        clearInterval(interval);
        setTimeout(() => setBootComplete(true), 500);
      }
    }, 200);

    return () => clearInterval(interval);
  }, []);

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/trades?select=*&order=timestamp.desc&limit=50`,
        { headers }
      );
      const data = await response.json();
      setLargeBets(data || []);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching trades:', error);
      setLoading(false);
    }
  }, [headers]);

  const fetchProfitability = useCallback(async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/calculate_trader_performance`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ min_resolved_markets: 1 })
        }
      );
      const data = await response.json();

      if (response.ok && Array.isArray(data)) {
        const mappedTraders = data.map(t => ({
          address: t.trader_address,
          wins: t.wins,
          losses: t.losses,
          win_rate: Number(t.win_rate || 0),
          profitability_rate: Number(t.profitability_rate || 0),
          total_pl: Number(t.total_pl || 0),
          resolved_markets: t.resolved_markets
        }));
        setProfitabilityTraders(mappedTraders);
      }
    } catch (error) {
      console.error('Error fetching profitability:', error);
    }
  }, [headers]);

  useEffect(() => {
    if (bootComplete) {
      fetchData();
      fetchProfitability();

      const interval = setInterval(() => {
        fetchData();
        fetchProfitability();
      }, 60000);

      return () => clearInterval(interval);
    }
  }, [bootComplete, fetchData, fetchProfitability]);

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatTimestamp = (ts) => {
    if (!ts) return 'UNKNOWN';
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  // Show boot sequence
  if (!bootComplete) {
    return (
      <div className="crt-screen min-h-screen p-8">
        <div className="terminal-text">
          <pre className="ascii-art">
{`╔══════════════════════════════════════════╗
║  POLYMARKET WHALE TRACKER SYSTEM v1.0   ║
║            [TERMINAL MODE]               ║
╚══════════════════════════════════════════╝`}
          </pre>
          <div className="mt-8">
            {bootMessages.map((msg, i) => (
              <div key={i} className="boot-line">
                <span className="terminal-glow">&gt; {msg}</span>
              </div>
            ))}
            {bootMessages.length > 0 && bootMessages[bootMessages.length - 1] !== '' && (
              <span className="blink">█</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Filter whales (>= $50k)
  const whaleBets = largeBets.filter(bet => Number(bet.amount || 0) >= 50000);
  const topPerformers = profitabilityTraders.slice(0, 10);

  return (
    <div className="crt-screen min-h-screen p-6 terminal-text">
      {/* Header */}
      <div className="mb-6">
        <pre className="ascii-art text-center">
{`╔══════════════════════════════════════════════════════════════╗
║       POLYMARKET WHALE TRACKER - TERMINAL INTERFACE         ║
║                    [SYSTEM OPERATIONAL]                      ║
╚══════════════════════════════════════════════════════════════╝`}
        </pre>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Whale Feed - Takes 2 columns */}
        <div className="lg:col-span-2">
          <div className="terminal-border p-4 retro-scroll" style={{ maxHeight: '800px', overflowY: 'auto' }}>
            <div className="mb-4">
              <span className="terminal-glow text-2xl">▓▓ WHALE ACTIVITY MONITOR ▓▓</span>
              <div className="mt-2 text-sm">
                <span className="terminal-glow">&gt; SCANNING FOR TRADES &gt;= $50,000</span>
                <span className="blink ml-2">█</span>
              </div>
            </div>

            {loading ? (
              <div className="text-center py-20">
                <div className="text-4xl mb-4">⣾⣿⣿⣿⣿⣿</div>
                <div className="terminal-glow">LOADING DATA...</div>
              </div>
            ) : whaleBets.length === 0 ? (
              <div className="text-center py-20">
                <div className="terminal-glow">&gt; NO WHALE ACTIVITY DETECTED</div>
                <div className="mt-2">&gt; MONITORING...</div>
              </div>
            ) : (
              <div className="space-y-3">
                {whaleBets.slice(0, 20).map((bet, idx) => {
                  const amount = Number(bet.amount || 0);
                  const isMegaWhale = amount >= 100000;

                  return (
                    <div
                      key={bet.tx_hash || idx}
                      className={`p-3 border-2 ${isMegaWhale ? 'whale-alert border-yellow-500' : 'border-green-500'}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={isMegaWhale ? 'whale-alert text-xl' : 'terminal-glow'}>
                              {isMegaWhale ? '🐋 MEGA WHALE' : '▸ WHALE'}
                            </span>
                            <span className="text-sm opacity-70">
                              [{formatTimestamp(bet.timestamp)}]
                            </span>
                          </div>

                          <div className="mb-2">
                            <span className="opacity-70">TRADER:</span>{' '}
                            <span className="terminal-glow font-bold">
                              {bet.trader_address?.slice(0, 10)}...{bet.trader_address?.slice(-4)}
                            </span>
                          </div>

                          <div className="text-sm truncate mb-1">
                            <span className="opacity-70">MARKET:</span>{' '}
                            <span>{bet.market_title || 'Unknown Market'}</span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div>
                              <span className="opacity-70">OUTCOME:</span>{' '}
                              <span className="terminal-glow">{bet.outcome || '---'}</span>
                            </div>
                            <div>
                              <span className="opacity-70">SIDE:</span>{' '}
                              <span className={bet.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>
                                {bet.side || 'BUY'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="text-right flex-shrink-0">
                          <div className={`text-3xl font-bold ${isMegaWhale ? 'whale-alert' : 'terminal-glow'}`}>
                            {formatCurrency(amount)}
                          </div>
                          <div className="text-xs mt-1 opacity-70">
                            @ {(Number(bet.price || 0) * 100).toFixed(1)}¢
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Top Performers - 1 column */}
        <div className="lg:col-span-1">
          <div className="terminal-border p-4 retro-scroll sticky top-6" style={{ maxHeight: '800px', overflowY: 'auto' }}>
            <div className="mb-4">
              <span className="terminal-glow text-xl">▓▓ LEADERBOARD ▓▓</span>
              <div className="mt-2 text-sm">
                <span className="terminal-glow">&gt; TOP PERFORMERS</span>
                <span className="blink ml-2">█</span>
              </div>
            </div>

            {topPerformers.length === 0 ? (
              <div className="text-center py-10">
                <div className="terminal-glow">&gt; CALCULATING...</div>
              </div>
            ) : (
              <div className="space-y-3">
                {topPerformers.map((trader, idx) => {
                  const rank = idx + 1;
                  const rankSymbol = rank === 1 ? '█' : rank === 2 ? '▓' : rank === 3 ? '▒' : '░';

                  return (
                    <div key={trader.address} className="border-2 border-green-500 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-2xl ${rank <= 3 ? 'whale-alert' : 'terminal-glow'}`}>
                          {rankSymbol} #{rank}
                        </span>
                      </div>

                      <div className="text-sm mb-2">
                        <span className="opacity-70">ADDR:</span>{' '}
                        <span className="terminal-glow font-bold">
                          {trader.address?.slice(0, 8)}...{trader.address?.slice(-4)}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                        <div>
                          <div className="opacity-70">WIN RATE</div>
                          <div className={`text-lg font-bold ${
                            trader.win_rate > 0.5 ? 'terminal-glow' : 'text-red-400'
                          }`}>
                            {(trader.win_rate * 100).toFixed(0)}%
                          </div>
                        </div>
                        <div>
                          <div className="opacity-70">PROFIT</div>
                          <div className={`text-lg font-bold ${
                            trader.profitability_rate > 0.5 ? 'terminal-glow' : 'text-red-400'
                          }`}>
                            {(trader.profitability_rate * 100).toFixed(0)}%
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="opacity-70">RECORD:</span>{' '}
                          <span className="terminal-glow">
                            {trader.wins}W-{trader.losses}L
                          </span>
                        </div>
                        <div>
                          <span className="opacity-70">P/L:</span>{' '}
                          <span className={trader.total_pl >= 0 ? 'terminal-glow' : 'text-red-400'}>
                            {trader.total_pl >= 0 ? '+' : ''}{formatCurrency(trader.total_pl)}
                          </span>
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

      {/* Footer */}
      <div className="mt-6 text-center text-sm opacity-50">
        <span>&gt; SYSTEM OPERATIONAL</span>
        <span className="blink ml-2">█</span>
        <span className="ml-4">AUTO-REFRESH: ENABLED</span>
      </div>
    </div>
  );
};

export default RetroApp;
