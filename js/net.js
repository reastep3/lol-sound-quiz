// Everything that talks to the game server: waking it up, the leaderboard
// API and the multiplayer WebSocket.

import { CONFIG } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { timeoutMs = 8000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

// The server runs on a free host that sleeps when nobody is using it and
// takes up to a minute to wake. Poll until it answers, reporting progress.
// Resolves { ok, outdated } and never throws.
let wakePromise = null;
export function wakeServer(onStatus = () => {}) {
  // Several callers may ask at once (page load, lobby, leaderboard): share one wake-up.
  if (wakePromise) {
    onStatus('connecting');
    wakePromise.then((r) => onStatus(r.ok ? (r.outdated ? 'outdated' : 'online') : 'offline'));
    return wakePromise;
  }
  wakePromise = (async () => {
    const deadline = Date.now() + CONFIG.serverWakeTimeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      onStatus(attempt === 1 ? 'connecting' : 'waking');
      try {
        const health = await fetchJson(`${CONFIG.server.http}/health`, { timeoutMs: 15_000, cache: 'no-store' });
        if (health?.status === 'ok') {
          // A server that predates the protocol field is still running old code.
          const outdated = health.protocol !== CONFIG.protocol;
          onStatus(outdated ? 'outdated' : 'online');
          return { ok: true, outdated };
        }
      } catch { /* still asleep or unreachable */ }
      await sleep(2000);
    }
    onStatus('offline');
    return { ok: false, outdated: false };
  })();
  // Only an in-flight check is shared; the next caller checks afresh.
  wakePromise.then(() => { wakePromise = null; });
  return wakePromise;
}

// ---- Leaderboard ------------------------------------------------------------

export function fetchLeaderboard(questions) {
  return fetchJson(`${CONFIG.server.http}/api/leaderboard?questions=${questions}`, { timeoutMs: 20_000 });
}

export function submitScore(entry) {
  return fetchJson(`${CONFIG.server.http}/api/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    timeoutMs: 20_000,
  });
}

// ---- Multiplayer ------------------------------------------------------------

export class LobbyClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.pingTimer = null;
    this.playerId = null;
    this.code = null;
    this.isHost = false;
    this.closedByUs = false;
  }

  on(type, fn) {
    this.handlers[type] = fn;
    return this;
  }

  emit(type, msg) {
    this.handlers[type]?.(msg);
  }

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(CONFIG.server.ws);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* not open yet */ }
        reject(new Error('Connection timed out'));
      }, timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Could not reach the game server'));
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg && typeof msg.type === 'string') this.emit(msg.type, msg);
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        if (!this.closedByUs && settled) this.emit('disconnected', {});
      };
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  create(name, questionCount, pool) {
    this.send({ type: 'create', v: CONFIG.protocol, name, questionCount, pool });
  }

  join(name, code) {
    this.send({ type: 'join', v: CONFIG.protocol, name, code });
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.handlers = {};
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}
