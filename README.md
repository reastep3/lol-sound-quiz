# LoL Sound Quiz

Hear a League of Legends ability, name the champion and which ability it was.

**Play: https://reastep3.github.io/lol-sound-quiz/**

- Every current champion. The roster is read from Riot's data when the page loads, so new champions appear on their own.
- Real in-game audio, trimmed and levelled so every clip starts promptly and plays at the same volume.
- Solo quizzes of 5, 10 or 20 questions: ultimates only, Q/W/E/R, or everything including passives. Timed (20 seconds, faster answers score more) or untimed practice.
- Multiplayer lobbies for up to 8 players with a shared clock.
- Personal bests saved in the browser, plus a global leaderboard.

Keyboard: type a champion and press <kbd>Enter</kbd> to pick the top match, <kbd>Q</kbd> <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd> <kbd>P</kbd> to choose the ability, <kbd>Enter</kbd> to submit, <kbd>Space</kbd> to replay.

## Where the sounds come from

Each sound is the audio track of the ability preview clip Riot shows on its own champion pages. Nothing is stored in this repository.

Those clips are video files and are not consistent with each other: measured across all 849 of them, loudness differs by more than 30 dB, some open with several seconds of silence or map ambience, about one in five runs longer than 10 seconds, and a handful contain no real sound at all. So the game does not just play them. For each question it:

1. downloads the clip and decodes only the audio,
2. finds where the sound starts and ends and trims the rest,
3. caps it at 10 seconds,
4. levels it to a common loudness,
5. throws it out and picks a different champion if it is silent, missing, larger than 12 MB, or no longer listed by the game client (which means it predates a rework).

If a clip cannot be loaded, the game never substitutes another sound. It swaps the question, or tells you it could not load.

The next two sounds are fetched in the background while you answer, so questions after the first start immediately.

| What | Source |
| --- | --- |
| Champion list, ability names, icons | Riot Data Dragon (`ddragon.leagueoflegends.com`) |
| Ability clips | Riot CDN (`lol.dyn.riotcdn.net`) |
| Which abilities currently have a clip | CommunityDragon mirror of the game client data |

## Run it locally

Needs Node 22 or newer. The site itself has no build step and no dependencies.

```bash
npm run dev
```

Open http://localhost:5500. Solo play works with just that.

For multiplayer and the leaderboard, also start the game server in a second terminal:

```bash
cd server && npm install && npm start
```

On `localhost` the site talks to `localhost:8080` automatically.

## Tests

```bash
cd server && npm install && cd .. && npm test
```

The suite covers champion search, question selection, scoring, the audio analysis (with synthetic signals), and the server end to end: it starts a real server, connects WebSocket clients and plays whole games against a fake of Riot's endpoints.

## Deploying

- **Site:** pushing to `main` runs the tests and then publishes `index.html`, `styles.css` and `js/` to GitHub Pages (`.github/workflows/pages.yml`).
- **Server:** `server/` is a Render web service (`server/render.yaml`). It needs no configuration beyond `PORT`.

The site and server check each other's protocol version. If the site is newer than the server, multiplayer shows "Game server is updating" instead of breaking.

## Layout

```
index.html, styles.css   the page
js/config.js             every tunable number and URL
js/data.js               roster, champion search, question selection, scoring
js/audio.js              download, decode, trim, level, play
js/app.js                screens and game flow (solo and multiplayer)
js/net.js                server wake-up, leaderboard, lobby connection
js/storage.js            settings and personal bests (localStorage)
server/app.js            lobbies, clock, scoring, leaderboard
test/                    node:test suites
tools/dev-server.mjs     static file server for local development
```

## Known limits

- **Data use.** A clip is a video file, typically around 3 MB, so a 10-question game downloads roughly 30 to 40 MB. Browsers cache the clips afterwards.
- **The global leaderboard resets.** The server keeps scores in memory and runs on a free Render instance that sleeps when idle, so the board starts over whenever it restarts. It also takes up to a minute to wake; the site shows that while it waits. Personal bests live in the browser and are not affected. A permanent board needs a database.
- **Scores are not cheat-proof.** Solo games are scored in the browser, and anyone who inspects network traffic can see which clip is being downloaded.
- **Browsers.** Developed and tested in Chromium. Firefox should behave the same. On browsers that cannot decode the clips directly, the game falls back to plain streaming, which works but skips the trimming and levelling; that path has not been tried on Safari.

## Legal

LoL Sound Quiz was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.
