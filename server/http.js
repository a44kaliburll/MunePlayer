import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { MIME, NATIVE_EXT } from './util.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

export async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** Pipe a file to the response; a vanished file or a client that hangs up must not crash the server. */
function pipeFile(res, file, opts) {
  const stream = fs.createReadStream(file, opts);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export async function sendFile(req, res, file, type, { cache = 'no-cache' } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  const etag = `"${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, ETag: etag, 'Cache-Control': cache });
  if (req.method === 'HEAD') return res.end();
  pipeFile(res, file);
}

/** Byte-range streaming so <audio> (and the phone's downloader) can seek and resume. */
export async function sendMedia(req, res, file, type, extraHeaders = {}) {
  const stat = await fsp.stat(file);
  const size = stat.size;
  const range = req.headers.range;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...extraHeaders };
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    return pipeFile(res, file);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start;
  let end;
  if (m && m[1] !== '') {
    start = Number(m[1]);
    end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else if (m && m[2] !== '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (start == null || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  pipeFile(res, file, { start, end });
}

/**
 * Local server for the UI: static files, a JSON API guarded by a per-launch
 * token, byte-range audio, cached album art and a server-sent event stream.
 * Only answers to 127.0.0.1/localhost Host headers (blocks DNS rebinding).
 */
export function createHttpServer(ctx) {
  const { token, uiDir } = ctx;
  const clients = new Set();
  let port = 0;

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of clients) res.write(msg);
  };
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000).unref();

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  ctx.registerRoutes(route, { sendJson, HttpError });

  route('GET', /^\/api\/events$/, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  route('GET', /^\/media\/([a-f0-9]{12})$/, async (req, res, [, id]) => {
    const t = ctx.library.tracks.get(id);
    if (!t) throw new HttpError(404, 'Unknown track');
    const ext = path.extname(t.path).toLowerCase();
    if (NATIVE_EXT.has(ext)) return sendMedia(req, res, t.path, MIME[ext] || 'application/octet-stream');
    const converted = await ctx.transcoder.get(t);
    if (!converted) throw new HttpError(415, 'This format needs ffmpeg to play');
    return sendMedia(req, res, converted, 'audio/mpeg');
  });

  route('GET', /^\/art\/album\/([a-f0-9]{12})$/, async (req, res, [, id], url) => {
    const size = url.searchParams.get('s') || 'm';
    const art = await ctx.art.album(id, size);
    if (!art) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendFile(req, res, art.file, art.type);
  });

  route('GET', /^\/art\/artist\/(.+)$/, async (req, res, [, name], url) => {
    const art = await ctx.art.artist(decodeURIComponent(name), url.searchParams.get('s') || 'l');
    if (!art) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendFile(req, res, art.file, art.type);
  });

  const serveUi = async (req, res, pathname) => {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(uiDir, rel));
    if (!file.startsWith(uiDir + path.sep)) throw new HttpError(403, 'Forbidden');
    const ext = path.extname(file).toLowerCase();
    if (rel === 'index.html') {
      const html = (await fsp.readFile(file, 'utf8'))
        .replace('%%TOKEN%%', token)
        .replace('%%SHELL%%', ctx.shell);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    return sendFile(req, res, file, MIME[ext] || 'application/octet-stream');
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Bad host');
      const url = new URL(req.url, `http://${host}`);
      const { pathname } = url;
      if (pathname.startsWith('/api/')) {
        const supplied = req.headers['x-mune-token'] || url.searchParams.get('t');
        if (supplied !== token) throw new HttpError(401, 'Bad token');
        if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'JSON only');
        }
      }
      for (const r of routes) {
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined;
        return await r.handler(req, res, m, url, body);
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'No such endpoint');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return await serveUi(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[http]', req.method, req.url, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  });

  return {
    server,
    broadcast,
    listen(wanted, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          port = server.address().port;
          resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(wanted, host);
      });
    },
  };
}
