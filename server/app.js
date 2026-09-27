import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { ArtService } from './art.js';
import { DeviceBridge, exePath } from './device.js';
import { createHttpServer } from './http.js';
import { Library } from './library.js';
import { Online } from './online.js';
import { PhoneSync } from './phone.js';
import { Playlists } from './playlists.js';
import { ZuneSync } from './sync.js';
import { JsonStore } from './store.js';
import { Transcoder } from './transcode.js';
import { cleanName, myMusicFolder } from './util.js';
import { importZuneFolders } from './zune-import.js';

const MAX_HISTORY = 60;

const USER_DEFAULTS = {
  settings: {
    folders: null, // null = not configured yet (first run)
    videoFolders: [],
    pictureFolders: [],
    playlistDir: null,
    background: 'pink',
    theme: 'light',
    startPivot: 'quickplay',
    resume: true,
    profileName: null, // null = the Windows account name
    pcName: null, // what phones call this PC; null = the computer name
    online: { albumArt: true, artistImages: true, related: true },
    sync: { auto: false },
    phone: { enabled: false },
    importedFromZune: false,
  },
  ratings: {},
  plays: {},
  lastPlayed: {},
  pins: [],
  history: [],
  session: null,
  devices: {},
  phones: {},
};

function accountName() {
  try {
    return cleanName(os.userInfo().username);
  } catch {
    return null;
  }
}

/**
 * Builds the whole back end (library, art, playlists, API) and starts the
 * local HTTP server. Used by the Electron main process and by server/dev.js.
 */
export async function startZoon({ stateDir, uiDir, port = 0, shell = 'browser', platform = {}, resize = async () => null, devices = false, phoneSync = false, phoneHost = '0.0.0.0' }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const user = new JsonStore(path.join(stateDir, 'state.json'), USER_DEFAULTS);
  user.load();
  const settings = user.data.settings = {
    ...USER_DEFAULTS.settings,
    ...user.data.settings,
    online: { ...USER_DEFAULTS.settings.online, ...(user.data.settings?.online || {}) },
    sync: { ...USER_DEFAULTS.settings.sync, ...(user.data.settings?.sync || {}) },
    phone: { ...USER_DEFAULTS.settings.phone, ...(user.data.settings?.phone || {}) },
  };
  user.data.devices ||= {};
  user.data.phones ||= {};

  if (!Array.isArray(settings.folders)) {
    const imported = await importZuneFolders();
    const music = myMusicFolder();
    settings.folders = [...new Set([...imported.music, music].filter((p) => p && fs.existsSync(p)))];
    settings.videoFolders = imported.video;
    settings.pictureFolders = imported.pictures;
    settings.importedFromZune = imported.found;
    user.save(0);
  }

  const getFolders = () => settings.folders || [];
  const getSaveDir = () => {
    if (settings.playlistDir) return settings.playlistDir;
    const first = getFolders()[0];
    return first ? path.join(first, 'Playlists') : path.join(myMusicFolder(), 'Playlists');
  };

  const library = new Library({ file: path.join(stateDir, 'library.json'), getFolders });
  library.load();
  const online = new Online({ file: path.join(stateDir, 'online-cache.json'), isEnabled: (f) => settings.online?.[f] });
  const art = new ArtService({ dir: path.join(stateDir, 'art'), library, online, resize });
  /** Library snapshot plus whether each album has art (null = not looked up yet). */
  const snapshot = () => {
    const s = library.snapshot();
    for (const a of s.albums) a.art = art.hasAlbumArt(a.id);
    return s;
  };
  const playlists = new Playlists({ library, getFolders, getSaveDir });
  await playlists.load();
  const transcoder = new Transcoder(path.join(stateDir, 'transcoded'));
  const bridge = new DeviceBridge(exePath(path.resolve(uiDir, '..')));
  const sync = new ZuneSync({ bridge, library, art, user, cacheDir: path.join(stateDir, 'sync-cache'), ffmpeg: null });
  transcoder.ready.then(() => { sync.ffmpeg = transcoder.ffmpeg; });
  const phone = new PhoneSync({ user, library, art, playlists, cacheDir: path.join(stateDir, 'phone-cache'), getFfmpeg: () => transcoder.ffmpeg, host: phoneHost });

  const profileName = () => settings.profileName || accountName() || 'zoon';

  const publicUser = () => ({
    settings,
    ratings: user.data.ratings,
    plays: user.data.plays,
    lastPlayed: user.data.lastPlayed,
    pins: user.data.pins,
    history: user.data.history,
    session: user.data.session,
  });

  const ctx = {
    token,
    uiDir: path.resolve(uiDir),
    shell,
    library,
    art,
    transcoder,
    registerRoutes(route, { sendJson, HttpError }) {
      const ok = (res, body = { ok: true }) => sendJson(res, 200, body);

      route('GET', /^\/api\/bootstrap$/, (req, res) => ok(res, {
        shell,
        profile: { name: profileName() },
        library: snapshot(),
        playlists: playlists.list(),
        user: publicUser(),
        scan: library.status,
        platform: { ffmpeg: transcoder.available, os: process.platform },
        device: sync.status(),
        phone: phone.status(),
      }));

      route('GET', /^\/api\/library$/, (req, res) => ok(res, { library: snapshot(), playlists: playlists.list() }));

      route('POST', /^\/api\/scan$/, (req, res, m, url, body) => {
        library.scan({ full: !!body.full });
        ok(res);
      });

      route('POST', /^\/api\/rate$/, (req, res, m, url, { id, rating }) => {
        if (!library.tracks.has(id)) throw new HttpError(404, 'Unknown track');
        if (rating === 'love' || rating === 'hate') user.data.ratings[id] = rating;
        else delete user.data.ratings[id];
        user.save();
        broadcast('rating', { id, rating: user.data.ratings[id] || null });
        ok(res);
      });

      route('POST', /^\/api\/played$/, (req, res, m, url, { id }) => {
        if (!library.tracks.has(id)) throw new HttpError(404, 'Unknown track');
        user.data.plays[id] = (user.data.plays[id] || 0) + 1;
        user.data.lastPlayed[id] = Date.now();
        user.save();
        ok(res, { plays: user.data.plays[id] });
      });

      route('POST', /^\/api\/history$/, (req, res, m, url, { type, id }) => {
        if (!type || !id) throw new HttpError(400, 'type and id required');
        user.data.history = [{ type, id, t: Date.now() }, ...user.data.history.filter((h) => !(h.type === type && h.id === id))].slice(0, MAX_HISTORY);
        user.save();
        ok(res, { history: user.data.history });
      });

      route('POST', /^\/api\/pins$/, (req, res, m, url, { op, type, id, to }) => {
        let pins = user.data.pins.filter((p) => !(p.type === type && p.id === id));
        if (op === 'add') pins = [{ type, id, t: Date.now() }, ...pins];
        else if (op === 'move') {
          const item = user.data.pins.find((p) => p.type === type && p.id === id);
          if (item) pins.splice(Math.max(0, Math.min(to, pins.length)), 0, item);
        }
        user.data.pins = pins;
        user.save();
        ok(res, { pins });
      });

      route('POST', /^\/api\/settings$/, async (req, res, m, url, patch) => {
        const before = JSON.stringify(settings.folders);
        const phoneBefore = !!settings.phone?.enabled;
        const pcNameBefore = settings.pcName;
        for (const [k, v] of Object.entries(patch || {})) {
          if (!(k in USER_DEFAULTS.settings)) continue;
          if (k === 'profileName' || k === 'pcName') settings[k] = cleanName(v);
          else settings[k] = k === 'online' || k === 'phone' ? { ...settings[k], ...v } : v;
        }
        if (Array.isArray(settings.folders)) settings.folders = [...new Set(settings.folders.filter(Boolean).map((f) => path.resolve(f)))];
        user.save(0);
        if (phoneSync && !!settings.phone?.enabled !== phoneBefore) await phone.apply();
        else if (settings.pcName !== pcNameBefore) phone.emit('status');
        if (JSON.stringify(settings.folders) !== before) {
          library.watch();
          library.scan().then(() => playlists.refresh());
        }
        ok(res, { settings, profile: { name: profileName() } });
      });

      route('POST', /^\/api\/session$/, (req, res, m, url, session) => {
        user.data.session = session;
        user.save(2000);
        ok(res);
      });

      route('GET', /^\/api\/track\/([a-f0-9]{12})$/, async (req, res, [, id]) => {
        const t = library.tracks.get(id);
        if (!t) throw new HttpError(404, 'Unknown track');
        let tags = null;
        try {
          const meta = await parseFile(t.path, { duration: false, skipCovers: true });
          tags = { common: meta.common, format: { ...meta.format, trackInfo: undefined } };
        } catch (err) {
          tags = { error: err.message };
        }
        let size = null;
        try {
          size = fs.statSync(t.path).size;
        } catch {}
        ok(res, { track: t, tags, size, plays: user.data.plays[id] || 0, lastPlayed: user.data.lastPlayed[id] || null });
      });

      route('POST', /^\/api\/related$/, async (req, res, m, url, { artist }) => {
        if (!settings.online.related) return ok(res, { names: [] });
        ok(res, { names: await online.related(artist) });
      });

      route('POST', /^\/api\/reveal$/, (req, res, m, url, { id }) => {
        const t = library.tracks.get(id);
        if (!t) throw new HttpError(404, 'Unknown track');
        if (!platform.reveal) throw new HttpError(501, 'Not available here');
        platform.reveal(t.path);
        ok(res);
      });

      route('GET', /^\/api\/device$/, (req, res) => ok(res, { device: sync.status() }));

      route('GET', /^\/api\/device\/content$/, (req, res) => ok(res, { content: sync.content }));

      route('POST', /^\/api\/device\/refresh$/, async (req, res) => ok(res, { device: await sync.refresh() }));

      route('POST', /^\/api\/device\/plan$/, (req, res, m, url, body) => {
        if (!sync.content) throw new HttpError(409, 'Connect your Zune first');
        const plan = sync.plan(sync.selection(body));
        ok(res, { add: plan.add.length, repair: plan.repair.length, already: plan.already, bytes: plan.bytes });
      });

      route('POST', /^\/api\/device\/sync$/, (req, res, m, url, body) => {
        if (!sync.status().connected) throw new HttpError(409, 'No Zune is connected');
        if (sync.busy) throw new HttpError(409, 'A sync is already running');
        sync.sync(body).catch((err) => console.warn('[sync]', err.message));
        ok(res, { started: true });
      });

      route('POST', /^\/api\/device\/rename$/, async (req, res, m, url, { name }) => {
        const clean = cleanName(name, 30);
        if (!clean) throw new HttpError(400, 'Type a name for your Zune');
        if (!sync.status().connected) throw new HttpError(409, 'No Zune is connected');
        ok(res, { device: await sync.rename(clean) });
      });

      route('POST', /^\/api\/device\/remove$/, async (req, res, m, url, { objectIds }) => {
        await sync.removeFromDevice((objectIds || []).filter((id) => /^o[0-9A-F]+$/i.test(id)));
        ok(res, { device: sync.status() });
      });

      route('GET', /^\/api\/user$/, (req, res) => ok(res, { user: publicUser() }));

      route('GET', /^\/api\/phone$/, (req, res) => ok(res, { phone: phone.status() }));

      route('POST', /^\/api\/phone\/pair$/, (req, res) => {
        if (!phoneSync) throw new HttpError(501, 'Wireless sync runs in the desktop app');
        ok(res, { pairing: phone.beginPairing() });
      });

      route('POST', /^\/api\/phone\/cancel$/, (req, res) => {
        phone.cancelPairing();
        ok(res);
      });

      route('POST', /^\/api\/phone\/forget$/, (req, res, m, url, { id }) => {
        phone.forget(String(id || ''));
        ok(res, { phone: phone.status() });
      });

      route('POST', /^\/api\/playlists$/, async (req, res, m, url, { name, trackIds }) => {
        const pl = await playlists.create(name || 'Untitled Playlist', (trackIds || []).filter((id) => library.tracks.has(id)));
        ok(res, { playlist: stripEntries(pl), playlists: playlists.list() });
      });

      route('POST', /^\/api\/playlists\/([a-f0-9]{12})$/, async (req, res, [, id], url, body) => {
        const pl = await playlists.update(id, {
          name: body.name,
          trackIds: body.trackIds?.filter((t) => library.tracks.has(t)),
          append: body.append?.filter((t) => library.tracks.has(t)),
        });
        ok(res, { playlist: stripEntries(pl), playlists: playlists.list() });
      });

      route('DELETE', /^\/api\/playlists\/([a-f0-9]{12})$/, async (req, res, [, id]) => {
        if (!platform.trash) throw new HttpError(501, 'Deleting playlists needs the desktop app');
        await playlists.remove(id, platform.trash);
        user.data.pins = user.data.pins.filter((p) => !(p.type === 'playlist' && p.id === id));
        user.save();
        ok(res, { playlists: playlists.list() });
      });
    },
  };

  const stripEntries = ({ entries, ...p }) => p;
  const web = createHttpServer(ctx);
  const { broadcast } = web;

  library.on('status', (s) => broadcast('scan', s));
  library.on('changed', async () => {
    await playlists.refresh();
    broadcast('library', { version: library.version });
    art.warm();
  });
  playlists.on('changed', () => broadcast('playlists', { playlists: playlists.list() }));
  art.on('art', (e) => broadcast('art', e));
  sync.on('status', () => broadcast('device', sync.status()));
  sync.on('progress', (p) => broadcast('sync', p));
  sync.on('plays', () => broadcast('user', {}));
  phone.on('status', () => broadcast('phone', phone.status()));
  phone.on('user', (e) => broadcast('user', e));
  phone.on('paired', (e) => broadcast('phonepaired', e));
  phone.on('synced', (e) => broadcast('phonesynced', e));

  let bound;
  try {
    bound = await web.listen(port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || !port) throw err;
    bound = await web.listen(0);
  }

  library.watch();
  library.scan().then(() => art.warm());
  if (devices) sync.start();
  if (phoneSync && settings.phone?.enabled) phone.apply();

  return {
    port: bound,
    token,
    url: `http://127.0.0.1:${bound}/`,
    library,
    async shutdown() {
      sync.stop();
      await phone.stop();
      library.unwatch();
      user.flushSync();
      library.store.flushSync();
      art.index.flushSync();
      online.cache.flushSync();
      web.server.closeAllConnections();
      await new Promise((r) => web.server.close(() => r()));
    },
  };
}
