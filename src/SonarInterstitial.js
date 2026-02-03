import React, { useState, useEffect, useCallback } from 'react';

/**
 * Sonar Interstitial v2
 * Subdued sonar panel effect with matching main UI colors
 */
const SonarInterstitial = ({ onComplete }) => {
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isComplete, setIsComplete] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [sweepAngle, setSweepAngle] = useState(0);

  const message = 'follow the white whale.';
  const typingSpeed = 70; // ms per character

  // Sonar green colors - matches main UI retroColors exactly
  const colors = {
    bg: '#050705',              // surfaceDark
    sonarGreen: '#4FB878',      // textPrimary - main text color
    sonarGreenDim: '#357A52',   // textDim - secondary elements
    sonarGreenMuted: '#2D6846', // textMuted - subtle elements
  };

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
      }, 200);
    }
  }, [isFading, onComplete]);

  // Sonar sweep animation
  useEffect(() => {
    if (prefersReducedMotion || !isVisible) return;

    const sweepInterval = setInterval(() => {
      setSweepAngle(prev => (prev + 2) % 360);
    }, 20);

    return () => clearInterval(sweepInterval);
  }, [prefersReducedMotion, isVisible]);

  // Typewriter effect
  useEffect(() => {
    if (prefersReducedMotion) {
      setIsVisible(false);
      onComplete();
      return;
    }

    let charIndex = 0;
    const typeInterval = setInterval(() => {
      if (charIndex < message.length) {
        setDisplayedText(message.slice(0, charIndex + 1));
        charIndex++;
      } else {
        clearInterval(typeInterval);
        setIsComplete(true);

        // Wait then fade out
        setTimeout(() => {
          setIsFading(true);
          setTimeout(() => {
            setIsVisible(false);
            onComplete();
          }, 600);
        }, 1000);
      }
    }, typingSpeed);

    return () => clearInterval(typeInterval);
  }, [prefersReducedMotion, onComplete]);

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

  // SVG sonar panel dimensions
  const sonarSize = 300;
  const center = sonarSize / 2;
  const outerRadius = 130;
  const innerRadius1 = 95;
  const innerRadius2 = 55;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: colors.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        opacity: isFading ? 0 : 1,
        transition: 'opacity 0.6s ease-out',
        overflow: 'hidden',
        fontFamily: "'VT323', monospace",
      }}
    >
      {/* Vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at center, transparent 25%, rgba(0,0,0,0.5) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Sonar panel SVG */}
      <svg
        width={sonarSize}
        height={sonarSize}
        viewBox={`0 0 ${sonarSize} ${sonarSize}`}
        style={{
          position: 'absolute',
          opacity: 0.35,
        }}
      >
        {/* Outer ring */}
        <circle
          cx={center}
          cy={center}
          r={outerRadius}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1"
          opacity="0.6"
        />

        {/* Middle ring */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius1}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1"
          opacity="0.4"
        />

        {/* Inner ring */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius2}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1"
          opacity="0.3"
        />

        {/* Center dot */}
        <circle
          cx={center}
          cy={center}
          r="3"
          fill={colors.sonarGreenDim}
          opacity="0.5"
        />

        {/* Radial tick marks - every 30 degrees */}
        {[...Array(12)].map((_, i) => {
          const angle = (i * 30 * Math.PI) / 180;
          const x1 = center + Math.cos(angle) * (outerRadius - 8);
          const y1 = center + Math.sin(angle) * (outerRadius - 8);
          const x2 = center + Math.cos(angle) * outerRadius;
          const y2 = center + Math.sin(angle) * outerRadius;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={colors.sonarGreenMuted}
              strokeWidth="1"
              opacity="0.45"
            />
          );
        })}

        {/* Cross hairs */}
        <line
          x1={center - outerRadius}
          y1={center}
          x2={center + outerRadius}
          y2={center}
          stroke={colors.sonarGreenMuted}
          strokeWidth="0.5"
          opacity="0.2"
        />
        <line
          x1={center}
          y1={center - outerRadius}
          x2={center}
          y2={center + outerRadius}
          stroke={colors.sonarGreenMuted}
          strokeWidth="0.5"
          opacity="0.2"
        />

        {/* Sweep line */}
        <line
          x1={center}
          y1={center}
          x2={center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius}
          y2={center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
          stroke={colors.sonarGreen}
          strokeWidth="1"
          opacity="0.35"
        />

        {/* Sweep wedge gradient */}
        <defs>
          <linearGradient id="sweepGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={colors.sonarGreen} stopOpacity="0.12" />
            <stop offset="100%" stopColor={colors.sonarGreen} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Sweep wedge - 40 degree trailing arc */}
        <path
          d={`
            M ${center} ${center}
            L ${center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius} ${center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
            A ${outerRadius} ${outerRadius} 0 0 0 ${center + Math.cos(((sweepAngle - 40) * Math.PI) / 180) * outerRadius} ${center + Math.sin(((sweepAngle - 40) * Math.PI) / 180) * outerRadius}
            Z
          `}
          fill="url(#sweepGrad)"
        />

        {/* Subtle noise dots */}
        {[...Array(6)].map((_, i) => {
          const dotAngle = (i * 53 + sweepAngle * 0.25) * Math.PI / 180;
          const dist = 35 + (i * 19) % 80;
          return (
            <circle
              key={`dot-${i}`}
              cx={center + Math.cos(dotAngle) * dist}
              cy={center + Math.sin(dotAngle) * dist}
              r="1.5"
              fill={colors.sonarGreenDim}
              opacity={0.15 + (Math.sin(sweepAngle * 0.04 + i) * 0.1)}
            />
          );
        })}
      </svg>

      {/* Main text */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          textAlign: 'center',
          padding: '0 1rem',
        }}
      >
        <div
          style={{
            fontSize: 'clamp(1.4rem, 5vw, 2.4rem)',
            color: colors.sonarGreen,
            letterSpacing: '0.1em',
            textShadow: `0 0 10px rgba(79, 184, 120, 0.25)`,
          }}
        >
          {displayedText}
          {!isComplete && (
            <span style={{ opacity: showCursor ? 1 : 0, marginLeft: '2px' }}>_</span>
          )}
        </div>
      </div>

      {/* Skip hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '1.5rem',
          fontSize: '0.85rem',
          color: colors.sonarGreenDim,
          opacity: 0.4,
          letterSpacing: '0.06em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default SonarInterstitial;
