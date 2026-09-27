import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { sleep } from './util.js';

/**
 * A JSON document on disk with debounced, atomic (write-temp-then-rename) saves.
 * Writes are chained so two saves never interleave.
 */
export class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.timer = null;
    this.chain = Promise.resolve();
    this.dirty = false;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...structuredClone(this.defaults), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {}
      }
    }
    return this.data;
  }

  save(delay = 800) {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const json = JSON.stringify(this.data);
    this.chain = this.chain.then(() => this.#write(json)).catch((err) => console.error('[store] save failed', this.file, err));
    return this.chain;
  }

  flushSync() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  async #write(json) {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, json);
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, this.file);
        return;
      } catch (err) {
        // Antivirus or indexers can briefly lock the target on Windows.
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        await sleep(100 * (attempt + 1));
      }
    }
  }
}
