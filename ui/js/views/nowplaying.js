// now playing: the tinted, flipping album-art wall (or an artist photo when one is
// available online), song info at the lower left and the play list on the right.
import { cycleRating, newPlaylist, showProperties, startSmartDJ, trackMenu } from '../actions.js';
import { showMenu } from '../components.js';
import { model } from '../model.js';
import { player } from '../player.js';
import { artUrl, artistPhotoUrl, clamp, esc, icons, shuffleArray } from '../util.js';

const TINTS = ['#c3d24f', '#e0409b', '#3fa9e0', '#f2a33a', '#9d7df0', '#35c0b0', '#e2523c'];

export class NowPlaying {
  constructor(host, { onClose, winButtons, onMixview }) {
    this.host = host;
    this.onClose = onClose;
    this.onMixview = onMixview;
    this.winButtons = winButtons;
    this.open = false;
    this.timers = [];
    this.tintIndex = 0;
    this.photoOk = false;
    this.photoArtist = null;
    this.showPhoto = false;
    this.idleTimer = null;
    this.unsub = [];
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;
    document.body.classList.add('np-open');
    this.host.hidden = false;
    this.host.innerHTML = `
      <div class="np-mosaic"></div>
      <div class="np-photo"></div>
      <div class="np-tint"></div>
      <div class="np-bigtext"></div>
      <div class="np-stat" hidden></div>
      <div class="np-shade"></div>
      <div class="np-drag"></div>
      <button class="np-back" title="Back (Esc)">${icons.backBig}</button>
      <div class="np-top">
        <div class="np-links"><a data-np="smartdj" title="Start a Smart DJ mix from this artist">smart dj</a><a data-np="mixview">mixview</a><a data-np="queue"></a></div>
        ${this.winButtons}
      </div>
      <div class="np-info">
        <div class="np-art"></div>
        <div class="np-text">
          <div class="np-artist"></div>
          <div class="np-album"></div>
          <div class="np-title"></div>
          <div class="np-actions">
            <button data-np="info" title="Song details">${icons.info}</button>
            <button data-np="love" title="Rate this song">${icons.heartRing}</button>
          </div>
        </div>
      </div>
      <aside class="np-queue">
        <header></header>
        <div class="np-qlist"></div>
        <footer><button data-np="save">save as playlist</button><button data-np="clear">clear</button></footer>
      </aside>`;
    this.mosaic = this.host.querySelector('.np-mosaic');
    this.tint = this.host.querySelector('.np-tint');
    this.photo = this.host.querySelector('.np-photo');
    this.qlist = this.host.querySelector('.np-qlist');
    this.#wire();
    this.#buildMosaic();
    this.#renderTrack();
    this.#renderQueue();
    this.#syncQueueLink();
    this.timers.push(setInterval(() => this.#flipRandom(), 2300));
    this.timers.push(setInterval(() => this.#nextTint(), 14000));
    this.timers.push(setInterval(() => this.#cyclePhoto(), 26000));
    this.unsub = [
      player.on('track', () => {
        this.#renderTrack();
        this.#renderQueue();
      }),
      player.on('queue', () => this.#renderQueue()),
      model.on('rating', () => this.#renderLove()),
      model.on('art', () => this.#renderTrack()),
    ];
    this.ro = new ResizeObserver(() => this.#buildMosaic());
    this.ro.observe(this.host);
    this.#poke();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.unsub.forEach((u) => u());
    this.ro?.disconnect();
    clearTimeout(this.idleTimer);
    document.body.classList.remove('np-open', 'np-idle');
    this.host.hidden = true;
    this.host.innerHTML = '';
    this.onClose?.();
  }

  #wire() {
    const h = this.host;
    h.querySelector('.np-back').onclick = () => this.close();
    h.addEventListener('click', (e) => {
      const act = e.target.closest('[data-np]')?.dataset.np;
      const t = player.current;
      if (act === 'queue') {
        document.body.classList.toggle('np-noqueue');
        this.#syncQueueLink();
      } else if (act === 'info' && t) showProperties(t.id);
      else if (act === 'love' && t) cycleRating(t.id);
      else if (act === 'save') newPlaylist(player.upcoming().map((x) => x.id));
      else if (act === 'mixview' && t) this.onMixview?.(t.aa);
      else if (act === 'smartdj' && t) startSmartDJ(t.artistId);
      else if (act === 'clear') player.clearQueue();
      const item = e.target.closest('.np-qitem');
      if (item) player.jumpTo(Number(item.dataset.pos));
    });
    h.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.np-qitem');
      if (!item) return;
      e.preventDefault();
      const pos = Number(item.dataset.pos);
      const t = player.upcoming()[pos];
      showMenu(e.clientX, e.clientY, [
        { label: 'play', action: () => player.jumpTo(pos) },
        { label: 'remove from now playing', action: () => player.removeAt(pos) },
        '-',
        ...trackMenu([t.id]).filter((m) => m !== '-' && !['play', 'add to now playing', 'play next'].includes(m.label)),
      ]);
    });
    h.addEventListener('mousemove', () => this.#poke());
    h.querySelector('.np-art').addEventListener('dblclick', () => this.close());
  }

  /** Hide the chrome after a few seconds without mouse movement. */
  #poke() {
    document.body.classList.remove('np-idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => document.body.classList.add('np-idle'), 6000);
  }

  #syncQueueLink() {
    const a = this.host.querySelector('[data-np="queue"]');
    if (a) a.textContent = document.body.classList.contains('np-noqueue') ? 'show playlist' : 'hide playlist';
  }

  #artPool() {
    const withArt = model.albumList.filter((a) => a.art !== false);
    return withArt.length ? withArt : model.albumList;
  }

  #buildMosaic() {
    if (!this.open) return;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    if (!W || !H) return;
    const key = `${W}x${H}`;
    if (key === this.mosaicKey) return;
    this.mosaicKey = key;
    const cell = clamp(Math.round(H / 7.5), 58, 110);
    const gap = 2;
    const cols = Math.ceil(W / cell) + 1;
    const rows = Math.ceil(H / cell) + 1;
    const used = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const fits = (r, c, s) => {
      if (r + s > rows || c + s > cols) return false;
      for (let y = r; y < r + s; y++) for (let x = c; x < c + s; x++) if (used[y][x]) return false;
      return true;
    };
    const pool = shuffleArray(this.#artPool());
    let n = 0;
    const html = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (used[r][c]) continue;
        const roll = Math.random();
        let s = roll < 0.07 ? 3 : roll < 0.3 ? 2 : 1;
        while (s > 1 && !fits(r, c, s)) s--;
        for (let y = r; y < r + s; y++) for (let x = c; x < c + s; x++) used[y][x] = true;
        const album = pool.length ? pool[n++ % pool.length] : null;
        const size = s * cell - gap;
        const img = album ? `background-image:url('${artUrl(album.id, s > 1 ? 'l' : 'm', model.artVersion(album.id))}')` : '';
        html.push(`<div class="np-cell" style="left:${c * cell}px;top:${r * cell}px;width:${size}px;height:${size}px"><div class="np-flip"><div class="np-face front" style="${img}"></div><div class="np-face back"></div></div></div>`);
      }
    }
    this.mosaic.innerHTML = html.join('');
  }

  #flipRandom() {
    const cells = this.mosaic?.querySelectorAll('.np-flip');
    if (!cells?.length) return;
    const pool = this.#artPool();
    if (!pool.length) return;
    const flip = cells[Math.floor(Math.random() * cells.length)];
    const cell = flip.parentElement;
    const big = cell.offsetWidth > 130;
    const album = pool[Math.floor(Math.random() * pool.length)];
    const hidden = flip.classList.contains('flipped') ? flip.querySelector('.front') : flip.querySelector('.back');
    hidden.style.backgroundImage = `url('${artUrl(album.id, big ? 'l' : 'm', model.artVersion(album.id))}')`;
    flip.classList.toggle('flipped');
  }

  #nextTint() {
    this.tintIndex = (this.tintIndex + 1) % TINTS.length;
    if (this.tint) this.tint.style.backgroundColor = TINTS[this.tintIndex];
  }

  #cyclePhoto() {
    if (!this.photoOk) return;
    this.showPhoto = !this.showPhoto;
    this.#applyPhoto();
  }

  #applyPhoto() {
    const on = this.photoOk && this.showPhoto;
    this.photo?.classList.toggle('on', on);
    if (this.mosaic) this.mosaic.style.opacity = on ? '0' : '1';
    if (this.tint) this.tint.style.opacity = on ? '.18' : '1';
    const stat = this.host.querySelector('.np-stat');
    if (stat) stat.hidden = !on;
  }

  #renderTrack() {
    if (!this.open) return;
    const t = player.current;
    const q = (s) => this.host.querySelector(s);
    if (!t) {
      q('.np-artist').textContent = '';
      q('.np-album').textContent = '';
      q('.np-title').textContent = 'Nothing is playing';
      q('.np-art').style.backgroundImage = '';
      q('.np-bigtext').textContent = '';
      return;
    }
    const artist = t.artist || t.aa;
    q('.np-artist').textContent = artist;
    q('.np-artist').title = artist;
    q('.np-album').textContent = t.album || '';
    q('.np-title').textContent = t.title;
    q('.np-art').style.backgroundImage = `url('${artUrl(t.albumId, 'l', model.artVersion(t.albumId))}')`;
    q('.np-bigtext').textContent = `${t.aa} ${t.aa}`;
    this.#renderLove();

    // Artist photo (online, cached by the server) for the Zune 4 "artist" look.
    if (this.photoArtist !== t.aa) {
      this.photoArtist = t.aa;
      this.photoOk = false;
      this.showPhoto = false;
      this.#applyPhoto();
      if (model.user.settings.online?.artistImages && !/^(unknown artist|various artists)$/i.test(t.aa)) {
        const url = artistPhotoUrl(t.aa);
        const img = new Image();
        img.onload = () => {
          if (this.photoArtist !== t.aa || !this.open) return;
          this.photo.style.backgroundImage = `url('${url}')`;
          this.photoOk = true;
          this.showPhoto = true;
          this.#applyPhoto();
        };
        img.src = url;
      }
    }
    const plays = model.tracksOfArtist(t.artistId).reduce((s, x) => s + model.plays(x.id), 0);
    const stat = q('.np-stat');
    stat.innerHTML = plays ? `<b>${plays.toLocaleString()}</b><span>plays of ${esc(t.aa)} in your collection</span>` : `<b>${model.tracksOfArtist(t.artistId).length}</b><span>songs by ${esc(t.aa)} in your collection</span>`;
  }

  #renderLove() {
    const t = player.current;
    const btn = this.host.querySelector('[data-np="love"]');
    if (!btn) return;
    const r = t && model.rating(t.id);
    btn.classList.toggle('love', r === 'love');
    btn.innerHTML = r === 'hate' ? icons.heartBrokenRing : icons.heartRing;
  }

  #renderQueue() {
    if (!this.open) return;
    const list = player.upcoming();
    const header = this.host.querySelector('.np-queue header');
    header.textContent = player.context?.label || (list.length ? 'now playing' : '');
    if (!list.length) {
      this.qlist.innerHTML = '<div class="np-qitem"><span>Nothing queued. Double-click songs in your collection to play them.</span></div>';
      return;
    }
    const cur = player.pos;
    this.qlist.innerHTML = list.map((t, i) => `
      <div class="np-qitem${i === cur ? ' cur' : ''}${i < cur ? ' past' : ''}" data-pos="${i}">
        ${i === cur ? `<span class="ind">${icons.eq}</span>` : ''}
        <b>${esc(t.title)}</b><span>${esc(t.artist || t.aa)}</span>
      </div>`).join('');
    const curEl = this.qlist.querySelector('.cur');
    if (curEl) this.qlist.scrollTop = Math.max(0, curEl.offsetTop - 80);
  }
}

