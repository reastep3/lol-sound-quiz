// ============================================================================
//  LoL Sound Quiz – multiplayer + leaderboard server
//
//  The server owns the game: it picks the questions, checks that each sound
//  clip really exists on Riot's CDN, keeps the clock and does the scoring.
//  Clients only ever send "this champion, this ability".
//
//  Nothing about the champion roster is hard-coded. It is read from Riot's
//  Data Dragon, so new champions show up without a code change.
// ============================================================================
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const PROTOCOL = 2;

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const CLIP_BASE = 'https://lol.dyn.riotcdn.net/x/videos/champion-abilities';
// Mirror of the game client's data files; tells us which abilities the client
// currently has a preview clip for.
const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1';

export const POOLS = {
  ult: ['R'],
  basic: ['Q', 'W', 'E', 'R'],
  all: ['P', 'Q', 'W', 'E', 'R'],
};
export const QUESTION_COUNTS = [5, 10, 20];
const SLOTS = ['P', 'Q', 'W', 'E', 'R'];

const DEFAULTS = {
  questionTime: 20,                  // seconds to answer once the sound starts
  revealPause: 6,                    // seconds the answer stays on screen
  loadGrace: 12,                     // longest we wait for players to load a clip
  prepareTimeout: 20,                // longest we spend building a question list
  minPlayers: 2,
  maxPlayers: 8,
  spareQuestions: 4,                 // extra clips, swapped in if one won't play
  maxClipBytes: 12 * 1024 * 1024,    // skip the handful of very large clips
  rosterTtl: 6 * 60 * 60_000,        // re-read the champion list every 6 hours
  lobbyIdleTtl: 60 * 60_000,         // drop lobbies nobody has touched for an hour
  scorePostsPerMinute: 6,
};

// ---- Small helpers ----------------------------------------------------------

export function clipUrl(championKey, slot) {
  const id = String(championKey).padStart(4, '0');
  return `${CLIP_BASE}/${id}/ability_${id}_${slot}1.webm`;
}

export function scoreAnswer({ championCorrect, abilityCorrect, timeFraction }) {
  const f = Math.min(1, Math.max(0, timeFraction));
  if (championCorrect && abilityCorrect) return { result: 'correct', points: Math.round(100 + 900 * f) };
  if (championCorrect) return { result: 'partial', points: Math.round(50 + 450 * f) };
  return { result: 'wrong', points: 0 };
}

export function cleanName(raw) {
  const name = String(typeof raw === 'string' ? raw : '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name || 'Player';
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---- Champion roster (Data Dragon) ------------------------------------------

export class Roster {
  constructor({ fetchImpl, ttl, maxClipBytes }) {
    this.fetch = fetchImpl;
    this.ttl = ttl;
    this.maxClipBytes = maxClipBytes;
    this.version = null;
    this.champions = [];        // [{ id, key, name }]
    this.loadedAt = 0;
    this.loading = null;
    this.abilityCache = new Map();  // champion id -> Promise<{P,Q,W,E,R}>
    this.clipCache = new Map();     // "key:slot" -> { ok, at }
    this.listedCache = new Map();   // champion key -> { slots: Set|null, at }
  }

  async json(url) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }

  // Loads the roster if we have none or it is stale. A failed refresh keeps
  // the roster we already have; it only throws when there is nothing at all.
  async ensure() {
    if (this.champions.length && Date.now() - this.loadedAt < this.ttl) return;
    if (!this.loading) this.loading = this.load().finally(() => { this.loading = null; });
    try {
      await this.loading;
    } catch (err) {
      if (!this.champions.length) throw err;
    }
  }

  async load() {
    const versions = await this.json(`${DDRAGON}/api/versions.json`);
    const version = versions[0];
    const data = await this.json(`${DDRAGON}/cdn/${version}/data/en_US/champion.json`);
    const champions = Object.values(data.data || {}).map((c) => ({
      id: c.id, key: String(c.key), name: c.name,
    }));
    if (!champions.length) throw new Error('Data Dragon returned an empty roster');
    if (version !== this.version) this.abilityCache.clear();
    this.version = version;
    this.champions = champions;
    this.loadedAt = Date.now();
  }

  abilities(champ) {
    const hit = this.abilityCache.get(champ.id);
    if (hit) return hit;
    const p = this.json(`${DDRAGON}/cdn/${this.version}/data/en_US/champion/${champ.id}.json`)
      .then((j) => {
        const d = j.data[champ.id];
        const out = { P: d.passive?.name || null };
        ['Q', 'W', 'E', 'R'].forEach((slot, i) => { out[slot] = d.spells?.[i]?.name || null; });
        return out;
      });
    this.abilityCache.set(champ.id, p);
    p.catch(() => this.abilityCache.delete(champ.id));
    return p;
  }

  // Slots the game client currently lists a preview clip for. Riot's CDN
  // still serves leftover clips for a few reworked abilities; this is how we
  // avoid asking about a sound that no longer matches. null = mirror
  // unreachable, in which case we fall back to "whatever the CDN has".
  async listedSlots(champ) {
    const hit = this.listedCache.get(champ.key);
    if (hit && Date.now() - hit.at < (hit.slots ? 6 * 60 * 60_000 : 5 * 60_000)) return hit.slots;
    let slots = null;
    try {
      const json = await this.json(`${CDRAGON}/champions/${champ.key}.json`);
      slots = new Set();
      if (json.passive?.abilityVideoPath) slots.add('P');
      for (const spell of json.spells || []) {
        if (spell.abilityVideoPath && spell.spellKey) slots.add(String(spell.spellKey).toUpperCase());
      }
    } catch { /* leave as unknown */ }
    this.listedCache.set(champ.key, { slots, at: Date.now() });
    return slots;
  }

  // Is this a current clip that Riot's CDN really has, at a size worth downloading?
  async clipOk(champ, slot) {
    const key = `${champ.key}:${slot}`;
    const hit = this.clipCache.get(key);
    if (hit && Date.now() - hit.at < 24 * 60 * 60_000) return hit.ok;
    const listed = await this.listedSlots(champ);
    if (listed && !listed.has(slot)) {
      this.clipCache.set(key, { ok: false, at: Date.now() });
      return false;
    }
    try {
      const res = await this.fetch(clipUrl(champ.key, slot), {
        method: 'HEAD', signal: AbortSignal.timeout(6000),
      });
      const len = Number(res.headers.get('content-length')) || 0;
      const ok = res.ok && len > 0 && len <= this.maxClipBytes;
      this.clipCache.set(key, { ok, at: Date.now() });
      return ok;
    } catch {
      return false; // network hiccup: say no for now, but don't remember it
    }
  }

  // One question per champion, so a game never repeats a champion.
  async buildQuestions(count, pool) {
    await this.ensure();
    const slots = POOLS[pool] || POOLS.basic;
    const candidates = shuffle(this.champions);
    const out = [];
    for (let i = 0; i < candidates.length && out.length < count; i += count) {
      const batch = candidates.slice(i, i + count);
      const tried = await Promise.all(batch.map(async (champ) => {
        const slot = slots[Math.floor(Math.random() * slots.length)];
        try {
          const [ok, names] = await Promise.all([this.clipOk(champ, slot), this.abilities(champ)]);
          if (!ok || !names[slot]) return null;
          return {
            championId: champ.id, championKey: champ.key, championName: champ.name,
            slot, abilityName: names[slot],
          };
        } catch {
          return null;
        }
      }));
      out.push(...tried.filter(Boolean));
    }
    return out.slice(0, count);
  }
}

// ---- Leaderboard ------------------------------------------------------------
// Kept in memory only. On a free host that sleeps when idle this resets on
// every wake-up; the client says so and also keeps personal bests locally.

export class Leaderboard {
  constructor(perCategory = 100) {
    this.perCategory = perCategory;
    this.entries = [];
  }

  // Returns the stored entry, or null when the payload is not a believable score.
  add(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const questions = Number(raw.questions);
    const score = Number(raw.score);
    if (!QUESTION_COUNTS.includes(questions)) return null;
    if (!Number.isInteger(score) || score < 0 || score > questions * 1000) return null;
    const entry = {
      name: cleanName(raw.name),
      score,
      maxScore: questions * 1000,
      questions,
      pool: Object.hasOwn(POOLS, raw.pool) ? raw.pool : 'basic',
      mode: raw.mode === 'multiplayer' ? 'multiplayer' : 'solo',
      date: Date.now(),
    };
    this.entries.push(entry);
    this.entries.sort((a, b) => b.score - a.score || a.date - b.date);
    // Trim each question-count category separately so one can't crowd out another.
    const seen = {};
    this.entries = this.entries.filter((e) => {
      seen[e.questions] = (seen[e.questions] || 0) + 1;
      return seen[e.questions] <= this.perCategory;
    });
    return this.entries.includes(entry) ? entry : null;
  }

  top(questions, limit = 50) {
    const list = QUESTION_COUNTS.includes(questions)
      ? this.entries.filter((e) => e.questions === questions)
      : this.entries;
    return list.slice(0, limit);
  }

  rankOf(entry) {
    return this.entries.filter((e) => e.questions === entry.questions).indexOf(entry) + 1;
  }
}

// ---- Lobby ------------------------------------------------------------------

class Lobby {
  constructor(app, code, settings) {
    this.app = app;
    this.code = code;
    this.settings = settings;        // { questionCount, pool }
    this.players = new Map();        // id -> player
    this.hostId = null;
    this.state = 'waiting';          // waiting | preparing | loading | playing | reveal | finished
    this.questions = [];
    this.spares = [];
    this.swaps = 0;
    this.index = -1;
    this.timer = null;
    this.deadline = 0;
    this.lastActivity = Date.now();
    this.closed = false;
  }

  get cfg() { return this.app.cfg; }

  touch() { this.lastActivity = Date.now(); }

  setTimer(fn, seconds) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.closed) fn(); }, seconds * 1000);
  }

  broadcast(msg) {
    for (const p of this.players.values()) this.app.send(p.ws, msg);
  }

  uniqueName(name) {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 20; n++) {
      const candidate = `${name.slice(0, 13)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  addPlayer(id, name, ws) {
    const player = {
      id, name: this.uniqueName(name), ws, score: 0, answered: false, ready: false, clipOk: true, last: null,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.touch();
    return player;
  }

  removePlayer(id) {
    if (!this.players.delete(id)) return;
    if (this.players.size === 0) { this.app.closeLobby(this); return; }
    if (id === this.hostId) this.hostId = this.players.keys().next().value;
    this.broadcast({ type: 'player_update', players: this.playerList() });
    // Someone leaving must never leave the rest waiting on them.
    if (this.state === 'loading' && this.allReady()) this.afterLoading();
    else if (this.state === 'playing' && this.allAnswered()) this.reveal();
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, isHost: p.id === this.hostId,
    }));
  }

  scoreboard() {
    const sorted = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    // Equal scores share a rank.
    sorted.forEach((p, i) => { p.rank = i > 0 && sorted[i - 1].score === p.score ? sorted[i - 1].rank : i + 1; });
    return sorted;
  }

  allReady() { return [...this.players.values()].every((p) => p.ready); }
  allAnswered() { return [...this.players.values()].every((p) => p.answered); }
  answeredCount() { return [...this.players.values()].filter((p) => p.answered).length; }

  clipRef(q) { return q ? { key: q.championKey, slot: q.slot } : null; }

  async start() {
    if (this.state !== 'waiting') return;
    this.state = 'preparing';
    this.touch();
    this.broadcast({ type: 'preparing' });
    let questions = [];
    try {
      questions = await Promise.race([
        this.app.roster.buildQuestions(this.settings.questionCount + this.cfg.spareQuestions, this.settings.pool),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), this.cfg.prepareTimeout * 1000)),
      ]);
    } catch (err) {
      this.app.log('question build failed:', err.message);
    }
    if (this.closed || this.state !== 'preparing') return;
    if (!questions.length) {
      this.state = 'waiting';
      this.broadcast({ type: 'error', message: "Couldn't load champion data from Riot. Try again in a moment." });
      this.broadcast({ type: 'back_to_lobby', players: this.playerList() });
      return;
    }
    this.questions = questions.slice(0, this.settings.questionCount);
    this.spares = questions.slice(this.settings.questionCount);
    this.swaps = 0;
    for (const p of this.players.values()) p.score = 0;
    this.broadcast({
      type: 'game_start',
      total: this.questions.length,
      timeLimit: this.cfg.questionTime,
      pool: this.settings.pool,
    });
    this.sendQuestion(0);
  }

  // Phase 1: everyone downloads the clip. The clock does not run yet.
  sendQuestion(index) {
    this.index = index;
    this.state = 'loading';
    for (const p of this.players.values()) { p.answered = false; p.ready = false; p.clipOk = true; p.last = null; }
    this.broadcast({
      type: 'question',
      index,
      total: this.questions.length,
      clip: this.clipRef(this.questions[index]),
      timeLimit: this.cfg.questionTime,
    });
    this.setTimer(() => this.afterLoading(), this.cfg.loadGrace);
  }

  onReady(player, index, ok) {
    if (this.state !== 'loading' || index !== this.index) return;
    player.ready = true;
    player.clipOk = ok !== false;
    if (this.allReady()) this.afterLoading();
  }

  // Everyone has reported in (or we stopped waiting). The server can only
  // check that a clip exists; whether it holds real sound is only known once
  // a browser has decoded it. If most players say this one is unusable, swap
  // in a spare instead of asking a question nobody can hear.
  afterLoading() {
    if (this.state !== 'loading') return;
    const reported = [...this.players.values()].filter((p) => p.ready);
    const failed = reported.filter((p) => !p.clipOk);
    if (failed.length * 2 > reported.length && this.spares.length && this.swaps < 3) {
      const bad = this.questions[this.index];
      if (failed.length >= 2) {
        // Two independent reports: stop offering this clip to other lobbies too.
        this.app.roster.clipCache.set(`${bad.championKey}:${bad.slot}`, { ok: false, at: Date.now() });
      }
      this.questions[this.index] = this.spares.shift();
      this.swaps++;
      this.sendQuestion(this.index);
      return;
    }
    this.go();
  }

  // Phase 2: sound plays for everyone at once and the clock starts.
  go() {
    if (this.state !== 'loading') return;
    this.state = 'playing';
    this.deadline = Date.now() + this.cfg.questionTime * 1000;
    this.broadcast({ type: 'go', index: this.index, timeLimit: this.cfg.questionTime });
    this.setTimer(() => this.reveal(), this.cfg.questionTime + 0.5);
  }

  onAnswer(player, index, championId, ability) {
    if (this.state !== 'playing' || index !== this.index || player.answered) return;
    this.touch();
    const q = this.questions[this.index];
    const skipped = !championId;
    const timeFraction = (this.deadline - Date.now()) / (this.cfg.questionTime * 1000);
    const scored = skipped
      ? { result: 'skipped', points: 0 }
      : scoreAnswer({
        championCorrect: championId === q.championId,
        abilityCorrect: ability === q.slot,
        timeFraction,
      });
    player.answered = true;
    player.score += scored.points;
    player.last = { championId: skipped ? null : championId, ability: skipped ? null : ability, ...scored };
    this.broadcast({ type: 'player_answered', answered: this.answeredCount(), total: this.players.size });
    if (this.allAnswered()) this.reveal();
  }

  reveal() {
    if (this.state !== 'playing') return;
    this.state = 'reveal';
    const q = this.questions[this.index];
    const results = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.last || { championId: null, ability: null, result: 'timeout', points: 0 }),
    }));
    const next = this.questions[this.index + 1];
    this.broadcast({
      type: 'reveal',
      index: this.index,
      total: this.questions.length,
      answer: {
        championId: q.championId, championName: q.championName,
        slot: q.slot, abilityName: q.abilityName,
      },
      results,
      scoreboard: this.scoreboard(),
      next: this.clipRef(next),          // lets clients download the next clip early
      pause: this.cfg.revealPause,
    });
    this.setTimer(() => {
      if (this.index + 1 < this.questions.length) this.sendQuestion(this.index + 1);
      else this.finish();
    }, this.cfg.revealPause);
  }

  finish() {
    this.state = 'finished';
    clearTimeout(this.timer);
    const scoreboard = this.scoreboard();
    this.broadcast({ type: 'game_over', scoreboard, maxScore: this.questions.length * 1000 });
    for (const p of scoreboard) {
      this.app.leaderboard.add({
        name: p.name, score: p.score, questions: this.questions.length,
        pool: this.settings.pool, mode: 'multiplayer',
      });
    }
  }

  backToLobby() {
    if (this.state !== 'finished') return;
    this.state = 'waiting';
    this.touch();
    for (const p of this.players.values()) { p.score = 0; p.answered = false; p.ready = false; p.clipOk = true; p.last = null; }
    this.broadcast({ type: 'back_to_lobby', players: this.playerList() });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

// ---- App --------------------------------------------------------------------

export function createApp(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const app = {
    cfg,
    log: options.log || ((...args) => console.log('[lsq]', ...args)),
    lobbies: new Map(),          // code -> Lobby
    connections: new Map(),      // ws -> { playerId, lobbyCode }
    leaderboard: new Leaderboard(),
    roster: new Roster({
      fetchImpl: options.fetchImpl || ((...args) => fetch(...args)),
      ttl: cfg.rosterTtl,
      maxClipBytes: cfg.maxClipBytes,
    }),
    send(ws, msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    closeLobby(lobby) {
      lobby.close();
      app.lobbies.delete(lobby.code);
    },
  };

  // ---- HTTP: health check + leaderboard API ----
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const json = (res, status, body) => {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const postTimes = new Map(); // ip -> recent POST timestamps
  const allowPost = (ip) => {
    const now = Date.now();
    const recent = (postTimes.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= cfg.scorePostsPerMinute) { postTimes.set(ip, recent); return false; }
    recent.push(now);
    postTimes.set(ip, recent);
    return true;
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    if (url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok', protocol: PROTOCOL, lobbies: app.lobbies.size, patch: app.roster.version,
      });
    }

    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      return json(res, 200, app.leaderboard.top(Number(url.searchParams.get('questions'))));
    }

    if (url.pathname === '/api/score' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!allowPost(ip)) return json(res, 429, { error: 'Too many submissions. Try again in a minute.' });
      let body = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2048) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        let data;
        try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        const entry = app.leaderboard.add({ ...data, mode: 'solo' });
        if (!entry) return json(res, 400, { error: 'That score could not be accepted.' });
        return json(res, 200, { ok: true, rank: app.leaderboard.rankOf(entry) });
      });
      return undefined;
    }

    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('LoL Sound Quiz game server');
  });

  // ---- WebSocket: lobbies ----
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 2048 });

  const lobbyOf = (ws) => {
    const conn = app.connections.get(ws);
    if (!conn) return {};
    const lobby = app.lobbies.get(conn.lobbyCode);
    return { lobby, player: lobby?.players.get(conn.playerId) };
  };

  const leave = (ws) => {
    const conn = app.connections.get(ws);
    if (!conn) return;
    app.connections.delete(ws);
    app.lobbies.get(conn.lobbyCode)?.removePlayer(conn.playerId);
  };

  const handlers = {
    create(ws, msg) {
      if (msg.v !== PROTOCOL) return app.send(ws, { type: 'error', code: 'outdated', message: 'Please refresh the page to get the latest version.' });
      leave(ws);
      let code;
      do { code = genCode(); } while (app.lobbies.has(code));
      const lobby = new Lobby(app, code, {
        questionCount: QUESTION_COUNTS.includes(msg.questionCount) ? msg.questionCount : 10,
        pool: Object.hasOwn(POOLS, msg.pool) ? msg.pool : 'basic',
      });
      app.lobbies.set(code, lobby);
      const player = lobby.addPlayer(genId(), cleanName(msg.name), ws);
      app.connections.set(ws, { playerId: player.id, lobbyCode: code });
      return app.send(ws, {
        type: 'lobby', code, playerId: player.id, isHost: true,
        players: lobby.playerList(), settings: lobby.settings, maxPlayers: cfg.maxPlayers,
      });
    },

    join(ws, msg) {
      if (msg.v !== PROTOCOL) return app.send(ws, { type: 'error', code: 'outdated', message: 'Please refresh the page to get the latest version.' });
      const code = String(typeof msg.code === 'string' ? msg.code : '').toUpperCase().slice(0, 4);
      const lobby = app.lobbies.get(code);
      if (!lobby) return app.send(ws, { type: 'error', message: 'Lobby not found. Check the code.' });
      if (lobby.state !== 'waiting') return app.send(ws, { type: 'error', message: 'That game has already started.' });
      if (lobby.players.size >= cfg.maxPlayers) return app.send(ws, { type: 'error', message: 'That lobby is full.' });
      leave(ws);
      const player = lobby.addPlayer(genId(), cleanName(msg.name), ws);
      app.connections.set(ws, { playerId: player.id, lobbyCode: code });
      app.send(ws, {
        type: 'lobby', code, playerId: player.id, isHost: false,
        players: lobby.playerList(), settings: lobby.settings, maxPlayers: cfg.maxPlayers,
      });
      return lobby.broadcast({ type: 'player_update', players: lobby.playerList() });
    },

    start(ws) {
      const { lobby, player } = lobbyOf(ws);
      if (!lobby || !player || player.id !== lobby.hostId) return undefined;
      if (lobby.players.size < cfg.minPlayers) {
        return app.send(ws, { type: 'error', message: `Need at least ${cfg.minPlayers} players to start.` });
      }
      return lobby.start();
    },

    ready(ws, msg) {
      const { lobby, player } = lobbyOf(ws);
      if (lobby && player) lobby.onReady(player, msg.index, msg.ok);
    },

    answer(ws, msg) {
      const { lobby, player } = lobbyOf(ws);
      if (!lobby || !player) return;
      const championId = typeof msg.championId === 'string' ? msg.championId.slice(0, 32) : '';
      const ability = SLOTS.includes(msg.ability) ? msg.ability : '';
      lobby.onAnswer(player, msg.index, championId, ability);
    },

    skip(ws, msg) {
      const { lobby, player } = lobbyOf(ws);
      if (lobby && player) lobby.onAnswer(player, msg.index, '', '');
    },

    play_again(ws) {
      const { lobby, player } = lobbyOf(ws);
      if (lobby && player && player.id === lobby.hostId) lobby.backToLobby();
    },

    leave(ws) { leave(ws); },

    ping(ws) { app.send(ws, { type: 'pong' }); },
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.msgTimes = [];
    ws.on('pong', () => { ws.isAlive = true; });
    app.send(ws, { type: 'hello', protocol: PROTOCOL });

    ws.on('message', (raw) => {
      // Cheap flood guard: nobody legitimately sends 40 messages in 10 seconds.
      const now = Date.now();
      ws.msgTimes = ws.msgTimes.filter((t) => now - t < 10_000);
      ws.msgTimes.push(now);
      if (ws.msgTimes.length > 40) return ws.close(1008, 'Too many messages');

      let msg;
      try { msg = JSON.parse(raw); } catch { return undefined; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return undefined;
      if (!Object.hasOwn(handlers, msg.type)) return undefined;
      try {
        return handlers[msg.type](ws, msg);
      } catch (err) {
        app.log('handler error', msg.type, err);
        return undefined;
      }
    });

    ws.on('close', () => leave(ws));
    ws.on('error', () => {});
  });

  // Drop connections that stopped answering pings, and lobbies left idle.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
    const now = Date.now();
    for (const lobby of [...app.lobbies.values()]) {
      if (lobby.state === 'waiting' || lobby.state === 'finished') {
        if (now - lobby.lastActivity > cfg.lobbyIdleTtl) {
          lobby.broadcast({ type: 'error', code: 'expired', message: 'This lobby expired.' });
          app.closeLobby(lobby);
        }
      }
    }
    for (const [ip, times] of postTimes) {
      if (!times.some((t) => now - t < 60_000)) postTimes.delete(ip);
    }
  }, 30_000);
  sweep.unref?.();

  app.httpServer = httpServer;
  app.wss = wss;
  app.listen = (port, host) => new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      // Warm the roster so the first game starts quickly. Failure is fine: we retry on demand.
      app.roster.ensure().catch((err) => app.log('roster warm-up failed:', err.message));
      resolve(httpServer.address().port);
    });
  });
  app.close = () => new Promise((resolve) => {
    clearInterval(sweep);
    for (const lobby of app.lobbies.values()) lobby.close();
    app.lobbies.clear();
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => httpServer.close(() => resolve()));
  });

  return app;
}
