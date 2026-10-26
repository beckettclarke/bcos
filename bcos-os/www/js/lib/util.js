// Small helpers shared by every app.

export const uid = (prefix = '') => {
  const rand = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of rand) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36];
  return prefix + Date.now().toString(36).slice(-5) + s;
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Class names from strings, falsy values and { name: bool } maps. */
export function cx(...args) {
  const out = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') out.push(a);
    else if (typeof a === 'object') for (const k in a) if (a[k]) out.push(k);
  }
  return out.join(' ');
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); fn(...args); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function initials(name = '') {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// A stable, pleasant hue per string (for avatars and anything without a colour).
export function hashHue(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${plural(d, 'day')}${h ? `, ${plural(h, 'hour')}` : ''}`;
  if (h) return `${plural(h, 'hour')}${m ? `, ${m} min` : ''}`;
  return `${Math.max(1, m)} min`;
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

export const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Text with the first match of `query` split out, for highlighting. */
export function splitMatch(text = '', query = '') {
  if (!query) return [text, '', ''];
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return [text, '', ''];
  return [text.slice(0, i), text.slice(i, i + query.length), text.slice(i + query.length)];
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';

/** True when a keyboard event happened inside something you type into. */
export function isTyping(e) {
  const t = e.target;
  if (!t || !t.tagName) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

/** Resize an image file to fit `max` px and re-encode it, for uploads. */
export async function downscaleImage(file, max = 2560, quality = 0.86) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const type = file.type === 'image/png' && scale === 1 ? 'image/png' : 'image/jpeg';
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
