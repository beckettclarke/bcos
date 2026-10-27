// The data layer. Every app reads and writes through here.
//
// - Reads are synchronous from memory, so nothing waits on the network to paint.
// - Writes are optimistic: the UI changes on the same frame, then the change is
//   queued in an outbox (persisted to localStorage) and sent to the server.
//   If the Umbrel is unreachable the outbox simply waits and retries.
// - The last good snapshot is cached in localStorage for an instant boot.
// - If there is no server at all (opened from a plain static host), BCOS runs
//   in "local" mode and the cache is the source of truth.

import { useEffect, useReducer } from './html.js';

const CACHE_KEY = 'bcos.cache.v1';
const OUTBOX_KEY = 'bcos.outbox.v1';

export const DEFAULT_SETTINGS = {
  id: 'prefs',
  name: '',
  wallpaper: 'peaks',
  customWallpaper: null,
  accent: 'sunset',
  widgets: ['upnext', 'tasks', 'journal'],
  use24h: false,
  weekStart: 0,
  reduceMotion: false,
  calendar: { view: 'week', dayStart: 7, defaultDuration: 60, showTasks: true },
  tasks: { completed: 'section' },
  notes: { sort: 'edited', view: 'list', font: 'sans' },
  journal: { font: 'sans', showFood: true },
  logoDevKey: '', // publishable key from logo.dev, for brand logos on Journal cards
  // AI: presets pair a provider with a model; `tasks` maps each AI feature to
  // a preset id, 'default' or 'ask'. Keys live on the server, never here.
  ai: { presets: [], defaultPreset: 'ask', tasks: {} },
};
const NESTED = ['calendar', 'tasks', 'notes', 'journal', 'ai'];

const data = new Map();      // collection → Map(id → item)
const arrays = new Map();    // collection → cached array for the current version
const listeners = new Map(); // collection | '*' → Set(fn)
const statusListeners = new Set();
const outbox = new Map();    // "collection/id" → { op, name, id, item }

export const status = { ready: false, mode: 'server', online: true, syncing: false, authLost: false, lastSync: 0 };

const col = (name) => {
  let c = data.get(name);
  if (!c) { c = new Map(); data.set(name, c); }
  return c;
};

function emit(name) {
  arrays.delete(name);
  listeners.get(name)?.forEach((fn) => fn());
  listeners.get('*')?.forEach((fn) => fn(name));
  scheduleCache();
}

function setStatus(patch) {
  Object.assign(status, patch);
  statusListeners.forEach((fn) => fn());
}

export function subscribe(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

// --- reads -----------------------------------------------------------------

export function all(name) {
  let arr = arrays.get(name);
  if (!arr) { arr = [...col(name).values()]; arrays.set(name, arr); }
  return arr;
}
export const get = (name, id) => col(name).get(id);

export function useCollection(name) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(name, force), [name]);
  return all(name);
}

export function useItem(name, id) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(name, force), [name]);
  return id ? get(name, id) : undefined;
}

export function useStatus() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { statusListeners.add(force); return () => statusListeners.delete(force); }, []);
  return status;
}

// --- writes ----------------------------------------------------------------

export function put(name, item, { touch = true } = {}) {
  const now = Date.now();
  const next = { ...item, createdAt: item.createdAt || now, updatedAt: touch ? now : (item.updatedAt || now) };
  col(name).set(next.id, next);
  emit(name);
  enqueue({ op: 'put', name, id: next.id, item: next });
  return next;
}

export function patch(name, id, changes) {
  const cur = get(name, id);
  if (!cur) return null;
  return put(name, { ...cur, ...changes });
}

export function remove(name, id) {
  const cur = get(name, id);
  if (!cur) return null;
  col(name).delete(id);
  emit(name);
  enqueue({ op: 'del', name, id });
  return cur;
}

/** Put many items at once with a single notification per collection. */
export function putMany(name, items, { touch = true } = {}) {
  const now = Date.now();
  for (const item of items) {
    const next = { ...item, createdAt: item.createdAt || now, updatedAt: touch ? now : (item.updatedAt || now) };
    col(name).set(next.id, next);
    enqueue({ op: 'put', name, id: next.id, item: next }, false);
  }
  emit(name);
  saveOutbox();
  flushSoon();
}

/**
 * Apply items the server has already stored (e.g. mail it synced) without
 * queueing them to be written back.
 */
export function absorb(name, upserts = [], removals = []) {
  const c = col(name);
  for (const item of upserts) if (item && item.id) c.set(item.id, item);
  for (const id of removals) c.delete(id);
  if (upserts.length || removals.length) emit(name);
}

/** Call a JSON endpoint on the BCOS server. Throws with the server's message. */
export async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  if (status.mode !== 'server') throw new Error('This needs the BCOS server running on your Umbrel');
  let res;
  try {
    res = await request(`api/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }, timeout);
  } catch (err) {
    if (err instanceof AuthLost) throw new Error('Signed out of Umbrel — reload to sign in');
    throw new Error(err.name === 'AbortError' ? 'That took too long — try again' : 'Couldn’t reach your Umbrel');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status})`), { status: res.status });
  return data;
}

// --- settings --------------------------------------------------------------

export function settings() {
  const s = get('settings', 'prefs') || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    ...Object.fromEntries(NESTED.map((k) => [k, { ...DEFAULT_SETTINGS[k], ...(s[k] || {}) }])),
  };
}

export function useSettings() {
  useCollection('settings');
  return settings();
}

export function setSettings(changes) {
  const cur = settings();
  const next = { ...cur, ...changes };
  for (const k of NESTED) if (changes[k]) next[k] = { ...cur[k], ...changes[k] };
  put('settings', next);
}

// --- outbox & sync ---------------------------------------------------------

function enqueue(op, flushNow = true) {
  if (status.mode === 'local') return;
  outbox.set(`${op.name}/${op.id}`, op);
  if (flushNow) { saveOutbox(); flushSoon(); }
}

function saveOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify([...outbox.values()])); } catch {}
}

function readOutbox() {
  try {
    const ops = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    for (const op of ops) outbox.set(`${op.name}/${op.id}`, op);
  } catch {}
}

class AuthLost extends Error {}

async function request(url, opts = {}, timeout = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, credentials: 'same-origin' });
    // Umbrel's proxy answers an expired session with its login page.
    if (res.redirected && !/\/api\//.test(res.url)) throw new AuthLost();
    return res;
  } finally { clearTimeout(t); }
}

let flushing = false;
let flushTimer = 0;
let retryDelay = 2000;

function flushSoon(ms = 60) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, ms);
}

async function flush() {
  if (flushing || status.mode !== 'server' || !status.ready || !outbox.size) return;
  flushing = true;
  setStatus({ syncing: true });
  try {
    while (outbox.size) {
      const [key, op] = outbox.entries().next().value;
      const res = await request(`api/c/${op.name}/${encodeURIComponent(op.id)}`, {
        method: op.op === 'put' ? 'PUT' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: op.op === 'put' ? JSON.stringify(op.item) : undefined,
      });
      if (res.status >= 500 || !(res.headers.get('content-type') || '').includes('json')) throw new Error(`HTTP ${res.status}`);
      // A 4xx will never succeed; drop it rather than block everything behind it.
      if (!res.ok) console.warn('[bcos] dropped write', op, res.status);
      if (outbox.get(key) === op) outbox.delete(key);
      saveOutbox();
    }
    retryDelay = 2000;
    setStatus({ online: true, syncing: false, lastSync: Date.now(), authLost: false });
  } catch (err) {
    setStatus({ online: false, syncing: false, authLost: err instanceof AuthLost });
    flushTimer = setTimeout(flush, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  } finally {
    flushing = false;
  }
}

// --- snapshot / cache ------------------------------------------------------

function applySnapshot(collections) {
  const names = new Set([...Object.keys(collections), ...data.keys()]);
  for (const name of names) {
    const items = collections[name] || [];
    const cur = col(name);
    let changed = cur.size !== items.length;
    if (!changed) {
      for (const item of items) {
        const mine = cur.get(item.id);
        if (!mine || mine.updatedAt !== item.updatedAt) { changed = true; break; }
      }
    }
    if (!changed) continue;
    const next = new Map(items.map((i) => [i.id, i]));
    data.set(name, next);
    emit(name);
  }
}

/** Re-apply writes that haven't reached the server on top of what it sent. */
function applyOutbox() {
  const touched = new Set();
  for (const op of outbox.values()) {
    if (op.op === 'put') col(op.name).set(op.id, op.item);
    else col(op.name).delete(op.id);
    touched.add(op.name);
  }
  touched.forEach(emit);
}

let cacheTimer = 0;
function scheduleCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(writeCache, 400);
}
function writeCache() {
  const out = {};
  for (const [name, c] of data) out[name] = [...c.values()];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); }
  catch (err) { console.warn('[bcos] could not cache data locally', err); }
}
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

export function snapshotAll() {
  const out = {};
  for (const [name, c] of data) out[name] = [...c.values()];
  return out;
}

// --- boot & refresh --------------------------------------------------------

let seedFn = null;

async function fetchServer() {
  const res = await request('api/data', {}, 8000);
  const type = res.headers.get('content-type') || '';
  if (res.status === 404 || !type.includes('json')) return { noServer: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function boot({ seed } = {}) {
  seedFn = seed;
  const cached = readCache();
  if (cached) applySnapshot(cached);
  readOutbox();
  applyOutbox();

  try {
    const body = await fetchServer();
    if (body.noServer) {
      setStatus({ mode: 'local', ready: true, online: true });
      outbox.clear();
      saveOutbox();
      if (!get('settings', 'prefs')) seedFn?.();
      return;
    }
    applySnapshot(body.collections || {});
    applyOutbox();
    setStatus({ mode: 'server', ready: true, online: true, lastSync: Date.now(), version: body.meta?.version });
    if (!get('settings', 'prefs')) seedFn?.();
    flushSoon(0);
  } catch (err) {
    // Server unreachable: keep working from the cache and keep trying.
    setStatus({ mode: 'server', ready: true, online: false, authLost: err instanceof AuthLost });
    setTimeout(() => refresh(true), 5000);
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('online', () => { refresh(); flushSoon(0); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
}

let refreshing = false;
export async function refresh(retryUntilOnline = false) {
  if (status.mode !== 'server' || refreshing) return;
  refreshing = true;
  try {
    const body = await fetchServer();
    if (body.noServer) return;
    // Don't paint over writes that are still on their way.
    if (!outbox.size && !flushing) applySnapshot(body.collections || {});
    const needsSeed = !get('settings', 'prefs');
    setStatus({ online: true, lastSync: Date.now(), authLost: false, version: body.meta?.version });
    if (needsSeed) seedFn?.();
    flushSoon(0);
  } catch (err) {
    setStatus({ online: false, authLost: err instanceof AuthLost });
    if (retryUntilOnline) setTimeout(() => refresh(true), 8000);
  } finally {
    refreshing = false;
  }
}

// --- whole-dataset operations ------------------------------------------------

export function exportAll() {
  return { app: 'bcos', format: 1, exportedAt: new Date().toISOString(), collections: snapshotAll() };
}

export async function importAll(dump) {
  const collections = dump && dump.collections;
  if (!collections || typeof collections !== 'object') throw new Error('That file isn’t a BCOS backup');
  if (status.mode === 'server') {
    const res = await request('api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collections }) }, 30000);
    if (!res.ok) throw new Error('The server refused the backup');
  }
  outbox.clear();
  saveOutbox();
  data.clear();
  applySnapshot(collections);
  writeCache();
}

export async function resetAll() {
  if (status.mode === 'server') {
    const res = await request('api/reset', { method: 'POST' }, 15000);
    if (!res.ok) throw new Error('The server couldn’t reset');
  }
  outbox.clear();
  saveOutbox();
  for (const name of [...data.keys()]) { data.set(name, new Map()); emit(name); }
  writeCache();
  seedFn?.();
}

/** Store an image and return a URL the page can show. */
export async function uploadImage(blob, id) {
  if (status.mode === 'server' && status.online) {
    const res = await request(`api/files${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob }, 60000);
    if (!res.ok) throw new Error('Upload failed');
    return (await res.json()).url;
  }
  const { blobToDataUrl } = await import('./util.js');
  return blobToDataUrl(blob);
}

export async function serverInfo() {
  if (status.mode !== 'server') return null;
  try {
    const res = await request('api/info', {}, 6000);
    return res.ok ? res.json() : null;
  } catch { return null; }
}

export async function fetchFeed(url) {
  if (status.mode !== 'server') throw new Error('Calendar feeds need the BCOS server');
  const res = await request(`api/feed?url=${encodeURIComponent(url)}`, {}, 20000);
  if (!res.ok) {
    let msg = `The feed couldn’t be loaded (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.text();
}
