// Tests for the browser-side logic that doesn't need a browser:
// champion search, question selection, scoring and the audio analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Roster, normalize, sampleQuestions, scoreAnswer } from '../js/data.js';
import { analyzePcm, clipUrl } from '../js/audio.js';
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
