import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseFile } from 'music-metadata';
import { JsonStore } from './store.js';
import { hash, limiter, norm } from './util.js';

export const ART_SIZES = { s: 120, m: 300, l: 800 };
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const PREFERRED = /^(folder|cover|front|album|albumart(_\{[^}]+\}_large)?|albumartlarge)$/i;
const AVOID = /(back|cd|disc|disk|inlay|tray|inside|booklet|label|matrix|spine|small)/i;
const RETRY_NONE_MS = 24 * 3600 * 1000;

const sniffType = (buf) => {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
};

/**
 * Album art and artist photos, resolved in Zune's order of preference
 * (embedded picture, then an image in the album folder, then online) and
 * cached as resized JPEGs so grids stay fast.
 */
export class ArtService extends EventEmitter {
  constructor({ dir, library, online, resize }) {
    super();
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.library = library;
    this.online = online;
    this.resize = resize; // (buffer, maxSize) => Promise<Buffer|null> JPEG, or null when unavailable
    this.index = new JsonStore(path.join(dir, 'index.json'), { albums: {}, artists: {} });
    this.index.load();
    this.limit = limiter(3);
    this.inflight = new Map();
    this.warming = false;
  }

  #signature(album) {
    return hash(album.trackIds.join(','));
  }

  /** Returns { file, type } for a cached image, building it on demand. */
  async album(albumId, size = 'm') {
    const album = this.library.albums.get(albumId);
    if (!album || !ART_SIZES[size]) return null;
    const sig = this.#signature(album);
    const entry = this.index.data.albums[albumId];
    if (entry && entry.sig === sig) {
      if (entry.src === 'none') {
        if (Date.now() - entry.t < RETRY_NONE_MS) return null;
      } else {
        const file = path.join(this.dir, `${albumId}_${size}${entry.ext || '.jpg'}`);
        if (fs.existsSync(file)) return { file, type: entry.type || 'image/jpeg' };
      }
    }
    const key = `album:${albumId}:${size}`;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.limit(() => this.#buildAlbum(album, size, sig)).finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  hasAlbumArt(albumId) {
    const e = this.index.data.albums[albumId];
    if (!e) return null;
    return e.src !== 'none';
  }

  async #buildAlbum(album, size, sig) {
    const cached = this.index.data.albums[album.id];
    let source = null;
    // Reuse a previously downloaded original instead of hitting the network again.
    const orig = path.join(this.dir, `${album.id}_orig`);
    if (cached?.sig === sig && cached.src !== 'none' && fs.existsSync(orig)) {
      source = { buf: await fsp.readFile(orig), src: cached.src };
    } else {
      source = await this.#resolveAlbum(album);
    }
    if (!source) {
      const wasKnown = cached && cached.src !== 'none';
      this.index.data.albums[album.id] = { sig, src: 'none', t: Date.now() };
      this.index.save();
      if (wasKnown) this.emit('art', { albumId: album.id, has: false });
      return null;
    }
    if (source.src === 'online') await fsp.writeFile(orig, source.buf);
    const out = await this.#writeSized(source.buf, `${album.id}_${size}`, ART_SIZES[size]);
    const isNew = !cached || cached.src === 'none' || cached.sig !== sig;
    this.index.data.albums[album.id] = { sig, src: source.src, t: Date.now(), ext: out.ext, type: out.type };
    this.index.save();
    if (isNew) this.emit('art', { albumId: album.id, has: true });
    return { file: out.file, type: out.type };
  }

  async #writeSized(buf, name, max) {
    let data = null;
    try {
      data = await this.resize(buf, max);
    } catch {}
    const type = data ? 'image/jpeg' : sniffType(buf);
    const ext = data ? '.jpg' : ({ 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }[type] || '.jpg');
    const file = path.join(this.dir, name + ext);
    await fsp.writeFile(file, data || buf);
    return { file, type, ext };
  }

  async #resolveAlbum(album) {
    const tracks = album.trackIds.map((id) => this.library.tracks.get(id)).filter(Boolean);
    for (const t of tracks.slice(0, 3)) {
      try {
        const meta = await parseFile(t.path, { duration: false, skipCovers: false });
        const pics = meta.common.picture || [];
        const pic = pics.find((p) => /front/i.test(p.type || '')) || pics[0];
        if (pic?.data?.length > 200) return { buf: Buffer.from(pic.data), src: 'embedded' };
      } catch {}
    }
    const dirs = [...new Set(tracks.map((t) => path.dirname(t.path)))];
    for (const dir of dirs) {
      const file = await this.#folderImage(dir);
      if (file) {
        try {
          return { buf: await fsp.readFile(file), src: 'file' };
        } catch {}
      }
    }
    if (this.online?.enabled('albumArt') && !album.unknown && album.artist !== 'Unknown Artist') {
      try {
        const url = await this.online.albumCoverUrl(album.artist, album.title);
        if (url) return { buf: await this.online.download(url), src: 'online' };
      } catch (err) {
        console.warn('[art] online cover failed:', album.title, err.message);
      }
    }
    return null;
  }

  async #folderImage(dir) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return null;
    }
    const images = names.filter((n) => IMG_EXT.has(path.extname(n).toLowerCase()));
    if (!images.length) return null;
    const stem = (n) => path.basename(n, path.extname(n));
    const preferred = images.find((n) => PREFERRED.test(stem(n)));
    if (preferred) return path.join(dir, preferred);
    const candidates = images.filter((n) => !AVOID.test(stem(n)));
    if (!candidates.length) return null;
    let best = null;
    let bestSize = 0;
    for (const n of candidates) {
      try {
        const s = await fsp.stat(path.join(dir, n));
        if (s.size > bestSize) {
          best = n;
          bestSize = s.size;
        }
      } catch {}
    }
    return best ? path.join(dir, best) : null;
  }

  /** Artist photo for Now Playing (online only, like the original). */
  async artist(name, size = 'l') {
    if (!this.online?.enabled('artistImages')) return null;
    const id = hash(`artist:${norm(name)}`);
    const entry = this.index.data.artists[id];
    const file = path.join(this.dir, `artist_${id}_${size}.jpg`);
    if (entry) {
      if (entry.src === 'none' && Date.now() - entry.t < RETRY_NONE_MS * 7) return null;
      if (entry.src !== 'none' && fs.existsSync(file)) return { file, type: 'image/jpeg' };
    }
    const key = `artist:${id}:${size}`;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.limit(async () => {
        const info = await this.online.artist(name);
        if (!info?.picture) {
          this.index.data.artists[id] = { src: 'none', t: Date.now() };
          this.index.save();
          return null;
        }
        const buf = await this.online.download(info.picture);
        const out = await this.#writeSized(buf, `artist_${id}_${size}`, ART_SIZES[size]);
        this.index.data.artists[id] = { src: 'online', t: Date.now() };
        this.index.save();
        return { file: out.file, type: out.type };
      }).catch((err) => {
        console.warn('[art] artist photo failed:', name, err.message);
        return null;
      }).finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  /** Resolve art for every album in the background so grids fill in. */
  async warm() {
    if (this.warming) return;
    this.warming = true;
    try {
      for (const album of [...this.library.albums.values()]) {
        await this.album(album.id, 'm').catch(() => null);
      }
    } finally {
      this.warming = false;
    }
  }
}
