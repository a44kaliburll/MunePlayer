import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Talks to native/zunewpd.exe, which reaches the Zune through Microsoft's Zune
 * driver (Windows Portable Devices). One request at a time, JSON lines both ways.
 */
export class DeviceBridge extends EventEmitter {
  constructor(exe) {
    super();
    this.exe = exe;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
  }

  get available() {
    return process.platform === 'win32' && fs.existsSync(this.exe);
  }

  start() {
    if (this.proc) return this.ready;
    const proc = spawn(this.exe, ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('zunewpd did not start')), 10000);
      this.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
    proc.stderr.on('data', (d) => console.warn('[zunewpd]', String(d).trim()));
    proc.on('exit', (code) => {
      this.proc = null;
      this.ready = null;
      for (const { reject } of this.pending.values()) reject(new Error(`zunewpd exited (${code})`));
      this.pending.clear();
      this.emit('exit', code);
    });
    return this.ready;
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {}
    const p = this.proc;
    setTimeout(() => p.kill(), 3000).unref();
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return console.warn('[zunewpd] bad line', line.slice(0, 200));
    }
    if (msg.event === 'ready') return this.emit('ready');
    if (msg.event === 'progress') {
      this.pending.get(msg.req)?.onProgress?.(msg.sent, msg.total);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else {
      const err = new Error(msg.error || 'device error');
      err.hr = msg.hr;
      entry.reject(err);
    }
  }

  async request(cmd, args = {}, { onProgress, timeout = 600000 } = {}) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeout);
      this.pending.set(id, {
        onProgress,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }
}

/** FAT32-safe folder/file names for the device. */
export function deviceName(s, fallback = 'Unknown') {
  const clean = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return (clean || fallback).slice(0, 80);
}

export const exePath = (appDir) => {
  const candidates = [
    path.join(appDir, 'native', 'zunewpd.exe'),
    process.resourcesPath && path.join(process.resourcesPath, 'native', 'zunewpd.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
};
