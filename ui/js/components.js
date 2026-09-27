// Reusable UI pieces: virtualised lists/grids, context menus, dialogs, toasts, drag & drop.
import { $, esc, icons } from './util.js';

// ---------------------------------------------------------------- virtual list / grid
/**
 * Renders only the rows (or grid rows) in view. `render(item, i)` returns an element;
 * `update(el, item, i)` refreshes state classes on an element that stays mounted.
 */
export class Virtual {
  constructor(scroller, { itemHeight, itemWidth = 0, gapX = 0, gapY = 0, overscan = 4, render, update }) {
    this.scroller = scroller;
    this.opts = { itemHeight, itemWidth, gapX, gapY, overscan };
    this.render = render;
    this.update = update || (() => {});
    this.items = [];
    this.mounted = new Map();
    this.inner = document.createElement('div');
    this.inner.className = 'vinner';
    scroller.appendChild(this.inner);
    this.cols = 1;
    this.onScroll = () => this.#paint();
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.#layout());
    this.ro.observe(scroller);
  }

  destroy() {
    this.ro.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
  }

  setItems(items, { keepScroll = false } = {}) {
    this.items = items;
    for (const node of this.mounted.values()) node.remove();
    this.mounted.clear();
    if (!keepScroll) this.scroller.scrollTop = 0;
    this.#layout();
  }

  /** Re-apply state (selection, now playing) to mounted elements. */
  refresh() {
    for (const [i, node] of this.mounted) this.update(node, this.items[i], i);
  }

  /** Throw away mounted rows and render them again (content changed). */
  rerender() {
    for (const node of this.mounted.values()) node.remove();
    this.mounted.clear();
    this.#paint();
  }

  scrollToIndex(i) {
    const { itemHeight, gapY } = this.opts;
    const rowH = itemHeight + gapY;
    const row = Math.floor(i / this.cols);
    const top = row * rowH;
    const view = this.scroller.clientHeight;
    const cur = this.scroller.scrollTop;
    if (top < cur) this.scroller.scrollTop = top;
    else if (top + rowH > cur + view - 40) this.scroller.scrollTop = top + rowH - view + 40;
  }

  indexOf(node) {
    const host = node?.closest?.('[data-i]');
    return host && this.inner.contains(host) ? Number(host.dataset.i) : -1;
  }

  #layout() {
    const { itemHeight, itemWidth, gapX, gapY } = this.opts;
    const width = this.scroller.clientWidth;
    const cols = itemWidth ? Math.max(1, Math.floor((width + gapX) / (itemWidth + gapX))) : 1;
    const rows = Math.ceil(this.items.length / cols);
    this.inner.style.height = `${Math.max(0, rows * (itemHeight + gapY) - gapY)}px`;
    // Only re-place mounted nodes when the column count changes; otherwise keep them
    // (replacing a row between mousedown and mouseup would swallow the click).
    if (cols !== this.cols) {
      this.cols = cols;
      for (const node of this.mounted.values()) node.remove();
      this.mounted.clear();
    }
    this.#paint();
  }

  #paint() {
    const { itemHeight, itemWidth, gapX, gapY, overscan } = this.opts;
    const rowH = itemHeight + gapY;
    const top = this.scroller.scrollTop;
    const view = this.scroller.clientHeight || 600;
    const firstRow = Math.max(0, Math.floor(top / rowH) - overscan);
    const lastRow = Math.floor((top + view) / rowH) + overscan;
    const from = firstRow * this.cols;
    const to = Math.min(this.items.length, (lastRow + 1) * this.cols);
    for (const [i, node] of this.mounted) {
      if (i < from || i >= to) {
        node.remove();
        this.mounted.delete(i);
      }
    }
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      if (this.mounted.has(i)) continue;
      const node = this.render(this.items[i], i);
      this.update(node, this.items[i], i);
      node.dataset.i = i;
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      node.style.top = `${row * rowH}px`;
      if (itemWidth) {
        node.style.left = `${col * (itemWidth + gapX)}px`;
        node.style.right = 'auto';
        node.style.width = `${itemWidth}px`;
      }
      this.mounted.set(i, node);
      frag.appendChild(node);
    }
    this.inner.appendChild(frag);
  }
}

/** Multi-select behaviour for lists: click, ctrl+click, shift+click, ctrl+A. */
export class Selection {
  constructor(onChange) {
    this.set = new Set();
    this.anchor = -1; // where shift-selection ranges start
    this.focus = -1; // the row the keyboard is on
    this.onChange = onChange;
  }
  clear(silent) {
    this.set.clear();
    this.anchor = -1;
    this.focus = -1;
    if (!silent) this.onChange();
  }
  has(i) {
    return this.set.has(i);
  }
  click(i, e) {
    if (e?.shiftKey && this.anchor >= 0) {
      if (!e.ctrlKey) this.set.clear();
      const [a, b] = this.anchor < i ? [this.anchor, i] : [i, this.anchor];
      for (let k = a; k <= b; k++) this.set.add(k);
    } else if (e?.ctrlKey || e?.metaKey) {
      if (this.set.has(i)) this.set.delete(i);
      else this.set.add(i);
      this.anchor = i;
    } else {
      this.set.clear();
      this.set.add(i);
      this.anchor = i;
    }
    this.focus = i;
    this.onChange();
  }
  /** Right-click keeps an existing multi-selection when clicking inside it. */
  context(i) {
    if (!this.set.has(i)) {
      this.set.clear();
      this.set.add(i);
      this.anchor = i;
      this.focus = i;
      this.onChange();
    }
  }
  all(n) {
    this.set = new Set(Array.from({ length: n }, (_, i) => i));
    this.onChange();
  }
  indices() {
    return [...this.set].sort((a, b) => a - b);
  }
}

// ---------------------------------------------------------------- context menu
let menuClose = null;

export function closeMenu() {
  if (menuClose) menuClose();
}

/**
 * items: [{ label, action, disabled, checked, submenu: items|() => items }, '-' ...]
 */
export function showMenu(x, y, items, { className = '' } = {}) {
  closeMenu();
  const root = $('#menu');
  const subs = [];
  const build = (host, list) => {
    host.innerHTML = '';
    for (const item of list) {
      if (!item) continue;
      if (item === '-') {
        host.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>');
        continue;
      }
      const row = document.createElement('div');
      row.className = `menu-item${item.disabled ? ' disabled' : ''}`;
      row.innerHTML = `${item.checked ? '<span class="check">●</span>' : ''}${esc(item.label)}${item.submenu ? `<span class="chev">${icons.chevron}</span>` : ''}`;
      if (item.submenu && !item.disabled) {
        row.addEventListener('mouseenter', () => {
          for (const s of subs.splice(0)) s.remove();
          host.querySelectorAll('.hot').forEach((n) => n.classList.remove('hot'));
          row.classList.add('hot');
          const sub = document.createElement('div');
          sub.className = 'submenu';
          document.body.appendChild(sub);
          subs.push(sub);
          build(sub, typeof item.submenu === 'function' ? item.submenu() : item.submenu);
          const r = row.getBoundingClientRect();
          place(sub, r.right - 2, r.top - 5, r.left);
        });
      } else {
        row.addEventListener('mouseenter', () => {
          if (host === root) {
            for (const s of subs.splice(0)) s.remove();
            host.querySelectorAll('.hot').forEach((n) => n.classList.remove('hot'));
          }
        });
        if (!item.disabled) {
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            item.action?.();
          });
        }
      }
      host.appendChild(row);
    }
  };
  const place = (node, px, py, altX) => {
    node.style.left = '0px';
    node.style.top = '0px';
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let left = px;
    if (left + w > innerWidth - 4) left = altX != null ? altX - w + 2 : innerWidth - w - 4;
    let top = py;
    if (top + h > innerHeight - 4) top = Math.max(4, innerHeight - h - 4);
    node.style.left = `${Math.max(4, left)}px`;
    node.style.top = `${top}px`;
  };
  root.className = className;
  build(root, items);
  root.hidden = false;
  place(root, x, y);
  const onDown = (e) => {
    if (root.contains(e.target) || subs.some((s) => s.contains(e.target))) return;
    closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  });
  menuClose = () => {
    root.hidden = true;
    for (const s of subs.splice(0)) s.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closeMenu);
    menuClose = null;
  };
}

// ---------------------------------------------------------------- dialogs
export function modal(html, { onOpen } = {}) {
  const host = $('#modal');
  host.innerHTML = `<div class="dialog" role="dialog">${html}</div>`;
  host.hidden = false;
  return new Promise((resolve) => {
    const close = (value) => {
      host.hidden = true;
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    host.onclick = (e) => {
      if (e.target === host) close(null);
      const btn = e.target.closest('[data-result]');
      if (!btn) return;
      if (btn.dataset.result !== 'ok') return close(null);
      close(onOpen?.value ? onOpen.value() : true);
    };
    onOpen?.(host.firstElementChild, close);
  });
}

export function prompt(title, { value = '', okLabel = 'ok', placeholder = '' } = {}) {
  let input;
  const opener = (dlg, close) => {
    input = dlg.querySelector('input');
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim() || null);
    });
  };
  opener.value = () => input.value.trim() || null;
  return modal(`
    <h2>${esc(title)}</h2>
    <input type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="120">
    <div class="buttons"><button class="zbtn primary" data-result="ok">${esc(okLabel)}</button><button class="zbtn" data-result="cancel">cancel</button></div>
  `, { onOpen: opener });
}

export function confirm(title, message, okLabel = 'ok') {
  return modal(`
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <div class="buttons"><button class="zbtn primary" data-result="ok">${esc(okLabel)}</button><button class="zbtn" data-result="cancel">cancel</button></div>
  `);
}

// ---------------------------------------------------------------- toast
let toastTimer;
export function toast(message, ms = 2600) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}

// ---------------------------------------------------------------- drag and drop
const DND_TYPE = 'application/x-mune-tracks';
let dragPayload = null;

/** Start dragging a set of track ids (with a small "N songs" drag image). */
export function startDrag(e, trackIds, label) {
  dragPayload = { trackIds };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(trackIds));
  e.dataTransfer.setData('text/plain', label);
  const ghost = document.createElement('div');
  ghost.textContent = label;
  ghost.style.cssText = 'position:fixed;top:-100px;left:0;padding:4px 10px;background:#f00097;color:#fff;font:600 11px Segoe UI;text-transform:uppercase;white-space:nowrap';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, -12, -8);
  setTimeout(() => ghost.remove(), 0);
  document.body.classList.add('dragging');
}

export function endDrag() {
  dragPayload = null;
  document.body.classList.remove('dragging');
}

export const isTrackDrag = (e) => e.dataTransfer?.types?.includes(DND_TYPE);

export function droppedTracks(e) {
  try {
    return JSON.parse(e.dataTransfer.getData(DND_TYPE));
  } catch {
    return dragPayload?.trackIds || [];
  }
}

document.addEventListener('dragend', endDrag);
document.addEventListener('drop', () => setTimeout(endDrag));
