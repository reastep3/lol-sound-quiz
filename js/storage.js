// Settings and personal bests, kept in this browser only.

const KEY = 'lsq.save.v2';

const DEFAULTS = {
  volume: 0.8,
  name: '',
  options: { count: 10, pool: 'basic', timed: true },
  bests: {},     // "10|basic|timed" -> { score, maxScore, date }
  games: [],     // most recent first, capped
};

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return { ...DEFAULTS, ...raw, options: { ...DEFAULTS.options, ...(raw.options || {}) } };
    }
  } catch { /* corrupted or blocked storage: start fresh */ }
  return structuredClone(DEFAULTS);
}

let state = read();

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* private mode or quota: the game still works, it just won't remember */ }
}

export const categoryKey = ({ count, pool, timed }) => `${count}|${pool}|${timed ? 'timed' : 'untimed'}`;

export const save = {
  get volume() { return state.volume; },
  set volume(v) { state.volume = v; write(); },

  get name() { return state.name; },
  set name(v) { state.name = String(v).slice(0, 16); write(); },

  get options() { return { ...state.options }; },
  set options(v) { state.options = { ...state.options, ...v }; write(); },

  best(options) {
    return state.bests[categoryKey(options)] || null;
  },

  get games() { return [...state.games]; },

  // Records a finished solo game. Returns true when it is a new personal best.
  recordGame(options, score, maxScore, correct) {
    const key = categoryKey(options);
    const entry = { ...options, score, maxScore, correct, date: Date.now() };
    state.games = [entry, ...state.games].slice(0, 30);
    const previous = state.bests[key];
    const isBest = !previous || score > previous.score;
    if (isBest) state.bests[key] = { score, maxScore, date: entry.date };
    write();
    return isBest && score > 0;
  },
};
