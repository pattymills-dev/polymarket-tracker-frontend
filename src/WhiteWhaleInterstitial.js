import React, { useState, useEffect, useCallback } from 'react';

const WhiteWhaleInterstitial = ({ onComplete }) => {
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isComplete, setIsComplete] = useState(false);
  const [isFading, setIsFading] = useState(false);

  const message = 'follow the white whale';
  const typingSpeed = 80; // ms per character

  // Check if user prefers reduced motion
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Skip handler
  const handleSkip = useCallback(() => {
    if (!isComplete) {
      setIsFading(true);
      setTimeout(() => {
        sessionStorage.setItem('whale-interstitial-shown', 'true');
        onComplete();
      }, 300);
    }
  }, [isComplete, onComplete]);

  // Check if already shown this session
  useEffect(() => {
    const alreadyShown = sessionStorage.getItem('whale-interstitial-shown');
    if (alreadyShown || prefersReducedMotion) {
      onComplete();
      return;
    }

    // Add event listeners for skip
    const handleKeyPress = () => handleSkip();
    const handleClick = () => handleSkip();

    window.addEventListener('keydown', handleKeyPress);
    window.addEventListener('click', handleClick);

    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      window.removeEventListener('click', handleClick);
    };
  }, [onComplete, prefersReducedMotion, handleSkip]);

  // Typewriter effect
  useEffect(() => {
    const alreadyShown = sessionStorage.getItem('whale-interstitial-shown');
    if (alreadyShown || prefersReducedMotion) return;

    let currentIndex = 0;
    const typeInterval = setInterval(() => {
      if (currentIndex < message.length) {
        setDisplayedText(message.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(typeInterval);
        setIsComplete(true);

        // Wait a moment then fade out
        setTimeout(() => {
          setIsFading(true);
          setTimeout(() => {
            sessionStorage.setItem('whale-interstitial-shown', 'true');
            onComplete();
          }, 800);
        }, 1500);
      }
    }, typingSpeed);

    return () => clearInterval(typeInterval);
  }, [onComplete, prefersReducedMotion]);

  // Cursor blink
  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor(prev => !prev);
    }, 530);
    return () => clearInterval(cursorInterval);
  }, []);

  // Don't render if reduced motion or already shown
  const alreadyShown = typeof window !== 'undefined' && sessionStorage.getItem('whale-interstitial-shown');
  if (alreadyShown || prefersReducedMotion) {
    return null;
  }

  return (
    <div
      className={`white-whale-interstitial ${isFading ? 'fading' : ''}`}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#050806',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        opacity: isFading ? 0 : 1,
        transition: 'opacity 0.8s ease-out',
      }}
    >
      <div
        className="interstitial-text"
        style={{
          fontFamily: "'VT323', monospace",
          fontSize: 'clamp(1.5rem, 5vw, 3rem)',
          color: '#7CFF9B',
          letterSpacing: '0.15em',
          textShadow: '0 0 20px rgba(124, 255, 155, 0.5)',
        }}
      >
        {displayedText}
        <span
          style={{
            opacity: showCursor ? 1 : 0,
            marginLeft: '2px',
            color: '#7CFF9B',
          }}
        >
          _
        </span>
      </div>

      {/* Skip hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '2rem',
          fontSize: '0.875rem',
          color: '#3AAE66',
          opacity: 0.6,
          fontFamily: "'VT323', monospace",
          letterSpacing: '0.1em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default WhiteWhaleInterstitial;
