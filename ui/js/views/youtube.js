// marketplace: YouTube Music through YouTube's official APIs (server/youtube.js). Songs play in
// YouTube's embedded player, with video, in a column beside the list. The player stays while you
// move between the marketplace's pages and stops when you leave the marketplace: YouTube doesn't
// let other apps play its songs as audio only or in the background.
import { api } from '../api.js';
import { toast } from '../components.js';
import { model } from '../model.js';
import { player } from '../player.js';
import { router } from '../router.js';
import { $, el, esc, fmtTime, plural } from '../util.js';

const YT = 'https://www.youtube.com';
const CACHE_MS = 10 * 60 * 1000;

// Answers kept for this session only, so going back and forth doesn't spend YouTube quota
// (a search costs 100 of the 10,000 daily units).
const cache = new Map();
async function load(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await api(path);
  cache.set(path, { at: Date.now(), data });
  return data;
}

/**
 * YouTube's embedded player in an iframe, driven over the IFrame Player API's postMessage
 * channel, so no YouTube script runs in Mune's own page.
 */
class EmbeddedPlayer {
  constructor(host, { onState, onError }) {
    this.host = host;
    this.frame = null;
    this.ping = null;
    this.onMessage = (e) => {
      if (e.origin !== YT || !this.frame || e.source !== this.frame.contentWindow) return;
      let m;
      try {
        m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (m?.event === 'initialDelivery' || m?.event === 'onReady') this.#stopPing();
      if (m?.event === 'onStateChange') onState(m.info);
      else if (m?.event === 'infoDelivery' && typeof m.info?.playerState === 'number') onState(m.info.playerState);
      else if (m?.event === 'onError') onError(m.info);
    };
    window.addEventListener('message', this.onMessage);
  }

  load(id) {
    if (this.frame) return this.#command('loadVideoById', [id]);
    const q = new URLSearchParams({ enablejsapi: '1', autoplay: '1', playsinline: '1', rel: '0', origin: location.origin, widgetid: '1' });
    this.frame = Object.assign(document.createElement('iframe'), {
      src: `${YT}/embed/${encodeURIComponent(id)}?${q}`,
      title: 'YouTube video player',
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowFullscreen: true,
    });
    // Until the player answers, keep telling it we're listening for its events.
    this.frame.addEventListener('load', () => {
      this.#stopPing();
      let tries = 0;
      const tick = () => {
        this.#post({ event: 'listening' });
        if (++tries < 40) this.ping = setTimeout(tick, 250);
      };
      tick();
    });
    this.host.appendChild(this.frame);
  }

  pause() {
    this.#command('pauseVideo');
  }

  destroy() {
    this.#stopPing();
    window.removeEventListener('message', this.onMessage);
    this.frame?.remove();
    this.frame = null;
  }

  #post(msg) {
    this.frame?.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), YT);
  }

  #command(func, args = []) {
    this.#post({ event: 'command', func, args });
  }

  #stopPing() {
    clearTimeout(this.ping);
    this.ping = null;
  }
}

/** The player column. It lives in #page (app.js leaves #yt-dock alone) so it survives moving between marketplace pages. */
class Dock {
  constructor() {
    this.queue = [];
    this.index = -1;
    this.onChange = null;
    this.node = el(`
      <aside id="yt-dock" class="yt-side">
        <div class="yt-frame"></div>
        <div class="yt-now"><b></b><span></span></div>
        <div class="yt-controls">
          <button class="zbtn" data-yt="prev">previous</button>
          <button class="zbtn" data-yt="next">next</button>
          <a data-yt="open">open in youtube music</a>
        </div>
        <p class="yt-attr">Playing from YouTube. Other apps can't play YouTube as audio only, so the video stays here in the marketplace.</p>
      </aside>`);
    this.embed = new EmbeddedPlayer(this.node.querySelector('.yt-frame'), {
      onState: (s) => {
        if (s === 1 && player.playing) player.pause(); // YouTube started: pause Mune's own music
        if (s === 0) this.step(1); // ended: next in the list
      },
      onError: (code) => {
        toast(code === 101 || code === 150 ? "That song's owner doesn't let it play outside YouTube." : `YouTube couldn't play that song (error ${code}).`);
        setTimeout(() => this.step(1), 1500);
      },
    });
    // And the other way round: Mune's own music pauses YouTube.
    this.offPlayer = player.on('state', (playing) => {
      if (playing) this.embed.pause();
    });
    this.node.addEventListener('click', (e) => {
      const act = e.target.closest('[data-yt]')?.dataset.yt;
      if (act === 'prev') this.step(-1);
      else if (act === 'next') this.step(1);
      else if (act === 'open' && this.current) {
        this.embed.pause();
        window.open(`https://music.youtube.com/watch?v=${encodeURIComponent(this.current.id)}`, '_blank');
      }
    });
    $('#page').appendChild(this.node);
  }

  get current() {
    return this.queue[this.index] || null;
  }

  play(items, i) {
    this.queue = items;
    this.index = i;
    const v = this.current;
    this.embed.load(v.id);
    this.node.querySelector('.yt-now b').textContent = v.title;
    this.node.querySelector('.yt-now span').textContent = v.artist;
    this.node.querySelector('[data-yt="prev"]').disabled = i <= 0;
    this.node.querySelector('[data-yt="next"]').disabled = i >= items.length - 1;
    this.onChange?.();
  }

  step(by) {
    const i = this.index + by;
    if (i >= 0 && i < this.queue.length) this.play(this.queue, i);
  }

  stop() {
    this.embed.destroy();
    this.offPlayer();
    this.node.remove();
    if (dock === this) dock = null;
  }
}

let dock = null;
let lastQuery = ''; // the music page reopens on the last search (cached, so it costs no quota)

const thumb = (src) => (src ? `<img src="${esc(src)}" alt="" loading="lazy" width="128" height="72">` : '<div class="noart"></div>');
const rows = (list) => list.map((v, i) => `
  <div class="yt-row" data-i="${i}" data-id="${esc(v.id)}">
    ${thumb(v.thumb)}
    <div class="yt-meta"><b>${esc(v.title)}</b><span>${esc([v.artist, v.duration ? fmtTime(v.duration) : null].filter(Boolean).join(' · '))}</span></div>
  </div>`).join('');

export function youtubeView(page, state) {
  const sub = ['music', 'playlists', 'liked'].includes(state.sub) ? state.sub : 'music';
  const params = state.params || {};
  const root = el('<div class="yt"><div class="yt-main"></div></div>');
  page.appendChild(root);
  const main = root.querySelector('.yt-main');

  let list = []; // what the page shows
  let current = 0; // drops answers to requests that are no longer wanted

  const markPlaying = () => {
    const id = dock?.current?.id;
    root.classList.toggle('docked', !!dock);
    main.querySelectorAll('.yt-row').forEach((r) => r.classList.toggle('on', !!id && r.dataset.id === id));
  };
  if (dock) dock.onChange = markPlaying;
  markPlaying();

  const showList = (items, empty) => {
    list = items;
    main.querySelector('.yt-list').innerHTML = items.length ? rows(items) : `<div class="yt-empty">${esc(empty)}</div>`;
    markPlaying();
  };

  const fetchInto = async (path, empty, show = showList) => {
    const mine = ++current;
    const box = main.querySelector('.yt-list');
    box.innerHTML = '<div class="yt-empty">loading…</div>';
    try {
      const data = await load(path);
      if (mine === current) show(data.items || [], empty);
    } catch (err) {
      if (mine === current) box.innerHTML = `<div class="yt-empty err">${esc(err.message)}</div>`;
    }
  };

  const search = (q) => {
    lastQuery = q;
    return fetchInto(`youtube/search?q=${encodeURIComponent(q)}`, `Nothing on YouTube Music for "${q}".`);
  };

  const render = () => {
    const yt = model.youtube || {};
    if (!yt.signedIn) {
      main.innerHTML = `
        <div class="placeholder">
          <h2>youtube music</h2>
          <p>Search YouTube Music and play your playlists and liked songs here, with video, in YouTube's own player. ${yt.configured ? 'Sign in with your Google account to start.' : 'It takes a one-time setup with your own free Google Cloud project.'}</p>
          <button class="zbtn primary" data-yt="setup">${yt.configured ? 'sign in' : 'set up'} in settings</button>
        </div>`;
      return;
    }
    if (sub === 'music') {
      const q = params.q || lastQuery;
      main.innerHTML = `
        <form class="addfolder yt-search"><input type="text" placeholder="search youtube music" maxlength="200" value="${esc(q)}"><button class="zbtn primary">search</button></form>
        <div class="yt-list"></div>`;
      if (q) search(q);
      else {
        main.querySelector('.yt-list').innerHTML = '<div class="yt-empty">Songs and music videos from YouTube Music. Each search uses 100 of your Google project\'s 10,000 daily YouTube units.</div>';
        main.querySelector('input').focus();
      }
    } else if (sub === 'playlists' && params.list) {
      main.innerHTML = `<div class="yt-head"><h2>${esc(params.title || 'playlist')}</h2><a data-yt="all">all playlists</a></div><div class="yt-list"></div>`;
      fetchInto(`youtube/playlists/${encodeURIComponent(params.list)}`, 'This playlist is empty, or its videos are private.');
    } else if (sub === 'playlists') {
      main.innerHTML = '<div class="yt-list"></div>';
      // Playlists open instead of playing.
      fetchInto('youtube/playlists', "You don't have any playlists on YouTube yet.", (items, empty) => {
        main.querySelector('.yt-list').innerHTML = items.map((p) => `
          <div class="yt-row" data-list="${esc(p.id)}" data-title="${esc(p.title)}">
            ${thumb(p.thumb)}
            <div class="yt-meta"><b>${esc(p.title)}</b><span>${p.count != null ? esc(plural(p.count, 'video')) : ''}</span></div>
          </div>`).join('') || `<div class="yt-empty">${esc(empty)}</div>`;
      });
    } else {
      main.innerHTML = '<div class="yt-head"><h2>liked songs</h2></div><div class="yt-list"></div>';
      fetchInto('youtube/liked', 'Songs you like on YouTube or YouTube Music show up here.');
    }
  };

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = main.querySelector('.yt-search input').value.trim();
    if (!q) return;
    router.patch({ q });
    search(q);
  });

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-yt]')?.dataset.yt;
    if (act === 'setup') return router.go({ pivot: 'settings', params: { section: 'online' } });
    if (act === 'all') return router.go({ pivot: 'marketplace', sub: 'playlists' });
    const pl = e.target.closest('[data-list]');
    if (pl) return router.go({ pivot: 'marketplace', sub: 'playlists', params: { list: pl.dataset.list, title: pl.dataset.title } });
    const row = e.target.closest('.yt-row[data-i]');
    if (!row) return;
    dock ||= new Dock();
    dock.onChange = markPlaying;
    dock.play(list, Number(row.dataset.i));
  });

  let signedIn = !!model.youtube?.signedIn;
  const offYoutube = model.on('youtube', (s) => {
    if (!!s.signedIn === signedIn) return;
    signedIn = !!s.signedIn;
    if (!signedIn) dock?.stop();
    render();
  });
  render();

  return {
    destroy() {
      offYoutube();
      if (dock?.onChange === markPlaying) dock.onChange = null;
      // Moving between marketplace pages keeps the player; going anywhere else stops it.
      if (router.state.pivot !== 'marketplace') dock?.stop();
    },
    refresh() {},
  };
}
