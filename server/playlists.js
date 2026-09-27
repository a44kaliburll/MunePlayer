import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { hash } from './util.js';

const PLAYLIST_EXT = new Set(['.zpl', '.wpl', '.m3u', '.m3u8']);

const xmlUnescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const safeName = (name) => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 120) || 'Playlist';

/**
 * Zune playlists: the .zpl files Zune wrote into "<monitored folder>\Playlists".
 * We read .zpl/.wpl/.m3u from those folders and write new playlists as .zpl so
 * the original Zune software can still open them.
 */
export class Playlists extends EventEmitter {
  constructor({ library, getFolders, getSaveDir }) {
    super();
    this.library = library;
    this.getFolders = getFolders;
    this.getSaveDir = getSaveDir;
    this.items = new Map();
  }

  dirs() {
    const dirs = new Set();
    for (const f of this.getFolders()) dirs.add(path.join(f, 'Playlists'));
    dirs.add(this.getSaveDir());
    return [...dirs].filter((d) => fs.existsSync(d));
  }

  async load() {
    const next = new Map();
    for (const dir of this.dirs()) {
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!PLAYLIST_EXT.has(path.extname(name).toLowerCase())) continue;
        const file = path.join(dir, name);
        try {
          const pl = await this.#read(file);
          next.set(pl.id, pl);
        } catch (err) {
          console.warn('[playlists] could not read', file, err.message);
        }
      }
    }
    this.items = next;
    return this.list();
  }

  /** Re-resolve paths after a library rescan (tracks may have appeared). */
  async refresh() {
    await this.load();
    this.emit('changed');
  }

  list() {
    return [...this.items.values()]
      .map(({ entries, ...p }) => p)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  async #read(file) {
    const raw = await fsp.readFile(file, 'utf8');
    const ext = path.extname(file).toLowerCase();
    const dir = path.dirname(file);
    let name = path.basename(file, ext);
    let guid = null;
    const srcs = [];
    if (ext === '.zpl' || ext === '.wpl') {
      const title = /<title>([\s\S]*?)<\/title>/i.exec(raw);
      if (title && title[1].trim()) name = xmlUnescape(title[1].trim());
      const g = /<guid>([\s\S]*?)<\/guid>/i.exec(raw);
      if (g) guid = g[1].trim();
      for (const m of raw.matchAll(/<media\b[^>]*\bsrc="([^"]*)"/gi)) srcs.push(xmlUnescape(m[1]));
    } else {
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim().replace(/^﻿/, '');
        if (s && !s.startsWith('#')) srcs.push(s);
      }
    }
    const trackIds = [];
    const entries = [];
    let missing = 0;
    for (const src of srcs) {
      const abs = path.isAbsolute(src) ? src : path.resolve(dir, src);
      const t = this.library.trackByPath(abs);
      entries.push(abs);
      if (t) trackIds.push(t.id);
      else missing++;
    }
    const stat = await fsp.stat(file);
    return {
      id: hash(file.toLowerCase()),
      name,
      file,
      guid,
      format: ext.slice(1),
      trackIds,
      missing,
      entries,
      modified: Math.round(stat.mtimeMs),
      readOnly: ext === '.m3u' || ext === '.m3u8',
    };
  }

  #uniqueFile(dir, name) {
    const base = safeName(name);
    let file = path.join(dir, `${base}.zpl`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).zpl`);
    return file;
  }

  async #write(file, { name, guid, trackIds, extraEntries = [] }) {
    const tracks = trackIds.map((id) => this.library.tracks.get(id)).filter(Boolean);
    const total = Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0) * 1000);
    const lines = [
      '<?zpl version="2.0"?>',
      '<smil>',
      '  <head>',
      `    <guid>${xmlEscape(guid)}</guid>`,
      '    <meta name="generator" content="Mune Player -- 1.1" />',
      `    <meta name="totalDuration" content="${total}" />`,
      `    <meta name="itemCount" content="${tracks.length + extraEntries.length}" />`,
      `    <title>${xmlEscape(name)}</title>`,
      '  </head>',
      '  <body>',
      '    <seq>',
      ...tracks.map((t) => `      <media src="${xmlEscape(t.path)}" />`),
      ...extraEntries.map((p) => `      <media src="${xmlEscape(p)}" />`),
      '    </seq>',
      '  </body>',
      '</smil>',
      '',
    ];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, lines.join('\r\n'), 'utf8');
    await fsp.rename(tmp, file);
  }

  async create(name, trackIds = []) {
    const dir = this.getSaveDir();
    const file = this.#uniqueFile(dir, name);
    const guid = `{${crypto.randomUUID().toUpperCase()}}`;
    await this.#write(file, { name: String(name).trim() || 'Untitled Playlist', guid, trackIds });
    const pl = await this.#read(file);
    this.items.set(pl.id, pl);
    this.emit('changed');
    return pl;
  }

  async update(id, { name, trackIds, append }) {
    const pl = this.items.get(id);
    if (!pl) throw new Error('Playlist not found');
    let file = pl.file;
    let format = pl.format;
    let ids = trackIds ? [...trackIds] : [...pl.trackIds];
    if (append) ids = ids.concat(append);
    const newName = name != null ? String(name).trim() || pl.name : pl.name;
    // Keep entries we couldn't resolve (e.g. a song on an unplugged drive).
    const unresolved = pl.entries.filter((p) => !this.library.trackByPath(p));
    if (format === 'm3u' || format === 'm3u8') {
      // Zune converted m3u playlists to .zpl the first time you edited them; so do we.
      file = this.#uniqueFile(path.dirname(pl.file), newName);
      format = 'zpl';
    } else if (newName !== pl.name) {
      const renamed = this.#uniqueFile(path.dirname(pl.file), newName);
      await fsp.rename(pl.file, renamed);
      file = renamed;
    }
    await this.#write(file, { name: newName, guid: pl.guid || `{${crypto.randomUUID().toUpperCase()}}`, trackIds: ids, extraEntries: unresolved });
    this.items.delete(id);
    const next = await this.#read(file);
    this.items.set(next.id, next);
    this.emit('changed');
    return next;
  }

  async remove(id, trash) {
    const pl = this.items.get(id);
    if (!pl) return false;
    await trash(pl.file);
    this.items.delete(id);
    this.emit('changed');
    return true;
  }
}
