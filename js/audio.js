// Sound engine.
//
// Each question's sound is the audio track of Riot's official ability preview
// clip. Raw, those clips are awkward to quiz on: they are multi-megabyte
// videos, their loudness differs by more than 30 dB from one to the next,
// they often open with a second or more of silence, and some run past 20
// seconds. So instead of streaming a hidden <video>, we download the clip,
// decode just the audio, and then:
//
//   1. find where the sound actually starts and trim the lead-in,
//   2. cap the length,
//   3. measure how loud it is and level it to a common target,
//   4. reject clips that turn out to contain no real sound at all.
//
// If a clip cannot be loaded there is no stand-in sound. The caller is told
// why, and picks a different question.

import { CONFIG } from './config.js';

const A = CONFIG.audio;

export class ClipError extends Error {
  // reason: 'missing' | 'too-large' | 'silent' | 'network'
  constructor(reason, detail = '') {
    super(`Clip ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'ClipError';
    this.reason = reason;
  }
}

export function clipUrl(key, slot, { ext = 'webm', host = CONFIG.clipHost } = {}) {
  const id = String(key).padStart(4, '0');
  return `${host}/${id}/ability_${id}_${slot}1.${ext}`;
}

const toDb = (meanSquare) => (meanSquare > 0 ? 10 * Math.log10(meanSquare) : -120);
const fromDb = (db) => 10 ** (db / 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- Analysis (pure: works on plain Float32Arrays, so it is unit-tested) ----

// Decide what part of a decoded clip to play and how much to amplify it.
// Returns { silent: true } when there is nothing worth playing.
export function analyzePcm(channels, sampleRate, opts = A) {
  const left = channels[0];
  const right = channels[1] || null;
  const n = left.length;
  const win = Math.max(1, Math.round(sampleRate * 0.02));   // 20 ms frames
  const frameSec = win / sampleRate;
  const frames = Math.ceil(n / win);
  if (!frames) return { silent: true, loudDb: -120 };

  // Mean-square energy of the mono mix, per frame.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const from = f * win;
    const to = Math.min(n, from + win);
    let sum = 0;
    for (let i = from; i < to; i++) {
      const m = right ? (left[i] + right[i]) * 0.5 : left[i];
      sum += m * m;
    }
    energy[f] = sum / (to - from);
  }

  // "Loudness" = the loudest 400 ms stretch. Robust for sparse sounds, where
  // an average over the whole clip would mostly measure the gaps.
  const loudest = (from, to) => {
    const span = Math.min(20, to - from);
    if (span <= 0) return 0;
    let run = 0;
    let best = 0;
    for (let f = from; f < to; f++) {
      run += energy[f];
      if (f - from >= span) run -= energy[f - span];
      if (f - from >= span - 1 && run / span > best) best = run / span;
    }
    return best;
  };

  const wholeDb = toDb(loudest(0, frames));
  if (wholeDb < opts.silentDb) return { silent: true, loudDb: wholeDb };

  // Start a little before the first frame that rises out of the background.
  const startLevel = fromDb(Math.max(-62, wholeDb - 30));
  let first = 0;
  while (first < frames - 1 && energy[first] <= startLevel) first++;

  // About one clip in sixteen opens with a second or more of faint map
  // ambience before the ability is cast. If that long passes with nothing
  // within 18 dB of the loudest part, skip ahead to just before the first
  // real hit (keeping a little, so a soft attack isn't clipped).
  const strongLevel = fromDb(wholeDb - 18);
  let strong = first;
  while (strong < frames - 1 && energy[strong] <= strongLevel) strong++;
  if ((strong - first) * frameSec >= 1) first = Math.max(first, strong - Math.round(0.35 / frameSec));
  const startSec = Math.max(0, first * frameSec - 0.1);

  // End a little after the last frame that is still clearly audible...
  const endLevel = fromDb(Math.max(-62, wholeDb - 38));
  let last = frames - 1;
  while (last > first && energy[last] <= endLevel) last--;
  let endSec = Math.min(n / sampleRate, (last + 1) * frameSec + 0.25);

  // ...but don't sit through seconds of ambience once the sound is over.
  // `cut` means we stop while something is still (faintly) playing, so the
  // end gets a longer fade.
  let cut = false;
  const tailLevel = fromDb(wholeDb - 24);
  let lastStrong = last;
  while (lastStrong > first && energy[lastStrong] <= tailLevel) lastStrong--;
  const strongEnd = (lastStrong + 1) * frameSec;
  if (endSec - strongEnd > 1.5) {
    endSec = strongEnd + 1.2;
    cut = true;
  }
  if (endSec - startSec > opts.maxPlaySec) {
    endSec = startSec + opts.maxPlaySec;
    cut = true;
  }

  // Level by the loudness of the part that will be heard.
  const fa = Math.floor(startSec / frameSec);
  const fb = Math.max(fa + 1, Math.min(frames, Math.ceil(endSec / frameSec)));
  const loudDb = toDb(loudest(fa, fb));
  const gainDb = clamp(opts.targetDb - loudDb, opts.minGainDb, opts.maxGainDb);

  // Bar heights for the waveform display.
  const BARS = 96;
  const peaks = new Array(BARS);
  let top = 0;
  for (let b = 0; b < BARS; b++) {
    const from = fa + Math.floor((b * (fb - fa)) / BARS);
    const to = Math.max(from + 1, fa + Math.floor(((b + 1) * (fb - fa)) / BARS));
    let max = 0;
    for (let f = from; f < to && f < frames; f++) if (energy[f] > max) max = energy[f];
    peaks[b] = Math.sqrt(max);
    if (peaks[b] > top) top = peaks[b];
  }
  for (let b = 0; b < BARS; b++) peaks[b] = top > 0 ? Math.max(0.04, (peaks[b] / top) ** 0.7) : 0.04;

  return { silent: false, startSec, endSec, cut, loudDb, gainDb, peaks };
}

// ---- Loading ----------------------------------------------------------------

function decodeWith(ctx, bytes) {
  // Promise form everywhere modern; callback form for older WebKit.
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && typeof p.catch === 'function') p.catch(reject);
  });
}

// Copy just the part we play into its own buffer, with short fades so the
// cut points never click. The full decoded clip can then be garbage-collected.
function sliceBuffer(buffer, { startSec, endSec, cut }) {
  const sr = buffer.sampleRate;
  const a = Math.floor(startSec * sr);
  const b = Math.min(buffer.length, Math.ceil(endSec * sr));
  const len = Math.max(1, b - a);
  const out = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: sr });
  const fadeIn = Math.min(len, Math.round(sr * 0.008));
  const fadeOut = Math.min(len, Math.round(sr * (cut ? 0.4 : 0.03)));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const dst = out.getChannelData(ch);
    dst.set(buffer.getChannelData(ch).subarray(a, b));
    for (let i = 0; i < fadeIn; i++) dst[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) dst[len - 1 - i] *= i / fadeOut;
  }
  return out;
}

function canPlayThrough(url, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const el = new Audio();
    const done = (ok) => {
      clearTimeout(timer);
      el.oncanplay = null;
      el.onerror = null;
      if (!ok) el.removeAttribute('src');
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    el.preload = 'auto';
    el.oncanplay = () => done(true);
    el.onerror = () => done(false);
    el.src = url;
    el.load();
  });
}

export class ClipLoader {
  constructor() {
    this.cache = new Map();   // "key:slot" -> { promise, clip, used }
    this.tick = 0;
    this.decodeCtx = null;
  }

  // Resolves to a playable clip. Rejects with a ClipError saying why not.
  // Safe to call repeatedly: work is shared and results are remembered.
  load(key, slot) {
    const id = `${key}:${slot}`;
    let entry = this.cache.get(id);
    if (!entry) {
      entry = { promise: null, clip: null, used: 0 };
      entry.promise = this.fetchClip(key, slot).then((clip) => { entry.clip = clip; return clip; });
      this.cache.set(id, entry);
      entry.promise.catch((err) => {
        // Remember "this clip does not exist / is silent", but let a
        // connection problem be retried.
        if (!(err instanceof ClipError) || err.reason === 'network') this.cache.delete(id);
      });
    }
    entry.used = ++this.tick;
    this.evict();
    return entry.promise;
  }

  evict() {
    const loaded = [...this.cache.entries()].filter(([, e]) => e.clip);
    if (loaded.length <= A.cacheSize) return;
    loaded.sort((a, b) => a[1].used - b[1].used);
    for (const [id] of loaded.slice(0, loaded.length - A.cacheSize)) this.cache.delete(id);
  }

  async download(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), A.fetchTimeoutMs);
    try {
      let res;
      try {
        res = await fetch(url, { signal: ctl.signal, mode: 'cors', credentials: 'omit' });
      } catch (err) {
        throw new ClipError('network', err.message);
      }
      if (res.status === 403 || res.status === 404) throw new ClipError('missing');
      if (!res.ok) throw new ClipError('network', `HTTP ${res.status}`);
      const size = Number(res.headers.get('content-length')) || 0;
      if (size > A.maxClipBytes) {
        ctl.abort();
        throw new ClipError('too-large', `${(size / 1e6).toFixed(1)} MB`);
      }
      try {
        return await res.arrayBuffer();
      } catch (err) {
        throw new ClipError('network', err.message);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  decode(bytes) {
    if (!this.decodeCtx) {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Offline) return Promise.reject(new Error('Web Audio is not available'));
      this.decodeCtx = new Offline(2, 2, 48000);
    }
    return decodeWith(this.decodeCtx, bytes);
  }

  async fetchClip(key, slot) {
    let decoded = null;
    // WebM first (smaller). MP4 is for browsers that cannot decode WebM audio.
    for (const ext of ['webm', 'mp4']) {
      let bytes;
      try {
        bytes = await this.download(clipUrl(key, slot, { ext }));
      } catch (err) {
        if (err.reason === 'network') break;      // offline, or the CDN stopped allowing reads
        if (ext === 'webm') throw err;            // missing / too large: a real answer
        break;
      }
      try {
        decoded = await this.decode(bytes);
        break;
      } catch { /* try the next container */ }
    }

    if (!decoded) return this.elementClip(key, slot);

    const channels = [];
    for (let ch = 0; ch < Math.min(2, decoded.numberOfChannels); ch++) channels.push(decoded.getChannelData(ch));
    const info = analyzePcm(channels, decoded.sampleRate);
    if (info.silent) throw new ClipError('silent', `${info.loudDb.toFixed(0)} dB`);

    const buffer = sliceBuffer(decoded, info);
    return {
      kind: 'buffer',
      buffer,
      duration: buffer.duration,
      gain: 10 ** (info.gainDb / 20),
      peaks: info.peaks,
      info,
    };
  }

  // Last resort: let the browser stream the file in a plain media element.
  // No trimming or levelling is possible this way, but it is the real sound.
  async elementClip(key, slot) {
    const candidates = [
      clipUrl(key, slot, { ext: 'mp4' }),
      clipUrl(key, slot),
      clipUrl(key, slot, { host: CONFIG.legacyClipHost }),
    ];
    for (const url of candidates) {
      if (await canPlayThrough(url)) return { kind: 'element', url, duration: null, gain: 1, peaks: null, info: null };
    }
    throw new ClipError('network', 'could not load the clip');
  }
}

// ---- Playback ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Player {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.el = null;
    this.volume = 0.8;
    this.session = null;
    this.seq = 0;
  }

  // Browsers only allow sound after a click or key press. Call this from
  // inside such a handler (Start, Next, Join...) so later playback is allowed.
  unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx && AC) {
      this.ctx = new AC();
      // Catches the occasional peak that levelling pushes over full scale.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -4;
      this.limiter.knee.value = 4;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.limiter.connect(this.master).connect(this.ctx.destination);
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = 'auto';
    }
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
    if (this.el) this.el.volume = this.volume;
  }

  get playing() {
    return !!this.session;
  }

  stop() {
    this.seq++;
    const s = this.session;
    if (s) {
      this.session = null;
      s.halt();
      s.onEnd?.('stopped');
    }
  }

  // Starts a clip. Resolves true once sound is playing, or false if the
  // browser refused (the player then needs to press play themselves).
  async play(clip, { onProgress, onEnd } = {}) {
    this.stop();
    this.unlock();
    const token = this.seq;

    if (clip.kind === 'buffer') {
      const ctx = this.ctx;
      if (!ctx) return false;
      if (ctx.state !== 'running') {
        // resume() can stay pending forever without a user gesture.
        await Promise.race([ctx.resume().catch(() => {}), sleep(400)]);
        if (token !== this.seq) return false;
        if (ctx.state !== 'running') return false;
      }
      const src = ctx.createBufferSource();
      src.buffer = clip.buffer;
      const gain = ctx.createGain();
      gain.gain.value = clip.gain;
      src.connect(gain).connect(this.limiter);

      const startedAt = ctx.currentTime;
      let raf = 0;
      const session = {
        onEnd,
        halt: () => {
          cancelAnimationFrame(raf);
          src.onended = null;
          try { src.stop(); } catch { /* already stopped */ }
          src.disconnect();
          gain.disconnect();
        },
      };
      const frame = () => {
        if (this.session !== session) return;
        onProgress?.(clamp((ctx.currentTime - startedAt) / clip.duration, 0, 1));
        raf = requestAnimationFrame(frame);
      };
      src.onended = () => {
        if (this.session !== session) return;
        this.session = null;
        session.halt();
        onProgress?.(1);
        onEnd?.('ended');
      };
      this.session = session;
      src.start();
      raf = requestAnimationFrame(frame);
      return true;
    }

    // Plain media-element playback (fallback path).
    const el = this.el;
    el.src = clip.url;
    el.volume = this.volume;
    try {
      await el.play();
    } catch {
      return false;
    }
    if (token !== this.seq) { el.pause(); return false; }
    let raf = 0;
    const session = {
      onEnd,
      halt: () => {
        cancelAnimationFrame(raf);
        el.onended = null;
        el.onerror = null;
        el.pause();
      },
    };
    const frame = () => {
      if (this.session !== session) return;
      if (el.duration > 0) onProgress?.(clamp(el.currentTime / el.duration, 0, 1));
      raf = requestAnimationFrame(frame);
    };
    const finish = () => {
      if (this.session !== session) return;
      this.session = null;
      session.halt();
      onProgress?.(1);
      onEnd?.('ended');
    };
    el.onended = finish;
    el.onerror = finish;
    this.session = session;
    raf = requestAnimationFrame(frame);
    return true;
  }
}
