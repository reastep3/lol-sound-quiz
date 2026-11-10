// Champion roster and ability details, read live from Riot's Data Dragon.
// Nothing here is a hand-kept list of champions: when Riot ships a new one,
// it appears in the quiz on the next page load.
//
// The Android app reads the same things from the bundle it was built with
// (Roster.fromBundle) and needs no connection.

import { CONFIG, POOLS, SLOTS } from './config.js';

const ROSTER_CACHE_KEY = 'lsq.roster.v1';

// Lowercase, strip accents and punctuation: "Kai'Sa" -> "kaisa".
export function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Nicknames players actually type that are not a prefix of the real name.
// Keyed by Data Dragon id (these never change); extra entries are harmless.
const NICKNAMES = {
  AurelionSol: ['asol'],
  Gangplank: ['gp'],
  Heimerdinger: ['donger'],
  JarvanIV: ['j4'],
  Khazix: ['k6'],
  Leblanc: ['lb'],
  MissFortune: ['mf'],
  MonkeyKing: ['monkeyking', 'monkey'],
  TwistedFate: ['tf'],
  Warwick: ['ww'],
};

function buildChampion(raw) {
  const words = String(raw.name).split(/[^A-Za-z0-9']+/).map(normalize).filter(Boolean);
  return {
    id: raw.id,                 // Data Dragon id, e.g. "MonkeyKing"
    key: String(raw.key),       // numeric id as a string, e.g. "62"
    name: raw.name,             // display name, e.g. "Wukong"
    norm: normalize(raw.name),
    words,
    initials: words.map((w) => w[0]).join(''),
    nicknames: NICKNAMES[raw.id] || [],
    // Slots with a sound in the offline bundle. null = not known up front (the website).
    clips: typeof raw.clips === 'string' ? new Set(raw.clips) : null,
  };
}

async function getJson(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export class Roster {
  constructor(version, rawChampions, { stale = false, bundle = null } = {}) {
    this.version = version;
    this.stale = stale;         // true when served from the offline cache
    this.bundle = bundle;       // folder of the offline bundle, when built from one
    this.champions = rawChampions
      .map(buildChampion)
      .sort((a, b) => a.name.localeCompare(b.name));
    this.byId = new Map(this.champions.map((c) => [c.id, c]));
    this.byKey = new Map(this.champions.map((c) => [c.key, c]));
    this.details = new Map();   // champion id -> Promise of ability details
    this.listed = new Map();    // champion id -> Promise of Set of slots with a current clip
  }

  // Everything the app needs, from the bundle it ships with: the roster,
  // ability names, icons, and which abilities have a sound on board.
  static fromBundle(manifest, base = CONFIG.bundle) {
    const roster = new Roster(manifest.version, manifest.champions, { bundle: base });
    roster.clipCount = 0;
    for (const raw of manifest.champions) {
      const champ = roster.byId.get(raw.id);
      const abilities = {};
      for (const slot of SLOTS) {
        const a = raw.abilities?.[slot];
        abilities[slot] = a ? { name: a.name, icon: a.icon ? `${base}/icons/${a.icon}` : null } : null;
      }
      roster.details.set(champ.id, Promise.resolve(abilities));
      roster.listed.set(champ.id, Promise.resolve(champ.clips));
      roster.clipCount += champ.clips.size;
    }
    return roster;
  }

  // Latest patch from Riot; falls back to the last roster this browser saw.
  static async load() {
    if (CONFIG.bundle) return Roster.fromBundle(await getJson(`${CONFIG.bundle}/manifest.json`));
    try {
      const versions = await getJson(`${CONFIG.ddragon}/api/versions.json`);
      const version = versions[0];
      const data = await getJson(`${CONFIG.ddragon}/cdn/${version}/data/en_US/champion.json`);
      const raw = Object.values(data.data).map((c) => ({ id: c.id, key: c.key, name: c.name }));
      if (!raw.length) throw new Error('Empty champion list');
      try {
        localStorage.setItem(ROSTER_CACHE_KEY, JSON.stringify({ version, champions: raw }));
      } catch { /* storage full or blocked: not important */ }
      return new Roster(version, raw);
    } catch (err) {
      try {
        const cached = JSON.parse(localStorage.getItem(ROSTER_CACHE_KEY));
        if (cached?.champions?.length) return new Roster(cached.version, cached.champions, { stale: true });
      } catch { /* no usable cache */ }
      throw err;
    }
  }

  get patch() {
    return this.version.split('.').slice(0, 2).join('.');
  }

  iconUrl(champ) {
    if (this.bundle) return `${this.bundle}/icons/champion/${champ.id}.png`;
    return `${CONFIG.ddragon}/cdn/${this.version}/img/champion/${champ.id}.png`;
  }

  // Ability names and icons for one champion: { P, Q, W, E, R } -> { name, icon }.
  abilities(champ) {
    const hit = this.details.get(champ.id);
    if (hit) return hit;
    const base = `${CONFIG.ddragon}/cdn/${this.version}`;
    const p = getJson(`${base}/data/en_US/champion/${champ.id}.json`).then((json) => {
      const d = json.data[champ.id];
      const out = {
        P: d.passive ? { name: d.passive.name, icon: `${base}/img/passive/${d.passive.image.full}` } : null,
      };
      ['Q', 'W', 'E', 'R'].forEach((slot, i) => {
        const s = d.spells?.[i];
        out[slot] = s ? { name: s.name, icon: `${base}/img/spell/${s.image.full}` } : null;
      });
      return out;
    });
    this.details.set(champ.id, p);
    p.catch(() => this.details.delete(champ.id)); // let a later attempt retry
    return p;
  }

  // Which of this champion's abilities the game client itself currently shows
  // a preview clip for. Riot's CDN still serves leftover clips for a few
  // abilities that have since been reworked (mostly passives); the client's
  // data is how we tell a current clip from a stale one.
  // Resolves to a Set like {"Q","W","E","R"}, or null when the mirror can't
  // be reached, in which case the caller simply tries the clip.
  clipSlots(champ) {
    const hit = this.listed.get(champ.id);
    if (hit) return hit;
    const p = getJson(`${CONFIG.cdragon}/champions/${champ.key}.json`, 8000)
      .then((json) => {
        const slots = new Set();
        if (json.passive?.abilityVideoPath) slots.add('P');
        for (const spell of json.spells || []) {
          if (spell.abilityVideoPath && spell.spellKey) slots.add(String(spell.spellKey).toUpperCase());
        }
        return slots;
      })
      .catch(() => null);
    this.listed.set(champ.id, p);
    p.then((slots) => { if (!slots) this.listed.delete(champ.id); }); // unknown: ask again next time
    return p;
  }

  // Ranked matches for what the player has typed so far.
  search(query, limit = 8) {
    const q = normalize(query);
    if (!q) return [];
    const scored = [];
    for (const c of this.champions) {
      let rank;
      if (c.norm === q) rank = 0;
      else if (c.nicknames.includes(q)) rank = 1;
      else if (c.norm.startsWith(q)) rank = 2;
      else if (c.words.some((w) => w.startsWith(q))) rank = 3;
      else if (c.nicknames.some((n) => n.startsWith(q))) rank = 3;
      else if (q.length >= 2 && c.words.length > 1 && c.initials === q) rank = 3;
      else if (q.length >= 3 && c.norm.includes(q)) rank = 4;
      else continue;
      scored.push({ c, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, limit).map((s) => s.c);
  }

  // A champion only if the text names exactly one: full name, nickname,
  // or the single champion the text could still become.
  resolve(text) {
    const q = normalize(text);
    if (!q) return null;
    const exact = this.champions.find((c) => c.norm === q || c.nicknames.includes(q));
    if (exact) return exact;
    const matches = this.search(text, 2);
    return matches.length === 1 ? matches[0] : null;
  }
}

// ---- Question selection -----------------------------------------------------

export function shuffle(list, random = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every champion is equally likely and none appears twice in one quiz.
// `reserve` holds the unused champions, for swapping in when a clip turns
// out to be missing or silent.
// When the roster already knows which sounds exist (the offline bundle), only
// those are asked, so no question ever needs swapping.
export function sampleQuestions(roster, count, pool, random = Math.random) {
  const poolSlots = (POOLS[pool] || POOLS.basic).slots;
  const usable = (champ) => (champ.clips ? poolSlots.filter((s) => champ.clips.has(s)) : poolSlots);
  const order = shuffle(roster.champions.filter((c) => usable(c).length), random);
  const pick = (champ) => {
    const slots = usable(champ);
    return { champ, slot: slots[Math.floor(random() * slots.length)] };
  };
  return {
    questions: order.slice(0, count).map(pick),
    reserve: order.slice(count),
    pick,
  };
}

// ---- Scoring ----------------------------------------------------------------
// Full marks need champion and ability; the champion alone earns half.
// `timeFraction` is the share of the clock still left (1 = instant answer).
// Untimed games pass 1, so every correct answer is worth the full 1000.

export function scoreAnswer({ championCorrect, abilityCorrect, timeFraction = 1 }) {
  const f = Math.min(1, Math.max(0, timeFraction));
  if (championCorrect && abilityCorrect) return { result: 'correct', points: Math.round(100 + 900 * f) };
  if (championCorrect) return { result: 'partial', points: Math.round(50 + 450 * f) };
  return { result: 'wrong', points: 0 };
}
