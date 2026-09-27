// YouTube Music through YouTube's official APIs (settings > online > youtube music).
//
// Nothing is built in: each person makes their own Google Cloud OAuth client of the type
// "TVs and Limited Input devices" and signs in with Google's device flow (Zoon shows a code,
// they approve it at google.com/device). Zoon searches YouTube and reads their playlists and
// liked songs with the YouTube Data API; songs play in YouTube's embedded player, with video,
// in the UI. Nothing is downloaded, and only the sign-in is kept (encrypted in the desktop app).
import { EventEmitter } from 'node:events';
import { HttpError } from './http.js';
import { JsonStore } from './store.js';

// Overridable so tests can point Zoon at a stand-in server.
const OAUTH = process.env.ZOON_GOOGLE_OAUTH || 'https://oauth2.googleapis.com';
const API = process.env.ZOON_YOUTUBE_API || 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const MUSIC = '10'; // YouTube's Music video category
const MAX_ITEMS = 200;
const MAX_PAGES = 20;

/** "PT1H2M3S" -> 3723 */
export function isoSeconds(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d || '');
  return m ? (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0) : null;
}

/** "Queen - Topic" (YouTube Music's automatic artist channels) -> "Queen". */
const artistOf = (channel) => String(channel || '').replace(/ - Topic$/, '');
const thumbOf = (t) => (t?.medium || t?.high || t?.default)?.url || null;

const toItem = (v) => ({
  id: v.id,
  title: v.snippet?.title || '',
  artist: artistOf(v.snippet?.channelTitle),
  thumb: thumbOf(v.snippet?.thumbnails),
  duration: isoSeconds(v.contentDetails?.duration),
});

/** fetch with a timeout; a failed connection becomes a 502 without an OAuth error code (sign-in polling retries those). */
async function send(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new HttpError(502, "Couldn't reach Google. Check the internet connection.");
  }
}

/** Google's OAuth error codes as sentences. */
function oauthMessage(body, status) {
  switch (body.error) {
    case 'invalid_client':
    case 'unauthorized_client':
      return "Google doesn't recognise that client. Check the client ID and secret, and that the client's type is \"TVs and Limited Input devices\".";
    case 'access_denied':
      return 'Sign-in was cancelled on the Google page.';
    case 'expired_token':
      return 'The sign-in code expired. Try again.';
    case 'invalid_scope':
      return 'Google refused the YouTube permission. Is the YouTube Data API v3 enabled in your Google Cloud project?';
    default:
      return body.error_description || body.error || `Google answered ${status}`;
  }
}

export class YouTube extends EventEmitter {
  /** protect/unprotect encrypt the sign-in at rest (Electron safeStorage); without them it's stored as is. */
  constructor({ file, protect = null, unprotect = null }) {
    super();
    this.store = new JsonStore(file, { clientId: null, clientSecret: null, refresh: null, channel: null });
    this.store.load();
    this.protect = protect;
    this.unprotect = unprotect;
    this.access = null; // { token, expires }
    this.signin = null; // { deviceCode, userCode, url, expires, interval }
    this.pollTimer = null;
    this.error = null;
  }

  status() {
    const d = this.store.data;
    const s = this.signin && this.signin.expires > Date.now() ? this.signin : null;
    return {
      configured: !!(d.clientId && d.clientSecret),
      clientId: d.clientId,
      signedIn: !!d.refresh,
      channel: d.channel,
      signin: s && { code: s.userCode, url: s.url, expires: s.expires },
      error: this.error,
    };
  }

  /** The client this PC uses, so a paired phone can sign in with it too (installed-app secrets aren't confidential). */
  client() {
    const { clientId, clientSecret } = this.store.data;
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  configure({ clientId, clientSecret }) {
    const id = String(clientId || '').trim();
    const secret = String(clientSecret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new HttpError(400, 'That isn\'t a Google OAuth client ID (they end in ".apps.googleusercontent.com").');
    if (!secret || /\s/.test(secret)) throw new HttpError(400, 'Paste the client secret as well.');
    const d = this.store.data;
    if (d.clientId !== id) this.#forget();
    d.clientId = id;
    d.clientSecret = secret;
    this.error = null;
    this.store.save(0);
    this.emit('status');
  }

  removeClient() {
    this.signOut();
    this.store.data.clientId = null;
    this.store.data.clientSecret = null;
    this.store.save(0);
    this.emit('status');
  }

  // ------------------------------------------------------------ sign-in (device flow)
  async startSignIn() {
    const d = this.store.data;
    if (!d.clientId || !d.clientSecret) throw new HttpError(409, 'Add your Google OAuth client first.');
    this.cancelSignIn();
    const r = await this.#form('device/code', { client_id: d.clientId, scope: SCOPE });
    this.signin = {
      deviceCode: r.device_code,
      userCode: r.user_code,
      url: r.verification_url || r.verification_uri,
      expires: Date.now() + (Number(r.expires_in) || 1800) * 1000,
      interval: Math.max(5, Number(r.interval) || 5),
    };
    this.error = null;
    this.#poll(this.signin.interval * 1000);
    this.emit('status');
    return this.status().signin;
  }

  cancelSignIn() {
    clearTimeout(this.pollTimer);
    if (!this.signin) return;
    this.signin = null;
    this.emit('status');
  }

  #poll(delay) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.#check(), delay);
    this.pollTimer.unref?.();
  }

  async #check() {
    const s = this.signin;
    if (!s) return;
    if (s.expires < Date.now()) {
      this.signin = null;
      this.error = 'The sign-in code expired. Try again.';
      return this.emit('status');
    }
    const d = this.store.data;
    try {
      const t = await this.#form('token', {
        client_id: d.clientId, client_secret: d.clientSecret, device_code: s.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (this.signin !== s) return;
      this.signin = null;
      this.#keep(t);
      d.channel = await this.#channel().catch(() => null);
      this.store.save(0);
      this.emit('status');
    } catch (err) {
      if (this.signin !== s) return;
      if (err.code === 'authorization_pending' || !err.code) return this.#poll(s.interval * 1000); // no code = network hiccup
      if (err.code === 'slow_down') {
        s.interval += 5;
        return this.#poll(s.interval * 1000);
      }
      this.signin = null;
      this.error = err.message;
      this.emit('status');
    }
  }

  signOut() {
    const refresh = this.#unseal(this.store.data.refresh);
    this.cancelSignIn();
    this.#forget();
    this.error = null;
    this.store.save(0);
    this.emit('status');
    if (refresh) {
      fetch(`${OAUTH}/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }), signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
  }

  #forget() {
    this.store.data.refresh = null;
    this.store.data.channel = null;
    this.access = null;
  }

  async #form(endpoint, params) {
    const res = await send(`${OAUTH}/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const err = new HttpError(res.status === 428 || res.status === 403 ? 409 : 502, oauthMessage(body, res.status));
    err.code = body.error || body.error_code || `http_${res.status}`;
    throw err;
  }

  #keep(t) {
    this.access = { token: t.access_token, expires: Date.now() + (Math.max(120, Number(t.expires_in) || 3600) - 60) * 1000 };
    if (t.refresh_token) {
      const sealed = this.protect?.(t.refresh_token);
      this.store.data.refresh = sealed ? { enc: sealed } : { plain: t.refresh_token };
    }
  }

  #unseal(r) {
    if (!r) return null;
    if (r.plain) return r.plain;
    try {
      return this.unprotect?.(r.enc) || null;
    } catch {
      return null;
    }
  }

  async #token() {
    if (this.access && this.access.expires > Date.now()) return this.access.token;
    const d = this.store.data;
    const refresh = this.#unseal(d.refresh);
    if (!refresh) throw new HttpError(401, 'Sign in to YouTube Music first (settings > online).');
    try {
      this.#keep(await this.#form('token', { client_id: d.clientId, client_secret: d.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }));
      return this.access.token;
    } catch (err) {
      if (err.code === 'invalid_grant' || err.code === 'invalid_client') {
        this.#forget();
        this.store.save(0);
        this.error = 'Google signed Zoon out of YouTube (the sign-in expired or was removed). Sign in again.';
        this.emit('status');
        throw new HttpError(401, this.error);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ YouTube Data API
  async #get(resource, params) {
    const url = `${API}/${resource}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await send(url, { headers: { Authorization: `Bearer ${await this.#token()}`, Accept: 'application/json' } });
      if (res.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      const reason = body.error?.errors?.[0]?.reason;
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        throw new HttpError(429, "Your Google project has used up today's YouTube quota. It resets at midnight Pacific time.");
      }
      if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
        throw new HttpError(502, 'The YouTube Data API v3 isn\'t enabled in your Google Cloud project.');
      }
      throw new HttpError(502, `YouTube answered: ${body.error?.message || res.status}`);
    }
  }

  async #pages(resource, params, take) {
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.#get(resource, { ...params, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
      if (take(r.items || []) >= MAX_ITEMS || !(pageToken = r.nextPageToken)) return;
    }
  }

  async #channel() {
    const c = (await this.#get('channels', { part: 'snippet', mine: 'true' })).items?.[0];
    return c ? { id: c.id, title: c.snippet?.title || '' } : null;
  }

  /** Full details (for durations) in the order given; videos that are gone or can't be embedded drop out. */
  async #videos(ids) {
    const found = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.#get('videos', { part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
      for (const v of r.items || []) if (v.status?.embeddable !== false) found.set(v.id, v);
    }
    return ids.map((id) => found.get(id)).filter(Boolean).map(toItem);
  }

  /** Costs 100 of the project's 10,000 daily quota units; everything else here costs 1 per page. */
  async search(q) {
    const query = String(q || '').trim().slice(0, 200);
    if (!query) return { items: [] };
    const r = await this.#get('search', { part: 'snippet', q: query, type: 'video', videoCategoryId: MUSIC, videoEmbeddable: 'true', maxResults: '25' });
    return { items: await this.#videos((r.items || []).map((i) => i.id?.videoId).filter(Boolean)) };
  }

  async playlists() {
    const items = [];
    await this.#pages('playlists', { part: 'snippet,contentDetails', mine: 'true' }, (page) => {
      for (const p of page) items.push({ id: p.id, title: p.snippet?.title || '', count: p.contentDetails?.itemCount ?? null, thumb: thumbOf(p.snippet?.thumbnails) });
      return items.length;
    });
    return { items };
  }

  async playlist(id) {
    if (!/^[\w-]{2,64}$/.test(id)) throw new HttpError(400, 'Bad playlist id');
    const ids = [];
    await this.#pages('playlistItems', { part: 'contentDetails', playlistId: id }, (page) => {
      for (const it of page) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      return ids.length;
    });
    return { items: await this.#videos(ids.slice(0, MAX_ITEMS)) };
  }

  /** Liked videos in YouTube's Music category (likes in YouTube Music land there too). */
  async liked() {
    const items = [];
    await this.#pages('videos', { part: 'snippet,contentDetails,status', myRating: 'like' }, (page) => {
      for (const v of page) if (v.snippet?.categoryId === MUSIC && v.status?.embeddable !== false) items.push(toItem(v));
      return items.length;
    });
    return { items: items.slice(0, MAX_ITEMS) };
  }
}
