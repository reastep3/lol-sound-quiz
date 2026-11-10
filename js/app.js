// LoL Sound Quiz – screens, game flow and input handling.

import { CONFIG, POOLS, SLOTS } from './config.js';
import { Roster, sampleQuestions, scoreAnswer } from './data.js';
import { ClipLoader, Player, ClipError } from './audio.js';
import { save } from './storage.js';
import { wakeServer, fetchLeaderboard, submitScore, LobbyClient } from './net.js';

// ---- Tiny DOM helpers -------------------------------------------------------

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

// Builds an element. Children are always inserted as text nodes or elements,
// never as HTML, so names typed by other players can't inject markup.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function champIcon(champ, cls = 'champ-icon') {
  const img = el('img', { class: cls, alt: '', src: app.roster.iconUrl(champ) });
  img.onerror = () => { img.style.visibility = 'hidden'; };
  return img;
}

const slotName = (slot) => (slot === 'P' ? 'Passive' : slot);

let toastTimer = 0;
function toast(message, ms = 3500) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// Segmented option control: exactly one button is active.
function segmented(root, initial, onChange) {
  const buttons = [...root.querySelectorAll('.seg-btn')];
  const set = (value) => buttons.forEach((b) => {
    const on = b.dataset.value === String(value);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  buttons.forEach((b) => b.addEventListener('click', () => {
    set(b.dataset.value);
    onChange?.(b.dataset.value);
  }));
  set(initial);
  return {
    set,
    get value() { return buttons.find((b) => b.classList.contains('active'))?.dataset.value; },
  };
}

// ---- App state --------------------------------------------------------------

const app = {
  roster: null,
  loader: new ClipLoader(),
  player: new Player(),
  screen: 'loading',
  game: null,          // the SoloGame or MpGame currently on the quiz screen
  mp: null,            // the multiplayer session, from lobby to final scoreboard
  lastSolo: null,      // most recent finished solo game (for the results screen)
};

const SCREENS = {
  loading: 'loading-screen',
  start: 'start-screen',
  lobby: 'lobby-screen',
  waiting: 'waiting-screen',
  quiz: 'quiz-screen',
  results: 'results-screen',
  mpResults: 'mp-results-screen',
};

function show(name) {
  app.screen = name;
  for (const [key, id] of Object.entries(SCREENS)) $(id).classList.toggle('active', key === name);
  window.scrollTo(0, 0);
  if (name === 'quiz') view.drawWave();
}

// ---- Countdown --------------------------------------------------------------

class Countdown {
  constructor(onTick, onExpire) {
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.id = 0;
    this.total = 1;
    this.endsAt = 0;
    this.frozen = 1;
  }

  start(totalMs) {
    this.stop();
    this.total = totalMs;
    this.endsAt = performance.now() + totalMs;
    this.id = setInterval(() => this.tick(), 100);
    this.tick();
  }

  get running() { return this.id !== 0; }

  // Share of the time still left, 1 down to 0.
  get fraction() {
    if (!this.id) return this.frozen;
    return Math.max(0, (this.endsAt - performance.now()) / this.total);
  }

  tick() {
    const left = Math.max(0, this.endsAt - performance.now());
    this.onTick(left / this.total, left);
    if (left <= 0) {
      this.stop();
      this.onExpire?.();
    }
  }

  stop() {
    if (!this.id) return;
    this.frozen = this.fraction;
    clearInterval(this.id);
    this.id = 0;
  }

  reset() {
    this.stop();
    this.frozen = 1;
  }
}

// ---- Champion picker (autocomplete) ----------------------------------------

class ChampionPicker {
  constructor({ input, list, icon, combo, onChange, onChoose, onCommit }) {
    Object.assign(this, { input, list, icon, combo, onChange, onChoose, onCommit });
    this.matches = [];
    this.active = -1;
    this.selected = null;

    input.addEventListener('input', () => this.onInput());
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('focus', () => { if (!this.selected && input.value.trim()) this.onInput(); });
    input.addEventListener('blur', () => { this.close(); this.autoResolve(); });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-index]');
      if (item) this.choose(this.matches[Number(item.dataset.index)]);
    });
  }

  onInput() {
    if (this.selected) this.setSelected(null, true);
    this.matches = app.roster.search(this.input.value, 7);
    this.active = this.matches.length ? 0 : -1;
    this.render();
  }

  render() {
    const typed = this.input.value.trim();
    if (!typed) { this.close(); return; }
    if (!this.matches.length) {
      this.list.replaceChildren(el('div', { class: 'combo-empty' }, 'No champion matches that'));
    } else {
      this.list.replaceChildren(...this.matches.map((champ, i) => el('div', {
        class: `combo-item${i === this.active ? ' active' : ''}`,
        role: 'option',
        id: `champ-opt-${i}`,
        'data-index': i,
        'aria-selected': String(i === this.active),
      }, champIcon(champ), el('span', {}, champ.name))));
    }
    this.list.classList.add('open');
    this.input.setAttribute('aria-expanded', 'true');
    if (this.active >= 0) this.input.setAttribute('aria-activedescendant', `champ-opt-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  get open() { return this.list.classList.contains('open'); }

  close() {
    this.list.classList.remove('open');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  move(step) {
    if (!this.matches.length) return;
    this.active = (this.active + step + this.matches.length) % this.matches.length;
    this.render();
  }

  onKey(e) {
    if (e.key === 'ArrowDown' && this.open) { e.preventDefault(); this.move(1); }
    else if (e.key === 'ArrowUp' && this.open) { e.preventDefault(); this.move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.open && this.active >= 0) this.choose(this.matches[this.active]);
      else if (this.selected) this.onCommit?.();
      else {
        const champ = app.roster.resolve(this.input.value);
        if (champ) this.choose(champ);
      }
    } else if (e.key === 'Tab' && !e.shiftKey && this.open && this.active >= 0) {
      this.setSelected(this.matches[this.active]);   // pick it, let focus move on naturally
      this.close();
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  // The player picked a champion on purpose: lock it in and get out of the way.
  choose(champ) {
    this.setSelected(champ);
    this.close();
    this.onChoose?.(champ);
  }

  setSelected(champ, keepText = false) {
    this.selected = champ;
    if (champ) {
      this.input.value = champ.name;
      this.icon.src = app.roster.iconUrl(champ);
      this.icon.hidden = false;
    } else {
      this.icon.hidden = true;
      this.icon.removeAttribute('src');
      if (!keepText) this.input.value = '';
    }
    this.combo.classList.toggle('has-value', !!champ);
    this.onChange?.(champ);
  }

  // Leaving the field with text that can only mean one champion counts as picking it.
  autoResolve() {
    if (this.selected) return;
    const champ = app.roster.resolve(this.input.value);
    if (champ) this.setSelected(champ);
  }

  clear() {
    this.matches = [];
    this.active = -1;
    this.setSelected(null);
    this.close();
  }

  focus() { this.input.focus({ preventScroll: true }); }
}

let picker = null;

// ---- Quiz screen ------------------------------------------------------------

const abilityButtons = () => [...document.querySelectorAll('.ability-btn')];

const view = {
  peaks: null,
  progress: 0,
  slots: SLOTS,
  selectedSlot: null,
  formEnabled: false,
  feedbackOpen: false,
  countdownTimer: 0,

  setup({ index, total, score, timed, slots }) {
    $('q-counter').textContent = `Question ${index + 1} / ${total}`;
    $('q-score').textContent = fmt(score);
    $('q-progress').style.width = `${(index / total) * 100}%`;
    this.hideFeedback();

    this.slots = slots;
    for (const b of abilityButtons()) {
      b.hidden = !slots.includes(b.dataset.slot);
      b.classList.remove('selected');
      b.setAttribute('aria-pressed', 'false');
    }
    // With a single possible slot (ultimates only) there is nothing to choose.
    $('ability-field').hidden = slots.length === 1;
    this.selectedSlot = slots.length === 1 ? slots[0] : null;

    picker.clear();
    $('locked-note').hidden = true;
    $('load-error').hidden = true;
    $('mp-answered').textContent = '';
    $('timer').hidden = !timed;
    this.setTimer(1, CONFIG.questionTimeSec * 1000);
    this.setClip(null);
    this.setState('loading', 'Loading sound…');
    this.setFormEnabled(false);
  },

  // state: loading | ready | playing | error
  setState(state, text) {
    $('sound-card').dataset.state = state;
    if (text != null) $('sound-status').textContent = text;
    const btn = $('play-btn');
    btn.disabled = state === 'loading' || state === 'error';
    btn.setAttribute('aria-label', state === 'playing' ? 'Stop sound' : 'Play sound');
  },

  setClip(clip) {
    this.peaks = clip?.peaks || null;
    this.progress = 0;
    this.drawWave();
  },

  setProgress(p) {
    this.progress = p;
    this.drawWave();
  },

  drawWave() {
    const canvas = $('wave');
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const idle = css.getPropertyValue('--wave-idle').trim() || '#2a4060';
    const played = css.getPropertyValue('--wave-played').trim() || '#0ac8b9';
    const bars = this.peaks ? this.peaks.length : 48;
    const step = w / bars;
    const barW = Math.max(1.5, step * 0.62);
    for (let i = 0; i < bars; i++) {
      const level = this.peaks ? this.peaks[i] : 0.1;
      const barH = Math.max(3, level * (h - 4));
      g.fillStyle = (i + 0.5) / bars <= this.progress ? played : idle;
      const x = i * step + (step - barW) / 2;
      const y = (h - barH) / 2;
      if (g.roundRect) { g.beginPath(); g.roundRect(x, y, barW, barH, barW / 2); g.fill(); }
      else g.fillRect(x, y, barW, barH);
    }
  },

  setTimer(fraction, msLeft) {
    $('timer-fill').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    const seconds = Math.ceil(msLeft / 1000);
    $('timer-value').textContent = String(seconds);
    const urgent = seconds <= 5;
    $('timer-fill').classList.toggle('urgent', urgent);
    $('timer-value').classList.toggle('urgent', urgent);
  },

  setFormEnabled(on) {
    this.formEnabled = on;
    $('champ-input').disabled = !on;
    $('skip-btn').disabled = !on;
    for (const b of abilityButtons()) b.disabled = !on;
    this.validate();
  },

  selectAbility(slot) {
    if (!this.formEnabled || !this.slots.includes(slot)) return;
    this.selectedSlot = slot;
    for (const b of abilityButtons()) {
      const on = b.dataset.slot === slot;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.validate();
  },

  validate() {
    $('submit-btn').disabled = !(this.formEnabled && picker?.selected && this.selectedSlot);
  },

  lock(note) {
    this.setFormEnabled(false);
    $('locked-note').textContent = note;
    $('locked-note').hidden = false;
  },

  nudge(node) {
    node.classList.remove('nudge');
    void node.offsetWidth; // restart the animation
    node.classList.add('nudge');
  },

  showLoadError(text) {
    this.setState('error', 'No sound');
    $('load-error-text').textContent = text;
    $('load-error').hidden = false;
  },

  // Answer reveal. `board` is only passed in multiplayer.
  showFeedback({ result, points, answer, guess, isLast, board, myId, pauseSec }) {
    const titles = {
      correct: 'Correct!',
      partial: 'Right champion, wrong ability',
      wrong: 'Not this time',
      skipped: 'Skipped',
      timeout: "Time's up",
    };
    $('fb-card').className = `modal feedback-card ${result}`;
    $('fb-title').textContent = titles[result] || '';

    const abilityIcon = el('img', { class: 'reveal-ability', alt: '', hidden: !answer.abilityIcon });
    if (answer.abilityIcon) abilityIcon.src = answer.abilityIcon;
    abilityIcon.onerror = () => { abilityIcon.hidden = true; };
    $('fb-reveal').replaceChildren(
      el('div', { class: 'reveal-art' }, champIcon(answer.champ, 'reveal-champ'), abilityIcon),
      el('div', { class: 'reveal-text' },
        el('strong', {}, answer.champ.name),
        el('span', {}, `${slotName(answer.slot)} · ${answer.abilityName}`)),
    );

    const yours = $('fb-yours');
    if (guess?.champ && result !== 'correct') {
      const showSlot = this.slots.length > 1 && guess.slot;
      yours.textContent = `You answered ${guess.champ.name}${showSlot ? ` · ${slotName(guess.slot)}` : ''}`;
      yours.hidden = false;
    } else {
      yours.hidden = true;
    }
    $('fb-points').textContent = `+${fmt(points)}`;

    const boardNode = $('fb-board');
    if (board) {
      boardNode.replaceChildren(...board.map((p) => el('div', { class: `board-row${p.id === myId ? ' me' : ''}` },
        el('span', { class: 'board-rank' }, `#${p.rank}`),
        el('span', { class: 'board-name' }, p.name),
        el('span', { class: `board-gain ${p.result || ''}` }, p.points ? `+${fmt(p.points)}` : '—'),
        el('span', { class: 'board-score' }, fmt(p.score)))));
      boardNode.hidden = false;
    } else {
      boardNode.hidden = true;
    }

    const next = $('fb-next');
    const countdown = $('fb-countdown');
    clearInterval(this.countdownTimer);
    if (board) {
      // Multiplayer advances on the server's clock.
      next.hidden = true;
      let left = Math.max(1, Math.round(pauseSec || 5));
      const label = () => `${isLast ? 'Final results' : 'Next question'} in ${left}…`;
      countdown.textContent = label();
      countdown.hidden = false;
      this.countdownTimer = setInterval(() => {
        left = Math.max(0, left - 1);
        countdown.textContent = left ? label() : 'Loading…';
      }, 1000);
    } else {
      next.hidden = false;
      next.textContent = isLast ? 'See results' : 'Next question';
      countdown.hidden = true;
    }

    this.feedbackOpen = true;
    $('feedback').classList.add('show');
    (board ? $('fb-replay') : next).focus({ preventScroll: true });
  },

  hideFeedback() {
    clearInterval(this.countdownTimer);
    this.feedbackOpen = false;
    $('feedback').classList.remove('show');
  },
};

// ---- Shared game behaviour --------------------------------------------------

class Game {
  constructor() {
    this.clip = null;
    this.alive = true;
  }

  get current() { return this.alive && app.game === this; }

  async playClip() {
    if (!this.clip) return false;
    const ok = await app.player.play(this.clip, {
      onProgress: (p) => { if (this.current) view.setProgress(p); },
      onEnd: () => {
        if (this.current && this.clip) view.setState('ready', 'Space or the button replays it');
      },
    });
    if (!this.current) return ok;
    if (ok) view.setState('playing', 'Listen…');
    else view.setState('ready', 'Press play to hear the sound');
    return ok;
  }

  togglePlay() {
    if (!this.clip) return;
    if (app.player.playing) app.player.stop();
    else this.playClip();
  }

  replay() {
    if (!this.clip) return;
    if (app.player.playing) app.player.stop();
    else app.player.play(this.clip);
  }

  end() {
    this.alive = false;
    app.player.stop();
    view.hideFeedback();
  }
}

// ---- Solo -------------------------------------------------------------------

class SoloGame extends Game {
  constructor(options) {
    super();
    this.options = options;          // { count, pool, timed }
    const sample = sampleQuestions(app.roster, options.count, options.pool);
    this.questions = sample.questions;
    this.reserve = sample.reserve;
    this.pick = sample.pick;
    this.slots = POOLS[options.pool].slots;
    this.index = 0;
    this.score = 0;
    this.answers = [];
    this.loads = [];
    this.phase = 'loading';          // loading | asking | feedback | error | done
    this.timer = new Countdown(
      (fraction, ms) => { if (this.current) view.setTimer(fraction, ms); },
      () => this.finishQuestion({ result: 'timeout', points: 0, guess: null }),
    );
  }

  get total() { return this.questions.length; }

  // Loads question i's sound and ability details. If the clip turns out to be
  // missing, silent or oversized, a champion from the reserve takes its place.
  ensure(i) {
    if (i >= this.total) return null;
    if (!this.loads[i]) this.loads[i] = this.loadWithFallback(i);
    return this.loads[i];
  }

  async loadWithFallback(i) {
    let networkFailures = 0;
    for (;;) {
      const q = this.questions[i];
      try {
        // Skip abilities the game client no longer has a preview for: the CDN
        // may still serve an old clip, and it would be the wrong sound.
        const listed = await app.roster.clipSlots(q.champ);
        if (listed && !listed.has(q.slot)) throw new ClipError('missing', 'no current preview clip');
        const [clip, abilities] = await Promise.all([
          app.loader.load(q.champ.key, q.slot),
          app.roster.abilities(q.champ),
        ]);
        const ability = abilities[q.slot];
        if (!ability) throw new ClipError('missing', 'no ability data');
        q.abilityName = ability.name;
        q.abilityIcon = ability.icon;
        return clip;
      } catch (err) {
        const reason = err instanceof ClipError ? err.reason : 'network';
        if (reason === 'network') {
          // A connection problem won't be fixed by trying another champion.
          if (++networkFailures >= 2) throw err;
          continue;
        }
        const substitute = this.reserve.shift();
        if (!substitute) throw err;
        this.questions[i] = this.pick(substitute);
      }
    }
  }

  async begin() {
    const i = this.index;
    this.phase = 'loading';
    this.clip = null;
    this.timer.reset();
    view.setup({ index: i, total: this.total, score: this.score, timed: this.options.timed, slots: this.slots });

    let clip;
    try {
      clip = await this.ensure(i);
    } catch {
      // The failure may be left over from a background preload during a
      // network blip, so try once more before bothering the player.
      if (!this.current || this.index !== i) return;
      this.loads[i] = null;
      try {
        clip = await this.ensure(i);
      } catch {
        if (!this.current || this.index !== i) return;
        this.phase = 'error';
        view.showLoadError("Couldn't load the sound. Check your connection and try again.");
        return;
      }
    }
    if (!this.current || this.index !== i) return;

    this.clip = clip;
    this.phase = 'asking';
    view.setClip(clip);
    view.setFormEnabled(true);
    picker.focus();

    // Fetch the next sounds in the background so they start instantly.
    this.ensure(i + 1)?.catch(() => {});
    this.ensure(i + 2)?.catch(() => {});

    await this.playClip();
  }

  // The clock only starts once the player can actually hear the sound.
  async playClip() {
    const ok = await super.playClip();
    if (ok && this.current && this.phase === 'asking' && this.options.timed && !this.timer.running && this.timer.frozen === 1) {
      this.timer.start(CONFIG.questionTimeSec * 1000);
    }
    return ok;
  }

  retryLoad() {
    this.loads[this.index] = null;
    this.begin();
  }

  submit(champ, slot) {
    if (this.phase !== 'asking') return;
    const q = this.questions[this.index];
    const scored = scoreAnswer({
      championCorrect: champ.id === q.champ.id,
      abilityCorrect: slot === q.slot,
      timeFraction: this.options.timed ? this.timer.fraction : 1,
    });
    this.finishQuestion({ ...scored, guess: { champ, slot } });
  }

  skip() {
    if (this.phase !== 'asking') return;
    this.finishQuestion({ result: 'skipped', points: 0, guess: null });
  }

  finishQuestion({ result, points, guess }) {
    if (this.phase !== 'asking' || !this.current) return;
    this.phase = 'feedback';
    this.timer.stop();
    app.player.stop();
    const q = this.questions[this.index];
    this.score += points;
    this.answers.push({ question: q, result, points, guess });
    $('q-score').textContent = fmt(this.score);
    view.setFormEnabled(false);
    view.showFeedback({
      result, points, guess,
      answer: { champ: q.champ, slot: q.slot, abilityName: q.abilityName, abilityIcon: q.abilityIcon },
      isLast: this.index + 1 >= this.total,
    });
  }

  next() {
    if (this.phase !== 'feedback') return;
    app.player.stop();
    if (this.index + 1 < this.total) {
      this.index++;
      this.begin();
    } else {
      this.finish();
    }
  }

  finish() {
    this.phase = 'done';
    this.end();
    const correct = this.answers.filter((a) => a.result === 'correct').length;
    this.isBest = save.recordGame(this.options, this.score, this.total * 1000, correct);
    app.lastSolo = this;
    app.game = null;
    renderResults(this);
    show('results');
  }

  quit() {
    this.timer.stop();
    this.end();
    app.game = null;
    showStart();
  }
}

// ---- Solo results -----------------------------------------------------------

function rankTitle(pct) {
  if (pct >= 90) return 'Challenger ears';
  if (pct >= 75) return 'Diamond ears';
  if (pct >= 55) return 'Gold ears';
  if (pct >= 35) return 'Silver ears';
  if (pct >= 15) return 'Bronze ears';
  return 'Iron ears';
}

function renderResults(game) {
  const max = game.total * 1000;
  const pct = Math.round((game.score / max) * 100);
  const count = (r) => game.answers.filter((a) => a.result === r).length;
  const missed = game.total - count('correct') - count('partial');

  $('final-score').textContent = fmt(game.score);
  $('final-total').textContent = `/ ${fmt(max)}`;
  $('rank-title').textContent = rankTitle(pct);
  const parts = [`${count('correct')} correct`];
  if (game.slots.length > 1) parts.push(`${count('partial')} champion only`);
  parts.push(`${missed} missed`);
  $('results-stats').textContent = parts.join(' · ');
  $('best-badge').hidden = !game.isBest;

  // Only timed games are comparable, so only those go on the global board.
  $('submit-card').hidden = !game.options.timed;
  $('score-name').value = save.name;
  $('submit-score-btn').disabled = false;
  $('submit-score-btn').textContent = 'Post score';
  $('submit-status').textContent = '';
  $('submit-status').className = 'submit-status';

  const marks = { correct: '✓', partial: '½', wrong: '✗', skipped: '–', timeout: '⏱' };
  $('review-list').replaceChildren(...game.answers.map((a) => {
    const q = a.question;
    const playBtn = el('button', { class: 'review-play', type: 'button', title: 'Play this sound', 'aria-label': `Play ${q.champ.name} ${slotName(q.slot)}` }, '▶');
    playBtn.addEventListener('click', () => playReview(q, playBtn));
    let note = '';
    if (a.result === 'skipped') note = 'Skipped';
    else if (a.result === 'timeout') note = 'Ran out of time';
    else if (a.result !== 'correct' && a.guess) {
      note = `You said ${a.guess.champ.name}${game.slots.length > 1 ? ` · ${slotName(a.guess.slot)}` : ''}`;
    }
    return el('div', { class: `review-item ${a.result}` },
      el('span', { class: 'review-mark' }, marks[a.result] || ''),
      champIcon(q.champ),
      el('div', { class: 'review-info' },
        el('div', { class: 'review-answer' }, `${q.champ.name} · ${slotName(q.slot)}`),
        el('div', { class: 'review-sub' }, note ? `${q.abilityName} — ${note}` : q.abilityName)),
      el('span', { class: 'review-points' }, `+${fmt(a.points)}`),
      playBtn);
  }));
}

async function playReview(question, button) {
  app.player.unlock();
  if (button.classList.contains('playing')) { app.player.stop(); return; }
  button.disabled = true;
  try {
    const clip = await app.loader.load(question.champ.key, question.slot);
    button.disabled = false;
    if (app.screen !== 'results') return;
    const ok = await app.player.play(clip, { onEnd: () => button.classList.remove('playing') });
    if (ok) button.classList.add('playing');
  } catch {
    button.disabled = false;
    toast("Couldn't load that sound.");
  }
}

// ---- Multiplayer ------------------------------------------------------------

const STATUS_TEXT = {
  idle: 'Game server',
  connecting: 'Connecting to the game server…',
  waking: 'Waking the game server… this can take a minute',
  online: 'Game server online',
  outdated: 'Game server is updating. Try again in a few minutes',
  offline: "Can't reach the game server",
};

function setServerStatus(state) {
  const pill = $('server-status');
  pill.dataset.state = state;
  pill.textContent = STATUS_TEXT[state] || STATUS_TEXT.idle;
}

class MpGame extends Game {
  constructor(client) {
    super();
    this.client = client;
    this.inLobby = false;
    this.players = [];
    this.settings = { questionCount: 10, pool: 'basic' };
    this.maxPlayers = 8;
    this.index = -1;
    this.total = 0;
    this.score = 0;
    this.timeLimit = CONFIG.questionTimeSec;
    this.phase = 'lobby';            // lobby | loading | playing | answered | reveal | over
    this.loadToken = null;
    this.timer = new Countdown((fraction, ms) => { if (this.current) view.setTimer(fraction, ms); });

    client
      .on('lobby', (m) => this.onLobby(m))
      .on('player_update', (m) => this.onPlayers(m.players))
      .on('preparing', () => { $('waiting-note').textContent = 'Picking sounds…'; $('start-game-btn').disabled = true; })
      .on('game_start', (m) => this.onGameStart(m))
      .on('question', (m) => this.onQuestion(m))
      .on('go', (m) => this.onGo(m))
      .on('player_answered', (m) => { $('mp-answered').textContent = `${m.answered}/${m.total} answered`; })
      .on('reveal', (m) => this.onReveal(m))
      .on('game_over', (m) => this.onGameOver(m))
      .on('back_to_lobby', (m) => { this.phase = 'lobby'; this.onPlayers(m.players); show('waiting'); })
      .on('error', (m) => this.onError(m))
      .on('disconnected', () => this.onDisconnected());
  }

  get slots() { return (POOLS[this.settings.pool] || POOLS.basic).slots; }

  onLobby(m) {
    this.inLobby = true;
    this.client.playerId = m.playerId;
    this.client.code = m.code;
    this.settings = m.settings || this.settings;
    this.maxPlayers = m.maxPlayers || 8;
    $('room-code').textContent = m.code;
    const pool = POOLS[this.settings.pool] || POOLS.basic;
    $('lobby-settings').textContent = `${this.settings.questionCount} questions · ${pool.label} (${pool.hint})`;
    this.onPlayers(m.players);
    setBusy(false);
    show('waiting');
  }

  onPlayers(players) {
    this.players = players;
    const me = players.find((p) => p.id === this.client.playerId);
    this.client.isHost = !!me?.isHost;
    $('player-count').textContent = `${players.length}/${this.maxPlayers}`;
    $('player-list').replaceChildren(...players.map((p) => el('div', { class: `player-item${p.isHost ? ' host' : ''}` },
      el('span', { class: 'player-avatar' }, (p.name[0] || '?').toUpperCase()),
      el('span', { class: 'player-name' }, p.name, p.id === this.client.playerId ? el('span', { class: 'muted' }, ' (you)') : null),
      p.isHost ? el('span', { class: 'host-badge' }, 'Host') : null)));

    const startBtn = $('start-game-btn');
    startBtn.hidden = !this.client.isHost;
    startBtn.disabled = players.length < 2;
    $('waiting-note').textContent = this.client.isHost
      ? (players.length < 2 ? 'Share the code. You need at least 2 players.' : 'Everyone here? Start when ready.')
      : 'Waiting for the host to start…';
    $('mp-play-again-btn').hidden = !this.client.isHost;
    $('mp-results-note').textContent = this.client.isHost ? '' : 'Waiting for the host to start another round…';
  }

  onGameStart(m) {
    this.total = m.total;
    this.timeLimit = m.timeLimit || CONFIG.questionTimeSec;
    if (m.pool) this.settings.pool = m.pool;
    this.score = 0;
    this.index = -1;
    app.game = this;
    show('quiz');
  }

  async onQuestion(m) {
    app.game = this;
    if (app.screen !== 'quiz') show('quiz');
    app.player.stop();
    this.timer.reset();
    this.index = m.index;
    this.total = m.total;
    this.timeLimit = m.timeLimit || this.timeLimit;
    this.phase = 'loading';
    this.clip = null;
    const token = Symbol('question');
    this.loadToken = token;
    view.setup({ index: m.index, total: m.total, score: this.score, timed: true, slots: this.slots });
    view.setTimer(1, this.timeLimit * 1000);

    let clip = null;
    let reason = null;
    try {
      clip = await app.loader.load(m.clip.key, m.clip.slot);
    } catch (err) {
      reason = err instanceof ClipError ? err.reason : 'network';
    }
    if (!this.current || this.loadToken !== token) return;   // the server has moved on
    this.clip = clip;
    this.client.send({ type: 'ready', index: m.index, ok: !!clip, reason });
    if (clip) {
      view.setClip(clip);
      view.setState('ready', 'Waiting for the other players…');
    } else {
      view.setState('error', "This sound wouldn't load on your device");
    }
    // If the round already started while we were downloading, join it now.
    if (this.phase === 'playing' && clip) this.playClip();
  }

  onGo(m) {
    if (m.index !== this.index || this.phase !== 'loading') return;
    this.phase = 'playing';
    this.timer.start((m.timeLimit || this.timeLimit) * 1000);
    view.setFormEnabled(true);
    picker.focus();
    if (this.clip) this.playClip();
    else if ($('sound-card').dataset.state === 'loading') view.setState('loading', 'Still loading the sound…');
  }

  submit(champ, slot) {
    if (this.phase !== 'playing') return;
    this.phase = 'answered';
    this.guess = { champ, slot };
    this.client.send({ type: 'answer', index: this.index, championId: champ.id, ability: slot });
    view.lock('Locked in. Waiting for the other players…');
  }

  skip() {
    if (this.phase !== 'playing') return;
    this.phase = 'answered';
    this.guess = null;
    this.client.send({ type: 'skip', index: this.index });
    view.lock('Skipped. Waiting for the other players…');
  }

  async onReveal(m) {
    if (!this.current) return;
    this.phase = 'reveal';
    this.loadToken = null;
    this.timer.stop();
    app.player.stop();
    view.setFormEnabled(false);

    const mine = m.results.find((r) => r.id === this.client.playerId);
    const myBoard = m.scoreboard.find((p) => p.id === this.client.playerId);
    if (myBoard) this.score = myBoard.score;
    $('q-score').textContent = fmt(this.score);

    const champ = app.roster.byId.get(m.answer.championId)
      || { id: m.answer.championId, key: '0', name: m.answer.championName };
    const answer = { champ, slot: m.answer.slot, abilityName: m.answer.abilityName, abilityIcon: null };
    const guessChamp = mine?.championId ? app.roster.byId.get(mine.championId) : null;
    const roundPoints = new Map(m.results.map((r) => [r.id, r]));
    view.showFeedback({
      result: mine?.result || 'timeout',
      points: mine?.points || 0,
      answer,
      guess: guessChamp ? { champ: guessChamp, slot: mine.ability } : null,
      isLast: m.index + 1 >= m.total,
      board: m.scoreboard.map((p) => ({ ...p, points: roundPoints.get(p.id)?.points || 0, result: roundPoints.get(p.id)?.result })),
      myId: this.client.playerId,
      pauseSec: m.pause,
    });

    // Start downloading the next sound while everyone reads the answer.
    if (m.next) app.loader.load(m.next.key, m.next.slot).catch(() => {});

    // The ability icon is a nicety: add it when it arrives.
    try {
      const abilities = await app.roster.abilities(champ);
      const icon = abilities[m.answer.slot]?.icon;
      if (icon && this.current && this.phase === 'reveal' && this.index === m.index) {
        const img = document.querySelector('#fb-reveal .reveal-ability');
        if (img) { img.src = icon; img.hidden = false; }
      }
    } catch { /* icon is optional */ }
  }

  onGameOver(m) {
    this.phase = 'over';
    this.timer.stop();
    app.player.stop();
    view.hideFeedback();
    const top = m.scoreboard.filter((p) => p.rank === 1);
    $('winner').replaceChildren(
      el('div', { class: 'winner-crown', 'aria-hidden': 'true' }, '👑'),
      el('div', { class: 'winner-name' }, top.map((p) => p.name).join(' & ')),
      el('div', { class: 'winner-score' }, `${fmt(top[0]?.score || 0)} / ${fmt(m.maxScore)} points`));
    $('mp-board').replaceChildren(...m.scoreboard.map((p) => el('div', {
      class: `board-row big${p.id === this.client.playerId ? ' me' : ''}${p.rank === 1 ? ' first' : ''}`,
    },
      el('span', { class: 'board-rank' }, ['🥇', '🥈', '🥉'][p.rank - 1] || `#${p.rank}`),
      el('span', { class: 'board-name' }, p.name),
      el('span', { class: 'board-score' }, `${fmt(p.score)} pts`))));
    this.onPlayers(this.players);
    show('mpResults');
  }

  onError(m) {
    toast(m.message || 'Something went wrong.');
    if (m.code === 'expired') this.leave();
    else if (!this.inLobby) this.dispose();   // e.g. wrong code: stay on the lobby screen
  }

  onDisconnected() {
    toast('Lost connection to the game server.');
    this.leave();
  }

  // The reveal overlay has no Next button in multiplayer; the server advances.
  next() {}

  quit() { this.leave(); }

  // Closes the connection without changing screens.
  dispose() {
    this.timer.stop();
    this.client.send({ type: 'leave' });
    this.client.close();
    this.end();
    if (app.game === this) app.game = null;
    if (app.mp === this) app.mp = null;
    setBusy(false);
  }

  leave() {
    this.dispose();
    showStart();
  }
}

function setBusy(busy) {
  $('create-lobby-btn').disabled = busy;
  $('join-lobby-btn').disabled = busy;
}

// Wakes the server if needed, connects, then runs `action` (create or join).
async function openLobby(action) {
  const nameInput = $('player-name');
  const name = nameInput.value.trim();
  if (!name) { toast('Enter your name first.'); nameInput.focus(); return; }
  save.name = name;
  app.player.unlock();     // we are inside a click, so sound is allowed from here on
  setBusy(true);

  const status = await wakeServer(setServerStatus);
  if (app.screen !== 'lobby') { setBusy(false); return; }
  if (!status.ok) { toast("Couldn't reach the game server. Try again in a minute."); setBusy(false); return; }
  if (status.outdated) { toast('The game server is updating. Try again in a few minutes.'); setBusy(false); return; }

  const client = new LobbyClient();
  try {
    await client.connect();
  } catch {
    toast("Couldn't connect to the game server. Try again.");
    setBusy(false);
    return;
  }
  app.mp?.dispose();
  setBusy(true);
  app.mp = new MpGame(client);
  action(client, name);
}

// ---- Leaderboard ------------------------------------------------------------

const lb = { scope: null, count: null, requestId: 0 };

function openLeaderboard() {
  $('leaderboard').classList.add('show');
  renderLeaderboard();
  $('lb-close').focus({ preventScroll: true });
}

async function renderLeaderboard() {
  const body = $('lb-body');
  const count = Number(lb.count.value);
  const requestId = ++lb.requestId;
  const row = (rank, name, score, meta, extra = '') => el('div', { class: `board-row${extra}` },
    el('span', { class: 'board-rank' }, ['🥇', '🥈', '🥉'][rank - 1] || `#${rank}`),
    el('span', { class: 'board-name' }, name),
    el('span', { class: 'board-meta' }, meta),
    el('span', { class: 'board-score' }, fmt(score)));
  const empty = (text) => body.replaceChildren(el('p', { class: 'lb-empty' }, text));

  if (lb.scope.value === 'mine') {
    $('lb-note').textContent = 'Saved in this browser only.';
    const games = save.games.filter((g) => g.count === count).sort((a, b) => b.score - a.score).slice(0, 30);
    if (!games.length) { empty(`No ${count}-question games yet. Go play one.`); return; }
    body.replaceChildren(...games.map((g, i) => row(
      i + 1,
      new Date(g.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      g.score,
      `${POOLS[g.pool]?.label || ''}${g.timed ? '' : ' · untimed'}`)));
    return;
  }

  $('lb-note').textContent = 'The global board lives on a free server and starts over whenever that server restarts. Your own games are always kept under "Your games".';
  body.replaceChildren(el('div', { class: 'loading-spinner small' }), el('p', { class: 'lb-empty' }, 'Loading…'));
  const status = await wakeServer((state) => {
    if (requestId === lb.requestId && state === 'waking') {
      body.replaceChildren(el('div', { class: 'loading-spinner small' }), el('p', { class: 'lb-empty' }, 'Waking the server… this can take a minute.'));
    }
  });
  if (requestId !== lb.requestId) return;
  if (!status.ok) { empty("Couldn't reach the leaderboard server. Try again in a minute."); return; }
  try {
    const entries = await fetchLeaderboard(count);
    if (requestId !== lb.requestId) return;
    if (!Array.isArray(entries) || !entries.length) { empty(`No ${count}-question scores yet. Be the first.`); return; }
    body.replaceChildren(...entries.map((e, i) => row(
      i + 1,
      String(e.name || 'Player'),
      Number(e.score) || 0,
      `${POOLS[e.pool]?.label || 'Q W E R'} · ${e.mode === 'multiplayer' ? 'Lobby' : 'Solo'}`,
      i < 3 ? ` top${i + 1}` : '')));
  } catch {
    if (requestId === lb.requestId) empty("Couldn't load the leaderboard. Try again in a minute.");
  }
}

async function postScore() {
  const game = app.lastSolo;
  if (!game) return;
  const input = $('score-name');
  const name = input.value.trim();
  if (!name) { input.focus(); view.nudge(input); return; }
  save.name = name;
  const btn = $('submit-score-btn');
  const status = $('submit-status');
  btn.disabled = true;
  btn.textContent = 'Posting…';
  status.className = 'submit-status';
  status.textContent = '';
  const fail = (text) => {
    status.textContent = text;
    status.classList.add('error');
    btn.disabled = false;
    btn.textContent = 'Post score';
  };
  const wake = await wakeServer((state) => {
    if (state === 'waking') status.textContent = 'Waking the server… this can take a minute.';
  });
  if (!wake.ok) { fail("Couldn't reach the leaderboard server. Try again in a minute."); return; }
  try {
    const result = await submitScore({ name, score: game.score, questions: game.total, pool: game.options.pool });
    status.textContent = `Posted. You're #${result.rank} for ${game.total}-question games.`;
    status.classList.add('ok');
    btn.textContent = 'Posted';
  } catch (err) {
    fail(err.message && !/HTTP|fetch|abort|timeout/i.test(err.message) ? err.message : "Couldn't post the score. Try again.");
  }
}

// ---- Start screen -----------------------------------------------------------

const startOptions = {};

function currentOptions() {
  return {
    count: Number(startOptions.count.value),
    pool: startOptions.pool.value,
    timed: startOptions.timed.value === 'on',
  };
}

function refreshStartHints() {
  const options = currentOptions();
  save.options = options;
  const what = {
    ult: 'Ultimates only: just name the champion.',
    basic: 'Any Q, W, E or R. Name the champion and the ability.',
    all: 'Everything, including passives. Some are very subtle.',
  }[options.pool];
  const best = save.best(options);
  const hint = [what];
  if (best) hint.push(' ', el('span', { class: 'best-line' }, `Your best: ${fmt(best.score)} / ${fmt(best.maxScore)}`));
  $('option-hint').replaceChildren(...hint);
  $('start-btn').textContent = options.timed ? 'Start Quiz' : 'Start Practice';
}

function showStart() {
  refreshStartHints();
  show('start');
}

function startSolo() {
  app.player.unlock();   // inside the click, so the first sound may autoplay
  if (app.game) app.game.end();
  const game = new SoloGame(currentOptions());
  app.game = game;
  show('quiz');
  game.begin();
}

// ---- Wiring -----------------------------------------------------------------

function trySubmit() {
  const game = app.game;
  if (!game || !view.formEnabled) return;
  if (!picker.selected) { picker.focus(); view.nudge($('combo')); return; }
  if (!view.selectedSlot) { view.nudge($('ability-row')); return; }
  game.submit(picker.selected, view.selectedSlot);
}

function wireEvents() {
  // Start screen
  const saved = save.options;
  startOptions.count = segmented($('opt-count'), CONFIG.questionCounts.includes(saved.count) ? saved.count : CONFIG.defaultCount, refreshStartHints);
  startOptions.pool = segmented($('opt-pool'), POOLS[saved.pool] ? saved.pool : 'basic', refreshStartHints);
  startOptions.timed = segmented($('opt-timed'), saved.timed === false ? 'off' : 'on', refreshStartHints);
  $('start-btn').addEventListener('click', startSolo);
  $('leaderboard-btn').addEventListener('click', openLeaderboard);
  $('multiplayer-btn').addEventListener('click', () => {
    $('player-name').value = save.name;
    show('lobby');
    wakeServer(setServerStatus);
  });

  // Quiz screen
  picker = new ChampionPicker({
    input: $('champ-input'),
    list: $('champ-list'),
    icon: $('combo-icon'),
    combo: $('combo'),
    onChange: () => view.validate(),
    onChoose: () => {
      // Move focus off the text field so Q/W/E/R/P pick the ability.
      $('champ-input').blur();
      $('answer-form').focus({ preventScroll: true });
    },
    onCommit: trySubmit,
  });
  $('answer-form').addEventListener('submit', (e) => { e.preventDefault(); trySubmit(); });
  for (const b of abilityButtons()) {
    b.addEventListener('click', (e) => {
      view.selectAbility(b.dataset.slot);
      if (e.detail > 0) b.blur();    // mouse click: keep the keyboard shortcuts live
    });
  }
  $('play-btn').addEventListener('click', (e) => {
    app.player.unlock();
    app.game?.togglePlay();
    if (e.detail > 0) e.currentTarget.blur();
  });
  $('skip-btn').addEventListener('click', () => app.game?.skip());
  $('quit-btn').addEventListener('click', () => app.game?.quit());
  $('load-retry-btn').addEventListener('click', () => app.game?.retryLoad?.());
  $('fb-next').addEventListener('click', () => { app.player.unlock(); app.game?.next(); });
  $('fb-replay').addEventListener('click', () => { app.player.unlock(); app.game?.replay(); });

  const volume = $('volume');
  volume.value = String(save.volume);
  app.player.setVolume(save.volume);
  volume.addEventListener('input', () => {
    const v = Number(volume.value);
    app.player.setVolume(v);
    save.volume = v;
  });

  // Keyboard shortcuts on the quiz screen.
  document.addEventListener('keydown', (e) => {
    if (app.screen !== 'quiz' || !app.game || e.ctrlKey || e.metaKey || e.altKey) return;
    if (view.feedbackOpen) {
      // Enter / Space press the focused button; R replays the sound.
      if (e.key.toLowerCase() === 'r') { e.preventDefault(); app.game.replay(); }
      return;
    }
    const target = e.target;
    if (target instanceof HTMLInputElement && target.type === 'text') return;
    const key = e.key.toUpperCase();
    // Ability letters only act as shortcuts for abilities this quiz can ask about.
    if (view.slots.length > 1 && view.slots.includes(key)) { e.preventDefault(); view.selectAbility(key); return; }
    const onButton = target instanceof HTMLButtonElement;
    if (e.key === ' ' && !onButton) { e.preventDefault(); app.game.togglePlay(); }
    else if (e.key === 'Enter' && !onButton) { e.preventDefault(); trySubmit(); }
    else if (view.formEnabled && (e.key === 'Backspace' || /^[a-z']$/i.test(e.key))) {
      // Any other letter means "I want to change the champion": jump back to
      // the field with its text selected, so typing replaces it.
      if (e.key === 'Backspace') e.preventDefault();
      picker.focus();
      $('champ-input').select();
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => view.drawWave(), 100);
  });

  // Solo results
  $('play-again-btn').addEventListener('click', startSolo);
  $('menu-btn').addEventListener('click', () => { app.player.stop(); showStart(); });
  $('submit-score-btn').addEventListener('click', postScore);
  $('score-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') postScore(); });

  // Leaderboard
  lb.scope = segmented($('lb-scope'), 'global', renderLeaderboard);
  lb.count = segmented($('lb-count'), CONFIG.defaultCount, renderLeaderboard);
  const closeLeaderboard = () => { lb.requestId++; $('leaderboard').classList.remove('show'); };
  $('lb-close').addEventListener('click', closeLeaderboard);
  $('leaderboard').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLeaderboard(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('leaderboard').classList.contains('show')) closeLeaderboard();
  });

  // Multiplayer lobby
  const mpCount = segmented($('mp-opt-count'), CONFIG.defaultCount);
  const mpPool = segmented($('mp-opt-pool'), 'basic');
  $('create-lobby-btn').addEventListener('click', () => {
    openLobby((client, name) => client.create(name, Number(mpCount.value), mpPool.value));
  });
  const join = () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter the 4-character room code.'); $('join-code').focus(); return; }
    openLobby((client, name) => client.join(name, code));
  };
  $('join-lobby-btn').addEventListener('click', join);
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('back-to-start-btn').addEventListener('click', () => {
    if (app.mp) app.mp.leave(); else showStart();
  });
  $('start-game-btn').addEventListener('click', () => {
    app.player.unlock();
    app.mp?.client.send({ type: 'start' });
  });
  const copy = async (button, text) => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = label; }, 1500);
  };
  $('copy-code-btn').addEventListener('click', (e) => copy(e.currentTarget, $('room-code').textContent));
  $('copy-link-btn').addEventListener('click', (e) => {
    const url = new URL(location.href);
    url.search = `?join=${$('room-code').textContent}`;
    url.hash = '';
    copy(e.currentTarget, url.toString());
  });
  $('leave-lobby-btn').addEventListener('click', () => app.mp?.leave());
  $('mp-leave-btn').addEventListener('click', () => app.mp?.leave());
  $('mp-play-again-btn').addEventListener('click', () => {
    app.player.unlock();
    app.mp?.client.send({ type: 'play_again' });
  });
}

// ---- Boot -------------------------------------------------------------------

async function boot() {
  $('loading-retry').hidden = true;
  $('loading-spinner').hidden = false;
  $('loading-text').textContent = 'Loading champions…';
  try {
    app.roster = await Roster.load();
  } catch {
    $('loading-spinner').hidden = true;
    $('loading-text').textContent = "Couldn't reach Riot's data servers. Check your connection.";
    $('loading-retry').hidden = false;
    return;
  }

  if (!boot.wired) { wireEvents(); boot.wired = true; }
  const n = app.roster.champions.length;
  $('roster-note').textContent = `${n} champions · patch ${app.roster.patch}${app.roster.stale ? ' (offline copy)' : ''} · real in-game audio from Riot's ability previews`;

  // An invite link (?join=CODE) goes straight to the lobby screen.
  const invite = new URLSearchParams(location.search).get('join');
  if (invite && /^[A-Za-z0-9]{4}$/.test(invite)) {
    $('join-code').value = invite.toUpperCase();
    $('player-name').value = save.name;
    refreshStartHints();
    show('lobby');
    wakeServer(setServerStatus);
    history.replaceState(null, '', location.pathname);
  } else {
    showStart();
    // The free server sleeps when idle. Nudge it now so the leaderboard and
    // lobbies are ready by the time anyone wants them.
    wakeServer();
  }
}

$('loading-retry').addEventListener('click', boot);
boot();

// Handy when debugging from the console.
window.lsq = app;
