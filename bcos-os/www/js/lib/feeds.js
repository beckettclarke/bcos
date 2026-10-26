// Subscribed calendars (an .ics URL, e.g. a school timetable or a shared
// iCloud calendar). The server fetches the feed; events are parsed here and
// kept read-only in memory plus a localStorage cache, never in your data.

import { useEffect, useReducer } from './html.js';
import { all, patch, fetchFeed, status } from './store.js';
import { parseIcs } from './events.js';

const CACHE_KEY = 'bcos.feeds.v1';
const REFRESH_MS = 30 * 60 * 1000;
const feeds = new Map(); // calendarId → { fetchedAt, events }
const listeners = new Set();
const inflight = new Map();
let version = 0;

try {
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  for (const [id, v] of Object.entries(cached)) feeds.set(id, v);
} catch {}

function save() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(feeds))); } catch {}
}
function emit() { version++; listeners.forEach((fn) => fn()); }

export function feedEvents() {
  const out = [];
  for (const cal of all('calendars')) {
    if (cal.kind !== 'feed') continue;
    const f = feeds.get(cal.id);
    if (!f) continue;
    for (const ev of f.events) out.push(ev);
  }
  return out;
}

export function useFeeds() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { listeners.add(force); return () => listeners.delete(force); }, []);
  return version;
}

export async function refreshFeed(cal) {
  if (inflight.has(cal.id)) return inflight.get(cal.id);
  const p = (async () => {
    try {
      const text = await fetchFeed(cal.url);
      const events = parseIcs(text).map((ev, i) => ({
        ...ev,
        id: `feed-${cal.id}-${i}`,
        calendarId: cal.id,
        readOnly: true,
      }));
      feeds.set(cal.id, { fetchedAt: Date.now(), events });
      save();
      emit();
      if (cal.error) patch('calendars', cal.id, { error: null });
      return events.length;
    } catch (err) {
      patch('calendars', cal.id, { error: err.message });
      throw err;
    } finally {
      inflight.delete(cal.id);
    }
  })();
  inflight.set(cal.id, p);
  return p;
}

export function forgetFeed(id) {
  feeds.delete(id);
  save();
  emit();
}

/** Refresh any feed that is stale. Called on boot and every few minutes. */
export function refreshStaleFeeds() {
  if (status.mode !== 'server') return;
  for (const cal of all('calendars')) {
    if (cal.kind !== 'feed' || !cal.url) continue;
    const f = feeds.get(cal.id);
    if (!f || Date.now() - f.fetchedAt > REFRESH_MS) refreshFeed(cal).catch(() => {});
  }
}

setInterval(refreshStaleFeeds, 5 * 60 * 1000);
