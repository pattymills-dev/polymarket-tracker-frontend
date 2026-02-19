import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../ThemeContext';
import {
  createInitialState,
  createRng,
  pointKey,
  queueTurn,
  restart,
  tick,
  togglePause
} from './snakeLogic';

const BOARD_ROWS = 20;
const BOARD_COLS = 20;
const TICK_MS = 120;

const KEY_TO_DIR = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  w: 'UP',
  a: 'LEFT',
  s: 'DOWN',
  d: 'RIGHT',
  W: 'UP',
  A: 'LEFT',
  S: 'DOWN',
  D: 'RIGHT'
};

function getOverlayBg(isRetro) {
  return isRetro ? 'rgba(0,0,0,0.78)' : 'rgba(2,6,23,0.72)';
}

export default function SnakeGameModal({ open, onClose }) {
  const { isRetro } = useTheme();
  const rngRef = useRef(null);
  const [game, setGame] = useState(() =>
    createInitialState({ rows: BOARD_ROWS, cols: BOARD_COLS, rng: Math.random })
  );

  useEffect(() => {
    if (!open) return;

    rngRef.current = createRng(Date.now());
    const fresh = createInitialState({ rows: BOARD_ROWS, cols: BOARD_COLS, rng: rngRef.current });
    // Start paused so the player has time to orient.
    setGame({ ...fresh, status: 'paused' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e) => {
      const dir = KEY_TO_DIR[e.key];

      if (dir) {
        e.preventDefault();
        setGame((prev) => {
          if (prev.status === 'gameover') return prev;
          let next = queueTurn(prev, dir);
          if (next.status === 'paused') next = { ...next, status: 'playing' };
          return next;
        });
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setGame((prev) => togglePause(prev));
        return;
      }

      if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') {
        e.preventDefault();
        setGame((prev) => {
          const next = restart(prev, rngRef.current || Math.random);
          return { ...next, status: 'paused' };
        });
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    if (game.status !== 'playing') return;

    const id = setInterval(() => {
      setGame((prev) => tick(prev, rngRef.current || Math.random));
    }, TICK_MS);

    return () => clearInterval(id);
  }, [open, game.status]);

  const snakeKeys = useMemo(() => new Set(game.snake.map(pointKey)), [game.snake]);
  const headKey = game.snake[0] ? pointKey(game.snake[0]) : null;
  const foodKey = game.food ? pointKey(game.food) : null;

  if (!open) return null;

  const cardStyle = isRetro
    ? { backgroundColor: 'var(--retro-surface)', borderColor: 'var(--retro-border)', color: 'var(--retro-text)' }
    : {};

  const boardBorderColor = isRetro ? 'var(--retro-border)' : 'rgba(51,65,85,0.9)';
  const boardCellBg = isRetro ? 'var(--retro-surface-dark)' : 'rgb(2, 6, 23)';
  const snakeHeadBg = isRetro ? 'var(--retro-numbers)' : 'rgb(52, 211, 153)';
  const snakeBodyBg = isRetro ? 'var(--retro-primary)' : 'rgba(52, 211, 153, 0.55)';
  const foodBg = isRetro ? 'var(--retro-accent)' : 'rgb(251, 113, 133)';

  const buttonBase = `px-3 py-2 rounded-md text-sm font-medium border transition-colors`;
  const buttonModern = `bg-slate-950 hover:bg-slate-900 border-slate-800 text-slate-100`;
  const buttonRetro = ``;

  const pauseLabel =
    game.status === 'paused'
      ? (isRetro ? 'RESUME' : 'Resume')
      : (isRetro ? 'PAUSE' : 'Pause');

  const statusLabel =
    game.status === 'paused'
      ? (isRetro ? 'PAUSED' : 'Paused')
      : game.status === 'gameover'
        ? (isRetro ? 'GAME OVER' : 'Game over')
        : (isRetro ? 'RUNNING' : 'Running');

  const gameOverMessage =
    game.gameOverReason === 'win'
      ? (isRetro ? 'BOARD CLEARED.' : 'Board cleared.')
      : game.gameOverReason === 'self'
        ? (isRetro ? 'SELF COLLISION.' : 'Self collision.')
        : game.gameOverReason === 'wall'
          ? (isRetro ? 'HIT THE WALL.' : 'Hit the wall.')
          : '';

  const handleDir = (dir) => {
    setGame((prev) => {
      if (prev.status === 'gameover') return prev;
      let next = queueTurn(prev, dir);
      if (next.status === 'paused') next = { ...next, status: 'playing' };
      return next;
    });
  };

  const handleRestart = () => {
    setGame((prev) => {
      const next = restart(prev, rngRef.current || Math.random);
      return { ...next, status: 'paused' };
    });
  };

  const handlePause = () => setGame((prev) => togglePause(prev));

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ backgroundColor: getOverlayBg(isRetro) }}
      onPointerDown={(e) => {
        // Click outside closes.
        if (e.target === e.currentTarget) onClose?.();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Snake game"
    >
      <div
        className={`w-full max-w-lg rounded-lg border p-4 ${isRetro ? '' : 'bg-slate-900 border-slate-800 text-slate-100'}`}
        style={cardStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={`text-lg font-semibold ${isRetro ? '' : 'text-slate-100'}`}>
              {isRetro ? 'SNAKE' : 'Snake'}
            </div>
            <div className="text-xs mt-1" style={isRetro ? { color: 'var(--retro-dim)' } : { color: 'rgb(148, 163, 184)' }}>
              {isRetro ? 'ARROWS / WASD • SPACE: PAUSE • R/ENTER: RESTART • ESC: CLOSE' : 'Arrows / WASD • Space: pause • R/Enter: restart • Esc: close'}
            </div>
          </div>

          <div className="text-right">
            <div className="text-sm font-mono" style={isRetro ? { color: 'var(--retro-numbers)' } : { color: 'rgb(34, 211, 238)' }}>
              {isRetro ? 'SCORE' : 'Score'}: {game.score}
            </div>
            <div className="text-xs mt-1" style={isRetro ? { color: 'var(--retro-dim)' } : { color: 'rgb(100, 116, 139)' }}>
              {statusLabel}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col items-center">
          <div
            className="rounded-md p-1"
            style={{
              width: 'min(90vw, 420px)',
              aspectRatio: '1 / 1',
              display: 'grid',
              gridTemplateColumns: `repeat(${game.cols}, 1fr)`,
              gridTemplateRows: `repeat(${game.rows}, 1fr)`,
              gap: 1,
              backgroundColor: boardBorderColor,
              position: 'relative'
            }}
          >
            {Array.from({ length: game.rows * game.cols }).map((_, i) => {
              const x = i % game.cols;
              const y = Math.floor(i / game.cols);
              const key = `${x},${y}`;

              let bg = boardCellBg;
              if (key === foodKey) bg = foodBg;
              if (snakeKeys.has(key)) bg = key === headKey ? snakeHeadBg : snakeBodyBg;

              return (
                <div
                  key={key}
                  style={{
                    width: '100%',
                    height: '100%',
                    backgroundColor: bg
                  }}
                />
              );
            })}

            {game.status === 'gameover' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: isRetro ? 'rgba(5,7,5,0.82)' : 'rgba(2,6,23,0.78)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 16,
                  textAlign: 'center'
                }}
              >
                <div>
                  <div className="text-lg font-semibold" style={isRetro ? { color: 'var(--retro-header)' } : { color: 'rgb(226, 232, 240)' }}>
                    {isRetro ? 'GAME OVER' : 'Game over'}
                  </div>
                  {gameOverMessage ? (
                    <div className="text-sm mt-1" style={isRetro ? { color: 'var(--retro-dim)' } : { color: 'rgb(148, 163, 184)' }}>
                      {gameOverMessage}
                    </div>
                  ) : null}
                  <div className="text-sm mt-2" style={isRetro ? { color: 'var(--retro-text)' } : { color: 'rgb(226, 232, 240)' }}>
                    {isRetro ? 'FINAL SCORE' : 'Final score'}: {game.score}
                  </div>
                  <button
                    className={`${buttonBase} mt-4 ${isRetro ? buttonRetro : buttonModern}`}
                    style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
                    onClick={handleRestart}
                  >
                    {isRetro ? 'RESTART' : 'Restart'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            <button
              className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
              style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
              onClick={handlePause}
              disabled={game.status === 'gameover'}
              title={isRetro ? 'SPACE' : 'Space'}
            >
              {pauseLabel}
            </button>
            <button
              className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
              style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
              onClick={handleRestart}
              title={isRetro ? 'R / ENTER' : 'R / Enter'}
            >
              {isRetro ? 'RESTART' : 'Restart'}
            </button>
            <button
              className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
              style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
              onClick={onClose}
              title={isRetro ? 'ESC' : 'Esc'}
            >
              {isRetro ? 'CLOSE' : 'Close'}
            </button>
          </div>

          {/* Touch controls: show on small screens */}
          <div className="mt-4 md:hidden w-full flex justify-center">
            <div className="grid grid-cols-3 gap-2 w-56">
              <div />
              <button
                className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
                style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
                onClick={() => handleDir('UP')}
                disabled={game.status === 'gameover'}
              >
                Up
              </button>
              <div />

              <button
                className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
                style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
                onClick={() => handleDir('LEFT')}
                disabled={game.status === 'gameover'}
              >
                Left
              </button>
              <button
                className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
                style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
                onClick={handlePause}
                disabled={game.status === 'gameover'}
              >
                {game.status === 'paused' ? 'Start' : 'Pause'}
              </button>
              <button
                className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
                style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
                onClick={() => handleDir('RIGHT')}
                disabled={game.status === 'gameover'}
              >
                Right
              </button>

              <div />
              <button
                className={`${buttonBase} ${isRetro ? buttonRetro : buttonModern}`}
                style={isRetro ? { borderColor: 'var(--retro-dim)', color: 'var(--retro-text)', background: 'transparent' } : {}}
                onClick={() => handleDir('DOWN')}
                disabled={game.status === 'gameover'}
              >
                Down
              </button>
              <div />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
