import React, { useState, useEffect, useCallback } from 'react';

/**
 * Sonar Interstitial
 * Full-screen intro with expanding sonar rings behind "follow the white whale" text.
 * Duration: ~2.0s total
 * - Sonar expansion: ~1.4s
 * - Fade-out: ~0.6s
 */
const SonarInterstitial = ({ onComplete }) => {
  const [isFading, setIsFading] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  // Check if user prefers reduced motion
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Skip handler
  const handleSkip = useCallback(() => {
    if (!isFading) {
      setIsFading(true);
      setTimeout(() => {
        setIsVisible(false);
        onComplete();
      }, 300);
    }
  }, [isFading, onComplete]);

  // Show on every load (hard refresh shows it again)
  useEffect(() => {
    if (prefersReducedMotion) {
      setIsVisible(false);
      onComplete();
      return;
    }

    // Add event listeners for skip
    const handleKeyPress = () => handleSkip();
    const handleClick = () => handleSkip();

    window.addEventListener('keydown', handleKeyPress);
    window.addEventListener('click', handleClick);

    // Auto-complete after animation
    const timer = setTimeout(() => {
      setIsFading(true);
      setTimeout(() => {
        setIsVisible(false);
        onComplete();
      }, 600);
    }, 2000);

    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      window.removeEventListener('click', handleClick);
      clearTimeout(timer);
    };
  }, [onComplete, prefersReducedMotion, handleSkip]);

  // Don't render if reduced motion or not visible
  if (!isVisible || prefersReducedMotion) {
    return null;
  }

  // Sonar colors - unified console palette
  const colors = {
    bg: '#060908',
    primary: '#5a8a6a',
    bright: '#6ddb8a',
    dim: '#3a5a48',
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        opacity: isFading ? 0 : 1,
        transition: 'opacity 0.6s ease-out',
        overflow: 'hidden',
      }}
    >
      {/* SVG Sonar Rings */}
      <svg
        style={{
          position: 'absolute',
          width: '200vmax',
          height: '200vmax',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid slice"
      >
        {/* Ring 1 - Main pulse */}
        <circle
          cx="50"
          cy="50"
          r="2"
          fill="none"
          stroke={colors.bright}
          strokeWidth="0.15"
          style={{
            animation: 'sonar-pulse-1 1.4s ease-out forwards',
            transformOrigin: '50% 50%',
          }}
        />
        {/* Ring 2 - Staggered */}
        <circle
          cx="50"
          cy="50"
          r="2"
          fill="none"
          stroke={colors.primary}
          strokeWidth="0.1"
          style={{
            animation: 'sonar-pulse-2 1.4s ease-out 0.15s forwards',
            transformOrigin: '50% 50%',
            opacity: 0,
          }}
        />
        {/* Ring 3 - Staggered */}
        <circle
          cx="50"
          cy="50"
          r="2"
          fill="none"
          stroke={colors.dim}
          strokeWidth="0.08"
          style={{
            animation: 'sonar-pulse-3 1.4s ease-out 0.3s forwards',
            transformOrigin: '50% 50%',
            opacity: 0,
          }}
        />
      </svg>

      {/* CSS Keyframes */}
      <style>{`
        @keyframes sonar-pulse-1 {
          0% {
            r: 2;
            opacity: 0.9;
            stroke-width: 0.3;
          }
          100% {
            r: 45;
            opacity: 0;
            stroke-width: 0.05;
          }
        }
        @keyframes sonar-pulse-2 {
          0% {
            r: 2;
            opacity: 0.7;
            stroke-width: 0.2;
          }
          100% {
            r: 40;
            opacity: 0;
            stroke-width: 0.03;
          }
        }
        @keyframes sonar-pulse-3 {
          0% {
            r: 2;
            opacity: 0.5;
            stroke-width: 0.15;
          }
          100% {
            r: 35;
            opacity: 0;
            stroke-width: 0.02;
          }
        }
        @keyframes text-fade-in {
          0% {
            opacity: 0;
            transform: scale(0.98);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes subtext-fade-in {
          0% {
            opacity: 0;
          }
          100% {
            opacity: 0.5;
          }
        }
      `}</style>

      {/* Text Container - On top of sonar */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          textAlign: 'center',
        }}
      >
        {/* Main Text */}
        <div
          style={{
            fontFamily: "'VT323', monospace",
            fontSize: 'clamp(1.5rem, 5vw, 3rem)',
            color: colors.bright,
            letterSpacing: '0.15em',
            textShadow: 'none', // No glow - crisp text
            animation: 'text-fade-in 0.4s ease-out forwards',
          }}
        >
          follow the white whale
        </div>

        {/* Subtext */}
        <div
          style={{
            fontFamily: "'VT323', monospace",
            fontSize: 'clamp(0.75rem, 2vw, 1rem)',
            color: colors.dim,
            letterSpacing: '0.1em',
            marginTop: '1rem',
            opacity: 0,
            animation: 'subtext-fade-in 0.5s ease-out 0.3s forwards',
          }}
        >
          initializing sonar...
        </div>
      </div>

      {/* Skip hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '2rem',
          fontSize: '0.75rem',
          color: colors.dim,
          opacity: 0.4,
          fontFamily: "'VT323', monospace",
          letterSpacing: '0.1em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default SonarInterstitial;
