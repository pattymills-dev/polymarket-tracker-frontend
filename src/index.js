import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './retro.css';
import App from './App';
import RetroApp from './RetroApp';
import reportWebVitals from './reportWebVitals';

const AppSwitcher = () => {
  const [retroMode, setRetroMode] = useState(
    localStorage.getItem('retroMode') === 'true'
  );

  const toggleMode = () => {
    const newMode = !retroMode;
    setRetroMode(newMode);
    localStorage.setItem('retroMode', newMode.toString());
  };

  return (
    <>
      {/* Mode Toggle Button */}
      <button
        onClick={toggleMode}
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 9999,
          padding: '8px 16px',
          background: retroMode ? '#00ff41' : '#1e293b',
          color: retroMode ? '#0a0a0a' : '#00ff41',
          border: retroMode ? '2px solid #0a0a0a' : '2px solid #00ff41',
          borderRadius: '4px',
          cursor: 'pointer',
          fontFamily: retroMode ? 'VT323, monospace' : 'system-ui',
          fontSize: retroMode ? '20px' : '14px',
          fontWeight: 'bold',
          boxShadow: retroMode ? '0 0 10px rgba(0, 255, 65, 0.5)' : 'none',
        }}
      >
        {retroMode ? '▓ MODERN MODE' : '⚡ RETRO MODE'}
      </button>

      {/* Render appropriate app */}
      {retroMode ? <RetroApp /> : <App />}
    </>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <AppSwitcher />
  </React.StrictMode>
);

reportWebVitals();