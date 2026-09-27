// Smart DJ: an endless-feeling mix seeded by one artist. The original used Zune's
// online "related artists" data; we use the same idea via the server's Deezer lookup,
// then fall back to artists that share a genre in your collection.
import { api } from './api.js';
import { model } from './model.js';

const norm = (s) => String(s || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** Avoid playing the same artist twice in a row where possible. */
function spread(tracks) {
  const out = [];
  const pending = [...tracks];
  while (pending.length) {
    const last = out[out.length - 1];
    let idx = pending.findIndex((t) => !last || t.artistId !== last.artistId);
    if (idx < 0) idx = 0;
    out.push(pending.splice(idx, 1)[0]);
  }
  return out;
}

export async function buildSmartDJ(artistId, size = 80) {
  const seed = model.artists.get(artistId);
  if (!seed) return { tracks: [], related: 0 };
  let related = [];
  try {
    related = (await api('related', { artist: seed.name })).names || [];
  } catch {}
  const byName = new Map(model.artistList.map((a) => [norm(a.name), a]));
  const relatedArtists = [...new Set(related.map((n) => byName.get(norm(n))).filter((a) => a && a.id !== artistId))];

  const seedTracks = model.tracksOfArtist(artistId);
  const seedGenres = new Set(seedTracks.map((t) => t.genreId));
  const relatedIds = new Set(relatedArtists.map((a) => a.id));
  const genreArtists = model.artistList.filter((a) => a.id !== artistId && !relatedIds.has(a.id)
    && model.tracksOfArtist(a.id).some((t) => seedGenres.has(t.genreId)));

  const pool = [];
  const add = (tracks, weight) => {
    for (const t of tracks) {
      const rating = model.rating(t.id);
      if (rating === 'hate') continue;
      const w = weight * (rating === 'love' ? 1.7 : 1) * (1 + Math.min(model.plays(t.id), 20) / 40);
      pool.push({ t, key: Math.random() ** (1 / w) });
    }
  };
  add(seedTracks, 3);
  for (const a of relatedArtists) add(model.tracksOfArtist(a.id), 2);
  for (const a of genreArtists) add(model.tracksOfArtist(a.id).filter((t) => seedGenres.has(t.genreId)), 1);
  pool.sort((a, b) => b.key - a.key);
  return { tracks: spread(pool.slice(0, size).map((p) => p.t)), related: relatedArtists.length };
}
