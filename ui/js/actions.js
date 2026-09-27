// Commands shared by every view: playing things, playlists, ratings, pins, menus.
import { api, native } from './api.js';
import { confirm, modal, prompt, toast } from './components.js';
import { model } from './model.js';
import { player } from './player.js';
import { router } from './router.js';
import { buildSmartDJ } from './smartdj.js';
import { esc, fmtTime, plural, shuffleArray } from './util.js';

const tracksOf = (ids) => ids.map((id) => model.tracks.get(id)).filter(Boolean);

/** Hooks the shell fills in (avoids importing the overlay views here). */
export const ui = { openMixview: null, syncTracks: null };

/** "sync with <zune>" — only while a Zune is plugged in. */
const syncItem = (getIds) => (model.device?.connected
  ? { label: `sync with ${model.device.device?.name || 'zune'}`, action: () => ui.syncTracks?.(getIds()) }
  : null);

export async function playItem(item, { shuffle = false } = {}) {
  if (item.type === 'smartdj') return startSmartDJ(item.id);
  const d = model.describe(item);
  if (!d) return;
  let tracks = d.tracks();
  if (!tracks.length) return toast('Nothing to play here yet.');
  if (shuffle) tracks = shuffleArray(tracks);
  player.playTracks(tracks, 0, { type: item.type, id: item.id, label: d.title });
}

export function enqueueItem(item) {
  const d = model.describe(item);
  if (!d) return;
  const tracks = d.tracks();
  player.enqueue(tracks);
  toast(`Added ${plural(tracks.length, 'song')} to now playing`);
}

export async function startSmartDJ(artistId) {
  const a = model.artists.get(artistId);
  if (!a) return;
  toast(`Smart DJ: mixing songs like ${a.name}…`, 1800);
  const { tracks } = await buildSmartDJ(artistId);
  if (!tracks.length) return toast('Smart DJ needs more music to work with.');
  player.playTracks(tracks, 0, { type: 'smartdj', id: artistId, label: `${a.name} smart dj` });
}

// ---------------------------------------------------------------- playlists
export async function newPlaylist(trackIds = []) {
  const name = await prompt('new playlist', { placeholder: 'playlist name', okLabel: 'create' });
  if (!name) return null;
  try {
    const res = await api('playlists', { name, trackIds });
    model.setPlaylists(res.playlists);
    toast(trackIds.length ? `Created "${res.playlist.name}" with ${plural(trackIds.length, 'song')}` : `Created "${res.playlist.name}"`);
    return res.playlist;
  } catch (err) {
    toast(`Couldn't create the playlist: ${err.message}`);
    return null;
  }
}

export async function addToPlaylist(playlistId, trackIds) {
  const pl = model.playlists.get(playlistId);
  if (!pl || !trackIds.length) return;
  try {
    const res = await api(`playlists/${playlistId}`, { append: trackIds });
    model.setPlaylists(res.playlists);
    toast(`Added ${plural(trackIds.length, 'song')} to ${res.playlist.name}`);
    return res.playlist;
  } catch (err) {
    toast(`Couldn't update the playlist: ${err.message}`);
  }
}

export async function savePlaylistOrder(playlistId, trackIds) {
  const res = await api(`playlists/${playlistId}`, { trackIds });
  model.setPlaylists(res.playlists);
  return res.playlist;
}

export async function renamePlaylist(playlistId) {
  const pl = model.playlists.get(playlistId);
  if (!pl) return;
  const name = await prompt('rename playlist', { value: pl.name, okLabel: 'rename' });
  if (!name || name === pl.name) return;
  const res = await api(`playlists/${playlistId}`, { name });
  model.setPlaylists(res.playlists);
  return res.playlist;
}

export async function deletePlaylist(playlistId) {
  const pl = model.playlists.get(playlistId);
  if (!pl) return;
  const ok = await confirm('delete playlist', `Move "${pl.name}" to the Recycle Bin? The songs stay in your collection.`, 'delete');
  if (!ok) return;
  try {
    const res = await api(`playlists/${playlistId}`, undefined, 'DELETE');
    model.setPlaylists(res.playlists);
    model.user.pins = model.user.pins.filter((p) => !(p.type === 'playlist' && p.id === playlistId));
    model.emit('pins');
    toast(`Deleted "${pl.name}"`);
  } catch (err) {
    toast(err.message);
  }
}

export function playlistSubmenu(getTrackIds) {
  return () => [
    { label: 'new playlist…', action: () => newPlaylist(getTrackIds()) },
    ...(model.playlistList.length ? ['-'] : []),
    ...model.playlistList.slice(0, 40).map((p) => ({ label: p.name, action: () => addToPlaylist(p.id, getTrackIds()) })),
  ];
}

// ---------------------------------------------------------------- ratings, pins, info
export function rateSubmenu(trackIds) {
  const current = trackIds.length === 1 ? model.rating(trackIds[0]) : undefined;
  const set = (r) => () => trackIds.forEach((id) => model.setRating(id, r));
  return [
    { label: 'I like it', checked: current === 'love', action: set('love') },
    { label: "I don't like it", checked: current === 'hate', action: set('hate') },
    { label: 'no rating', checked: current === null, action: set(null) },
  ];
}

export function cycleRating(trackId) {
  const r = model.rating(trackId);
  model.setRating(trackId, r === 'love' ? 'hate' : r === 'hate' ? null : 'love');
}

export function pinItem(type, id) {
  const pinned = model.isPinned(type, id);
  return { label: pinned ? 'unpin from quickplay' : 'pin to quickplay', action: () => model.setPinned(type, id, !pinned) };
}

export async function showProperties(trackId) {
  let info;
  try {
    info = await api(`track/${trackId}`);
  } catch (err) {
    return toast(err.message);
  }
  const t = info.track;
  const c = info.tags?.common || {};
  const f = info.tags?.format || {};
  const rows = [
    ['title', t.title],
    ['artist', t.artist],
    ['album artist', t.aa],
    ['album', t.album],
    ['genre', t.genre],
    ['year', t.year],
    ['track', t.track && `${t.track}${c.track?.of ? ` of ${c.track.of}` : ''}`],
    ['disc', t.disc && `${t.disc}${c.disk?.of ? ` of ${c.disk.of}` : ''}`],
    ['composer', c.composer?.join(', ')],
    ['length', t.duration && fmtTime(t.duration)],
    ['format', [f.container, f.codec].filter(Boolean).join(' · ')],
    ['bit rate', f.bitrate && `${Math.round(f.bitrate / 1000)} kbps`],
    ['sample rate', f.sampleRate && `${(f.sampleRate / 1000).toFixed(1)} kHz${f.bitsPerSample ? ` · ${f.bitsPerSample}-bit` : ''}`],
    ['size', info.size && `${(info.size / 1048576).toFixed(1)} MB`],
    ['play count', String(info.plays)],
    ['last played', info.lastPlayed && new Date(info.lastPlayed).toLocaleString()],
    ['rating', model.rating(trackId) === 'love' ? 'I like it' : model.rating(trackId) === 'hate' ? "I don't like it" : 'none'],
    ['file', t.path],
  ].filter(([, v]) => v != null && v !== '');
  await modal(`
    <h2>${esc(t.title)}</h2>
    <table class="props">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="buttons">${native ? '<button class="zbtn" data-reveal>open file location</button>' : ''}<button class="zbtn primary" data-result="ok">close</button></div>
  `, {
    onOpen: (dlg) => dlg.querySelector('[data-reveal]')?.addEventListener('click', () => reveal(trackId)),
  });
}

export function reveal(trackId) {
  api('reveal', { id: trackId }).catch((err) => toast(err.message));
}

// ---------------------------------------------------------------- navigation
export function goToArtist(artistId) {
  router.go({ pivot: 'collection', sub: 'music', view: 'artists', params: { artists: [artistId] } });
}

export function goToAlbum(albumId) {
  const a = model.albums.get(albumId);
  if (!a) return;
  router.go({ pivot: 'collection', sub: 'music', view: 'artists', params: { artists: [a.artistId], albums: [albumId] } });
}

export function goToPlaylist(playlistId) {
  router.go({ pivot: 'collection', sub: 'music', view: 'playlists', params: { playlist: playlistId } });
}

// ---------------------------------------------------------------- menus
export function trackMenu(trackIds, { playlistId, onRemove } = {}) {
  const tracks = tracksOf(trackIds);
  if (!tracks.length) return [];
  const one = tracks.length === 1 ? tracks[0] : null;
  return [
    { label: 'play', action: () => player.playTracks(tracks, 0, null) },
    { label: 'add to now playing', action: () => { player.enqueue(tracks); toast(`Added ${plural(tracks.length, 'song')} to now playing`); } },
    { label: 'play next', action: () => { player.playNext(tracks); toast(`${plural(tracks.length, 'song')} will play next`); } },
    '-',
    { label: 'add to playlist', submenu: playlistSubmenu(() => trackIds) },
    { label: 'rate', submenu: rateSubmenu(trackIds) },
    one && pinItem('track', one.id),
    syncItem(() => trackIds),
    '-',
    onRemove && { label: 'remove from playlist', action: onRemove },
    one && { label: 'find in collection', action: () => goToAlbum(one.albumId) },
    one && native && { label: 'open file location', action: () => reveal(one.id) },
    one && { label: 'properties', action: () => showProperties(one.id) },
  ].filter(Boolean);
}

export function albumMenu(albumIds) {
  const albums = albumIds.map((id) => model.albums.get(id)).filter(Boolean);
  if (!albums.length) return [];
  const tracks = () => model.tracksOfAlbums(albums).map((t) => t.id);
  const one = albums.length === 1 ? albums[0] : null;
  return [
    { label: 'play', action: () => player.playTracks(tracksOf(tracks()), 0, one ? { type: 'album', id: one.id, label: one.title } : null) },
    { label: 'shuffle', action: () => player.playTracks(shuffleArray(tracksOf(tracks())), 0, one ? { type: 'album', id: one.id, label: one.title } : null) },
    { label: 'add to now playing', action: () => { player.enqueue(tracksOf(tracks())); toast(`Added ${plural(tracks().length, 'song')} to now playing`); } },
    '-',
    { label: 'add to playlist', submenu: playlistSubmenu(tracks) },
    one && pinItem('album', one.id),
    syncItem(tracks),
    one && one.artist !== 'Various Artists' && { label: 'start smart dj', action: () => startSmartDJ(one.artistId) },
    one && one.artist !== 'Various Artists' && one.artist !== 'Unknown Artist' && { label: 'mixview', action: () => ui.openMixview?.(one.artist) },
    '-',
    one && { label: `go to ${one.artist}`, action: () => goToArtist(one.artistId) },
    one && native && { label: 'open file location', action: () => reveal(one.trackIds[0]) },
  ].filter(Boolean);
}

export function artistMenu(artistIds) {
  const tracks = () => artistIds.flatMap((id) => model.tracksOfArtist(id)).map((t) => t.id);
  const one = artistIds.length === 1 ? model.artists.get(artistIds[0]) : null;
  return [
    { label: 'play all', action: () => player.playTracks(tracksOf(tracks()), 0, one ? { type: 'artist', id: one.id, label: one.name } : null) },
    { label: 'shuffle all', action: () => player.playTracks(shuffleArray(tracksOf(tracks())), 0, one ? { type: 'artist', id: one.id, label: one.name } : null) },
    { label: 'add to now playing', action: () => { player.enqueue(tracksOf(tracks())); toast('Added to now playing'); } },
    '-',
    one && { label: 'start smart dj', action: () => startSmartDJ(one.id) },
    one && { label: 'mixview', action: () => ui.openMixview?.(one.name) },
    { label: 'add to playlist', submenu: playlistSubmenu(tracks) },
    one && pinItem('artist', one.id),
    syncItem(tracks),
  ].filter(Boolean);
}

export function playlistMenu(playlistId) {
  const pl = model.playlists.get(playlistId);
  if (!pl) return [];
  return [
    { label: 'play', action: () => playItem({ type: 'playlist', id: pl.id }) },
    { label: 'shuffle', action: () => playItem({ type: 'playlist', id: pl.id }, { shuffle: true }) },
    { label: 'add to now playing', action: () => enqueueItem({ type: 'playlist', id: pl.id }) },
    '-',
    pinItem('playlist', pl.id),
    syncItem(() => pl.trackIds),
    { label: 'rename', action: () => renamePlaylist(pl.id) },
    native && { label: 'delete', action: () => deletePlaylist(pl.id) },
  ].filter(Boolean);
}
