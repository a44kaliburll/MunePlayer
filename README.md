# Zoon Player

A music player for your own music collection, in the style of Microsoft's Zune:

- **Windows:** a desktop app modelled on the Zune 4.8 software. It plays your music folders, keeps `.zpl` playlists the original Zune software can open, and syncs a real **Zune HD** over USB.
- **Android:** a phone app modelled on the Zune HD (big lowercase menus, panoramas, a now playing screen with drifting artist photos). It plays the music on the phone and syncs with the Windows app over Wi‑Fi. See [android/README.md](android/README.md).

Zoon Player is a fan project, not affiliated with or endorsed by Microsoft. Zune is a trademark of Microsoft Corporation.

## Windows app

Needs Windows 10 or 11 and Node.js 22 or later.

```bash
npm install
npm start
```

If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once (newer npm versions skip install scripts, and Electron downloads its binary in one).

- `npm run dist` builds an installer, `dist\Zoon Player Setup 1.0.0.exe`, with Start menu entries.
- `node server/dev.js --port=18751` runs the back end without Electron, for a browser preview on `http://127.0.0.1:18751` with its own separate data. Add `?noanim` to the URL in previews that don't run CSS animations.

On first run it watches your Music folder, plus the folders the original Zune software used if it's installed. Change them under **settings > collection**.

### What's in it

| Zune feature | Status |
|---|---|
| quickplay: pins, new, history, welcome, Smart DJ row | yes |
| collection > music: artists / genres / albums / songs / playlists | yes, with sorting, multi-select, type-to-jump |
| now playing: flipping, tinted album-art wall; artist photos; up-next list | yes (artist photos come from Deezer) |
| mixview | yes (related artists come from Deezer) |
| Smart DJ | yes: related artists you own plus genre matches, weighted by ratings and plays |
| hearts (like / dislike), play counts | yes |
| playlists as `.zpl` files the original Zune software can open; drag songs onto the playlist icon | yes |
| compact (mini player) mode, taskbar thumbnail buttons, media keys | yes |
| monitored folders that update on their own | yes |
| social | a local "zoon card" with your plays, favorites and badges |
| your name, this PC's name, your Zune's name | yes: settings > account, settings > phone, and "rename" on the device page (your name starts as your Windows account name) |
| Zune HD sync | yes: "device" pivot, sync all music or drag / right-click "sync with …", remove from device, the device's play counts flow back |
| wireless sync with the Android app | yes (settings > phone) |
| marketplace | YouTube Music: search, your YouTube playlists and liked songs, played in YouTube's own player with video (see below) |
| videos, pictures, podcasts, channels | placeholders |
| video / picture / podcast sync, CD burning and ripping | not supported |

Missing album art is looked up online (Deezer, then iTunes). Every online feature can be switched off in **settings > online**; only artist and album names are sent. YouTube Music, if you set it up, talks to Google with your own account.

### YouTube Music

The marketplace searches YouTube Music and plays your YouTube playlists and liked songs, through YouTube's official APIs. Songs play in YouTube's own embedded player, with video, beside the list. That brings some limits from YouTube's rules for other apps: the video always shows, nothing plays in the background or as audio only (the player stops when you leave the marketplace), there may be ads without YouTube Premium, and YouTube songs can't be copied to a phone or a Zune. Songs you uploaded to YouTube Music aren't reachable through YouTube's API.

Nothing is built in: you use your own free Google Cloud project, set up once.

1. At [console.cloud.google.com](https://console.cloud.google.com), create a project and enable the **YouTube Data API v3** (APIs & Services > Library).
2. In **Google Auth Platform**, set the app up as **External**. Under **Audience**, add yourself as a test user, or choose **Publish app** so the sign-in doesn't expire every 7 days. (Google warns that the app is unverified; it's your own project.)
3. Under **Clients**, create a client of the type **TVs and Limited Input devices**.
4. In Zoon Player, **settings > online > youtube music**: paste the client ID and secret, then **sign in with Google**. Zoon shows a code to enter at google.com/device.

The Android app can copy the client from the PC it's paired with, then signs in the same way. The sign-in is kept on each device (encrypted with your Windows account on the PC) and can be removed at any time from your Google Account. A search uses 100 of the project's 10,000 free daily YouTube quota units; everything else uses 1.

### Syncing a Zune HD

Plug the Zune in and a **device** pivot appears. The app talks to the Zune through Microsoft's own Zune driver, which is installed with the original Zune software, so no driver swap is needed. Close the original Zune software before syncing: a Zune can only be in one sync session at a time.

A Zune only accepts new files after the **MTPZ** handshake, which needs the "Zune Software" application certificate and RSA key. **They are not included in this repository.** Put them in `%USERPROFILE%\.mtpz-data` (the format libmtp uses: exponent, encryption key, modulus, private key and certificates, one hex string per line) or in `%USERPROFILE%\.zoon-player\mtpz-keys.json` (`exponent`, `modulus`, `privateKey`, `certificates`). Without them the app can still read what's on a Zune but can't copy to it.

How it works, in `native/zunewpd.cpp` and `server/sync.js`:

1. `zunewpd.exe` (C++, Windows Portable Devices API) opens the Zune and reads its library in bulk. Build it with `native\build.cmd` (Visual Studio 2019 Build Tools or later). `zunewpd.exe probe | tree | library | props <id>` dumps what's on the device.
2. `server/mtpz.js` runs the MTPZ handshake through the driver's raw MTP pass-through.
3. For each song, the artist and album entries are created first (the album with its year and cover), then the file goes into `Music\<artist>\<album>`. MP3s get ID3v2.3 tags, since the Zune ignores v2.4. FLAC, WAV, OGG and AAC are converted to MP3 320k with ffmpeg; WMA is sent as-is.
4. Finally each album's track list and each song's ArtistId are set. Until then the Zune files new songs under "Unknown Artist / Unknown Album"; the same step repairs songs already stuck there.

### Wireless sync with the Android app

1. **settings > phone** > "Let my phone sync with this PC over Wi‑Fi". The first time, Windows asks whether Zoon Player may use the network: choose **Allow** on private networks.
2. **pair a phone** shows a six-digit code for 10 minutes.
3. On the phone, open **sync**, pick the PC and type the code.

The phone finds the PC with a UDP broadcast on port 18761 and then uses a small HTTP API on port 18760 (`server/phone.js`) with a token handed out at pairing. The PC keeps only a hash of the token, answers local-network addresses only, and "forget" in either app revokes the pairing. Plays and hearts from the phone come back to the PC on each sync.

### Where things live

- Library index, ratings, plays, settings and the art cache: `%USERPROFILE%\.zoon-player` (`.zoon-player-dev` for `server/dev.js`).
- Playlists: `.zpl` files in the `Playlists` folder inside your first music folder, where the original Zune software kept them.

### Code map

- `main.js`, `preload.cjs`, `desktop/`: the Electron window (frameless, compact mode, taskbar buttons, icons drawn in code).
- `server/`: a local HTTP server on 127.0.0.1. It scans folders (music-metadata), caches art, reads and writes `.zpl` files, does the online lookups and streams audio with byte ranges. Every API call needs a per-launch token. `phone.js` is the separate, opt-in LAN server for the phone; `youtube.js` is the Google sign-in and YouTube Data API client (the player itself is `ui/js/views/youtube.js`).
- `ui/`: plain HTML, CSS and ES modules, no build step. `js/app.js` is the shell; the views are in `js/views/`.
- `native/`: the Zune HD helper.
- `android/`: the Android app (Kotlin, Jetpack Compose, Media3).

## Credits

- The MTPZ handshake in `server/mtpz.js` is ported from [zune-explorer](https://github.com/NiceBeard/zune-explorer) (MIT), which follows libmtp's implementation.
- Artist photos, related artists and missing covers come from the public Deezer and iTunes Search APIs.
- The Android app uses the [Selawik](https://github.com/microsoft/Selawik) font (SIL Open Font License).
- Built with Electron, music-metadata, Jetpack Compose, AndroidX Media3, Coil and OkHttp.
