// settings: collection folders, playback, display, online services, keyboard, about.
import { api, native } from '../api.js';
import { prompt, toast } from '../components.js';
import { model } from '../model.js';
import { router } from '../router.js';
import { el, esc, plural } from '../util.js';

export const GLOWS = {
  pink: { label: 'zoon', light: ['255,132,118', '247,150,186'], dark: ['236,40,120', '240,90,60'] },
  blue: { label: 'blue', light: ['90,170,255', '140,205,255'], dark: ['30,120,240', '60,190,255'] },
  green: { label: 'green', light: ['140,210,80', '196,232,120'], dark: ['90,180,30', '170,220,40'] },
  orange: { label: 'orange', light: ['255,160,60', '255,206,110'], dark: ['240,110,20', '255,170,40'] },
  purple: { label: 'purple', light: ['170,120,255', '214,160,255'], dark: ['130,60,240', '200,90,255'] },
  none: { label: 'none', light: null, dark: null },
};

const SECTIONS = ['collection', 'playback', 'display', 'online', 'phone', 'account', 'keyboard', 'about'];

const SHORTCUTS = [
  ['Play / pause', 'Space or Ctrl+P'],
  ['Next song', 'Ctrl+F'],
  ['Previous song', 'Ctrl+B'],
  ['Shuffle on/off', 'Ctrl+H'],
  ['Repeat on/off', 'Ctrl+T'],
  ['Mute', 'F7'],
  ['Volume down / up', 'F8 / F9'],
  ['Search', 'Ctrl+E'],
  ['Back', 'Alt+Left or Backspace'],
  ['New playlist', 'Ctrl+N'],
  ['Now playing', 'Ctrl+Shift+N'],
  ['Compact mode', 'Ctrl+M'],
  ['Quickplay / collection', 'Ctrl+1 / Ctrl+2'],
  ['Select all', 'Ctrl+A'],
  ['Play selection', 'Enter'],
  ['Remove from playlist', 'Delete'],
];

function check(key, label, sub, on) {
  return `<label class="check"><input type="checkbox" data-set="${key}" ${on ? 'checked' : ''}><span class="box"></span><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
}

function ago(ts) {
  if (!ts) return null;
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

const phoneLine = (p) => (p.lastSync
  ? `last synced ${ago(p.lastSync)}${p.songs != null ? ` · ${plural(p.songs, 'song')}` : ''}`
  : `paired ${ago(p.paired)}, not synced yet`);

const fmtLeft = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const ext = (href, text) => `<a href="${href}" target="_blank">${text}</a>`;

/** settings > online > youtube music: set up the Google client, sign in with a code, sign out. */
function youtubeSection(yt) {
  let body;
  if (!yt.configured) {
    body = `
      <p>Search YouTube Music and play your YouTube playlists and liked songs in the marketplace, with video, in YouTube's own player. Zoon reaches YouTube through your own free Google Cloud project, set up once:</p>
      <ol class="yt-steps">
        <li>At <b>console.cloud.google.com</b>, create a project and enable the <b>YouTube Data API v3</b> (APIs &amp; Services › Library).</li>
        <li>In <b>Google Auth Platform</b>, set the app up as <b>External</b>. Under <b>Audience</b>, add yourself as a test user, or choose <b>Publish app</b> so the sign-in doesn't expire every 7 days. (Google warns that the app is unverified; it's your own project.)</li>
        <li>Under <b>Clients</b>, create a client of the type <b>TVs and Limited Input devices</b>, then paste its ID and secret here.</li>
      </ol>
      <div class="addfolder yt-client">
        <input type="text" data-yt-id placeholder="client ID (…apps.googleusercontent.com)" spellcheck="false" autocomplete="off">
        <input type="password" data-yt-secret placeholder="client secret" spellcheck="false" autocomplete="off">
        <button class="zbtn" data-yt="save">save</button>
      </div>`;
  } else if (yt.signin) {
    body = `
      <p>On this PC or on your phone, go to <b>${esc(yt.signin.url.replace(/^https?:\/\//, ''))}</b>, sign in to Google and enter this code:</p>
      <div class="paircode yt-code">${esc(yt.signin.code)}</div>
      <p data-ytexpires>The code works for ${fmtLeft(yt.signin.expires - Date.now())}.</p>
      <div class="row-actions"><button class="zbtn primary" data-yt="page">open the page</button><button class="zbtn" data-yt="cancel">cancel</button></div>`;
  } else if (yt.signedIn) {
    body = `
      <ul class="folders"><li><span>signed in${yt.channel?.title ? ` as ${esc(yt.channel.title)}` : ''}</span><a data-yt="signout">sign out</a></li></ul>
      <p>Find it under marketplace: search YouTube Music, your playlists and your liked songs.</p>`;
  } else {
    body = `
      <p>Sign in with the Google account you use for YouTube Music.</p>
      <div class="row-actions"><button class="zbtn primary" data-yt="signin">sign in with Google</button></div>
      <ul class="folders"><li><span title="${esc(yt.clientId)}">Google client ${esc(yt.clientId)}</span><a data-yt="remove">remove</a></li></ul>`;
  }
  return `
    <section>
      <h3>youtube music</h3>
      ${body}
      ${yt.error ? `<div class="status-line busy">${esc(yt.error)}</div>` : ''}
      <p class="yt-fine">This uses YouTube API Services. By signing in you agree to the ${ext('https://www.youtube.com/t/terms', 'YouTube Terms of Service')}; see also the ${ext('https://policies.google.com/privacy', 'Google Privacy Policy')}. The sign-in stays on this PC, and you can ${ext('https://myaccount.google.com/connections', 'remove Zoon\'s access')} from your Google Account at any time.</p>
    </section>`;
}

export function settingsView(page) {
  let section = router.state.params.section || 'collection';
  const root = el(`
    <div class="settings">
      <nav>${SECTIONS.map((s) => `<a data-section="${s}">${s}</a>`).join('')}</nav>
      <div class="pane"></div>
      <div class="settings-buttons"><button class="zbtn primary" data-ok>ok</button></div>
    </div>`);
  page.appendChild(root);
  const pane = root.querySelector('.pane');

  const s = () => model.user.settings;

  const render = () => {
    root.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.section === section));
    const st = s();
    if (section === 'collection') {
      const folders = st.folders || [];
      const scan = model.scan;
      pane.innerHTML = `
        <section>
          <h3>music folders</h3>
          <p>Zoon watches these folders and adds new music automatically.${st.importedFromZune ? ' They were copied from your original Zune software settings.' : ''}</p>
          <ul class="folders">${folders.map((f, i) => `<li><span title="${esc(f)}">${esc(f)}</span><a data-remove="${i}">remove</a></li>`).join('') || '<li><span class="muted">No folders yet.</span></li>'}</ul>
          <div class="addfolder">
            ${native ? '<button class="zbtn" data-add>add folder…</button>' : '<input type="text" placeholder="Paste a folder path, e.g. D:\\Music" data-path><button class="zbtn" data-add>add</button>'}
            <button class="zbtn" data-rescan>rescan now</button>
          </div>
          <div class="status-line ${scan.scanning ? 'busy' : ''}">${scan.scanning
            ? `Updating collection… ${scan.done || 0} of ${scan.total || '?'} files`
            : `${plural(model.tracks.size, 'song')}, ${plural(model.albums.size, 'album')}, ${plural(model.artists.size, 'artist')}${scan.lastScan ? ` · last checked ${new Date(scan.lastScan).toLocaleTimeString()}` : ''}`}</div>
        </section>
        <section>
          <h3>playlists</h3>
          <p>New playlists are saved as Zune playlist files (.zpl), so the original Zune software can open them too.</p>
          <ul class="folders"><li><span>${esc(st.playlistDir || `${folders[0] || 'Music'}\\Playlists`)}</span>${native ? '<a data-pldir>change</a>' : ''}</li></ul>
        </section>`;
    } else if (section === 'playback') {
      pane.innerHTML = `
        <section>
          <h3>playback</h3>
          ${check('resume', 'Resume where I left off', 'Reopen with the same now playing list, paused at the same spot.', st.resume !== false)}
        </section>
        <section>
          <h3>file types</h3>
          <p>MP3, AAC/M4A, FLAC, WAV, OGG and Opus play directly. WMA and AIFF are converted once with ffmpeg${model.platform.ffmpeg ? ' (found on this PC)' : ' (not found — install ffmpeg to play them)'}, like Zune's transcoded files cache.</p>
        </section>`;
    } else if (section === 'display') {
      pane.innerHTML = `
        <section>
          <h3>background</h3>
          <p>The glow along the bottom of the window. It pulses with the music.</p>
          <div class="swatches">${Object.entries(GLOWS).map(([k, g]) => `
            <div><button class="swatch ${st.background === k ? 'on' : ''}" data-glow="${k}" style="--sw:${g.light ? `rgb(${g.light[0]})` : 'transparent'}"></button><div class="swatch-label">${esc(g.label)}</div></div>`).join('')}</div>
        </section>
        <section>
          <h3>theme</h3>
          ${check('darkTheme', 'Dark collection', 'The hidden dark mode from Zune 4.8, used everywhere instead of only in quickplay and now playing.', st.theme === 'dark')}
        </section>
        <section>
          <h3>start-up</h3>
          <div class="radio-row">
            ${['quickplay', 'collection'].map((p) => `<label class="check"><input type="checkbox" data-start="${p}" ${st.startPivot === p ? 'checked' : ''}><span class="box"></span><span>Start in ${p}</span></label>`).join('')}
          </div>
        </section>`;
    } else if (section === 'online') {
      pane.innerHTML = `
        <section>
          <h3>online services</h3>
          <p>The Zune service shut down in 2015. These options use the free Deezer and iTunes Search catalogs instead. Only artist and album names are sent; results are cached on this PC.</p>
          ${check('online.albumArt', 'Find missing album art', 'For albums with no embedded art or cover image in the folder.', st.online?.albumArt)}
          ${check('online.artistImages', 'Show artist photos in now playing', 'Brings back the big artist backgrounds from Zune 4.', st.online?.artistImages)}
          ${check('online.related', 'Use related artists for Smart DJ', 'Mixes in artists you own that are similar to the one you picked.', st.online?.related)}
        </section>
        ${youtubeSection(model.youtube || {})}`;
    } else if (section === 'phone') {
      const ph = model.phone || {};
      const on = !!st.phone?.enabled;
      const pairing = ph.pairing;
      pane.innerHTML = `
        <section>
          <h3>wireless sync</h3>
          <p>Sync your music to the Zoon Player app on your Android phone over Wi‑Fi, the way a Zune HD synced. Your phone and this PC need to be on the same network, with Zoon Player open here.</p>
          ${check('phone.enabled', 'Let my phone sync with this PC over Wi‑Fi', 'The first time, Windows asks whether Zoon Player may use your network. Choose Allow for private networks.', on)}
          ${on ? `<div class="status-line ${ph.listening ? '' : 'busy'}">${esc(ph.listening ? `Ready for your phone at ${(ph.addresses || []).join(', ') || 'this PC'} (port ${ph.port}).` : ph.error || 'Starting…')}</div>` : ''}
          ${ph.activity ? `<div class="status-line busy">${esc(`${ph.activity.phone} is syncing: ${ph.activity.title}`)}</div>` : ''}
        </section>
        ${on ? `<section>
          <h3>this pc's name</h3>
          <p>Your phone lists this PC by this name.</p>
          <ul class="folders"><li><span>${esc(ph.name || '')}</span><a data-rename="pc">change</a></li></ul>
        </section>` : ''}
        ${on ? `<section>
          <h3>pair a phone</h3>
          ${pairing ? `
            <p>On your phone, open Zoon, go to <b>sync</b>, pick <b>${esc(ph.name || 'this PC')}</b> and enter this code:</p>
            <div class="paircode">${esc(pairing.code.slice(0, 3))}<i></i>${esc(pairing.code.slice(3))}</div>
            <p data-expires>The code works for ${fmtLeft(pairing.expires - Date.now())}.</p>
            <button class="zbtn" data-cancelpair>cancel</button>` : `
            <p>Install Zoon Player on your phone and pair it once. After that it syncs whenever you ask, and on its own while it charges on this Wi‑Fi.</p>
            <button class="zbtn primary" data-pair ${ph.listening ? '' : 'disabled'}>pair a phone</button>`}
        </section>` : ''}
        <section>
          <h3>paired phones</h3>
          <ul class="folders">${(ph.phones || []).map((p) => `<li><span>${esc(p.name)} <small class="muted">— ${esc(phoneLine(p))}</small></span><a data-forget="${esc(p.id)}">forget</a></li>`).join('') || '<li><span class="muted">No phones yet.</span></li>'}</ul>
        </section>`;
    } else if (section === 'account') {
      pane.innerHTML = `
        <section>
          <h3>your name</h3>
          <p>Shown at the top of Zoon and on your zoon card. It stays on this PC.</p>
          <ul class="folders"><li><span>${esc(model.profile.name || '')}</span><a data-rename="profile">change</a></li></ul>
        </section>`;
    } else if (section === 'keyboard') {
      pane.innerHTML = `
        <section>
          <h3>keyboard shortcuts</h3>
          <table class="kbd-table">${SHORTCUTS.map(([a, k]) => `<tr><td>${esc(k)}</td><td>${esc(a)}</td></tr>`).join('')}</table>
        </section>`;
    } else {
      pane.innerHTML = `
        <section>
          <h3>zoon player</h3>
          <p>A music player for your own collection, rebuilt from scratch in the style of the Zune 4.8 desktop software. Not affiliated with Microsoft; Zune is a trademark of Microsoft Corporation.</p>
          <p>${plural(model.tracks.size, 'song')} · ${plural(model.albums.size, 'album')} · ${plural(model.playlists.size, 'playlist')} · ${model.totalPlays().toLocaleString()} plays</p>
        </section>`;
    }
  };

  const save = async (patch) => {
    try {
      await model.saveSettings(patch);
      render();
    } catch (err) {
      toast(err.message);
    }
  };

  const youtubeAction = async (act) => {
    try {
      let res = null;
      if (act === 'save') {
        res = await api('youtube/client', { clientId: pane.querySelector('[data-yt-id]').value, clientSecret: pane.querySelector('[data-yt-secret]').value });
      } else if (act === 'signin') {
        const { signin } = await api('youtube/signin', {});
        window.open(signin.url, '_blank'); // google.com/device, in the browser
      } else if (act === 'page') {
        window.open(model.youtube.signin?.url || 'https://www.google.com/device', '_blank');
      } else if (act === 'cancel') {
        await api('youtube/signin/cancel', {});
      } else if (act === 'signout') {
        res = await api('youtube/signout', {});
      } else if (act === 'remove') {
        res = await api('youtube/client/remove', {});
      }
      if (res?.youtube) {
        model.youtube = res.youtube;
        model.emit('youtube', res.youtube);
      }
    } catch (err) {
      toast(err.message);
    }
  };

  root.addEventListener('click', async (e) => {
    const t = e.target;
    const sec = t.closest('[data-section]');
    if (sec) {
      section = sec.dataset.section;
      router.patch({ section });
      return render();
    }
    if (t.closest('[data-ok]')) return router.back() || router.go({ pivot: 'collection', sub: 'music', view: 'artists' });
    const rm = t.closest('[data-remove]');
    if (rm) {
      const folders = [...(s().folders || [])];
      folders.splice(Number(rm.dataset.remove), 1);
      return save({ folders });
    }
    if (t.closest('[data-add]')) {
      let path = null;
      if (native) path = await native.pickFolder();
      else path = root.querySelector('[data-path]')?.value.trim();
      if (!path) return;
      return save({ folders: [...(s().folders || []), path] });
    }
    if (t.closest('[data-rescan]')) {
      await api('scan', { full: false });
      return toast('Checking your folders for changes…');
    }
    if (t.closest('[data-pldir]')) {
      const dir = await native.pickFolder();
      if (dir) save({ playlistDir: dir });
      return;
    }
    const glow = t.closest('[data-glow]');
    if (glow) return save({ background: glow.dataset.glow });
    const yt = t.closest('[data-yt]');
    if (yt) return youtubeAction(yt.dataset.yt);
    const rename = t.closest('[data-rename]');
    if (rename) {
      const pc = rename.dataset.rename === 'pc';
      const name = await prompt(pc ? "this pc's name" : 'your name', { value: pc ? model.phone?.name || '' : model.profile.name || '', okLabel: 'save' });
      if (name) await save(pc ? { pcName: name } : { profileName: name });
      return;
    }
    try {
      if (t.closest('[data-pair]')) {
        await api('phone/pair', {});
        return;
      }
      if (t.closest('[data-cancelpair]')) return void (await api('phone/cancel', {}));
      const forget = t.closest('[data-forget]');
      if (forget) {
        const p = (model.phone?.phones || []).find((x) => x.id === forget.dataset.forget);
        await api('phone/forget', { id: forget.dataset.forget });
        return toast(`${p?.name || 'The phone'} will need to pair again to sync.`);
      }
    } catch (err) {
      toast(err.message);
    }
  });

  root.addEventListener('change', (e) => {
    const key = e.target.dataset.set;
    const start = e.target.dataset.start;
    if (start) return save({ startPivot: start });
    if (!key) return;
    const on = e.target.checked;
    if (key === 'darkTheme') return save({ theme: on ? 'dark' : 'light' });
    if (key.startsWith('online.')) return save({ online: { [key.split('.')[1]]: on } });
    if (key === 'phone.enabled') return save({ phone: { enabled: on } });
    return save({ [key]: on });
  });

  const unsub = [
    model.on('scan', () => section === 'collection' && render()),
    model.on('library', render),
    model.on('phone', () => section === 'phone' && render()),
    model.on('youtube', () => section === 'online' && render()),
  ];
  // Count the pairing and YouTube sign-in codes down; re-render when they run out.
  const tick = setInterval(() => {
    const y = model.youtube?.signin;
    if (section === 'online' && y) {
      if (y.expires <= Date.now()) {
        model.youtube.signin = null;
        return render();
      }
      const line = pane.querySelector('[data-ytexpires]');
      if (line) line.textContent = `The code works for ${fmtLeft(y.expires - Date.now())}.`;
    }
    const p = model.phone?.pairing;
    if (section !== 'phone' || !p) return;
    const left = p.expires - Date.now();
    if (left <= 0) {
      model.phone.pairing = null;
      return render();
    }
    const line = pane.querySelector('[data-expires]');
    if (line) line.textContent = `The code works for ${fmtLeft(left)}.`;
  }, 1000);
  render();
  return { destroy: () => { clearInterval(tick); unsub.forEach((u) => u()); }, refresh() {} };
}
