// collection > music: artists | genres | albums | songs | playlists
import { native } from '../api.js';
import {
  addToPlaylist, albumMenu, artistMenu, cycleRating, deletePlaylist, newPlaylist, playItem, playlistMenu,
  renamePlaylist, savePlaylistOrder, trackMenu,
} from '../actions.js';
import { Selection, Virtual, droppedTracks, isTrackDrag, showMenu, startDrag, toast } from '../components.js';
import { model } from '../model.js';
import { player } from '../player.js';
import { router } from '../router.js';
import {
  artUrl, collator, el, esc, fmtDuration, fmtTime, icons, pad2, plural, sortName,
} from '../util.js';

const ROW = 21;
const sorts = {
  artists: 'az',
  genres: 'az',
  albums: 'az',
  songs: 'az',
  table: { key: 'title', dir: 1 },
};
const SORT_LABEL = { az: 'a-z', added: 'by date added', year: 'by release year', artist: 'by artist', album: 'by album', rating: 'by rating', plays: 'by plays' };
const noArt = new Set();

// ---------------------------------------------------------------- shared renderers
function artImg(albumId, size = 'm') {
  if (noArt.has(albumId)) return '';
  return `<img alt="" src="${artUrl(albumId, size, model.artVersion(albumId))}" data-album="${albumId}">`;
}

export function wireArt(root) {
  root.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG') e.target.classList.add('ok');
  }, true);
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || !img.dataset.album) return;
    noArt.add(img.dataset.album);
    img.remove();
  }, true);
}

model.on('art', (albumId) => {
  noArt.delete(albumId);
  for (const img of document.querySelectorAll(`img[data-album="${albumId}"]`)) {
    img.classList.remove('ok');
    img.src = artUrl(albumId, img.src.includes('s=l') ? 'l' : 'm', model.artVersion(albumId));
  }
  for (const art of document.querySelectorAll(`[data-art-album="${albumId}"]`)) {
    if (!art.querySelector('img')) art.insertAdjacentHTML('afterbegin', artImg(albumId));
  }
});

function albumTile(a) {
  return el(`
    <div class="tile" draggable="true">
      <div class="art" data-art-album="${a.id}">${artImg(a.id)}<button class="play" title="Play">${icons.playTile}</button></div>
      <div class="t1">${esc(a.title)}</div>
      <div class="t2">${esc(a.artist)}</div>
    </div>`);
}

function heartHtml(id, playing) {
  const r = model.rating(id);
  if (r === 'love') return { cls: 'love', svg: icons.heart };
  if (r === 'hate') return { cls: 'hate', svg: icons.heartBroken };
  return { cls: 'none', svg: playing ? icons.heart : icons.heartOutline };
}

function songRow(t, numbers) {
  const node = el(`<div class="song" draggable="true"><span class="ind"></span>${numbers ? `<span class="num">${pad2(t.track)}</span>` : ''}<span class="title">${esc(t.title)}</span><button class="heart" title="Rate"></button></div>`);
  return node;
}

function updateSongRow(node, t, selected) {
  const playing = player.current?.id === t.id;
  node.classList.toggle('playing', playing);
  node.classList.toggle('sel', selected);
  const ind = node.querySelector('.ind');
  if (ind) ind.innerHTML = playing ? icons.eq : '';
  const h = heartHtml(t.id, playing);
  const btn = node.querySelector('.heart');
  if (btn) {
    btn.className = `heart ${h.cls}`;
    btn.innerHTML = h.svg;
  }
}

function sortTracks(list, mode) {
  const out = [...list];
  const title = (a, b) => collator.compare(sortName(a.title), sortName(b.title));
  if (mode === 'album') {
    out.sort((a, b) => collator.compare(sortName(a.album || ''), sortName(b.album || '')) || (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0));
  } else if (mode === 'artist') out.sort((a, b) => collator.compare(sortName(a.artist || a.aa), sortName(b.artist || b.aa)) || title(a, b));
  else if (mode === 'added') out.sort((a, b) => b.added - a.added);
  else if (mode === 'rating') {
    const rank = (t) => ({ love: 0, undefined: 1, null: 1, hate: 2 }[model.rating(t.id)] ?? 1);
    out.sort((a, b) => rank(a) - rank(b) || title(a, b));
  } else if (mode === 'plays') out.sort((a, b) => model.plays(b.id) - model.plays(a.id) || title(a, b));
  else out.sort(title);
  return out;
}

function sortAlbums(list, mode) {
  const out = [...list];
  const title = (a, b) => collator.compare(sortName(a.title), sortName(b.title));
  if (mode === 'year') out.sort((a, b) => (b.year || 0) - (a.year || 0) || title(a, b));
  else if (mode === 'added') out.sort((a, b) => b.added - a.added);
  else if (mode === 'artist') out.sort((a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || (a.year || 0) - (b.year || 0));
  else out.sort(title);
  return out;
}

function sortMenu(anchor, options, current, onPick) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, options.map((o) => ({ label: SORT_LABEL[o], checked: o === current, action: () => onPick(o) })), { className: 'sortmenu' });
}

function colHead(count, noun, sortKey, extra = '') {
  return `<div class="colhead"><b class="clear" title="Show all">${esc(plural(count, noun))}</b>${sortKey ? `<a class="sort">${esc(SORT_LABEL[sortKey])}</a>` : ''}<span class="spacer"></span>${extra}</div>`;
}

function emptyState(page) {
  const scanning = model.scan.scanning;
  const folders = model.user.settings.folders || [];
  const node = el(`
    <div class="empty">
      <h2>${scanning ? 'adding music…' : 'your collection is empty'}</h2>
      <p>${scanning
        ? `<span class="scanning">Reading ${esc(String(model.scan.done || 0))} of ${esc(String(model.scan.total || '?'))} files.</span> Songs show up here as soon as they're read.`
        : folders.length
          ? `Zoon is watching ${esc(folders.join(', '))}, but didn't find any music there. Add another folder in settings, or copy music into one of those folders.`
          : 'Tell Zoon where your music lives and it will keep your collection up to date automatically.'}</p>
      ${scanning ? '' : '<button class="zbtn primary" data-go-settings>add folders</button>'}
    </div>`);
  node.querySelector('[data-go-settings]')?.addEventListener('click', () => router.go({ pivot: 'settings', params: { section: 'collection' } }));
  page.appendChild(node);
  return { destroy() {}, refresh() {} };
}

// ---------------------------------------------------------------- song list column
/** The right-hand song list used by the artists, genres and albums views. */
class SongColumn {
  constructor(col) {
    this.col = col;
    this.tracks = [];
    this.numbers = false;
    this.sel = new Selection(() => this.list.refresh());
    col.innerHTML = '<div class="colhead"></div><div class="songhead" hidden></div><div class="colbody" tabindex="0"></div>';
    this.head = col.querySelector('.colhead');
    this.songhead = col.querySelector('.songhead');
    this.body = col.querySelector('.colbody');
    this.list = new Virtual(this.body, {
      itemHeight: ROW,
      render: (t) => {
        const node = songRow(t, this.numbers);
        updateSongRow(node, t, false);
        return node;
      },
      update: (node, t, i) => updateSongRow(node, t, this.sel.has(i)),
    });
    this.body.addEventListener('click', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      if (e.target.closest('.heart')) return cycleRating(this.tracks[i].id);
      this.sel.click(i, e);
    });
    this.body.addEventListener('dblclick', (e) => {
      const i = this.list.indexOf(e.target);
      if (i >= 0 && !e.target.closest('.heart')) this.play(i);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      this.sel.context(i);
      showMenu(e.clientX, e.clientY, trackMenu(this.selectedIds()));
    });
    this.body.addEventListener('dragstart', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      if (!this.sel.has(i)) this.sel.click(i, {});
      const ids = this.selectedIds();
      startDrag(e, ids, plural(ids.length, 'song'));
    });
    this.head.addEventListener('click', (e) => {
      if (e.target.closest('.sort') && !this.numbers) {
        sortMenu(e.target, ['az', 'album', 'artist', 'added', 'rating', 'plays'], sorts.songs, (m) => {
          sorts.songs = m;
          this.onSort?.();
        });
      }
    });
  }

  selectedIds() {
    return this.sel.indices().map((i) => this.tracks[i]?.id).filter(Boolean);
  }

  play(i) {
    player.playTracks(this.tracks, i, this.context);
  }

  set({ tracks, numbers, album, sortKey, context }) {
    this.tracks = tracks;
    this.numbers = numbers;
    this.context = context;
    this.sel.clear(true);
    this.head.innerHTML = `<b>${esc(plural(tracks.length, 'song'))}</b><a class="sort">${esc(numbers ? 'by album' : SORT_LABEL[sortKey])}</a><span class="spacer"></span><span class="hdr-icon" title="Rating">${icons.heart}</span>`;
    if (album) {
      this.songhead.hidden = false;
      const secs = tracks.reduce((s, t) => s + (t.duration || 0), 0);
      this.songhead.innerHTML = `<div class="album-name" title="${esc(album.title)}">${esc(album.title)}</div><div class="album-meta">${esc([album.artist, album.year, fmtDuration(secs)].filter(Boolean).join(' · '))}</div>`;
    } else {
      this.songhead.hidden = true;
    }
    this.list.setItems(tracks);
    const cur = player.current;
    const idx = cur ? tracks.findIndex((t) => t.id === cur.id) : -1;
    if (idx >= 0 && numbers) this.list.scrollToIndex(idx);
  }

  refresh() {
    this.list.refresh();
  }

  onKey(e) {
    if (document.activeElement !== this.body) return false;
    return listKeys(e, this.sel, this.tracks.length, this.list, (i) => this.play(i), (i) => this.tracks[i].title);
  }

  destroy() {
    this.list.destroy();
  }
}

let typed = '';
let typedAt = 0;

/** Arrow keys / Enter / Ctrl+A for a focused list, plus type-to-jump when `label` is given. */
function listKeys(e, sel, count, list, play, label) {
  if (!count) return false;
  if (label && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== ' ') {
    const now = Date.now();
    typed = now - typedAt > 900 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
    typedAt = now;
    for (let i = 0; i < count; i++) {
      if (sortName(label(i)).toLowerCase().startsWith(typed) || String(label(i)).toLowerCase().startsWith(typed)) {
        sel.click(i, {});
        list.scrollToIndex(i);
        break;
      }
    }
    return true;
  }
  if (e.key === 'a' && e.ctrlKey) {
    sel.all(count);
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const next = Math.max(0, Math.min(count - 1, sel.focus + (e.key === 'ArrowDown' ? 1 : -1)));
    sel.click(next, { shiftKey: e.shiftKey });
    list.scrollToIndex(next);
    return true;
  }
  if (e.key === 'Enter' && sel.focus >= 0) {
    play(sel.focus);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- artists / genres / albums
class BrowseView {
  constructor(page, kind) {
    this.kind = kind; // 'artists' | 'genres' | 'albums'
    this.root = el(`<div class="coll ${kind}"></div>`);
    page.appendChild(this.root);
    wireArt(this.root);
    this.leftIds = new Set(router.state.params[kind] || []);
    this.albumIds = new Set(router.state.params.albums || []);

    if (kind !== 'albums') {
      this.left = el('<section class="col"><div class="colhead"></div><div class="colbody" tabindex="0"></div></section>');
      this.root.appendChild(this.left);
      this.leftHead = this.left.querySelector('.colhead');
      this.leftBody = this.left.querySelector('.colbody');
      this.leftSel = new Selection(() => this.#leftChanged());
      this.leftList = new Virtual(this.leftBody, {
        itemHeight: ROW,
        render: (item) => el(`<div class="row" draggable="true">${esc(item.name)}</div>`),
        update: (node, item, i) => {
          node.classList.toggle('sel', this.leftSel.has(i));
          const cur = player.current;
          node.classList.toggle('playing', !!cur && (kind === 'artists' ? cur.artistId === item.id : cur.genreId === item.id));
        },
      });
      this.#wireLeft();
    }

    this.mid = el(`<section class="col ${kind === 'albums' ? 'big-tiles' : ''}"><div class="colhead"></div><div class="colbody" tabindex="0"></div></section>`);
    this.root.appendChild(this.mid);
    this.midHead = this.mid.querySelector('.colhead');
    this.midBody = this.mid.querySelector('.colbody');
    const tile = kind === 'albums' ? 104 : 72;
    this.albumSel = new Selection(() => this.#albumsChanged());
    this.grid = new Virtual(this.midBody, {
      itemHeight: tile + 34,
      itemWidth: tile,
      gapX: kind === 'albums' ? 20 : 14,
      gapY: kind === 'albums' ? 18 : 14,
      render: (a) => albumTile(a),
      update: (node, a, i) => {
        node.classList.toggle('sel', this.albumSel.has(i));
        node.classList.toggle('playing', player.current?.albumId === a.id);
      },
    });
    this.#wireGrid();

    const songCol = el('<section class="col songs-col"></section>');
    this.root.appendChild(songCol);
    this.songs = new SongColumn(songCol);
    this.songs.onSort = () => this.#fillSongs();

    this.unsub = [
      player.on('track', () => this.refresh()),
      model.on('rating', () => this.songs.refresh()),
      model.on('library', () => this.#fillLeft(true)),
    ];
    this.#fillLeft(false);
  }

  // ---- left column (artists or genres)
  #leftItems() {
    const list = this.kind === 'artists' ? model.artistList : model.genreList;
    const mode = sorts[this.kind];
    if (mode === 'added') return [...list].sort((a, b) => (b.added || 0) - (a.added || 0));
    return list;
  }

  #fillLeft(keep) {
    if (this.kind === 'albums') {
      this.#fillAlbums(keep);
      return;
    }
    this.items = this.#leftItems();
    const noun = this.kind === 'artists' ? 'artist' : 'genre';
    this.leftHead.innerHTML = colHead(this.items.length, noun, sorts[this.kind]).replace(/^<div class="colhead">|<\/div>$/g, '');
    this.leftSel.clear(true);
    this.items.forEach((item, i) => {
      if (this.leftIds.has(item.id)) this.leftSel.set.add(i);
    });
    const first = this.items.findIndex((item) => this.leftIds.has(item.id));
    this.leftSel.anchor = this.leftSel.focus = first;
    this.leftList.setItems(this.items, { keepScroll: keep });
    this.leftList.refresh();
    if (first >= 0 && !keep) this.leftList.scrollToIndex(first);
    this.#fillAlbums(keep);
  }

  #leftChanged() {
    this.leftList.refresh();
    this.leftIds = new Set(this.leftSel.indices().map((i) => this.items[i].id));
    this.albumIds = new Set();
    router.patch({ [this.kind]: [...this.leftIds], albums: [] });
    this.#fillAlbums(false);
  }

  #wireLeft() {
    const body = this.leftBody;
    body.addEventListener('click', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i >= 0) this.leftSel.click(i, e);
    });
    body.addEventListener('dblclick', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i < 0) return;
      const item = this.items[i];
      if (this.kind === 'artists') playItem({ type: 'artist', id: item.id });
      else playItem({ type: 'genre', id: item.id });
    });
    body.addEventListener('contextmenu', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      this.leftSel.context(i);
      const ids = this.leftSel.indices().map((k) => this.items[k].id);
      if (this.kind === 'artists') showMenu(e.clientX, e.clientY, artistMenu(ids));
      else {
        const g = this.items[i];
        showMenu(e.clientX, e.clientY, [
          { label: 'play', action: () => playItem({ type: 'genre', id: g.id }) },
          { label: 'shuffle', action: () => playItem({ type: 'genre', id: g.id }, { shuffle: true }) },
          { label: model.isPinned('genre', g.id) ? 'unpin from quickplay' : 'pin to quickplay', action: () => model.setPinned('genre', g.id, !model.isPinned('genre', g.id)) },
        ]);
      }
    });
    body.addEventListener('dragstart', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i < 0) return;
      const item = this.items[i];
      const d = model.describe({ type: this.kind === 'artists' ? 'artist' : 'genre', id: item.id });
      const ids = d.tracks().map((t) => t.id);
      startDrag(e, ids, `${item.name} · ${plural(ids.length, 'song')}`);
    });
    this.leftHead.addEventListener('click', (e) => {
      if (e.target.closest('.clear')) this.leftSel.clear();
      else if (e.target.closest('.sort')) {
        sortMenu(e.target, ['az', 'added'], sorts[this.kind], (m) => {
          sorts[this.kind] = m;
          this.#fillLeft(true);
        });
      }
    });
  }

  // ---- albums
  #albumPool() {
    if (this.kind === 'albums' || !this.leftIds.size) return model.albumList;
    return this.kind === 'artists' ? model.albumsOf(this.leftIds) : model.albumsOfGenres(this.leftIds);
  }

  #fillAlbums(keep) {
    const pool = this.#albumPool();
    const mode = this.leftIds.size && this.kind === 'artists' && sorts.albums === 'az' ? 'year' : sorts.albums;
    this.albums = sortAlbums(pool, mode);
    this.midHead.innerHTML = colHead(this.albums.length, 'album', mode).replace(/^<div class="colhead">|<\/div>$/g, '');
    this.albumSel.clear(true);
    this.albums.forEach((a, i) => {
      if (this.albumIds.has(a.id)) this.albumSel.set.add(i);
    });
    const first = this.albums.findIndex((a) => this.albumIds.has(a.id));
    this.albumSel.anchor = this.albumSel.focus = first;
    this.grid.setItems(this.albums, { keepScroll: keep });
    this.grid.refresh();
    if (first >= 0) this.grid.scrollToIndex(first);
    this.#fillSongs();
  }

  #albumsChanged() {
    this.grid.refresh();
    this.albumIds = new Set(this.albumSel.indices().map((i) => this.albums[i].id));
    router.patch({ albums: [...this.albumIds] });
    this.#fillSongs();
  }

  #wireGrid() {
    const body = this.midBody;
    body.addEventListener('click', (e) => {
      const i = this.grid.indexOf(e.target);
      if (i < 0) {
        if (e.target === body || e.target.classList.contains('vinner')) this.albumSel.clear();
        return;
      }
      if (e.target.closest('.play')) return playItem({ type: 'album', id: this.albums[i].id });
      this.albumSel.click(i, e);
    });
    body.addEventListener('dblclick', (e) => {
      const i = this.grid.indexOf(e.target);
      if (i >= 0 && !e.target.closest('.play')) playItem({ type: 'album', id: this.albums[i].id });
    });
    body.addEventListener('contextmenu', (e) => {
      const i = this.grid.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      this.albumSel.context(i);
      showMenu(e.clientX, e.clientY, albumMenu(this.albumSel.indices().map((k) => this.albums[k].id)));
    });
    body.addEventListener('dragstart', (e) => {
      const i = this.grid.indexOf(e.target);
      if (i < 0) return;
      if (!this.albumSel.has(i)) this.albumSel.click(i, {});
      const albums = this.albumSel.indices().map((k) => this.albums[k]);
      const ids = model.tracksOfAlbums(albums).map((t) => t.id);
      startDrag(e, ids, albums.length === 1 ? `${albums[0].title} · ${plural(ids.length, 'song')}` : plural(ids.length, 'song'));
    });
    this.midHead.addEventListener('click', (e) => {
      if (e.target.closest('.clear')) this.albumSel.clear();
      else if (e.target.closest('.sort')) {
        sortMenu(e.target, ['az', 'year', 'added', 'artist'], sorts.albums, (m) => {
          sorts.albums = m;
          this.#fillAlbums(true);
        });
      }
    });
  }

  // ---- songs
  #fillSongs() {
    const selected = this.albums.filter((a) => this.albumIds.has(a.id));
    const genreFilter = this.kind === 'genres' && this.leftIds.size ? { genreIds: this.leftIds } : {};
    let tracks;
    let numbers = false;
    let album = null;
    let context = null;
    if (selected.length) {
      tracks = model.tracksOfAlbums(selected, genreFilter);
      numbers = selected.length === 1;
      album = numbers ? selected[0] : null;
      if (album) context = { type: 'album', id: album.id, label: album.title };
    } else if (this.leftIds.size) {
      tracks = model.tracksOfAlbums(this.albums, genreFilter);
      if (sorts.songs !== 'az') tracks = sortTracks(tracks, sorts.songs);
      numbers = false;
      if (this.leftIds.size === 1) {
        const id = [...this.leftIds][0];
        context = { type: this.kind === 'artists' ? 'artist' : 'genre', id };
      }
    } else {
      tracks = sortTracks(model.trackList, sorts.songs);
    }
    this.songs.set({ tracks, numbers, album, sortKey: this.leftIds.size && sorts.songs === 'az' ? 'album' : sorts.songs, context });
  }

  refresh() {
    this.leftList?.refresh();
    this.grid.refresh();
    this.songs.refresh();
  }

  onKey(e) {
    if (this.songs.onKey(e)) return true;
    if (this.leftBody && document.activeElement === this.leftBody) {
      return listKeys(e, this.leftSel, this.items.length, this.leftList, (i) => playItem({ type: this.kind === 'artists' ? 'artist' : 'genre', id: this.items[i].id }), (i) => this.items[i].name);
    }
    if (document.activeElement === this.midBody) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const n = this.albums.length;
        const next = Math.max(0, Math.min(n - 1, this.albumSel.focus + (e.key === 'ArrowRight' ? 1 : -1)));
        this.albumSel.click(next, {});
        this.grid.scrollToIndex(next);
        return true;
      }
      return listKeys(e, this.albumSel, this.albums.length, this.grid, (i) => playItem({ type: 'album', id: this.albums[i].id }), (i) => this.albums[i].title);
    }
    return false;
  }

  destroy() {
    this.unsub.forEach((u) => u());
    this.leftList?.destroy();
    this.grid.destroy();
    this.songs.destroy();
  }
}

// ---------------------------------------------------------------- songs (table)
const TABLE_COLS = [
  { key: 'title', label: 'song', cls: 'c-title', get: (t) => t.title },
  { key: 'duration', label: 'length', cls: 'c-len', get: (t) => fmtTime(t.duration), num: true },
  { key: 'artist', label: 'artist', cls: 'c-artist', get: (t) => t.artist || t.aa },
  { key: 'album', label: 'album', cls: 'c-album', get: (t) => t.album || 'Unknown Album' },
  { key: 'genre', label: 'genre', cls: 'c-genre', get: (t) => t.genre || '' },
  { key: 'rating', label: 'rating', cls: 'c-rating' },
  { key: 'plays', label: 'plays', cls: 'c-plays', get: (t) => String(model.plays(t.id) || ''), num: true },
];

function tableRow(t, cols, extra = '') {
  const cells = cols.map((c) => {
    if (c.key === 'rating') return '<span class="c c-rating"><button class="heart"></button></span>';
    if (c.key === 'num') return `<span class="c c-num">${extra}</span>`;
    return `<span class="c ${c.cls}">${esc(c.get(t))}</span>`;
  }).join('');
  return el(`<div class="song" draggable="true"><span class="ind"></span>${cells}</div>`);
}

function compareBy(key, dir) {
  const val = {
    title: (t) => sortName(t.title),
    duration: (t) => t.duration || 0,
    artist: (t) => sortName(t.artist || t.aa),
    album: (t) => sortName(t.album || ''),
    genre: (t) => t.genre || '',
    rating: (t) => ({ love: 0, hate: 2 }[model.rating(t.id)] ?? 1),
    plays: (t) => -model.plays(t.id),
  }[key];
  return (a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'number' ? x - y : collator.compare(x, y);
    return (c || collator.compare(sortName(a.title), sortName(b.title))) * dir;
  };
}

class SongsView {
  constructor(page) {
    this.root = el('<div class="coll songs"><section class="col table songs-col"><div class="thead"></div><div class="colbody" tabindex="0"></div></section></div>');
    page.appendChild(this.root);
    this.body = this.root.querySelector('.colbody');
    this.headEl = this.root.querySelector('.thead');
    this.sel = new Selection(() => this.list.refresh());
    this.list = new Virtual(this.body, {
      itemHeight: ROW,
      render: (t) => tableRow(t, TABLE_COLS),
      update: (node, t, i) => updateSongRow(node, t, this.sel.has(i)),
    });
    this.body.addEventListener('click', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      if (e.target.closest('.heart')) return cycleRating(this.tracks[i].id);
      this.sel.click(i, e);
    });
    this.body.addEventListener('dblclick', (e) => {
      const i = this.list.indexOf(e.target);
      if (i >= 0 && !e.target.closest('.heart')) player.playTracks(this.tracks, i, null);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      this.sel.context(i);
      showMenu(e.clientX, e.clientY, trackMenu(this.selectedIds()));
    });
    this.body.addEventListener('dragstart', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      if (!this.sel.has(i)) this.sel.click(i, {});
      const ids = this.selectedIds();
      startDrag(e, ids, plural(ids.length, 'song'));
    });
    this.headEl.addEventListener('click', (e) => {
      const c = e.target.closest('[data-key]');
      if (!c) return;
      const key = c.dataset.key;
      sorts.table = { key, dir: sorts.table.key === key ? -sorts.table.dir : 1 };
      this.fill(true);
    });
    this.unsub = [
      player.on('track', () => this.list.refresh()),
      model.on('rating', () => this.list.refresh()),
      model.on('plays', () => this.list.rerender()),
      model.on('library', () => this.fill(true)),
    ];
    this.fill(false);
  }

  selectedIds() {
    return this.sel.indices().map((i) => this.tracks[i].id);
  }

  fill(keep) {
    const { key, dir } = sorts.table;
    this.tracks = [...model.trackList].sort(compareBy(key, dir));
    this.headEl.innerHTML = TABLE_COLS.map((c) => {
      const label = c.key === 'rating' ? `<span class="hdr-icon">${icons.heart}</span>` : esc(c.label);
      const count = c.key === 'title' ? `${esc(plural(this.tracks.length, 'song'))}` : label;
      return `<span class="c ${c.cls} ${key === c.key ? 'sorted' : ''}" data-key="${c.key}">${c.key === 'title' ? count : label}${key === c.key ? `<span class="arrow">${dir > 0 ? '▲' : '▼'}</span>` : ''}</span>`;
    }).join('');
    this.headEl.insertAdjacentHTML('afterbegin', '<span class="ind"></span>');
    this.sel.clear(true);
    this.list.setItems(this.tracks, { keepScroll: keep });
  }

  refresh() {
    this.list.refresh();
  }

  onKey(e) {
    if (document.activeElement !== this.body) return false;
    return listKeys(e, this.sel, this.tracks.length, this.list, (i) => player.playTracks(this.tracks, i, null), (i) => this.tracks[i].title);
  }

  destroy() {
    this.unsub.forEach((u) => u());
    this.list.destroy();
  }
}

// ---------------------------------------------------------------- playlists
const PL_COLS = [
  { key: 'num', cls: 'c-num' },
  TABLE_COLS[0], TABLE_COLS[1], TABLE_COLS[2], TABLE_COLS[3], TABLE_COLS[5],
];

class PlaylistsView {
  constructor(page) {
    this.root = el(`
      <div class="coll playlists">
        <section class="col"><div class="colhead"></div><div class="colbody" tabindex="0"></div></section>
        <section class="col table songs-col pl-detail"></section>
      </div>`);
    page.appendChild(this.root);
    this.leftHead = this.root.querySelector('.col .colhead');
    this.leftBody = this.root.querySelector('.col .colbody');
    this.detail = this.root.querySelector('.pl-detail');
    this.current = router.state.params.playlist || null;
    this.leftList = new Virtual(this.leftBody, {
      itemHeight: ROW,
      render: (p) => el(`<div class="row" draggable="false">${esc(p.name)}<span class="count">${p.trackIds.length}</span></div>`),
      update: (node, p) => node.classList.toggle('sel', p.id === this.current),
    });
    this.#wireLeft();
    this.unsub = [
      model.on('playlists', () => this.fill(true)),
      model.on('library', () => this.fill(true)),
      player.on('track', () => this.list?.refresh()),
      model.on('rating', () => this.list?.refresh()),
    ];
    this.fill(false);
  }

  fill(keep) {
    this.items = model.playlistList;
    if (this.current && !model.playlists.has(this.current)) this.current = null;
    if (!this.current && this.items.length) this.current = this.items[0].id;
    this.leftHead.innerHTML = `<b>${esc(plural(this.items.length, 'playlist'))}</b><span class="spacer"></span><a class="link" data-new title="New playlist (Ctrl+N)">new</a>`;
    this.leftList.setItems(this.items, { keepScroll: keep });
    this.leftList.refresh();
    this.#fillDetail(keep);
  }

  #wireLeft() {
    this.leftHead.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-new]')) return;
      const pl = await newPlaylist([]);
      if (pl) this.select(pl.id);
    });
    this.leftBody.addEventListener('click', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i >= 0) this.select(this.items[i].id);
    });
    this.leftBody.addEventListener('dblclick', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i >= 0) playItem({ type: 'playlist', id: this.items[i].id });
    });
    this.leftBody.addEventListener('contextmenu', (e) => {
      const i = this.leftList.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, playlistMenu(this.items[i].id));
    });
    // Drop songs onto a playlist name to add them.
    this.leftBody.addEventListener('dragover', (e) => {
      if (!isTrackDrag(e)) return;
      const i = this.leftList.indexOf(e.target);
      this.leftBody.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      if (i < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      e.target.closest('.row')?.classList.add('drop-target');
    });
    this.leftBody.addEventListener('dragleave', (e) => {
      e.target.closest?.('.row')?.classList.remove('drop-target');
    });
    this.leftBody.addEventListener('drop', (e) => {
      const i = this.leftList.indexOf(e.target);
      this.leftBody.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      if (i < 0) return;
      e.preventDefault();
      addToPlaylist(this.items[i].id, droppedTracks(e));
    });
  }

  select(id) {
    this.current = id;
    router.patch({ playlist: id });
    this.leftList.refresh();
    this.#fillDetail(false);
  }

  #fillDetail(keep) {
    this.list?.destroy();
    this.list = null;
    const pl = this.current && model.playlists.get(this.current);
    if (!pl) {
      this.detail.innerHTML = `<div class="hint">${this.items.length ? 'Pick a playlist.' : 'You don\'t have any playlists yet. Click <b>new</b>, or drag songs onto the playlist icon at the bottom left.'}</div>`;
      return;
    }
    this.tracks = pl.trackIds.map((id) => model.tracks.get(id)).filter(Boolean);
    const secs = this.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    this.detail.innerHTML = `
      <div class="pl-title" title="${esc(pl.name)}">${esc(pl.name)}</div>
      <div class="pl-meta">${esc(plural(this.tracks.length, 'song'))} · ${esc(fmtDuration(secs))}${pl.missing ? ` · ${pl.missing} missing` : ''}${pl.readOnly ? ' · m3u' : ''}</div>
      <div class="pl-actions"><a data-act="play">play</a><a data-act="shuffle">shuffle</a><a data-act="rename">rename</a>${native ? '<a data-act="delete">delete</a>' : ''}</div>
      <div class="thead"><span class="ind"></span>${PL_COLS.map((c) => `<span class="c ${c.cls}">${c.key === 'num' ? '#' : c.key === 'rating' ? `<span class="hdr-icon">${icons.heart}</span>` : esc(c.label)}</span>`).join('')}</div>
      <div class="colbody" tabindex="0"></div>`;
    const body = this.detail.querySelector('.colbody');
    this.body = body;
    this.sel = new Selection(() => this.list.refresh());
    this.list = new Virtual(body, {
      itemHeight: ROW,
      render: (t, i) => tableRow(t, PL_COLS, i + 1),
      update: (node, t, i) => updateSongRow(node, t, this.sel.has(i)),
    });
    this.list.setItems(this.tracks, { keepScroll: keep });
    this.detail.querySelector('.pl-actions').onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'play') playItem({ type: 'playlist', id: pl.id });
      if (act === 'shuffle') playItem({ type: 'playlist', id: pl.id }, { shuffle: true });
      if (act === 'rename') renamePlaylist(pl.id).then((p) => p && this.select(p.id));
      if (act === 'delete') deletePlaylist(pl.id);
    };
    const context = { type: 'playlist', id: pl.id, label: pl.name };
    body.addEventListener('click', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      if (e.target.closest('.heart')) return cycleRating(this.tracks[i].id);
      this.sel.click(i, e);
    });
    body.addEventListener('dblclick', (e) => {
      const i = this.list.indexOf(e.target);
      if (i >= 0 && !e.target.closest('.heart')) player.playTracks(this.tracks, i, context);
    });
    body.addEventListener('contextmenu', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      this.sel.context(i);
      showMenu(e.clientX, e.clientY, trackMenu(this.sel.indices().map((k) => this.tracks[k].id), { playlistId: pl.id, onRemove: () => this.removeSelected() }));
    });
    // Reorder inside the playlist, or drop songs from elsewhere at a position.
    body.addEventListener('dragstart', (e) => {
      const i = this.list.indexOf(e.target);
      if (i < 0) return;
      if (!this.sel.has(i)) this.sel.click(i, {});
      this.dragFrom = this.sel.indices();
      startDrag(e, this.dragFrom.map((k) => this.tracks[k].id), plural(this.dragFrom.length, 'song'));
    });
    const clearMarks = () => body.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    body.addEventListener('dragover', (e) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = this.dragFrom ? 'move' : 'copy';
      clearMarks();
      const row = e.target.closest('.song');
      if (row) {
        const r = row.getBoundingClientRect();
        row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
      }
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) clearMarks();
    });
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      clearMarks();
      const row = e.target.closest('.song');
      let at = this.tracks.length;
      if (row) {
        const i = this.list.indexOf(row);
        const r = row.getBoundingClientRect();
        at = e.clientY < r.top + r.height / 2 ? i : i + 1;
      }
      let ids = this.tracks.map((t) => t.id);
      if (this.dragFrom) {
        const moving = this.dragFrom.map((k) => ids[k]);
        const before = this.dragFrom.filter((k) => k < at).length;
        ids = ids.filter((_, k) => !this.dragFrom.includes(k));
        ids.splice(at - before, 0, ...moving);
      } else {
        ids.splice(at, 0, ...droppedTracks(e));
      }
      this.dragFrom = null;
      try {
        const next = await savePlaylistOrder(pl.id, ids);
        this.current = next.id;
      } catch (err) {
        toast(err.message);
      }
    });
    body.addEventListener('dragend', () => {
      this.dragFrom = null;
      clearMarks();
    });
  }

  async removeSelected() {
    const pl = model.playlists.get(this.current);
    if (!pl || !this.sel?.set.size) return;
    const drop = new Set(this.sel.indices());
    const ids = this.tracks.filter((_, i) => !drop.has(i)).map((t) => t.id);
    const next = await savePlaylistOrder(pl.id, ids);
    this.current = next.id;
    toast(`Removed ${plural(drop.size, 'song')} from ${next.name}`);
  }

  refresh() {
    this.leftList.refresh();
    this.list?.refresh();
  }

  onKey(e) {
    if (this.body && document.activeElement === this.body) {
      if (e.key === 'Delete') {
        this.removeSelected();
        return true;
      }
      return listKeys(e, this.sel, this.tracks.length, this.list, (i) => player.playTracks(this.tracks, i, { type: 'playlist', id: this.current }));
    }
    return false;
  }

  destroy() {
    this.unsub.forEach((u) => u());
    this.leftList.destroy();
    this.list?.destroy();
  }
}

// ---------------------------------------------------------------- entry
export function collectionView(page, state) {
  if (state.sub !== 'music') return null;
  if (!model.tracks.size) return emptyState(page);
  switch (state.view) {
    case 'genres': return new BrowseView(page, 'genres');
    case 'albums': return new BrowseView(page, 'albums');
    case 'songs': return new SongsView(page);
    case 'playlists': return new PlaylistsView(page);
    default: return new BrowseView(page, 'artists');
  }
}

export { SongColumn, sortTracks, albumTile, songRow, updateSongRow, artImg };
