import React, { useState, useEffect, useCallback } from 'react';

/**
 * Sonar Interstitial v3
 * Full-page sonar panel with boot sequence + "follow the white whale."
 */

// Constants moved outside component to avoid dependency warnings
const BOOT_SEQUENCE = [
  '> INITIALIZING SONAR ARRAY...',
  '> SCANNING POLYMARKET FEEDS...',
  '> NORMALIZING TRADE FLOW...',
  '> FILTERING EXTREME PROBABILITIES...',
  '> WHALE DETECTION ONLINE...',
  '> RESOLUTION SYNC ARMED...',
  '> ALERT CHANNELS ARMED...',
  '> TRACKING ENABLED.',
  '> WARMING CACHE LAYERS...',
  '> TARGET ACQUISITION READY...',
  '> STANDING BY...',
];
const MESSAGE = 'follow the white whale.';
const BOOT_LINE_DELAY = 280; // ms per boot line
const TYPING_SPEED = 70; // ms per character

const SonarInterstitial = ({ onComplete }) => {
  const [phase, setPhase] = useState('boot'); // 'boot' | 'message'
  const [bootLines, setBootLines] = useState([]);
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isComplete, setIsComplete] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [sweepAngle, setSweepAngle] = useState(0);

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

  // Sonar sweep animation - runs throughout
  useEffect(() => {
    if (prefersReducedMotion || !isVisible) return;

    const sweepInterval = setInterval(() => {
      setSweepAngle(prev => (prev + 2) % 360);
    }, 20);

    return () => clearInterval(sweepInterval);
  }, [prefersReducedMotion, isVisible]);

  // Boot sequence effect
  useEffect(() => {
    if (prefersReducedMotion) {
      setIsVisible(false);
      onComplete();
      return;
    }

    // Reset in case this component is ever remounted quickly.
    setBootLines([]);
    setPhase('boot');
    setDisplayedText('');
    setIsComplete(false);

    let lineIndex = 0;
    const bootInterval = setInterval(() => {
      if (lineIndex < BOOT_SEQUENCE.length) {
        setBootLines(prev => [...prev, BOOT_SEQUENCE[lineIndex]]);
        lineIndex++;
      } else {
        clearInterval(bootInterval);
        // Transition to message phase
        setTimeout(() => {
          setPhase('message');
        }, 400);
      }
    }, BOOT_LINE_DELAY);

    return () => clearInterval(bootInterval);
  }, [prefersReducedMotion, onComplete]);

  // Typewriter effect for main message
  useEffect(() => {
    if (phase !== 'message' || prefersReducedMotion) return;

    let charIndex = 0;
    const typeInterval = setInterval(() => {
      if (charIndex < MESSAGE.length) {
        setDisplayedText(MESSAGE.slice(0, charIndex + 1));
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
        }, 1200);
      }
    }, TYPING_SPEED);

    return () => clearInterval(typeInterval);
  }, [phase, prefersReducedMotion, onComplete]);

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

  // Full viewport sonar - use min dimension to fit
  const viewportSize = typeof window !== 'undefined'
    ? Math.min(window.innerWidth, window.innerHeight) * 0.95
    : 600;
  const sonarSize = viewportSize;
  const center = sonarSize / 2;
  const outerRadius = sonarSize * 0.45;
  const innerRadius1 = sonarSize * 0.32;
  const innerRadius2 = sonarSize * 0.18;
  const innerRadius3 = sonarSize * 0.08;

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
          background: 'radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,0.7) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* FULL PAGE Sonar panel SVG */}
      <svg
        width={sonarSize}
        height={sonarSize}
        viewBox={`0 0 ${sonarSize} ${sonarSize}`}
        style={{
          position: 'absolute',
          opacity: 0.3,
        }}
      >
        {/* Outer ring */}
        <circle
          cx={center}
          cy={center}
          r={outerRadius}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1.5"
          opacity="0.6"
        />

        {/* Ring 2 */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius1}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1"
          opacity="0.45"
        />

        {/* Ring 3 */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius2}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1"
          opacity="0.35"
        />

        {/* Inner ring */}
        <circle
          cx={center}
          cy={center}
          r={innerRadius3}
          fill="none"
          stroke={colors.sonarGreenMuted}
          strokeWidth="1"
          opacity="0.25"
        />

        {/* Center dot */}
        <circle
          cx={center}
          cy={center}
          r={sonarSize * 0.008}
          fill={colors.sonarGreenDim}
          opacity="0.6"
        />

        {/* Radial tick marks - every 30 degrees */}
        {[...Array(12)].map((_, i) => {
          const angle = (i * 30 * Math.PI) / 180;
          const x1 = center + Math.cos(angle) * (outerRadius - 12);
          const y1 = center + Math.sin(angle) * (outerRadius - 12);
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
              opacity="0.5"
            />
          );
        })}

        {/* Minor tick marks - every 10 degrees */}
        {[...Array(36)].map((_, i) => {
          if (i % 3 === 0) return null; // Skip major ticks
          const angle = (i * 10 * Math.PI) / 180;
          const x1 = center + Math.cos(angle) * (outerRadius - 6);
          const y1 = center + Math.sin(angle) * (outerRadius - 6);
          const x2 = center + Math.cos(angle) * outerRadius;
          const y2 = center + Math.sin(angle) * outerRadius;
          return (
            <line
              key={`minor-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={colors.sonarGreenMuted}
              strokeWidth="0.5"
              opacity="0.3"
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

        {/* Diagonal cross hairs */}
        <line
          x1={center - outerRadius * 0.707}
          y1={center - outerRadius * 0.707}
          x2={center + outerRadius * 0.707}
          y2={center + outerRadius * 0.707}
          stroke={colors.sonarGreenMuted}
          strokeWidth="0.3"
          opacity="0.12"
        />
        <line
          x1={center + outerRadius * 0.707}
          y1={center - outerRadius * 0.707}
          x2={center - outerRadius * 0.707}
          y2={center + outerRadius * 0.707}
          stroke={colors.sonarGreenMuted}
          strokeWidth="0.3"
          opacity="0.12"
        />

        {/* Sweep wedge gradient */}
        <defs>
          <linearGradient id="sweepGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={colors.sonarGreen} stopOpacity="0.15" />
            <stop offset="100%" stopColor={colors.sonarGreen} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Sweep wedge - 50 degree trailing arc */}
        <path
          d={`
            M ${center} ${center}
            L ${center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius} ${center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
            A ${outerRadius} ${outerRadius} 0 0 0 ${center + Math.cos(((sweepAngle - 50) * Math.PI) / 180) * outerRadius} ${center + Math.sin(((sweepAngle - 50) * Math.PI) / 180) * outerRadius}
            Z
          `}
          fill="url(#sweepGrad)"
        />

        {/* Sweep line */}
        <line
          x1={center}
          y1={center}
          x2={center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius}
          y2={center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
          stroke={colors.sonarGreen}
          strokeWidth="1.5"
          opacity="0.4"
        />

        {/* Noise dots - more of them for larger display */}
        {[...Array(12)].map((_, i) => {
          const dotAngle = (i * 31 + sweepAngle * 0.2) * Math.PI / 180;
          const dist = (outerRadius * 0.2) + (i * outerRadius * 0.06) % (outerRadius * 0.7);
          return (
            <circle
              key={`dot-${i}`}
              cx={center + Math.cos(dotAngle) * dist}
              cy={center + Math.sin(dotAngle) * dist}
              r={sonarSize * 0.004}
              fill={colors.sonarGreenDim}
              opacity={0.2 + (Math.sin(sweepAngle * 0.03 + i) * 0.15)}
            />
          );
        })}
      </svg>

      {/* Center stage: fixed height prevents "recentering" when switching phases */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 10,
          textAlign: 'center',
          padding: '0 1.5rem',
          width: 'min(680px, calc(100% - 3rem))',
          height: 'min(520px, 70vh)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        {/* Boot text stays on-screen (dims) while the message types in */}
        <div
          style={{
            fontSize: 'clamp(0.9rem, 2.5vw, 1.1rem)',
            color: colors.sonarGreenDim,
            letterSpacing: '0.05em',
            lineHeight: 1.8,
            opacity: phase === 'boot' ? 1 : 0.35,
            transition: 'opacity 0.35s ease-out',
          }}
        >
          {bootLines.map((line, idx) => (
            <div key={idx} style={{ opacity: 0.7, minHeight: '1.8em' }}>
              {line}
            </div>
          ))}
          {phase === 'boot' && (
            <span style={{ opacity: showCursor ? 0.7 : 0 }}>_</span>
          )}
        </div>

        {/* Main message */}
        <div
          style={{
            minHeight: '3.2em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: phase === 'message' ? 1 : 0,
            transition: 'opacity 0.25s ease-in',
          }}
        >
          <div
            style={{
              fontSize: 'clamp(1.6rem, 6vw, 2.6rem)',
              color: colors.sonarGreen,
              letterSpacing: '0.10em',
              textShadow: `0 0 15px rgba(79, 184, 120, 0.3)`,
            }}
          >
            {displayedText}
            {phase === 'message' && !isComplete && (
              <span style={{ opacity: showCursor ? 1 : 0, marginLeft: '2px' }}>_</span>
            )}
          </div>
        </div>
      </div>

      {/* Skip hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '1.5rem',
          fontSize: '0.85rem',
          color: colors.sonarGreenDim,
          opacity: 0.35,
          letterSpacing: '0.06em',
        }}
      >
        press any key to skip
      </div>
    </div>
  );
};

export default SonarInterstitial;
