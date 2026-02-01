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
  // Initialize from localStorage, default to 'modern'
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('polymarket-theme') || 'modern';
    }
    return 'modern';
  });

  // Persist theme choice
  useEffect(() => {
    localStorage.setItem('polymarket-theme', theme);

    // Add/remove theme class on document
    if (theme === 'retro') {
      document.documentElement.classList.add('retro-theme');
    } else {
      document.documentElement.classList.remove('retro-theme');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'modern' ? 'retro' : 'modern');
  };

  const isRetro = theme === 'retro';

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, isRetro }}>
      {children}
    </ThemeContext.Provider>
  );
};
