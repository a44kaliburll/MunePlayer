# Zoon Player for Android

The Zune HD experience on an Android phone, built for Android 17 (a Pixel 11 Pro XL), with Zune HD-style wireless sync from Zoon Player on Windows. Not affiliated with Microsoft.

## Installing

`dist\Zoon Player.apk` is the signed app (built by `build.cmd`, not kept in the repository). Copy it to the phone (a cloud folder, USB, a link to yourself) and open it. Android asks once to allow installs from that app ("Install unknown apps"). Updates install over the top as long as they're signed with the same key (see *Building*).

With USB debugging on, `adb install -r "dist\Zoon Player.apk"` works too.

## What's in it

| | |
|---|---|
| home | a giant lowercase menu with quickplay (pins, history, new) peeking in from the right; the backdrop and a huge faint "zoon" slide at their own speeds as you swipe (panorama) |
| music | a pivot of artists / albums / songs / playlists / genres with sliding headers; letter tiles open a jump grid |
| artist | a full-bleed Deezer photo with parallax, marquee name, albums, related artists you own, songs |
| album | the cover swings in and tips back as you scroll, over a blurred wash of itself; disc breaks |
| now playing | a drifting (Ken Burns) artist photo, enormous artist / album / title words scrolling past, album art that flips when the album changes and swipes to skip, a glow that pulses with the music, controls that fade after 7 s (tap to bring them back) while the art tucks into the corner, up next, hearts, shuffle / repeat, Smart DJ |
| smart dj | pick an artist; it mixes in Deezer's related artists you own and same-genre songs, weighted by hearts and plays (same logic as the desktop) |
| playlists | make your own on the phone; playlists from the PC sync over too |
| search, settings | accent colours (Zune magenta plus the desktop's Smart DJ tints), backdrop choice, online toggles, and the name your PC shows for this phone |
| background playback | a Media3 session: notification, lock screen, Bluetooth buttons, resume after reboot |
| wireless sync | see below |
| youtube | search YouTube Music and play your YouTube playlists and liked songs in YouTube's own player, with video (settings › online › youtube music; it can copy the Google setup from the paired PC, see "YouTube Music" in the main README). It pauses when you leave the screen: YouTube doesn't allow background or audio-only play in other apps |

Plays and hearts are counted on the phone and flow back to the PC on the next sync; hearts set on the PC come to the phone.

## Wireless sync

1. On the PC: Zoon Player > settings > **phone** > "Let my phone sync with this PC over Wi‑Fi". The first time, Windows asks whether Zoon Player may use the network; choose **Allow** (private networks).
2. Click **pair a phone**. A six-digit code appears for 10 minutes.
3. On the phone: **sync**. Allow "Nearby devices" (Android 17 needs it to reach other devices on the Wi‑Fi), pick the PC, type the code. The first sync starts right away.

After that, **sync now** copies anything new, and while the phone charges on Wi‑Fi it checks in about once an hour (Zune HD style). Songs land in `Music/Zoon/<artist>/<album>/`. FLAC, MP3, AAC, OGG and Opus are copied as they are; WMA becomes MP3 and AIFF becomes FLAC (this needs ffmpeg on the PC). Switch off "all music" to pick albums and playlists instead. Songs removed from the PC (or from the sync) come off the phone too, but only files the app copied itself.

How it talks: a UDP broadcast on port 18761 finds the PC, then HTTP on port 18760 with a bearer token from pairing. The PC side is `server/phone.js` in the desktop app.

## Code map

- `data/`: the MediaStore library (grouped like the desktop: album artists, "Various Artists" detection), the hearts / plays / pins / playlists store, Deezer and iTunes lookups, album art (the PC's art, embedded art, online) and Smart DJ.
- `playback/`: `PlaybackService` (ExoPlayer in a MediaSessionService, play counting, artwork for the lock screen), `PlayerConnection` (the MediaController as Compose state) and `AudioLevels` (a pass-through audio processor that measures loudness for the glow; no microphone permission needed).
- `sync/`: discovery, the pairing client, `SyncEngine` (report, read, copy into MediaStore, art, removals), `SyncService` (a foreground service for syncs you start) and `AutoSyncWorker`.
- `youtube/`: Google's device sign-in and the YouTube Data API client; the player screen (YouTube's IFrame player in a WebView whose Referer is the app ID) is in `ui/screens/YouTubeScreens.kt`. `zoon.googleOauth` / `zoon.youtubeApi` Gradle properties point it at a stand-in server for tests.
- `ui/`: Compose screens in `screens/`, the turnstile / feather motion and pivots in `components/`, the Selawik type ramp and line icons in `theme/`.

## Building

Needs JDK 17 or later (21 is what it's built with) and the Android SDK with platform 37.

- `build.cmd` builds the release APK into `dist\`. It uses the Gradle wrapper, so any machine with a JDK and the SDK works; if `JAVA_HOME` / `ANDROID_HOME` aren't set it looks for a toolchain in `%USERPROFILE%\.android-dev`.
- `gradlew :app:assembleDebug` builds a debug APK.
- Signing: a properties file with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`, at `%USERPROFILE%\.android-dev\keys\zoon-release.properties` or wherever the `zoon.signing` Gradle property points. Without it the release APK is signed with the debug key. Keep the key and its passwords backed up: Android only installs an update over the app if it's signed with the same key.
- Optional: set the `zoon.buildRoot` Gradle property (for example in `~/.gradle/gradle.properties`) to put build output outside the project, which helps when the sources live in a synced folder.
- Versions: AGP 9.4.1 (built-in Kotlin), Kotlin 2.4.20, Gradle 9.8, Compose BOM 2026.09.00, Media3 1.11.1, Coil 3.6.3, OkHttp 5.5, WorkManager 2.12. minSdk 29, targetSdk 37.
- Testing on an emulator: the PC is `10.0.2.2` from inside it. `node server/dev.js --port=18753 --phone --phone-host=127.0.0.1` runs the desktop back end with phone sync on the loopback address only, so nothing listens on the LAN.

The app uses the Selawik font (Microsoft, SIL Open Font License; see `app/src/main/assets/licenses`).
