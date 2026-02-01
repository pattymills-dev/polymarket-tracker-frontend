import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  // Initialize from localStorage, default to 'belowDeck' (retro/sonar theme)
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('polymarket-theme');
      // Migrate old values
      if (stored === 'retro') return 'belowDeck';
      if (stored === 'modern') return 'bridgeView';
      return stored || 'belowDeck';
    }
    return 'belowDeck';
  });

  // Persist theme choice
  useEffect(() => {
    localStorage.setItem('polymarket-theme', theme);

    // Add/remove theme class on document
    if (theme === 'belowDeck') {
      document.documentElement.classList.add('retro-theme');
    } else {
      document.documentElement.classList.remove('retro-theme');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'bridgeView' ? 'belowDeck' : 'bridgeView');
  };

  // Below Deck = retro/sonar theme, Bridge View = clean/modern
  const isBelowDeck = theme === 'belowDeck';
  const isRetro = isBelowDeck; // Alias for backward compatibility

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, isRetro, isBelowDeck }}>
      {children}
    </ThemeContext.Provider>
  );
};
