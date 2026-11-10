// Builds the offline bundle that ships inside the Android app.
//
//   node tools/offline/build.mjs             everything, resuming where it left off
//   node tools/offline/build.mjs --limit=5   a quick trial with the first five champions
//   node tools/offline/build.mjs --refresh   re-read Riot's data (after a patch) and re-check every clip
//
// Steps:
//   roster    champions, ability names, and which abilities have a current preview clip
//   icons     champion and ability icons
//   fonts     the two web fonts the site uses
//   clips     downloads each preview clip once, keeps only its audio track, then makes the
//             same trim / cap / level decisions the website makes in the browser
//             (analyzePcm and slicePcm in js/audio.js) and stores the result as Ogg Opus
//   assemble  writes android/app/src/main/assets/www: the site plus an offline/ folder
//
// Downloads and intermediate files live in android/.cache, so a second run only fetches
// what is new. Nothing this script writes is committed to git.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

import { CONFIG, SLOTS } from '../../js/config.js';
import { analyzePcm, slicePcm, clipUrl } from '../../js/audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, 'android', '.cache');
const WWW = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');
const BUNDLE = 'offline';                 // folder name inside www, and the lsq-bundle meta value

const RATE = 48000;                       // what the browser decodes to as well
const BITRATE = '96k';                    // Ogg Opus, stereo
const PEAK_CEILING = 0.89;                // stored files peak at or below -1 dBFS
// Bump when the processing below changes, so cached results are redone.
const SETTINGS = JSON.stringify({ pipeline: 2, RATE, BITRATE, PEAK_CEILING, audio: CONFIG.audio });

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const LIMIT = Number(option('limit', 0));
const JOBS = Math.max(1, Number(option('jobs', 6)));
const REFRESH = flag('refresh');

// ---- Small helpers ----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.access(p).then(() => true, () => false);
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function writeFile(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
}
const writeJson = (p, value) => writeFile(p, JSON.stringify(value));

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

// fetch with retries. 4xx answers are returned (a missing clip is a real answer).
async function request(url, { tries = 4, timeoutMs = 60_000, ...init } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url}: ${err.message}`);
      await sleep(1000 * attempt * attempt);
    }
  }
}

async function getJson(url) {
  const res = await request(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Streams a URL to disk. Resolves { status, etag, bytes }; 403/404 are not errors.
async function downloadTo(url, file, { tries = 4, timeoutMs = 300_000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 403 || res.status === 404) return { status: res.status };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
      const { size } = await fs.stat(file);
      const expected = Number(res.headers.get('content-length')) || 0;
      if (expected && size !== expected) throw new Error(`got ${size} of ${expected} bytes`);
      return { status: 200, etag: res.headers.get('etag') || '', bytes: size };
    } catch (err) {
      await fs.rm(file, { force: true });
      if (attempt >= tries) throw new Error(`${url}: ${err.message}`);
      await sleep(1000 * attempt * attempt);
    }
  }
}

function ffmpeg(ffArgs, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...ffArgs], { windowsHide: true });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out), err: err.trim() }));
    child.stdin.on('error', () => {});     // ffmpeg quit early: its exit code tells the story
    child.stdin.end(input || undefined);
  });
}

// ---- Roster -----------------------------------------------------------------

async function buildRoster() {
  const file = path.join(CACHE, 'roster.json');
  let roster = REFRESH ? null : await readJson(file);
  if (!roster) {
    const dd = CONFIG.ddragon;
    const version = (await getJson(`${dd}/api/versions.json`))[0];
    const list = Object.values((await getJson(`${dd}/cdn/${version}/data/en_US/champion.json`)).data)
      .sort((a, b) => a.name.localeCompare(b.name));
    console.log(`roster: patch ${version}, ${list.length} champions`);
    const champions = await pool(list, 8, async (c) => {
      const d = (await getJson(`${dd}/cdn/${version}/data/en_US/champion/${c.id}.json`)).data[c.id];
      const abilities = { P: d.passive ? { name: d.passive.name, image: `passive/${d.passive.image.full}` } : null };
      ['Q', 'W', 'E', 'R'].forEach((slot, i) => {
        const s = d.spells?.[i];
        abilities[slot] = s ? { name: s.name, image: `spell/${s.image.full}` } : null;
      });
      // Same question the website asks: which abilities does the game client
      // currently show a preview for? Anything else on the CDN is a leftover.
      const client = await getJson(`${CONFIG.cdragon}/champions/${c.key}.json`);
      const listed = [];
      if (client.passive?.abilityVideoPath) listed.push('P');
      for (const spell of client.spells || []) {
        if (spell.abilityVideoPath && spell.spellKey) listed.push(String(spell.spellKey).toUpperCase());
      }
      return { id: c.id, key: String(c.key), name: c.name, abilities, listed };
    });
    roster = { version, champions };
    await writeJson(file, roster);
  }
  if (LIMIT) roster = { ...roster, champions: roster.champions.slice(0, LIMIT) };
  return roster;
}

// ---- Icons ------------------------------------------------------------------

async function buildIcons(roster) {
  const dir = path.join(CACHE, `icons-${roster.version}`);
  const base = `${CONFIG.ddragon}/cdn/${roster.version}/img`;
  const wanted = [];
  for (const c of roster.champions) {
    wanted.push({ url: `${base}/champion/${c.id}.png`, name: `champion/${c.id}.png` });
    for (const slot of SLOTS) {
      if (c.abilities[slot]) wanted.push({ url: `${base}/${c.abilities[slot].image}`, name: `ability/${c.id}_${slot}.png` });
    }
  }
  const have = new Set();
  let fetched = 0;
  await pool(wanted, 12, async ({ url, name }) => {
    const file = path.join(dir, name);
    if (!(await exists(file))) {
      const got = await downloadTo(url, file, { timeoutMs: 60_000 });
      if (got.status !== 200) { console.warn(`icons: missing ${name}`); return; }
      fetched++;
    }
    have.add(name);
  });
  console.log(`icons: ${have.size} ready (${fetched} downloaded)`);
  return { dir, have };
}

// ---- Fonts ------------------------------------------------------------------

async function buildFonts() {
  const dir = path.join(CACHE, 'fonts');
  const cssFile = path.join(dir, 'fonts.css');
  if (!REFRESH && await exists(cssFile)) return dir;

  // Ask for exactly the families and weights the site's own <link> asks for.
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const sheet = html.match(/href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/)?.[1];
  if (!sheet) throw new Error('index.html no longer links a Google Fonts stylesheet');
  // Google serves woff2 only to a browser it recognises.
  const css = await (await request(sheet.replace(/&amp;/g, '&'), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
  })).text();

  const files = new Map();    // remote url -> local file name
  let out = '';
  for (const [, subset, block] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)) {
    if (subset !== 'latin' && subset !== 'latin-ext') continue;
    const url = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    const family = block.match(/font-family:\s*'([^']+)'/)?.[1];
    if (!url || !family) throw new Error('Unexpected Google Fonts stylesheet format: ' + block.slice(0, 300));
    if (!files.has(url)) files.set(url, `${family.toLowerCase().replace(/\W+/g, '-')}-${subset}-${files.size + 1}.woff2`);
    out += `${block.replace(url, files.get(url))}\n`;
  }
  if (!files.size) throw new Error('No latin fonts found in the Google Fonts stylesheet');
  for (const [url, name] of files) {
    const got = await downloadTo(url, path.join(dir, name), { timeoutMs: 60_000 });
    if (got.status !== 200) throw new Error(`Font download failed: ${url}`);
  }

  // Both families are under the SIL Open Font License, which asks that the
  // licence travels with the font files.
  for (const family of ['cinzel', 'inter']) {
    try {
      const res = await request(`https://raw.githubusercontent.com/google/fonts/main/ofl/${family}/OFL.txt`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(path.join(dir, `OFL-${family}.txt`), await res.text());
    } catch {
      await writeFile(path.join(dir, `OFL-${family}.txt`), `${family}: SIL Open Font License 1.1, https://openfontlicense.org\n`);
    }
  }
  await writeFile(cssFile, out);
  console.log(`fonts: ${files.size} files`);
  return dir;
}

// ---- Clips ------------------------------------------------------------------

// Downloads one preview clip and keeps its audio track, untouched, as a small
// Matroska file. The multi-megabyte video is deleted straight away.
async function sourceAudio(champ, slot) {
  const base = path.join(CACHE, 'src', `${champ.key}_${slot}`);
  const save = async (state) => { await writeJson(`${base}.json`, state); return state; };
  const state = await readJson(`${base}.json`);
  if (state?.status === 'ok' && await exists(`${base}.mka`)) {
    if (!REFRESH) return state;
    const head = await request(clipUrl(champ.key, slot, { ext: state.ext }), { method: 'HEAD' });
    if (head.ok && (head.headers.get('etag') || '') === state.etag) return state;
  } else if (state && state.status !== 'ok' && !REFRESH) {
    return state;
  }

  // Same order as the website: WebM, then MP4 if the WebM has no usable audio.
  const problems = [];
  for (const ext of ['webm', 'mp4']) {
    const tmp = path.join(CACHE, 'tmp', `${champ.key}_${slot}.${ext}`);
    const got = await downloadTo(clipUrl(champ.key, slot, { ext }), tmp);
    if (got.status !== 200) {
      if (ext === 'webm') return save({ status: 'missing' });
      problems.push(`${ext}: HTTP ${got.status}`);
      break;
    }
    const copy = await ffmpeg(['-nostdin', '-i', tmp, '-vn', '-map', '0:a:0', '-c:a', 'copy', '-y', `${base}.mka`]);
    await fs.rm(tmp, { force: true });
    if (copy.code === 0) return save({ status: 'ok', ext, etag: got.etag, videoBytes: got.bytes });
    problems.push(`${ext}: ${copy.err.split(/\r?\n/).pop()}`);
  }
  return save({ status: 'noaudio', detail: problems.join(' | ') });
}

async function decodePcm(file) {
  const { code, out, err } = await ffmpeg(['-nostdin', '-i', file, '-vn', '-map', '0:a:0', '-f', 'f32le', '-ac', '2', '-ar', String(RATE), 'pipe:1']);
  const frames = Math.floor(out.length / 8);
  if (code !== 0 || !frames) throw new Error(`decode failed for ${path.basename(file)}: ${err || 'no audio'}`);
  const data = new Float32Array(frames * 2);
  new Uint8Array(data.buffer).set(out.subarray(0, frames * 8));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = data[2 * i];
    right[i] = data[2 * i + 1];
  }
  return [left, right];
}

async function encodeOgg([left, right], file) {
  const data = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    data[2 * i] = left[i];
    data[2 * i + 1] = right[i];
  }
  const { code, err } = await ffmpeg([
    '-f', 'f32le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', BITRATE, '-vbr', 'on', '-application', 'audio',
    '-map_metadata', '-1', '-y', file,
  ], Buffer.from(data.buffer));
  if (code !== 0) throw new Error(`encode failed for ${path.basename(file)}: ${err}`);
}

// Turns the kept audio track into the file the app plays.
async function processClip(champ, slot, source) {
  const base = path.join(CACHE, 'clips', `${champ.key}_${slot}`);
  const save = async (result) => {
    const full = { ...result, settings: SETTINGS, source: source.etag };
    await writeJson(`${base}.json`, full);
    return full;
  };
  const done = await readJson(`${base}.json`);
  if (done && done.settings === SETTINGS && done.source === source.etag
    && (done.status !== 'ok' || await exists(`${base}.ogg`))) return done;

  const pcm = await decodePcm(path.join(CACHE, 'src', `${champ.key}_${slot}.mka`));
  const info = analyzePcm(pcm, RATE, CONFIG.audio);
  if (info.silent) return save({ status: 'silent', loudDb: Math.round(info.loudDb) });

  const parts = slicePcm(pcm, RATE, info);

  // Bake in as much of the levelling as fits under full scale, so the encoder
  // works on the sound at the level it will be heard (a quiet clip amplified
  // 30 dB after lossy encoding would bring the codec's noise up with it).
  // The app measures the stored clip and applies whatever gain is still owed
  // through its limiter, exactly as the website does. It does not trim again.
  let peak = 0;
  for (const part of parts) for (let i = 0; i < part.length; i++) peak = Math.max(peak, Math.abs(part[i]));
  const wanted = 10 ** (info.gainDb / 20);
  const baked = peak > 0 ? Math.min(wanted, PEAK_CEILING / peak) : 1;
  for (const part of parts) for (let i = 0; i < part.length; i++) part[i] *= baked;

  await fs.mkdir(path.dirname(base), { recursive: true });
  await encodeOgg(parts, `${base}.ogg`);

  // Check what the app will actually get: decode the stored file and measure
  // it the way the app does.
  const check = analyzePcm(await decodePcm(`${base}.ogg`), RATE, { ...CONFIG.audio, trim: false });
  if (check.silent) throw new Error('the encoded clip came out silent');
  const { size } = await fs.stat(`${base}.ogg`);
  return save({
    status: 'ok',
    bytes: size,
    seconds: Number((parts[0].length / RATE).toFixed(2)),
    sourceLoudDb: Number(info.loudDb.toFixed(1)),
    wantedGainDb: Number(info.gainDb.toFixed(1)),
    bakedGainDb: Number((20 * Math.log10(baked)).toFixed(1)),
    appGainDb: Number(check.gainDb.toFixed(1)),
    storedSeconds: Number((check.endSec - check.startSec).toFixed(2)),
    cut: info.cut,
  });
}

async function buildClips(roster) {
  const jobs = [];
  for (const champ of roster.champions) {
    for (const slot of SLOTS) if (champ.listed.includes(slot)) jobs.push({ champ, slot });
  }
  console.log(`clips: ${jobs.length} to check, ${JOBS} at a time`);
  // ffmpeg does not create folders for its output files.
  for (const dir of ['src', 'clips', 'tmp']) await fs.mkdir(path.join(CACHE, dir), { recursive: true });
  const results = new Map();
  let done = 0;
  const started = Date.now();
  await pool(jobs, JOBS, async ({ champ, slot }) => {
    let result;
    try {
      const source = await sourceAudio(champ, slot);
      result = source.status === 'ok' ? await processClip(champ, slot, source) : { status: source.status, detail: source.detail };
    } catch (err) {
      result = { status: 'error', message: err.message };
    }
    results.set(`${champ.key}_${slot}`, { ...result, champ: champ.name, slot });
    done++;
    if (done % 25 === 0 || done === jobs.length) {
      const line = `clips: ${done}/${jobs.length} (${Math.round((Date.now() - started) / 1000)} s)`;
      console.log(line);
      await writeFile(path.join(CACHE, 'progress.txt'), `${line}\n`);
    }
  });

  const by = (status) => [...results.values()].filter((r) => r.status === status);
  const ok = by('ok');
  const label = (r) => `${r.champ} ${r.slot}`;
  console.log(`clips: ${ok.length} ready, ${mb(ok.reduce((sum, r) => sum + r.bytes, 0))}, `
    + `${(ok.reduce((sum, r) => sum + r.seconds, 0) / Math.max(1, ok.length)).toFixed(1)} s on average`);
  for (const status of ['silent', 'missing', 'noaudio']) {
    if (by(status).length) console.log(`clips: ${by(status).length} ${status}: ${by(status).map(label).join(', ')}`);
  }
  for (const r of by('noaudio')) console.log(`clips: no audio track in ${label(r)} (${r.detail || 'no detail'})`);
  const errors = by('error');
  if (errors.length) {
    for (const r of errors) console.error(`clips: FAILED ${label(r)}: ${r.message}`);
    throw new Error(`${errors.length} clips failed. Run the script again to retry just those.`);
  }
  await writeJson(path.join(CACHE, 'clips-report.json'), Object.fromEntries(results));
  return results;
}

// ---- Assemble ---------------------------------------------------------------

// The site's own index.html, with the two changes the app needs: fonts come
// from the bundle, and a tag tells js/config.js that the bundle is there.
function bundledIndex(html) {
  const swap = (pattern, replacement, what) => {
    if (!html.match(pattern)) throw new Error(`index.html changed: cannot find ${what}`);
    html = html.replace(pattern, replacement);
  };
  swap(/[ \t]*<link rel="preconnect"[^>]*>\r?\n/g, '', 'the preconnect hints');
  swap(/<link href="https:\/\/fonts\.googleapis\.com\/[^"]*" rel="stylesheet">/,
    `<link rel="stylesheet" href="${BUNDLE}/fonts/fonts.css">`, 'the Google Fonts stylesheet');
  swap(/<meta name="theme-color"/, `<meta name="lsq-bundle" content="${BUNDLE}">\n    <meta name="theme-color"`, 'the theme-color tag');
  const external = html.match(/(?:href|src)="https?:\/\/[^"]*"/);
  if (external) throw new Error(`index.html still loads something from the network: ${external[0]}`);
  return html;
}

async function assemble(roster, icons, fontsDir, clips) {
  await fs.rm(WWW, { recursive: true, force: true });
  await fs.mkdir(WWW, { recursive: true });

  await writeFile(path.join(WWW, 'index.html'), bundledIndex(await fs.readFile(path.join(ROOT, 'index.html'), 'utf8')));
  await fs.copyFile(path.join(ROOT, 'styles.css'), path.join(WWW, 'styles.css'));
  await fs.cp(path.join(ROOT, 'js'), path.join(WWW, 'js'), { recursive: true });

  const off = path.join(WWW, BUNDLE);
  await fs.cp(fontsDir, path.join(off, 'fonts'), { recursive: true });

  let clipCount = 0;
  const champions = [];
  for (const c of roster.champions) {
    const abilities = {};
    for (const slot of SLOTS) {
      const a = c.abilities[slot];
      const icon = `ability/${c.id}_${slot}.png`;
      abilities[slot] = a ? { name: a.name, icon: icons.have.has(icon) ? icon : null } : null;
    }
    const slots = SLOTS.filter((slot) => clips.get(`${c.key}_${slot}`)?.status === 'ok');
    for (const slot of slots) {
      await fs.mkdir(path.join(off, 'clips'), { recursive: true });
      await fs.copyFile(path.join(CACHE, 'clips', `${c.key}_${slot}.ogg`), path.join(off, 'clips', `${c.key}_${slot}.ogg`));
    }
    clipCount += slots.length;
    champions.push({ id: c.id, key: c.key, name: c.name, abilities, clips: slots.join('') });
  }
  for (const name of icons.have) {
    await fs.mkdir(path.dirname(path.join(off, 'icons', name)), { recursive: true });
    await fs.copyFile(path.join(icons.dir, name), path.join(off, 'icons', name));
  }
  await writeJson(path.join(off, 'manifest.json'), {
    version: roster.version,
    built: new Date().toISOString().slice(0, 10),
    clips: clipCount,
    champions,
  });

  let bytes = 0;
  let files = 0;
  for (const entry of await fs.readdir(WWW, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
    files++;
  }
  console.log(`bundle: ${champions.length} champions, ${clipCount} sounds, ${files} files, ${mb(bytes)}`);
  console.log(`bundle: written to ${path.relative(ROOT, WWW)}`);
}

// ---- Main -------------------------------------------------------------------

const roster = await buildRoster();
const [icons, fontsDir] = await Promise.all([buildIcons(roster), buildFonts()]);
const clips = await buildClips(roster);
await assemble(roster, icons, fontsDir, clips);
