// Classic Snake core logic: deterministic + testable (no DOM, no timers).

export const DIRECTIONS = Object.freeze({
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 }
});

const OPPOSITE = Object.freeze({
  UP: 'DOWN',
  DOWN: 'UP',
  LEFT: 'RIGHT',
  RIGHT: 'LEFT'
});

export function createRng(seed) {
  // Mulberry32 PRNG. Deterministic, fast, good enough for a mini-game.
  // Returns a float in [0, 1).
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pointKey(p) {
  return `${p.x},${p.y}`;
}

export function pointsEqual(a, b) {
  return a?.x === b?.x && a?.y === b?.y;
}

export function isOppositeDirection(a, b) {
  return OPPOSITE[a] === b;
}

export function placeFood({ rows, cols, snake }, rng) {
  const occupied = new Set(snake.map(pointKey));
  const empties = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const key = `${x},${y}`;
      if (!occupied.has(key)) empties.push({ x, y });
    }
  }

  if (empties.length === 0) return null;
  const idx = Math.floor(rng() * empties.length);
  return empties[idx];
}

export function createInitialState({
  rows = 20,
  cols = 20,
  rng = Math.random,
  initialLength = 3
} = {}) {
  const midX = Math.floor(cols / 2);
  const midY = Math.floor(rows / 2);

  // Head first. Default direction RIGHT, body extends LEFT.
  const snake = [];
  for (let i = 0; i < initialLength; i++) {
    snake.push({ x: midX - i, y: midY });
  }

  const base = {
    rows,
    cols,
    snake,
    direction: 'RIGHT',
    queuedDirection: null,
    food: null,
    score: 0,
    status: 'playing', // 'playing' | 'paused' | 'gameover'
    gameOverReason: null // 'wall' | 'self' | 'win' | null
  };

  return { ...base, food: placeFood(base, rng) };
}

export function queueTurn(state, requestedDirection) {
  if (!DIRECTIONS[requestedDirection]) return state;
  if (state.status === 'gameover') return state;

  const baseDirection = state.queuedDirection || state.direction;
  if (requestedDirection === baseDirection) return state;

  // Disallow reversing when length > 1. If length==1, reversal is harmless.
  if (state.snake.length > 1 && isOppositeDirection(baseDirection, requestedDirection)) {
    return state;
  }

  return { ...state, queuedDirection: requestedDirection };
}

export function togglePause(state) {
  if (state.status === 'gameover') return state;
  return { ...state, status: state.status === 'paused' ? 'playing' : 'paused' };
}

export function tick(state, rng = Math.random) {
  if (state.status !== 'playing') return state;

  const direction = state.queuedDirection || state.direction;
  const vec = DIRECTIONS[direction];
  const head = state.snake[0];
  const nextHead = { x: head.x + vec.x, y: head.y + vec.y };

  // Wall collision.
  if (
    nextHead.x < 0 ||
    nextHead.x >= state.cols ||
    nextHead.y < 0 ||
    nextHead.y >= state.rows
  ) {
    return {
      ...state,
      status: 'gameover',
      queuedDirection: null,
      direction,
      gameOverReason: 'wall'
    };
  }

  const willEat = state.food && pointsEqual(nextHead, state.food);
  const nextSnake = willEat
    ? [nextHead, ...state.snake]
    : [nextHead, ...state.snake.slice(0, -1)];

  // Self collision (note: moving into the previous tail is allowed when not eating,
  // because the tail segment is removed above).
  for (let i = 1; i < nextSnake.length; i++) {
    if (pointsEqual(nextSnake[i], nextHead)) {
      return {
        ...state,
        snake: nextSnake,
        status: 'gameover',
        queuedDirection: null,
        direction,
        gameOverReason: 'self'
      };
    }
  }

  let food = state.food;
  let score = state.score;
  let status = state.status;
  let gameOverReason = null;

  if (willEat) {
    score += 1;
    food = placeFood({ rows: state.rows, cols: state.cols, snake: nextSnake }, rng);
    if (!food) {
      // Filled the board: treat as a win.
      status = 'gameover';
      gameOverReason = 'win';
    }
  }

  return {
    ...state,
    snake: nextSnake,
    direction,
    queuedDirection: null,
    food,
    score,
    status,
    gameOverReason
  };
}

export function restart(state, rng = Math.random) {
  return createInitialState({ rows: state.rows, cols: state.cols, rng });
}

