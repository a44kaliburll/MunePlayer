// quickplay: pins, new, history and the smart dj row, on the dark background.
import { goToAlbum, goToArtist, goToPlaylist, playItem, startSmartDJ } from '../actions.js';
import { showMenu } from '../components.js';
import { model } from '../model.js';
import { router } from '../router.js';
import { artUrl, el, esc, icons } from '../util.js';
import { wireArt } from './collection.js';

const DJ_TINTS = ['#9bbf2a', '#e3007b', '#1ba1e2', '#f09609', '#a05aff', '#00aba9', '#e51400', '#d8c100'];

function tileHtml(item, large) {
  const d = model.describe(item);
  if (!d) return '';
  const cls = `qp-tile${large ? ' lg' : ''}`;
  const data = `data-type="${item.type}" data-id="${esc(item.id)}"`;
  const label = `<div class="label"><b>${esc(d.title)}</b><span>${esc(d.sub || '')}</span></div>`;
  if (item.type === 'playlist') {
    return `<div class="${cls} text playlist" ${data}><div class="big">${esc(d.title)}</div><div class="small">playlist</div></div>`;
  }
  if (item.type === 'genre') {
    return `<div class="${cls} text artist" ${data}><div class="big">${esc(d.title)}</div><div class="small">genre</div></div>`;
  }
  const hasArt = d.albumId && model.albums.has(d.albumId);
  const textFallback = `<div class="big">${esc(d.title)}</div><div class="small">${esc(d.sub || '')}</div>`;
  if (!hasArt) return `<div class="${cls} text noart" ${data}>${textFallback}</div>`;
  // Text shows underneath until (and unless) the art loads, like Zune's text tiles.
  return `<div class="${cls} text noart" ${data}>${textFallback}<img alt="" data-album="${d.albumId}" src="${artUrl(d.albumId, large ? 'l' : 'm', model.artVersion(d.albumId))}">${label}</div>`;
}

function group(name, items, { cls = '', emptyHtml = '' } = {}) {
  const tiles = items.map((it, i) => tileHtml(it, i === 0)).filter(Boolean).join('');
  const body = tiles ? `<div class="qp-grid">${tiles}</div>` : emptyHtml;
  if (!body) return '';
  return `<section class="qp-group ${cls}"><h2>${esc(name)}</h2>${body}</section>`;
}

function artistPlays() {
  const totals = new Map();
  for (const [id, n] of Object.entries(model.user.plays)) {
    const t = model.tracks.get(id);
    if (t) totals.set(t.artistId, (totals.get(t.artistId) || 0) + n);
  }
  return totals;
}

export function quickplayView(page) {
  const root = el(`
    <div class="qp">
      <div class="qp-scroller"><div class="qp-row"></div></div>
      <section class="qp-dj"><h3>smart dj</h3><div class="qp-djrow"></div></section>
    </div>`);
  page.appendChild(root);
  wireArt(root);
  const row = root.querySelector('.qp-row');
  const scroller = root.querySelector('.qp-scroller');
  const djRow = root.querySelector('.qp-djrow');

  const render = () => {
    const pins = model.user.pins.map((p) => ({ type: p.type, id: p.id })).filter((p) => model.describe(p));
    const history = model.user.history.map((h) => ({ type: h.type, id: h.id })).filter((h) => model.describe(h)).slice(0, 14);
    const recent = [...model.albums.values()].sort((a, b) => b.added - a.added).slice(0, 11).map((a) => ({ type: 'album', id: a.id }));

    const welcome = !history.length ? `
      <section class="qp-group welcome"><h2>welcome</h2>
        <div class="qp-welcome">
          Click any item in Quickplay to dive right in.
          <a class="go" data-go="collection">${icons.goCollection}<span>go to your<br>collection</span></a>
        </div>
      </section>` : '';

    row.innerHTML = [
      group('pins', pins, { emptyHtml: '<div class="qp-empty">Right-click an album, artist, playlist or song and choose <b>pin to quickplay</b> to keep it here.</div>' }),
      welcome,
      group('new', recent),
      group('history', history),
    ].join('');

    const plays = artistPlays();
    const artists = [...model.artistList]
      .filter((a) => a.name !== 'Unknown Artist' && a.name !== 'Various Artists')
      .sort((a, b) => (plays.get(b.id) || 0) - (plays.get(a.id) || 0) || b.trackCount - a.trackCount)
      .slice(0, 8);
    djRow.innerHTML = artists.map((a, i) => {
      const first = model.tracksOfArtist(a.id)[0];
      const bg = first ? `style="background-image:url('${artUrl(first.albumId, 'm', model.artVersion(first.albumId))}')"` : '';
      return `<div class="dj-tile" data-dj="${a.id}" title="Start Smart DJ for ${esc(a.name)}"><div class="bg" ${bg}></div><div class="tint" style="background:${DJ_TINTS[i % DJ_TINTS.length]}"></div><small>smart dj</small><span>${esc(a.name)}</span></div>`;
    }).join('');
    root.querySelector('.qp-dj').hidden = !artists.length;
  };

  root.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) return router.go({ pivot: 'collection', sub: 'music', view: 'artists' });
    const dj = e.target.closest('[data-dj]');
    if (dj) return startSmartDJ(dj.dataset.dj);
    const tile = e.target.closest('.qp-tile');
    if (tile) playItem({ type: tile.dataset.type, id: tile.dataset.id });
  });

  root.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.qp-tile');
    const dj = e.target.closest('[data-dj]');
    if (!tile && !dj) return;
    e.preventDefault();
    if (dj) {
      const id = dj.dataset.dj;
      return showMenu(e.clientX, e.clientY, [
        { label: 'start smart dj', action: () => startSmartDJ(id) },
        { label: 'go to artist', action: () => goToArtist(id) },
      ]);
    }
    const item = { type: tile.dataset.type, id: tile.dataset.id };
    const pinned = model.isPinned(item.type, item.id);
    const goTo = {
      album: () => goToAlbum(item.id),
      artist: () => goToArtist(item.id),
      smartdj: () => goToArtist(item.id),
      playlist: () => goToPlaylist(item.id),
      track: () => goToAlbum(model.tracks.get(item.id)?.albumId),
      genre: () => router.go({ pivot: 'collection', sub: 'music', view: 'genres', params: { genres: [item.id] } }),
    }[item.type];
    showMenu(e.clientX, e.clientY, [
      { label: 'play', action: () => playItem(item) },
      { label: pinned ? 'unpin from quickplay' : 'pin to quickplay', action: () => model.setPinned(item.type, item.id, !pinned) },
      goTo && { label: 'go to collection', action: goTo },
    ].filter(Boolean));
  });

  // Quickplay scrolls sideways; let the mouse wheel drive it.
  scroller.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      scroller.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  const unsub = [
    model.on('pins', render),
    model.on('history', render),
    model.on('library', render),
    model.on('playlists', render),
  ];
  render();

  return {
    destroy() {
      unsub.forEach((u) => u());
    },
    refresh() {},
  };
}
