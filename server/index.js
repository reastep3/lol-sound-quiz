// ============================================
//  LoL Sound Quiz – Multiplayer WebSocket Server
// ============================================
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const QUESTION_TIME = 15;          // seconds per question
const REVEAL_PAUSE  = 4;           // seconds to show reveal before next Q
const LOBBY_TTL     = 60 * 60_000; // auto-delete lobbies after 1 hour

// ---- Sound Pool (must match client) -----------------------------------------
const SOUND_POOL = [
  { champion:'Ahri', key:'Q', name:'Orb of Deception' },
  { champion:'Ahri', key:'E', name:'Charm' },
  { champion:'Ahri', key:'R', name:'Spirit Rush' },
  { champion:'Akali', key:'Q', name:'Five Point Strike' },
  { champion:'Akali', key:'E', name:'Shuriken Flip' },
  { champion:'Akali', key:'R', name:'Perfect Execution' },
  { champion:'Aatrox', key:'Q', name:'The Darkin Blade' },
  { champion:'Aatrox', key:'R', name:'World Ender' },
  { champion:'Annie', key:'Q', name:'Disintegrate' },
  { champion:'Annie', key:'R', name:'Summon: Tibbers' },
  { champion:'Ashe', key:'W', name:'Volley' },
  { champion:'Ashe', key:'R', name:'Enchanted Crystal Arrow' },
  { champion:'Bard', key:'Q', name:'Cosmic Binding' },
  { champion:'Bard', key:'R', name:'Tempered Fate' },
  { champion:'Blitzcrank', key:'Q', name:'Rocket Grab' },
  { champion:'Blitzcrank', key:'R', name:'Static Field' },
  { champion:'Brand', key:'W', name:'Pillar of Flame' },
  { champion:'Brand', key:'R', name:'Pyroclasm' },
  { champion:'Caitlyn', key:'Q', name:'Piltover Peacemaker' },
  { champion:'Caitlyn', key:'R', name:'Ace in the Hole' },
  { champion:'Darius', key:'Q', name:'Decimate' },
  { champion:'Darius', key:'R', name:'Noxian Guillotine' },
  { champion:'Draven', key:'Q', name:'Spinning Axe' },
  { champion:'Draven', key:'R', name:'Whirling Death' },
  { champion:'Ekko', key:'Q', name:'Timewinder' },
  { champion:'Ekko', key:'W', name:'Parallel Convergence' },
  { champion:'Ekko', key:'R', name:'Chronobreak' },
  { champion:'Ezreal', key:'Q', name:'Mystic Shot' },
  { champion:'Ezreal', key:'R', name:'Trueshot Barrage' },
  { champion:'Fiora', key:'W', name:'Riposte' },
  { champion:'Fiora', key:'R', name:'Grand Challenge' },
  { champion:'Fizz', key:'E', name:'Playful / Trickster' },
  { champion:'Fizz', key:'R', name:'Chum the Waters' },
  { champion:'Garen', key:'Q', name:'Decisive Strike' },
  { champion:'Garen', key:'E', name:'Judgment' },
  { champion:'Garen', key:'R', name:'Demacian Justice' },
  { champion:'Irelia', key:'Q', name:'Bladesurge' },
  { champion:'Irelia', key:'R', name:"Vanguard's Edge" },
  { champion:'Jhin', key:'Passive', name:'Whisper' },
  { champion:'Jhin', key:'W', name:'Deadly Flourish' },
  { champion:'Jhin', key:'R', name:'Curtain Call' },
  { champion:'Jinx', key:'W', name:'Zap!' },
  { champion:'Jinx', key:'E', name:'Flame Chompers!' },
  { champion:'Jinx', key:'R', name:'Super Mega Death Rocket!' },
  { champion:'Katarina', key:'E', name:'Shunpo' },
  { champion:'Katarina', key:'R', name:'Death Lotus' },
  { champion:'Kayn', key:'Q', name:'Reaping Slash' },
  { champion:'Kayn', key:'R', name:'Umbral Trespass' },
  { champion:'Lee Sin', key:'Q', name:'Sonic Wave' },
  { champion:'Lee Sin', key:'R', name:"Dragon's Rage" },
  { champion:'Leona', key:'E', name:'Zenith Blade' },
  { champion:'Leona', key:'R', name:'Solar Flare' },
  { champion:'Lucian', key:'Q', name:'Piercing Light' },
  { champion:'Lucian', key:'R', name:'The Culling' },
  { champion:'Lux', key:'Q', name:'Light Binding' },
  { champion:'Lux', key:'E', name:'Lucent Singularity' },
  { champion:'Lux', key:'R', name:'Final Spark' },
  { champion:'Malzahar', key:'R', name:'Nether Grasp' },
  { champion:'Malzahar', key:'Q', name:'Call of the Void' },
  { champion:'Miss Fortune', key:'Q', name:'Double Up' },
  { champion:'Miss Fortune', key:'R', name:'Bullet Time' },
  { champion:'Mordekaiser', key:'Q', name:'Obliterate' },
  { champion:'Mordekaiser', key:'R', name:'Realm of Death' },
  { champion:'Morgana', key:'Q', name:'Dark Binding' },
  { champion:'Morgana', key:'R', name:'Soul Shackles' },
  { champion:'Orianna', key:'Q', name:'Command: Attack' },
  { champion:'Orianna', key:'R', name:'Command: Shockwave' },
  { champion:'Pyke', key:'Q', name:'Bone Skewer' },
  { champion:'Pyke', key:'R', name:'Death from Below' },
  { champion:'Rengar', key:'R', name:'Thrill of the Hunt' },
  { champion:'Rengar', key:'Q', name:'Savagery' },
  { champion:'Riven', key:'Q', name:'Broken Wings' },
  { champion:'Riven', key:'W', name:'Ki Burst' },
  { champion:'Riven', key:'R', name:'Blade of the Exile' },
  { champion:'Senna', key:'Q', name:'Piercing Darkness' },
  { champion:'Senna', key:'R', name:'Dawning Shadow' },
  { champion:'Sett', key:'W', name:'Haymaker' },
  { champion:'Sett', key:'R', name:'The Show Stopper' },
  { champion:'Soraka', key:'Q', name:'Starcall' },
  { champion:'Soraka', key:'R', name:'Wish' },
  { champion:'Syndra', key:'Q', name:'Dark Sphere' },
  { champion:'Syndra', key:'R', name:'Unleashed Power' },
  { champion:'Teemo', key:'Q', name:'Blinding Dart' },
  { champion:'Teemo', key:'R', name:'Noxious Trap' },
  { champion:'Thresh', key:'Q', name:'Death Sentence' },
  { champion:'Thresh', key:'W', name:'Dark Passage' },
  { champion:'Thresh', key:'R', name:'The Box' },
  { champion:'Twisted Fate', key:'W', name:'Pick a Card' },
  { champion:'Twisted Fate', key:'R', name:'Destiny' },
  { champion:'Vayne', key:'Q', name:'Tumble' },
  { champion:'Vayne', key:'E', name:'Condemn' },
  { champion:'Vayne', key:'R', name:'Final Hour' },
  { champion:'Veigar', key:'E', name:'Event Horizon' },
  { champion:'Veigar', key:'R', name:'Primordial Burst' },
  { champion:'Vi', key:'Q', name:'Vault Breaker' },
  { champion:'Vi', key:'R', name:'Assault and Battery' },
  { champion:'Viego', key:'R', name:'Heartbreaker' },
  { champion:'Viego', key:'Q', name:'Blade of the Ruined King' },
  { champion:'Viktor', key:'E', name:'Death Ray' },
  { champion:'Viktor', key:'R', name:'Chaos Storm' },
  { champion:'Yasuo', key:'Q', name:'Steel Tempest' },
  { champion:'Yasuo', key:'W', name:'Wind Wall' },
  { champion:'Yasuo', key:'R', name:'Last Breath' },
  { champion:'Yone', key:'Q', name:'Mortal Steel' },
  { champion:'Yone', key:'E', name:'Soul Unbound' },
  { champion:'Yone', key:'R', name:'Fate Sealed' },
  { champion:'Zed', key:'Q', name:'Razor Shuriken' },
  { champion:'Zed', key:'W', name:'Living Shadow' },
  { champion:'Zed', key:'R', name:'Death Mark' },
  { champion:'Zoe', key:'Q', name:'Paddle Star' },
  { champion:'Zoe', key:'E', name:'Sleepy Trouble Bubble' },
  { champion:'Yuumi', key:'Q', name:'Prowling Projectile' },
  { champion:'Yuumi', key:'R', name:'Final Chapter' },
];

// ---- Helpers ----------------------------------------------------------------

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---- Lobby State ------------------------------------------------------------

const lobbies = new Map();  // code → Lobby

const leaderboard = [];
const MAX_LEADERBOARD = 100;

function addToLeaderboard(entry) {
  leaderboard.push({
    name: (entry.name || 'Anonymous').slice(0, 16),
    score: entry.score,
    maxScore: entry.maxScore,
    questions: entry.questions,
    mode: entry.mode || 'solo',
    date: Date.now(),
  });
  leaderboard.sort((a, b) => b.score - a.score);
  if (leaderboard.length > MAX_LEADERBOARD) leaderboard.length = MAX_LEADERBOARD;
}

class Lobby {
  constructor(code, host) {
    this.code = code;
    this.players = new Map();  // id → { id, name, ws, score, answered }
    this.hostId = host.id;
    this.state = 'waiting';    // waiting | playing | reveal | finished
    this.questions = [];
    this.questionIndex = -1;
    this.questionCount = 10;
    this.timer = null;
    this.timeLeft = 0;
    this.createdAt = Date.now();
    this.addPlayer(host);
  }

  addPlayer(p) {
    this.players.set(p.id, { id: p.id, name: p.name, ws: p.ws, score: 0, answered: false });
  }

  removePlayer(id) {
    this.players.delete(id);
    if (id === this.hostId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value; // promote next player
    }
  }

  broadcast(msg) {
    for (const p of this.players.values()) send(p.ws, msg);
  }

  playerList() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, isHost: p.id === this.hostId,
    }));
  }

  startGame() {
    this.questions = shuffle(SOUND_POOL).slice(0, this.questionCount);
    this.questionIndex = -1;
    this.state = 'playing';
    for (const p of this.players.values()) { p.score = 0; p.answered = false; }
    this.broadcast({ type: 'game_start', totalQuestions: this.questions.length });
    this.nextQuestion();
  }

  nextQuestion() {
    this.questionIndex++;
    if (this.questionIndex >= this.questions.length) {
      this.endGame();
      return;
    }
    const q = this.questions[this.questionIndex];
    for (const p of this.players.values()) p.answered = false;
    this.state = 'playing';
    this.timeLeft = QUESTION_TIME;

    this.broadcast({
      type: 'question',
      index: this.questionIndex,
      total: this.questions.length,
      champion: q.champion,
      abilityKey: q.key,
      abilityName: q.name,
    });

    // Start countdown
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.timeLeft--;
      this.broadcast({ type: 'tick', timeLeft: this.timeLeft });
      if (this.timeLeft <= 0) {
        clearInterval(this.timer);
        this.revealAnswer();
      }
    }, 1000);
  }

  submitAnswer(playerId, champion, ability) {
    const p = this.players.get(playerId);
    if (!p || p.answered || this.state !== 'playing') return;

    const q = this.questions[this.questionIndex];
    const champCorrect = champion.trim().toLowerCase() === q.champion.toLowerCase();
    const keyCorrect = ability === q.key;
    let points = 0;
    let result = 'wrong';
    if (champCorrect && keyCorrect)  { points = Math.round(100 + 900 * (this.timeLeft / QUESTION_TIME)); result = 'correct'; }
    else if (champCorrect)           { points = Math.round(50 + 450 * (this.timeLeft / QUESTION_TIME)); result = 'partial'; }

    p.score += points;
    p.answered = true;
    p.lastResult = { champion, ability, points, result };

    // Notify all that someone answered (no spoilers)
    this.broadcast({ type: 'player_answered', playerId: p.id, name: p.name, answered: this.answeredCount() });

    if (this.allAnswered()) {
      clearInterval(this.timer);
      this.revealAnswer();
    }
  }

  skipAnswer(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.answered || this.state !== 'playing') return;
    p.answered = true;
    p.lastResult = { champion: '', ability: '', points: 0, result: 'skipped' };
    this.broadcast({ type: 'player_answered', playerId: p.id, name: p.name, answered: this.answeredCount() });
    if (this.allAnswered()) {
      clearInterval(this.timer);
      this.revealAnswer();
    }
  }

  answeredCount() {
    let c = 0;
    for (const p of this.players.values()) if (p.answered) c++;
    return c;
  }

  allAnswered() {
    for (const p of this.players.values()) if (!p.answered) return false;
    return true;
  }

  revealAnswer() {
    this.state = 'reveal';
    const q = this.questions[this.questionIndex];
    const results = [...this.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      ...(p.lastResult || { champion: '', ability: '', points: 0, result: 'skipped' }),
    }));

    const scoreboard = [...this.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    this.broadcast({
      type: 'reveal',
      champion: q.champion,
      abilityKey: q.key,
      abilityName: q.name,
      results,
      scoreboard,
      questionIndex: this.questionIndex,
      totalQuestions: this.questions.length,
    });

    // Auto-advance after pause
    setTimeout(() => {
      if (this.state === 'reveal') this.nextQuestion();
    }, REVEAL_PAUSE * 1000);
  }

  endGame() {
    this.state = 'finished';
    clearInterval(this.timer);
    const scoreboard = [...this.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ ...p, rank: i + 1 }));

    this.broadcast({ type: 'game_over', scoreboard, maxScore: this.questions.length * 1000 });

    for (const p of this.players.values()) {
      addToLeaderboard({
        name: p.name,
        score: p.score,
        maxScore: this.questions.length * 1000,
        questions: this.questions.length,
        mode: 'multiplayer',
      });
    }
  }

  cleanup() {
    clearInterval(this.timer);
  }
}

// ---- HTTP server (health check for Render) ----------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const httpServer = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lobbies: lobbies.size }));
  } else if (req.url === '/api/leaderboard' && req.method === 'GET') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(leaderboard.slice(0, 50)));
  } else if (req.url === '/api/score' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (typeof data.score !== 'number' || typeof data.maxScore !== 'number' || typeof data.questions !== 'number') {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload: score, maxScore, and questions are required numbers' }));
          return;
        }
        addToLeaderboard(data);
        const rank = leaderboard.findIndex(e => e.score === data.score && e.name === (data.name || 'Anonymous').slice(0, 16)) + 1;
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rank }));
      } catch (e) {
        res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('LoL Sound Quiz WebSocket Server');
  }
});

// ---- WebSocket server -------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

// Map ws → { playerId, lobbyCode }
const connections = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        let code;
        do { code = genCode(); } while (lobbies.has(code));
        const playerId = genId();
        const lobby = new Lobby(code, { id: playerId, name: msg.name || 'Player', ws });
        lobbies.set(code, lobby);
        connections.set(ws, { playerId, lobbyCode: code });
        if (msg.questionCount) lobby.questionCount = Math.min(Math.max(msg.questionCount, 5), 20);
        send(ws, { type: 'lobby', code, playerId, isHost: true, players: lobby.playerList() });
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase();
        const lobby = lobbies.get(code);
        if (!lobby) { send(ws, { type: 'error', message: 'Lobby not found' }); break; }
        if (lobby.state !== 'waiting') { send(ws, { type: 'error', message: 'Game already in progress' }); break; }
        if (lobby.players.size >= 8) { send(ws, { type: 'error', message: 'Lobby is full' }); break; }
        const playerId = genId();
        lobby.addPlayer({ id: playerId, name: msg.name || 'Player', ws });
        connections.set(ws, { playerId, lobbyCode: code });
        const players = lobby.playerList();
        send(ws, { type: 'lobby', code, playerId, isHost: false, players });
        lobby.broadcast({ type: 'player_update', players });
        break;
      }

      case 'start': {
        const conn = connections.get(ws);
        if (!conn) break;
        const lobby = lobbies.get(conn.lobbyCode);
        if (!lobby || conn.playerId !== lobby.hostId) break;
        if (lobby.players.size < 2) { send(ws, { type: 'error', message: 'Need at least 2 players' }); break; }
        lobby.startGame();
        break;
      }

      case 'answer': {
        const conn = connections.get(ws);
        if (!conn) break;
        const lobby = lobbies.get(conn.lobbyCode);
        if (!lobby) break;
        lobby.submitAnswer(conn.playerId, msg.champion || '', msg.ability || '');
        break;
      }

      case 'skip': {
        const conn = connections.get(ws);
        if (!conn) break;
        const lobby = lobbies.get(conn.lobbyCode);
        if (!lobby) break;
        lobby.skipAnswer(conn.playerId);
        break;
      }

      case 'play_again': {
        const conn = connections.get(ws);
        if (!conn) break;
        const lobby = lobbies.get(conn.lobbyCode);
        if (!lobby || conn.playerId !== lobby.hostId) break;
        lobby.state = 'waiting';
        for (const p of lobby.players.values()) { p.score = 0; p.answered = false; }
        lobby.broadcast({ type: 'back_to_lobby', players: lobby.playerList() });
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const conn = connections.get(ws);
    if (conn) {
      const lobby = lobbies.get(conn.lobbyCode);
      if (lobby) {
        lobby.removePlayer(conn.playerId);
        if (lobby.players.size === 0) {
          lobby.cleanup();
          lobbies.delete(conn.lobbyCode);
        } else {
          lobby.broadcast({ type: 'player_update', players: lobby.playerList() });
        }
      }
      connections.delete(ws);
    }
  });
});

// ---- Cleanup stale lobbies --------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [code, lobby] of lobbies) {
    if (now - lobby.createdAt > LOBBY_TTL) {
      lobby.cleanup();
      lobby.broadcast({ type: 'error', message: 'Lobby expired' });
      lobbies.delete(code);
    }
  }
}, 60_000);

// ---- Start ------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`LoL Sound Quiz server listening on port ${PORT}`);
});
