import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deviceName } from './device.js';
import { MtpzAuth } from './mtpz.js';
import { norm } from './util.js';

const NATIVE = { '.mp3': 0x3009, '.wma': 0xb901 };
const POLL_MS = 4000;

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
});

/** Keys used to recognise the same song on both sides (tags may be spelled a little differently). */
const keyOf = (album, track, title) => `${norm(album)}|${track || 0}|${norm(title)}`;
const looseKeyOf = (album, title) => `${norm(album)}|${norm(title)}`;

/**
 * Zune device sync: watches for a Zune, runs the MTPZ handshake through Microsoft's
 * driver, and copies music the way the Zune software did:
 *   artist object -> album object (+cover, year) -> track files -> album references + ArtistId.
 * The Zune leaves a track under "Unknown Artist/Album" until those links exist.
 */
export class ZuneSync extends EventEmitter {
  constructor({ bridge, library, art, user, cacheDir, ffmpeg }) {
    super();
    this.bridge = bridge;
    this.library = library;
    this.art = art;
    this.user = user;
    this.cacheDir = cacheDir;
    this.ffmpeg = ffmpeg;
    this.device = null; // { id, name } of a connected Zune
    this.info = null;
    this.content = null; // last device library read
    this.busy = false;
    this.progress = null;
    this.lastError = null;
    this.timer = null;
  }

  status() {
    return {
      available: this.bridge.available,
      connected: !!this.device,
      device: this.device,
      info: this.info,
      summary: this.#summary(),
      busy: this.busy,
      progress: this.progress,
      lastError: this.lastError,
      lastSync: this.device ? this.user.data.devices?.[this.info?.serial]?.lastSync || null : null,
    };
  }

  start() {
    if (!this.bridge.available) return;
    const tick = async () => {
      if (!this.busy) {
        try {
          await this.#poll();
        } catch (err) {
          console.warn('[sync] poll failed', err.message);
        }
      }
      this.timer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.bridge.stop();
  }

  async #poll() {
    const { devices } = await this.bridge.request('devices');
    const zune = devices[0] || null;
    if (!zune && this.device) {
      this.device = null;
      this.info = null;
      this.content = null;
      this.emit('status');
      return;
    }
    if (zune && (!this.device || this.device.id !== zune.id)) {
      this.device = { id: zune.id, name: zune.name };
      this.emit('status');
      await this.refresh().catch((err) => {
        this.lastError = err.message;
        this.emit('status');
      });
      if (this.user.data.settings.sync?.auto) this.sync({ all: true }).catch(() => {});
    }
  }

  /** Open + authenticate for the duration of `fn`, then release the device (so the Zune software can use it too). */
  async #withDevice(fn) {
    if (!this.device) throw new Error('No Zune is connected');
    const opened = await this.bridge.request('open', { deviceId: this.device.id });
    this.info = opened.info;
    try {
      await new MtpzAuth(this.bridge).authenticate();
      return await fn();
    } finally {
      await this.bridge.request('close').catch(() => {});
    }
  }

  async refresh() {
    this.busy = true;
    this.emit('status');
    try {
      await this.#withDevice(async () => {
        this.content = await this.bridge.request('library');
        this.info = (await this.bridge.request('info')).info;
      });
      this.#importPlays();
      this.lastError = null;
    } finally {
      this.busy = false;
      this.emit('status');
    }
    return this.status();
  }

  #summary() {
    if (!this.content) return null;
    const musicBytes = this.content.tracks.reduce((s, t) => s + (t.size || 0), 0);
    const matched = this.#matchIndex();
    let onDevice = 0;
    for (const t of this.library.tracks.values()) if (this.#findOnDevice(t, matched)) onDevice++;
    return {
      tracks: this.content.tracks.length,
      albums: this.content.albums.length,
      artists: this.content.artists.length,
      musicBytes,
      localTracks: this.library.tracks.size,
      localOnDevice: onDevice,
      unknown: this.content.tracks.filter((t) => /^unknown artist$/i.test(t.artist) && /^unknown album$/i.test(t.album)).length,
    };
  }

  #matchIndex() {
    const strict = new Map();
    const loose = new Map();
    for (const d of this.content?.tracks || []) {
      strict.set(keyOf(d.album, d.track, d.title), d);
      loose.set(looseKeyOf(d.album, d.title), d);
      // Tracks the Zune couldn't file still match by title + track number.
      loose.set(`*|${d.track || 0}|${norm(d.title)}`, d);
    }
    return { strict, loose };
  }

  #findOnDevice(t, index) {
    const album = t.album || 'Unknown Album';
    return index.strict.get(keyOf(album, t.track, t.title)) || index.loose.get(looseKeyOf(album, t.title)) || index.loose.get(`*|${t.track || 0}|${norm(t.title)}`) || null;
  }

  /** Device play counts feed the collection's play counts (only the increase since the last sync). */
  #importPlays() {
    if (!this.content || !this.info?.serial) return;
    const devices = (this.user.data.devices ||= {});
    const rec = (devices[this.info.serial] ||= { name: this.info.name, seenPlays: {} });
    rec.name = this.info.name;
    const index = new Map();
    for (const t of this.library.tracks.values()) index.set(`${norm(t.album || 'Unknown Album')}|${norm(t.title)}`, t);
    let changed = 0;
    for (const d of this.content.tracks) {
      const local = index.get(`${norm(d.album)}|${norm(d.title)}`);
      if (!local) continue;
      const seen = rec.seenPlays[d.puid] ?? d.plays;
      const delta = d.plays - seen;
      if (delta > 0) {
        this.user.data.plays[local.id] = (this.user.data.plays[local.id] || 0) + delta;
        this.user.data.lastPlayed[local.id] = Date.now();
        changed += delta;
      }
      rec.seenPlays[d.puid] = d.plays;
    }
    this.user.save();
    if (changed) this.emit('plays', changed);
  }

  /** What a sync would do for the given selection. */
  plan(trackIds) {
    const index = this.#matchIndex();
    const add = [];
    const repair = [];
    let already = 0;
    for (const id of trackIds) {
      const t = this.library.tracks.get(id);
      if (!t) continue;
      const d = this.#findOnDevice(t, index);
      if (!d) {
        add.push(t);
        continue;
      }
      // Only "repair" when the Zune filed it as Unknown but we know better.
      const wrongArtist = /^unknown artist$/i.test(d.artist) && !/^unknown artist$/i.test(t.aa);
      const wrongAlbum = /^unknown album$/i.test(d.album) && norm(t.album || 'Unknown Album') !== 'unknown album';
      if (wrongArtist || wrongAlbum) repair.push({ local: t, device: d });
      else already++;
    }
    const bytes = add.reduce((s, t) => s + estimateSize(t), 0);
    return { add, repair, already, bytes };
  }

  selection({ all, trackIds }) {
    if (all) return [...this.library.tracks.keys()];
    return (trackIds || []).filter((id) => this.library.tracks.has(id));
  }

  async sync(request) {
    if (this.busy) throw new Error('A sync is already running');
    if (!this.device) throw new Error('No Zune is connected');
    this.busy = true;
    this.lastError = null;
    const report = { added: 0, repaired: 0, failed: [], skipped: 0 };
    const set = (p) => {
      this.progress = p;
      this.emit('progress', p);
    };
    try {
      await this.#withDevice(async () => {
        this.content = await this.bridge.request('library');
        const { add, repair, already } = this.plan(this.selection(request));
        report.skipped = already;
        const total = add.length + repair.length;
        set({ phase: 'preparing', done: 0, total, title: '' });
        await fsp.mkdir(this.cacheDir, { recursive: true });
        const artists = new Map(this.content.artists.map((a) => [norm(a.name), a.id]));
        const albums = new Map(this.content.albums.map((a) => [`${norm(a.artist)}|${norm(a.name)}`, a]));
        const touched = new Map(); // albumId -> { refs:Set, newTracks:[], artistId }

        const ensureArtist = async (name) => {
          const k = norm(name);
          if (artists.has(k)) return artists.get(k);
          const r = await this.bridge.request('createArtist', { name, fileName: `${deviceName(name)}.art`, folder: ['Artists'] });
          artists.set(k, r.objectId);
          return r.objectId;
        };
        const ensureAlbum = async (t, artistId) => {
          const albumName = t.album || 'Unknown Album';
          const k = `${norm(t.aa)}|${norm(albumName)}`;
          let a = albums.get(k);
          if (!a) {
            const albumMeta = this.library.albums.get(t.albumId);
            const r = await this.bridge.request('createAlbum', {
              name: albumName,
              artist: t.aa,
              fileName: `${deviceName(t.aa)}--${deviceName(albumName)}.alb`,
              folder: ['Albums'],
              ...(albumMeta?.year ? { year: albumMeta.year } : {}),
            });
            await this.bridge.request('setProps', { objectId: r.objectId, artistId });
            const cover = await this.#coverFor(t.albumId);
            if (cover) await this.bridge.request('setArt', { objectId: r.objectId, file: cover }).catch(() => {});
            a = { id: r.objectId, refs: [], artistId };
            albums.set(k, a);
          }
          if (!touched.has(a.id)) touched.set(a.id, { refs: new Set(a.refs), newTracks: [], artistId });
          return a.id;
        };

        let done = 0;
        for (const t of add) {
          set({ phase: 'copying', done, total, title: t.title, artist: t.aa });
          let prepared = null;
          try {
            const artistId = await ensureArtist(t.aa);
            const albumId = await ensureAlbum(t, artistId);
            prepared = await this.#prepare(t);
            const up = await this.bridge.request('uploadTrack', {
              file: prepared.file,
              folder: ['Music', deviceName(t.aa), deviceName(t.album || 'Unknown Album')],
              fileName: prepared.fileName,
              title: t.title,
              artist: t.artist || t.aa,
              albumArtist: t.aa,
              album: t.album || 'Unknown Album',
              ...(t.genre ? { genre: t.genre } : {}),
              ...(t.track ? { track: t.track } : {}),
              durationMs: Math.round((t.duration || 0) * 1000),
              format: prepared.format,
            }, {
              onProgress: (sent, size) => set({ phase: 'copying', done, total, title: t.title, artist: t.aa, sent, size }),
            });
            const entry = touched.get(albumId);
            entry.refs.add(up.objectId);
            entry.newTracks.push(up.objectId);
            report.added++;
          } catch (err) {
            report.failed.push({ title: t.title, error: err.message });
          } finally {
            if (prepared?.temp) fsp.unlink(prepared.file).catch(() => {});
          }
          done++;
        }

        // Tracks already on the Zune but stuck under "Unknown": link them to the right artist/album.
        for (const { local, device } of repair) {
          set({ phase: 'fixing', done, total, title: local.title, artist: local.aa });
          try {
            const artistId = await ensureArtist(local.aa);
            const albumId = await ensureAlbum(local, artistId);
            const entry = touched.get(albumId);
            entry.refs.add(device.id);
            entry.newTracks.push(device.id);
            report.repaired++;
          } catch (err) {
            report.failed.push({ title: local.title, error: err.message });
          }
          done++;
        }

        set({ phase: 'linking', done, total, title: '' });
        for (const [albumId, entry] of touched) {
          await this.bridge.request('setProps', { objectId: albumId, refs: [...entry.refs] }).catch((err) => report.failed.push({ title: 'album links', error: err.message }));
          for (const id of entry.newTracks) {
            await this.bridge.request('setProps', { objectId: id, artistId: entry.artistId }).catch(() => {});
          }
        }
        this.content = await this.bridge.request('library');
        this.info = (await this.bridge.request('info')).info;
      });
      const devices = (this.user.data.devices ||= {});
      const rec = (devices[this.info?.serial] ||= { name: this.info?.name, seenPlays: {} });
      rec.lastSync = Date.now();
      this.user.save();
      set({ phase: 'done', done: report.added + report.repaired, total: report.added + report.repaired, report });
      return report;
    } catch (err) {
      this.lastError = err.message;
      set({ phase: 'error', error: err.message, report });
      throw err;
    } finally {
      this.busy = false;
      this.emit('status');
    }
  }

  async removeFromDevice(objectIds) {
    if (this.busy) throw new Error('The Zune is busy');
    this.busy = true;
    this.emit('status');
    try {
      await this.#withDevice(async () => {
        await this.bridge.request('delete', { ids: objectIds });
        this.content = await this.bridge.request('library');
        this.info = (await this.bridge.request('info')).info;
      });
    } finally {
      this.busy = false;
      this.emit('status');
    }
  }

  /** A 300px JPEG of the album cover for the device (or null). */
  async #coverFor(albumId) {
    try {
      const art = await this.art.album(albumId, 'm');
      if (!art) return null;
      if (art.type === 'image/jpeg') return art.file;
      const out = path.join(this.cacheDir, `${albumId}-cover.jpg`);
      await run(this.ffmpeg, ['-y', '-v', 'error', '-i', art.file, '-vf', 'scale=300:300:force_original_aspect_ratio=decrease', '-q:v', '3', out]);
      return out;
    } catch {
      return null;
    }
  }

  /**
   * The Zune HD plays MP3 and WMA. MP3s get their tags rewritten as ID3v2.3 (the Zune
   * ignores v2.4) with the cover embedded; everything else is converted to MP3 320k.
   */
  async #prepare(t) {
    const ext = path.extname(t.path).toLowerCase();
    const base = path.basename(t.path, path.extname(t.path));
    if (ext === '.wma') return { file: t.path, fileName: `${deviceName(base)}.wma`, format: NATIVE['.wma'], temp: false };
    if (!this.ffmpeg) {
      if (ext === '.mp3') return { file: t.path, fileName: `${deviceName(base)}.mp3`, format: NATIVE['.mp3'], temp: false };
      throw new Error('ffmpeg is needed to convert this file for the Zune');
    }
    const out = path.join(this.cacheDir, `${t.id}.mp3`);
    const cover = await this.#coverFor(t.albumId);
    const meta = [
      ['title', t.title], ['artist', t.artist || t.aa], ['album_artist', t.aa], ['album', t.album || 'Unknown Album'],
      ['genre', t.genre], ['track', t.track ? String(t.track) : null], ['date', t.year ? String(t.year) : null],
    ].filter(([, v]) => v).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    const inputs = ['-i', t.path, ...(cover ? ['-i', cover] : [])];
    const maps = ['-map', '0:a', ...(cover ? ['-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)'] : [])];
    const audio = ext === '.mp3' ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', '320k'];
    await run(this.ffmpeg, ['-y', '-v', 'error', ...inputs, ...maps, ...audio, '-map_metadata', '-1', ...meta, '-id3v2_version', '3', '-write_id3v1', '1', out]);
    return { file: out, fileName: `${deviceName(base)}.mp3`, format: NATIVE['.mp3'], temp: true };
  }
}

function estimateSize(t) {
  const ext = path.extname(t.path).toLowerCase();
  if (ext === '.mp3' || ext === '.wma') return fs.existsSync(t.path) ? fs.statSync(t.path).size : 0;
  return Math.round((t.duration || 0) * 40000); // 320 kbit/s
}
