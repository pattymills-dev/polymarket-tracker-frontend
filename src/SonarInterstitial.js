import React, { useState, useEffect, useCallback } from 'react';

/**
 * Sonar Interstitial
 * Minimal intro sequence - restrained, functional
 */
const SonarInterstitial = ({ onComplete }) => {
  const [phase, setPhase] = useState('boot'); // 'boot' | 'typing' | 'sonar' | 'done'
  const [bootMessages, setBootMessages] = useState([]);
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isFading, setIsFading] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  const message = 'follow the white whale';
  const typingSpeed = 50; // ms per character

  const bootSequence = [
    'POLYMARKET TERMINAL v2.0',
    'INITIALIZING SCANNER...',
    'LOADING WHALE DETECTOR...',
    'SYSTEM READY',
  ];

  // Check if user prefers reduced motion
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Console colors - muted, restrained
  const colors = {
    bg: '#0a0c0a',
    text: '#708070',
    textBright: '#8faa8f',
    textDim: '#4a5a4a',
  };

  // Skip handler
  const handleSkip = useCallback(() => {
    if (!isFading) {
      setIsFading(true);
      setTimeout(() => {
        setIsVisible(false);
        onComplete();
      }, 200);
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
        setTimeout(() => setPhase('typing'), 300);
      }
    }, 100);

    return () => clearInterval(bootInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, prefersReducedMotion]);

  // Typewriter effect
  useEffect(() => {
    if (phase !== 'typing') return;

    let charIndex = 0;
    const typeInterval = setInterval(() => {
      if (charIndex < message.length) {
        setDisplayedText(message.slice(0, charIndex + 1));
        charIndex++;
      } else {
        clearInterval(typeInterval);
        setTimeout(() => setPhase('sonar'), 200);
      }
    }, typingSpeed);

    return () => clearInterval(typeInterval);
  }, [phase]);

  // Sonar phase - quick completion
  useEffect(() => {
    if (phase !== 'sonar') return;

    const timer = setTimeout(() => {
      setIsFading(true);
      setTimeout(() => {
        setIsVisible(false);
        onComplete();
      }, 400);
    }, 1200);

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
        transition: 'opacity 0.4s ease-out',
        overflow: 'hidden',
        fontFamily: "'VT323', monospace",
      }}
    >
      {/* Subtle sonar ring - only during sonar phase */}
      {phase === 'sonar' && (
        <svg
          style={{
            position: 'absolute',
            width: '150vmax',
            height: '150vmax',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
          }}
          viewBox="0 0 100 100"
          preserveAspectRatio="xMidYMid slice"
        >
          <circle
            cx="50"
            cy="50"
            r="2"
            fill="none"
            stroke={colors.text}
            strokeWidth="0.1"
            style={{
              animation: 'sonar-pulse 1.4s ease-out forwards',
              transformOrigin: '50% 50%',
            }}
          />
        </svg>
      )}

      <style>{`
        @keyframes sonar-pulse {
          0% {
            r: 2;
            opacity: 0.5;
            stroke-width: 0.2;
          }
          100% {
            r: 45;
            opacity: 0;
            stroke-width: 0.02;
          }
        }
      `}</style>

      {/* Boot Messages */}
      {phase === 'boot' && (
        <div style={{ textAlign: 'left', minWidth: '280px', padding: '0 2rem' }}>
          {bootMessages.map((msg, i) => (
            <div
              key={i}
              style={{
                color: i === bootMessages.length - 1 && bootMessages.length === bootSequence.length
                  ? colors.textBright
                  : colors.text,
                fontSize: '0.9rem',
                marginBottom: '0.2rem',
                letterSpacing: '0.02em',
              }}
            >
              &gt; {msg}
            </div>
          ))}
          {bootMessages.length < bootSequence.length && (
            <span style={{ color: colors.text, opacity: showCursor ? 1 : 0 }}>█</span>
          )}
        </div>
      )}

      {/* Main Text */}
      {(phase === 'typing' || phase === 'sonar') && (
        <div style={{ position: 'relative', zIndex: 10, textAlign: 'center' }}>
          <div
            style={{
              fontSize: 'clamp(1.25rem, 4vw, 2.5rem)',
              color: colors.textBright,
              letterSpacing: '0.12em',
            }}
          >
            {displayedText}
            {phase === 'typing' && (
              <span style={{ opacity: showCursor ? 1 : 0, marginLeft: '2px' }}>_</span>
            )}
          </div>

          {phase === 'sonar' && (
            <div
              style={{
                fontSize: 'clamp(0.7rem, 1.5vw, 0.9rem)',
                color: colors.textDim,
                letterSpacing: '0.08em',
                marginTop: '0.75rem',
              }}
            >
              scanning...
            </div>
          )}
        </div>
      )}

      {/* Skip hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '1.5rem',
          fontSize: '0.7rem',
          color: colors.textDim,
          opacity: 0.3,
          letterSpacing: '0.08em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default SonarInterstitial;
