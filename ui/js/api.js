// Thin client for the local Zoon Player server (see server/app.js).

const token = document.querySelector('meta[name="zoon-token"]')?.content || '';
export const shellKind = document.querySelector('meta[name="zoon-shell"]')?.content || 'browser';

/** The Electron preload bridge (window controls, folder picker...), or null in a plain browser. */
export const native = window.zoonShell || null;

export async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'X-Zoon-Token': token } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function subscribe(handlers) {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => fn(JSON.parse(e.data || '{}')));
  }
  return es;
}

export const mediaUrl = (id) => `/media/${id}`;
