// Wireless sync with the Mune Player Android app (settings > phone).
//
// Off until it's turned on. The phone finds this PC with a UDP broadcast, pairs
// once with a six-digit code shown on the PC, and then uses a small HTTP API on
// the local network with a bearer token: it reads the collection, downloads
// songs and album art, and reports its plays and hearts back, the way a Zune HD
// did over wireless sync.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HttpError, readBody, sendFile, sendJson, sendMedia } from './http.js';
import { MIME, NATIVE_EXT, cleanName } from './util.js';

export const PHONE_PORT = 18760;
export const DISCOVERY_PORT = 18761;
const API = '/mune/v1';
const PAIR_MS = 10 * 60 * 1000;
const MAX_TRIES = 8;
const VPN = /tailscale|vpn|zerotier|wireguard/i;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Private, link-local, CGNAT (Tailscale) and loopback IPv4: the only peers we talk to. */
export function isLocalAddress(ip) {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  if (v4 === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** This PC's LAN addresses, Wi-Fi/Ethernet first and VPNs last (virtual switches skipped). */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out.sort((x, y) => Number(VPN.test(x.name)) - Number(VPN.test(y.name))).map((a) => a.address);
}

const run = (bin, args) => new Promise((resolve, reject) => {
  const p = spawn(bin, args, { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
});

/** Android plays everything Chromium does; WMA becomes MP3 and AIFF becomes FLAC. */
const convertedExt = (ext) => (ext === '.wma' ? '.mp3' : '.flac');

export class PhoneSync extends EventEmitter {
  constructor({ user, library, art, playlists, cacheDir, getFfmpeg, getYouTubeClient = () => null, host = '0.0.0.0', port = PHONE_PORT }) {
    super();
    this.getYouTubeClient = getYouTubeClient;
    this.user = user;
    this.library = library;
    this.art = art;
    this.playlists = playlists;
    this.cacheDir = cacheDir;
    this.getFfmpeg = getFfmpeg;
    this.host = host;
    this.wantedPort = port;
    this.server = null;
    this.udp = null;
    this.port = null;
    this.error = null;
    this.pairing = null;
    this.pairTimer = null;
    this.activity = null;
    this.converting = new Map();
    user.data.phones ||= {};
    if (!user.data.pcId) {
      user.data.pcId = crypto.randomUUID();
      user.save();
    }
  }

  get enabled() {
    return !!this.user.data.settings.phone?.enabled;
  }

  /** The name phones show for this PC: the one chosen in settings > phone, or the computer name. */
  pcName() {
    return this.user.data.settings.pcName || os.hostname() || 'My PC';
  }

  status() {
    const pairing = this.pairing && this.pairing.expires > Date.now() ? { code: this.pairing.code, expires: this.pairing.expires } : null;
    return {
      name: this.pcName(),
      enabled: this.enabled,
      listening: !!this.server,
      port: this.port,
      addresses: this.server ? (this.host === '0.0.0.0' ? lanAddresses() : [this.host]) : [],
      error: this.error,
      pairing,
      activity: this.activity && Date.now() - this.activity.at < 15000 ? this.activity : null,
      phones: Object.entries(this.user.data.phones).map(([id, p]) => ({
        id, name: p.name, paired: p.paired, lastSeen: p.lastSeen || null, lastSync: p.lastSync || null, songs: p.songs ?? null,
      })),
    };
  }

  /** Start or stop to match settings.phone.enabled. */
  async apply() {
    if (this.enabled) await this.start();
    else await this.stop();
    this.emit('status');
  }

  async start() {
    if (this.server) return;
    this.error = null;
    const server = http.createServer((req, res) => this.#handle(req, res));
    server.keepAliveTimeout = 30000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.wantedPort, this.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.error = err.code === 'EADDRINUSE'
        ? `Port ${this.wantedPort} is already in use (is Mune Player open twice?).`
        : err.message;
      return;
    }
    this.server = server;
    this.port = server.address().port;
    this.#startDiscovery();
  }

  #startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      console.warn('[phone] discovery:', err.message);
      try {
        sock.close();
      } catch {}
      if (this.udp === sock) this.udp = null;
    });
    sock.on('message', (msg, rinfo) => {
      if (msg.length > 512 || !isLocalAddress(rinfo.address)) return;
      let q;
      try {
        q = JSON.parse(msg.toString('utf8'));
      } catch {
        return;
      }
      if (q?.q !== 'mune-player') return;
      sock.send(Buffer.from(JSON.stringify(this.#hello())), rinfo.port, rinfo.address);
    });
    sock.bind(DISCOVERY_PORT, this.host === '0.0.0.0' ? undefined : this.host);
    this.udp = sock;
  }

  async stop() {
    this.pairing = null;
    clearTimeout(this.pairTimer);
    if (this.udp) {
      try {
        this.udp.close();
      } catch {}
      this.udp = null;
    }
    if (this.server) {
      const s = this.server;
      this.server = null;
      this.port = null;
      s.closeAllConnections?.();
      await new Promise((r) => s.close(() => r()));
    }
  }

  beginPairing() {
    if (!this.server) throw new HttpError(409, 'Turn on wireless sync first');
    this.pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), expires: Date.now() + PAIR_MS, tries: 0 };
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => {
      this.pairing = null;
      this.emit('status');
    }, PAIR_MS);
    this.pairTimer.unref?.();
    this.emit('status');
    return this.status().pairing;
  }

  cancelPairing() {
    this.pairing = null;
    clearTimeout(this.pairTimer);
    this.emit('status');
  }

  forget(id) {
    delete this.user.data.phones[id];
    this.user.save(0);
    this.emit('status');
  }

  #hello() {
    return {
      app: 'mune-player',
      api: 1,
      id: this.user.data.pcId,
      name: this.pcName(),
      port: this.port,
      pairing: !!(this.pairing && this.pairing.expires > Date.now()),
    };
  }

  async #handle(req, res) {
    try {
      if (!isLocalAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Only phones on your local network can sync');
      const url = new URL(req.url, 'http://phone.invalid');
      if (!url.pathname.startsWith(`${API}/`)) throw new HttpError(404, 'Not found');
      const route = url.pathname.slice(API.length);
      const get = req.method === 'GET' || req.method === 'HEAD';
      if (get && route === '/hello') return sendJson(res, 200, this.#hello());
      if (req.method === 'POST' && route === '/pair') return await this.#pair(req, res);

      const phone = this.#auth(req);
      phone.lastSeen = Date.now();
      this.user.save(5000);
      let m;
      if (get && route === '/library') return sendJson(res, 200, this.#library());
      if (get && (m = /^\/file\/([a-f0-9]{12})$/.exec(route))) return await this.#file(req, res, m[1], phone);
      if (get && (m = /^\/art\/album\/([a-f0-9]{12})$/.exec(route))) {
        const art = await this.art.album(m[1], url.searchParams.get('s') || 'l');
        if (!art) throw new HttpError(404, 'No art');
        return await sendFile(req, res, art.file, art.type);
      }
      if (get && (m = /^\/art\/artist\/(.+)$/.exec(route))) {
        const art = await this.art.artist(decodeURIComponent(m[1]), url.searchParams.get('s') || 'l');
        if (!art) throw new HttpError(404, 'No photo');
        return await sendFile(req, res, art.file, art.type);
      }
      if (req.method === 'POST' && route === '/report') return await this.#report(req, res, phone);
      // The Google OAuth client set up in settings > online, so the phone can sign in to YouTube with it too.
      if (get && route === '/youtube') {
        const client = this.getYouTubeClient();
        if (!client) throw new HttpError(404, "YouTube Music isn't set up in Mune Player on this PC");
        return sendJson(res, 200, client);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[phone]', req.method, req.url, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.destroy();
    }
  }

  #auth(req) {
    const m = /^Bearer\s+([\w-]{16,})$/i.exec(req.headers.authorization || '');
    if (m) {
      const h = Buffer.from(sha256(m[1]), 'hex');
      for (const [id, p] of Object.entries(this.user.data.phones)) {
        if (p.tokenHash && crypto.timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), h)) {
          Object.defineProperty(p, 'id', { value: id, enumerable: false, configurable: true });
          return p;
        }
      }
    }
    throw new HttpError(401, "This phone isn't paired with this PC anymore");
  }

  async #pair(req, res) {
    const body = await readBody(req, 4096);
    const pairing = this.pairing;
    if (!pairing || pairing.expires < Date.now()) {
      throw new HttpError(409, 'Pairing is closed. On your PC, open Mune Player > settings > phone and choose "pair a phone".');
    }
    pairing.tries++;
    const code = String(body.code || '').replace(/\D/g, '');
    const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
    if (!ok) {
      if (pairing.tries >= MAX_TRIES) {
        this.cancelPairing();
        throw new HttpError(403, 'Too many wrong codes. Start pairing again on your PC.');
      }
      throw new HttpError(403, "That code doesn't match the one on your PC.");
    }
    const phoneId = String(body.phoneId || crypto.randomUUID()).replace(/[^\w-]/g, '').slice(0, 64) || crypto.randomUUID();
    const name = cleanName(body.phoneName, 60) || 'Android phone';
    const token = crypto.randomBytes(24).toString('base64url');
    this.user.data.phones[phoneId] = { name, tokenHash: sha256(token), paired: Date.now(), lastSeen: Date.now() };
    this.user.save(0);
    this.cancelPairing();
    this.emit('paired', { name });
    sendJson(res, 200, { token, pc: { id: this.user.data.pcId, name: this.pcName() } });
  }

  #library() {
    const { ratings, plays } = this.user.data;
    const tracks = [];
    for (const t of this.library.tracks.values()) {
      const ext = path.extname(t.path).toLowerCase();
      const native = NATIVE_EXT.has(ext);
      tracks.push({
        id: t.id,
        title: t.title,
        artist: t.artist || null,
        albumArtist: t.aa,
        album: t.album || null,
        albumId: t.albumId,
        genre: t.genre || null,
        year: t.year || null,
        track: t.track ?? null,
        disc: t.disc ?? null,
        duration: t.duration || null,
        ext: native ? ext : convertedExt(ext),
        size: native ? t.size : null,
        mtime: t.mtime,
        added: t.added,
        rating: ratings[t.id] || null,
        plays: plays[t.id] || 0,
      });
    }
    const albums = [...this.library.albums.values()].map((a) => ({
      id: a.id, title: a.title, artist: a.artist, year: a.year, genre: a.genre, trackIds: a.trackIds, art: this.art.hasAlbumArt(a.id),
    }));
    const playlists = this.playlists.list().map((p) => ({ id: p.id, name: p.name, trackIds: p.trackIds }));
    return { pc: { id: this.user.data.pcId, name: this.pcName() }, tracks, albums, playlists };
  }

  async #file(req, res, id, phone) {
    const t = this.library.tracks.get(id);
    if (!t) throw new HttpError(404, 'That song is no longer in the collection');
    const ext = path.extname(t.path).toLowerCase();
    let file = t.path;
    let type = MIME[ext] || 'application/octet-stream';
    if (!NATIVE_EXT.has(ext)) ({ file, type } = await this.#convert(t, ext));
    if (req.method === 'GET') {
      this.activity = { phone: phone.name, title: t.title, at: Date.now() };
      this.#emitActivity();
    }
    await sendMedia(req, res, file, type, { 'X-Mune-Ext': path.extname(file) });
  }

  #emitActivity() {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.emit('status');
    }, 700);
  }

  async #convert(t, ext) {
    const ffmpeg = this.getFfmpeg();
    if (!ffmpeg) throw new HttpError(415, `Sending ${ext} files to a phone needs ffmpeg on the PC`);
    const target = convertedExt(ext);
    const out = path.join(this.cacheDir, `${t.id}${target}`);
    try {
      const s = await fsp.stat(out);
      if (s.size > 0 && s.mtimeMs >= (t.mtime || 0)) return { file: out, type: MIME[target] };
    } catch {}
    if (!this.converting.has(t.id)) {
      const job = (async () => {
        await fsp.mkdir(this.cacheDir, { recursive: true });
        const tmp = `${out}.part${target}`;
        const meta = [
          ['title', t.title], ['artist', t.artist || t.aa], ['album_artist', t.aa], ['album', t.album], ['genre', t.genre],
          ['track', t.track && String(t.track)], ['disc', t.disc && String(t.disc)], ['date', t.year && String(t.year)],
        ].filter(([, v]) => v).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
        const codec = target === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3'] : ['-c:a', 'flac'];
        await run(ffmpeg, ['-y', '-v', 'error', '-i', t.path, '-map', '0:a', '-map_metadata', '-1', ...meta, ...codec, tmp]);
        await fsp.rename(tmp, out);
        return { file: out, type: MIME[target] };
      })().finally(() => this.converting.delete(t.id));
      this.converting.set(t.id, job);
    }
    return this.converting.get(t.id);
  }

  /** Plays and hearts from the phone, like a Zune's play counts flowing back after a sync. */
  async #report(req, res, phone) {
    const body = await readBody(req, 2 * 1024 * 1024);
    const d = this.user.data;
    const known = (id) => this.library.tracks.has(id);
    let plays = 0;
    for (const [id, n] of Object.entries(body.plays || {})) {
      const k = Math.floor(Number(n));
      if (!known(id) || !(k > 0) || k > 10000) continue;
      d.plays[id] = (d.plays[id] || 0) + k;
      plays += k;
    }
    for (const [id, ts] of Object.entries(body.lastPlayed || {})) {
      const v = Number(ts);
      if (known(id) && v > (d.lastPlayed[id] || 0) && v < Date.now() + 86400000) d.lastPlayed[id] = v;
    }
    const ratings = [];
    for (const [id, r] of Object.entries(body.ratings || {})) {
      if (!known(id)) continue;
      if (r === 'love' || r === 'hate') {
        if (d.ratings[id] !== r) {
          d.ratings[id] = r;
          ratings.push({ id, rating: r });
        }
      } else if (!r && d.ratings[id]) {
        delete d.ratings[id];
        ratings.push({ id, rating: null });
      }
    }
    if (body.synced) {
      phone.lastSync = Date.now();
      phone.songs = Math.max(0, Math.floor(Number(body.synced.songs) || 0));
    }
    // The phone's name can change in its settings; it comes along with each report.
    const phoneName = cleanName(body.phoneName, 60);
    if (phoneName) phone.name = phoneName;
    this.user.save();
    if (plays || ratings.length) this.emit('user', { ratings });
    if (body.synced) this.emit('synced', { name: phone.name, songs: phone.songs, added: Number(body.synced.added) || 0 });
    this.emit('status');
    sendJson(res, 200, { ok: true, plays });
  }
}
