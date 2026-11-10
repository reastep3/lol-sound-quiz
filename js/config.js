// Central settings. Everything tunable lives here.

const host = typeof location !== 'undefined' ? location.hostname : '';
const isLocal = ['localhost', '127.0.0.1', '[::1]', ''].includes(host);

export const CONFIG = {
  // Riot's Data Dragon: champion roster, ability names, icons.
  ddragon: 'https://ddragon.leagueoflegends.com',

  // CommunityDragon mirrors the game client's own data files. We only ask it
  // one thing: which abilities the client currently has a preview clip for.
  cdragon: 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1',

  // Riot's current CDN for the ability preview clips shown on the official
  // champion pages. It allows cross-origin reads, which lets us decode the
  // audio track ourselves instead of streaming a hidden video.
  clipHost: 'https://lol.dyn.riotcdn.net/x/videos/champion-abilities',
  // Older bucket. No longer updated and has no CORS, so it is only ever used
  // as a last-resort plain <audio> source.
  legacyClipHost: 'https://d28xe8vt774jo5.cloudfront.net/champion-abilities',

  // Multiplayer + leaderboard server.
  server: isLocal
    ? { http: 'http://localhost:8080', ws: 'ws://localhost:8080' }
    : { http: 'https://lol-sound-quiz.onrender.com', ws: 'wss://lol-sound-quiz.onrender.com' },
  protocol: 2,
  // The free host sleeps when idle and needs up to a minute to wake.
  serverWakeTimeoutMs: 75_000,

  questionTimeSec: 20,        // time to answer once the sound starts (solo)
  questionCounts: [5, 10, 20],
  defaultCount: 10,

  audio: {
    maxClipBytes: 12 * 1024 * 1024, // a few clips are 15-30 MB of video; skip those
    maxPlaySec: 10,                 // longest stretch of a clip we play
    targetDb: -17,                  // loudness every clip is levelled to
    silentDb: -50,                  // quieter than this = the clip has no real sound
    maxGainDb: 32,
    minGainDb: -12,
    fetchTimeoutMs: 30_000,
    cacheSize: 8,                   // decoded clips kept in memory
  },
};

// Which ability slots a quiz draws from.
export const POOLS = {
  ult: { slots: ['R'], label: 'Ultimates', hint: 'R only' },
  basic: { slots: ['Q', 'W', 'E', 'R'], label: 'Q W E R', hint: 'no passives' },
  all: { slots: ['P', 'Q', 'W', 'E', 'R'], label: 'Everything', hint: 'with passives' },
};

export const SLOTS = ['P', 'Q', 'W', 'E', 'R'];
