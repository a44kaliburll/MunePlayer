// Playback: one <audio> element, a queue ("now playing" list), shuffle/repeat,
// play counting, Windows media controls and a Web Audio analyser for the glow.
import { api, mediaUrl, native } from './api.js';
import { model } from './model.js';
import { Emitter, artUrl, clamp, debounce, shuffleArray } from './util.js';

class Player extends Emitter {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.order = [];
    this.pos = -1;
    this.shuffle = false;
    this.repeat = false;
    this.volume = 0.8;
    this.muted = false;
    this.context = null;
    this.counted = false;
    this.errors = 0;
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.pendingSeek = null;
    this.saveSession = debounce(() => this.#persist(), 1500);

    const a = this.audio;
    a.addEventListener('play', () => this.#stateChanged());
    a.addEventListener('pause', () => this.#stateChanged());
    a.addEventListener('ended', () => this.next(true));
    a.addEventListener('loadedmetadata', () => {
      if (this.pendingSeek != null) {
        a.currentTime = Math.min(this.pendingSeek, a.duration || this.pendingSeek);
        this.pendingSeek = null;
      }
      this.emit('time');
    });
    a.addEventListener('timeupdate', () => this.#onTime());
    a.addEventListener('error', () => this.#onError());
    a.addEventListener('playing', () => { this.errors = 0; });

    this.#setupMediaSession();
    native?.onThumbar?.((action) => {
      if (action === 'prev') this.prev();
      else if (action === 'next') this.next();
      else this.toggle();
    });
  }

  get current() {
    const qi = this.order[this.pos];
    return qi == null ? null : model.tracks.get(this.queue[qi]) || null;
  }

  get currentQueueIndex() {
    return this.order[this.pos] ?? -1;
  }

  get playing() {
    return !!this.current && !this.audio.paused && !this.audio.ended;
  }

  get time() {
    return this.audio.currentTime || 0;
  }

  get duration() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : this.current?.duration || 0;
  }

  /** The play order as track objects (what the Now Playing list shows). */
  upcoming() {
    return this.order.map((qi) => model.tracks.get(this.queue[qi])).filter(Boolean);
  }

  playTracks(tracks, start = 0, context = null) {
    const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id)).filter((id) => model.tracks.has(id));
    if (!ids.length) return;
    start = clamp(start, 0, ids.length - 1);
    this.queue = ids;
    const rest = ids.map((_, i) => i).filter((i) => i !== start);
    this.order = this.shuffle ? [start, ...shuffleArray(rest)] : ids.map((_, i) => i);
    this.pos = this.shuffle ? 0 : start;
    this.context = context;
    if (context?.type && context?.id) model.addHistory(context.type, context.id);
    this.#load(true);
    this.emit('queue');
  }

  /** "Add to now playing". Starts playback when nothing is loaded. */
  enqueue(tracks) {
    const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id)).filter((id) => model.tracks.has(id));
    if (!ids.length) return;
    if (!this.current) return this.playTracks(ids, 0, null);
    const base = this.queue.length;
    this.queue.push(...ids);
    this.order.push(...ids.map((_, i) => base + i));
    this.emit('queue');
    this.saveSession();
  }

  playNext(tracks) {
    const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id)).filter((id) => model.tracks.has(id));
    if (!ids.length) return;
    if (!this.current) return this.playTracks(ids, 0, null);
    const base = this.queue.length;
    this.queue.push(...ids);
    this.order.splice(this.pos + 1, 0, ...ids.map((_, i) => base + i));
    this.emit('queue');
    this.saveSession();
  }

  jumpTo(orderPos) {
    if (orderPos < 0 || orderPos >= this.order.length) return;
    this.pos = orderPos;
    this.#load(true);
  }

  removeAt(orderPos) {
    if (orderPos < 0 || orderPos >= this.order.length) return;
    const wasCurrent = orderPos === this.pos;
    this.order.splice(orderPos, 1);
    if (orderPos < this.pos) this.pos--;
    if (wasCurrent) {
      if (this.pos >= this.order.length) this.pos = this.order.length - 1;
      this.#load(this.playing);
    }
    this.emit('queue');
    this.saveSession();
  }

  clearQueue() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.queue = [];
    this.order = [];
    this.pos = -1;
    this.context = null;
    this.emit('track', null);
    this.emit('queue');
    this.#stateChanged();
    this.saveSession();
  }

  toggle() {
    if (!this.current) {
      // Like Zune: pressing play with an empty queue plays the whole collection.
      if (model.trackList.length) this.playTracks(model.trackList, 0, null);
      return;
    }
    if (this.audio.paused) this.play();
    else this.pause();
  }

  play() {
    if (!this.current) return this.toggle();
    this.#ensureGraph();
    const p = this.audio.play();
    p?.catch((err) => {
      if (err.name !== 'AbortError') console.warn('play failed', err);
    });
  }

  pause() {
    this.audio.pause();
  }

  next(auto = false) {
    if (!this.order.length) return;
    if (this.pos < this.order.length - 1) {
      this.pos++;
    } else if (this.repeat) {
      if (this.shuffle) this.order = shuffleArray(this.order);
      this.pos = 0;
    } else {
      if (auto) {
        // End of the list: stop on the last song, rewound.
        this.audio.pause();
        this.audio.currentTime = 0;
        this.#stateChanged();
      }
      return;
    }
    this.#load(true);
  }

  prev() {
    if (!this.order.length) return;
    if (this.audio.currentTime > 3 || this.pos <= 0) {
      if (this.pos <= 0 && this.repeat && this.audio.currentTime <= 3 && this.order.length > 1) {
        this.pos = this.order.length - 1;
        return this.#load(true);
      }
      this.audio.currentTime = 0;
      return;
    }
    this.pos--;
    this.#load(true);
  }

  seek(seconds) {
    if (!this.current) return;
    const d = this.duration;
    this.audio.currentTime = clamp(seconds, 0, d ? d - 0.25 : seconds);
    this.emit('time');
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.audio.volume = this.volume;
    if (this.muted && v > 0) this.setMuted(false);
    this.emit('volume');
    this.saveSession();
  }

  setMuted(m) {
    this.muted = !!m;
    this.audio.muted = this.muted;
    this.emit('volume');
    this.saveSession();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    const qi = this.order[this.pos];
    if (qi != null) {
      if (this.shuffle) {
        this.order = [qi, ...shuffleArray(this.queue.map((_, i) => i).filter((i) => i !== qi))];
        this.pos = 0;
      } else {
        this.order = this.queue.map((_, i) => i);
        this.pos = qi;
      }
    }
    this.emit('mode');
    this.emit('queue');
    this.saveSession();
  }

  setRepeat(on) {
    this.repeat = !!on;
    this.emit('mode');
    this.saveSession();
  }

  /** Frequency data for the visualiser glow (null until audio has played). */
  levels() {
    if (!this.analyser || this.audio.paused) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  restore(session) {
    if (!session) return;
    this.volume = clamp(session.volume ?? 0.8, 0, 1);
    this.muted = !!session.muted;
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;
    this.shuffle = !!session.shuffle;
    this.repeat = !!session.repeat;
    const keep = (session.queue || []).map((id, i) => [id, i]).filter(([id]) => model.tracks.has(id));
    if (keep.length) {
      const remap = new Map(keep.map(([, oldIdx], newIdx) => [oldIdx, newIdx]));
      this.queue = keep.map(([id]) => id);
      this.order = (session.order || []).map((i) => remap.get(i)).filter((i) => i != null);
      if (this.order.length !== this.queue.length) this.order = this.queue.map((_, i) => i);
      const curOld = session.order?.[session.pos];
      const curNew = remap.get(curOld);
      this.pos = curNew != null ? this.order.indexOf(curNew) : 0;
      if (this.pos < 0) this.pos = 0;
      this.context = session.context || null;
      if (model.user.settings.resume !== false) this.pendingSeek = session.time || 0;
      this.#load(false);
    }
    this.emit('volume');
    this.emit('mode');
    this.emit('queue');
  }

  // ---------------------------------------------------------------- internals
  #load(autoplay) {
    const t = this.current;
    if (!t) return;
    this.counted = false;
    this.audio.src = mediaUrl(t.id);
    if (autoplay) this.play();
    this.emit('track', t);
    this.#updateMediaSession(t);
    this.saveSession();
  }

  #ensureGraph() {
    if (this.analyser) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.82;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    } catch (err) {
      console.warn('audio graph unavailable', err);
    }
  }

  #onTime() {
    const t = this.current;
    if (t && !this.counted) {
      const d = this.duration;
      if (d && this.audio.currentTime >= Math.min(d * 0.5, 240)) {
        this.counted = true;
        model.countPlay(t.id);
      }
    }
    this.emit('time');
    if ('mediaSession' in navigator && this.duration && Math.floor(this.audio.currentTime) % 5 === 0) {
      try {
        navigator.mediaSession.setPositionState({ duration: this.duration, position: Math.min(this.audio.currentTime, this.duration), playbackRate: 1 });
      } catch {}
    }
    if (!this.audio.paused && Math.floor(this.audio.currentTime) % 10 === 0) this.saveSession();
  }

  #onError() {
    const t = this.current;
    if (!t || !this.audio.src) return;
    this.errors++;
    this.emit('error', { track: t, message: this.audio.error?.message || 'unsupported or missing file' });
    if (this.errors < Math.min(this.order.length, 8) && this.pos < this.order.length - 1) {
      setTimeout(() => this.next(true), 1200);
    }
  }

  #stateChanged() {
    this.emit('state', this.playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.current ? (this.playing ? 'playing' : 'paused') : 'none';
    native?.setThumbar?.({ playing: this.playing, hasTrack: !!this.current });
    this.saveSession();
  }

  #setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {}
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (e) => this.seek(e.seekTime));
    set('seekbackward', (e) => this.seek(this.time - (e.seekOffset || 10)));
    set('seekforward', (e) => this.seek(this.time + (e.seekOffset || 10)));
  }

  #updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist || t.aa,
        album: t.album || '',
        artwork: [{ src: new URL(artUrl(t.albumId, 'l', model.artVersion(t.albumId)), location.href).href, sizes: '800x800', type: 'image/jpeg' }],
      });
    } catch {}
  }

  #persist() {
    api('session', {
      queue: this.queue,
      order: this.order,
      pos: this.pos,
      time: Math.round((this.audio.currentTime || 0) * 10) / 10,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      muted: this.muted,
      context: this.context,
    }).catch(() => {});
  }
}

export const player = new Player();
