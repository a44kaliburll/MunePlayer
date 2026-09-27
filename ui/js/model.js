// Client-side copy of the collection plus the user's ratings, plays, pins and settings.
import { api } from './api.js';
import { Emitter, byName, collator, sortName } from './util.js';

class Model extends Emitter {
  tracks = new Map();
  albums = new Map();
  artists = new Map();
  genres = new Map();
  playlists = new Map();
  artistList = [];
  albumList = [];
  genreList = [];
  trackList = [];
  playlistList = [];
  user = { settings: {}, ratings: {}, plays: {}, lastPlayed: {}, pins: [], history: [], session: null };
  profile = { name: '' };
  youtube = { configured: false, signedIn: false };
  scan = { scanning: false };
  platform = {};
  artVer = new Map();
  libVersion = 0;

  setLibrary(lib) {
    this.tracks = new Map(lib.tracks.map((t) => [t.id, t]));
    this.albums = new Map(lib.albums.map((a) => [a.id, a]));
    this.artists = new Map(lib.artists.map((a) => [a.id, a]));
    this.genres = new Map(lib.genres.map((g) => [g.id, g]));
    this.artistList = [...this.artists.values()].sort(byName((a) => a.name));
    this.albumList = [...this.albums.values()].sort(byName((a) => a.title));
    this.genreList = [...this.genres.values()].sort(byName((g) => g.name));
    this.trackList = [...this.tracks.values()].sort(byName((t) => t.title));
    this.libVersion = lib.version;
    this.emit('library');
  }

  setPlaylists(list) {
    this.playlists = new Map(list.map((p) => [p.id, p]));
    this.playlistList = [...list].sort((a, b) => collator.compare(a.name, b.name));
    this.emit('playlists');
  }

  // ---------------------------------------------------------------- lookups
  rating(id) {
    return this.user.ratings[id] || null;
  }

  plays(id) {
    return this.user.plays[id] || 0;
  }

  artVersion(albumId) {
    return this.artVer.get(albumId) || 0;
  }

  bumpArt(albumId) {
    this.artVer.set(albumId, this.artVersion(albumId) + 1);
    this.emit('art', albumId);
  }

  albumsOf(artistIds) {
    const ids = new Set();
    for (const id of artistIds) for (const a of this.artists.get(id)?.albumIds || []) ids.add(a);
    return [...ids].map((id) => this.albums.get(id)).filter(Boolean);
  }

  albumsOfGenres(genreIds) {
    const ids = new Set();
    for (const id of genreIds) for (const a of this.genres.get(id)?.albumIds || []) ids.add(a);
    return [...ids].map((id) => this.albums.get(id)).filter(Boolean);
  }

  /** Tracks of albums in album order (albums sorted by year, then title). */
  tracksOfAlbums(albums, { genreIds } = {}) {
    const sorted = [...albums].sort((a, b) => (a.year || 9999) - (b.year || 9999) || collator.compare(sortName(a.title), sortName(b.title)));
    const out = [];
    for (const a of sorted) {
      for (const id of a.trackIds) {
        const t = this.tracks.get(id);
        if (!t) continue;
        if (genreIds && !genreIds.has(t.genreId)) continue;
        out.push(t);
      }
    }
    return out;
  }

  tracksOfArtist(artistId) {
    return this.tracksOfAlbums(this.albumsOf([artistId]));
  }

  totalPlays() {
    let n = 0;
    for (const v of Object.values(this.user.plays)) n += v;
    return n;
  }

  /** Title/subtitle/art/tracks for anything that can be pinned or played from Quickplay. */
  describe(item) {
    const { type, id } = item;
    if (type === 'album') {
      const a = this.albums.get(id);
      return a && { type, id, title: a.title, sub: a.artist, albumId: a.id, tracks: () => a.trackIds.map((t) => this.tracks.get(t)).filter(Boolean) };
    }
    if (type === 'artist') {
      const a = this.artists.get(id);
      if (!a) return null;
      const first = this.tracksOfArtist(id).find((t) => t.albumId);
      return { type, id, title: a.name, sub: 'artist', albumId: first?.albumId, tracks: () => this.tracksOfArtist(id) };
    }
    if (type === 'playlist') {
      const p = this.playlists.get(id);
      if (!p) return null;
      const first = p.trackIds.map((t) => this.tracks.get(t)).find(Boolean);
      return { type, id, title: p.name, sub: 'playlist', albumId: first?.albumId, tracks: () => p.trackIds.map((t) => this.tracks.get(t)).filter(Boolean) };
    }
    if (type === 'genre') {
      const g = this.genres.get(id);
      if (!g) return null;
      return { type, id, title: g.name, sub: 'genre', albumId: g.albumIds[0], tracks: () => this.tracksOfAlbums(this.albumsOfGenres([id]), { genreIds: new Set([id]) }) };
    }
    if (type === 'track') {
      const t = this.tracks.get(id);
      return t && { type, id, title: t.title, sub: t.artist || t.aa, albumId: t.albumId, tracks: () => [t] };
    }
    if (type === 'smartdj') {
      const a = this.artists.get(id);
      if (!a) return null;
      const first = this.tracksOfArtist(id)[0];
      return { type, id, title: a.name, sub: 'smart dj', albumId: first?.albumId, tracks: () => this.tracksOfArtist(id) };
    }
    return null;
  }

  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return { artists: [], albums: [], tracks: [] };
    const has = (s) => String(s || '').toLowerCase().includes(q);
    return {
      artists: this.artistList.filter((a) => has(a.name)),
      albums: this.albumList.filter((a) => has(a.title) || has(a.artist)),
      tracks: this.trackList.filter((t) => has(t.title) || has(t.artist) || has(t.album) || has(t.aa)),
    };
  }

  // ---------------------------------------------------------------- mutations
  async setRating(id, rating) {
    if (rating) this.user.ratings[id] = rating;
    else delete this.user.ratings[id];
    this.emit('rating', id);
    await api('rate', { id, rating });
  }

  isPinned(type, id) {
    return this.user.pins.some((p) => p.type === type && p.id === id);
  }

  async setPinned(type, id, on) {
    const { pins } = await api('pins', { op: on ? 'add' : 'remove', type, id });
    this.user.pins = pins;
    this.emit('pins');
  }

  async addHistory(type, id) {
    try {
      const { history } = await api('history', { type, id });
      this.user.history = history;
      this.emit('history');
    } catch {}
  }

  async countPlay(id) {
    try {
      const { plays } = await api('played', { id });
      this.user.plays[id] = plays;
      this.user.lastPlayed[id] = Date.now();
      this.emit('plays', id);
    } catch {}
  }

  async saveSettings(patch) {
    const { settings, profile } = await api('settings', patch);
    this.user.settings = settings;
    if (profile) this.profile = profile;
    this.emit('settings');
    return settings;
  }
}

export const model = new Model();
