// BCOS server — serves the web UI from ./www and keeps your data in DATA_DIR.
//
// No dependencies on purpose: the container is the stock node:alpine image
// with this folder mounted read-only, so updating BCOS is "push, then update
// the app in Umbrel" with nothing to build.
//
// Storage is one JSON file per collection ({ id: item }), held in memory and
// written atomically (tmp file + rename) shortly after each change. Writes are
// per item, so two devices editing different things never clobber each other.
// Umbrel's app_proxy sits in front and handles login.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const APP_DIR = __dirname;
const WWW_DIR = path.resolve(process.env.WWW_DIR || path.join(APP_DIR, 'www'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const STARTED_AT = Date.now();

const VERSION = (() => {
  try {
    const yml = fs.readFileSync(path.join(APP_DIR, 'umbrel-app.yml'), 'utf8');
    const m = yml.match(/^version:\s*"?([^"\n]+)"?/m);
    return m ? m[1].trim() : 'dev';
  } catch { return 'dev'; }
})();

const COLLECTION_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_FEED = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** @type {Map<string, Record<string, any>>} */
const collections = new Map();
const dirty = new Set();
let flushTimer = null;
let fresh = true;

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -5);
    if (!COLLECTION_RE.test(name)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        collections.set(name, parsed);
        fresh = false;
      }
    } catch (err) {
      // A corrupt file is kept aside rather than overwritten, so nothing is lost.
      const aside = path.join(DATA_DIR, `${file}.corrupt-${Date.now()}`);
      fs.renameSync(path.join(DATA_DIR, file), aside);
      console.error(`[bcos] ${file} was unreadable and moved to ${path.basename(aside)}:`, err.message);
    }
  }
}

function getCollection(name) {
  let col = collections.get(name);
  if (!col) { col = {}; collections.set(name, col); }
  return col;
}

function markDirty(name) {
  fresh = false;
  dirty.add(name);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 150);
}

function writeCollectionSync(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(collections.get(name) || {}));
  fs.renameSync(tmp, file);
}

function flush() {
  for (const name of [...dirty]) {
    dirty.delete(name);
    try { writeCollectionSync(name); }
    catch (err) { console.error(`[bcos] failed to write ${name}:`, err.message); dirty.add(name); }
  }
}

function dataBytes() {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  try { walk(DATA_DIR); } catch {}
  return total;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

function send(req, res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const type = headers['Content-Type'] || (typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  const out = { 'Content-Type': type, ...headers };
  if (buf.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    out['Content-Encoding'] = 'gzip';
    out['Vary'] = 'Accept-Encoding';
  }
  out['Content-Length'] = buf.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const json = (req, res, status, data) => send(req, res, status, data, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  try { return JSON.parse(buf.toString('utf8') || 'null'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// Static files are small and few, so each is gzipped once per mtime and kept.
const staticCache = new Map();

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(WWW_DIR, rel));
  if (!file.startsWith(WWW_DIR + path.sep)) return send(req, res, 403, 'Forbidden');

  let stat;
  try { stat = await fsp.stat(file); } catch { return send(req, res, 404, 'Not found'); }
  if (!stat.isFile()) return send(req, res, 404, 'Not found');

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // Revalidate everything: on a LAN a 304 costs nothing, and an update to the
  // app is visible on the next reload instead of whenever a cache expires.
  const headers = { 'Content-Type': type, 'ETag': etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

  const gzip = COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  let entry = staticCache.get(file);
  if (!entry || entry.etag !== etag) {
    const raw = await fsp.readFile(file);
    entry = { etag, raw, gz: COMPRESSIBLE.test(type) ? zlib.gzipSync(raw) : null };
    staticCache.set(file, entry);
  }
  const body = gzip && entry.gz ? entry.gz : entry.raw;
  if (gzip && entry.gz) { headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function snapshot() {
  const out = {};
  for (const [name, col] of collections) out[name] = Object.values(col);
  return out;
}

async function info() {
  let disk = null;
  try {
    const s = await fsp.statfs(DATA_DIR);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {}
  const counts = {};
  for (const [name, col] of collections) counts[name] = Object.keys(col).length;
  const cpus = os.cpus();
  return {
    version: VERSION,
    startedAt: STARTED_AT,
    serverUptime: Math.round((Date.now() - STARTED_AT) / 1000),
    hostUptime: Math.round(os.uptime()),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.arch()}`,
    cpu: cpus.length ? `${cpus.length} × ${cpus[0].model.trim() || 'CPU'}` : null,
    memory: { total: os.totalmem(), free: os.freemem() },
    load: os.loadavg(),
    node: process.version,
    dataBytes: dataBytes(),
    disk,
    counts,
  };
}

// Calendar subscriptions are fetched here so the browser isn't stopped by
// CORS. Only http(s) feeds that answer with calendar-ish text are passed on.
async function fetchFeed(rawUrl) {
  let url = String(rawUrl || '').trim().replace(/^webcals?:\/\//i, 'https://');
  let parsed;
  try { parsed = new URL(url); } catch { throw Object.assign(new Error('That isn’t a valid URL'), { status: 400 }); }
  if (!/^https?:$/.test(parsed.protocol)) throw Object.assign(new Error('Only http(s) and webcal links are supported'), { status: 400 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(parsed, { signal: ctrl.signal, headers: { 'User-Agent': `BCOS/${VERSION}`, 'Accept': 'text/calendar, text/plain, */*' }, redirect: 'follow' });
    if (!r.ok) throw Object.assign(new Error(`The feed answered ${r.status}`), { status: 502 });
    const text = await r.text();
    if (text.length > MAX_FEED) throw Object.assign(new Error('That feed is too large'), { status: 413 });
    if (!/BEGIN:VCALENDAR/i.test(text)) throw Object.assign(new Error('That link isn’t a calendar feed'), { status: 422 });
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error('The feed took too long to answer'), { status: 504 });
    if (err.status) throw err;
    throw Object.assign(new Error(`Couldn’t reach the feed (${err.cause?.code || err.message})`), { status: 502 });
  } finally { clearTimeout(timer); }
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const fileMetaPath = (id) => path.join(FILES_DIR, `${id}.meta.json`);
const filePath = (id) => path.join(FILES_DIR, `${id}.bin`);

async function api(req, res, pathname, query) {
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const [head, a, b] = parts;
  const method = req.method;

  if (head === 'health') return json(req, res, 200, { ok: true });

  if (head === 'data' && method === 'GET') {
    return json(req, res, 200, { collections: snapshot(), meta: { fresh, version: VERSION, serverTime: Date.now() } });
  }

  if (head === 'info' && method === 'GET') return json(req, res, 200, await info());

  if (head === 'c' && a && b) {
    if (!COLLECTION_RE.test(a) || !ID_RE.test(b)) return json(req, res, 400, { error: 'Bad collection or id' });
    if (method === 'PUT') {
      const item = await readJson(req);
      if (!item || typeof item !== 'object' || Array.isArray(item)) return json(req, res, 400, { error: 'Expected an object' });
      item.id = b;
      getCollection(a)[b] = item;
      markDirty(a);
      return json(req, res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      const col = collections.get(a);
      if (col && col[b]) { delete col[b]; markDirty(a); }
      return json(req, res, 200, { ok: true });
    }
  }

  if (head === 'import' && method === 'POST') {
    const body = await readJson(req);
    const incoming = body && body.collections;
    if (!incoming || typeof incoming !== 'object') return json(req, res, 400, { error: 'Expected { collections }' });
    for (const [name, items] of Object.entries(incoming)) {
      if (!COLLECTION_RE.test(name) || !Array.isArray(items)) continue;
      const col = {};
      for (const item of items) if (item && ID_RE.test(String(item.id))) col[item.id] = item;
      collections.set(name, col);
      markDirty(name);
    }
    return json(req, res, 200, { ok: true });
  }

  if (head === 'reset' && method === 'POST') {
    for (const name of collections.keys()) { collections.set(name, {}); markDirty(name); }
    await fsp.rm(FILES_DIR, { recursive: true, force: true });
    fs.mkdirSync(FILES_DIR, { recursive: true });
    fresh = true;
    return json(req, res, 200, { ok: true });
  }

  if (head === 'feed' && method === 'GET') {
    const text = await fetchFeed(query.get('url'));
    return send(req, res, 200, text, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  if (head === 'files') {
    if (!a && method === 'POST') {
      const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      if (!/^image\//.test(type)) return json(req, res, 415, { error: 'Only images can be uploaded' });
      const buf = await readBody(req, MAX_FILE);
      const id = (query.get('id') && FILE_ID_RE.test(query.get('id'))) ? query.get('id') : crypto.randomBytes(9).toString('base64url');
      await fsp.writeFile(filePath(id), buf);
      await fsp.writeFile(fileMetaPath(id), JSON.stringify({ type, size: buf.length, at: Date.now() }));
      return json(req, res, 200, { id, url: `api/files/${id}?v=${Date.now().toString(36)}` });
    }
    if (a && FILE_ID_RE.test(a)) {
      if (method === 'GET' || method === 'HEAD') {
        try {
          const meta = JSON.parse(await fsp.readFile(fileMetaPath(a), 'utf8'));
          const buf = await fsp.readFile(filePath(a));
          return send(req, res, 200, buf, { 'Content-Type': meta.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
        } catch { return send(req, res, 404, 'Not found'); }
      }
      if (method === 'DELETE') {
        await fsp.rm(filePath(a), { force: true });
        await fsp.rm(fileMetaPath(a), { force: true });
        return json(req, res, 200, { ok: true });
      }
    }
  }

  return json(req, res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadStore();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[bcos]', req.method, url.pathname, err);
    if (!res.headersSent) json(req, res, status, { error: err.message || 'Something went wrong' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[bcos] ${VERSION} listening on :${PORT} — www ${WWW_DIR}, data ${DATA_DIR}`);
});

function shutdown(signal) {
  console.log(`[bcos] ${signal}, saving and stopping`);
  clearTimeout(flushTimer);
  flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
