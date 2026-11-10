# LoL Sound Quiz for Android

The same quiz as the website, as an app that works with no connection at all. Every champion, ability name, icon and sound is stored inside the APK.

- Solo quizzes and practice run fully offline. The app makes no network request unless you open "Play with Friends" or the global leaderboard.
- Those two still work when the phone is online, against the same server as the website, so app and browser players can share a lobby.
- Settings, personal bests and your last 30 games are saved on the phone.

Needs Android 13 or newer. Built and tested for a Galaxy S26 Ultra: portrait, edge to edge, with the layout tightening up while the keyboard is open.

## What is in the APK

| Part | Size | Where it comes from |
| --- | --- | --- |
| The site (`index.html`, `styles.css`, `js/`) | under 0.2 MB | this repository, unchanged apart from two lines in `index.html` |
| 841 sounds, Ogg Opus | 52 MB | Riot's ability preview clips, audio track only, already trimmed |
| Champion and ability icons | 10 MB | Riot Data Dragon |
| Roster and ability names | 0.1 MB | Riot Data Dragon, plus CommunityDragon for which clips are current |
| Fonts (Cinzel, Inter) | 0.2 MB | Google Fonts, SIL Open Font License |

None of that is committed to git. `tools/offline/build.mjs` downloads and prepares it.

## Build it

You need Node 22+, a JDK (17 or newer) and the Android SDK (platform 37).

```bash
cd tools/offline && npm install && cd ../..
```

```bash
npm run bundle
```

```bash
cd android && ./gradlew assembleRelease
```

The APK is written to `android/app/build/outputs/apk/release/`. Point Gradle at your tools first: set `JAVA_HOME`, and either set `ANDROID_HOME` or put `sdk.dir=...` in `android/local.properties`.

`npm run bundle` downloads about 3.3 GB of video the first time (850 clips), keeps only the audio, and takes around five minutes on a fast connection. Later runs reuse `android/.cache` (about 800 MB, safe to delete) and finish in seconds.

To install: copy the APK to the phone and open it, or with the phone connected over USB:

```bash
adb install -r android/app/build/outputs/apk/release/LoLSoundQuiz-2.1.0-release.apk
```

## After a new patch or champion

```bash
npm run bundle -- --refresh
```

That re-reads Riot's data, re-checks every clip, downloads the ones that changed, and rebuilds the bundle. Then build and install the APK again; it installs over the old one and keeps your scores.

## How the sounds are prepared

The website downloads each clip, decodes the audio and then decides what to play: where the sound starts, where it ends, a 10 second cap, and how much gain brings it to a common loudness (`analyzePcm` in `js/audio.js`).

The bundle builder runs that same function on each clip, so the app and the website play the same part of every sound. It then stores the result:

1. the chosen part is cut out, with the same fades the browser applies (`slicePcm`);
2. as much of the levelling as fits under full scale is applied before encoding, so the encoder works on the sound at the level it will be heard;
3. it is encoded as 96 kbit/s Ogg Opus;
4. the stored file is decoded again and measured, to confirm it is not silent and to record what gain the app will still add (at most about 2 dB).

In the app, a bundled clip is only measured, never trimmed a second time.

Clips are left out for the same reasons the website skips them: 8 contain no real sound, 1 is missing on Riot's side, and 15 are leftovers from before a rework. Clips the website has to skip for size (over 12 MB of video) are included here, because only their audio is kept.

## How the app is put together

`MainActivity` is the whole native side: one WebView. Requests to `https://appassets.androidplatform.net/` (a domain Google reserves for this; it never resolves on the internet) are answered from `assets/www`, so the page has a normal https origin and runs the site's own code. Anything else the page asks for goes to the network as usual, which is only the game server.

`index.html` in the bundle carries `<meta name="lsq-bundle" content="offline">`. That one tag switches `js/config.js` into bundle mode: the roster comes from `offline/manifest.json` and sounds from `offline/clips/`.

The back button and back gesture are handed to the page (`goBack` in `js/app.js`): it closes the leaderboard, asks twice before quitting a game, and on the start screen lets the app step into the background.

## Limits

- Tested on an Android 17 emulator set to the S26 Ultra's screen size, not on the phone itself.
- The roster is the one the app was built with. A champion released later appears after a rebuild.
- The APK is signed with the debug key the Android tools keep on the build computer (`~/.android/debug.keystore`). An update only installs over an older copy if it was signed on the same computer; otherwise uninstall first, which clears saved scores.
- It bundles Riot's assets under their "Legal Jibber Jabber" policy for fan projects. Keep it free, and do not publish it to a store.
