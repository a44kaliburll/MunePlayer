// mixview: an artist in the middle, their albums around it, and related artists
// on the outer ring. Click anything to re-centre on it; double-click to play.
import { api } from '../api.js';
import { playItem, startSmartDJ } from '../actions.js';
import { showMenu, toast } from '../components.js';
import { model } from '../model.js';
import { artUrl, artistPhotoUrl, esc, icons } from '../util.js';

const norm = (s) => String(s || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export class Mixview {
  constructor(host, { onClose, winButtons = '' }) {
    this.host = host;
    this.onClose = onClose;
    this.winButtons = winButtons;
    this.open = false;
    this.focus = null; // { name, artistId|null }
    this.trail = [];
    this.token = 0;
  }

  show(artistName) {
    if (!artistName) return;
    if (!this.open) {
      this.open = true;
      document.body.classList.add('mix-open');
      this.host.hidden = false;
      this.host.innerHTML = `
        <div class="mix-bg"></div>
        <svg class="mix-lines"></svg>
        <div class="mix-items"></div>
        <button class="np-back mix-back" title="Back (Esc)">${icons.backBig}</button>
        <div class="mix-title"><span>mixview</span><b></b></div>
        <div class="mix-hint">click to explore · double-click to play · right-click for more</div>
        <div class="mix-top">${this.winButtons}</div>`;
      this.host.querySelector('.mix-back').onclick = () => this.back();
      this.#wire();
      this.ro = new ResizeObserver(() => this.#layout());
      this.ro.observe(this.host);
    }
    if (this.focus) this.trail.push(this.focus.name);
    this.#load(artistName);
  }

  back() {
    const prev = this.trail.pop();
    if (prev) this.#load(prev);
    else this.close();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.ro?.disconnect();
    this.trail = [];
    this.focus = null;
    document.body.classList.remove('mix-open');
    this.host.hidden = true;
    this.host.innerHTML = '';
    this.onClose?.();
  }

  #wire() {
    const items = this.host.querySelector('.mix-items');
    items.addEventListener('click', (e) => {
      const it = e.target.closest('.mix-item');
      if (!it || it.classList.contains('center')) return;
      clearTimeout(this.clickTimer);
      // Wait a beat so a double-click can play instead of re-centring.
      this.clickTimer = setTimeout(() => {
        if (it.dataset.kind === 'album') {
          const a = model.albums.get(it.dataset.id);
          if (a) this.show(a.artist);
        } else this.show(it.dataset.name);
      }, 230);
    });
    items.addEventListener('dblclick', (e) => {
      clearTimeout(this.clickTimer);
      const it = e.target.closest('.mix-item');
      if (!it) return;
      if (it.dataset.kind === 'album') playItem({ type: 'album', id: it.dataset.id });
      else if (it.dataset.id) playItem({ type: 'artist', id: it.dataset.id });
      else toast(`${it.dataset.name} isn't in your collection.`);
    });
    items.addEventListener('contextmenu', (e) => {
      const it = e.target.closest('.mix-item');
      if (!it) return;
      e.preventDefault();
      const menu = [];
      if (it.dataset.kind === 'album') {
        menu.push({ label: 'play album', action: () => playItem({ type: 'album', id: it.dataset.id }) });
      } else if (it.dataset.id) {
        menu.push({ label: 'play all', action: () => playItem({ type: 'artist', id: it.dataset.id }) });
        menu.push({ label: 'start smart dj', action: () => startSmartDJ(it.dataset.id) });
      }
      if (!it.classList.contains('center')) menu.push({ label: 'explore', action: () => it.click() });
      if (menu.length) showMenu(e.clientX, e.clientY, menu);
    });
  }

  async #load(name) {
    const token = ++this.token;
    const local = model.artistList.find((a) => norm(a.name) === norm(name)) || null;
    this.focus = { name: local?.name || name, artistId: local?.id || null };
    this.host.querySelector('.mix-title b').textContent = this.focus.name;
    this.albums = local ? model.albumsOf([local.id]).sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 8) : [];
    this.related = [];
    this.#render();
    let names = [];
    try {
      names = (await api('related', { artist: this.focus.name })).names || [];
    } catch {}
    if (token !== this.token) return;
    const owned = [];
    const other = [];
    for (const n of names) {
      if (norm(n) === norm(this.focus.name)) continue;
      const a = model.artistList.find((x) => norm(x.name) === norm(n));
      (a ? owned : other).push({ name: a?.name || n, id: a?.id || null });
    }
    // Artists you own first, then the rest of the neighbourhood.
    this.related = [...owned, ...other].slice(0, 12);
    if (!this.related.length && !model.user.settings.online?.related) {
      this.host.querySelector('.mix-hint').textContent = 'Turn on "related artists" in settings > online to fill in the mixview.';
    }
    this.#render();
  }

  #render() {
    const items = this.host.querySelector('.mix-items');
    const f = this.focus;
    const centerArt = f.artistId ? this.albums[0] : null;
    const html = [`
      <div class="mix-item center artist" data-kind="artist" data-name="${esc(f.name)}" ${f.artistId ? `data-id="${f.artistId}"` : ''}>
        <div class="mix-art" style="background-image:url('${artistPhotoUrl(f.name)}')${centerArt ? `, url('${artUrl(centerArt.id, 'l', model.artVersion(centerArt.id))}')` : ''}"></div>
        <span>${esc(f.name)}</span>
      </div>`];
    for (const a of this.albums) {
      html.push(`
        <div class="mix-item album" data-kind="album" data-id="${a.id}" title="${esc(a.title)}">
          <div class="mix-art" style="background-image:url('${artUrl(a.id, 'm', model.artVersion(a.id))}')"></div>
          <span>${esc(a.title)}</span>
        </div>`);
    }
    for (const r of this.related) {
      const localAlbum = r.id ? model.albumsOf([r.id])[0] : null;
      const bg = [`url('${artistPhotoUrl(r.name)}')`, localAlbum && `url('${artUrl(localAlbum.id, 'm', model.artVersion(localAlbum.id))}')`].filter(Boolean).join(', ');
      html.push(`
        <div class="mix-item artist related ${r.id ? 'owned' : ''}" data-kind="artist" data-name="${esc(r.name)}" ${r.id ? `data-id="${r.id}"` : ''} title="${esc(r.name)}${r.id ? ' (in your collection)' : ''}">
          <div class="mix-art" style="background-image:${bg}"></div>
          <span>${esc(r.name)}</span>
        </div>`);
    }
    items.innerHTML = html.join('');
    this.#layout();
  }

  /** Place albums on an inner ring and related artists on an outer ring. */
  #layout() {
    if (!this.open) return;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight - 64;
    const cx = W / 2;
    const cy = H / 2 + 20;
    const nodes = [...this.host.querySelectorAll('.mix-item')];
    const lines = [];
    const inner = nodes.filter((n) => n.classList.contains('album'));
    const outer = nodes.filter((n) => n.classList.contains('related'));
    const r1 = Math.min(W, H) * 0.3;
    const r2x = Math.min(W * 0.44, H * 0.8);
    const r2y = H * 0.37;
    const place = (n, x, y, size, delay) => {
      n.style.width = `${size}px`;
      n.style.left = `${x - size / 2}px`;
      n.style.top = `${y - size / 2}px`;
      n.style.setProperty('--size', `${size}px`);
      n.style.animationDelay = `${delay}ms`;
    };
    const center = nodes.find((n) => n.classList.contains('center'));
    const cs = Math.max(130, Math.min(200, H * 0.3));
    if (center) place(center, cx, cy, cs, 0);
    inner.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i + 0.5) * ((2 * Math.PI) / Math.max(inner.length, 1));
      const x = cx + Math.cos(ang) * r1;
      const y = cy + Math.sin(ang) * r1 * 0.78;
      place(n, x, y, Math.max(70, Math.min(96, H * 0.14)), 80 + i * 40);
      lines.push([cx, cy, x, y, 'album']);
    });
    outer.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i + 0.25) * ((2 * Math.PI) / Math.max(outer.length, 1));
      const x = cx + Math.cos(ang) * r2x;
      const y = cy + Math.sin(ang) * r2y;
      place(n, x, y, Math.max(58, Math.min(80, H * 0.12)), 200 + i * 45);
      lines.push([cx, cy, x, y, n.classList.contains('owned') ? 'owned' : 'other']);
    });
    const svg = this.host.querySelector('.mix-lines');
    svg.setAttribute('viewBox', `0 0 ${W} ${this.host.clientHeight}`);
    svg.innerHTML = lines.map(([x1, y1, x2, y2, kind]) => `<line class="${kind}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join('');
  }
}
