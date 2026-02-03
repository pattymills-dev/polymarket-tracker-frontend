import React, { useState, useEffect, useCallback } from 'react';

const WhiteWhaleInterstitial = ({ onComplete }) => {
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isComplete, setIsComplete] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const [sweepAngle, setSweepAngle] = useState(0);

  const message = 'follow the white whale.';
  const typingSpeed = 80; // ms per character

  // Sonar green colors - matches main UI retroColors
  const sonarGreen = '#4FB878';      // textPrimary equivalent
  const sonarGreenDim = '#357A52';   // textDim equivalent
  const sonarGreenMuted = '#2D6846'; // textMuted equivalent
  const bgColor = '#050705';         // surfaceDark equivalent

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

  // Sonar sweep animation
  useEffect(() => {
    const alreadyShown = sessionStorage.getItem('whale-interstitial-shown');
    if (alreadyShown || prefersReducedMotion) return;

    const sweepInterval = setInterval(() => {
      setSweepAngle(prev => (prev + 2) % 360);
    }, 20);

    return () => clearInterval(sweepInterval);
  }, [prefersReducedMotion]);

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
        }, 1200);
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

  // SVG sonar panel
  const sonarSize = 320;
  const center = sonarSize / 2;
  const outerRadius = 140;
  const innerRadius1 = 100;
  const innerRadius2 = 60;

  return (
    <div
      className={`white-whale-interstitial ${isFading ? 'fading' : ''}`}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: bgColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        opacity: isFading ? 0 : 1,
        transition: 'opacity 0.8s ease-out',
      }}
    >
      {/* Vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.6) 100%)',
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
          opacity: 0.4,
        }}
      >
        {/* Outer ring */}
        <circle
          cx={center}
          cy={center}
          r={outerRadius}
          fill="none"
          stroke={sonarGreenMuted}
          strokeWidth="1"
          opacity="0.6"
        />

        {/* Middle ring */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius1}
          fill="none"
          stroke={sonarGreenMuted}
          strokeWidth="1"
          opacity="0.4"
        />

        {/* Inner ring */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius2}
          fill="none"
          stroke={sonarGreenMuted}
          strokeWidth="1"
          opacity="0.3"
        />

        {/* Center dot */}
        <circle
          cx={center}
          cy={center}
          r="3"
          fill={sonarGreenDim}
          opacity="0.6"
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
              stroke={sonarGreenMuted}
              strokeWidth="1"
              opacity="0.5"
            />
          );
        })}

        {/* Cross hairs */}
        <line
          x1={center - outerRadius}
          y1={center}
          x2={center + outerRadius}
          y2={center}
          stroke={sonarGreenMuted}
          strokeWidth="0.5"
          opacity="0.25"
        />
        <line
          x1={center}
          y1={center - outerRadius}
          x2={center}
          y2={center + outerRadius}
          stroke={sonarGreenMuted}
          strokeWidth="0.5"
          opacity="0.25"
        />

        {/* Sweep wedge - subtle gradient */}
        <defs>
          <linearGradient id="sweepGradient" gradientTransform={`rotate(${sweepAngle}, 0.5, 0.5)`}>
            <stop offset="0%" stopColor={sonarGreen} stopOpacity="0.15" />
            <stop offset="100%" stopColor={sonarGreen} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Sweep arc - 45 degree wedge */}
        <path
          d={`
            M ${center} ${center}
            L ${center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius} ${center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
            A ${outerRadius} ${outerRadius} 0 0 0 ${center + Math.cos(((sweepAngle - 45) * Math.PI) / 180) * outerRadius} ${center + Math.sin(((sweepAngle - 45) * Math.PI) / 180) * outerRadius}
            Z
          `}
          fill={`url(#sweepGradient)`}
          style={{
            transform: `rotate(${sweepAngle}deg)`,
            transformOrigin: 'center',
          }}
        />

        {/* Sweep line */}
        <line
          x1={center}
          y1={center}
          x2={center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius}
          y2={center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
          stroke={sonarGreen}
          strokeWidth="1"
          opacity="0.4"
        />

        {/* Random noise dots - subtle */}
        {[...Array(8)].map((_, i) => {
          const angle = (i * 47 + sweepAngle * 0.3) * Math.PI / 180;
          const dist = 30 + (i * 17) % 90;
          return (
            <circle
              key={`noise-${i}`}
              cx={center + Math.cos(angle) * dist}
              cy={center + Math.sin(angle) * dist}
              r="1.5"
              fill={sonarGreenDim}
              opacity={0.2 + (Math.sin(sweepAngle * 0.05 + i) * 0.15)}
            />
          );
        })}
      </svg>

      {/* Main text */}
      <div
        className="interstitial-text"
        style={{
          fontFamily: "'VT323', monospace",
          fontSize: 'clamp(1.5rem, 5vw, 2.5rem)',
          color: sonarGreen,
          letterSpacing: '0.12em',
          textShadow: `0 0 12px rgba(79, 184, 120, 0.3)`,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {displayedText}
        <span
          style={{
            opacity: showCursor ? 1 : 0,
            marginLeft: '2px',
            color: sonarGreen,
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
          fontSize: '0.9rem',
          color: sonarGreenDim,
          opacity: 0.5,
          fontFamily: "'VT323', monospace",
          letterSpacing: '0.08em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default WhiteWhaleInterstitial;
