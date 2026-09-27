// Small DOM, formatting and icon helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Build an element from an HTML string. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Zune sorted "The Killers" under K. */
export const sortName = (s) => String(s || '').replace(/^\s*the\s+/i, '').replace(/^[^\p{L}\p{N}]+/u, '');

export const byName = (get) => (a, b) => collator.compare(sortName(get(a)), sortName(get(b)));

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function fmtDuration(sec) {
  const mins = Math.round((sec || 0) / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} min` : ''}`;
}

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const pad2 = (n) => (n == null ? '' : String(n).padStart(2, '0'));

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttleFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Tiny event bus. */
export class Emitter {
  #h = new Map();
  on(evt, fn) {
    if (!this.#h.has(evt)) this.#h.set(evt, new Set());
    this.#h.get(evt).add(fn);
    return () => this.#h.get(evt)?.delete(fn);
  }
  emit(evt, data) {
    for (const fn of this.#h.get(evt) || []) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[${evt}]`, err);
      }
    }
  }
}

// ---------------------------------------------------------------- icons
// Thin outline glyphs in the spirit of Zune's 1px icons; all use currentColor.
const svg = (vb, body, extra = '') => `<svg viewBox="${vb}" ${extra} fill="none" stroke="currentColor" aria-hidden="true">${body}</svg>`;

export const icons = {
  back: svg('0 0 17 17', '<circle cx="8.5" cy="8.5" r="7.7" stroke-width="1.15"/><path d="M12.2 8.5H5.1M8 5.5 5 8.5l3 3" stroke-width="1.3" stroke-linejoin="round"/>'),
  backBig: svg('0 0 26 26', '<circle cx="13" cy="13" r="12" stroke-width="1.6"/><path d="M18.5 13H7.8M12.3 8.3 7.6 13l4.7 4.7" stroke-width="1.8" stroke-linejoin="round"/>'),
  device: svg('0 0 26 26', '<rect x="8" y="2.5" width="10" height="21" rx="1.8" stroke-width="1.1"/><path d="M11.5 20.5h3" stroke-width="1.1"/>'),
  disc: svg('0 0 26 26', '<circle cx="13" cy="13" r="10.5" stroke-width="1.1"/><circle cx="13" cy="13" r="3.2" stroke-width="1.1"/>'),
  playlist: svg('0 0 26 26', '<path d="M7 2.5h9l4 4v17H7z" stroke-width="1.1" stroke-linejoin="round"/><path d="M16 2.5v4h4M10 11h7M10 14h7M10 17h7M10 20h5" stroke-width="1"/>'),
  heart: '<svg viewBox="0 0 10 9" aria-hidden="true"><path fill="currentColor" d="M5 8.7.95 4.9A2.55 2.55 0 0 1 4.6 1.25L5 1.65l.4-.4A2.55 2.55 0 0 1 9.05 4.9z"/></svg>',
  heartOutline: '<svg viewBox="0 0 10 9" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width=".9" d="M5 8.1 1.3 4.6A2.1 2.1 0 0 1 4.3 1.6L5 2.3l.7-.7a2.1 2.1 0 0 1 3 3z"/></svg>',
  heartBroken: '<svg viewBox="0 0 10 9" aria-hidden="true"><path fill="currentColor" d="M4.55 8.3.95 4.9A2.55 2.55 0 0 1 4.6 1.25l.2.2L4 3.4l1.3 1.3-.75 3.6zM5.6 8.1l.8-3.4-1.2-1.3.9-2.1A2.55 2.55 0 0 1 9.05 4.9z"/></svg>',
  repeat: svg('0 0 12 12', '<path d="M10.2 6.1A4.2 4.2 0 1 1 8.9 3" stroke-width="1.2"/><path d="M9.6 1v2.6H7" stroke-width="1.2" stroke-linejoin="round"/>'),
  shuffle: svg('0 0 12 12', '<path d="M1 3.2h2.4l5 5.6H10.6M1 8.8h2.4l1.5-1.7M6.9 4.9l1.5-1.7h2.2" stroke-width="1.15"/><path d="m9.4 1.9 1.4 1.3-1.4 1.3M9.4 7.5l1.4 1.3-1.4 1.3" stroke-width="1.1"/>'),
  prev: '<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.2" fill="none" stroke="currentColor" stroke-width="1.05"/><path fill="currentColor" d="M8.7 9 12 6.6v4.8zM5.3 9l3.3-2.4v4.8z"/></svg>',
  next: '<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8.2" fill="none" stroke="currentColor" stroke-width="1.05"/><path fill="currentColor" d="M9.3 9 6 6.6v4.8zM12.7 9 9.4 6.6v4.8z"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path fill="currentColor" d="M9.6 7.4v9.2l7.2-4.6z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path fill="currentColor" d="M8.6 7.6h2.4v8.8H8.6zM13 7.6h2.4v8.8H13z"/></svg>',
  playTile: '<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="rgba(0,0,0,.35)" stroke="currentColor" stroke-width="1.3"/><path fill="currentColor" d="M9 6.8v8.4l6.3-4.2z"/></svg>',
  bars: '<svg viewBox="0 0 14 12" aria-hidden="true"><path fill="currentColor" d="M0 6h2.6v6H0zM3.8 0h2.6v12H3.8zM7.6 4h2.6v8H7.6zM11.4 2H14v10h-2.6z"/></svg>',
  eq: '<svg viewBox="0 0 13 11" aria-hidden="true"><path fill="currentColor" d="M0 5h2.4v6H0zM3.5 1h2.4v10H3.5zM7 3.5h2.4V11H7zM10.5 6h2.4v5h-2.4z"/></svg>',
  volume: '<svg viewBox="0 0 11 9" aria-hidden="true"><path fill="currentColor" d="M0 3h2.2L5 .6v7.8L2.2 6H0z"/><path fill="none" stroke="currentColor" stroke-width=".9" d="M6.6 2.6a2.6 2.6 0 0 1 0 3.8M8.2 1.2a4.6 4.6 0 0 1 0 6.6"/></svg>',
  mute: '<svg viewBox="0 0 11 9" aria-hidden="true"><path fill="currentColor" d="M0 3h2.2L5 .6v7.8L2.2 6H0z"/><path fill="none" stroke="currentColor" stroke-width="1" d="m6.6 3 3 3m0-3-3 3"/></svg>',
  search: svg('0 0 11 11', '<circle cx="4.5" cy="4.5" r="3.7" stroke-width="1.2"/><path d="m7.2 7.2 3.2 3.2" stroke-width="1.4"/>'),
  compact: svg('0 0 9 9', '<rect x=".6" y="4.6" width="7.8" height="3.8" stroke-width="1"/><path d="M2 2.4h5" stroke-width="1"/>'),
  minimize: svg('0 0 9 9', '<path d="M.5 7.5h8" stroke-width="1.2"/>'),
  maximize: svg('0 0 9 9', '<rect x=".6" y=".6" width="7.8" height="7.8" stroke-width="1.1"/>'),
  restore: svg('0 0 9 9', '<rect x=".6" y="2.6" width="5.8" height="5.8" stroke-width="1"/><path d="M2.6 2.4V.6h5.8v5.8H6.6" stroke-width="1"/>'),
  close: svg('0 0 9 9', '<path d="m1 1 7 7M8 1 1 8" stroke-width="1.2"/>'),
  expand: svg('0 0 9 9', '<path d="M1 3.5V1h2.5M8 5.5V8H5.5M1 1l3 3M8 8 5 5" stroke-width="1"/>'),
  info: svg('0 0 22 22', '<circle cx="11" cy="11" r="10.2" stroke-width="1.2"/><path d="M11 9.6v6" stroke-width="1.6"/><circle cx="11" cy="6.7" r=".5" fill="currentColor" stroke-width="1.2"/>'),
  heartRing: '<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path fill="currentColor" d="M11 15.9 7.1 12.3a2.45 2.45 0 0 1 3.5-3.5l.4.4.4-.4a2.45 2.45 0 0 1 3.5 3.5z"/></svg>',
  heartBrokenRing: '<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path fill="currentColor" d="M10.5 15.7 7.1 12.3a2.45 2.45 0 0 1 3.5-3.5l.2.2-.8 1.9 1.3 1.3zM11.6 15.5l.8-3.3-1.2-1.3.9-2.1a2.45 2.45 0 0 1 3.5 3.5z"/></svg>',
  chevron: svg('0 0 6 10', '<path d="m1 1 4 4-4 4" stroke-width="1.2"/>'),
  person: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.6" fill="#fff"/><path fill="#fff" d="M3.2 18.5c.6-3.9 3.3-6 6.8-6s6.2 2.1 6.8 6z"/></svg>',
  goCollection: svg('0 0 42 42', '<circle cx="21" cy="21" r="19.5" stroke-width="1.4"/><path d="M13 16h16M13 21h16M13 26h10" stroke-width="2.2" stroke="currentColor"/><path d="M7 7v8M3 11h8" stroke-width="1.6"/>'),
};

/** Image URL helpers (art is cached server-side; `v` busts the browser cache when art changes). */
export const artUrl = (albumId, size = 'm', v = 0) => `/art/album/${albumId}?s=${size}${v ? `&v=${v}` : ''}`;
// Apostrophes are escaped too: these URLs go inside CSS url('...') ("Guns N' Roses").
export const artistPhotoUrl = (name) => `/art/artist/${encodeURIComponent(name).replace(/'/g, '%27')}?s=l`;
