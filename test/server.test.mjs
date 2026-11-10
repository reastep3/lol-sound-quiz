// End-to-end tests for the game server. A real server is started on a random
// port with short timings; Riot's endpoints are replaced by a small fake so
// the tests are fast and never touch the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, PROTOCOL, cleanName, scoreAnswer, clipUrl, Leaderboard } from '../server/app.js';

// ---- Fake Riot data ---------------------------------------------------------

const CHAMPS = [
  ['Ahri', '103'], ['Akali', '84'], ['Annie', '1'], ['Ashe', '22'], ['Braum', '201'], ['Darius', '122'],
  ['Ekko', '245'], ['Garen', '86'], ['Jinx', '222'], ['Lux', '99'], ['Sona', '37'], ['Teemo', '17'],
  ['Unlisted', '901'],   // the game client lists no clips for this one
  ['Missing', '902'],    // clips are not on the CDN
  ['Huge', '903'],       // clips exist but are far too large
];
const BAD = new Set(['Unlisted', 'Missing', 'Huge']);
const idByKey = new Map(CHAMPS.map(([id, key]) => [key, id]));

const reply = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

let riotDown = false;
async function fakeFetch(url) {
  url = String(url);
  if (riotDown) throw new Error('network down');
  if (url.endsWith('/api/versions.json')) return reply(['99.1.1', '99.0.1']);
  if (url.endsWith('/data/en_US/champion.json')) {
    return reply({ data: Object.fromEntries(CHAMPS.map(([id, key]) => [id, { id, key, name: id }])) });
  }
  let m = url.match(/\/data\/en_US\/champion\/(\w+)\.json$/);
  if (m) {
    const id = m[1];
    return reply({ data: { [id]: {
      passive: { name: `${id} Passive` },
      spells: ['Q', 'W', 'E', 'R'].map((s) => ({ name: `${id} ${s}` })),
    } } });
  }
  m = url.match(/communitydragon.*\/champions\/(\d+)\.json$/);
  if (m) {
    const listed = idByKey.get(m[1]) !== 'Unlisted';
    const path = (slot) => (listed ? `champion-abilities/x/ability_x_${slot}1.webm` : '');
    return reply({
      passive: { abilityVideoPath: path('P') },
      spells: ['q', 'w', 'e', 'r'].map((k) => ({ spellKey: k, abilityVideoPath: path(k.toUpperCase()) })),
    });
  }
  m = url.match(/ability_(\d{4})_([PQWER])1\.webm$/);
  if (m) {
    const id = idByKey.get(String(Number(m[1])));
    if (id === 'Missing') return reply(null, 404);
    return reply(null, 200, { 'content-length': String(id === 'Huge' ? 50_000_000 : 3_000_000) });
  }
  return reply(null, 404);
}

// ---- Test harness -----------------------------------------------------------

let app;
let port;

before(async () => {
  app = createApp({
    fetchImpl: fakeFetch,
    log: () => {},
    questionTime: 0.5,
    revealPause: 0.1,
    loadGrace: 0.4,
    prepareTimeout: 2,
    scorePostsPerMinute: 1000,
  });
  port = await app.listen(0, '127.0.0.1');
});

after(async () => { await app.close(); });

const http = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);

function connectTo(targetPort) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${targetPort}`);
    const inbox = [];
    const waiters = [];
    const client = {
      ws,
      inbox,
      closed: false,
      send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
      // Resolves with the next message of this type (already received or yet to come).
      next(type, timeoutMs = 3000) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const waiter = { type, res };
          waiters.push(waiter);
          setTimeout(() => {
            const k = waiters.indexOf(waiter);
            if (k >= 0) { waiters.splice(k, 1); rej(new Error(`timed out waiting for "${type}"`)); }
          }, timeoutMs);
        });
      },
      close: () => new Promise((res) => {
        if (client.closed) { res(); return; }
        ws.addEventListener('close', () => res());
        ws.close();
      }),
    };
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].res(msg);
      else inbox.push(msg);
    });
    ws.addEventListener('close', () => { client.closed = true; });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

const connect = () => connectTo(port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lobbyOfTwo(options = {}) {
  const host = await connect();
  host.send({ type: 'create', v: PROTOCOL, name: 'Host', questionCount: 5, pool: 'basic', ...options });
  const lobby = await host.next('lobby');
  const guest = await connect();
  guest.send({ type: 'join', v: PROTOCOL, name: 'Guest', code: lobby.code });
  const joined = await guest.next('lobby');
  await host.next('player_update');
  await guest.next('player_update');
  return { host, guest, code: lobby.code, hostId: lobby.playerId, guestId: joined.playerId };
}

// ---- Pure helpers -----------------------------------------------------------

test('cleanName strips markup and control characters and enforces length', () => {
  assert.equal(cleanName('  Alice  '), 'Alice');
  assert.equal(cleanName('<img src=x onerror=alert(1)>'), 'img src=x onerro');
  assert.equal(cleanName('a\u0000b\nc'), 'abc');
  assert.equal(cleanName('two   spaces'), 'two spaces');
  assert.equal(cleanName(''), 'Player');
  assert.equal(cleanName(undefined), 'Player');
  assert.equal(cleanName({ evil: true }), 'Player');
  assert.equal(cleanName('x'.repeat(50)).length, 16);
});

test('scoreAnswer matches the client formula', () => {
  assert.deepEqual(scoreAnswer({ championCorrect: true, abilityCorrect: true, timeFraction: 1 }), { result: 'correct', points: 1000 });
  assert.deepEqual(scoreAnswer({ championCorrect: true, abilityCorrect: true, timeFraction: 0 }), { result: 'correct', points: 100 });
  assert.deepEqual(scoreAnswer({ championCorrect: true, abilityCorrect: false, timeFraction: 0.5 }), { result: 'partial', points: 275 });
  assert.deepEqual(scoreAnswer({ championCorrect: false, abilityCorrect: true, timeFraction: 1 }), { result: 'wrong', points: 0 });
  assert.equal(clipUrl('5', 'R'), 'https://lol.dyn.riotcdn.net/x/videos/champion-abilities/0005/ability_0005_R1.webm');
});

test('leaderboard only accepts believable scores and keeps categories separate', () => {
  const board = new Leaderboard(3);
  assert.equal(board.add({ name: 'a', score: 5000, questions: 5 }).score, 5000);
  assert.equal(board.add({ name: 'a', score: 5001, questions: 5 }), null);     // above the maximum
  assert.equal(board.add({ name: 'a', score: -1, questions: 5 }), null);
  assert.equal(board.add({ name: 'a', score: 12.5, questions: 5 }), null);
  assert.equal(board.add({ name: 'a', score: 100, questions: 7 }), null);      // not a real quiz length
  assert.equal(board.add({ name: 'a', score: '100', questions: '10' }).questions, 10);
  assert.equal(board.add(null), null);
  assert.equal(board.add('nope'), null);
  for (const score of [10, 20, 30, 40]) board.add({ name: 'b', score, questions: 20 });
  assert.deepEqual(board.top(20).map((e) => e.score), [40, 30, 20]);            // trimmed to 3 per category
  assert.equal(board.top(5).length, 1);                                         // other categories untouched
  assert.equal(board.add({ name: 'late', score: 5, questions: 20 }), null);     // didn't make the cut
  const entry = board.add({ name: '<b>x</b>', score: 35, questions: 20, pool: 'nonsense', mode: 'multiplayer' });
  assert.equal(entry.name, 'bx/b');
  assert.equal(entry.pool, 'basic');
  assert.equal(board.rankOf(entry), 2);
});

// ---- HTTP -------------------------------------------------------------------

test('health reports the protocol version', async () => {
  const body = await (await http('/health')).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.protocol, PROTOCOL);
});

test('score API validates input and ranks entries', async () => {
  const post = (body) => http('/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let res = await post({ name: 'Zed', score: 7000, questions: 10, pool: 'ult' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, rank: 1 });
  res = await post({ name: 'Lux', score: 9000, questions: 10 });
  assert.equal((await res.json()).rank, 1);
  assert.equal((await post({ name: 'Cheat', score: 999999, questions: 10 })).status, 400);
  assert.equal((await post({ name: 'Cheat', score: 5, questions: 3 })).status, 400);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ name: 'x', score: 1, questions: 10, mode: 'multiplayer' })).status, 200);

  const board = await (await http('/api/leaderboard?questions=10')).json();
  assert.deepEqual(board.map((e) => e.name), ['Lux', 'Zed', 'x']);
  assert.ok(board.every((e) => e.mode === 'solo'), 'clients cannot claim multiplayer scores');
  assert.equal(board[1].pool, 'ult');
  assert.equal((await (await http('/api/leaderboard?questions=20')).json()).length, 0);

  const cors = await http('/api/leaderboard', { method: 'OPTIONS' });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), '*');
});

test('score API rate-limits repeated posts', async () => {
  const limited = createApp({ fetchImpl: fakeFetch, log: () => {}, scorePostsPerMinute: 2 });
  const p = await limited.listen(0, '127.0.0.1');
  try {
    const post = () => fetch(`http://127.0.0.1:${p}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', score: 1, questions: 5 }),
    });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429);
  } finally {
    await limited.close();
  }
});

// ---- Question selection -----------------------------------------------------

test('questions never repeat a champion and never use an unusable clip', async () => {
  for (let run = 0; run < 25; run++) {
    const questions = await app.roster.buildQuestions(9, 'all');
    assert.equal(questions.length, 9);
    const ids = questions.map((q) => q.championId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate champion');
    for (const q of questions) {
      assert.ok(!BAD.has(q.championId), `${q.championId} should have been skipped`);
      assert.equal(q.abilityName, `${q.championId} ${q.slot === 'P' ? 'Passive' : q.slot}`);
    }
  }
  const ults = await app.roster.buildQuestions(5, 'ult');
  assert.ok(ults.every((q) => q.slot === 'R'));
  // Asking for more than exist returns what there is rather than hanging.
  assert.equal((await app.roster.buildQuestions(50, 'basic')).length, CHAMPS.length - BAD.size);
});

// ---- Lobbies ----------------------------------------------------------------

test('a full two-player game: questions, scoring, reveal, final board', async () => {
  const { host, guest, hostId, guestId } = await lobbyOfTwo();

  guest.send({ type: 'start' });                 // only the host may start
  await sleep(50);
  assert.equal(guest.inbox.filter((m) => m.type === 'preparing').length, 0);

  host.send({ type: 'start' });
  await host.next('preparing');
  const started = await host.next('game_start');
  assert.equal(started.total, 5);

  const seen = new Set();
  let hostTotal = 0;
  for (let i = 0; i < 5; i++) {
    const q = await host.next('question');
    await guest.next('question');
    assert.equal(q.index, i);
    assert.equal(q.champion, undefined, 'the question must not carry the answer');
    assert.equal(q.abilityName, undefined);
    const champion = idByKey.get(q.clip.key);
    assert.ok(!seen.has(champion), 'champion repeated within a game');
    seen.add(champion);

    host.send({ type: 'answer', index: i, championId: champion, ability: q.clip.slot });   // too early: ignored
    host.send({ type: 'ready', index: i, ok: true });
    guest.send({ type: 'ready', index: i, ok: true });
    await host.next('go');
    await guest.next('go');

    host.send({ type: 'answer', index: i, championId: champion, ability: q.clip.slot });
    host.send({ type: 'answer', index: i, championId: champion, ability: q.clip.slot });   // duplicates ignored
    const wrongSlot = q.clip.slot === 'Q' ? 'W' : 'Q';
    if (i === 0) guest.send({ type: 'answer', index: i, championId: champion, ability: wrongSlot });
    else if (i === 1) guest.send({ type: 'answer', index: i, championId: 'Nope', ability: 'Q' });
    else guest.send({ type: 'skip', index: i });

    const reveal = await host.next('reveal');
    await guest.next('reveal');
    assert.deepEqual(reveal.answer, {
      championId: champion, championName: champion, slot: q.clip.slot, abilityName: `${champion} ${q.clip.slot}`,
    });
    const mine = reveal.results.find((r) => r.id === hostId);
    const theirs = reveal.results.find((r) => r.id === guestId);
    assert.equal(mine.result, 'correct');
    assert.ok(mine.points > 800 && mine.points <= 1000, `fast correct answer scored ${mine.points}`);
    hostTotal += mine.points;
    if (i === 0) {
      assert.equal(theirs.result, 'partial');
      assert.ok(theirs.points > 400 && theirs.points <= 500);
    } else if (i === 1) {
      assert.equal(theirs.result, 'wrong');
      assert.equal(theirs.points, 0);
    } else {
      assert.equal(theirs.result, 'skipped');
      assert.equal(theirs.points, 0);
    }
    assert.equal(reveal.scoreboard[0].id, hostId);
    assert.equal(reveal.scoreboard[0].score, hostTotal);
    assert.equal(reveal.scoreboard[0].rank, 1);
    assert.equal(reveal.next === null, i === 4);
  }

  const over = await host.next('game_over');
  await guest.next('game_over');
  assert.equal(over.maxScore, 5000);
  assert.equal(over.scoreboard[0].score, hostTotal);
  assert.equal(over.scoreboard[1].rank, 2);

  // Finished multiplayer games land on the leaderboard.
  const board = await (await http('/api/leaderboard?questions=5')).json();
  assert.ok(board.some((e) => e.name === 'Host' && e.score === hostTotal && e.mode === 'multiplayer'));

  guest.send({ type: 'play_again' });            // host only
  await sleep(50);
  assert.equal(guest.inbox.filter((m) => m.type === 'back_to_lobby').length, 0);
  host.send({ type: 'play_again' });
  const back = await guest.next('back_to_lobby');
  assert.deepEqual(back.players.map((p) => p.score), [0, 0]);

  await host.close();
  await guest.close();
});

test('unanswered questions time out, and results do not leak between rounds', async () => {
  const { host, guest, hostId, guestId } = await lobbyOfTwo();
  host.send({ type: 'start' });

  // Round 1: host answers correctly, guest lets the clock run out.
  const q = await host.next('question');
  host.send({ type: 'ready', index: 0 });
  guest.send({ type: 'ready', index: 0 });
  await host.next('go');
  host.send({ type: 'answer', index: 0, championId: idByKey.get(q.clip.key), ability: q.clip.slot });
  let reveal = await host.next('reveal');
  assert.equal(reveal.results.find((r) => r.id === guestId).result, 'timeout');
  const firstScore = reveal.scoreboard.find((p) => p.id === hostId).score;
  assert.ok(firstScore > 0);

  // Round 2: nobody answers. The host must not be credited again for round 1.
  await host.next('question');
  host.send({ type: 'ready', index: 1 });
  guest.send({ type: 'ready', index: 1 });
  await host.next('go');
  reveal = await host.next('reveal');
  for (const r of reveal.results) {
    assert.equal(r.result, 'timeout');
    assert.equal(r.points, 0);
  }
  assert.equal(reveal.scoreboard.find((p) => p.id === hostId).score, firstScore);

  await host.close();
  await guest.close();
});

test('the round starts after the grace period even if a player never reports ready', async () => {
  const { host, guest } = await lobbyOfTwo();
  host.send({ type: 'start' });
  await host.next('question');
  const started = Date.now();
  host.send({ type: 'ready', index: 0 });        // guest stays silent
  await host.next('go');
  assert.ok(Date.now() - started >= 250, 'should have waited for the grace period');
  await host.close();
  await guest.close();
});

test('a clip most players cannot play is swapped for a spare', async () => {
  const { host, guest } = await lobbyOfTwo();
  host.send({ type: 'start' });
  const first = await host.next('question');
  await guest.next('question');
  host.send({ type: 'ready', index: 0, ok: false, reason: 'silent' });
  guest.send({ type: 'ready', index: 0, ok: false, reason: 'silent' });
  const second = await host.next('question');
  assert.equal(second.index, 0);
  assert.notDeepEqual(second.clip, first.clip);
  // Two players agreed, so the clip is no longer offered to anyone.
  const cacheKey = `${first.clip.key}:${first.clip.slot}`;
  assert.equal(app.roster.clipCache.get(cacheKey).ok, false);
  await guest.next('question');
  host.send({ type: 'ready', index: 0, ok: true });
  guest.send({ type: 'ready', index: 0, ok: true });
  await host.next('go');
  app.roster.clipCache.delete(cacheKey);
  await host.close();
  await guest.close();
});

test('one player with a broken clip does not derail the round', async () => {
  const { host, guest } = await lobbyOfTwo();
  host.send({ type: 'start' });
  const q = await host.next('question');
  host.send({ type: 'ready', index: 0, ok: true });
  guest.send({ type: 'ready', index: 0, ok: false, reason: 'network' });
  const go = await host.next('go');
  assert.equal(go.index, q.index);
  assert.equal(host.inbox.filter((m) => m.type === 'question').length, 0);
  await host.close();
  await guest.close();
});

test('leaving mid-question never strands the other player; the host role moves on', async () => {
  const { host, guest, guestId } = await lobbyOfTwo();
  host.send({ type: 'start' });
  const q = await guest.next('question');
  host.send({ type: 'ready', index: 0 });
  guest.send({ type: 'ready', index: 0 });
  await guest.next('go');
  guest.send({ type: 'answer', index: 0, championId: idByKey.get(q.clip.key), ability: q.clip.slot });
  await sleep(30);
  await host.close();                            // host vanishes without answering
  const reveal = await guest.next('reveal');     // ...and the round resolves right away
  assert.equal(reveal.results.length, 1);
  const update = await guest.next('player_update');
  assert.deepEqual(update.players.map((p) => [p.id, p.isHost]), [[guestId, true]]);
  await guest.close();
});

test('join is refused for unknown, running and full lobbies', async () => {
  const stranger = await connect();
  stranger.send({ type: 'join', v: PROTOCOL, name: 'S', code: 'ZZZZ' });
  assert.match((await stranger.next('error')).message, /not found/i);

  const { host, guest, code } = await lobbyOfTwo();
  host.send({ type: 'start' });
  await host.next('game_start');
  stranger.send({ type: 'join', v: PROTOCOL, name: 'S', code });
  assert.match((await stranger.next('error')).message, /already started/i);
  await host.close();
  await guest.close();

  const owner = await connect();
  owner.send({ type: 'create', v: PROTOCOL, name: 'Same' });
  const lobby = await owner.next('lobby');
  assert.deepEqual(lobby.settings, { questionCount: 10, pool: 'basic' });       // defaults
  const others = [];
  for (let i = 0; i < 7; i++) {
    const c = await connect();
    c.send({ type: 'join', v: PROTOCOL, name: 'Same', code: lobby.code.toLowerCase() });   // codes are case-insensitive
    others.push(c);
    const joined = await c.next('lobby');
    assert.equal(joined.players.length, i + 2);
  }
  const namesNow = [...app.lobbies.get(lobby.code).players.values()].map((p) => p.name);
  assert.equal(new Set(namesNow).size, 8, 'duplicate names are made distinct');
  stranger.send({ type: 'join', v: PROTOCOL, name: 'S', code: lobby.code });
  assert.match((await stranger.next('error')).message, /full/i);

  await Promise.all([owner, stranger, ...others].map((c) => c.close()));
});

test('a solo host cannot start, and an empty lobby is cleaned up', async () => {
  const host = await connect();
  host.send({ type: 'create', v: PROTOCOL, name: 'Alone', questionCount: 20, pool: 'ult' });
  const lobby = await host.next('lobby');
  assert.deepEqual(lobby.settings, { questionCount: 20, pool: 'ult' });
  host.send({ type: 'start' });
  assert.match((await host.next('error')).message, /at least 2/i);
  assert.ok(app.lobbies.has(lobby.code));
  await host.close();
  await sleep(50);
  assert.ok(!app.lobbies.has(lobby.code));
});

test('outdated and malformed clients are handled without crashing', async () => {
  const old = await connect();
  assert.equal((await old.next('hello')).protocol, PROTOCOL);
  old.send({ type: 'create', name: 'Old client' });                 // no protocol version
  assert.equal((await old.next('error')).code, 'outdated');

  const c = await connect();
  const junk = [
    'not json', '[]', 'null', '42', '{"type":123}', '{"type":"__proto__"}', '{"type":"constructor"}',
    { type: 'nope' }, { type: 'start' }, { type: 'ready' }, { type: 'answer' }, { type: 'skip' }, { type: 'play_again' },
    { type: 'join', v: PROTOCOL, code: { a: 1 }, name: ['x'] },
    { type: 'answer', index: 'x', championId: { $gt: '' }, ability: 9 },
    { type: 'create', v: PROTOCOL, name: 12345, questionCount: 'lots', pool: '__proto__' },
  ];
  for (const msg of junk) c.send(msg);
  await c.next('error');                         // from the join with a nonsense code
  const lobby = await c.next('lobby');           // the last (odd but valid) create still works
  assert.equal(lobby.players[0].name, 'Player');
  assert.deepEqual(lobby.settings, { questionCount: 10, pool: 'basic' });
  c.send({ type: 'ping' });
  await c.next('pong');
  assert.equal((await (await http('/health')).json()).status, 'ok');
  await old.close();
  await c.close();
});

test('oversized and flooding connections are dropped', async () => {
  const big = await connect();
  big.send(JSON.stringify({ type: 'create', v: PROTOCOL, name: 'x'.repeat(5000) }));
  await sleep(200);
  assert.equal(big.closed, true);

  const flood = await connect();
  for (let i = 0; i < 60; i++) flood.send({ type: 'ping' });
  await sleep(250);
  assert.equal(flood.closed, true);
});

test('if Riot is unreachable the lobby gets a clear error and can retry', async () => {
  const fresh = createApp({
    fetchImpl: fakeFetch, log: () => {}, questionTime: 0.5, revealPause: 0.1, loadGrace: 0.4, prepareTimeout: 1,
  });
  const p = await fresh.listen(0, '127.0.0.1');
  try {
    await sleep(50);
    fresh.roster.champions = [];                 // forget the warm-up roster
    fresh.roster.loadedAt = 0;
    riotDown = true;
    const a = await connectTo(p);
    a.send({ type: 'create', v: PROTOCOL, name: 'A', questionCount: 5 });
    const lobby = await a.next('lobby');
    const b = await connectTo(p);
    b.send({ type: 'join', v: PROTOCOL, name: 'B', code: lobby.code });
    await b.next('lobby');
    a.send({ type: 'start' });
    assert.match((await a.next('error')).message, /Riot/);
    await a.next('back_to_lobby');
    riotDown = false;
    a.send({ type: 'start' });                   // works once Riot is back
    assert.equal((await a.next('game_start')).total, 5);
    await a.close();
    await b.close();
  } finally {
    riotDown = false;
    await fresh.close();
  }
});
