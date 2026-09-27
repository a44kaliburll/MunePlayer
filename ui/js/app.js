// Mune Player — renderer entry point: header, pivots, transport, glow, keyboard.
import { addToPlaylist, cycleRating, newPlaylist, ui } from './actions.js';
import { api, native, shellKind, subscribe } from './api.js';
import { closeMenu, droppedTracks, isTrackDrag, modal, toast } from './components.js';
import { model } from './model.js';
import { player } from './player.js';
import { router } from './router.js';
import { $, $$, artUrl, clamp, debounce, esc, fmtTime, icons, plural } from './util.js';
import { collectionView } from './views/collection.js';
import { deviceView, syncLine } from './views/device.js';
import { Mixview } from './views/mixview.js';
import { NowPlaying } from './views/nowplaying.js';
import { placeholderView, searchView, socialView } from './views/other.js';
import { quickplayView } from './views/quickplay.js';
import { GLOWS, settingsView } from './views/settings.js';
import { youtubeView } from './views/youtube.js';

const SUBPIVOTS = {
  collection: ['music', 'videos', 'pictures', 'podcasts', 'channels'],
  // The marketplace is YouTube Music now (views/youtube.js).
  marketplace: ['music', 'playlists', 'liked'],
  device: ['summary', 'music'],
};
const MUSIC_VIEWS = ['artists', 'genres', 'albums', 'songs', 'playlists'];

let view = null;
let nowPlaying = null;
let mixview = null;

// ---------------------------------------------------------------- header
function winButtonsHtml() {
  if (!native) return '';
  return `<div class="winbtns">
    <button data-win="compact" title="Switch to compact mode (Ctrl+M)">${icons.compact}</button>
    <button data-win="minimize" title="Minimize">${icons.minimize}</button>
    <button data-win="maximize" title="Maximize">${document.body.classList.contains('maximized') ? icons.restore : icons.maximize}</button>
    <button data-win="close" title="Close">${icons.close}</button>
  </div>`;
}

function renderChrome() {
  const { pivot, sub, view: v, params } = router.state;
  const pivots = $('#pivots');
  const titleMode = pivot === 'settings';
  $('#chrome').classList.toggle('titled', titleMode);
  if (titleMode) {
    pivots.innerHTML = '<span class="page-title">settings</span>';
  } else {
    // "device" joins the pivots while a Zune is plugged in, like Zune 4.
    const list = ['quickplay', 'collection', 'marketplace', 'social', ...(model.device?.connected ? ['device'] : [])];
    if ([...pivots.querySelectorAll('a')].map((a) => a.dataset.pivot).join() !== list.join()) {
      pivots.innerHTML = list.map((p) => `<a data-pivot="${p}">${p}</a>`).join('');
    }
  }
  $$('#pivots a').forEach((a) => a.classList.toggle('on', a.dataset.pivot === pivot));

  const subs = titleMode ? ['software'] : SUBPIVOTS[pivot] || [];
  const subpivots = $('#subpivots');
  if (pivot === 'search') {
    subpivots.innerHTML = `<a class="on">results for "${esc(params.q || '')}"</a>${model.youtube.signedIn && params.q ? '<a data-ytsearch>on youtube music</a>' : ''}`;
  } else {
    subpivots.innerHTML = subs.map((s) => `<a data-sub="${s}" class="${s === sub || titleMode ? 'on' : ''}">${s}</a>`).join('');
  }

  const showViews = pivot === 'collection' && sub === 'music';
  $('#views').innerHTML = showViews ? MUSIC_VIEWS.map((x) => `<a data-view="${x}" class="${x === v ? 'on' : ''}">${x}</a>`).join('') : '';
  $('#search').hidden = titleMode;
  $('#back').classList.toggle('gone', !router.canGoBack);
}

function updateProfile() {
  $('#profile-name').textContent = model.profile.name || 'mune';
  $('#profile-sub').textContent = `${model.totalPlays().toLocaleString()} plays`;
}

function applyTheme() {
  const { pivot } = router.state;
  const darkPage = pivot === 'quickplay';
  const dark = darkPage || model.user.settings.theme === 'dark' || document.body.classList.contains('np-open') || document.body.classList.contains('mix-open');
  document.body.classList.toggle('page-dark', darkPage);
  $('#frame').classList.toggle('dark', dark);
}

// ---------------------------------------------------------------- pages
function renderPage() {
  closeMenu();
  view?.destroy?.();
  view = null;
  const page = $('#page');
  // The YouTube player column (views/youtube.js) outlives page changes within the marketplace.
  for (const child of [...page.children]) if (child.id !== 'yt-dock') child.remove();
  const state = router.state;
  if (state.pivot === 'collection' && state.sub === 'music' && state.view) lastMusicView = state.view;
  const host = document.createElement('div');
  host.className = 'page';
  page.appendChild(host);
  if (state.pivot === 'quickplay') view = quickplayView(host);
  else if (state.pivot === 'collection') view = state.sub === 'music' ? collectionView(host, state) : placeholderView(host, state.sub);
  else if (state.pivot === 'marketplace') view = youtubeView(host, state);
  else if (state.pivot === 'social') view = socialView(host);
  else if (state.pivot === 'settings') view = settingsView(host);
  else if (state.pivot === 'search') view = searchView(host, state);
  else if (state.pivot === 'device') view = deviceView(host, state);
  renderChrome();
  applyTheme();
  if (state.pivot !== 'search' && $('#search-input').value && document.activeElement !== $('#search-input')) $('#search-input').value = '';
}

function wireHeader() {
  $('#chrome').addEventListener('click', (e) => {
    const p = e.target.closest('[data-pivot]');
    if (p) {
      const pivot = p.dataset.pivot;
      if (pivot === 'collection') router.go({ pivot, sub: 'music', view: lastMusicView });
      else router.go({ pivot, sub: pivot === 'marketplace' ? 'music' : pivot === 'device' ? 'summary' : '' });
      return;
    }
    if (e.target.closest('[data-ytsearch]')) {
      router.go({ pivot: 'marketplace', sub: 'music', params: { q: router.state.params.q } });
      return;
    }
    const s = e.target.closest('[data-sub]');
    if (s && router.state.pivot !== 'settings') {
      router.go({ pivot: router.state.pivot, sub: s.dataset.sub, view: s.dataset.sub === 'music' ? lastMusicView : '' });
      return;
    }
    const v = e.target.closest('[data-view]');
    if (v) {
      lastMusicView = v.dataset.view;
      router.go({ pivot: 'collection', sub: 'music', view: v.dataset.view });
    }
  });
  $('#back').innerHTML = icons.back;
  $('#back').addEventListener('click', () => router.back());
  $('#lnk-settings').addEventListener('click', () => router.go({ pivot: 'settings', params: { section: 'collection' } }));
  $('#lnk-help').addEventListener('click', showHelp);
  $('#profile').addEventListener('click', () => router.go({ pivot: 'social' }));
  $('.avatar').innerHTML = icons.person;
  $('.search-icon').innerHTML = icons.search;

  const input = $('#search-input');
  const runSearch = debounce(() => {
    const q = input.value.trim();
    if (q) router.go({ pivot: 'search', params: { q } }, { replace: router.state.pivot === 'search' });
    else if (router.state.pivot === 'search') router.back();
  }, 220);
  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      runSearch();
      input.blur();
    }
  });
}
let lastMusicView = 'artists';

function showHelp() {
  modal(`
    <h2>help</h2>
    <p>Mune Player plays the music in the folders listed under settings &gt; collection. Double-click anything to play it, right-click for more, and drag songs onto the playlist icon at the bottom left.</p>
    <p><b>Keyboard:</b> Space or Ctrl+P play/pause · Ctrl+F next · Ctrl+B previous · Ctrl+H shuffle · Ctrl+T repeat · F7 mute · F8/F9 volume · Ctrl+E search · Alt+Left back · Ctrl+M compact mode.</p>
    <div class="buttons"><button class="zbtn" data-keys>all shortcuts</button><button class="zbtn primary" data-result="ok">close</button></div>`, {
    onOpen: (dlg, close) => dlg.querySelector('[data-keys]').addEventListener('click', () => {
      close(null);
      router.go({ pivot: 'settings', params: { section: 'keyboard' } });
    }),
  });
}

// ---------------------------------------------------------------- window controls
function wireWindow() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-win]');
    if (b && native) native.win(b.dataset.win);
  });
  $$('#winbtns button').forEach((b) => { b.innerHTML = icons[b.dataset.win]; });
  native?.onWinState?.((s) => {
    document.body.classList.toggle('maximized', !!s.maximized);
    $$('[data-win="maximize"]').forEach((b) => {
      b.innerHTML = s.maximized ? icons.restore : icons.maximize;
      b.title = s.maximized ? 'Restore' : 'Maximize';
    });
    const compact = !!s.compact;
    if (compact !== document.body.classList.contains('compact')) {
      document.body.classList.toggle('compact', compact);
      $('#mini').hidden = !compact;
      if (compact) renderMini();
    }
  });
}

function renderMini() {
  const mini = $('#mini');
  const t = player.current;
  mini.innerHTML = `
    <div class="mini-art" style="${t ? `background-image:url('${artUrl(t.albumId, 'm', model.artVersion(t.albumId))}')` : ''}"></div>
    <div class="mini-text">
      <b>${esc(t ? t.title : 'Mune')}</b>
      <span>${esc(t ? t.artist || t.aa : 'nothing playing')}</span>
      <div class="mini-bar"><i></i></div>
    </div>
    <div class="mini-ctl">
      <button class="ctl ring" data-mini="prev">${icons.prev}</button>
      <button class="ctl ring big" data-mini="play">${player.playing ? icons.pause : icons.play}</button>
      <button class="ctl ring" data-mini="next">${icons.next}</button>
    </div>
    <div class="mini-win">
      <button data-win="compact" title="Back to full mode">${icons.expand}</button>
      <button data-win="close" title="Close">${icons.close}</button>
    </div>`;
  updateMiniTime();
}

function updateMiniTime() {
  const bar = $('#mini .mini-bar i');
  if (bar) bar.style.width = `${player.duration ? (player.time / player.duration) * 100 : 0}%`;
}

$('#mini').addEventListener('click', (e) => {
  const a = e.target.closest('[data-mini]')?.dataset.mini;
  if (a === 'prev') player.prev();
  if (a === 'next') player.next();
  if (a === 'play') player.toggle();
});

// ---------------------------------------------------------------- transport
function wireTransport() {
  $('#btn-prev').innerHTML = icons.prev;
  $('#btn-next').innerHTML = icons.next;
  $('#btn-play').innerHTML = icons.play;
  $('#btn-repeat').innerHTML = icons.repeat;
  $('#btn-shuffle').innerHTML = icons.shuffle;
  $('#btn-np').innerHTML = icons.bars;
  $('#btn-mute').innerHTML = icons.volume;
  $('[data-dock="device"]').innerHTML = icons.device;
  $('[data-dock="disc"]').innerHTML = icons.disc;
  $('[data-dock="playlist"]').innerHTML = icons.playlist;

  $('#btn-play').onclick = () => player.toggle();
  $('#btn-prev').onclick = () => player.prev();
  $('#btn-next').onclick = () => player.next();
  $('#btn-shuffle').onclick = () => player.setShuffle(!player.shuffle);
  $('#btn-repeat').onclick = () => player.setRepeat(!player.repeat);
  $('#btn-np').onclick = () => nowPlaying.toggle();
  $('#npmini-art').onclick = () => nowPlaying.toggle();
  $('#btn-mute').onclick = () => player.setMuted(!player.muted);
  $('#npmini-heart').onclick = () => player.current && cycleRating(player.current.id);

  // Seek bar and volume bar share the same drag logic.
  const dragBar = (bar, onValue) => {
    bar.addEventListener('mousedown', (e) => {
      const rect = bar.getBoundingClientRect();
      const set = (ev) => onValue(clamp((ev.clientX - rect.left) / rect.width, 0, 1));
      bar.classList.add('dragging');
      set(e);
      const move = (ev) => set(ev);
      const up = () => {
        bar.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  };
  dragBar($('#seek'), (f) => player.seek(f * player.duration));
  dragBar($('#vol-bar'), (f) => player.setVolume(f));
  $('#vol-bar').addEventListener('wheel', (e) => {
    e.preventDefault();
    player.setVolume(player.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });

  player.on('track', updateTrack);
  player.on('state', updatePlayState);
  player.on('time', updateTime);
  player.on('volume', updateVolume);
  player.on('mode', updateModes);
  player.on('error', ({ track }) => toast(`Mune can't play "${track.title}". The file may be missing or in an unsupported format.`, 3500));
  model.on('rating', updateHeart);
  model.on('plays', updateProfile);
  model.on('art', (albumId) => {
    if (player.current?.albumId === albumId) updateTrack();
  });
}

function updateTrack() {
  const t = player.current;
  $('#npmini').hidden = !t;
  if (t) {
    const img = $('#npmini-art img');
    img.classList.remove('noart');
    img.onerror = () => img.classList.add('noart');
    img.src = artUrl(t.albumId, 'm', model.artVersion(t.albumId));
    const title = $('#npmini-title');
    title.textContent = t.title;
    title.title = `${t.title} — ${t.artist || t.aa}`;
    document.title = `${t.title} - ${t.artist || t.aa} - Mune`;
  } else {
    document.title = 'Mune';
  }
  updateHeart();
  updateTime();
  updatePlayState();
  if (document.body.classList.contains('compact')) renderMini();
}

function updateHeart() {
  const t = player.current;
  const btn = $('#npmini-heart');
  const r = t && model.rating(t.id);
  btn.className = `heart ${r || ''}`;
  btn.innerHTML = r === 'hate' ? icons.heartBroken : r === 'love' ? icons.heart : icons.heartOutline;
  view?.refresh?.();
}

function updatePlayState() {
  const playing = player.playing;
  $('#btn-play').innerHTML = playing ? icons.pause : icons.play;
  $('#btn-play').title = playing ? 'Pause (Ctrl+P)' : 'Play (Ctrl+P)';
  const miniPlay = $('#mini [data-mini="play"]');
  if (miniPlay) miniPlay.innerHTML = playing ? icons.pause : icons.play;
}

function updateTime() {
  const d = player.duration;
  const t = player.time;
  const f = d ? clamp(t / d, 0, 1) : 0;
  $('#seek .seek-fill').style.width = `${f * 100}%`;
  $('#seek .seek-knob').style.left = `${f * 100}%`;
  $('#t-elapsed').textContent = fmtTime(t);
  $('#t-remain').textContent = `-${fmtTime(Math.max(0, d - t))}`;
  updateMiniTime();
}

function updateVolume() {
  const v = player.muted ? 0 : player.volume;
  $('#vol-bar .vol-fill').style.width = `${v * 100}%`;
  $('#vol-bar .vol-knob').style.left = `${v * 100}%`;
  $('#vol-value').textContent = Math.round(player.volume * 100);
  $('#btn-mute').innerHTML = player.muted ? icons.mute : icons.volume;
  $('#btn-mute').classList.toggle('muted', player.muted);
}

function updateModes() {
  $('#btn-shuffle').classList.toggle('on', player.shuffle);
  $('#btn-repeat').classList.toggle('on', player.repeat);
}

// ---------------------------------------------------------------- drag targets (bottom left)
function wireDock() {
  const flyout = $('#flyout');
  let closeTimer = null;
  const openFlyout = (anchor) => {
    clearTimeout(closeTimer);
    if (!flyout.hidden) return;
    flyout.innerHTML = `<h4>add to playlist</h4><div class="fly-item new" data-fly="new">new playlist…</div>${model.playlistList.map((p) => `<div class="fly-item" data-fly="${p.id}">${esc(p.name)}</div>`).join('')}`;
    flyout.hidden = false;
    const r = anchor.getBoundingClientRect();
    flyout.style.left = `${r.left}px`;
    flyout.style.top = `${Math.max(8, r.top - flyout.offsetHeight - 8)}px`;
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { flyout.hidden = true; }, 350);
  };
  flyout.addEventListener('dragover', (e) => {
    if (!isTrackDrag(e)) return;
    e.preventDefault();
    clearTimeout(closeTimer);
    $$('.fly-item', flyout).forEach((n) => n.classList.toggle('drop', n === e.target.closest('.fly-item')));
  });
  flyout.addEventListener('dragleave', scheduleClose);
  flyout.addEventListener('drop', async (e) => {
    e.preventDefault();
    const item = e.target.closest('[data-fly]');
    const ids = droppedTracks(e);
    flyout.hidden = true;
    if (!item || !ids.length) return;
    if (item.dataset.fly === 'new') newPlaylist(ids);
    else addToPlaylist(item.dataset.fly, ids);
  });

  for (const btn of $$('.dock-btn, #btn-np')) {
    const kind = btn.dataset.dock || 'nowplaying';
    btn.addEventListener('dragover', (e) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      btn.classList.add('drop');
      if (kind === 'playlist') openFlyout(btn);
    });
    btn.addEventListener('dragleave', () => {
      btn.classList.remove('drop');
      if (kind === 'playlist') scheduleClose();
    });
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drop');
      const ids = droppedTracks(e);
      if (kind === 'nowplaying') {
        player.enqueue(ids);
        toast(`Added ${plural(ids.length, 'song')} to now playing`);
      } else if (kind === 'playlist') {
        flyout.hidden = true;
        newPlaylist(ids);
      } else if (kind === 'device') syncTracks(ids);
      else if (kind === 'disc') toast('Burning CDs isn\'t supported in Mune Player.', 3000);
    });
  }
  $('[data-dock="playlist"]').addEventListener('click', () => router.go({ pivot: 'collection', sub: 'music', view: 'playlists' }));
  $('[data-dock="device"]').addEventListener('click', () => {
    if (model.device?.connected) router.go({ pivot: 'device', sub: 'summary' });
    else toast('Connect your Zune with its USB cable and it will show up here.');
  });
  $('[data-dock="disc"]').addEventListener('click', () => toast('Burning CDs isn\'t supported in Mune Player.'));
  document.addEventListener('dragend', () => {
    flyout.hidden = true;
    $$('.dock-btn.drop, #btn-np.drop').forEach((b) => b.classList.remove('drop'));
  });
}

// ---------------------------------------------------------------- device sync
function updateDeviceDock() {
  const btn = $('[data-dock="device"]');
  const d = model.device;
  const p = model.syncProgress;
  const syncing = !!d?.busy || (!!p && !['done', 'error'].includes(p.phase));
  btn.classList.toggle('connected', !!d?.connected);
  btn.classList.toggle('syncing', !!d?.connected && syncing);
  const name = d?.device?.name || 'Zune';
  if (!d?.connected) btn.title = 'Drag to device (connect your Zune)';
  else if (syncing) btn.title = `${name} — ${syncLine(p) || 'syncing'}`;
  else btn.title = `${name}${d.info?.free ? ` — ${(d.info.free / 1e9).toFixed(1)} GB free` : ''}. Click to open, or drag music here to sync.`;
}

async function syncTracks(trackIds) {
  if (!model.device?.connected) return toast('Connect your Zune with its USB cable first.');
  if (!trackIds.length) return;
  const name = model.device.device?.name || 'your Zune';
  try {
    const plan = await api('device/plan', { trackIds });
    if (!plan.add && !plan.repair) return toast(`Already on ${name}.`);
    await api('device/sync', { trackIds });
    toast(`Syncing ${plural(plan.add + plan.repair, 'song')} to ${name}…`);
  } catch (err) {
    toast(err.message);
  }
}
ui.syncTracks = syncTracks;

// ---------------------------------------------------------------- the glow
function startGlow() {
  const canvas = $('#glow');
  const ctx = canvas.getContext('2d');
  const BANDS = 28;
  const smooth = new Float32Array(BANDS);
  let t0 = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (document.hidden || document.body.classList.contains('compact')) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const glow = GLOWS[model.user.settings.background] || GLOWS.pink;
    const dark = $('#frame').classList.contains('dark');
    const colors = dark ? glow.dark : glow.light;
    if (!colors) return;
    const [ca, cb] = colors;
    const levels = player.levels();
    const time = (now - t0) / 1000;
    const bins = levels ? levels.length : 0;
    let bass = 0;
    for (let i = 0; i < BANDS; i++) {
      let v = 0;
      if (levels) {
        // Log-spaced bands across the spectrum.
        const a = Math.floor((Math.pow(bins, i / BANDS)) - 1);
        const b = Math.max(a + 1, Math.floor(Math.pow(bins, (i + 1) / BANDS)));
        let sum = 0;
        for (let k = a; k < b && k < bins; k++) sum += levels[k];
        v = sum / ((b - a) * 255);
      }
      const idle = 0.18 + 0.06 * Math.sin(time * 0.9 + i * 0.7);
      const target = levels ? Math.max(idle * 0.6, v) : idle;
      smooth[i] += (target - smooth[i]) * (target > smooth[i] ? 0.35 : 0.08);
      if (i < 5) bass += smooth[i] / 5;
    }
    // Main elliptical glow, centred just below the bottom edge; it swells with the bass.
    const cx = w / 2;
    const rx = w * 0.3;
    const ry = h * (0.62 + bass * 0.5);
    const strength = dark ? 0.85 : 0.95;
    const base = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    base.addColorStop(0, `rgba(${ca},${strength})`);
    base.addColorStop(0.5, `rgba(${cb},${0.45 * strength})`);
    base.addColorStop(1, `rgba(${cb},0)`);
    ctx.save();
    ctx.translate(cx, h * 1.02);
    ctx.scale(1, ry / rx);
    ctx.fillStyle = base;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
    // Flame-like bands riding on the glow.
    const left = w * 0.24;
    const span = w * 0.52;
    const bw = span / BANDS;
    for (let i = 0; i < BANDS; i++) {
      const mirrored = i < BANDS / 2 ? smooth[BANDS / 2 - 1 - i] : smooth[i - BANDS / 2];
      const x = left + (i + 0.5) * bw;
      const edge = 1 - Math.abs((i + 0.5) / BANDS - 0.5) * 1.6;
      const hh = h * (0.25 + mirrored * 0.95) * edge;
      if (hh <= 1) continue;
      const g = ctx.createRadialGradient(x, h, 0, x, h, hh);
      g.addColorStop(0, `rgba(${ca},${0.42 * edge})`);
      g.addColorStop(1, `rgba(${cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, h, bw * 1.6, hh, 0, Math.PI, 2 * Math.PI);
      ctx.fill();
    }
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- keyboard
function wireKeys() {
  // Buttons never take focus from the mouse (Space would otherwise both "click" the
  // focused button and toggle playback).
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.target.closest('button') && !e.target.closest('.dialog')) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches?.('input, textarea');
    if (e.key === 'Escape') {
      if (!$('#menu').hidden) return closeMenu();
      if (mixview.open) return mixview.close();
      if (nowPlaying.open) return nowPlaying.close();
      return;
    }
    if (typing) return;
    if (view?.onKey?.(e)) {
      e.preventDefault();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === ' ' && !ctrl) player.toggle();
    else if (ctrl && k === 'p') player.toggle();
    else if (ctrl && k === 'f') player.next();
    else if (ctrl && k === 'b') player.prev();
    else if (ctrl && k === 'h') player.setShuffle(!player.shuffle);
    else if (ctrl && k === 't') player.setRepeat(!player.repeat);
    else if (ctrl && k === 'e') $('#search-input').focus();
    else if (ctrl && e.shiftKey && k === 'n') nowPlaying.toggle();
    else if (ctrl && k === 'n') newPlaylist([]);
    else if (ctrl && k === 'm' && native) native.win('compact');
    else if (ctrl && k === '1') router.go({ pivot: 'quickplay' });
    else if (ctrl && k === '2') router.go({ pivot: 'collection', sub: 'music', view: lastMusicView });
    else if (e.key === 'F7') player.setMuted(!player.muted);
    else if (e.key === 'F8') player.setVolume(player.volume - 0.05);
    else if (e.key === 'F9') player.setVolume(player.volume + 0.05);
    else if ((e.altKey && e.key === 'ArrowLeft') || e.key === 'Backspace' || e.key === 'BrowserBack') {
      if (mixview.open) mixview.back();
      else if (nowPlaying.open) nowPlaying.close();
      else router.back();
    } else if (e.key === 'MediaPlayPause') player.toggle();
    else handled = false;
    if (handled) e.preventDefault();
  });
  // Mouse back button.
  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      if (mixview.open) mixview.back();
      else if (nowPlaying.open) nowPlaying.close();
      else router.back();
    }
  });
}

// ---------------------------------------------------------------- live updates from the server
function wireEvents() {
  const refetch = debounce(async () => {
    try {
      const wasEmpty = !model.tracks.size;
      const { library, playlists } = await api('library');
      model.setLibrary(library);
      model.setPlaylists(playlists);
      // Views listen for 'library' themselves; only swap between the empty state and real views.
      if (!view || wasEmpty !== !model.tracks.size) renderPage();
      updateProfile();
    } catch (err) {
      console.warn(err);
    }
  }, 400);
  subscribe({
    scan: (s) => {
      const was = model.scan.scanning;
      model.scan = s;
      model.emit('scan', s);
      if (!model.tracks.size && s.scanning !== was) renderPage();
    },
    library: refetch,
    playlists: ({ playlists }) => model.setPlaylists(playlists),
    device: (status) => {
      const was = !!model.device?.connected;
      model.device = status;
      model.emit('device', status);
      updateDeviceDock();
      if (was !== status.connected) {
        renderChrome();
        if (status.connected) toast(`${status.device?.name || 'Your Zune'} is connected`);
        else if (router.state.pivot === 'device') router.go({ pivot: 'collection', sub: 'music', view: lastMusicView });
      }
    },
    sync: (p) => {
      model.syncProgress = p;
      model.emit('sync', p);
      updateDeviceDock();
      if (p.phase === 'done' || p.phase === 'error') toast(syncLine(p), 4000);
    },
    user: async (e) => {
      try {
        const { user } = await api('user');
        model.user.plays = user.plays;
        model.user.lastPlayed = user.lastPlayed;
        model.user.ratings = user.ratings;
        model.emit('plays');
        // Hearts changed on a synced phone.
        for (const r of e?.ratings || []) model.emit('rating', r.id);
        updateProfile();
      } catch {}
    },
    phone: (status) => {
      model.phone = status;
      model.emit('phone', status);
    },
    youtube: (status) => {
      model.youtube = status;
      model.emit('youtube', status);
      renderChrome();
    },
    phonepaired: ({ name }) => toast(`${name} is paired with this PC`, 4000),
    phonesynced: ({ name, added }) => toast(added ? `${name} synced ${plural(added, 'new song')}` : `${name} is up to date`, 4000),
    art: ({ albumId, has }) => {
      const a = model.albums.get(albumId);
      if (a) a.art = has;
      model.bumpArt(albumId);
    },
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  document.body.classList.add(shellKind === 'electron' ? 'electron' : 'browser');
  if (new URLSearchParams(location.search).has('noanim')) document.body.classList.add('noanim');
  const data = await api('bootstrap');
  model.profile = data.profile;
  model.platform = data.platform;
  model.scan = data.scan;
  model.user = data.user;
  model.setLibrary(data.library);
  model.setPlaylists(data.playlists);
  model.device = data.device || null;
  model.phone = data.phone || null;
  model.youtube = data.youtube || model.youtube;

  mixview = new Mixview($('#mixview'), { onClose: applyTheme, winButtons: winButtonsHtml() });
  ui.openMixview = (name) => {
    mixview.show(name);
    applyTheme();
  };
  nowPlaying = new NowPlaying($('#nowplaying'), { onClose: applyTheme, winButtons: winButtonsHtml(), onMixview: (name) => { nowPlaying.close(); ui.openMixview(name); } });
  const openNp = nowPlaying.show.bind(nowPlaying);
  nowPlaying.show = () => {
    mixview.close();
    openNp();
    applyTheme();
  };

  wireHeader();
  wireWindow();
  wireTransport();
  wireDock();
  wireKeys();
  wireEvents();
  startGlow();

  router.on('change', renderPage);
  model.on('settings', () => {
    applyTheme();
    updateProfile();
  });
  model.on('pins', () => {});

  const start = model.user.settings.startPivot === 'collection' ? { pivot: 'collection', sub: 'music', view: 'artists' } : { pivot: 'quickplay' };
  router.state = { ...router.state, ...start, params: {} };
  renderPage();
  updateProfile();
  player.restore(model.user.session);
  updateTrack();
  updateVolume();
  updateModes();
  updateDeviceDock();
  document.body.classList.remove('loading');
  native?.ready?.();
}

boot().catch((err) => {
  console.error(err);
  document.body.classList.remove('loading');
  $('#page').innerHTML = `<div class="placeholder"><h2>something went wrong</h2><p>${esc(err.message)}</p></div>`;
});
