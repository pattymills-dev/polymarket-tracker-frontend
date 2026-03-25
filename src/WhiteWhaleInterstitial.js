import React, { useState, useEffect, useCallback, useRef } from 'react';

// Sonar terminal intro interstitial — pixelated whale sonar echo
const WhiteWhaleInterstitial = ({ onComplete }) => {
  const [isFading, setIsFading]       = useState(false);
  const [sweepAngle, setSweepAngle]   = useState(0);
  const [showCursor, setShowCursor]   = useState(true);
  const [contacted, setContacted]     = useState(false);
  const completedRef                  = useRef(false);
  const contactFiredRef               = useRef(false);

  // Sonar green palette — matches main UI retroColors
  const sonarGreen      = '#4FB878';
  const sonarGreenDim   = '#357A52';
  const sonarGreenMuted = '#2D6846';
  const bgColor         = '#050705';

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Single completion gate — prevents double-fire from skip + auto
  const complete = useCallback((fadeDelay = 800) => {
    if (completedRef.current) return;
    completedRef.current = true;
    setIsFading(true);
    setTimeout(() => {
      sessionStorage.setItem('whale-interstitial-shown', 'true');
      onComplete();
    }, fadeDelay);
  }, [onComplete]);

  const handleSkip = useCallback(() => complete(300), [complete]);

  // Bootstrap: check session, register listeners, fallback timer
  useEffect(() => {
    const alreadyShown = sessionStorage.getItem('whale-interstitial-shown');
    if (alreadyShown || prefersReducedMotion) { onComplete(); return; }

    window.addEventListener('keydown', handleSkip);
    window.addEventListener('click',   handleSkip);
    const fallback = setTimeout(() => complete(800), 6500);

    return () => {
      window.removeEventListener('keydown', handleSkip);
      window.removeEventListener('click',   handleSkip);
      clearTimeout(fallback);
    };
  }, [onComplete, prefersReducedMotion, handleSkip, complete]);

  // Sonar sweep — 2° per 20 ms tick (~100°/s)
  // Whale sits at ~324° (upper-right quadrant).
  // When the sweep line crosses it, "CONTACT ACQUIRED" fires.
  const WHALE_ANGLE = 324;
  useEffect(() => {
    const alreadyShown = sessionStorage.getItem('whale-interstitial-shown');
    if (alreadyShown || prefersReducedMotion) return;

    const interval = setInterval(() => {
      setSweepAngle(prev => {
        const next = (prev + 2) % 360;
        if (
          !contactFiredRef.current &&
          prev < WHALE_ANGLE &&
          next >= WHALE_ANGLE
        ) {
          contactFiredRef.current = true;
          setTimeout(() => setContacted(true), 60);
          setTimeout(() => complete(800), 2200);
        }
        return next;
      });
    }, 20);

    return () => clearInterval(interval);
  }, [prefersReducedMotion, complete]);

  // Cursor blink
  useEffect(() => {
    const t = setInterval(() => setShowCursor(p => !p), 530);
    return () => clearInterval(t);
  }, []);

  // Already shown or reduced motion — render nothing
  const alreadyShown =
    typeof window !== 'undefined' &&
    sessionStorage.getItem('whale-interstitial-shown');
  if (alreadyShown || prefersReducedMotion) return null;

  // ── Sonar geometry ───────────────────────────────────────────────────────
  const sonarSize   = 320;
  const center      = sonarSize / 2;   // 160
  const outerRadius = 140;
  const midRadius   = 100;
  const innerRadius = 60;

  // ── Whale pixel art ──────────────────────────────────────────────────────
  // 20 cols × 9 rows at 4 px/pixel = 80 × 36 px total.
  // Head faces LEFT; tail flukes are on the RIGHT.
  // 0 = empty · 1 = body · 2 = highlight (dorsal tip, eye)
  const PX = 4;
  const whaleMap = [
    [0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0],  // row 0 — dorsal fin tip
    [0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],  // row 1 — dorsal fin
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0],  // row 2 — upper body
    [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,0],  // row 3 — upper body + upper fluke
    [0,0,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],  // row 4 — widest (eye col 2) + flukes
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],  // row 5 — lower body + flukes
    [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,0],  // row 6 — lower body + lower fluke
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0],  // row 7 — lower body
    [0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],  // row 8 — tail centre
  ];

  // Whale anchor: centre of mass lands at approx (225, 112) in SVG space,
  // which is ~81 px from sonar centre at bearing ~324° — sits between the
  // inner (60) and mid (100) rings, perfectly in the "contact zone".
  const WX = 185; // start X
  const WY =  94; // start Y

  // How far past the whale has the sweep rotated?
  // angleDiff = 0 right when sweep crosses the whale; trails off over 60°.
  const angleDiff  = (sweepAngle - WHALE_ANGLE + 360) % 360;
  const sweepTrail = angleDiff < 60 ? Math.max(0, 1 - angleDiff / 60) : 0;
  const whaleAlpha = 0.10 + sweepTrail * 0.40; // dims from 0.50 → 0.10

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: bgColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
        opacity: isFading ? 0 : 1,
        transition: 'opacity 0.8s ease-out',
      }}
    >
      {/* Vignette overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.65) 100%)',
        pointerEvents: 'none',
      }} />

      {/* ── Sonar SVG ──────────────────────────────────────────────────── */}
      <svg
        width={sonarSize}
        height={sonarSize}
        viewBox={`0 0 ${sonarSize} ${sonarSize}`}
        style={{ position: 'absolute', opacity: 0.95 }}
      >
        <defs>
          <linearGradient id="sweepGrad" gradientTransform={`rotate(${sweepAngle}, 0.5, 0.5)`}>
            <stop offset="0%"   stopColor={sonarGreen} stopOpacity="0.15" />
            <stop offset="100%" stopColor={sonarGreen} stopOpacity="0"    />
          </linearGradient>
          <radialGradient id="whaleGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={sonarGreen} stopOpacity="0.35" />
            <stop offset="100%" stopColor={sonarGreen} stopOpacity="0"    />
          </radialGradient>
        </defs>

        {/* Range rings */}
        {[outerRadius, midRadius, innerRadius].map((r, i) => (
          <circle key={r} cx={center} cy={center} r={r}
            fill="none" stroke={sonarGreenMuted} strokeWidth="1"
            opacity={[0.6, 0.4, 0.3][i]} />
        ))}

        {/* Centre pip */}
        <circle cx={center} cy={center} r="3" fill={sonarGreenDim} opacity="0.6" />

        {/* Bearing tick marks every 30° */}
        {[...Array(12)].map((_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          return (
            <line key={i}
              x1={center + Math.cos(a) * (outerRadius - 8)}
              y1={center + Math.sin(a) * (outerRadius - 8)}
              x2={center + Math.cos(a) *  outerRadius}
              y2={center + Math.sin(a) *  outerRadius}
              stroke={sonarGreenMuted} strokeWidth="1" opacity="0.5" />
          );
        })}

        {/* Crosshairs */}
        <line x1={center - outerRadius} y1={center} x2={center + outerRadius} y2={center}
          stroke={sonarGreenMuted} strokeWidth="0.5" opacity="0.25" />
        <line x1={center} y1={center - outerRadius} x2={center} y2={center + outerRadius}
          stroke={sonarGreenMuted} strokeWidth="0.5" opacity="0.25" />

        {/* Sweep wedge */}
        <path
          d={`
            M ${center} ${center}
            L ${center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius}
              ${center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
            A ${outerRadius} ${outerRadius} 0 0 0
              ${center + Math.cos(((sweepAngle - 45) * Math.PI) / 180) * outerRadius}
              ${center + Math.sin(((sweepAngle - 45) * Math.PI) / 180) * outerRadius}
            Z
          `}
          fill="url(#sweepGrad)"
        />

        {/* Sweep line */}
        <line
          x1={center} y1={center}
          x2={center + Math.cos((sweepAngle * Math.PI) / 180) * outerRadius}
          y2={center + Math.sin((sweepAngle * Math.PI) / 180) * outerRadius}
          stroke={sonarGreen} strokeWidth="1" opacity="0.45"
        />

        {/* Ambient noise dots */}
        {[...Array(8)].map((_, i) => {
          const a   = (i * 47 + sweepAngle * 0.3) * Math.PI / 180;
          const d   = 30 + (i * 17) % 90;
          return (
            <circle key={`n${i}`}
              cx={center + Math.cos(a) * d}
              cy={center + Math.sin(a) * d}
              r="1.5" fill={sonarGreenDim}
              opacity={0.15 + Math.sin(sweepAngle * 0.05 + i) * 0.12} />
          );
        })}

        {/* ── Whale glow halo (visible when sweep passes) ── */}
        {sweepTrail > 0.02 && (
          <ellipse
            cx={WX + 10 * PX}
            cy={WY +  4 * PX}
            rx={46} ry={22}
            fill="url(#whaleGlow)"
            opacity={sweepTrail * 0.55}
          />
        )}

        {/* ── Pixelated whale echo ── */}
        {whaleMap.map((row, ri) =>
          row.map((cell, ci) => {
            if (!cell) return null;
            const highlight = cell === 2;
            return (
              <rect
                key={`w${ri}-${ci}`}
                x={WX + ci * PX}
                y={WY + ri * PX}
                width={PX - 0.5}
                height={PX - 0.5}
                fill={highlight ? sonarGreen : sonarGreenDim}
                opacity={(highlight ? 1.6 : 1.0) * whaleAlpha}
              />
            );
          })
        )}

        {/* Contact pip — bright dot at whale centre after acquisition */}
        {contacted && (
          <circle
            cx={WX + 10 * PX}
            cy={WY +  4 * PX}
            r="2.5" fill={sonarGreen} opacity="0.85"
          />
        )}
      </svg>

      {/* ── Contact text ───────────────────────────────────────────────── */}
      {contacted && (
        <div style={{
          fontFamily: "'VT323', monospace",
          fontSize: 'clamp(1.2rem, 4vw, 2rem)',
          color: sonarGreen,
          letterSpacing: '0.14em',
          textShadow: `0 0 12px rgba(79, 184, 120, 0.35)`,
          position: 'relative',
          zIndex: 1,
        }}>
          &gt; CONTACT ACQUIRED
          <span style={{ opacity: showCursor ? 1 : 0, marginLeft: '3px' }}>_</span>
        </div>
      )}

      {/* ── Skip hint ──────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: '2rem',
        fontSize: '0.9rem',
        color: sonarGreenDim,
        opacity: 0.45,
        fontFamily: "'VT323', monospace",
        letterSpacing: '0.08em',
      }}>
        press any key to skip
      </div>
    </div>
  );
};

export default WhiteWhaleInterstitial;
