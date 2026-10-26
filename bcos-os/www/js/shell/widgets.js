// Home-screen widgets. Each is a small live window onto one app's data;
// tapping it opens that app at the right place.

import { html, useMemo } from '../lib/html.js';
import { useCollection, useSettings, patch } from '../lib/store.js';
import { expand } from '../lib/events.js';
import { feedEvents, useFeeds } from '../lib/feeds.js';
import { setDone, dueInfo, habitStreak, periodCount } from '../lib/tasks.js';
import { startOfDay, addDays, todayKey, dayKey, fmt, fmtTime, timeAgo, isToday } from '../lib/date.js';
import { cx, plural } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { useTick } from '../ui/components.js';
import { openApp } from './os.js';
import { journalStats, MOODS } from '../apps/journal-shared.js';

export const WIDGETS = [
  { id: 'upnext', name: 'Up next', app: 'calendar', desc: 'Today’s schedule' },
  { id: 'tasks', name: 'Tasks', app: 'tasks', desc: 'What’s due today' },
  { id: 'journal', name: 'Journal', app: 'journal', desc: 'Streak and mood' },
  { id: 'habits', name: 'Habits', app: 'tasks', desc: 'Check in for today' },
  { id: 'notes', name: 'Notes', app: 'notes', desc: 'Recent notes' },
  { id: 'inbox', name: 'Inbox', app: 'mail', desc: 'Unread mail' },
  { id: 'clock', name: 'Clock', app: null, desc: 'Time and date' },
];

const open = (app, intent) => (e) => openApp(app, intent, e.currentTarget);

function UpNext() {
  const events = useCollection('events');
  const calendars = useCollection('calendars');
  useFeeds();
  useTick(60000);
  const now = Date.now();
  const items = useMemo(() => {
    const hidden = new Set(calendars.filter((c) => c.visible === false).map((c) => c.id));
    const color = Object.fromEntries(calendars.map((c) => [c.id, c.color]));
    const from = startOfDay(now).getTime();
    const occ = expand([...events, ...feedEvents()].filter((e) => !hidden.has(e.calendarId)), from, addDays(from, 2).getTime())
      .filter((e) => e.allDay ? isToday(e.start) || e.start < now : e.end > now)
      .map((e) => ({ ...e, color: e.color || color[e.calendarId] || '#3b82f6' }));
    return occ.slice(0, 3);
  }, [events, calendars, Math.floor(now / 60000)]);
  const d = new Date();
  return html`<button class="widget w-upnext" onClick=${open('calendar', { type: 'date', date: todayKey() })}>
    <div class="w-upnext-date">
      <div class="w-kicker">${fmt(d, 'weekdayLong')}</div>
      <div class="w-bignum">${d.getDate()}</div>
      <div class="w-sub">${fmt(d, 'monthLong')}</div>
    </div>
    <div class="w-upnext-list">
      ${items.length ? items.map((e) => html`<div class="w-event" key=${e.occurrenceKey}>
        <span class="w-event-bar" style=${{ background: e.color }} />
        <span class="w-event-time">${e.allDay ? 'All day' : isToday(e.start) ? fmtTime(e.start, { short: true }) : 'Tmrw'}</span>
        <span class="w-event-title">${e.title}</span>
      </div>`) : html`<div class="w-empty">Nothing else today.<br/><span>Enjoy the open time.</span></div>`}
    </div>
  </button>`;
}

function Ring({ value, size = 64, stroke = 6, children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return html`<div class="ring" style=${{ width: size, height: size }}>
    <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`}>
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="rgba(255,255,255,.14)" stroke-width=${stroke} />
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--accent)" stroke-width=${stroke} stroke-linecap="round"
        stroke-dasharray=${c} stroke-dashoffset=${c * (1 - Math.min(1, value))} transform=${`rotate(-90 ${size / 2} ${size / 2})`} class="ring-arc" />
    </svg>
    <div class="ring-label">${children}</div>
  </div>`;
}

function TasksWidget() {
  const tasks = useCollection('tasks');
  const today = todayKey();
  const dueToday = tasks.filter((t) => t.due && t.due <= today && (!t.done || (t.doneAt && dayKey(t.doneAt) === today)));
  const done = dueToday.filter((t) => t.done).length;
  const open_ = dueToday.filter((t) => !t.done).sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 3);
  return html`<div class="widget w-tasks" role="button" tabindex="0" onClick=${open('tasks', { type: 'list', id: 'today' })}>
    <${Ring} value=${dueToday.length ? done / dueToday.length : 0}>
      <strong>${done}</strong><span>/${dueToday.length}</span>
    </${Ring}>
    <div class="w-tasks-list">
      ${open_.length ? open_.map((t) => html`<div class="w-task" key=${t.id}>
        <button class="w-check" aria-label=${`Complete ${t.title}`} onClick=${(e) => { e.stopPropagation(); setDone(t, true); }} />
        <span class="w-task-title">${t.title}</span>
        ${dueInfo(t)?.tone === 'overdue' && html`<span class="w-dot-overdue" title="Overdue" />`}
      </div>`) : html`<div class="w-empty">${dueToday.length ? 'All done for today.' : 'Nothing due today.'}<br/><span>${dueToday.length ? 'Nicely done.' : 'Add something in Tasks.'}</span></div>`}
    </div>
  </div>`;
}

function JournalWidget() {
  const entries = useCollection('journal');
  const st = journalStats(entries);
  const mood = st.avgMood ? MOODS[Math.round(st.avgMood) - 1] : null;
  return html`<button class="widget w-pills" onClick=${open('journal', { type: 'day', date: todayKey() })}>
    <div class="w-pill"><${Icon} name="flame" size=${17} /><span class="w-pill-label">Streak</span><span class="w-pill-value">${plural(st.streak, 'day')}</span></div>
    <div class="w-pill"><${Icon} name="book" size=${17} /><span class="w-pill-label">This month</span><span class="w-pill-value">${st.monthCount}</span></div>
    <div class="w-pill"><span class="w-pill-emoji">${mood ? mood.face : '·'}</span><span class="w-pill-label">Mood</span><span class="w-pill-value">${mood ? mood.label : '—'}</span></div>
  </button>`;
}

function HabitsWidget() {
  const habits = useCollection('habits').filter((h) => !h.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).slice(0, 4);
  const s = useSettings();
  const key = todayKey();
  const toggle = (h) => {
    const log = { ...(h.log || {}) };
    if (log[key]) delete log[key]; else log[key] = 1;
    patch('habits', h.id, { log });
  };
  return html`<div class="widget w-habits" role="button" tabindex="0" onClick=${open('tasks', { type: 'list', id: 'habits' })}>
    ${habits.length ? habits.map((h) => {
      const doneToday = !!(h.log || {})[key];
      const target = h.freq === 'weekly' ? (h.target || 3) : 1;
      const pct = Math.min(1, periodCount(h, new Date(), s.weekStart) / target);
      return html`<div class="w-habit" key=${h.id}>
        <button class=${cx('w-habit-ring', doneToday && 'is-done')} style=${{ '--c': h.color }} aria-pressed=${doneToday} aria-label=${h.name}
          onClick=${(e) => { e.stopPropagation(); toggle(h); }}>
          <${Ring} value=${pct} size=${46} stroke=${4}>${doneToday ? html`<${Icon} name="check" size=${16} stroke=${2.6} />` : html`<span class="w-habit-emoji">${h.emoji || '•'}</span>`}</${Ring}>
        </button>
        <span class="w-habit-name">${h.name}</span>
        <span class="w-habit-streak">${habitStreak(h, s.weekStart)}d</span>
      </div>`;
    }) : html`<div class="w-empty">No habits yet.<br/><span>Start one in Tasks.</span></div>`}
  </div>`;
}

function NotesWidget() {
  const notes = useCollection('notes').filter((n) => !n.trashed).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt).slice(0, 4);
  return html`<div class="widget w-tiles">
    ${notes.map((n) => html`<button class="w-tile" key=${n.id} onClick=${open('notes', { type: 'note', id: n.id })}>
      <span class="w-tile-icon"><${Icon} name=${n.pinned ? 'pin' : 'note'} size=${15} /></span>
      <span class="w-tile-title">${n.title || 'Untitled'}</span>
    </button>`)}
    ${Array.from({ length: Math.max(0, 4 - notes.length) }, (_, i) => html`<button class="w-tile is-ghost" key=${`g${i}`} onClick=${open('notes', { type: 'new' })}>
      <span class="w-tile-icon"><${Icon} name="plus" size=${15} /></span><span class="w-tile-title">New note</span>
    </button>`)}
  </div>`;
}

function InboxWidget() {
  const mail = useCollection('mail');
  const unread = mail.filter((m) => m.mailbox === 'inbox' && !m.read).sort((a, b) => b.date - a.date);
  return html`<button class="widget w-inbox" onClick=${open('mail', { type: 'mailbox', id: 'inbox' })}>
    <div class="w-inbox-head">
      <div><div class="w-bignum">${unread.length}</div><div class="w-sub">unread</div></div>
      <span class="w-inbox-icon"><${Icon} name="inbox" size=${18} /></span>
    </div>
    <div class="w-inbox-list">
      ${unread.slice(0, 2).map((m) => html`<div class="w-mail" key=${m.id}><strong>${m.from?.name || m.from?.email}</strong><span>${m.subject}</span></div>`)}
      ${!unread.length && html`<div class="w-empty"><span>You’re all caught up.</span></div>`}
    </div>
  </button>`;
}

function ClockWidget() {
  useTick(1000);
  const d = new Date();
  const time = fmtTime(d).replace(/\s?[AP]M$/, '');
  const ap = /AM|PM/.exec(fmtTime(d))?.[0];
  return html`<div class="widget w-clock">
    <div class="w-clock-time">${time}${ap && html`<span>${ap}</span>`}</div>
    <div class="w-sub">${fmt(d, 'full')}</div>
  </div>`;
}

const COMPONENTS = { upnext: UpNext, tasks: TasksWidget, journal: JournalWidget, habits: HabitsWidget, notes: NotesWidget, inbox: InboxWidget, clock: ClockWidget };

export function Widget({ id }) {
  const C = COMPONENTS[id];
  const meta = WIDGETS.find((w) => w.id === id);
  if (!C) return null;
  return html`<div class="widget-slot">
    <${C} />
    <div class="widget-label">${meta.name}</div>
  </div>`;
}
