// BCOS mail — real accounts over IMAP (reading) and SMTP (sending).
//
// Like server.js this has no dependencies: a small IMAP client, an SMTP
// client and a MIME parser, all on node:tls. Works with iCloud, Gmail, Yahoo,
// Fastmail and any standard IMAP/SMTP server that accepts an (app) password.
//
// Where things live:
// - Passwords and server settings: DATA_DIR/mail-accounts.json (0600). They
//   never go back to the browser.
// - Account info the UI shows (name, address, last sync, errors): the
//   `mail_accounts` collection.
// - Message list entries (headers, a text snippet for search, flags): the
//   `mail` collection, next to the local mailbox, tagged with `account`.
// - Full bodies (text, sanitisable HTML, attachment list): DATA_DIR/mail/<id>.json,
//   fetched on demand so the synced collection stays small.

'use strict';

const tls = require('node:tls');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PRESETS = {
  icloud: { name: 'iCloud', imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  gmail: { name: 'Gmail', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  yahoo: { name: 'Yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
  fastmail: { name: 'Fastmail', imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true } },
  other: { name: 'Mail', imap: null, smtp: null },
};

// How many recent messages to keep per folder.
const WINDOW = { inbox: 200, sent: 80, archive: 80, junk: 40, trash: 40 };
const FOLDER_ORDER = ['inbox', 'sent', 'junk', 'trash', 'archive'];
const FETCH_BYTES = 400 * 1024;      // partial fetch per message; text parts come first
const SNIPPET = 1200;                // characters of text kept in the list entry
const MAX_HTML = 600 * 1024;
const TIMEOUT = 45000;
const POLL_MS = 5 * 60 * 1000;

const err = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// IMAP response parser. A response is a line of tokens: atoms, "quoted"
// strings, {n} literals (returned as Buffers), (lists) and NIL (null).
// Status responses (OK/NO/BAD/BYE/PREAUTH) keep their text raw instead.
// ---------------------------------------------------------------------------

const CR = 13, LF = 10, SP = 32, LP = 40, RP = 41, DQ = 34, LB = 123, BS = 92, LSQ = 91, RSQ = 93;
const STATUS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);

/** Parse one response starting at `start`. Returns null if more data is needed. */
function parseResponse(buf, start) {
  // Status lines and continuations: take the line as text.
  const eol = buf.indexOf('\r\n', start);
  if (eol < 0) return null;
  const head = buf.toString('latin1', start, Math.min(eol, start + 40));
  const m = head.match(/^(\S+) (\S+)/);
  if (buf[start] === 0x2b /* + */ || (m && (STATUS.has(m[2].toUpperCase()) && !/\{\d+\+?\}$/.test(buf.toString('latin1', start, eol))))) {
    const line = buf.toString('utf8', start, eol);
    return { line, tokens: null, next: eol + 2 };
  }

  const root = [];
  const stack = [root];
  let i = start;
  const top = () => stack[stack.length - 1];
  while (true) {
    if (i >= buf.length) return null;
    const c = buf[i];
    if (c === CR) {
      if (i + 1 >= buf.length) return null;
      return { line: null, tokens: root, next: i + 2 };
    }
    if (c === SP) { i++; continue; }
    if (c === LP) { const l = []; top().push(l); stack.push(l); i++; continue; }
    if (c === RP) { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === DQ) {
      const parts = [];
      let j = i + 1, from = j;
      for (;; j++) {
        if (j >= buf.length) return null;
        if (buf[j] === BS) { parts.push(buf.subarray(from, j)); j++; from = j; continue; }
        if (buf[j] === DQ) break;
      }
      parts.push(buf.subarray(from, j));
      top().push(Buffer.concat(parts).toString('utf8'));
      i = j + 1;
      continue;
    }
    if (c === LB) {
      const close = buf.indexOf('}', i);
      if (close < 0) return null;
      const n = parseInt(buf.toString('latin1', i + 1, close), 10);
      const startLit = close + 3; // }\r\n
      if (buf.length < startLit + n) return null;
      top().push(buf.subarray(startLit, startLit + n));
      i = startLit + n;
      continue;
    }
    // Atom. Brackets (BODY[HEADER.FIELDS (A B)]) are part of the atom.
    let j = i, depth = 0;
    for (; j < buf.length; j++) {
      const d = buf[j];
      if (d === LSQ) depth++;
      else if (d === RSQ) depth--;
      else if (depth <= 0 && (d === SP || d === LP || d === RP || d === CR)) break;
    }
    if (j >= buf.length) return null;
    const atom = buf.toString('utf8', i, j);
    top().push(atom.toUpperCase() === 'NIL' ? null : atom);
    i = j;
  }
}

const str = (v) => (v == null ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/** IMAP quoted string. */
function q(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Modified UTF-7 (RFC 3501 §5.1.3) folder names → readable text.
function decodeFolderName(name) {
  return name.replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return '&';
    const bytes = Buffer.from(b.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

// ---------------------------------------------------------------------------
// IMAP client — one command at a time, which is all BCOS needs.
// ---------------------------------------------------------------------------

class Imap {
  constructor({ host, port, secure }) {
    this.host = host; this.port = port; this.secure = secure !== false;
    this.buf = Buffer.alloc(0);
    this.tag = 0;
    this.pending = null;   // { tag, untagged, resolve, reject, onContinue }
    this.greeting = null;
    this.caps = new Set();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const done = (e) => { clearTimeout(t); e ? reject(e) : resolve(); };
      const t = setTimeout(() => { this.destroy(); done(err(504, `${this.host} didn’t answer`)); }, 20000);
      const onConnectError = (e) => done(err(502, `Couldn’t reach ${this.host} (${e.code || e.message})`));
      const start = (sock) => {
        this.sock = sock;
        sock.setTimeout(TIMEOUT, () => { this.fail(err(504, 'The mail server stopped answering')); sock.destroy(); });
        sock.on('data', (d) => this.onData(d));
        sock.on('error', (e) => this.fail(err(502, `Connection to ${this.host} failed (${e.code || e.message})`)));
        sock.on('close', () => { this.closed = true; this.fail(err(502, 'The mail server closed the connection')); });
        this.greeting = { resolve: () => done(), reject: done };
      };
      if (this.secure) {
        const s = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {});
        s.once('error', onConnectError);
        start(s);
      } else {
        const s = net.connect({ host: this.host, port: this.port });
        s.once('error', onConnectError);
        start(s);
      }
    }).then(async () => {
      if (!this.secure) {
        await this.run('STARTTLS');
        await this.upgrade();
      }
      await this.capability();
    });
  }

  upgrade() {
    return new Promise((resolve, reject) => {
      const plain = this.sock;
      plain.removeAllListeners('data');
      const s = tls.connect({ socket: plain, servername: this.host }, () => resolve());
      s.once('error', (e) => reject(err(502, `TLS failed (${e.code || e.message})`)));
      s.on('data', (d) => this.onData(d));
      this.sock = s;
    });
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let pos = 0;
    while (pos < this.buf.length) {
      const r = parseResponse(this.buf, pos);
      if (!r) break;
      pos = r.next;
      this.handle(r);
    }
    this.buf = pos >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(pos);
  }

  handle(r) {
    if (this.greeting) {
      const g = this.greeting; this.greeting = null;
      if (r.line && /^\* (OK|PREAUTH)/i.test(r.line)) { this.parseCaps(r.line); g.resolve(); }
      else g.reject(err(502, `Unexpected greeting: ${r.line || '?'}`));
      return;
    }
    const p = this.pending;
    if (r.line && r.line.startsWith('+')) { p?.onContinue?.(r.line.slice(1).trim()); return; }
    if (r.line) {
      const [tag, status] = r.line.split(' ');
      if (p && tag === p.tag) {
        this.pending = null;
        const text = r.line.slice(tag.length + status.length + 2);
        if (status.toUpperCase() === 'OK') p.resolve({ untagged: p.untagged, text });
        else p.reject(Object.assign(err(status.toUpperCase() === 'NO' ? 422 : 502, text.replace(/^\[[^\]]*\]\s*/, '') || `${status} response`), { imapStatus: status, imapText: text }));
        return;
      }
      p?.untagged.push({ line: r.line });
      return;
    }
    p?.untagged.push({ tokens: r.tokens });
  }

  fail(e) {
    const p = this.pending; this.pending = null;
    if (p) p.reject(e);
    if (this.greeting) { const g = this.greeting; this.greeting = null; g.reject(e); }
  }

  /** Run a command. `literal` (Buffer) is sent after the server's "+". */
  run(cmd, { literal, onContinue } = {}) {
    if (this.closed) return Promise.reject(err(502, 'Not connected'));
    const tag = `B${++this.tag}`;
    return new Promise((resolve, reject) => {
      this.pending = { tag, untagged: [], resolve, reject, onContinue: onContinue || (literal ? () => { this.sock.write(literal); this.sock.write('\r\n'); } : null) };
      this.sock.write(`${tag} ${cmd}\r\n`);
    });
  }

  parseCaps(text) {
    const m = text.match(/\[CAPABILITY ([^\]]+)\]/i);
    if (m) this.caps = new Set(m[1].toUpperCase().split(' '));
  }

  async capability() {
    const r = await this.run('CAPABILITY');
    for (const u of r.untagged) {
      if (u.tokens && str(u.tokens[1]).toUpperCase() === 'CAPABILITY') this.caps = new Set(u.tokens.slice(2).map((t) => str(t).toUpperCase()));
    }
  }

  async login(user, pass) {
    try {
      if (this.caps.has('AUTH=PLAIN')) {
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        await this.run('AUTHENTICATE PLAIN', { onContinue: () => this.sock.write(`${token}\r\n`) });
      } else {
        await this.run(`LOGIN ${q(user)} ${q(pass)}`);
      }
    } catch (e) {
      if (e.imapStatus) throw err(401, `Sign-in failed: ${e.message}`);
      throw e;
    }
    await this.capability();
  }

  async list() {
    const r = await this.run('LIST "" "*"');
    const out = [];
    for (const u of r.untagged) {
      const t = u.tokens;
      if (!t || str(t[1]).toUpperCase() !== 'LIST') continue;
      const flags = (Array.isArray(t[2]) ? t[2] : []).map((f) => str(f).toLowerCase());
      const name = str(t[4]);
      if (flags.includes('\\noselect') || flags.includes('\\nonexistent')) continue;
      out.push({ name, flags, display: decodeFolderName(name) });
    }
    return out;
  }

  async select(folder, readOnly = false) {
    const r = await this.run(`${readOnly ? 'EXAMINE' : 'SELECT'} ${q(folder)}`);
    let uidValidity = null, exists = 0;
    for (const u of r.untagged) {
      if (u.line) { const m = u.line.match(/\[UIDVALIDITY (\d+)\]/i); if (m) uidValidity = m[1]; }
      else if (u.tokens && str(u.tokens[2]).toUpperCase() === 'EXISTS') exists = Number(u.tokens[1]);
    }
    return { uidValidity, exists };
  }

  async searchAll() {
    const r = await this.run('UID SEARCH ALL');
    const uids = [];
    for (const u of r.untagged) {
      if (u.tokens && str(u.tokens[1]).toUpperCase() === 'SEARCH') for (const n of u.tokens.slice(2)) uids.push(Number(n));
    }
    return uids.sort((a, b) => a - b);
  }

  /** UID FETCH → [{ uid, flags, internaldate, body }] */
  async fetch(uids, items) {
    if (!uids.length) return [];
    const r = await this.run(`UID FETCH ${compressUids(uids)} (${items})`);
    const out = [];
    for (const u of r.untagged) {
      const t = u.tokens;
      if (!t || str(t[2]).toUpperCase() !== 'FETCH' || !Array.isArray(t[3])) continue;
      const kv = t[3];
      const msg = {};
      for (let i = 0; i + 1 < kv.length; i += 2) {
        const k = str(kv[i]).toUpperCase();
        const v = kv[i + 1];
        if (k === 'UID') msg.uid = Number(v);
        else if (k === 'FLAGS') msg.flags = (v || []).map((f) => str(f));
        else if (k === 'INTERNALDATE') msg.internaldate = Date.parse(str(v));
        else if (k.startsWith('BODY[')) msg.body = Buffer.isBuffer(v) ? v : Buffer.from(str(v), 'utf8');
      }
      if (msg.uid) out.push(msg);
    }
    return out;
  }

  async store(uid, op, flags) {
    await this.run(`UID STORE ${uid} ${op}FLAGS.SILENT (${flags})`);
  }

  /** Move a message; returns its new UID when the server reports it. */
  async move(uid, dest) {
    const pick = (texts) => {
      for (const s of texts) {
        const m = s && s.match(/\[COPYUID \d+ (\S+) (\S+)\]/i);
        if (m && /^\d+$/.test(m[2])) return Number(m[2]);
      }
      return null;
    };
    if (this.caps.has('MOVE')) {
      const r = await this.run(`UID MOVE ${uid} ${q(dest)}`);
      return pick([r.text, ...r.untagged.map((u) => u.line)]);
    }
    const r = await this.run(`UID COPY ${uid} ${q(dest)}`);
    await this.expunge(uid);
    return pick([r.text]);
  }

  async expunge(uid) {
    await this.store(uid, '+', '\\Deleted');
    if (this.caps.has('UIDPLUS')) await this.run(`UID EXPUNGE ${uid}`);
    else await this.run('EXPUNGE');
  }

  async append(folder, raw, flags = '\\Seen') {
    await this.run(`APPEND ${q(folder)} (${flags}) {${raw.length}}`, { literal: raw });
  }

  async logout() {
    try { await Promise.race([this.run('LOGOUT'), new Promise((r) => setTimeout(r, 1500))]); } catch {}
    this.destroy();
  }

  destroy() { this.closed = true; try { this.sock?.destroy(); } catch {} }
}

function compressUids(uids) {
  const sorted = [...uids].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}:${sorted[j]}`);
    i = j;
  }
  return out.join(',');
}

// ---------------------------------------------------------------------------
// SMTP client
// ---------------------------------------------------------------------------

class Smtp {
  constructor({ host, port, secure }) { this.host = host; this.port = port; this.secure = !!secure; this.buf = ''; this.waiter = null; }

  connect() {
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(err(502, `Couldn’t reach ${this.host} (${e.code || e.message})`));
      const s = this.secure ? tls.connect({ host: this.host, port: this.port, servername: this.host }) : net.connect({ host: this.host, port: this.port });
      s.once('error', onErr);
      s.setTimeout(TIMEOUT, () => { s.destroy(); this.waiter?.reject(err(504, 'The mail server stopped answering')); });
      this.attach(s);
      this.read().then((r) => { s.removeListener('error', onErr); s.on('error', (e) => this.waiter?.reject(err(502, e.message))); r.code === 220 ? resolve() : reject(err(502, r.text)); }, reject);
    });
  }

  attach(s) {
    this.sock = s;
    s.on('data', (d) => { this.buf += d.toString('utf8'); this.drain(); });
  }

  drain() {
    if (!this.waiter) return;
    const lines = this.buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const block = lines.slice(0, i + 1);
        this.buf = lines.slice(i + 1).join('\r\n');
        const w = this.waiter; this.waiter = null;
        w.resolve({ code: Number(lines[i].slice(0, 3)), text: block.map((l) => l.slice(4)).join('\n'), lines: block });
        return;
      }
    }
  }

  read() { return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.drain(); }); }

  async cmd(line, expect) {
    this.sock.write(`${line}\r\n`);
    const r = await this.read();
    if (expect && !expect.includes(r.code)) throw err(r.code === 535 ? 401 : 502, `${line.split(' ')[0]} failed: ${r.text}`);
    return r;
  }

  async hello() {
    const r = await this.cmd('EHLO bcos.local', [250]);
    this.ext = r.text.toUpperCase();
  }

  async login(user, pass) {
    await this.hello();
    if (!this.secure) {
      if (!/STARTTLS/.test(this.ext)) throw err(502, `${this.host} doesn’t offer encryption, so BCOS won’t send your password to it`);
      await this.cmd('STARTTLS', [220]);
      await new Promise((resolve, reject) => {
        const plain = this.sock;
        plain.removeAllListeners('data');
        const s = tls.connect({ socket: plain, servername: this.host }, resolve);
        s.once('error', (e) => reject(err(502, `TLS failed (${e.message})`)));
        this.attach(s);
      });
      await this.hello();
    }
    try {
      if (/AUTH[^\n]*PLAIN/.test(this.ext)) {
        await this.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
      } else {
        await this.cmd('AUTH LOGIN', [334]);
        await this.cmd(Buffer.from(user).toString('base64'), [334]);
        await this.cmd(Buffer.from(pass).toString('base64'), [235]);
      }
    } catch (e) { throw err(401, `Sign-in to ${this.host} failed — check the password`); }
  }

  async send(from, rcpts, raw) {
    await this.cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of rcpts) await this.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await this.cmd('DATA', [354]);
    const body = raw.toString('utf8').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.sock.write(body.endsWith('\r\n') ? body : `${body}\r\n`);
    const r = await this.cmd('.', [250]);
    return r;
  }

  async quit() { try { this.sock.write('QUIT\r\n'); } catch {} setTimeout(() => this.sock?.destroy(), 500); }
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

function decodeCharset(buf, charset) {
  let cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  if (cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8';
  try { return new TextDecoder(cs).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

function decodeQP(s) {
  const bytes = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { bytes.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
    else { const code = t.charCodeAt(i); if (code < 256) bytes.push(code); else bytes.push(...Buffer.from(c, 'utf8')); }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words: =?utf-8?B?...?= */
function decodeWords(s) {
  if (!s || !s.includes('=?')) return s || '';
  return s
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, text) => {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQP(text.replace(/_/g, ' '));
      return decodeCharset(buf, cs);
    });
}

function parseHeaders(text) {
  const out = {};
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    (out[k] ||= []).push(line.slice(i + 1).trim());
  }
  return out;
}
const h1 = (hs, k) => (hs[k] ? hs[k][0] : '');

/** "text/plain; charset=utf-8; name*=utf-8''r%C3%A9sum%C3%A9.pdf" */
function parseParams(value) {
  const parts = [];
  let cur = '', inQ = false;
  for (const ch of value || '') {
    if (ch === '"') inQ = !inQ;
    if (ch === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const params = {};
  const cont = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim().replace(/^"(.*)"$/s, '$1');
    const m = k.match(/^([^*]+)\*(\d+)?(\*)?$/);
    if (m) {
      // RFC 2231: name*=charset''value, possibly split into name*0*, name*1*
      if (m[3] || (!m[2] && k.endsWith('*'))) {
        const mm = v.match(/^([^']*)'[^']*'(.*)$/);
        const cs = mm ? mm[1] : (cont[m[1]]?.cs || 'utf-8');
        if (mm) v = mm[2];
        const bytes = [];
        for (let k = 0; k < v.length; k++) {
          if (v[k] === '%' && /^[0-9a-f]{2}$/i.test(v.substr(k + 1, 2))) { bytes.push(parseInt(v.substr(k + 1, 2), 16)); k += 2; }
          else bytes.push(v.charCodeAt(k) & 255);
        }
        v = decodeCharset(Buffer.from(bytes), cs);
        cont[m[1]] = { cs, parts: [...(cont[m[1]]?.parts || []), [Number(m[2] || 0), v]] };
      } else {
        cont[m[1]] = { cs: cont[m[1]]?.cs, parts: [...(cont[m[1]]?.parts || []), [Number(m[2] || 0), v]] };
      }
      continue;
    }
    params[k] = decodeWords(v);
  }
  for (const [k, c] of Object.entries(cont)) params[k] = c.parts.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('');
  return { value: parts[0].trim().toLowerCase(), params };
}

function splitHead(buf) {
  let i = buf.indexOf('\r\n\r\n'), sep = 4;
  const j = buf.indexOf('\n\n');
  if (i < 0 || (j >= 0 && j < i)) { i = j; sep = 2; }
  if (i < 0) return { head: buf.toString('latin1'), body: Buffer.alloc(0) };
  return { head: buf.toString('latin1', 0, i), body: buf.subarray(i + sep) };
}

function decodeBody(buf, encoding) {
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQP(buf.toString('latin1'));
  return buf;
}

/** Walk a MIME tree, collecting the readable text, the HTML, and attachments. */
function parseMime(raw) {
  const out = { headers: {}, text: '', html: '', attachments: [], inline: {} };
  const walk = (buf, depth, isRoot) => {
    const { head, body } = splitHead(buf);
    // Header bytes are often UTF-8 even though they shouldn't be.
    const hs = parseHeaders(Buffer.from(head, 'latin1').toString('utf8'));
    if (isRoot) out.headers = hs;
    const ct = parseParams(h1(hs, 'content-type') || 'text/plain');
    const disp = parseParams(h1(hs, 'content-disposition'));
    const enc = h1(hs, 'content-transfer-encoding');
    if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 12) {
      const b = Buffer.from(`--${ct.params.boundary}`);
      let pos = body.indexOf(b);
      while (pos >= 0) {
        let start = pos + b.length;
        if (body[start] === 45 && body[start + 1] === 45) break; // closing --boundary--
        while (body[start] === 13 || body[start] === 10 || body[start] === 32 || body[start] === 9) { if (body[start] === 10) { start++; break; } start++; }
        const next = body.indexOf(b, start);
        let end = next < 0 ? body.length : next;
        if (body[end - 1] === 10) end--;
        if (body[end - 1] === 13) end--;
        walk(body.subarray(start, end), depth + 1, false);
        pos = next;
      }
      return;
    }
    const name = decodeWords(disp.params.filename || ct.params.name || '');
    const isAttachment = disp.value === 'attachment' || (name && !ct.value.startsWith('text/'));
    if (!isAttachment && ct.value === 'text/plain' && !out.text) { out.text = decodeCharset(decodeBody(body, enc), ct.params.charset); return; }
    if (!isAttachment && ct.value === 'text/html' && !out.html) { out.html = decodeCharset(decodeBody(body, enc), ct.params.charset); return; }
    if (ct.value.startsWith('text/') && !name) return;
    const cid = h1(hs, 'content-id').replace(/^<|>$/g, '');
    const data = decodeBody(body, enc);
    if (cid && ct.value.startsWith('image/') && data.length < 400 * 1024) out.inline[cid] = `data:${ct.value};base64,${data.toString('base64')}`;
    if (name || !cid) out.attachments.push({ name: name || 'attachment', type: ct.value, size: data.length });
  };
  walk(raw, 0, true);
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: '' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Name <a@b>, "Last, First" <c@d>, e@f" */
function parseAddressList(s) {
  if (!s) return [];
  const out = [];
  let cur = '', inQ = false, inA = false;
  const push = () => {
    const t = cur.trim(); cur = '';
    if (!t) return;
    const m = t.match(/^(.*?)\s*<([^>]*)>\s*$/);
    let name = m ? m[1] : '', email = m ? m[2] : t;
    name = decodeWords(name.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')).trim();
    email = email.trim().replace(/^.*:/, '');
    if (email.includes('@')) out.push({ name, email });
  };
  for (const ch of s) {
    if (ch === '"' && !inA) inQ = !inQ;
    else if (ch === '<' && !inQ) inA = true;
    else if (ch === '>' && !inQ) inA = false;
    if ((ch === ',' || ch === ';') && !inQ && !inA) { push(); continue; }
    cur += ch;
  }
  push();
  return out;
}

// ---------------------------------------------------------------------------
// Building outgoing messages
// ---------------------------------------------------------------------------

const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
function fmtAddr(a) {
  if (!a.name) return a.email;
  const name = /^[\w .'-]*$/.test(a.name) ? a.name : /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, '')}"` : encWord(a.name);
  return `${name} <${a.email}>`;
}
const b64lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

function buildMessage({ from, to, cc, subject, text, inReplyTo, references, messageId }) {
  const domain = (from.email.split('@')[1] || 'bcos.local');
  const id = messageId || `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;
  const headers = [
    `From: ${fmtAddr(from)}`,
    `To: ${to.map(fmtAddr).join(', ')}`,
    cc?.length ? `Cc: ${cc.map(fmtAddr).join(', ')}` : null,
    `Subject: ${encWord(subject || '')}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'User-Agent: BCOS',
  ].filter(Boolean);
  const raw = `${headers.join('\r\n')}\r\n\r\n${b64lines(Buffer.from(text || '', 'utf8'))}\r\n`;
  return { raw: Buffer.from(raw, 'utf8'), messageId: id };
}

// ---------------------------------------------------------------------------
// Accounts, sync and actions
// ---------------------------------------------------------------------------

function createMail({ DATA_DIR, getCollection, markDirty }) {
  const SECRETS = path.join(DATA_DIR, 'mail-accounts.json');
  const BODIES = path.join(DATA_DIR, 'mail');
  fs.mkdirSync(BODIES, { recursive: true });

  let secrets = {};
  try { secrets = JSON.parse(fs.readFileSync(SECRETS, 'utf8')) || {}; } catch {}
  const saveSecrets = () => {
    const tmp = `${SECRETS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
    fs.renameSync(tmp, SECRETS);
  };

  const accounts = () => getCollection('mail_accounts');
  const mail = () => getCollection('mail');
  const bodyPath = (id) => path.join(BODIES, `${id}.json`);

  function setPublic(id, changes) {
    const col = accounts();
    col[id] = { ...(col[id] || { id }), ...changes, id, updatedAt: Date.now() };
    markDirty('mail_accounts');
    return col[id];
  }

  function putItem(item) {
    const now = Date.now();
    const next = { ...item, createdAt: item.createdAt || now, updatedAt: now };
    mail()[next.id] = next;
    markDirty('mail');
    return next;
  }
  function dropItem(id) {
    delete mail()[id];
    markDirty('mail');
    fsp.rm(bodyPath(id), { force: true }).catch(() => {});
  }

  async function withImap(acct, fn) {
    const c = new Imap(acct.imap);
    await c.connect();
    try {
      await c.login(acct.user, acct.pass);
      return await fn(c);
    } finally { c.logout(); }
  }

  /** Map special folders to BCOS mailboxes from LIST attributes (RFC 6154) or names. */
  function mapFolders(list) {
    const byFlag = (f) => list.find((x) => x.flags.includes(f))?.name;
    const byName = (re) => list.find((x) => re.test(x.display))?.name;
    const gmailAll = list.find((x) => x.flags.includes('\\all'))?.name;
    return {
      inbox: list.find((x) => x.name.toUpperCase() === 'INBOX')?.name || 'INBOX',
      sent: byFlag('\\sent') || byName(/^(sent( messages| mail| items)?|\[gmail\]\/sent mail)$/i),
      drafts: byFlag('\\drafts') || byName(/^drafts$/i),
      trash: byFlag('\\trash') || byName(/^(trash|deleted( messages| items)?|bin)$/i),
      junk: byFlag('\\junk') || byName(/^(junk|spam|bulk( mail)?)$/i),
      archive: byFlag('\\archive') || byName(/^archive$/i) || gmailAll,
    };
  }

  async function testAndDescribe(acct) {
    return withImap(acct, async (c) => mapFolders(await c.list()));
  }

  const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const clean = (s, n = 200) => String(s || '').trim().slice(0, n);

  async function saveAccount(body, id) {
    const existing = id ? secrets[id] : null;
    if (id && !existing) throw err(404, 'No such account');
    const provider = PRESETS[body.provider] ? body.provider : existing?.provider || 'other';
    const preset = PRESETS[provider];
    const email = clean(body.email || existing?.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw err(400, 'Enter your full email address');
    const pass = body.password ? String(body.password).replace(/\s+/g, provider === 'gmail' ? '' : ' ').trim() : existing?.pass;
    if (!pass) throw err(400, 'Enter the password (an app-specific password for iCloud, Gmail and Yahoo)');
    const server = (s, fallback) => {
      if (!s || !s.host) return fallback;
      const host = clean(s.host, 255).toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(host)) throw err(400, `“${host}” isn’t a valid server name`);
      return { host, port: Number(s.port) || fallback?.port || 993, secure: s.secure !== false };
    };
    const imap = provider === 'other' ? server(body.imap, existing?.imap) : preset.imap;
    const smtp = provider === 'other' ? server(body.smtp, existing?.smtp) : preset.smtp;
    if (!imap?.host || !smtp?.host) throw err(400, 'Enter the IMAP and SMTP servers');

    const users = clean(body.username || existing?.user) ? [clean(body.username || existing?.user)] : [email];
    // iCloud's docs ask for the part before the @, but the full address
    // usually works; try both before giving up.
    if (provider === 'icloud' && !body.username) users.push(email.split('@')[0]);

    let folders = null, user = null, lastErr = null;
    for (const u of users) {
      try { folders = await testAndDescribe({ imap, user: u, pass }); user = u; break; }
      catch (e) { lastErr = e; if (e.status !== 401) break; }
    }
    if (!folders) {
      if (lastErr?.status === 401) {
        const hint = { icloud: ' Use an app-specific password from account.apple.com → Sign-In and Security.', gmail: ' Use an app password from myaccount.google.com/apppasswords (needs 2-Step Verification).', yahoo: ' Use an app password from Yahoo Account Security.', fastmail: ' Use an app password from Fastmail Settings → Privacy & Security.' }[provider] || '';
        throw err(401, `${provider === 'other' ? imap.host : preset.name} didn’t accept that email and password.${hint}`);
      }
      throw lastErr;
    }
    // Check sending too, so a bad SMTP setting shows up now rather than on first send.
    const s = new Smtp(smtp);
    try { await s.connect(); await s.login(user, pass); } finally { s.quit(); }

    id = id || `a${crypto.randomBytes(6).toString('hex')}`;
    const name = clean(body.name || existing?.name || email.split('@')[0], 80);
    secrets[id] = { id, provider, email, name, user, pass, imap, smtp, folders, uidValidity: existing?.uidValidity || {} };
    saveSecrets();
    return setPublic(id, { provider, email, name, label: clean(body.label, 40) || preset.name, server: imap.host, folders: Object.fromEntries(Object.entries(folders).filter(([, v]) => v)), error: null });
  }

  function deleteAccount(id) {
    if (!ACCOUNT_RE.test(id)) throw err(400, 'Bad account');
    delete secrets[id];
    saveSecrets();
    delete accounts()[id];
    markDirty('mail_accounts');
    for (const m of Object.values(mail())) if (m.account === id) dropItem(m.id);
  }

  const syncing = new Map();

  function sync(id) {
    if (syncing.has(id)) return syncing.get(id);
    const p = doSync(id).finally(() => syncing.delete(id));
    syncing.set(id, p);
    return p;
  }

  async function doSync(id) {
    const acct = secrets[id];
    if (!acct) throw err(404, 'No such account');
    setPublic(id, { syncing: true });
    try {
      let added = 0;
      await withImap(acct, async (c) => {
        acct.folders = mapFolders(await c.list());
        const isGmail = /gmail\.com$/.test(acct.imap.host);
        for (const box of FOLDER_ORDER) {
          const folder = acct.folders[box];
          if (!folder) continue;
          added += await syncFolder(c, acct, box, folder, { dedupe: isGmail && box === 'archive' });
        }
      });
      saveSecrets();
      setPublic(id, { syncing: false, lastSync: Date.now(), error: null, folders: Object.fromEntries(Object.entries(acct.folders).filter(([, v]) => v)) });
      return { added };
    } catch (e) {
      setPublic(id, { syncing: false, error: e.message, errorAt: Date.now() });
      throw e;
    }
  }

  async function syncFolder(c, acct, box, folder, { dedupe }) {
    const { uidValidity } = await c.select(folder, true);
    const all = await c.searchAll();
    const keep = all.slice(-WINDOW[box]);
    const keepSet = new Set(keep);

    const mine = Object.values(mail()).filter((m) => m.account === acct.id && m.folder === folder);
    if (acct.uidValidity[folder] && uidValidity && acct.uidValidity[folder] !== uidValidity) {
      for (const m of mine) dropItem(m.id);
      mine.length = 0;
    }
    acct.uidValidity[folder] = uidValidity;

    const byUid = new Map();
    const unplaced = new Map(); // moved here by BCOS, waiting to learn their UID
    for (const m of mine) {
      if (m.uid == null) { if (m.messageId) unplaced.set(m.messageId, m); }
      else if (!keepSet.has(m.uid)) dropItem(m.id);
      else byUid.set(m.uid, m);
    }

    // Flags for what we already have.
    const known = keep.filter((u) => byUid.has(u));
    for (let i = 0; i < known.length; i += 500) {
      for (const f of await c.fetch(known.slice(i, i + 500), 'UID FLAGS')) {
        const m = byUid.get(f.uid);
        const read = f.flags.includes('\\Seen');
        const starred = f.flags.includes('\\Flagged');
        if (m && (m.read !== read || m.starred !== starred)) putItem({ ...m, read, starred });
      }
    }

    // Message IDs elsewhere in this account, to skip duplicates in Gmail's All Mail.
    const seenIds = dedupe ? new Set(Object.values(mail()).filter((m) => m.account === acct.id && m.folder !== folder).map((m) => m.messageId).filter(Boolean)) : null;

    const fresh = keep.filter((u) => !byUid.has(u)).reverse(); // newest first
    let added = 0;
    for (let i = 0; i < fresh.length; i += 20) {
      const batch = await c.fetch(fresh.slice(i, i + 20), `UID FLAGS INTERNALDATE BODY.PEEK[]<0.${FETCH_BYTES}>`);
      for (const f of batch) {
        if (!f.body) continue;
        const parsed = parseMime(f.body);
        const hs = parsed.headers;
        const messageId = h1(hs, 'message-id');
        if (seenIds && messageId && seenIds.has(messageId)) continue;
        const pending = messageId && unplaced.get(messageId);
        const id = pending ? pending.id : `x${crypto.createHash('sha1').update(`${acct.id}\n${folder}\n${uidValidity}\n${f.uid}`).digest('hex').slice(0, 20)}`;
        if (pending) unplaced.delete(messageId);
        const text = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
        let html = parsed.html || '';
        for (const [cid, data] of Object.entries(parsed.inline)) html = html.split(`cid:${cid}`).join(data);
        if (html.length > MAX_HTML) html = '';
        const date = Date.parse(h1(hs, 'date')) || f.internaldate || Date.now();
        const item = {
          id,
          account: acct.id,
          folder,
          uid: f.uid,
          mailbox: box,
          read: f.flags.includes('\\Seen'),
          starred: f.flags.includes('\\Flagged'),
          date: Math.min(date, Date.now() + 60000),
          from: parseAddressList(h1(hs, 'from'))[0] || { name: '', email: '' },
          to: parseAddressList(h1(hs, 'to')),
          cc: parseAddressList(h1(hs, 'cc')),
          replyTo: parseAddressList(h1(hs, 'reply-to'))[0] || null,
          subject: decodeWords(h1(hs, 'subject')),
          body: text.slice(0, SNIPPET),
          messageId,
          references: [h1(hs, 'references'), messageId].filter(Boolean).join(' ').slice(-900),
          attachments: parsed.attachments.slice(0, 20).map((a) => ({ name: a.name, size: a.size })),
          hasHtml: !!html,
          remote: true,
        };
        await fsp.writeFile(bodyPath(id), JSON.stringify({ text, html, attachments: parsed.attachments, truncated: f.body.length >= FETCH_BYTES }));
        putItem(pending ? { ...pending, ...item } : item);
        added++;
      }
    }
    // Anything still unplaced wasn't found here; the next sync of its old folder would have it.
    for (const m of unplaced.values()) dropItem(m.id);
    return added;
  }

  async function body(id) {
    const m = mail()[id];
    if (!m || !m.account) throw err(404, 'No such message');
    try { return JSON.parse(await fsp.readFile(bodyPath(id), 'utf8')); } catch {}
    const acct = secrets[m.account];
    if (!acct || m.uid == null) return { text: m.body || '', html: '', attachments: [] };
    return withImap(acct, async (c) => {
      await c.select(m.folder, true);
      const [f] = await c.fetch([m.uid], `UID BODY.PEEK[]<0.${FETCH_BYTES}>`);
      if (!f?.body) return { text: m.body || '', html: '', attachments: [] };
      const parsed = parseMime(f.body);
      const text = parsed.text || htmlToText(parsed.html || '');
      const out = { text, html: parsed.html.length <= MAX_HTML ? parsed.html : '', attachments: parsed.attachments };
      await fsp.writeFile(bodyPath(id), JSON.stringify(out));
      return out;
    });
  }

  async function action(id, op, args = {}) {
    const m = mail()[id];
    if (!m || !m.account) throw err(404, 'No such message');
    const acct = secrets[m.account];
    if (!acct) throw err(404, 'That account was removed');
    if (m.uid == null) throw err(409, 'That message is still being moved — try again after the next sync');
    return withImap(acct, async (c) => {
      await c.select(m.folder);
      if (op === 'flags') {
        const next = { ...m };
        if (typeof args.read === 'boolean') { await c.store(m.uid, args.read ? '+' : '-', '\\Seen'); next.read = args.read; }
        if (typeof args.starred === 'boolean') { await c.store(m.uid, args.starred ? '+' : '-', '\\Flagged'); next.starred = args.starred; }
        return { item: putItem(next) };
      }
      if (op === 'move') {
        const dest = acct.folders[args.to];
        if (!dest) throw err(422, `This account has no ${args.to} folder`);
        if (dest === m.folder) return { item: m };
        const uid = await c.move(m.uid, dest);
        return { item: putItem({ ...m, folder: dest, mailbox: args.to, uid }) };
      }
      if (op === 'delete') {
        await c.expunge(m.uid);
        dropItem(id);
        return { removed: id };
      }
      throw err(400, 'Unknown action');
    });
  }

  async function send(body) {
    const acct = secrets[body.account];
    if (!acct) throw err(404, 'Choose an account to send from');
    const to = (body.to || []).filter((a) => a && /@/.test(a.email));
    const cc = (body.cc || []).filter((a) => a && /@/.test(a.email));
    const bcc = (body.bcc || []).filter((a) => a && /@/.test(a.email));
    if (!to.length && !cc.length && !bcc.length) throw err(400, 'Add at least one recipient');
    const from = { name: acct.name, email: acct.email };
    const { raw, messageId } = buildMessage({ from, to, cc, subject: body.subject, text: body.text, inReplyTo: body.inReplyTo, references: body.references });
    const s = new Smtp(acct.smtp);
    try {
      await s.connect();
      await s.login(acct.user, acct.pass);
      await s.send(acct.email, [...to, ...cc, ...bcc].map((a) => a.email), raw);
    } finally { s.quit(); }
    // Gmail files sent mail itself; everyone else needs a copy appended.
    const isGmail = /gmail\.com$/.test(acct.imap.host);
    if (!isGmail && acct.folders.sent) {
      try { await withImap(acct, (c) => c.append(acct.folders.sent, raw)); } catch (e) { console.warn('[bcos] couldn’t save to Sent:', e.message); }
    }
    sync(acct.id).catch(() => {});
    return { ok: true, messageId };
  }

  // Keep every account fresh in the background, even with no browser open.
  setInterval(() => { for (const id of Object.keys(secrets)) sync(id).catch(() => {}); }, POLL_MS).unref();
  setTimeout(() => { for (const id of Object.keys(secrets)) sync(id).catch(() => {}); }, 4000).unref();

  async function reset() {
    secrets = {};
    saveSecrets();
    await fsp.rm(BODIES, { recursive: true, force: true });
    fs.mkdirSync(BODIES, { recursive: true });
  }

  return {
    reset,
    presets: () => Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { name: v.name, imap: v.imap, smtp: v.smtp }])),
    saveAccount, deleteAccount, sync, body, action, send,
    hasAccount: (id) => !!secrets[id],
  };
}

module.exports = { createMail, parseMime, parseResponse, parseAddressList, decodeWords, buildMessage, htmlToText };
