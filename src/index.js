import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './retro.css';
import App from './App';
import SonarInterstitial from './SonarInterstitial';
import { ThemeProvider, useTheme } from './ThemeContext';
import reportWebVitals from './reportWebVitals';

// Main app wrapper with theme-aware rendering
const ThemedApp = () => {
  const { isRetro } = useTheme();
  const [showInterstitial, setShowInterstitial] = useState(false);
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    if (isRetro) {
      // Always show interstitial on load for Below Deck mode
      setShowInterstitial(true);
      // Mount the app behind the interstitial so the transition feels continuous.
      setAppReady(true);
    } else {
      // Bridge View mode - show app directly
      setShowInterstitial(false);
      setAppReady(true);
    }
  }, [isRetro]);

  const handleInterstitialComplete = () => {
    setShowInterstitial(false);
    setAppReady(true);
  };

  // Below Deck mode: render the app behind the interstitial so the fade-out reveals it.
  if (isRetro) {
    return (
      <>
        <App />
        {showInterstitial ? (
          <SonarInterstitial onComplete={handleInterstitialComplete} />
        ) : null}
      </>
    );
  }

  // Bridge View mode - show main app
  if (appReady) return <App />;

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
