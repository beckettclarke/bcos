// Date helpers. Everything is local time: BCOS is one person's OS in one place.
// Events store epoch milliseconds; anything that is "a day" (task due dates,
// journal entries) stores a YYYY-MM-DD key so it never drifts across zones.

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
};
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const startOfMonth = (d) => { const x = startOfDay(d); x.setDate(1); return x; };
export const startOfWeek = (d, weekStart = 0) => {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() - weekStart + 7) % 7));
  return x;
};
export const sameDay = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};
export const isToday = (d) => sameDay(d, Date.now());
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
export const fromKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayKey = () => dayKey(new Date());
export const timeValue = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const withTime = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(day); x.setHours(h || 0, m || 0, 0, 0); return x.getTime(); };
export const minutesOfDay = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

// --- formatting ------------------------------------------------------------

let use24 = false;
export const setClock24 = (v) => { use24 = !!v; };
export const clock24 = () => use24;

export function fmtTime(ms, { short = false } = {}) {
  const d = new Date(ms);
  if (use24) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const ap = d.getHours() < 12 ? 'AM' : 'PM';
  if (short) return m ? `${h}:${pad(m)}${ap[0].toLowerCase()}` : `${h}${ap[0].toLowerCase()}`;
  return `${h}:${pad(m)} ${ap}`;
}

export function fmtHour(h) {
  if (use24) return `${pad(h)}:00`;
  if (h === 0) return '12 AM';
  if (h === 12) return 'Noon';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const F = (opts) => new Intl.DateTimeFormat(undefined, opts);
const fmts = {
  weekdayShort: F({ weekday: 'short' }),
  weekdayLong: F({ weekday: 'long' }),
  monthLong: F({ month: 'long' }),
  monthShort: F({ month: 'short' }),
  monthDay: F({ month: 'short', day: 'numeric' }),
  monthDayYear: F({ month: 'short', day: 'numeric', year: 'numeric' }),
  full: F({ weekday: 'long', month: 'long', day: 'numeric' }),
  fullYear: F({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  monthYear: F({ month: 'long', year: 'numeric' }),
  weekdayMonthDay: F({ weekday: 'short', month: 'short', day: 'numeric' }),
};
export const fmt = (d, kind) => fmts[kind].format(new Date(d));

export function weekdayNames(weekStart = 0, kind = 'weekdayShort') {
  const base = new Date(2024, 0, 7); // a Sunday
  return Array.from({ length: 7 }, (_, i) => fmt(addDays(base, (i + weekStart) % 7), kind));
}

/** "Today", "Tomorrow", "Yesterday", "Friday", "Oct 31", "Oct 31, 2027". */
export function relativeDay(d, { long = false } = {}) {
  const diff = daysBetween(Date.now(), d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return fmt(d, long ? 'weekdayLong' : 'weekdayLong');
  if (new Date(d).getFullYear() !== new Date().getFullYear()) return fmt(d, 'monthDayYear');
  return fmt(d, long ? 'weekdayMonthDay' : 'monthDay');
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return fmt(ms, new Date(ms).getFullYear() === new Date().getFullYear() ? 'monthDay' : 'monthDayYear');
}

/** Short list-style timestamp: time today, weekday this week, else date. */
export function listStamp(ms) {
  if (isToday(ms)) return fmtTime(ms);
  const diff = daysBetween(ms, Date.now());
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return fmt(ms, 'weekdayLong');
  return fmt(ms, new Date(ms).getFullYear() === new Date().getFullYear() ? 'monthDay' : 'monthDayYear');
}

/** 6×7 grid of dates covering the month that contains `d`. */
export function monthGrid(d, weekStart = 0) {
  const first = startOfWeek(startOfMonth(d), weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export function isoWeek(d) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + 3 - ((x.getDay() + 6) % 7));
  const week1 = new Date(x.getFullYear(), 0, 4);
  return 1 + Math.round(((x - week1) / DAY - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Good night';
}
