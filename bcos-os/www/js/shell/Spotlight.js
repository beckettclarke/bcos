// Search across everything (⌘K): apps, actions, events, tasks, notes,
// journal and mail. Also quick-captures a task or note, and does arithmetic.

import { html, useState, useEffect, useRef, useMemo } from '../lib/html.js';
import { all, put } from '../lib/store.js';
import { expand } from '../lib/events.js';
import { feedEvents } from '../lib/feeds.js';
import { fmt, fmtTime, relativeDay, fromKey, todayKey, addDays, startOfDay, listStamp } from '../lib/date.js';
import { cx, uid, splitMatch, modKey } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Portal, useEscape, toast } from '../ui/components.js';
import { APPS } from './apps.js';
import { os, useOS, openApp, setSpotlight } from './os.js';

const ACTIONS = [
  { id: 'new-event', label: 'New event', icon: 'calendar-plus', app: 'calendar', intent: { type: 'new' }, keywords: 'add create schedule meeting' },
  { id: 'new-task', label: 'New task', icon: 'check-circle', app: 'tasks', intent: { type: 'new' }, keywords: 'add todo reminder' },
  { id: 'new-note', label: 'New note', icon: 'compose', app: 'notes', intent: { type: 'new' }, keywords: 'add write' },
  { id: 'journal', label: 'Write today’s journal', icon: 'pen', app: 'journal', intent: { type: 'day', date: null }, keywords: 'diary entry today' },
  { id: 'compose', label: 'Compose message', icon: 'send', app: 'mail', intent: { type: 'compose' }, keywords: 'email write mail' },
  { id: 'wallpaper', label: 'Change wallpaper', icon: 'image', app: 'settings', intent: { section: 'appearance' }, keywords: 'background theme appearance' },
];

function score(text, q) {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 60;
  if (t.includes(q)) return 40;
  return 0;
}

function calc(q) {
  if (!/^[\d\s+\-*/().,%^]+$/.test(q) || !/[+\-*/^%]/.test(q) || !/\d/.test(q)) return null;
  try {
    const expr = q.replace(/,/g, '').replace(/\^/g, '**').replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
    const v = Function(`"use strict"; return (${expr})`)();
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return Math.round(v * 1e10) / 1e10;
  } catch { return null; }
}

function buildResults(raw) {
  const q = raw.trim().toLowerCase();
  const groups = [];
  if (!q) {
    groups.push({ name: 'Quick actions', items: ACTIONS.slice(0, 5).map((a) => ({ ...a, kind: 'action' })) });
    groups.push({ name: 'Apps', items: APPS.map((a) => ({ id: `app-${a.id}`, kind: 'app', label: a.name, app: a.id, glyph: a.glyph })) });
    return groups;
  }

  const value = calc(q);
  if (value != null) groups.push({ name: 'Calculator', items: [{ id: 'calc', kind: 'calc', label: `${value.toLocaleString(undefined, { maximumFractionDigits: 10 })}`, sub: `${raw.trim()} =`, icon: 'hash', value }] });

  const apps = APPS.map((a) => ({ a, s: score(a.name, q) })).filter((x) => x.s).sort((x, y) => y.s - x.s);
  if (apps.length) groups.push({ name: 'Apps', items: apps.map(({ a }) => ({ id: `app-${a.id}`, kind: 'app', label: a.name, app: a.id, glyph: a.glyph })) });

  const actions = ACTIONS.filter((a) => score(a.label, q) || score(a.keywords, q));
  if (actions.length) groups.push({ name: 'Actions', items: actions.map((a) => ({ ...a, kind: 'action' })) });

  const now = Date.now();
  const cals = Object.fromEntries(all('calendars').map((c) => [c.id, c]));
  const occ = expand([...all('events'), ...feedEvents()], startOfDay(addDays(now, -60)).getTime(), addDays(now, 365).getTime());
  const seen = new Set();
  const events = occ
    .map((e) => ({ e, s: Math.max(score(e.title, q), score(e.location, q) * 0.6) - (e.end < now ? 15 : 0) }))
    .filter(({ e, s }) => s > 0 && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => b.s - a.s || Math.abs(a.e.start - now) - Math.abs(b.e.start - now))
    .slice(0, 4);
  if (events.length) groups.push({ name: 'Calendar', items: events.map(({ e }) => ({
    id: `ev-${e.occurrenceKey}`, kind: 'item', label: e.title, icon: 'calendar', color: e.color || cals[e.calendarId]?.color,
    sub: `${relativeDay(e.start)}${e.allDay ? '' : ` · ${fmtTime(e.start)}`}${e.location ? ` · ${e.location}` : ''}`,
    app: 'calendar', intent: { type: 'event', id: e.series?.id || e.id, date: todayKeyOf(e.start) },
  })) });

  const lists = Object.fromEntries(all('lists').map((l) => [l.id, l]));
  const tasks = all('tasks').map((t) => ({ t, s: Math.max(score(t.title, q), score(t.notes, q) * 0.5) - (t.done ? 20 : 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4);
  if (tasks.length) groups.push({ name: 'Tasks', items: tasks.map(({ t }) => ({
    id: `t-${t.id}`, kind: 'item', label: t.title, icon: t.done ? 'check-circle' : 'circle', done: t.done,
    sub: [lists[t.listId]?.name, t.due && relativeDay(fromKey(t.due))].filter(Boolean).join(' · '),
    app: 'tasks', intent: { type: 'task', id: t.id },
  })) });

  const notes = all('notes').filter((n) => !n.trashed).map((n) => ({ n, s: Math.max(score(n.title, q), score(n.text, q) * 0.7, (n.tags || []).some((t) => t === q.replace(/^#/, '')) ? 70 : 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt).slice(0, 4);
  if (notes.length) groups.push({ name: 'Notes', items: notes.map(({ n }) => ({
    id: `n-${n.id}`, kind: 'item', label: n.title || 'Untitled', icon: 'note', sub: snippet(n.text, q), app: 'notes', intent: { type: 'note', id: n.id },
  })) });

  const journal = all('journal').filter((j) => score(j.text, q)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 3);
  if (journal.length) groups.push({ name: 'Journal', items: journal.map((j) => ({
    id: `j-${j.id}`, kind: 'item', label: fmt(fromKey(j.id), 'full'), icon: 'book', sub: snippet(j.text, q), app: 'journal', intent: { type: 'day', date: j.id },
  })) });

  const mail = all('mail').filter((m) => m.mailbox !== 'trash').map((m) => ({ m, s: Math.max(score(m.subject, q), score(m.from?.name, q), score(m.body, q) * 0.5) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.m.date - a.m.date).slice(0, 3);
  if (mail.length) groups.push({ name: 'Mail', items: mail.map(({ m }) => ({
    id: `m-${m.id}`, kind: 'item', label: m.subject || '(no subject)', icon: 'mail', sub: `${m.from?.name || m.from?.email} · ${listStamp(m.date)}`, app: 'mail', intent: { type: 'message', id: m.id },
  })) });

  groups.push({ name: 'Create', items: [
    { id: 'cap-task', kind: 'capture', what: 'task', label: `Add task “${raw.trim()}”`, icon: 'plus', sub: 'Due today in Tasks' },
    { id: 'cap-note', kind: 'capture', what: 'note', label: `New note “${raw.trim()}”`, icon: 'compose', sub: 'Opens in Notes' },
  ] });
  return groups;
}

const todayKeyOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function snippet(text = '', q = '') {
  const t = text.replace(/\s+/g, ' ').trim();
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t.slice(0, 90);
  const start = Math.max(0, i - 30);
  return (start ? '…' : '') + t.slice(start, start + 100);
}

function Highlight({ text, q }) {
  const [a, b, c] = splitMatch(text, q.trim());
  return b ? html`${a}<mark>${b}</mark>${c}` : text;
}

export function Spotlight() {
  const state = useOS();
  const [closing, setClosing] = useState(false);
  const [visible, setVisible] = useState(state.spotlight);

  useEffect(() => {
    if (state.spotlight) { setVisible(true); setClosing(false); }
    else if (visible) { setClosing(true); const t = setTimeout(() => { setVisible(false); setClosing(false); }, 180); return () => clearTimeout(t); }
  }, [state.spotlight]);

  if (!visible) return null;
  return html`<${SpotlightPanel} closing=${closing} />`;
}

function SpotlightPanel({ closing }) {
  const [q, setQ] = useState(() => os.spotlightSeed || '');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const groups = useMemo(() => buildResults(q), [q]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('.spot-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEscape(() => (q ? setQ('') : setSpotlight(false)));

  const run = (item) => {
    if (!item) return;
    if (item.kind === 'calc') {
      navigator.clipboard?.writeText(String(item.value));
      toast('Copied result', { icon: 'copy' });
      setSpotlight(false);
      return;
    }
    if (item.kind === 'capture') {
      const title = q.trim();
      if (item.what === 'task') {
        put('tasks', { id: uid('t'), title, listId: all('lists')[0]?.id || null, due: todayKey(), priority: 0, status: 'todo', done: false, subtasks: [], order: Date.now() });
        toast(`Added “${title}” to Today`, { icon: 'check-circle', action: { label: 'Open', onClick: () => openApp('tasks', { type: 'list', id: 'today' }) } });
        setSpotlight(false);
      } else {
        openApp('notes', { type: 'new', title });
      }
      return;
    }
    openApp(item.app, item.intent || null);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[active]); }
  };

  let idx = -1;
  return html`<${Portal}>
    <div class=${cx('spot-scrim', closing && 'is-closing')} onPointerDown=${() => setSpotlight(false)} />
    <div class=${cx('spotlight', closing && 'is-closing')} role="dialog" aria-label="Search" data-layer="900">
      <div class="spot-input-row">
        <${Icon} name="search" size=${20} />
        <input ref=${inputRef} class="spot-input" value=${q} placeholder="Search or type a command…" spellcheck="false" autocomplete="off"
          onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} aria-label="Search" />
        <kbd>esc</kbd>
      </div>
      <div class="spot-results" ref=${listRef}>
        ${groups.map((g) => html`<div class="spot-group" key=${g.name}>
          <div class="spot-group-name">${g.name}</div>
          ${g.items.map((it) => {
            idx++;
            const i = idx;
            return html`<button key=${it.id} class=${cx('spot-item', i === active && 'is-active', it.done && 'is-done')}
              onPointerMove=${() => active !== i && setActive(i)} onClick=${() => run(it)}>
              <span class="spot-icon" style=${it.color ? { color: it.color } : null}>
                ${it.glyph ? html`<${it.glyph} size=${26} />` : html`<${Icon} name=${it.icon} size=${16} />`}
              </span>
              <span class="spot-text">
                <span class="spot-label"><${Highlight} text=${it.label} q=${it.kind === 'item' ? q : ''} /></span>
                ${it.sub && html`<span class="spot-sub">${it.sub}</span>`}
              </span>
              ${i === active && html`<span class="spot-enter">${it.kind === 'calc' ? 'Copy' : it.kind === 'app' ? 'Open' : '↵'}</span>`}
            </button>`;
          })}
        </div>`)}
      </div>
      <div class="spot-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>${modKey}K</kbd> to toggle</span>
      </div>
    </div>
  </${Portal}>`;
}
