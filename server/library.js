import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseFile } from 'music-metadata';
import { JsonStore } from './store.js';
import { AUDIO_EXT, hash, limiter, norm } from './util.js';

const SCHEMA = 3;
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
const ARTIST_SPLIT = /\s*(?:\/|;|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i;

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  return s || null;
};

function titleFromFile(file) {
  const base = path.basename(file, path.extname(file));
  return base.replace(/^\s*\d{1,3}\s*[-._ ]+\s*/, '').replace(/_/g, ' ').trim() || base;
}

function trackFromFile(file) {
  const m = /^\s*(\d{1,3})\s*[-._ ]/.exec(path.basename(file));
  return m ? Number(m[1]) : null;
}

/** "Daft Punk/Romanthony" -> "Daft Punk" (used only when grouping untagged albums). */
const primaryArtist = (artist) => clean(String(artist || '').split(ARTIST_SPLIT)[0]);

const byNum = (a, b) => (a ?? 1e9) - (b ?? 1e9);

/**
 * The music collection: scans monitored folders, reads tags with music-metadata,
 * and groups tracks into albums, album artists and genres the way Zune did.
 */
export class Library extends EventEmitter {
  constructor({ file, getFolders }) {
    super();
    this.store = new JsonStore(file, { schema: SCHEMA, tracks: [] });
    this.getFolders = getFolders;
    this.tracks = new Map();
    this.byPath = new Map();
    this.albums = new Map();
    this.artists = new Map();
    this.genres = new Map();
    this.status = { scanning: false, phase: 'idle', done: 0, total: 0, lastScan: 0, count: 0 };
    this.watchers = [];
    this.scanPromise = null;
    this.rescanQueued = false;
    this.rescanTimer = null;
    this.version = 0;
  }

  load() {
    const data = this.store.load();
    const tracks = data.schema === SCHEMA ? data.tracks : [];
    for (const t of tracks) {
      this.tracks.set(t.id, t);
      this.byPath.set(t.path.toLowerCase(), t);
    }
    this.rebuild();
    this.status.count = this.tracks.size;
  }

  trackByPath(p) {
    return this.byPath.get(path.resolve(p).toLowerCase()) || null;
  }

  scan(opts = {}) {
    if (this.scanPromise) {
      this.rescanQueued = true;
      return this.scanPromise;
    }
    this.scanPromise = this.#scan(opts)
      .catch((err) => {
        console.error('[library] scan failed', err);
        this.#setStatus({ scanning: false, phase: 'idle', error: String(err.message || err) });
      })
      .finally(() => {
        this.scanPromise = null;
        if (this.rescanQueued) {
          this.rescanQueued = false;
          this.scan();
        }
      });
    return this.scanPromise;
  }

  async #scan({ full = false } = {}) {
    const folders = [...new Set(this.getFolders().map((f) => path.resolve(f)))];
    const present = folders.filter((f) => fs.existsSync(f));
    const missing = folders.filter((f) => !present.includes(f)).map((f) => f.toLowerCase() + path.sep);

    this.#setStatus({ scanning: true, phase: 'finding', done: 0, total: 0, error: null });
    const found = [];
    for (const folder of present) await this.#walk(folder, found);
    const unique = [...new Map(found.map((p) => [p.toLowerCase(), p])).values()];

    const statLimit = limiter(16);
    const stats = await Promise.all(unique.map((p) => statLimit(async () => {
      try {
        const s = await fsp.stat(p);
        return { path: p, size: s.size, mtime: Math.round(s.mtimeMs), birth: Math.round(s.birthtimeMs || s.ctimeMs) };
      } catch {
        return null;
      }
    })));

    const seen = new Set();
    const toRead = [];
    for (const s of stats) {
      if (!s) continue;
      const key = s.path.toLowerCase();
      seen.add(key);
      const prev = this.byPath.get(key);
      if (full || !prev || prev.size !== s.size || prev.mtime !== s.mtime) toRead.push({ s, prev });
    }

    let removed = 0;
    for (const [key, t] of this.byPath) {
      if (seen.has(key)) continue;
      // A disconnected drive shouldn't wipe its songs from the collection.
      if (missing.some((root) => key.startsWith(root))) continue;
      this.byPath.delete(key);
      this.tracks.delete(t.id);
      removed++;
    }

    this.#setStatus({ phase: 'reading', done: 0, total: toRead.length });
    const readLimit = limiter(4);
    let done = 0;
    let lastEmit = 0;
    await Promise.all(toRead.map(({ s, prev }) => readLimit(async () => {
      const t = await this.#read(s, prev);
      this.tracks.set(t.id, t);
      this.byPath.set(s.path.toLowerCase(), t);
      done++;
      if (Date.now() - lastEmit > 300) {
        lastEmit = Date.now();
        this.#setStatus({ done });
      }
    })));

    const changed = toRead.length > 0 || removed > 0;
    if (changed) {
      this.rebuild();
      this.store.data = { schema: SCHEMA, tracks: [...this.tracks.values()] };
      this.store.save(0);
    }
    this.#setStatus({ scanning: false, phase: 'idle', done, total: toRead.length, lastScan: Date.now(), count: this.tracks.size });
    if (changed) this.emit('changed', { read: toRead.length, removed });
    return { read: toRead.length, removed };
  }

  async #walk(root, out) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) stack.push(full);
        } else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
          out.push(full);
        }
      }
    }
  }

  async #read(s, prev) {
    const base = {
      id: prev?.id || hash(s.path.toLowerCase()),
      path: s.path,
      size: s.size,
      mtime: s.mtime,
      added: prev?.added || s.birth || Date.now(),
    };
    try {
      let meta = await parseFile(s.path, { duration: false, skipCovers: true });
      if (!meta.format.duration) meta = await parseFile(s.path, { duration: true, skipCovers: true });
      const c = meta.common;
      const f = meta.format;
      return {
        ...base,
        title: clean(c.title) || titleFromFile(s.path),
        artist: clean(c.artist) || clean(c.artists?.join('; ')),
        albumArtist: clean(c.albumartist),
        album: clean(c.album),
        genre: clean(c.genre?.[0]),
        year: c.year || null,
        track: c.track?.no ?? trackFromFile(s.path),
        disc: c.disk?.no ?? null,
        composer: clean(c.composer?.[0]),
        duration: f.duration ? Math.round(f.duration * 1000) / 1000 : null,
        bitrate: f.bitrate ? Math.round(f.bitrate) : null,
        sampleRate: f.sampleRate || null,
        codec: f.codec || null,
        lossless: !!f.lossless,
        compilation: !!c.compilation,
      };
    } catch (err) {
      return {
        ...base,
        title: titleFromFile(s.path),
        artist: null,
        albumArtist: null,
        album: null,
        genre: null,
        year: null,
        track: trackFromFile(s.path),
        disc: null,
        duration: null,
        error: String(err.message || err).slice(0, 200),
      };
    }
  }

  /** Derive albums / album artists / genres from the flat track list. */
  rebuild() {
    // Albums without an album-artist tag: if a folder's copy of the album has several
    // different artists, it's a compilation ("Various Artists"), like Zune showed it.
    const groups = new Map();
    for (const t of this.tracks.values()) {
      if (!t.album) continue;
      const key = `${norm(path.dirname(t.path))}\0${norm(t.album)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const resolved = new Map();
    for (const g of groups.values()) {
      const tagged = g.find((t) => t.albumArtist);
      if (tagged) {
        for (const t of g) resolved.set(t.id, t.albumArtist || tagged.albumArtist);
        continue;
      }
      const names = new Map();
      for (const t of g) {
        const p = primaryArtist(t.artist);
        if (p) names.set(norm(p), p);
      }
      const aa = (g.some((t) => t.compilation) || names.size > 1) ? 'Various Artists' : [...names.values()][0];
      if (aa) for (const t of g) resolved.set(t.id, aa);
    }

    this.albums = new Map();
    this.artists = new Map();
    this.genres = new Map();
    for (const t of this.tracks.values()) {
      const aa = t.albumArtist || resolved.get(t.id) || primaryArtist(t.artist) || 'Unknown Artist';
      const albumName = t.album || 'Unknown Album';
      const genreName = t.genre || 'Unknown';
      t.aa = aa;
      t.artistId = hash(`artist:${norm(aa)}`);
      t.albumId = hash(`album:${norm(aa)}\0${norm(albumName)}`);
      t.genreId = hash(`genre:${norm(genreName)}`);

      let album = this.albums.get(t.albumId);
      if (!album) {
        album = {
          id: t.albumId, title: albumName, artist: aa, artistId: t.artistId, year: null, genre: genreName,
          trackIds: [], added: t.added, duration: 0, dir: path.dirname(t.path), unknown: !t.album,
        };
        this.albums.set(t.albumId, album);
      }
      album.trackIds.push(t.id);
      album.added = Math.min(album.added, t.added);
      album.duration += t.duration || 0;
      if (t.year && (!album.year || t.year < album.year)) album.year = t.year;

      let artist = this.artists.get(t.artistId);
      if (!artist) {
        artist = { id: t.artistId, name: aa, albumIds: new Set(), trackCount: 0, added: t.added };
        this.artists.set(t.artistId, artist);
      }
      artist.albumIds.add(t.albumId);
      artist.trackCount++;
      artist.added = Math.min(artist.added, t.added);

      let genre = this.genres.get(t.genreId);
      if (!genre) {
        genre = { id: t.genreId, name: genreName, albumIds: new Set(), trackCount: 0 };
        this.genres.set(t.genreId, genre);
      }
      genre.albumIds.add(t.albumId);
      genre.trackCount++;
    }

    for (const album of this.albums.values()) {
      album.trackIds.sort((a, b) => {
        const x = this.tracks.get(a);
        const y = this.tracks.get(b);
        return byNum(x.disc, y.disc) || byNum(x.track, y.track) || x.title.localeCompare(y.title);
      });
    }
    this.version++;
  }

  snapshot() {
    return {
      version: this.version,
      tracks: [...this.tracks.values()].map(({ mtime, size, ...t }) => t),
      albums: [...this.albums.values()],
      artists: [...this.artists.values()].map((a) => ({ ...a, albumIds: [...a.albumIds] })),
      genres: [...this.genres.values()].map((g) => ({ ...g, albumIds: [...g.albumIds] })),
    };
  }

  watch() {
    this.unwatch();
    for (const folder of this.getFolders()) {
      try {
        const w = fs.watch(folder, { recursive: true }, (_evt, name) => {
          if (!name) return;
          const ext = path.extname(String(name)).toLowerCase();
          if (ext && !AUDIO_EXT.has(ext)) return;
          clearTimeout(this.rescanTimer);
          this.rescanTimer = setTimeout(() => this.scan(), 4000);
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {}
    }
  }

  unwatch() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  #setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('status', { ...this.status });
  }
}
