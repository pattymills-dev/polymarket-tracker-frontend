import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './retro.css';
import App from './App';
import SonarInterstitial from './SonarInterstitial';
import { ThemeProvider, useTheme } from './ThemeContext';
import reportWebVitals from './reportWebVitals';

// Refined color palette
const colors = {
  bg: '#050806',
  primary: '#4a9b6b',
  bright: '#7CFF9B',
  dim: '#2d5a42',
};

// Boot sequence for Below Deck mode - Refined, minimal styling
const RetroBoot = ({ onComplete }) => {
  const [bootMessages, setBootMessages] = useState([]);
  const [bootComplete, setBootComplete] = useState(false);

  const messages = [
    'POLYMARKET TERMINAL v2.0',
    'INITIALIZING MARKET SCANNER...',
    'LOADING WHALE DETECTOR...',
    'CALIBRATING PREDICTION MODELS...',
    'ESTABLISHING DATABASE LINK...',
    'SYSTEM READY',
  ];

  useEffect(() => {
    // Check if boot already completed this session
    if (sessionStorage.getItem('retro-boot-complete')) {
      onComplete();
      return;
    }

    let index = 0;
    const interval = setInterval(() => {
      if (index < messages.length) {
        setBootMessages(prev => [...prev, messages[index]]);
        index++;
      } else {
        clearInterval(interval);
        setBootComplete(true);
      }
    }, 150);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onComplete]);

  useEffect(() => {
    if (bootComplete) {
      sessionStorage.setItem('retro-boot-complete', 'true');
      // Small delay before showing interstitial
      setTimeout(onComplete, 300);
    }
  }, [bootComplete, onComplete]);

  return (
    <div style={{
      background: colors.bg,
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: "'VT323', monospace",
    }}>
      {/* ASCII Header - No glow */}
      <pre style={{
        color: colors.primary,
        textShadow: 'none',
        fontSize: 'clamp(0.6rem, 1.5vw, 0.9rem)',
        lineHeight: 1.2,
        marginBottom: '2rem',
      }}>
{`╔══════════════════════════════════════════╗
║  POLYMARKET WHALE TRACKER SYSTEM v2.0   ║
║            [TERMINAL MODE]               ║
╚══════════════════════════════════════════╝`}
      </pre>

      {/* Boot Messages */}
      <div style={{ textAlign: 'left', minWidth: '300px' }}>
        {bootMessages.map((msg, i) => (
          <div key={i} style={{
            color: i === bootMessages.length - 1 && bootComplete ? colors.bright : colors.primary,
            fontSize: '1rem',
            marginBottom: '0.25rem',
            letterSpacing: '0.02em',
          }}>
            &gt; {msg}
          </div>
        ))}
        {bootMessages.length > 0 && bootMessages.length < messages.length && (
          <span style={{
            color: colors.primary,
            animation: 'retro-blink 1s step-end infinite',
          }}>█</span>
        )}
      </div>

      {/* Inline keyframes for cursor blink */}
      <style>{`
        @keyframes retro-blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
};

// Main app wrapper with theme-aware rendering
const ThemedApp = () => {
  const { isRetro } = useTheme();
  const [showBoot, setShowBoot] = useState(false);
  const [showInterstitial, setShowInterstitial] = useState(false);
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    if (isRetro) {
      // Check if we need boot sequence
      const bootDone = sessionStorage.getItem('retro-boot-complete');

      if (!bootDone) {
        setShowBoot(true);
        setAppReady(false);
      } else {
        // Always show interstitial after boot (on every hard refresh)
        setShowInterstitial(true);
        setAppReady(false);
      }
    } else {
      // Bridge View mode - show app directly
      setShowBoot(false);
      setShowInterstitial(false);
      setAppReady(true);
    }
  }, [isRetro]);

  const handleBootComplete = () => {
    setShowBoot(false);
    // Always show interstitial after boot
    setShowInterstitial(true);
  };

  const handleInterstitialComplete = () => {
    setShowInterstitial(false);
    setAppReady(true);
  };

  // Show boot sequence for Below Deck mode
  if (isRetro && showBoot) {
    return <RetroBoot onComplete={handleBootComplete} />;
  }

  // Show sonar interstitial after boot (Below Deck mode only)
  if (isRetro && showInterstitial) {
    return <SonarInterstitial onComplete={handleInterstitialComplete} />;
  }

  // Show main app
  if (appReady) {
    return <App />;
  }

  // Fallback loading
  return null;
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  </React.StrictMode>
);

reportWebVitals();
