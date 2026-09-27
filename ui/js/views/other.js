// search results, social (a local Mune card) and the not-yet-built media types.
import { albumMenu, artistMenu, goToAlbum, goToArtist, playItem } from '../actions.js';
import { Selection, Virtual, showMenu, startDrag } from '../components.js';
import { model } from '../model.js';
import { player } from '../player.js';
import { router } from '../router.js';
import { artUrl, el, esc, icons, plural } from '../util.js';
import { SongColumn, albumTile, wireArt } from './collection.js';

// ---------------------------------------------------------------- search
export function searchView(page, state) {
  const q = state.params.q || '';
  const res = model.search(q);
  const root = el('<div class="coll artists"></div>');
  page.appendChild(root);
  wireArt(root);

  const left = el(`<section class="col"><div class="colhead"><b>${esc(plural(res.artists.length, 'artist'))}</b></div><div class="colbody" tabindex="0"></div></section>`);
  const mid = el(`<section class="col"><div class="colhead"><b>${esc(plural(res.albums.length, 'album'))}</b></div><div class="colbody" tabindex="0"></div></section>`);
  const right = el('<section class="col songs-col"></section>');
  root.append(left, mid, right);

  const artists = new Virtual(left.querySelector('.colbody'), {
    itemHeight: 21,
    render: (a) => el(`<div class="row">${esc(a.name)}</div>`),
  });
  artists.setItems(res.artists);
  left.querySelector('.colbody').addEventListener('click', (e) => {
    const i = artists.indexOf(e.target);
    if (i >= 0) goToArtist(res.artists[i].id);
  });
  left.querySelector('.colbody').addEventListener('contextmenu', (e) => {
    const i = artists.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, artistMenu([res.artists[i].id]));
  });

  const songs = new SongColumn(right);
  const albumSel = new Selection(() => {
    grid.refresh();
    const chosen = albumSel.indices().map((i) => res.albums[i]);
    if (chosen.length) songs.set({ tracks: model.tracksOfAlbums(chosen), numbers: chosen.length === 1, album: chosen.length === 1 ? chosen[0] : null, context: chosen.length === 1 ? { type: 'album', id: chosen[0].id } : null });
    else songs.set({ tracks: res.tracks, numbers: false, sortKey: 'az' });
  });
  const midBody = mid.querySelector('.colbody');
  const grid = new Virtual(midBody, {
    itemHeight: 106,
    itemWidth: 72,
    gapX: 14,
    gapY: 14,
    render: (a) => albumTile(a),
    update: (node, a, i) => node.classList.toggle('sel', albumSel.has(i)),
  });
  grid.setItems(res.albums);
  midBody.addEventListener('click', (e) => {
    const i = grid.indexOf(e.target);
    if (i < 0) return;
    if (e.target.closest('.play')) return playItem({ type: 'album', id: res.albums[i].id });
    albumSel.click(i, e);
  });
  midBody.addEventListener('dblclick', (e) => {
    const i = grid.indexOf(e.target);
    if (i >= 0) playItem({ type: 'album', id: res.albums[i].id });
  });
  midBody.addEventListener('contextmenu', (e) => {
    const i = grid.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, albumMenu([res.albums[i].id]));
  });
  midBody.addEventListener('dragstart', (e) => {
    const i = grid.indexOf(e.target);
    if (i < 0) return;
    const ids = res.albums[i].trackIds;
    startDrag(e, ids, plural(ids.length, 'song'));
  });
  songs.set({ tracks: res.tracks, numbers: false, sortKey: 'az' });

  const unsub = [
    player.on('track', () => songs.refresh()),
    model.on('rating', () => songs.refresh()),
  ];
  return {
    destroy() {
      unsub.forEach((u) => u());
      artists.destroy();
      grid.destroy();
      songs.destroy();
    },
    refresh() {
      songs.refresh();
    },
    onKey: (e) => songs.onKey(e),
  };
}

// ---------------------------------------------------------------- social: your mune card
const MEDALS = [
  [250, 'platinum', '#8e9aa6'],
  [100, 'gold', '#d4a017'],
  [50, 'silver', '#a7a7a7'],
  [10, 'bronze', '#b0703c'],
];

export function socialView(page) {
  const plays = model.user.plays;
  const total = model.totalPlays();
  const loved = Object.entries(model.user.ratings).filter(([, r]) => r === 'love').map(([id]) => model.tracks.get(id)).filter(Boolean);
  const recent = Object.entries(model.user.lastPlayed)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => model.tracks.get(id))
    .filter(Boolean);
  const recentAlbums = [...new Set(recent.map((t) => t.albumId))].slice(0, 8);
  const byArtist = new Map();
  for (const [id, n] of Object.entries(plays)) {
    const t = model.tracks.get(id);
    if (t) byArtist.set(t.artistId, (byArtist.get(t.artistId) || 0) + n);
  }
  const topArtists = [...byArtist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topSongs = Object.entries(plays).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => [model.tracks.get(id), n]).filter(([t]) => t);
  const badges = topArtists.map(([id, n]) => {
    const medal = MEDALS.find(([min]) => n >= min);
    return medal && { name: model.artists.get(id)?.name, level: medal[1], color: medal[2], n };
  }).filter(Boolean).slice(0, 6);

  const root = el(`
    <div class="social">
      <div class="zcard">
        <div class="who"><div class="avatar">${icons.person}</div><div><b>${esc(model.profile.name)}</b><span>mune card</span></div></div>
        <div class="stats">
          <div><b>${total.toLocaleString()}</b><span>plays</span></div>
          <div><b>${model.tracks.size.toLocaleString()}</b><span>songs</span></div>
          <div><b>${loved.length.toLocaleString()}</b><span>favorites</span></div>
        </div>
        <div class="arts">${recentAlbums.map((id) => `<div style="background-image:url('${artUrl(id, 'm', model.artVersion(id))}')" data-album="${id}" title="${esc(model.albums.get(id)?.title || '')}"></div>`).join('') || '<div></div>'}</div>
      </div>
      <div class="lists">
        ${badges.length ? `<section><h3>badges</h3><div class="badges">${badges.map((b) => `<div class="badge"><div class="medal" style="background:${b.color}">${b.n}</div><b>${esc(b.name)}</b><span>${esc(b.level)} fan</span></div>`).join('')}</div></section>` : ''}
        <section><h3>most played artists</h3><div class="toplist">${topArtists.map(([id, n], i) => `<div class="item" data-artist="${id}"><i>${i + 1}</i><span>${esc(model.artists.get(id)?.name || '')}</span><small>${plural(n, 'play')}</small></div>`).join('') || '<div class="hint">Play some music and your top artists show up here.</div>'}</div></section>
        <section><h3>most played songs</h3><div class="toplist">${topSongs.map(([t, n], i) => `<div class="item" data-track="${t.id}"><i>${i + 1}</i><span>${esc(t.title)}</span><small>${plural(n, 'play')}</small></div>`).join('') || '<div class="hint">Nothing yet.</div>'}</div></section>
        <section><h3>favorites</h3><div class="toplist">${loved.slice(0, 30).map((t, i) => `<div class="item" data-track="${t.id}"><i>${i + 1}</i><span>${esc(t.title)}</span><small>${esc(t.artist || t.aa)}</small></div>`).join('') || '<div class="hint">Click the heart next to a song to add it here.</div>'}</div></section>
      </div>
    </div>`);
  page.appendChild(root);
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-artist]');
    if (a) return goToArtist(a.dataset.artist);
    const alb = e.target.closest('[data-album]');
    if (alb) return goToAlbum(alb.dataset.album);
  });
  root.addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-track]');
    if (t) player.playTracks([t.dataset.track], 0, null);
  });
  return { destroy() {}, refresh() {} };
}

// ---------------------------------------------------------------- placeholders
const PLACEHOLDERS = {
  videos: (s) => ({
    title: 'videos',
    body: `Video playback isn't part of Mune Player yet. Your video folders are ${(s.videoFolders || []).map(esc).join(', ') || 'not set'}.`,
  }),
  pictures: (s) => ({
    title: 'pictures',
    body: `Pictures aren't part of Mune Player yet. Your picture folders are ${(s.pictureFolders || []).map(esc).join(', ') || 'not set'}.`,
  }),
  podcasts: () => ({ title: 'podcasts', body: 'Podcast subscriptions aren\'t part of Mune Player yet.' }),
  channels: () => ({ title: 'channels', body: 'Zune channels were a streaming service. They went away with the Zune service in 2015.' }),
};

export function placeholderView(page, key) {
  const make = PLACEHOLDERS[key] || (() => ({ title: key, body: '' }));
  const p = make(model.user.settings || {});
  const root = el(`<div class="placeholder"><h2>${esc(p.title)}</h2><p>${p.body}</p>${p.button ? `<button class="zbtn">${esc(p.button[0])}</button>` : ''}</div>`);
  page.appendChild(root);
  root.querySelector('.zbtn')?.addEventListener('click', () => router.go(p.button[1]));
  return { destroy() {}, refresh() {} };
}
