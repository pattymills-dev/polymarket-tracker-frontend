import React, { useState, useEffect, useCallback } from 'react';

/**
 * Sonar Interstitial
 * Full-screen intro with:
 * 1. Boot messages appearing line by line
 * 2. "follow the white whale" typed letter by letter
 * 3. Sonar pulse animation expanding behind text
 */
const SonarInterstitial = ({ onComplete }) => {
  const [phase, setPhase] = useState('boot'); // 'boot' | 'typing' | 'sonar' | 'done'
  const [bootMessages, setBootMessages] = useState([]);
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isFading, setIsFading] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  const message = 'follow the white whale';
  const typingSpeed = 60; // ms per character

  const bootSequence = [
    'POLYMARKET TERMINAL v2.0',
    'INITIALIZING MARKET SCANNER...',
    'LOADING WHALE DETECTOR...',
    'CALIBRATING PREDICTION MODELS...',
    'ESTABLISHING DATABASE LINK...',
    'SYSTEM READY',
  ];

  // Check if user prefers reduced motion
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Sonar colors - unified console palette
  const colors = {
    bg: '#060908',
    primary: '#5a8a6a',
    bright: '#6ddb8a',
    dim: '#3a5a48',
  };

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

  // Boot sequence effect
  useEffect(() => {
    if (prefersReducedMotion) {
      setIsVisible(false);
      onComplete();
      return;
    }

    if (phase !== 'boot') return;

    let index = 0;
    const bootInterval = setInterval(() => {
      if (index < bootSequence.length) {
        setBootMessages(prev => [...prev, bootSequence[index]]);
        index++;
      } else {
        clearInterval(bootInterval);
        // Short pause then start typing
        setTimeout(() => setPhase('typing'), 400);
      }
    }, 120);

    return () => clearInterval(bootInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, prefersReducedMotion]);

  // Typewriter effect for "follow the white whale"
  useEffect(() => {
    if (phase !== 'typing') return;

    let charIndex = 0;
    const typeInterval = setInterval(() => {
      if (charIndex < message.length) {
        setDisplayedText(message.slice(0, charIndex + 1));
        charIndex++;
      } else {
        clearInterval(typeInterval);
        // Start sonar after typing complete
        setTimeout(() => setPhase('sonar'), 300);
      }
    }, typingSpeed);

    return () => clearInterval(typeInterval);
  }, [phase]);

  // Sonar phase - auto complete after animation
  useEffect(() => {
    if (phase !== 'sonar') return;

    const timer = setTimeout(() => {
      setIsFading(true);
      setTimeout(() => {
        setIsVisible(false);
        onComplete();
      }, 600);
    }, 1800); // Let sonar animation play

    return () => clearTimeout(timer);
  }, [phase, onComplete]);

  // Cursor blink
  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor(prev => !prev);
    }, 530);
    return () => clearInterval(cursorInterval);
  }, []);

  // Skip event listeners
  useEffect(() => {
    if (prefersReducedMotion) return;

    const handleKeyPress = () => handleSkip();
    const handleClick = () => handleSkip();

    window.addEventListener('keydown', handleKeyPress);
    window.addEventListener('click', handleClick);

    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      window.removeEventListener('click', handleClick);
    };
  }, [prefersReducedMotion, handleSkip]);

  // Don't render if reduced motion or not visible
  if (!isVisible || prefersReducedMotion) {
    return null;
  }

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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        opacity: isFading ? 0 : 1,
        transition: 'opacity 0.6s ease-out',
        overflow: 'hidden',
        fontFamily: "'VT323', monospace",
      }}
    >
      {/* SVG Sonar Rings - Only show during sonar phase */}
      {phase === 'sonar' && (
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
              animation: 'sonar-pulse-1 1.6s ease-out forwards',
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
              animation: 'sonar-pulse-2 1.6s ease-out 0.2s forwards',
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
              animation: 'sonar-pulse-3 1.6s ease-out 0.4s forwards',
              transformOrigin: '50% 50%',
              opacity: 0,
            }}
          />
        </svg>
      )}

      {/* CSS Keyframes */}
      <style>{`
        @keyframes sonar-pulse-1 {
          0% {
            r: 2;
            opacity: 0.9;
            stroke-width: 0.3;
          }
          100% {
            r: 50;
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
            r: 45;
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
            r: 40;
            opacity: 0;
            stroke-width: 0.02;
          }
        }
        @keyframes cursor-blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>

      {/* Boot Messages - Show during boot phase */}
      {phase === 'boot' && (
        <div style={{ textAlign: 'left', minWidth: '320px', padding: '0 2rem' }}>
          {bootMessages.map((msg, i) => (
            <div
              key={i}
              style={{
                color: i === bootMessages.length - 1 && bootMessages.length === bootSequence.length
                  ? colors.bright
                  : colors.primary,
                fontSize: '1rem',
                marginBottom: '0.25rem',
                letterSpacing: '0.02em',
              }}
            >
              &gt; {msg}
            </div>
          ))}
          {bootMessages.length < bootSequence.length && (
            <span
              style={{
                color: colors.primary,
                animation: 'cursor-blink 1s step-end infinite',
              }}
            >
              █
            </span>
          )}
        </div>
      )}

      {/* Main Text Container - Show during typing and sonar phases */}
      {(phase === 'typing' || phase === 'sonar') && (
        <div
          style={{
            position: 'relative',
            zIndex: 10,
            textAlign: 'center',
          }}
        >
          {/* Main Text with typewriter effect */}
          <div
            style={{
              fontSize: 'clamp(1.5rem, 5vw, 3rem)',
              color: colors.bright,
              letterSpacing: '0.15em',
              textShadow: 'none',
            }}
          >
            {displayedText}
            {phase === 'typing' && (
              <span
                style={{
                  opacity: showCursor ? 1 : 0,
                  marginLeft: '2px',
                  color: colors.bright,
                }}
              >
                _
              </span>
            )}
          </div>

          {/* Subtext - Only show during sonar */}
          {phase === 'sonar' && (
            <div
              style={{
                fontSize: 'clamp(0.75rem, 2vw, 1rem)',
                color: colors.dim,
                letterSpacing: '0.1em',
                marginTop: '1rem',
                opacity: 0.6,
              }}
            >
              scanning for whales...
            </div>
          )}
        </div>
      )}

      {/* Skip hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '2rem',
          fontSize: '0.75rem',
          color: colors.dim,
          opacity: 0.4,
          letterSpacing: '0.1em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default SonarInterstitial;
