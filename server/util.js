import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

/** Case/space-insensitive comparison key. */
export const norm = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.wma', '.m4b', '.mp4', '.aif', '.aiff', '.webm',
]);

/** Formats Chromium can decode natively; everything else is transcoded with ffmpeg. */
export const NATIVE_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4b', '.mp4', '.webm']);

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};

/** Run at most `n` async jobs at once. */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

/** Where the app keeps its library index, caches and settings (outside OneDrive). */
export function stateDir(dev = false) {
  const dir = path.join(os.homedir(), dev ? '.mune-player-dev' : '.mune-player');
  // Before 1.1 the app was called Zoon Player and kept its data under that name; bring it along once.
  const legacy = path.join(os.homedir(), dev ? '.zoon-player-dev' : '.zoon-player');
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, dir);
    } catch {}
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Windows "My Music" known folder, following OneDrive redirection. */
export function myMusicFolder() {
  const candidates = [
    process.env.OneDrive && path.join(process.env.OneDrive, 'Music'),
    path.join(os.homedir(), 'OneDrive', 'Music'),
    path.join(os.homedir(), 'Music'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
}

export const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A name someone typed (their own, this PC's, a phone's or a Zune's): one line, no control characters; empty means null. */
export function cleanName(value, max = 40) {
  const s = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return s || null;
}
