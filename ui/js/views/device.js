// device: the connected Zune — summary (capacity, sync) and the music on it.
import { api } from '../api.js';
import { confirm, prompt, showMenu, toast } from '../components.js';
import { model } from '../model.js';
import { router } from '../router.js';
import { artUrl, collator, el, esc, plural, sortName } from '../util.js';
import { wireArt } from './collection.js';

const GB = 1e9;
const fmtBytes = (n) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(0, Math.round(n / 1e6))} MB`);

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

export function syncLine(p) {
  if (!p) return '';
  if (p.phase === 'preparing') return 'Getting ready to sync…';
  if (p.phase === 'copying') {
    const pct = p.size ? ` · ${Math.round((p.sent / p.size) * 100)}%` : '';
    return `Copying ${p.done + 1} of ${p.total}: ${p.title}${pct}`;
  }
  if (p.phase === 'fixing') return `Fixing ${p.done + 1} of ${p.total}: ${p.title}`;
  if (p.phase === 'linking') return 'Updating albums and artists on your Zune…';
  if (p.phase === 'error') return `Sync stopped: ${p.error}`;
  if (p.phase === 'done') {
    const r = p.report || {};
    const parts = [];
    if (r.added) parts.push(`added ${plural(r.added, 'song')}`);
    if (r.repaired) parts.push(`fixed ${plural(r.repaired, 'song')}`);
    if (!parts.length) parts.push('everything was already on your Zune');
    if (r.failed?.length) parts.push(`${r.failed.length} couldn't be copied`);
    return `Sync complete: ${parts.join(', ')}.`;
  }
  return '';
}

/** Local album art for something on the device, when the collection has the same album. */
function localAlbumFor(name, artist) {
  const n = String(name || '').toLowerCase();
  const a = String(artist || '').toLowerCase();
  return model.albumList.find((x) => x.title.toLowerCase() === n && (x.artist.toLowerCase() === a || !a || a === 'unknown artist'))
    || model.albumList.find((x) => x.title.toLowerCase() === n) || null;
}

export function deviceView(page, state) {
  const root = el('<div class="devpage"></div>');
  page.appendChild(root);
  wireArt(root);
  let content = null;

  const loadContent = async () => {
    try {
      content = (await api('device/content')).content;
    } catch {
      content = null;
    }
    render();
  };

  const render = () => {
    const d = model.device || {};
    if (!d.connected) {
      root.innerHTML = `
        <div class="placeholder">
          <h2>connect your zune</h2>
          <p>Plug in your Zune with its USB cable. It shows up here within a few seconds.${d.available === false ? ' (Device sync needs the Zune driver, which comes with the original Zune software.)' : ''}</p>
        </div>`;
      return;
    }
    if (state.sub === 'music') return renderMusic(d);
    renderSummary(d);
  };

  const renderSummary = (d) => {
    const info = d.info || {};
    const s = d.summary || {};
    const cap = info.capacity || 0;
    const free = info.free || 0;
    const music = s.musicBytes || 0;
    const other = Math.max(0, cap - free - music);
    const pct = (n) => (cap ? `${Math.max(0, (n / cap) * 100).toFixed(2)}%` : '0%');
    const p = model.syncProgress;
    const busy = d.busy || (p && !['done', 'error'].includes(p.phase));
    const barPct = p?.total ? Math.round(((p.done + (p.size ? p.sent / p.size : 0)) / p.total) * 100) : 0;
    root.innerHTML = `
      <div class="dev-summary">
        <div class="dev-art" aria-hidden="true">
          <div class="dev-body"><div class="dev-screen"></div><div class="dev-button"></div></div>
        </div>
        <div class="dev-main">
          <h2 class="dev-name">${esc(info.name || d.device?.name || 'zune')}</h2>
          <div class="dev-meta">${esc(['zune hd', cap ? fmtBytes(cap) : null, info.firmware ? `firmware ${info.firmware.split('-')[0]}` : null, info.battery != null ? `battery ${info.battery}%` : null].filter(Boolean).join(' · '))}</div>
          <div class="capacity" title="${esc(`${fmtBytes(free)} free of ${fmtBytes(cap)}`)}">
            <span class="seg music" style="width:${pct(music)}"></span><span class="seg other" style="width:${pct(other)}"></span>
          </div>
          <div class="capacity-legend">
            <span><i class="music"></i>music ${fmtBytes(music)}</span>
            <span><i class="other"></i>other ${fmtBytes(other)}</span>
            <span><i class="free"></i>free ${fmtBytes(free)}</span>
          </div>
          <div class="dev-stats">
            ${s.localTracks != null ? `<div><b>${s.localOnDevice}</b><span>of your ${plural(s.localTracks, 'song')} on this zune</span></div>` : ''}
            ${s.tracks != null ? `<div><b>${s.tracks}</b><span>${s.tracks === 1 ? 'song' : 'songs'} on the zune</span></div>` : ''}
            ${s.unknown ? `<div><b>${s.unknown}</b><span>filed as unknown</span></div>` : ''}
          </div>
          <div class="dev-actions">
            <button class="zbtn primary" data-act="sync" ${busy ? 'disabled' : ''}>${busy ? 'syncing…' : 'sync all music'}</button>
            <button class="zbtn" data-act="refresh" ${busy ? 'disabled' : ''}>refresh</button>
            <button class="zbtn" data-act="rename" ${busy ? 'disabled' : ''}>rename</button>
          </div>
          <div class="dev-progress ${busy ? 'on' : ''}"><i style="width:${barPct}%"></i></div>
          <div class="dev-status">${esc(syncLine(p) || (d.lastError ? `Problem talking to your Zune: ${d.lastError}` : `Last synced ${ago(d.lastSync)}.`))}</div>
          <label class="check"><input type="checkbox" data-auto ${model.user.settings.sync?.auto ? 'checked' : ''}><span class="box"></span><span>Sync automatically when my Zune connects</span></label>
          ${p?.phase === 'done' && p.report?.failed?.length ? `<ul class="dev-failed">${p.report.failed.slice(0, 8).map((f) => `<li>${esc(f.title)} — ${esc(f.error)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>`;
  };

  const renderMusic = () => {
    if (!content) {
      root.innerHTML = '<div class="hint devhint">Reading your Zune…</div>';
      return;
    }
    const byTrack = (x, y) => (x.track || 0) - (y.track || 0) || collator.compare(x.title, y.title);
    const albums = content.albums.map((a) => ({ ...a, tracks: content.tracks.filter((t) => a.refs.includes(t.id)).sort(byTrack) }));
    const loose = content.tracks.filter((t) => !albums.some((a) => a.refs.includes(t.id)));
    if (loose.length) albums.push({ id: '', name: 'Unknown Album', artist: 'Unknown Artist', tracks: loose.sort(byTrack), unknown: true });
    albums.sort((a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || collator.compare(a.name, b.name));
    root.innerHTML = `
      <div class="coll dev-music">
        <section class="col">
          <div class="colhead"><b>${esc(plural(albums.length, 'album'))}</b><span class="sort">on your zune</span></div>
          <div class="colbody dev-albums">${albums.map((a, i) => {
            const local = a.unknown ? null : localAlbumFor(a.name, a.artist);
            return `<div class="dev-album" data-i="${i}">
              <div class="art" data-art-album="${local?.id || ''}">${local ? `<img alt="" src="${artUrl(local.id, 'm', model.artVersion(local.id))}">` : ''}</div>
              <div><b>${esc(a.name)}</b><span>${esc(a.artist)} · ${plural(a.tracks.length, 'song')}</span></div>
            </div>`;
          }).join('')}</div>
        </section>
        <section class="col songs-col">
          <div class="colhead"><b>${esc(plural(content.tracks.length, 'song'))}</b><span class="sort">right-click to remove</span></div>
          <div class="colbody dev-songs">${albums.flatMap((a) => a.tracks.map((t) => `
            <div class="song" data-id="${esc(t.id)}"><span class="title">${esc(t.title)}</span><span class="sub">${esc(t.artist)} · ${esc(t.album)}</span></div>`)).join('')}</div>
        </section>
      </div>`;
    root.querySelector('.dev-albums').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.dev-album');
      if (!row) return;
      e.preventDefault();
      const a = albums[Number(row.dataset.i)];
      showMenu(e.clientX, e.clientY, [{ label: `remove "${a.name}" from zune`, action: () => removeFromZune(a.tracks.map((t) => t.id).concat(a.id ? [a.id] : []), `${plural(a.tracks.length, 'song')} from "${a.name}"`) }]);
    });
    root.querySelector('.dev-songs').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.song');
      if (!row) return;
      e.preventDefault();
      const t = content.tracks.find((x) => x.id === row.dataset.id);
      showMenu(e.clientX, e.clientY, [{ label: 'remove from zune', action: () => removeFromZune([t.id], `"${t.title}"`) }]);
    });
  };

  const removeFromZune = async (ids, label) => {
    const ok = await confirm('remove from zune', `Delete ${label} from your Zune? The files stay in your collection on this PC.`, 'remove');
    if (!ok) return;
    try {
      await api('device/remove', { objectIds: ids });
      toast(`Removed ${label} from your Zune`);
      loadContent();
    } catch (err) {
      toast(err.message);
    }
  };

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sync') {
      try {
        const plan = await api('device/plan', { all: true });
        if (!plan.add && !plan.repair) return toast('Everything in your collection is already on your Zune.');
        model.syncProgress = { phase: 'preparing', done: 0, total: plan.add + plan.repair };
        render();
        await api('device/sync', { all: true });
      } catch (err) {
        toast(err.message);
      }
    } else if (act === 'refresh') {
      api('device/refresh').then(loadContent).catch((err) => toast(err.message));
    } else if (act === 'rename') {
      const d = model.device || {};
      const name = await prompt('name your zune', { value: d.info?.name || d.device?.name || '', okLabel: 'save' });
      if (!name) return;
      try {
        const { device } = await api('device/rename', { name });
        toast(`Your Zune is now called ${device.info?.name || name}.`);
      } catch (err) {
        toast(err.message);
      }
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-auto]')) model.saveSettings({ sync: { auto: e.target.checked } });
  });

  const unsub = [
    model.on('device', () => {
      render();
      if (state.sub === 'music') loadContent();
    }),
    model.on('sync', (p) => {
      if (state.sub !== 'music') render();
      if (p.phase === 'done') loadContent();
    }),
  ];
  if (state.sub === 'music') loadContent();
  else render();
  return { destroy: () => unsub.forEach((u) => u()), refresh() {} };
}

export const goToDevice = () => router.go({ pivot: 'device', sub: 'summary' });
