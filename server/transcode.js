import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

/**
 * Chromium can't decode WMA, AIFF or ALAC. Like Zune's "Transcoded Files Cache",
 * convert those once to MP3 with ffmpeg (if installed) and serve the copy.
 */
export class Transcoder {
  constructor(dir) {
    this.dir = dir;
    this.ffmpeg = null;
    this.inflight = new Map();
    this.ready = this.#detect();
  }

  async #detect() {
    const candidates = ['ffmpeg', path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')];
    for (const bin of candidates) {
      const ok = await new Promise((resolve) => {
        execFile(bin, ['-version'], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
      });
      if (ok) {
        this.ffmpeg = bin;
        return true;
      }
    }
    return false;
  }

  get available() {
    return !!this.ffmpeg;
  }

  async get(track) {
    await this.ready;
    if (!this.ffmpeg) return null;
    const out = path.join(this.dir, `${track.id}.mp3`);
    try {
      const s = await fsp.stat(out);
      if (s.mtimeMs >= (track.mtime || 0) && s.size > 0) return out;
    } catch {}
    if (!this.inflight.has(track.id)) {
      this.inflight.set(track.id, this.#run(track.path, out).finally(() => this.inflight.delete(track.id)));
    }
    return this.inflight.get(track.id);
  }

  async #run(input, out) {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${out}.part.mp3`;
    await new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, ['-y', '-v', 'error', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-q:a', '1', tmp], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
    });
    await fsp.rename(tmp, out);
    return out;
  }
}
