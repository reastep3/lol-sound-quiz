// ============================================
//  LoL Sound Quiz – Main Application
// ============================================

// --------------- Configuration ---------------
const CONFIG = {
  defaultLength: 10,
  maxReplays: 5,
  ddragonBase: 'https://ddragon.leagueoflegends.com/cdn',
  ddragonVersionUrl: 'https://ddragon.leagueoflegends.com/api/versions.json',
  wsUrl: (() => {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'ws://localhost:8080';
    }
    return 'wss://lol-sound-quiz.onrender.com';
  })(),
};

// ---- Ability Video CDN (Riot's CloudFront) ----------------------------------
// The ability preview videos on Riot's CDN contain the real in-game SFX + VO.
// URL format: https://d28xe8vt774jo5.cloudfront.net/champion-abilities/{paddedId}/ability_{paddedId}_{slot}1.webm
// The app extracts the audio track from the video for playback.
// championKeyMap is populated at startup from Data Dragon.
// -----------------------------------------------------------------------------
const ABILITY_VIDEO_CDN = 'https://d28xe8vt774jo5.cloudfront.net/champion-abilities';
let championKeyMap = {};  // populated at init: champion display name → numeric key string

function getAbilityVideoUrl(championName, abilityKey) {
  const numericKey = championKeyMap[championName];
  if (!numericKey) return null;
  const paddedId = numericKey.padStart(4, '0');
  const slot = abilityKey === 'Passive' ? 'P' : abilityKey;
  return `${ABILITY_VIDEO_CDN}/${paddedId}/ability_${paddedId}_${slot}1.webm`;
}

// --------------- Sound Pool --------------------------------------------------
// Each entry is one possible quiz question.
// championId must match the Data Dragon id (for icons).
const SOUND_POOL = [
  // Ahri
  { champion:'Ahri', championId:'Ahri', key:'Q', name:'Orb of Deception' },
  { champion:'Ahri', championId:'Ahri', key:'E', name:'Charm' },
  { champion:'Ahri', championId:'Ahri', key:'R', name:'Spirit Rush' },
  // Akali
  { champion:'Akali', championId:'Akali', key:'Q', name:'Five Point Strike' },
  { champion:'Akali', championId:'Akali', key:'E', name:'Shuriken Flip' },
  { champion:'Akali', championId:'Akali', key:'R', name:'Perfect Execution' },
  // Aatrox
  { champion:'Aatrox', championId:'Aatrox', key:'Q', name:'The Darkin Blade' },
  { champion:'Aatrox', championId:'Aatrox', key:'R', name:'World Ender' },
  // Annie
  { champion:'Annie', championId:'Annie', key:'Q', name:'Disintegrate' },
  { champion:'Annie', championId:'Annie', key:'R', name:'Summon: Tibbers' },
  // Ashe
  { champion:'Ashe', championId:'Ashe', key:'W', name:'Volley' },
  { champion:'Ashe', championId:'Ashe', key:'R', name:'Enchanted Crystal Arrow' },
  // Bard
  { champion:'Bard', championId:'Bard', key:'Q', name:'Cosmic Binding' },
  { champion:'Bard', championId:'Bard', key:'R', name:'Tempered Fate' },
  // Blitzcrank
  { champion:'Blitzcrank', championId:'Blitzcrank', key:'Q', name:'Rocket Grab' },
  { champion:'Blitzcrank', championId:'Blitzcrank', key:'R', name:'Static Field' },
  // Brand
  { champion:'Brand', championId:'Brand', key:'W', name:'Pillar of Flame' },
  { champion:'Brand', championId:'Brand', key:'R', name:'Pyroclasm' },
  // Caitlyn
  { champion:'Caitlyn', championId:'Caitlyn', key:'Q', name:'Piltover Peacemaker' },
  { champion:'Caitlyn', championId:'Caitlyn', key:'R', name:'Ace in the Hole' },
  // Darius
  { champion:'Darius', championId:'Darius', key:'Q', name:'Decimate' },
  { champion:'Darius', championId:'Darius', key:'R', name:'Noxian Guillotine' },
  // Draven
  { champion:'Draven', championId:'Draven', key:'Q', name:'Spinning Axe' },
  { champion:'Draven', championId:'Draven', key:'R', name:'Whirling Death' },
  // Ekko
  { champion:'Ekko', championId:'Ekko', key:'Q', name:'Timewinder' },
  { champion:'Ekko', championId:'Ekko', key:'W', name:'Parallel Convergence' },
  { champion:'Ekko', championId:'Ekko', key:'R', name:'Chronobreak' },
  // Ezreal
  { champion:'Ezreal', championId:'Ezreal', key:'Q', name:'Mystic Shot' },
  { champion:'Ezreal', championId:'Ezreal', key:'R', name:'Trueshot Barrage' },
  // Fiora
  { champion:'Fiora', championId:'Fiora', key:'W', name:'Riposte' },
  { champion:'Fiora', championId:'Fiora', key:'R', name:'Grand Challenge' },
  // Fizz
  { champion:'Fizz', championId:'Fizz', key:'E', name:'Playful / Trickster' },
  { champion:'Fizz', championId:'Fizz', key:'R', name:'Chum the Waters' },
  // Garen
  { champion:'Garen', championId:'Garen', key:'Q', name:'Decisive Strike' },
  { champion:'Garen', championId:'Garen', key:'E', name:'Judgment' },
  { champion:'Garen', championId:'Garen', key:'R', name:'Demacian Justice' },
  // Irelia
  { champion:'Irelia', championId:'Irelia', key:'Q', name:'Bladesurge' },
  { champion:'Irelia', championId:'Irelia', key:'R', name:"Vanguard's Edge" },
  // Jhin
  { champion:'Jhin', championId:'Jhin', key:'Passive', name:'Whisper' },
  { champion:'Jhin', championId:'Jhin', key:'W', name:'Deadly Flourish' },
  { champion:'Jhin', championId:'Jhin', key:'R', name:'Curtain Call' },
  // Jinx
  { champion:'Jinx', championId:'Jinx', key:'W', name:'Zap!' },
  { champion:'Jinx', championId:'Jinx', key:'E', name:'Flame Chompers!' },
  { champion:'Jinx', championId:'Jinx', key:'R', name:'Super Mega Death Rocket!' },
  // Kai'Sa
  { champion:"Kai'Sa", championId:'Kaisa', key:'Q', name:'Icathian Rain' },
  { champion:"Kai'Sa", championId:'Kaisa', key:'R', name:'Killer Instinct' },
  // Katarina
  { champion:'Katarina', championId:'Katarina', key:'E', name:'Shunpo' },
  { champion:'Katarina', championId:'Katarina', key:'R', name:'Death Lotus' },
  // Kayn
  { champion:'Kayn', championId:'Kayn', key:'Q', name:'Reaping Slash' },
  { champion:'Kayn', championId:'Kayn', key:'R', name:'Umbral Trespass' },
  // Kha'Zix
  { champion:"Kha'Zix", championId:'Khazix', key:'Q', name:'Taste Their Fear' },
  { champion:"Kha'Zix", championId:'Khazix', key:'R', name:'Void Assault' },
  // Lee Sin
  { champion:'Lee Sin', championId:'LeeSin', key:'Q', name:'Sonic Wave' },
  { champion:'Lee Sin', championId:'LeeSin', key:'R', name:"Dragon's Rage" },
  // Leona
  { champion:'Leona', championId:'Leona', key:'E', name:'Zenith Blade' },
  { champion:'Leona', championId:'Leona', key:'R', name:'Solar Flare' },
  // Lucian
  { champion:'Lucian', championId:'Lucian', key:'Q', name:'Piercing Light' },
  { champion:'Lucian', championId:'Lucian', key:'R', name:'The Culling' },
  // Lux
  { champion:'Lux', championId:'Lux', key:'Q', name:'Light Binding' },
  { champion:'Lux', championId:'Lux', key:'E', name:'Lucent Singularity' },
  { champion:'Lux', championId:'Lux', key:'R', name:'Final Spark' },
  // Malzahar
  { champion:'Malzahar', championId:'Malzahar', key:'R', name:'Nether Grasp' },
  { champion:'Malzahar', championId:'Malzahar', key:'Q', name:'Call of the Void' },
  // Miss Fortune
  { champion:'Miss Fortune', championId:'MissFortune', key:'Q', name:'Double Up' },
  { champion:'Miss Fortune', championId:'MissFortune', key:'R', name:'Bullet Time' },
  // Mordekaiser
  { champion:'Mordekaiser', championId:'Mordekaiser', key:'Q', name:'Obliterate' },
  { champion:'Mordekaiser', championId:'Mordekaiser', key:'R', name:'Realm of Death' },
  // Morgana
  { champion:'Morgana', championId:'Morgana', key:'Q', name:'Dark Binding' },
  { champion:'Morgana', championId:'Morgana', key:'R', name:'Soul Shackles' },
  // Orianna
  { champion:'Orianna', championId:'Orianna', key:'Q', name:'Command: Attack' },
  { champion:'Orianna', championId:'Orianna', key:'R', name:'Command: Shockwave' },
  // Pyke
  { champion:'Pyke', championId:'Pyke', key:'Q', name:'Bone Skewer' },
  { champion:'Pyke', championId:'Pyke', key:'R', name:'Death from Below' },
  // Rengar
  { champion:'Rengar', championId:'Rengar', key:'R', name:'Thrill of the Hunt' },
  { champion:'Rengar', championId:'Rengar', key:'Q', name:'Savagery' },
  // Riven
  { champion:'Riven', championId:'Riven', key:'Q', name:'Broken Wings' },
  { champion:'Riven', championId:'Riven', key:'W', name:'Ki Burst' },
  { champion:'Riven', championId:'Riven', key:'R', name:'Blade of the Exile' },
  // Senna
  { champion:'Senna', championId:'Senna', key:'Q', name:'Piercing Darkness' },
  { champion:'Senna', championId:'Senna', key:'R', name:'Dawning Shadow' },
  // Sett
  { champion:'Sett', championId:'Sett', key:'W', name:'Haymaker' },
  { champion:'Sett', championId:'Sett', key:'R', name:'The Show Stopper' },
  // Soraka
  { champion:'Soraka', championId:'Soraka', key:'Q', name:'Starcall' },
  { champion:'Soraka', championId:'Soraka', key:'R', name:'Wish' },
  // Syndra
  { champion:'Syndra', championId:'Syndra', key:'Q', name:'Dark Sphere' },
  { champion:'Syndra', championId:'Syndra', key:'R', name:'Unleashed Power' },
  // Teemo
  { champion:'Teemo', championId:'Teemo', key:'Q', name:'Blinding Dart' },
  { champion:'Teemo', championId:'Teemo', key:'R', name:'Noxious Trap' },
  // Thresh
  { champion:'Thresh', championId:'Thresh', key:'Q', name:'Death Sentence' },
  { champion:'Thresh', championId:'Thresh', key:'W', name:'Dark Passage' },
  { champion:'Thresh', championId:'Thresh', key:'R', name:'The Box' },
  // Twisted Fate
  { champion:'Twisted Fate', championId:'TwistedFate', key:'W', name:'Pick a Card' },
  { champion:'Twisted Fate', championId:'TwistedFate', key:'R', name:'Destiny' },
  // Vayne
  { champion:'Vayne', championId:'Vayne', key:'Q', name:'Tumble' },
  { champion:'Vayne', championId:'Vayne', key:'E', name:'Condemn' },
  { champion:'Vayne', championId:'Vayne', key:'R', name:'Final Hour' },
  // Veigar
  { champion:'Veigar', championId:'Veigar', key:'E', name:'Event Horizon' },
  { champion:'Veigar', championId:'Veigar', key:'R', name:'Primordial Burst' },
  // Vi
  { champion:'Vi', championId:'Vi', key:'Q', name:'Vault Breaker' },
  { champion:'Vi', championId:'Vi', key:'R', name:'Assault and Battery' },
  // Viego
  { champion:'Viego', championId:'Viego', key:'R', name:'Heartbreaker' },
  { champion:'Viego', championId:'Viego', key:'Q', name:'Blade of the Ruined King' },
  // Viktor
  { champion:'Viktor', championId:'Viktor', key:'E', name:'Death Ray' },
  { champion:'Viktor', championId:'Viktor', key:'R', name:'Chaos Storm' },
  // Yasuo
  { champion:'Yasuo', championId:'Yasuo', key:'Q', name:'Steel Tempest' },
  { champion:'Yasuo', championId:'Yasuo', key:'W', name:'Wind Wall' },
  { champion:'Yasuo', championId:'Yasuo', key:'R', name:'Last Breath' },
  // Yone
  { champion:'Yone', championId:'Yone', key:'Q', name:'Mortal Steel' },
  { champion:'Yone', championId:'Yone', key:'E', name:'Soul Unbound' },
  { champion:'Yone', championId:'Yone', key:'R', name:'Fate Sealed' },
  // Zed
  { champion:'Zed', championId:'Zed', key:'Q', name:'Razor Shuriken' },
  { champion:'Zed', championId:'Zed', key:'W', name:'Living Shadow' },
  { champion:'Zed', championId:'Zed', key:'R', name:'Death Mark' },
  // Zoe
  { champion:'Zoe', championId:'Zoe', key:'Q', name:'Paddle Star' },
  { champion:'Zoe', championId:'Zoe', key:'E', name:'Sleepy Trouble Bubble' },
  // Yuumi
  { champion:'Yuumi', championId:'Yuumi', key:'Q', name:'Prowling Projectile' },
  { champion:'Yuumi', championId:'Yuumi', key:'R', name:'Final Chapter' },
];

// --------------- Helpers -----------------------------------------------------

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Simple seeded PRNG (mulberry32)
function seededRandom(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------- Sound Engine ------------------------------------------------

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.currentNodes = [];
    this.currentAudio = null;     // tracks <audio> element for stop()
  }

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  stop() {
    // Stop Web Audio nodes
    this.currentNodes.forEach((n) => {
      try { n.stop(); } catch (_) { /* already stopped */ }
    });
    this.currentNodes = [];
    // Stop HTML Audio element
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
    }
    this.playing = false;
  }

  // Returns a Promise that resolves when the sound finishes.
  // Tries the ability video URL first; falls back to synthesiser on error.
  play(champion, key) {
    this.init();
    this.stop();
    this.playing = true;

    const videoUrl = getAbilityVideoUrl(champion, key);
    if (videoUrl) {
      return this._playVideo(videoUrl).catch((err) => {
        console.warn(`Video failed for ${champion} ${key}, falling back to synth`, err?.message);
        return this._synthesize(champion, key);
      });
    }
    return this._synthesize(champion, key);
  }

  // ---------- Video-based playback (audio only) ----------
  _playVideo(url) {
    return new Promise((resolve, reject) => {
      // Reuse or create hidden video element
      if (!this._videoEl) {
        this._videoEl = document.createElement('video');
        this._videoEl.style.display = 'none';
        this._videoEl.preload = 'auto';
        document.body.appendChild(this._videoEl);
      }
      const vid = this._videoEl;
      this.currentAudio = vid;  // for stop()

      const cleanup = () => {
        vid.onended = null;
        vid.onerror = null;
      };
      vid.onended = () => { cleanup(); this.playing = false; this.currentAudio = null; resolve(); };
      vid.onerror = () => { cleanup(); this.playing = false; this.currentAudio = null; reject(new Error('video load failed')); };

      vid.src = url;
      vid.load();
      vid.play().catch(reject);
    });
  }

  // ---------- Synthesised playback ----------
  _synthesize(champion, key) {
    const ctx = this.ctx;
    const seed = hashString(champion + '_' + key);
    const rng = seededRandom(seed);

    // Derive champion "voice" parameters
    const baseFreq = 140 + rng() * 460;                     // 140-600 Hz
    const waveforms = ['sine', 'triangle', 'sawtooth', 'square'];
    const waveIdx = Math.floor(rng() * waveforms.length);
    const wave = waveforms[waveIdx];
    const modRate = 2 + rng() * 12;
    const detune = (rng() - 0.5) * 40;
    const noiseAmt = 0.05 + rng() * 0.15;

    // Ability-type envelopes
    const profiles = {
      Passive: { attack: 0.15, sustain: 0.8, release: 0.6, duration: 1.8, layers: 2 },
      Q:       { attack: 0.02, sustain: 0.15, release: 0.25, duration: 0.55, layers: 2 },
      W:       { attack: 0.06, sustain: 0.35, release: 0.3, duration: 0.8, layers: 2 },
      E:       { attack: 0.01, sustain: 0.1, release: 0.2, duration: 0.5, layers: 1 },
      R:       { attack: 0.04, sustain: 0.5, release: 0.6, duration: 1.6, layers: 3 },
    };
    const p = profiles[key] || profiles.Q;
    const now = ctx.currentTime;
    const end = now + p.duration;
    const nodes = [];

    // Master gain
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);

    // ---- Layer 1: primary oscillator ----
    const osc1 = ctx.createOscillator();
    osc1.type = wave;
    osc1.frequency.value = baseFreq;
    osc1.detune.value = detune;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.7, now + p.attack);
    g1.gain.setValueAtTime(0.7, now + p.attack + p.sustain);
    g1.gain.linearRampToValueAtTime(0, end);
    osc1.connect(g1).connect(master);
    osc1.start(now);
    osc1.stop(end + 0.05);
    nodes.push(osc1);

    // Frequency envelope per ability type
    if (key === 'E') {
      // Sweep up or down
      const dir = rng() > 0.5 ? 1 : -1;
      osc1.frequency.setValueAtTime(baseFreq, now);
      osc1.frequency.exponentialRampToValueAtTime(
        Math.max(20, baseFreq + dir * 300), end
      );
    }
    if (key === 'R') {
      // Dramatic drop then rise
      osc1.frequency.setValueAtTime(baseFreq * 1.5, now);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.5, now + 0.3);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 1.2, end - 0.2);
    }

    // ---- Layer 2: modulated harmonic ----
    if (p.layers >= 2) {
      const osc2 = ctx.createOscillator();
      const w2 = waveforms[(waveIdx + 1) % waveforms.length];
      osc2.type = w2;
      osc2.frequency.value = baseFreq * (1.5 + rng() * 1.0); // harmonic
      osc2.detune.value = -detune;

      // LFO for tremolo
      const lfo = ctx.createOscillator();
      lfo.frequency.value = modRate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.3;
      lfo.connect(lfoGain).connect(osc2.frequency);
      lfo.start(now);
      lfo.stop(end + 0.05);
      nodes.push(lfo);

      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, now);
      g2.gain.linearRampToValueAtTime(0.3, now + p.attack * 1.5);
      g2.gain.setValueAtTime(0.3, now + p.attack + p.sustain * 0.8);
      g2.gain.linearRampToValueAtTime(0, end);
      osc2.connect(g2).connect(master);
      osc2.start(now);
      osc2.stop(end + 0.05);
      nodes.push(osc2);
    }

    // ---- Layer 3 (ultimates): sub-bass + shimmer ----
    if (p.layers >= 3) {
      // Sub-bass
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = baseFreq * 0.25;
      const gSub = ctx.createGain();
      gSub.gain.setValueAtTime(0, now);
      gSub.gain.linearRampToValueAtTime(0.5, now + 0.1);
      gSub.gain.linearRampToValueAtTime(0.2, now + 0.5);
      gSub.gain.linearRampToValueAtTime(0, end);
      sub.connect(gSub).connect(master);
      sub.start(now);
      sub.stop(end + 0.05);
      nodes.push(sub);

      // High shimmer
      const shim = ctx.createOscillator();
      shim.type = 'sine';
      shim.frequency.value = baseFreq * 3;
      const gShim = ctx.createGain();
      gShim.gain.setValueAtTime(0, now + 0.2);
      gShim.gain.linearRampToValueAtTime(0.15, now + 0.6);
      gShim.gain.linearRampToValueAtTime(0, end);
      shim.connect(gShim).connect(master);
      shim.start(now);
      shim.stop(end + 0.05);
      nodes.push(shim);
    }

    // ---- Noise layer ----
    if (noiseAmt > 0.08) {
      const bufSize = ctx.sampleRate * p.duration;
      const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      const nRng = seededRandom(seed + 999);
      for (let i = 0; i < bufSize; i++) data[i] = nRng() * 2 - 1;

      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = baseFreq * (1 + rng() * 2);
      filt.Q.value = 1 + rng() * 4;
      const gN = ctx.createGain();
      gN.gain.setValueAtTime(0, now);
      gN.gain.linearRampToValueAtTime(noiseAmt, now + p.attack);
      gN.gain.setValueAtTime(noiseAmt, now + p.attack + p.sustain * 0.5);
      gN.gain.linearRampToValueAtTime(0, end);
      noiseSrc.connect(filt).connect(gN).connect(master);
      noiseSrc.start(now);
      noiseSrc.stop(end + 0.05);
      nodes.push(noiseSrc);
    }

    this.currentNodes = nodes;

    return new Promise((resolve) => {
      setTimeout(() => {
        this.playing = false;
        resolve();
      }, p.duration * 1000 + 80);
    });
  }
}

// --------------- Quiz Engine -------------------------------------------------

class QuizEngine {
  constructor() {
    this.questions = [];
    this.currentIndex = 0;
    this.answers = [];
    this.score = 0;
    this.length = CONFIG.defaultLength;
  }

  generate(length) {
    this.length = length;
    this.currentIndex = 0;
    this.answers = [];
    this.score = 0;

    const pool = shuffleArray(SOUND_POOL);

    // Pick unique champion+key combos, avoiding repeating the same champion
    // back-to-back when possible.
    const picked = [];
    const used = new Set();
    for (const entry of pool) {
      const id = `${entry.champion}_${entry.key}`;
      if (!used.has(id)) {
        picked.push({ ...entry });
        used.add(id);
      }
      if (picked.length >= length) break;
    }

    // If pool is too small, allow dupes
    while (picked.length < length) {
      picked.push({ ...SOUND_POOL[Math.floor(Math.random() * SOUND_POOL.length)] });
    }

    this.questions = shuffleArray(picked);
  }

  current() {
    return this.questions[this.currentIndex] || null;
  }

  submitAnswer(championGuess, keyGuess) {
    const q = this.current();
    if (!q) return null;

    const champCorrect = championGuess.trim().toLowerCase() === q.champion.toLowerCase();
    const keyCorrect = keyGuess === q.key;

    let points = 0;
    let result = 'wrong';
    if (champCorrect && keyCorrect) { points = 2; result = 'correct'; }
    else if (champCorrect)          { points = 1; result = 'partial'; }

    this.score += points;
    const answer = {
      question: q,
      championGuess,
      keyGuess,
      champCorrect,
      keyCorrect,
      points,
      result,
      skipped: false,
    };
    this.answers.push(answer);
    return answer;
  }

  skip() {
    const q = this.current();
    const answer = {
      question: q,
      championGuess: '',
      keyGuess: '',
      champCorrect: false,
      keyCorrect: false,
      points: 0,
      result: 'skipped',
      skipped: true,
    };
    this.answers.push(answer);
    return answer;
  }

  next() {
    this.currentIndex++;
    return this.currentIndex < this.questions.length;
  }

  isComplete() {
    return this.currentIndex >= this.questions.length;
  }

  maxScore() {
    return this.length * 2;
  }
}

// --------------- Autocomplete ------------------------------------------------

class Autocomplete {
  constructor(inputEl, dropdownEl, champions, version) {
    this.input = inputEl;
    this.dropdown = dropdownEl;
    this.champions = champions; // [{id, name}]
    this.version = version;
    this.highlighted = -1;
    this.filtered = [];
    this.selectedName = '';

    this.input.addEventListener('input', () => this._onInput());
    this.input.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.input.addEventListener('focus', () => { if (this.input.value) this._onInput(); });
    document.addEventListener('click', (e) => {
      if (!this.input.contains(e.target) && !this.dropdown.contains(e.target)) {
        this.close();
      }
    });
  }

  _onInput() {
    const val = this.input.value.trim().toLowerCase();
    this.selectedName = this.input.value.trim();
    if (!val) { this.close(); return; }

    this.filtered = this.champions
      .filter((c) => c.name.toLowerCase().includes(val))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(val) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(val) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 8);

    this.highlighted = -1;
    this._render(val);
  }

  _render(query) {
    if (this.filtered.length === 0) { this.close(); return; }

    const imgBase = `${CONFIG.ddragonBase}/${this.version}/img/champion`;
    this.dropdown.innerHTML = this.filtered.map((c, i) => {
      const hl = i === this.highlighted ? ' highlighted' : '';
      const name = this._highlightMatch(c.name, query);
      return `<div class="autocomplete-item${hl}" data-index="${i}">
        <img src="${imgBase}/${c.id}.png" alt="" loading="lazy" width="28" height="28">
        <span class="champ-name">${name}</span>
      </div>`;
    }).join('');

    this.dropdown.querySelectorAll('.autocomplete-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._select(Number(el.dataset.index));
      });
    });

    this.dropdown.classList.add('show');
  }

  _highlightMatch(name, query) {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    return name.slice(0, idx) + '<mark>' + name.slice(idx, idx + query.length) + '</mark>' + name.slice(idx + query.length);
  }

  _select(index) {
    const champ = this.filtered[index];
    if (!champ) return;
    this.input.value = champ.name;
    this.selectedName = champ.name;
    this.close();
    this.input.dispatchEvent(new Event('change'));
  }

  _onKeyDown(e) {
    if (!this.dropdown.classList.contains('show')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.highlighted = Math.min(this.highlighted + 1, this.filtered.length - 1);
      this._render(this.input.value.trim().toLowerCase());
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.highlighted = Math.max(this.highlighted - 1, 0);
      this._render(this.input.value.trim().toLowerCase());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.highlighted >= 0) {
        this._select(this.highlighted);
      }
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  close() {
    this.dropdown.classList.remove('show');
    this.highlighted = -1;
  }

  getValue() {
    return this.input.value.trim();
  }

  reset() {
    this.input.value = '';
    this.selectedName = '';
    this.close();
  }
}

// --------------- Multiplayer Client ------------------------------------------

class MultiplayerClient {
  constructor() {
    this.ws = null;
    this.playerId = null;
    this.lobbyCode = null;
    this.isHost = false;
    this.playerName = '';
    this.playerCount = 0;
    this._handlers = {};
    this._pingInterval = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try { this.ws = new WebSocket(CONFIG.wsUrl); }
      catch (e) { return reject(e); }
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      this.ws.onopen = () => { clearTimeout(timeout); resolve(); };
      this.ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); };
      this.ws.onmessage = (e) => {
        try { const msg = JSON.parse(e.data); this._emit(msg.type, msg); } catch {}
      };
      this.ws.onclose = () => this._emit('disconnected', {});
    });
  }

  on(type, fn) { if (!this._handlers[type]) this._handlers[type] = []; this._handlers[type].push(fn); return this; }
  _emit(type, data) { (this._handlers[type] || []).forEach(fn => fn(data)); }
  _send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  create(name, questionCount) { this.playerName = name; this._send({ type: 'create', name, questionCount }); }
  join(name, code) { this.playerName = name; this._send({ type: 'join', name, code: code.toUpperCase() }); }
  startGame() { this._send({ type: 'start' }); }
  answer(champion, ability) { this._send({ type: 'answer', champion, ability }); }
  skip() { this._send({ type: 'skip' }); }
  playAgain() { this._send({ type: 'play_again' }); }
  disconnect() { this.stopPing(); if (this.ws) { this.ws.close(); this.ws = null; } this.playerId = null; this.lobbyCode = null; this.isHost = false; this._handlers = {}; }
  startPing() { this._pingInterval = setInterval(() => this._send({ type: 'ping' }), 25000); }
  stopPing() { clearInterval(this._pingInterval); }
}

// --------------- UI Controller -----------------------------------------------

class UIController {
  constructor() {
    // Screens
    this.screens = {
      loading:   document.getElementById('loading-screen'),
      start:     document.getElementById('start-screen'),
      quiz:      document.getElementById('quiz-screen'),
      results:   document.getElementById('results-screen'),
      lobby:     document.getElementById('lobby-screen'),
      waiting:   document.getElementById('waiting-screen'),
      mpResults: document.getElementById('mp-results-screen'),
    };

    // Quiz elements
    this.questionCounter = document.getElementById('question-counter');
    this.scoreDisplay    = document.getElementById('score-display');
    this.progressFill    = document.getElementById('progress-fill');
    this.playBtn         = document.getElementById('play-btn');
    this.waveform        = document.getElementById('waveform');
    this.playCount       = document.getElementById('play-count');
    this.championInput   = document.getElementById('champion-input');
    this.abilityBtns     = document.querySelectorAll('.ability-btn');
    this.submitBtn       = document.getElementById('submit-btn');
    this.skipBtn         = document.getElementById('skip-btn');

    // Feedback
    this.feedbackOverlay = document.getElementById('feedback-overlay');
    this.feedbackCard    = document.getElementById('feedback-card');
    this.feedbackIcon    = document.getElementById('feedback-icon');
    this.feedbackTitle   = document.getElementById('feedback-title');
    this.feedbackDetails = document.getElementById('feedback-details');
    this.feedbackScore   = document.getElementById('feedback-score');
    this.nextBtn         = document.getElementById('next-btn');

    // Multiplayer elements
    this.mpStatus     = document.getElementById('mp-status');
    this.timerValue   = document.getElementById('timer-value');
    this.timerFill    = document.getElementById('timer-fill');
    this.mpAnsweredEl = document.getElementById('mp-answered');

    // State
    this.selectedAbility = '';
    this.replayCount = 0;
    this.multiplayerMode = false;
  }

  showScreen(name) {
    Object.values(this.screens).forEach((s) => s.classList.remove('active'));
    if (this.screens[name]) {
      this.screens[name].classList.add('active');
      this.screens[name].style.animation = 'none';
      // trigger reflow
      void this.screens[name].offsetWidth;
      this.screens[name].style.animation = '';
    }
  }

  // -- Quiz --

  renderQuestion(question, index, total, score) {
    this.questionCounter.textContent = `Question ${index + 1} / ${total}`;
    this.scoreDisplay.textContent = `Score: ${score}`;
    this.progressFill.style.width = `${((index) / total) * 100}%`;

    // Reset form
    this.championInput.value = '';
    this.selectedAbility = '';
    this.abilityBtns.forEach((b) => b.classList.remove('selected'));
    this.submitBtn.disabled = true;
    this.replayCount = 0;
    this.playCount.textContent = 'Click to play';
    this.waveform.classList.remove('active');
    this.playBtn.querySelector('.play-icon').style.display = '';
    this.playBtn.querySelector('.pause-icon').style.display = 'none';
    this.playBtn.classList.remove('playing');
    this.feedbackOverlay.classList.remove('show');
    this.championInput.focus();
  }

  setPlaying(isPlaying) {
    const playIcon  = this.playBtn.querySelector('.play-icon');
    const pauseIcon = this.playBtn.querySelector('.pause-icon');
    if (isPlaying) {
      playIcon.style.display = 'none';
      pauseIcon.style.display = '';
      this.playBtn.classList.add('playing');
      this.waveform.classList.add('active');
    } else {
      playIcon.style.display = '';
      pauseIcon.style.display = 'none';
      this.playBtn.classList.remove('playing');
      this.waveform.classList.remove('active');
    }
  }

  updatePlayCount(count, max) {
    this.playCount.textContent = `Played ${count} / ${max}`;
  }

  selectAbility(key) {
    this.selectedAbility = key;
    this.abilityBtns.forEach((b) => {
      b.classList.toggle('selected', b.dataset.key === key);
    });
    this._validateForm();
  }

  _validateForm() {
    const hasChampion = this.championInput.value.trim().length > 0;
    const hasAbility  = this.selectedAbility !== '';
    this.submitBtn.disabled = !(hasChampion && hasAbility);
  }

  onInputChange() {
    this._validateForm();
  }

  showFeedback(answer, ddragonVersion) {
    const { question, championGuess, keyGuess, result, points } = answer;
    this.feedbackCard.className = `feedback-card ${result}`;

    const icons = { correct: '\u2714\uFE0F', partial: '\u2764\uFE0F', wrong: '\u274C', skipped: '\u23ED\uFE0F' };
    const titles = {
      correct: 'Perfect!',
      partial: 'Close!',
      wrong: 'Wrong',
      skipped: 'Skipped',
    };
    this.feedbackIcon.textContent = icons[result] || '';
    this.feedbackTitle.textContent = titles[result] || '';

    // Build details
    const imgBase = `${CONFIG.ddragonBase}/${ddragonVersion}/img/champion`;
    let detailsHTML = `
      <div class="answer-line">
        <span class="answer-label">Correct answer</span>
        <span class="answer-value correct-value">${question.champion} – ${question.key}: ${question.name}</span>
      </div>`;
    if (!answer.skipped) {
      const champClass = answer.champCorrect ? 'correct-value' : 'wrong-value';
      const keyClass   = answer.keyCorrect   ? 'correct-value' : 'wrong-value';
      detailsHTML += `
      <div class="answer-line">
        <span class="answer-label">Your champion</span>
        <span class="answer-value ${champClass}">${championGuess || '—'}</span>
      </div>
      <div class="answer-line">
        <span class="answer-label">Your ability</span>
        <span class="answer-value ${keyClass}">${keyGuess || '—'}</span>
      </div>`;
    }
    this.feedbackDetails.innerHTML = detailsHTML;

    this.feedbackScore.textContent = `+${points} point${points !== 1 ? 's' : ''}`;
    this.feedbackOverlay.classList.add('show');
  }

  // -- Results --

  renderResults(quiz, ddragonVersion) {
    const score = quiz.score;
    const max   = quiz.maxScore();
    const pct   = Math.round((score / max) * 100);

    document.getElementById('final-score-number').textContent = score;
    document.getElementById('final-score-total').textContent  = `/ ${max}`;
    document.getElementById('score-percent').textContent       = `${pct}%`;

    // Stars
    const starCount = pct >= 90 ? 5 : pct >= 70 ? 4 : pct >= 50 ? 3 : pct >= 30 ? 2 : pct >= 10 ? 1 : 0;
    document.getElementById('score-stars').textContent = '\u2B50'.repeat(starCount) + '\u2606'.repeat(5 - starCount);

    // Message
    const msgs = [
      [90, 'Challenger-level ears! Incredible.'],
      [70, 'Diamond-tier sound knowledge!'],
      [50, 'Solid performance. Keep practicing!'],
      [30, 'Not bad. You know some of them!'],
      [0,  'Time to spend more hours on the Rift!'],
    ];
    document.getElementById('score-message').textContent = msgs.find(([t]) => pct >= t)[1];

    // Results list
    const imgBase = `${CONFIG.ddragonBase}/${ddragonVersion}/img/champion`;
    const listEl = document.getElementById('results-list');
    listEl.innerHTML = quiz.answers.map((a, i) => {
      const q = a.question;
      const icons = { correct: '\u2714', partial: '\u2248', wrong: '\u2718', skipped: '\u2014' };
      return `
      <div class="result-item ${a.result}">
        <div class="result-icon">${icons[a.result]}</div>
        <div class="result-info">
          <div class="result-answer">${a.skipped ? 'Skipped' : `${a.championGuess} – ${a.keyGuess}`}</div>
          <div class="result-correct">${q.champion} ${q.key} — ${q.name}</div>
        </div>
        <div class="result-points">+${a.points}</div>
      </div>`;
    }).join('');
  }

  // -- Multiplayer UI --

  renderWaitingRoom(code, players, isHost) {
    document.getElementById('room-code').textContent = code;
    document.getElementById('player-count').textContent = players.length;
    const listEl = document.getElementById('player-list');
    listEl.innerHTML = players.map(p => `
      <div class="player-item ${p.isHost ? 'host' : ''}">
        <span class="player-avatar">${p.name.charAt(0).toUpperCase()}</span>
        <span class="player-name">${p.name}</span>
        ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
      </div>
    `).join('');

    const startBtn = document.getElementById('start-game-btn');
    const waitNote = document.getElementById('waiting-note');
    if (isHost) {
      startBtn.style.display = '';
      startBtn.disabled = players.length < 2;
      waitNote.textContent = players.length < 2 ? 'Need at least 2 players to start' : '';
    } else {
      startBtn.style.display = 'none';
      waitNote.textContent = 'Waiting for the host to start...';
    }
  }

  renderMpQuestion(data, score) {
    this.multiplayerMode = true;
    this.mpStatus.style.display = '';
    this.timerValue.textContent = '15';
    this.timerValue.classList.remove('urgent');
    this.timerFill.style.width = '100%';
    this.timerFill.classList.remove('urgent');
    this.mpAnsweredEl.textContent = '';

    this.questionCounter.textContent = `Question ${data.index + 1} / ${data.total}`;
    this.scoreDisplay.textContent = `Score: ${score}`;
    this.progressFill.style.width = `${(data.index / data.total) * 100}%`;

    // Reset form
    this.championInput.value = '';
    this.selectedAbility = '';
    this.abilityBtns.forEach(b => b.classList.remove('selected'));
    this.submitBtn.disabled = true;
    this.replayCount = 0;
    this.playCount.textContent = 'Click to play';
    this.waveform.classList.remove('active');
    this.playBtn.querySelector('.play-icon').style.display = '';
    this.playBtn.querySelector('.pause-icon').style.display = 'none';
    this.playBtn.classList.remove('playing');
    this.feedbackOverlay.classList.remove('show');
    this.nextBtn.style.display = 'none'; // hide in multiplayer (auto-advance)

    // Re-enable form
    this.enableAnswerForm();
    this.championInput.focus();
  }

  updateTimer(timeLeft) {
    this.timerValue.textContent = timeLeft;
    this.timerFill.style.width = `${(timeLeft / 15) * 100}%`;
    if (timeLeft <= 5) {
      this.timerValue.classList.add('urgent');
      this.timerFill.classList.add('urgent');
    } else {
      this.timerValue.classList.remove('urgent');
      this.timerFill.classList.remove('urgent');
    }
  }

  updateMpAnswered(count, total) {
    this.mpAnsweredEl.textContent = `${count}/${total} answered`;
  }

  showMpReveal(data, myId) {
    const myResult = data.results.find(r => r.id === myId);
    const result = myResult?.result || 'skipped';
    this.feedbackCard.className = `feedback-card ${result}`;

    const icons = { correct: '\u2714\uFE0F', partial: '\u2764\uFE0F', wrong: '\u274C', skipped: '\u23ED\uFE0F' };
    const titles = { correct: 'Perfect!', partial: 'Close!', wrong: 'Wrong', skipped: 'Skipped' };
    this.feedbackIcon.textContent = icons[result] || '';
    this.feedbackTitle.textContent = titles[result] || '';

    let html = `<div class="answer-line">
      <span class="answer-label">Correct answer</span>
      <span class="answer-value correct-value">${data.champion} \u2013 ${data.abilityKey}: ${data.abilityName}</span>
    </div>`;

    html += '<div class="reveal-scoreboard">';
    data.scoreboard.forEach((p, i) => {
      const isMe = p.id === myId;
      html += `<div class="reveal-player ${isMe ? 'me' : ''}">
        <span class="reveal-rank">#${i + 1}</span>
        <span class="reveal-name">${p.name}</span>
        <span class="reveal-score">${p.score}</span>
      </div>`;
    });
    html += '</div>';

    this.feedbackDetails.innerHTML = html;
    this.feedbackScore.textContent = myResult ? `+${myResult.points} point${myResult.points !== 1 ? 's' : ''}` : '';
    this.nextBtn.style.display = 'none';
    this.feedbackOverlay.classList.add('show');
  }

  showMpResults(scoreboard, maxScore, myId, isHost) {
    const winner = scoreboard[0];
    document.getElementById('winner-announcement').innerHTML = `
      <div class="winner-crown">\uD83D\uDC51</div>
      <div class="winner-name">${winner.name}</div>
      <div class="winner-score">${winner.score} / ${maxScore} points</div>
    `;

    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    document.getElementById('leaderboard-list').innerHTML = scoreboard.map(p => {
      const isMe = p.id === myId;
      const medal = p.rank <= 3 ? medals[p.rank - 1] : `#${p.rank}`;
      return `<div class="leaderboard-item ${isMe ? 'me' : ''} rank-${p.rank}">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name">${p.name}</span>
        <span class="lb-score">${p.score} pts</span>
      </div>`;
    }).join('');

    document.getElementById('mp-play-again-btn').style.display = isHost ? '' : 'none';
  }

  showLobbyError(msg) {
    const el = document.getElementById('lobby-error');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  }

  disableAnswerForm() {
    this.submitBtn.disabled = true;
    this.skipBtn.disabled = true;
    this.championInput.disabled = true;
    this.abilityBtns.forEach(b => { b.disabled = true; });
  }

  enableAnswerForm() {
    this.skipBtn.disabled = false;
    this.championInput.disabled = false;
    this.abilityBtns.forEach(b => { b.disabled = false; });
    this._validateForm();
  }

  resetForSolo() {
    this.multiplayerMode = false;
    this.mpStatus.style.display = 'none';
    this.nextBtn.style.display = '';
    this.enableAnswerForm();
  }
}

// --------------- App Initialisation ------------------------------------------

(async function init() {
  const ui    = new UIController();
  const sound = new SoundEngine();
  const quiz  = new QuizEngine();
  let ddragonVersion = '14.8.1'; // fallback
  let allChampions = [];
  let autocomplete = null;

  // Multiplayer state
  let mp = null;
  let mpScore = 0;
  let mpCurrentQuestion = null;
  let mpPlayerCount = 0;
  let soundPlaying = false;

  // 1. Fetch Data Dragon version & champion list
  try {
    const vRes = await fetch(CONFIG.ddragonVersionUrl);
    const versions = await vRes.json();
    ddragonVersion = versions[0];
  } catch (e) {
    console.warn('Failed to fetch DDragon version, using fallback', e);
  }

  try {
    const cRes = await fetch(`${CONFIG.ddragonBase}/${ddragonVersion}/data/en_US/champion.json`);
    const cData = await cRes.json();
    allChampions = Object.values(cData.data).map((c) => ({
      id: c.id,
      name: c.name,
      key: c.key,
    })).sort((a, b) => a.name.localeCompare(b.name));

    // Build championKeyMap for video URLs  (name → numeric key)
    championKeyMap = {};
    allChampions.forEach((c) => { championKeyMap[c.name] = c.key; });
  } catch (e) {
    console.warn('Failed to fetch champions, using sound pool names', e);
    // Fallback: derive from sound pool
    const seen = new Set();
    SOUND_POOL.forEach((s) => {
      if (!seen.has(s.champion)) {
        seen.add(s.champion);
        allChampions.push({ id: s.championId, name: s.champion, key: '0' });
      }
    });
    allChampions.sort((a, b) => a.name.localeCompare(b.name));
  }

  // 2. Setup autocomplete
  const inputEl    = document.getElementById('champion-input');
  const dropdownEl = document.getElementById('autocomplete-dropdown');
  autocomplete = new Autocomplete(inputEl, dropdownEl, allChampions, ddragonVersion);

  // Show start screen
  ui.showScreen('start');

  // --------------- Event Listeners -------------------------------------------

  // Quiz length options
  document.querySelectorAll('#length-options .option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#length-options .option-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Start quiz
  document.getElementById('start-btn').addEventListener('click', () => {
    const activeBtn = document.querySelector('#length-options .option-btn.active');
    const length = parseInt(activeBtn?.dataset.value || CONFIG.defaultLength, 10);
    quiz.generate(length);
    ui.showScreen('quiz');
    ui.renderQuestion(quiz.current(), quiz.currentIndex, quiz.length, quiz.score);
  });

  // Play sound
  ui.playBtn.addEventListener('click', async () => {
    if (soundPlaying) {
      sound.stop();
      ui.setPlaying(false);
      soundPlaying = false;
      return;
    }
    if (ui.replayCount >= CONFIG.maxReplays) return;

    let champion, key;
    if (mp && mpCurrentQuestion) {
      champion = mpCurrentQuestion.champion;
      key = mpCurrentQuestion.abilityKey;
    } else {
      const q = quiz.current();
      if (!q) return;
      champion = q.champion;
      key = q.key;
    }

    ui.replayCount++;
    ui.updatePlayCount(ui.replayCount, CONFIG.maxReplays);
    soundPlaying = true;
    ui.setPlaying(true);

    try {
      await sound.play(champion, key);
    } catch (e) {
      console.warn('Audio playback error', e);
    }
    soundPlaying = false;
    ui.setPlaying(false);
  });

  // Ability buttons
  ui.abilityBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.selectAbility(btn.dataset.key);
    });
  });

  // Champion input validation
  inputEl.addEventListener('input', () => ui.onInputChange());
  inputEl.addEventListener('change', () => ui.onInputChange());

  // Submit answer
  ui.submitBtn.addEventListener('click', () => {
    if (ui.submitBtn.disabled) return;
    const champGuess = autocomplete.getValue();
    const keyGuess   = ui.selectedAbility;

    if (mp && mp.ws && mp.ws.readyState === WebSocket.OPEN) {
      // Multiplayer
      mp.answer(champGuess, keyGuess);
      ui.disableAnswerForm();
      return;
    }

    // Solo
    const answer = quiz.submitAnswer(champGuess, keyGuess);
    if (answer) {
      sound.stop();
      ui.setPlaying(false);
      soundPlaying = false;
      ui.showFeedback(answer, ddragonVersion);
    }
  });

  // Skip
  ui.skipBtn.addEventListener('click', () => {
    if (mp && mp.ws && mp.ws.readyState === WebSocket.OPEN) {
      mp.skip();
      ui.disableAnswerForm();
      return;
    }
    const answer = quiz.skip();
    sound.stop();
    ui.setPlaying(false);
    soundPlaying = false;
    ui.showFeedback(answer, ddragonVersion);
  });

  // Next question / finish
  ui.nextBtn.addEventListener('click', () => {
    if (quiz.next()) {
      autocomplete.reset();
      ui.renderQuestion(quiz.current(), quiz.currentIndex, quiz.length, quiz.score);
    } else {
      ui.showScreen('results');
      ui.renderResults(quiz, ddragonVersion);
    }
  });

  // Enter key submits
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !ui.submitBtn.disabled) {
      // Small delay so autocomplete can select first
      setTimeout(() => {
        if (!ui.submitBtn.disabled && !document.getElementById('autocomplete-dropdown').classList.contains('show')) {
          ui.submitBtn.click();
        }
      }, 50);
    }
  });

  // Play again
  document.getElementById('play-again-btn').addEventListener('click', () => {
    ui.showScreen('start');
  });

  // ---- Multiplayer Flow ----

  // "Play with Friends" button
  document.getElementById('multiplayer-btn').addEventListener('click', () => {
    ui.showScreen('lobby');
  });

  // Back to start from lobby
  document.getElementById('back-to-start-btn').addEventListener('click', () => {
    ui.showScreen('start');
  });

  // MP length options
  document.querySelectorAll('#mp-length-options .option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#mp-length-options .option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Force uppercase on join code input
  document.getElementById('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  function setupMpHandlers() {
    mp.on('lobby', (msg) => {
      mp.playerId = msg.playerId;
      mp.lobbyCode = msg.code;
      mp.isHost = msg.isHost;
      mp.playerCount = msg.players.length;
      mp.startPing();
      ui.showScreen('waiting');
      ui.renderWaitingRoom(msg.code, msg.players, msg.isHost);
    });

    mp.on('player_update', (msg) => {
      mp.playerCount = msg.players.length;
      const me = msg.players.find(p => p.id === mp.playerId);
      if (me) mp.isHost = me.isHost;
      ui.renderWaitingRoom(mp.lobbyCode, msg.players, mp.isHost);
    });

    mp.on('error', (msg) => {
      ui.showLobbyError(msg.message);
    });

    mp.on('game_start', (msg) => {
      mpScore = 0;
      ui.showScreen('quiz');
    });

    mp.on('question', (msg) => {
      mpCurrentQuestion = msg;
      ui.feedbackOverlay.classList.remove('show');
      ui.renderMpQuestion(msg, mpScore);

      // Auto-play the sound after a short delay
      setTimeout(async () => {
        if (!mpCurrentQuestion || mpCurrentQuestion.index !== msg.index) return;
        ui.replayCount++;
        ui.updatePlayCount(ui.replayCount, CONFIG.maxReplays);
        soundPlaying = true;
        ui.setPlaying(true);
        try {
          await sound.play(msg.champion, msg.abilityKey);
        } catch (e) {
          console.warn('Auto-play failed', e);
        }
        soundPlaying = false;
        ui.setPlaying(false);
      }, 400);
    });

    mp.on('tick', (msg) => {
      ui.updateTimer(msg.timeLeft);
    });

    mp.on('player_answered', (msg) => {
      ui.updateMpAnswered(msg.answered, mp.playerCount);
    });

    mp.on('reveal', (msg) => {
      sound.stop();
      ui.setPlaying(false);
      soundPlaying = false;
      const myResult = msg.results.find(r => r.id === mp.playerId);
      if (myResult) mpScore += myResult.points;
      ui.showMpReveal(msg, mp.playerId);
    });

    mp.on('game_over', (msg) => {
      sound.stop();
      soundPlaying = false;
      ui.feedbackOverlay.classList.remove('show');
      ui.showScreen('mpResults');
      ui.showMpResults(msg.scoreboard, msg.maxScore, mp.playerId, mp.isHost);
    });

    mp.on('back_to_lobby', (msg) => {
      mp.playerCount = msg.players.length;
      const me = msg.players.find(p => p.id === mp.playerId);
      if (me) mp.isHost = me.isHost;
      ui.showScreen('waiting');
      ui.renderWaitingRoom(mp.lobbyCode, msg.players, mp.isHost);
    });

    mp.on('disconnected', () => {
      mp.stopPing();
      ui.showLobbyError('Disconnected from server');
      setTimeout(() => ui.showScreen('start'), 1500);
      mp = null;
    });
  }

  // Create lobby
  document.getElementById('create-lobby-btn').addEventListener('click', async () => {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { ui.showLobbyError('Please enter your name'); return; }

    const lengthBtn = document.querySelector('#mp-length-options .option-btn.active');
    const questionCount = parseInt(lengthBtn?.dataset.value || '10', 10);

    try {
      if (mp) mp.disconnect();
      mp = new MultiplayerClient();
      await mp.connect();
      setupMpHandlers();
      mp.create(name, questionCount);
    } catch (e) {
      ui.showLobbyError('Could not connect to server');
      mp = null;
    }
  });

  // Join lobby
  document.getElementById('join-lobby-btn').addEventListener('click', async () => {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!name) { ui.showLobbyError('Please enter your name'); return; }
    if (!code || code.length !== 4) { ui.showLobbyError('Enter a 4-character room code'); return; }

    try {
      if (mp) mp.disconnect();
      mp = new MultiplayerClient();
      await mp.connect();
      setupMpHandlers();
      mp.join(name, code);
    } catch (e) {
      ui.showLobbyError('Could not connect to server');
      mp = null;
    }
  });

  // Start game (host only)
  document.getElementById('start-game-btn').addEventListener('click', () => {
    if (mp) mp.startGame();
  });

  // Copy room code
  document.getElementById('copy-code-btn').addEventListener('click', () => {
    const code = document.getElementById('room-code').textContent;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('copy-code-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });

  // Leave lobby / Leave results
  document.getElementById('leave-lobby-btn').addEventListener('click', () => {
    if (mp) { mp.disconnect(); mp = null; }
    ui.resetForSolo();
    ui.showScreen('start');
  });

  document.getElementById('mp-leave-btn').addEventListener('click', () => {
    if (mp) { mp.disconnect(); mp = null; }
    ui.resetForSolo();
    ui.showScreen('start');
  });

  // Play again (host only)
  document.getElementById('mp-play-again-btn').addEventListener('click', () => {
    if (mp) mp.playAgain();
  });
})();
