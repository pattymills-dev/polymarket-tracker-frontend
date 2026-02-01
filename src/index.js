import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './retro.css';
import App from './App';
import WhiteWhaleInterstitial from './WhiteWhaleInterstitial';
import { ThemeProvider, useTheme } from './ThemeContext';
import reportWebVitals from './reportWebVitals';

// Boot sequence for retro mode
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
    }, 180);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onComplete]);

  useEffect(() => {
    if (bootComplete) {
      sessionStorage.setItem('retro-boot-complete', 'true');
      // Small delay before showing interstitial
      setTimeout(onComplete, 400);
    }
  }, [bootComplete, onComplete]);

  return (
    <div className="retro-boot-screen" style={{
      background: '#050806',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: "'VT323', monospace",
    }}>
      <pre style={{
        color: '#7CFF9B',
        textShadow: '0 0 10px rgba(124, 255, 155, 0.4)',
        fontSize: 'clamp(0.7rem, 2vw, 1rem)',
        lineHeight: 1.1,
        marginBottom: '2rem',
      }}>
{`╔══════════════════════════════════════════╗
║  POLYMARKET WHALE TRACKER SYSTEM v2.0   ║
║            [TERMINAL MODE]               ║
╚══════════════════════════════════════════╝`}
      </pre>
      <div style={{ textAlign: 'left', minWidth: '300px' }}>
        {bootMessages.map((msg, i) => (
          <div key={i} style={{
            color: '#7CFF9B',
            fontSize: '1.125rem',
            marginBottom: '0.25rem',
            opacity: 1,
          }}>
            &gt; {msg}
          </div>
        ))}
        {bootMessages.length > 0 && bootMessages.length < messages.length && (
          <span style={{ color: '#7CFF9B', animation: 'retro-blink 1s step-end infinite' }}>█</span>
        )}
      </div>
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
      const interstitialDone = sessionStorage.getItem('whale-interstitial-shown');

      if (!bootDone) {
        setShowBoot(true);
        setAppReady(false);
      } else if (!interstitialDone) {
        setShowInterstitial(true);
        setAppReady(false);
      } else {
        setAppReady(true);
      }
    } else {
      // Modern mode - show app directly
      setShowBoot(false);
      setShowInterstitial(false);
      setAppReady(true);
    }
  }, [isRetro]);

  const handleBootComplete = () => {
    setShowBoot(false);
    // Check if interstitial already shown
    const interstitialDone = sessionStorage.getItem('whale-interstitial-shown');
    if (!interstitialDone) {
      setShowInterstitial(true);
    } else {
      setAppReady(true);
    }
  };

  const handleInterstitialComplete = () => {
    setShowInterstitial(false);
    setAppReady(true);
  };

  // Show boot sequence for retro mode
  if (isRetro && showBoot) {
    return <RetroBoot onComplete={handleBootComplete} />;
  }

  // Show interstitial after boot (retro mode only)
  if (isRetro && showInterstitial) {
    return <WhiteWhaleInterstitial onComplete={handleInterstitialComplete} />;
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
