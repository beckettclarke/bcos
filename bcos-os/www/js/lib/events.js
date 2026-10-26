// Calendar logic shared by the Calendar app, widgets and search:
// repeating-event expansion, overlap layout, and .ics parsing.

import { DAY, startOfDay, addDays, dayKey, daysInMonth } from './date.js';

export const CAL_COLORS = ['#3b82f6', '#f2783c', '#22c55e', '#ec4899', '#a855f7', '#14b8a6', '#eab308', '#ef4444', '#64748b'];

export const REPEAT_PRESETS = [
  { id: 'none', label: 'Never' },
  { id: 'day', label: 'Every day' },
  { id: 'weekdays', label: 'Every weekday' },
  { id: 'week', label: 'Every week' },
  { id: 'biweek', label: 'Every 2 weeks' },
  { id: 'month', label: 'Every month' },
  { id: 'year', label: 'Every year' },
];

export function presetToRule(id, start) {
  const wd = new Date(start).getDay();
  switch (id) {
    case 'day': return { freq: 'day', interval: 1 };
    case 'weekdays': return { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] };
    case 'week': return { freq: 'week', interval: 1, days: [wd] };
    case 'biweek': return { freq: 'week', interval: 2, days: [wd] };
    case 'month': return { freq: 'month', interval: 1 };
    case 'year': return { freq: 'year', interval: 1 };
    default: return null;
  }
}

export function ruleToPreset(rule) {
  if (!rule) return 'none';
  const days = rule.days || [];
  if (rule.freq === 'day' && rule.interval === 1) return 'day';
  if (rule.freq === 'week' && rule.interval === 1 && days.join() === '1,2,3,4,5') return 'weekdays';
  if (rule.freq === 'week' && days.length <= 1) return rule.interval === 2 ? 'biweek' : rule.interval === 1 ? 'week' : 'custom';
  if (rule.freq === 'month' && rule.interval === 1) return 'month';
  if (rule.freq === 'year' && rule.interval === 1) return 'year';
  return 'custom';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function describeRule(rule) {
  if (!rule) return 'Does not repeat';
  const n = rule.interval || 1;
  const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[rule.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (rule.freq === 'week' && rule.days?.length) {
    s += rule.days.join() === '1,2,3,4,5' && n === 1 ? ' on weekdays' : ` on ${rule.days.map((d) => DAY_NAMES[d]).join(', ')}`;
  }
  if (rule.until) s += `, until ${new Date(rule.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (rule.count) s += `, ${rule.count} times`;
  return s;
}

/** Step a date forward by whole months/years, clamping to short months. */
function stepCalendar(d, months) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + months);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
}

/**
 * Every occurrence of `events` that overlaps [from, to). Each occurrence is a
 * shallow copy with its own start/end, plus `occurrenceKey` and `series`.
 */
export function expand(events, from, to) {
  const out = [];
  for (const ev of events) {
    const dur = Math.max(0, ev.end - ev.start);
    const rule = ev.recurrence;
    if (!rule) {
      if (ev.start < to && (ev.end > from || (dur === 0 && ev.start >= from))) out.push({ ...ev, occurrenceKey: ev.id, series: ev });
      continue;
    }
    const ex = new Set(ev.exdates || []);
    const until = rule.until ? rule.until + DAY : Infinity;
    const interval = Math.max(1, rule.interval || 1);
    let emitted = 0;
    const push = (s) => {
      emitted++;
      if (s + dur <= from && !(dur === 0 && s >= from)) return;
      if (ex.has(dayKey(s))) return;
      out.push({ ...ev, start: s, end: s + dur, occurrenceKey: `${ev.id}:${dayKey(s)}`, series: ev, isOccurrence: true });
    };
    const done = (s) => s >= to || s >= until || (rule.count && emitted >= rule.count);

    if (rule.freq === 'week' && rule.days?.length) {
      const base = new Date(ev.start);
      const weekStart = addDays(startOfDay(base), -base.getDay());
      const days = [...rule.days].sort((a, b) => a - b);
      let w = 0;
      // Skip whole periods that end before the window (not when counting).
      if (!rule.count) w = Math.max(0, Math.floor((from - weekStart.getTime()) / (7 * DAY * interval)) - 1) * interval;
      for (let guard = 0; guard < 2000; guard++, w += interval) {
        let stop = false;
        for (const d of days) {
          const day = addDays(weekStart, w * 7 + d);
          day.setHours(base.getHours(), base.getMinutes(), 0, 0);
          const s = day.getTime();
          if (s < ev.start) continue;
          if (done(s)) { stop = true; break; }
          push(s);
        }
        if (stop) break;
      }
      continue;
    }

    let cursor = new Date(ev.start);
    if (!rule.count && (rule.freq === 'day' || rule.freq === 'week')) {
      const stepDays = (rule.freq === 'day' ? 1 : 7) * interval;
      const skip = Math.max(0, Math.floor((from - ev.start - dur) / (stepDays * DAY)) - 1);
      if (skip) cursor = addDays(cursor, skip * stepDays);
    }
    for (let guard = 0; guard < 5000; guard++) {
      const s = cursor.getTime();
      if (done(s)) break;
      push(s);
      if (rule.freq === 'day') cursor = addDays(cursor, interval);
      else if (rule.freq === 'week') cursor = addDays(cursor, 7 * interval);
      else if (rule.freq === 'month') cursor = stepCalendar(new Date(ev.start), (guard + 1) * interval);
      else cursor = stepCalendar(new Date(ev.start), (guard + 1) * 12 * interval);
    }
  }
  out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  return out;
}

/** True if an occurrence covers more than one calendar day (or is all-day). */
export const isSpanning = (ev) => ev.allDay || !sameCalendarDay(ev.start, Math.max(ev.start, ev.end - 1));
const sameCalendarDay = (a, b) => dayKey(a) === dayKey(b);

/**
 * Side-by-side layout for timed events in one day column. Returns a Map of
 * occurrenceKey → { col, cols } where overlapping events share the width.
 */
export function layoutDay(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map();
  let cluster = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const columns = [];
    for (const ev of cluster) {
      const end = Math.max(ev.end, ev.start + 20 * 60 * 1000);
      let c = columns.findIndex((colEnd) => colEnd <= ev.start);
      if (c < 0) { c = columns.length; columns.push(end); } else columns[c] = end;
      result.set(ev.occurrenceKey, { col: c, cols: 0 });
    }
    for (const ev of cluster) result.get(ev.occurrenceKey).cols = columns.length;
    cluster = [];
  };
  for (const ev of sorted) {
    const end = Math.max(ev.end, ev.start + 20 * 60 * 1000);
    if (ev.start >= clusterEnd) { close(); clusterEnd = -Infinity; }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, end);
  }
  close();
  return result;
}

/**
 * Lanes for a week row of the month view (or the all-day strip). Each item is
 * placed in the first lane free across all the days it covers.
 * Returns [{ ev, lane, startCol, span }].
 */
export function layoutWeekRow(occurrences, weekStart, days = 7) {
  const ws = startOfDay(weekStart).getTime();
  const items = occurrences.map((ev) => {
    // Both ends are local midnights, so rounding absorbs DST's 23/25-hour days.
    const s = Math.max(0, Math.round((startOfDay(ev.start) - ws) / DAY));
    const lastMs = ev.allDay ? ev.end - 1 : Math.max(ev.start, ev.end - 1);
    const e = Math.min(days - 1, Math.round((startOfDay(lastMs) - ws) / DAY));
    return { ev, startCol: Math.min(s, days - 1), span: Math.max(1, e - Math.min(s, days - 1) + 1) };
  }).filter((it) => it.startCol <= days - 1 && it.startCol + it.span > 0);
  items.sort((a, b) => a.startCol - b.startCol || b.span - a.span || (b.ev.allDay - a.ev.allDay) || a.ev.start - b.ev.start);
  const lanes = [];
  for (const it of items) {
    let lane = 0;
    for (;; lane++) {
      lanes[lane] ||= new Array(days).fill(false);
      let free = true;
      for (let c = it.startCol; c < it.startCol + it.span; c++) if (lanes[lane][c]) { free = false; break; }
      if (free) break;
    }
    for (let c = it.startCol; c < it.startCol + it.span; c++) lanes[lane][c] = true;
    it.lane = lane;
  }
  return items;
}

// ---------------------------------------------------------------------------
// .ics
// ---------------------------------------------------------------------------

const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseIcsDate(value, params = {}) {
  const v = value.trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { ms: new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)).getTime(), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const ms = z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))
    : new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime(); // TZID times are read as local wall time
  return { ms, allDay: false };
}

const unescapeText = (s = '') => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** Parse VEVENTs out of an .ics file into BCOS event objects (minus ids). */
export function parseIcs(text, { limit = 5000 } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start != null && !cur.cancelled) {
        if (cur.end == null) cur.end = cur.allDay ? cur.start + DAY : cur.start + (cur.duration || 60 * 60 * 1000);
        events.push({
          uid: cur.uid,
          title: cur.title || 'Untitled',
          start: cur.start,
          end: cur.end,
          allDay: !!cur.allDay,
          location: cur.location || '',
          notes: cur.notes || '',
          recurrence: cur.recurrence || null,
          exdates: cur.exdates,
        });
        if (events.length >= limit) break;
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...paramParts] = line.slice(0, idx).split(';');
    const params = Object.fromEntries(paramParts.map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), (v || '').replace(/"/g, '')]));
    const value = line.slice(idx + 1);
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DESCRIPTION': cur.notes = unescapeText(value).slice(0, 4000); break;
      case 'STATUS': if (/CANCELLED/i.test(value)) cur.cancelled = true; break;
      case 'DTSTART': { const d = parseIcsDate(value, params); if (d) { cur.start = d.ms; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseIcsDate(value, params); if (d) cur.end = d.ms; break; }
      case 'DURATION': {
        const m = value.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
        if (m) cur.duration = ((+m[1] || 0) * 7 * DAY) + ((+m[2] || 0) * DAY) + ((+m[3] || 0) * 3600e3) + ((+m[4] || 0) * 60e3) + ((+m[5] || 0) * 1e3);
        break;
      }
      case 'EXDATE':
        for (const part of value.split(',')) { const d = parseIcsDate(part, params); if (d) cur.exdates.push(dayKey(d.ms)); }
        break;
      case 'RRULE': {
        const r = Object.fromEntries(value.split(';').map((p) => p.split('=')));
        const freq = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.FREQ];
        if (!freq) break;
        const rule = { freq, interval: +r.INTERVAL || 1 };
        if (r.BYDAY && freq === 'week') rule.days = r.BYDAY.split(',').map((d) => ICS_DAYS[d.slice(-2)]).filter((d) => d != null);
        if (r.UNTIL) { const d = parseIcsDate(r.UNTIL); if (d) rule.until = startOfDay(d.ms).getTime(); }
        if (r.COUNT) rule.count = +r.COUNT;
        cur.recurrence = rule;
        break;
      }
    }
  }
  return events;
}

/** A minimal .ics export of BCOS events. */
export function toIcs(events, calName = 'BCOS') {
  const pad = (n) => String(n).padStart(2, '0');
  const utc = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
  const date = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };
  const esc = (s = '') => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BCOS//Calendar//EN', `X-WR-CALNAME:${esc(calName)}`];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@bcos`, `DTSTAMP:${utc(Date.now())}`, `SUMMARY:${esc(ev.title)}`);
    if (ev.allDay) lines.push(`DTSTART;VALUE=DATE:${date(ev.start)}`, `DTEND;VALUE=DATE:${date(ev.end)}`);
    else lines.push(`DTSTART:${utc(ev.start)}`, `DTEND:${utc(ev.end)}`);
    if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${esc(ev.notes)}`);
    const r = ev.recurrence;
    if (r) {
      const freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[r.freq];
      let rr = `RRULE:FREQ=${freq};INTERVAL=${r.interval || 1}`;
      if (r.days?.length) rr += `;BYDAY=${r.days.map((d) => Object.keys(ICS_DAYS)[Object.values(ICS_DAYS).indexOf(d)]).join(',')}`;
      if (r.until) rr += `;UNTIL=${date(r.until)}`;
      if (r.count) rr += `;COUNT=${r.count}`;
      lines.push(rr);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
