// Tests for the browser-side logic that doesn't need a browser:
// champion search, question selection, scoring, the audio analysis,
// and the offline bundle the Android app reads instead of the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Roster, normalize, sampleQuestions, scoreAnswer } from '../js/data.js';
import { analyzePcm, slicePcm, clipUrl, bundledClipUrl } from '../js/audio.js';
import { wakeServer } from '../js/net.js';
import { CONFIG, POOLS } from '../js/config.js';

const roster = new Roster('16.22.1', [
  ['Ahri', '103', 'Ahri'], ['Akali', '84', 'Akali'], ['AurelionSol', '136', 'Aurelion Sol'],
  ['Belveth', '200', "Bel'Veth"], ['DrMundo', '36', 'Dr. Mundo'], ['JarvanIV', '59', 'Jarvan IV'],
  ['Kaisa', '145', "Kai'Sa"], ['KSante', '897', "K'Sante"], ['Leblanc', '7', 'LeBlanc'],
  ['LeeSin', '64', 'Lee Sin'], ['Maokai', '57', 'Maokai'], ['MissFortune', '21', 'Miss Fortune'],
  ['MonkeyKing', '62', 'Wukong'], ['Nidalee', '76', 'Nidalee'], ['Nunu', '20', 'Nunu & Willump'],
  ['TwistedFate', '4', 'Twisted Fate'], ['Velkoz', '161', "Vel'Koz"], ['Warwick', '19', 'Warwick'],
].map(([id, key, name]) => ({ id, key, name })));

const names = (list) => list.map((c) => c.name);

test('normalize strips case, accents and punctuation', () => {
  assert.equal(normalize("Kai'Sa"), 'kaisa');
  assert.equal(normalize('Nunu & Willump'), 'nunuwillump');
  assert.equal(normalize('  Dr. Mundo '), 'drmundo');
});

test('search finds champions the way players type them', () => {
  assert.deepEqual(names(roster.search('kaisa')), ["Kai'Sa"]);
  assert.deepEqual(names(roster.search("k's")), ["K'Sante"]);
  assert.deepEqual(names(roster.search('velk')), ["Vel'Koz"]);
  assert.deepEqual(names(roster.search('mundo')), ['Dr. Mundo']);       // second word
  assert.deepEqual(names(roster.search('willump')), ['Nunu & Willump']);
  assert.deepEqual(names(roster.search('sol')), ['Aurelion Sol']);
  assert.deepEqual(names(roster.search('mf')), ['Miss Fortune']);       // initials
  assert.deepEqual(names(roster.search('tf')), ['Twisted Fate']);
  assert.deepEqual(names(roster.search('j4')), ['Jarvan IV']);          // nickname
  assert.deepEqual(names(roster.search('lb')), ['LeBlanc']);
  assert.deepEqual(names(roster.search('ww')), ['Warwick']);
  assert.deepEqual(names(roster.search('wukong')), ['Wukong']);
  assert.deepEqual(roster.search('zzz'), []);
  assert.deepEqual(roster.search(''), []);
});

test('search ranks name prefixes ahead of matches inside a name', () => {
  assert.deepEqual(names(roster.search('kai')), ["Kai'Sa", 'Maokai']);
  assert.deepEqual(names(roster.search('lee')), ['Lee Sin', 'Nidalee']);
  assert.equal(roster.search('a')[0].name, 'Ahri');
  assert.ok(roster.search('a', 3).length <= 3);
});

test('resolve only accepts text that names exactly one champion', () => {
  assert.equal(roster.resolve('ahr')?.name, 'Ahri');
  assert.equal(roster.resolve('kai sa')?.name, "Kai'Sa");
  assert.equal(roster.resolve('LEBLANC')?.name, 'LeBlanc');
  assert.equal(roster.resolve('j4')?.name, 'Jarvan IV');
  assert.equal(roster.resolve('a'), null);      // ambiguous
  assert.equal(roster.resolve('lee'), null);    // Lee Sin or Nidalee
  assert.equal(roster.resolve(''), null);
  assert.equal(roster.resolve('teemo'), null);  // not in this roster
});

test('roster exposes patch and icon urls', () => {
  assert.equal(roster.patch, '16.22');
  assert.equal(roster.iconUrl(roster.byId.get('MonkeyKing')),
    'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/MonkeyKing.png');
  assert.equal(roster.byKey.get('62').name, 'Wukong');
});

test('sampleQuestions never repeats a champion and respects the ability pool', () => {
  for (const pool of Object.keys(POOLS)) {
    for (let run = 0; run < 50; run++) {
      const { questions, reserve } = sampleQuestions(roster, 10, pool);
      assert.equal(questions.length, 10);
      const ids = questions.map((q) => q.champ.id);
      assert.equal(new Set(ids).size, 10, 'duplicate champion in one quiz');
      for (const q of questions) assert.ok(POOLS[pool].slots.includes(q.slot));
      assert.equal(reserve.length, roster.champions.length - 10);
      for (const c of reserve) assert.ok(!ids.includes(c.id), 'reserve overlaps the quiz');
    }
  }
});

test('sampleQuestions reaches every champion', () => {
  const seen = new Set();
  for (let run = 0; run < 300; run++) {
    for (const q of sampleQuestions(roster, 5, 'basic').questions) seen.add(q.champ.id);
  }
  assert.equal(seen.size, roster.champions.length);
});

test('scoreAnswer rewards speed and gives half for the champion alone', () => {
  const full = (f) => scoreAnswer({ championCorrect: true, abilityCorrect: true, timeFraction: f });
  assert.deepEqual(full(1), { result: 'correct', points: 1000 });
  assert.deepEqual(full(0), { result: 'correct', points: 100 });
  assert.deepEqual(full(0.5), { result: 'correct', points: 550 });
  assert.deepEqual(full(7), { result: 'correct', points: 1000 });    // clamped
  assert.deepEqual(full(-3), { result: 'correct', points: 100 });
  assert.deepEqual(scoreAnswer({ championCorrect: true, abilityCorrect: false, timeFraction: 1 }), { result: 'partial', points: 500 });
  assert.deepEqual(scoreAnswer({ championCorrect: false, abilityCorrect: true, timeFraction: 1 }), { result: 'wrong', points: 0 });
  assert.deepEqual(scoreAnswer({ championCorrect: true, abilityCorrect: true }), { result: 'correct', points: 1000 });
});

test('clipUrl builds the zero-padded Riot CDN path', () => {
  assert.equal(clipUrl('103', 'Q'), `${CONFIG.clipHost}/0103/ability_0103_Q1.webm`);
  assert.equal(clipUrl('1', 'P', { ext: 'mp4' }), `${CONFIG.clipHost}/0001/ability_0001_P1.mp4`);
  assert.equal(clipUrl('950', 'R', { host: 'https://x.test' }), 'https://x.test/0950/ability_0950_R1.webm');
});

// ---- Audio analysis ---------------------------------------------------------

const SR = 48000;
const amp = (db) => 10 ** (db / 20) * Math.SQRT2;    // sine amplitude for an RMS level in dBFS

// Builds a mono signal from [seconds, level in dBFS RMS or null for silence] parts.
function signal(parts) {
  const total = Math.round(parts.reduce((sum, [sec]) => sum + sec, 0) * SR);
  const out = new Float32Array(total);
  let pos = 0;
  for (const [sec, db] of parts) {
    const len = Math.round(sec * SR);
    if (db != null) {
      const a = amp(db);
      for (let i = 0; i < len; i++) out[pos + i] = a * Math.sin((2 * Math.PI * 440 * (pos + i)) / SR);
    }
    pos += len;
  }
  return out;
}

const near = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ~${expected}, got ${actual}`);
};

test('analyzePcm rejects clips with no real sound', () => {
  assert.equal(analyzePcm([signal([[4, null]])], SR).silent, true);
  assert.equal(analyzePcm([signal([[4, -57]])], SR).silent, true);      // faint hiss only
  assert.equal(analyzePcm([new Float32Array(0)], SR).silent, true);
  assert.equal(analyzePcm([signal([[4, -45]])], SR).silent, false);     // quiet but real
});

test('analyzePcm trims silence around the sound', () => {
  const info = analyzePcm([signal([[1, null], [1, -20], [2, null]])], SR);
  assert.equal(info.silent, false);
  near(info.startSec, 0.9, 0.03, 'start');     // 100 ms of lead-in kept
  near(info.endSec, 2.25, 0.03, 'end');        // 250 ms of tail kept
  assert.equal(info.cut, false);
  near(info.loudDb, -20, 0.5, 'loudness');
  near(info.gainDb, CONFIG.audio.targetDb + 20, 0.5, 'gain');
});

test('analyzePcm levels quiet and loud clips to the same target', () => {
  const quiet = analyzePcm([signal([[2, -40]])], SR);
  const loud = analyzePcm([signal([[2, -8]])], SR);
  near(quiet.loudDb + quiet.gainDb, CONFIG.audio.targetDb, 0.5, 'quiet clip after gain');
  near(loud.loudDb + loud.gainDb, CONFIG.audio.targetDb, 0.5, 'loud clip after gain');
  // Gain is bounded so a near-silent clip can't be boosted into pure noise.
  assert.equal(analyzePcm([signal([[2, -49.5]])], SR).gainDb, CONFIG.audio.maxGainDb);
  assert.equal(analyzePcm([signal([[2, -1]])], SR).gainDb, CONFIG.audio.minGainDb);
});

test('analyzePcm caps very long clips', () => {
  const info = analyzePcm([signal([[25, -20]])], SR);
  near(info.endSec - info.startSec, CONFIG.audio.maxPlaySec, 0.01, 'length');
  assert.equal(info.cut, true);
});

test('analyzePcm skips a long stretch of faint ambience before the ability', () => {
  // 3 s of map ambience 30 dB under the ability, then the ability itself.
  const info = analyzePcm([signal([[3, -50], [1.5, -20], [0.5, null]])], SR);
  near(info.startSec, 3 - 0.45, 0.05, 'start');
  near(info.loudDb, -20, 0.5, 'loudness');
});

test('analyzePcm keeps a short quiet lead-in (could be the start of the sound)', () => {
  const info = analyzePcm([signal([[0.6, -45], [1.5, -20]])], SR);
  near(info.startSec, 0, 0.02, 'start');
});

test('analyzePcm stops shortly after the sound instead of playing out the ambience', () => {
  const info = analyzePcm([signal([[1, -20], [6, -50]])], SR);
  near(info.endSec, 1 + 1.2, 0.05, 'end');
  assert.equal(info.cut, true);
});

test('analyzePcm measures loudness on the part that is played', () => {
  // The louder burst comes after the 10 s cap, so it must not set the gain.
  // (The first part is within 18 dB of it, so it counts as sound, not lead-in.)
  const info = analyzePcm([signal([[12, -22], [2, -8]])], SR);
  near(info.startSec, 0, 0.02, 'start');
  near(info.endSec - info.startSec, CONFIG.audio.maxPlaySec, 0.01, 'length');
  near(info.loudDb, -22, 0.6, 'loudness of played part');
});

test('analyzePcm handles stereo and returns drawable peaks', () => {
  const left = signal([[0.5, null], [1, -18], [0.5, null]]);
  const right = signal([[0.5, null], [1, -18], [0.5, null]]);
  const info = analyzePcm([left, right], SR);
  assert.equal(info.silent, false);
  assert.equal(info.peaks.length, 96);
  assert.ok(info.peaks.every((p) => p > 0 && p <= 1));
  assert.ok(Math.max(...info.peaks) === 1);
});

test('slicePcm copies just the played part and fades both ends', () => {
  const src = new Float32Array(SR * 2).fill(0.5);
  const [out] = slicePcm([src], SR, { startSec: 0.5, endSec: 1.5, cut: false });
  assert.equal(out.length, SR);
  assert.equal(out[0], 0);                              // fades in from nothing...
  near(out[Math.round(SR * 0.008)], 0.5, 1e-6, 'after the fade-in');
  near(out[SR / 2], 0.5, 1e-6, 'middle');
  assert.equal(out[SR - 1], 0);                         // ...and out to nothing
  near(out[SR - 1 - Math.round(SR * 0.03)], 0.5, 1e-6, 'before the fade-out');
  assert.equal(src[SR / 2], 0.5, 'the source is left alone');

  // Stopping mid-sound gets a much longer fade.
  const [cut] = slicePcm([src], SR, { startSec: 0, endSec: 1, cut: true });
  assert.ok(cut[SR - 1 - Math.round(SR * 0.2)] < 0.3);
});

// ---- Offline bundle ---------------------------------------------------------

const manifest = {
  version: '16.22.1',
  champions: [
    { id: 'Ahri', key: '103', name: 'Ahri', clips: 'PQWER',
      abilities: { P: { name: 'Essence Theft', icon: 'ability/Ahri_P.png' }, Q: { name: 'Orb of Deception', icon: 'ability/Ahri_Q.png' }, W: { name: 'Fox-Fire', icon: null }, E: { name: 'Charm', icon: 'ability/Ahri_E.png' }, R: { name: 'Spirit Rush', icon: 'ability/Ahri_R.png' } } },
    { id: 'TahmKench', key: '223', name: 'Tahm Kench', clips: 'R', abilities: {} },   // only the ultimate has real sound
    { id: 'Aatrox', key: '266', name: 'Aatrox', clips: 'P', abilities: {} },          // passive only
    { id: 'Nobody', key: '999', name: 'Nobody', clips: '', abilities: {} },           // nothing usable
  ],
};

test('a bundled roster answers everything without the network', async () => {
  const bundled = Roster.fromBundle(manifest, 'offline');
  const ahri = bundled.byId.get('Ahri');
  assert.equal(bundled.patch, '16.22');
  assert.equal(bundled.clipCount, 7);
  assert.equal(bundled.iconUrl(ahri), 'offline/icons/champion/Ahri.png');
  assert.deepEqual([...await bundled.clipSlots(ahri)], ['P', 'Q', 'W', 'E', 'R']);
  assert.deepEqual([...await bundled.clipSlots(bundled.byId.get('TahmKench'))], ['R']);
  const abilities = await bundled.abilities(ahri);
  assert.deepEqual(abilities.Q, { name: 'Orb of Deception', icon: 'offline/icons/ability/Ahri_Q.png' });
  assert.deepEqual(abilities.W, { name: 'Fox-Fire', icon: null });
  assert.equal((await bundled.abilities(bundled.byId.get('Aatrox'))).Q, null);
  assert.deepEqual(names(bundled.search('tahm')), ['Tahm Kench']);
  assert.equal(bundledClipUrl('103', 'Q', 'offline'), 'offline/clips/103_Q.ogg');
});

test('a bundled roster only asks about sounds it has', () => {
  const bundled = Roster.fromBundle(manifest, 'offline');
  for (let run = 0; run < 200; run++) {
    const basic = sampleQuestions(bundled, 4, 'basic');
    assert.deepEqual(basic.questions.map((q) => q.champ.id).sort(), ['Ahri', 'TahmKench']);   // no QWER sound for the others
    for (const q of [...basic.questions, ...basic.reserve.map(basic.pick)]) assert.ok(q.champ.clips.has(q.slot));
    assert.equal(basic.questions.find((q) => q.champ.id === 'TahmKench').slot, 'R');

    const all = sampleQuestions(bundled, 4, 'all');
    assert.deepEqual(all.questions.map((q) => q.champ.id).sort(), ['Aatrox', 'Ahri', 'TahmKench']);
    assert.equal(all.questions.find((q) => q.champ.id === 'Aatrox').slot, 'P');
  }
});

test('a clip trimmed for the bundle is only measured in the app, never trimmed again', () => {
  // A long clip that the build caps at 10 s. The kept part happens to end on
  // three quiet seconds (the clip gets loud again later), so running the
  // trimming a second time would cut the stored clip shorter than the website
  // plays it. That is why the app asks for trim: false.
  const raw = [signal([[0.5, null], [7, -20], [4, -50], [3, -20]])];
  const first = analyzePcm(raw, SR);
  near(first.endSec - first.startSec, 10, 0.01, 'the build caps it');
  const stored = slicePcm(raw, SR, first);
  assert.ok(analyzePcm(stored, SR).endSec < 9.8, 'a second trim would shorten it');

  const inApp = analyzePcm(stored, SR, { ...CONFIG.audio, trim: false });
  assert.equal(inApp.startSec, 0);
  near(inApp.endSec, stored[0].length / SR, 1e-9, 'plays to the end');
  assert.equal(inApp.cut, false);
  near(inApp.gainDb, first.gainDb, 0.3, 'same levelling');
  assert.equal(inApp.peaks.length, 96);
  // Silence is still silence.
  assert.equal(analyzePcm([new Float32Array(SR)], SR, { ...CONFIG.audio, trim: false }).silent, true);
});

test('wakeServer gives up at once when the device has no connection', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  try {
    const seen = [];
    const started = Date.now();
    const status = await wakeServer((state) => seen.push(state));
    assert.deepEqual(status, { ok: false, outdated: false, offline: true });
    assert.deepEqual(seen, ['nointernet']);
    assert.ok(Date.now() - started < 200, 'no waiting, no request');
  } finally {
    if (had) Object.defineProperty(globalThis.navigator, 'onLine', had);
    else delete globalThis.navigator.onLine;
  }
});
