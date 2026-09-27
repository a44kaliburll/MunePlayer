import { JsonStore } from './store.js';
import { norm, sleep } from './util.js';

const UA = 'ZoonPlayer/1.0 (local music player)';
const RETRY_MISS_MS = 14 * 24 * 3600 * 1000;

/** Loose title key: drops bracketed qualifiers and punctuation. */
const simple = (s) => norm(s)
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

function matchScore(candTitle, candArtist, album, artist) {
  const a = simple(album);
  const c = simple(candTitle);
  if (!a || !c) return -1;
  let score;
  if (c === a) score = 3;
  else if (c.startsWith(a) || a.startsWith(c)) score = 2;
  else if (c.includes(a) || a.includes(c)) score = 1;
  else return -1;
  if (artist && artist !== 'Various Artists') {
    const x = simple(artist);
    const y = simple(candArtist);
    if (x === y) score += 2;
    else if (x && y && (y.includes(x) || x.includes(y))) score += 1;
    else return -1;
  }
  return score;
}

/**
 * Stand-in for the retired Zune Marketplace metadata service. Uses the public
 * Deezer and iTunes Search APIs (no keys) for album covers, artist photos and
 * related artists. Every answer, including "not found", is cached on disk.
 */
export class Online {
  constructor({ file, isEnabled }) {
    this.cache = new JsonStore(file, { albums: {}, artists: {}, related: {} });
    this.cache.load();
    this.isEnabled = isEnabled;
    this.queue = Promise.resolve();
    this.last = 0;
  }

  enabled(feature) {
    return !!this.isEnabled(feature);
  }

  #json(url) {
    const run = async () => {
      const wait = this.last + 160 - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const body = await res.json();
      if (body?.error) throw new Error(`API error: ${JSON.stringify(body.error)}`);
      return body;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async download(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async albumCoverUrl(artist, album) {
    const key = `${norm(artist)}|${norm(album)}`;
    const hit = this.cache.data.albums[key];
    if (hit && (hit.url || Date.now() - hit.t < RETRY_MISS_MS)) return hit.url || null;
    let url = null;
    try {
      url = await this.#deezerAlbum(artist, album);
    } catch (err) {
      console.warn('[online] deezer album lookup failed:', err.message);
    }
    if (!url) {
      try {
        url = await this.#itunesAlbum(artist, album);
      } catch (err) {
        console.warn('[online] itunes album lookup failed:', err.message);
      }
    }
    this.cache.data.albums[key] = { url, t: Date.now() };
    this.cache.save();
    return url;
  }

  async #deezerAlbum(artist, album) {
    // Deezer's field syntax (artist:"x" album:"y") misses a lot; a plain query plus scoring works better.
    const bare = album.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim() || album;
    const q = artist && artist !== 'Various Artists' ? `${artist} ${bare}` : bare;
    const body = await this.#json(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`);
    let best = null;
    let bestScore = 0;
    for (const d of body.data || []) {
      const s = matchScore(d.title, d.artist?.name, album, artist);
      if (s > bestScore) {
        best = d;
        bestScore = s;
      }
    }
    const url = best?.cover_xl || best?.cover_big;
    return url && !/\/cover\/\/|\/images\/cover\/$/.test(url) ? url : null;
  }

  async #itunesAlbum(artist, album) {
    const term = `${artist && artist !== 'Various Artists' ? artist : ''} ${album}`.trim();
    const body = await this.#json(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&media=music&limit=10`);
    let best = null;
    let bestScore = 0;
    for (const r of body.results || []) {
      const s = matchScore(r.collectionName, r.artistName, album, artist);
      if (s > bestScore) {
        best = r;
        bestScore = s;
      }
    }
    return best?.artworkUrl100 ? best.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
  }

  async artist(name) {
    if (!name || /^(unknown artist|various artists)$/i.test(name)) return null;
    const key = norm(name);
    const hit = this.cache.data.artists[key];
    if (hit && (hit.id || Date.now() - hit.t < RETRY_MISS_MS)) return hit.id ? hit : null;
    let found = null;
    try {
      const body = await this.#json(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=15`);
      // Deezer ranks obscure namesakes first (a 13-fan "Queen" before the band), so take
      // the most-followed artist whose name matches exactly.
      const d = (body.data || [])
        .filter((a) => simple(a.name) === simple(name))
        .sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0] || null;
      if (d) {
        const picture = d.picture_xl && !/\/artist\/\//.test(d.picture_xl) ? d.picture_xl : null;
        found = { id: d.id, name: d.name, picture, fans: d.nb_fan || 0 };
      }
    } catch (err) {
      console.warn('[online] artist lookup failed:', err.message);
      return null; // don't cache network failures
    }
    this.cache.data.artists[key] = { ...(found || {}), t: Date.now() };
    this.cache.save();
    return found;
  }

  async related(name) {
    const key = norm(name);
    const hit = this.cache.data.related[key];
    if (hit && Date.now() - hit.t < RETRY_MISS_MS) return hit.names;
    const a = await this.artist(name);
    if (!a) return [];
    let names = [];
    try {
      const body = await this.#json(`https://api.deezer.com/artist/${a.id}/related?limit=40`);
      names = (body.data || []).map((d) => d.name);
    } catch (err) {
      console.warn('[online] related lookup failed:', err.message);
      return [];
    }
    this.cache.data.related[key] = { names, t: Date.now() };
    this.cache.save();
    return names;
  }
}
