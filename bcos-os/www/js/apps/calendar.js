// Calendar — day, week and month views, drag to create/move/resize, repeating
// events, calendar subscriptions and .ics import/export.

import { html, useState, useEffect, useMemo, useRef, useLayoutEffect } from '../lib/html.js';
import { useCollection, useSettings, setSettings, put, remove, get, putMany, all, status } from '../lib/store.js';
import { expand, layoutDay, layoutWeekRow, CAL_COLORS, REPEAT_PRESETS, presetToRule, ruleToPreset, describeRule, parseIcs, toIcs } from '../lib/events.js';
import { feedEvents, useFeeds, refreshFeed, forgetFeed } from '../lib/feeds.js';
import { DAY, MINUTE, startOfDay, addDays, addMonths, startOfWeek, startOfMonth, sameDay, isToday, dayKey, fromKey, fmt, fmtTime, fmtHour, weekdayNames, monthGrid, timeValue, withTime, minutesOfDay, relativeDay } from '../lib/date.js';
import { cx, uid, clamp, download, pickFile, plural, isTyping } from '../lib/util.js';
import { setDone } from '../lib/tasks.js';
import { Icon } from '../ui/icons.js';
import { Popover, Segmented, Toggle, IconButton, openMenu, openContextMenu, confirm, prompt, toast, useNarrow, useTick, ColorDots, AutoTextarea, justClosedLayer } from '../ui/components.js';
import { openApp } from '../shell/os.js';
import { os } from '../shell/os.js';

const HOUR_H = 52;
const SNAP = 15;
const snap = (min) => Math.round(min / SNAP) * SNAP;

// ---------------------------------------------------------------------------
// Saving occurrences. Editing one occurrence of a repeating event either
// changes the whole series or splits that one day off as its own event.
// Every change returns an undo function.
// ---------------------------------------------------------------------------

function seriesOf(occ) { return get('events', occ.series?.id || occ.id); }

function saveOccurrence(occ, changes, scope = 'all') {
  const series = seriesOf(occ);
  if (!series) return null;
  if (!series.recurrence || !occ.isOccurrence) {
    put('events', { ...series, ...changes });
    return () => put('events', series);
  }
  if (scope === 'this') {
    const copy = { ...series, ...changes, id: uid('e'), recurrence: null, exdates: [], start: changes.start ?? occ.start, end: changes.end ?? occ.end, createdAt: undefined };
    delete copy.occurrenceKey; delete copy.series; delete copy.isOccurrence;
    put('events', { ...series, exdates: [...new Set([...(series.exdates || []), dayKey(occ.start)])] });
    put('events', copy);
    return () => { put('events', series); remove('events', copy.id); };
  }
  const newStart = changes.start ?? occ.start;
  const newEnd = changes.end ?? occ.end;
  const next = { ...series, ...changes };
  const rule = changes.recurrence !== undefined ? changes.recurrence : series.recurrence;
  const bare = (r) => r && JSON.stringify({ ...r, until: null, count: null });
  const sameRule = !!rule && bare(rule) === bare(series.recurrence);
  const fromWd = new Date(occ.start).getDay();
  const toWd = new Date(newStart).getDay();
  if (sameRule && rule.freq === 'week' && rule.days?.length > 1 && fromWd !== toWd) {
    // Mon+Wed with Wed dragged to Thu means "Wed becomes Thu", not "shift everything".
    const tod = minutesOfDay(newStart) - minutesOfDay(occ.start);
    next.recurrence = { ...rule, days: [...new Set(rule.days.map((d) => (d === fromWd ? toWd : d)))].sort() };
    next.start = series.start + tod * MINUTE;
  } else {
    const dayShift = Math.round((startOfDay(newStart) - startOfDay(occ.start)) / DAY);
    const s = addDays(new Date(series.start), dayShift);
    s.setHours(new Date(newStart).getHours(), new Date(newStart).getMinutes(), 0, 0);
    next.start = series.allDay || changes.allDay ? startOfDay(s).getTime() : s.getTime();
    if (sameRule && rule.freq === 'week' && rule.days?.length === 1 && dayShift) {
      next.recurrence = { ...rule, days: [new Date(next.start).getDay()] };
    }
  }
  next.end = next.start + (newEnd - newStart);
  put('events', next);
  return () => put('events', series);
}

function deleteOccurrence(occ, scope = 'all') {
  const series = seriesOf(occ);
  if (!series) return null;
  if (series.recurrence && occ.isOccurrence && scope === 'this') {
    put('events', { ...series, exdates: [...new Set([...(series.exdates || []), dayKey(occ.start)])] });
  } else {
    remove('events', series.id);
  }
  return () => put('events', series);
}

/** Ask "this one or all?" for repeating events. Resolves 'this' | 'all' | null. */
function askScope(anchor, verb) {
  return new Promise((resolve) => {
    openMenu(anchor, [
      { heading: `${verb} a repeating event` },
      { label: 'Only this event', icon: 'calendar', onSelect: () => resolve('this') },
      { label: 'All events in the series', icon: 'repeat', onSelect: () => resolve('all') },
    ], { placement: 'top-end', onDismiss: () => resolve(null) });
  });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function CalendarApp({ intent, nonce }) {
  const s = useSettings();
  const narrow = useNarrow();
  const [view, setViewState] = useState(s.calendar.view || 'week');
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [editor, setEditor] = useState(null);
  const [showSide, setShowSide] = useState(false);
  const [dayList, setDayList] = useState(null);
  const newBtn = useRef(null);
  const events = useCollection('events');
  const calendars = useCollection('calendars');
  const tasks = useCollection('tasks');
  const feedVersion = useFeeds();
  useTick(60000);

  const setView = (v) => { setViewState(v); setSettings({ calendar: { view: v } }); };

  const cals = useMemo(() => [...calendars].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [calendars]);
  const calMap = useMemo(() => Object.fromEntries(cals.map((c) => [c.id, c])), [cals]);
  const writable = cals.filter((c) => c.kind !== 'feed');
  const colorOf = (ev) => ev.color || calMap[ev.calendarId]?.color || '#3b82f6';

  const effView = narrow && view === 'week' ? 'days3' : view;
  const range = useMemo(() => {
    if (effView === 'month') {
      let grid = monthGrid(cursor, s.weekStart);
      if (grid[35].getMonth() !== cursor.getMonth()) grid = grid.slice(0, 35);
      return { start: grid[0], end: addDays(grid[grid.length - 1], 1), grid };
    }
    const days = effView === 'week' ? 7 : effView === 'days3' ? 3 : 1;
    const start = effView === 'week' ? startOfWeek(cursor, s.weekStart) : startOfDay(cursor);
    return { start, end: addDays(start, days), days };
  }, [effView, cursor.getTime(), s.weekStart]);

  const occ = useMemo(() => {
    const visible = new Set(cals.filter((c) => c.visible !== false).map((c) => c.id));
    const src = [...events, ...feedEvents()].filter((e) => visible.has(e.calendarId));
    return expand(src, range.start.getTime(), range.end.getTime()).map((e) => ({ ...e, color: colorOf(e) }));
  }, [events, cals, feedVersion, range]);

  const dueTasks = useMemo(() => {
    if (!s.calendar.showTasks) return [];
    const a = dayKey(range.start), b = dayKey(range.end);
    return tasks.filter((t) => t.due && t.due >= a && t.due < b);
  }, [tasks, range, s.calendar.showTasks]);

  // --- navigation ---
  const step = (dir) => {
    if (effView === 'month') setCursor(startOfMonth(addMonths(cursor, dir)));
    else setCursor(addDays(cursor, dir * (effView === 'week' ? 7 : effView === 'days3' ? 3 : 1)));
    setEditor(null);
  };
  const goToday = () => { setCursor(startOfDay(new Date())); setEditor(null); };
  const goDay = (d) => { setCursor(startOfDay(d)); setView('day'); };

  // --- editor ---
  const defaultCal = () => writable.find((c) => c.visible !== false)?.id || writable[0]?.id;
  const openNew = (anchor, start, end, allDay = false) => {
    if (!writable.length) { toast('Create a calendar first', { icon: 'calendar' }); return; }
    setEditor({ anchor, isNew: true, occ: { id: null, title: '', calendarId: defaultCal(), start, end, allDay, location: '', notes: '', recurrence: null } });
  };
  const openNewDefault = (anchor) => {
    const now = new Date();
    const showsToday = now >= range.start && now < range.end;
    const start = showsToday ? Math.ceil(now.getTime() / (30 * MINUTE)) * 30 * MINUTE : withTime(cursor, '09:00');
    openNew(anchor || newBtn.current, start, start + s.calendar.defaultDuration * MINUTE);
  };
  const openEvent = (ev, anchor) => setEditor({ anchor, isNew: false, occ: ev });

  const moveEvent = async (ev, start, end, anchor) => {
    if (ev.readOnly) return;
    let scope = 'all';
    if (ev.isOccurrence) {
      scope = await askScope(anchor || { left: innerWidth / 2, top: innerHeight / 2, right: innerWidth / 2, bottom: innerHeight / 2, width: 0, height: 0 }, 'Move');
      if (!scope) return;
    }
    const undo = saveOccurrence(ev, { start, end }, scope);
    toast(`Moved to ${relativeDay(start)}${ev.allDay ? '' : `, ${fmtTime(start)}`}`, { icon: 'calendar', action: undo && { label: 'Undo', onClick: undo } });
  };

  // --- intents ---
  useEffect(() => {
    if (!intent) return;
    if (intent.type === 'date' && intent.date) { setCursor(fromKey(intent.date)); }
    if (intent.type === 'new') setTimeout(() => openNewDefault(newBtn.current), 380);
    if (intent.type === 'event') {
      const ev = get('events', intent.id) || feedEvents().find((e) => e.id === intent.id);
      if (ev) {
        const day = intent.date ? fromKey(intent.date) : new Date(ev.start);
        setCursor(startOfDay(day));
        setTimeout(() => {
          const el = document.querySelector(`[data-series="${CSS.escape(ev.id)}"]`);
          const [o] = expand([ev], startOfDay(day).getTime(), addDays(day, 1).getTime());
          const occItem = o ? { ...o, color: colorOf(o) } : { ...ev, color: colorOf(ev), series: ev };
          openEvent(occItem, el || { left: innerWidth / 2 - 10, right: innerWidth / 2 + 10, top: innerHeight / 3, bottom: innerHeight / 3 + 20, width: 20, height: 20 });
        }, 420);
      }
    }
  }, [nonce]);

  // --- keyboard ---
  useEffect(() => {
    const onKey = (e) => {
      if (os.app !== 'calendar') return; // running in the background
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || editor || document.querySelector('.popover, .spotlight')) return;
      const k = e.key.toLowerCase();
      if (k === 't') goToday();
      else if (k === 'd') setView('day');
      else if (k === 'w') setView('week');
      else if (k === 'm') setView('month');
      else if (k === 'n') openNewDefault();
      else if (e.key === 'ArrowLeft' || k === 'j') step(-1);
      else if (e.key === 'ArrowRight' || k === 'k') step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- title ---
  let title;
  if (effView === 'month') title = html`${fmt(cursor, 'monthLong')} <span class="light">${cursor.getFullYear()}</span>`;
  else if (effView === 'day') title = html`${fmt(cursor, 'monthDay')} <span class="light">${fmt(cursor, 'weekdayLong')}</span>`;
  else {
    const a = range.start, b = addDays(range.end, -1);
    title = a.getMonth() === b.getMonth()
      ? html`${fmt(a, 'monthLong')} <span class="light">${a.getFullYear()}</span>`
      : html`${fmt(a, 'monthShort')} – ${fmt(b, 'monthShort')} <span class="light">${b.getFullYear()}</span>`;
  }

  const draft = editor?.isNew ? editor.occ : null;
  const activeKey = editor && !editor.isNew ? editor.occ.occurrenceKey : null;
  const viewProps = { occ, dueTasks, draft, activeKey, onCreate: openNew, onOpen: openEvent, onMove: moveEvent, calMap, weekStart: s.weekStart, defaultDuration: s.calendar.defaultDuration, dayStart: s.calendar.dayStart, goDay, setDayList };

  return html`<div class=${cx('app cal', showSide && 'show-side')}>
    <aside class="app-side cal-side">
      <button class="btn btn-primary btn-block" ref=${newBtn} onClick=${(e) => openNewDefault(e.currentTarget)}><${Icon} name="plus" size=${16} /> New event</button>
      <${MiniMonth} cursor=${cursor} weekStart=${s.weekStart} events=${events} cals=${cals} range=${range}
        onPick=${(d) => { setCursor(startOfDay(d)); setShowSide(false); }} />
      <${CalendarList} cals=${cals} />
      <label class="cal-side-opt">
        <span>Show tasks with due dates</span>
        <${Toggle} checked=${s.calendar.showTasks} onChange=${(v) => setSettings({ calendar: { showTasks: v } })} label="Show tasks" />
      </label>
    </aside>
    <section class="app-main">
      <header class="app-bar">
        <${IconButton} class="back-btn" icon="sidebar" label="Calendars" onClick=${() => setShowSide(!showSide)} />
        <h1 class="app-title cal-title">${title}</h1>
        <div class="cal-nav">
          <${IconButton} icon="chevron-left" label="Previous" onClick=${() => step(-1)} />
          <button class="btn btn-sm" onClick=${goToday}>Today</button>
          <${IconButton} icon="chevron-right" label="Next" onClick=${() => step(1)} />
        </div>
        <div class="spacer" />
        <${Segmented} value=${narrow && view === 'week' ? 'week' : view} onChange=${setView} options=${[
          { value: 'day', label: 'Day' },
          { value: 'week', label: narrow ? '3 Day' : 'Week' },
          { value: 'month', label: 'Month' },
        ]} />
        ${narrow && html`<${IconButton} icon="plus" label="New event" onClick=${(e) => openNewDefault(e.currentTarget)} />`}
      </header>
      <div class="cal-body-wrap" key=${effView}>
        ${effView === 'month'
          ? html`<${MonthView} ...${viewProps} grid=${range.grid} cursor=${cursor} />`
          : html`<${TimeGrid} ...${viewProps} start=${range.start} days=${range.days} />`}
      </div>
    </section>
    ${editor && html`<${EventEditor} key=${editor.occ.occurrenceKey || 'new'} ...${editor} cals=${cals} writable=${writable}
      onChange=${(occ) => setEditor((ed) => ed && { ...ed, occ })} onClose=${() => setEditor(null)} />`}
    ${dayList && html`<${DayListPopover} ...${dayList} calMap=${calMap} onClose=${() => setDayList(null)}
      onOpen=${(ev, el) => { setDayList(null); openEvent(ev, el); }} goDay=${(d) => { setDayList(null); goDay(d); }} />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function MiniMonth({ cursor, weekStart, events, range, onPick }) {
  const [month, setMonth] = useState(() => startOfMonth(cursor));
  useEffect(() => { setMonth(startOfMonth(cursor)); }, [cursor.getFullYear(), cursor.getMonth()]);
  const grid = monthGrid(month, weekStart);
  const busy = useMemo(() => {
    const set = new Set();
    for (const e of expand(events, grid[0].getTime(), addDays(grid[41], 1).getTime())) set.add(dayKey(e.start));
    return set;
  }, [events, month.getTime(), weekStart]);
  const inRange = (d) => d >= range.start && d < range.end;
  return html`<div class="mini">
    <div class="mini-head">
      <span class="mini-title">${fmt(month, 'monthLong')} <span class="light">${month.getFullYear()}</span></span>
      <${IconButton} class="sm" icon="chevron-left" size=${14} label="Previous month" onClick=${() => setMonth(addMonths(month, -1))} />
      <${IconButton} class="sm" icon="chevron-right" size=${14} label="Next month" onClick=${() => setMonth(addMonths(month, 1))} />
    </div>
    <div class="mini-grid">
      ${weekdayNames(weekStart, 'weekdayShort').map((w) => html`<span class="mini-wd">${w.slice(0, 1)}</span>`)}
      ${grid.map((d) => html`<button key=${d.getTime()}
        class=${cx('mini-day', d.getMonth() !== month.getMonth() && 'is-other', isToday(d) && 'is-today', inRange(d) && 'is-range', sameDay(d, cursor) && 'is-cursor')}
        onClick=${() => onPick(d)} aria-label=${fmt(d, 'full')}>
        ${d.getDate()}${busy.has(dayKey(d)) && html`<i />`}
      </button>`)}
    </div>
  </div>`;
}

function CalendarList({ cals }) {
  const toggle = (c) => put('calendars', { ...c, visible: c.visible === false });
  const solo = (c) => cals.forEach((x) => { if ((x.id === c.id) !== (x.visible !== false)) put('calendars', { ...x, visible: x.id === c.id }); });

  const addCalendar = async () => {
    const name = await prompt({ title: 'New calendar', placeholder: 'Calendar name', confirmLabel: 'Create' });
    if (!name?.trim()) return;
    const used = new Set(cals.map((c) => c.color));
    put('calendars', { id: uid('cal'), name: name.trim(), color: CAL_COLORS.find((c) => !used.has(c)) || CAL_COLORS[cals.length % CAL_COLORS.length], visible: true, kind: 'local', order: cals.length });
  };

  const subscribe = async () => {
    if (status.mode !== 'server') { toast('Subscriptions need the BCOS server running on your Umbrel', { icon: 'cloud-off' }); return; }
    const url = await prompt({ title: 'Subscribe to a calendar', body: 'Paste an .ics or webcal:// link — a school timetable, a sports schedule, or a shared iCloud calendar. It stays read-only and refreshes every 30 minutes.', placeholder: 'https://…/calendar.ics', confirmLabel: 'Subscribe' });
    if (!url?.trim()) return;
    const used = new Set(cals.map((c) => c.color));
    const cal = { id: uid('cal'), name: 'Subscription', color: CAL_COLORS.find((c) => !used.has(c)) || '#64748b', visible: true, kind: 'feed', url: url.trim(), order: cals.length };
    put('calendars', cal);
    try {
      const text = await (await import('../lib/store.js')).fetchFeed(cal.url);
      const name = (text.match(/^X-WR-CALNAME:(.+)$/m) || [])[1]?.trim();
      if (name) put('calendars', { ...get('calendars', cal.id), name });
      const n = await refreshFeed(get('calendars', cal.id));
      toast(`Subscribed — ${plural(n, 'event')}`, { icon: 'check-circle' });
    } catch (err) {
      toast(err.message, { icon: 'alert', tone: 'warn' });
    }
  };

  const importIcs = async () => {
    const file = await pickFile('.ics,text/calendar');
    if (!file) return;
    const parsed = parseIcs(await file.text());
    if (!parsed.length) { toast('No events found in that file', { icon: 'alert' }); return; }
    const used = new Set(cals.map((c) => c.color));
    const calId = uid('cal');
    put('calendars', { id: calId, name: file.name.replace(/\.ics$/i, ''), color: CAL_COLORS.find((c) => !used.has(c)) || '#64748b', visible: true, kind: 'local', order: cals.length });
    putMany('events', parsed.map((ev) => ({ ...ev, id: uid('e'), calendarId: calId })));
    toast(`Imported ${plural(parsed.length, 'event')}`, { icon: 'download' });
  };

  const menuFor = (c) => [
    { label: 'Show only this calendar', icon: 'eye', onSelect: () => solo(c) },
    { label: 'Rename…', icon: 'edit', disabled: false, onSelect: async () => { const n = await prompt({ title: 'Rename calendar', value: c.name }); if (n?.trim()) put('calendars', { ...c, name: n.trim() }); } },
    { label: 'Change colour…', icon: 'palette', onSelect: () => setTimeout(() => openMenu(document.querySelector(`[data-cal="${c.id}"]`), CAL_COLORS.map((col) => ({ label: col === c.color ? 'Current' : ' ', swatch: col, onSelect: () => put('calendars', { ...c, color: col }) })), { placement: 'right-start', width: 120 }), 0) },
    c.kind === 'feed'
      ? { label: 'Refresh now', icon: 'refresh', onSelect: () => refreshFeed(c).then((n) => toast(`Refreshed — ${plural(n, 'event')}`, { icon: 'refresh' })).catch((e) => toast(e.message, { icon: 'alert' })) }
      : { label: 'Export as .ics', icon: 'download', onSelect: () => download(`${c.name}.ics`, toIcs(all('events').filter((e) => e.calendarId === c.id), c.name), 'text/calendar') },
    { divider: true },
    {
      label: c.kind === 'feed' ? 'Unsubscribe' : 'Delete calendar…', icon: 'trash', danger: true,
      onSelect: async () => {
        const evs = all('events').filter((e) => e.calendarId === c.id);
        const ok = c.kind === 'feed' || await confirm({ title: `Delete “${c.name}”?`, body: evs.length ? `Its ${plural(evs.length, 'event')} will be deleted too.` : 'It has no events.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        remove('calendars', c.id);
        evs.forEach((e) => remove('events', e.id));
        if (c.kind === 'feed') forgetFeed(c.id);
        toast(`Deleted ${c.name}`, { icon: 'trash', action: { label: 'Undo', onClick: () => { put('calendars', c); putMany('events', evs); } } });
      },
    },
  ];

  return html`<div class="side-section">
    <div class="side-label">
      <span>Calendars</span>
      <${IconButton} class="sm" icon="plus" size=${15} label="Add calendar" onClick=${(e) => openMenu(e.currentTarget, [
        { label: 'New calendar', icon: 'calendar-plus', onSelect: addCalendar },
        { label: 'Subscribe to a link…', icon: 'link', onSelect: subscribe },
        { label: 'Import .ics file…', icon: 'file-up', onSelect: importIcs },
      ])} />
    </div>
    ${cals.map((c) => html`<div class="cal-row" key=${c.id} data-cal=${c.id} onContextMenu=${(e) => openContextMenu(e, menuFor(c))}>
      <button class=${cx('cal-check', c.visible !== false && 'is-on')} style=${{ '--c': c.color }} onClick=${() => toggle(c)} aria-pressed=${c.visible !== false} aria-label=${`Show ${c.name}`}>
        <${Icon} name="check" size=${11} stroke=${3} />
      </button>
      <span class="cal-row-name" onClick=${() => toggle(c)}>${c.name}</span>
      ${c.kind === 'feed' && html`<span class="cal-row-feed" title=${c.error || `Subscribed: ${c.url}`}><${Icon} name=${c.error ? 'alert' : 'link'} size=${12} /></span>`}
      <${IconButton} class="sm cal-row-more" icon="more" size=${15} label=${`${c.name} options`} onClick=${(e) => openMenu(e.currentTarget, menuFor(c), { placement: 'right-start' })} />
    </div>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Time grid (day / 3-day / week)
// ---------------------------------------------------------------------------

function EventBlock({ ev, seg, lay, onPointerDown, active, ghost, dragging }) {
  const durMin = (seg.end - seg.start) / MINUTE;
  const top = (minutesOfDay(seg.start) / 60) * HOUR_H;
  const height = Math.max(18, (durMin / 60) * HOUR_H - 2);
  const compact = height < 38;
  const left = lay ? (lay.col / lay.cols) * 100 : 0;
  const width = lay ? 100 / lay.cols : 100;
  return html`<div
    class=${cx('cal-ev', compact && 'is-compact', active && 'is-active', ghost && 'is-ghost', dragging && 'is-source', ev.readOnly && 'is-readonly', ev.isDraft && 'is-draft')}
    data-series=${ev.series?.id || ev.id} data-key=${ev.occurrenceKey}
    style=${{ '--c': ev.color, top: `${top}px`, height: `${height}px`, left: `calc(${left}% + 1px)`, width: `calc(${width}% - ${lay && lay.col < lay.cols - 1 ? 3 : 6}px)` }}
    onPointerDown=${onPointerDown}>
    <div class="cal-ev-title">${ev.title || (ev.isDraft ? 'New event' : 'Untitled')}${compact && !ev.allDay ? html`<span class="cal-ev-time">${fmtTime(ev.start, { short: true })}</span>` : null}</div>
    ${!compact && html`<div class="cal-ev-meta">${fmtTime(ev.start, { short: true })} – ${fmtTime(ev.end, { short: true })}${ev.location ? ` · ${ev.location}` : ''}</div>`}
    ${ev.recurrence && !compact && html`<${Icon} class="cal-ev-repeat" name="repeat" size=${11} />`}
    ${!ev.readOnly && !ghost && html`<div class="cal-ev-resize" data-resize="1" />`}
  </div>`;
}

function TimeGrid({ start, days, occ, dueTasks, draft, activeKey, onCreate, onOpen, onMove, weekStart, defaultDuration, dayStart, calMap }) {
  const list = useMemo(() => Array.from({ length: days }, (_, i) => addDays(start, i)), [start.getTime(), days]);
  const scrollRef = useRef(null);
  const colsRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [allDayOpen, setAllDayOpen] = useState(false);
  useTick(60000);

  const isAllDayLike = (e) => e.allDay || e.end - e.start >= DAY;
  const allDayOcc = occ.filter(isAllDayLike);
  const timed = occ.filter((e) => !isAllDayLike(e));
  const withDraft = draft ? [...timed.filter((e) => e.occurrenceKey !== 'draft'), ...(!draft.allDay ? [{ ...draft, occurrenceKey: 'draft', isDraft: true, color: calMap[draft.calendarId]?.color || '#3b82f6' }] : [])] : timed;

  const columns = useMemo(() => list.map((d) => {
    const ds = d.getTime(), de = addDays(d, 1).getTime();
    const segs = withDraft.filter((e) => e.start < de && e.end > ds).map((e) => ({ ev: e, seg: { occurrenceKey: e.occurrenceKey, start: Math.max(e.start, ds), end: Math.min(e.end, de) } }));
    const lay = layoutDay(segs.map((x) => x.seg));
    return { d, segs, lay };
  }), [list, withDraft]);

  // Scroll to something useful on first show.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showsToday = list.some((d) => isToday(d));
    const h = showsToday ? Math.max(0, new Date().getHours() - 1.5) : dayStart;
    el.scrollTop = Math.max(0, h * HOUR_H - 8);
  }, [start.getTime()]);

  const rects = () => colsRef.current.getBoundingClientRect();
  const minAt = (clientY) => ((clientY - rects().top) / HOUR_H) * 60;
  const dayAt = (clientX) => { const r = rects(); return clamp(Math.floor(((clientX - r.left) / r.width) * days), 0, days - 1); };
  const rectFor = (dayIdx, startMs, endMs) => {
    const r = rects();
    const colW = r.width / days;
    const top = r.top + (minutesOfDay(startMs) / 60) * HOUR_H;
    const h = Math.max(20, ((endMs - startMs) / MINUTE / 60) * HOUR_H);
    return { left: r.left + dayIdx * colW, right: r.left + (dayIdx + 1) * colW, top, bottom: top + h, width: colW, height: h };
  };

  const autoscroll = (clientY) => {
    const el = scrollRef.current;
    const r = el.getBoundingClientRect();
    if (clientY < r.top + 40) el.scrollTop -= 14;
    else if (clientY > r.bottom - 40) el.scrollTop += 14;
  };

  const onColumnDown = (e, dayIdx) => {
    if (e.button !== 0 || e.target.closest('.cal-ev') || justClosedLayer()) return;
    e.preventDefault();
    const base = list[dayIdx].getTime();
    const m0 = clamp(Math.floor(minAt(e.clientY) / SNAP) * SNAP, 0, 24 * 60 - SNAP);
    let moved = false;
    let last = null;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientY - e.clientY) < 6) return;
      moved = true;
      autoscroll(ev.clientY);
      const m1 = clamp(snap(minAt(ev.clientY)), 0, 24 * 60);
      const a = Math.min(m0, m1), b = Math.max(m0 + SNAP, m1);
      last = { kind: 'create', day: dayIdx, start: base + a * MINUTE, end: base + b * MINUTE };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        const m = clamp(Math.floor(minAt(e.clientY) / 30) * 30, 0, 24 * 60 - 30);
        const s = new Date(list[dayIdx]); s.setHours(0, m, 0, 0);
        const startMs = s.getTime();
        onCreate(rectFor(dayIdx, startMs, startMs + defaultDuration * MINUTE), startMs, startMs + defaultDuration * MINUTE);
      } else if (last) {
        onCreate(rectFor(dayIdx, last.start, last.end), last.start, last.end);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onEventDown = (e, ev) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    if (ev.isDraft) return;
    const resizing = !!e.target.closest('[data-resize]');
    const day0 = dayAt(e.clientX);
    const y0 = e.clientY;
    let moved = false;
    let last = null;
    const move = (pe) => {
      if (ev.readOnly) return;
      if (!moved && Math.hypot(pe.clientX - e.clientX, pe.clientY - y0) < 5) return;
      moved = true;
      autoscroll(pe.clientY);
      const dMin = snap(((pe.clientY - y0) / HOUR_H) * 60);
      if (resizing) {
        const end = Math.max(ev.start + SNAP * MINUTE, ev.end + dMin * MINUTE);
        last = { kind: 'resize', ev, start: ev.start, end };
      } else {
        const dDay = dayAt(pe.clientX) - day0;
        const s = addDays(new Date(ev.start), dDay).getTime() + dMin * MINUTE;
        last = { kind: 'move', ev, start: s, end: s + (ev.end - ev.start) };
      }
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved) { onOpen(ev, el); return; }
      if (last && (last.start !== ev.start || last.end !== ev.end)) {
        const idx = clamp(Math.round((startOfDay(last.start) - start) / DAY), 0, days - 1);
        onMove(ev, last.start, last.end, rectFor(idx, last.start, last.end));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Ghost segments for whatever is being dragged.
  const ghostFor = (d) => {
    if (!drag) return null;
    const ds = d.getTime(), de = addDays(d, 1).getTime();
    if (drag.end <= ds || drag.start >= de) return null;
    const ev = drag.kind === 'create'
      ? { title: '', isDraft: true, color: 'var(--accent)', occurrenceKey: 'ghost', start: drag.start, end: drag.end }
      : { ...drag.ev, start: drag.start, end: drag.end, occurrenceKey: 'ghost' };
    return html`<${EventBlock} ev=${ev} seg=${{ start: Math.max(drag.start, ds), end: Math.min(drag.end, de) }} lay=${null} ghost=${true} />`;
  };

  // All-day strip
  const adItems = layoutWeekRow([
    ...allDayOcc,
    ...(draft && draft.allDay ? [{ ...draft, occurrenceKey: 'draft', isDraft: true, color: calMap[draft.calendarId]?.color }] : []),
  ], start, days);
  const taskByDay = list.map((d) => dueTasks.filter((t) => t.due === dayKey(d)));
  const adLanes = Math.max(adItems.reduce((m, it) => Math.max(m, it.lane + 1), 0), 0);
  const taskLanes = Math.max(0, ...taskByDay.map((t) => t.length));
  const totalLanes = adLanes + taskLanes;
  const maxLanes = allDayOpen ? totalLanes : Math.min(totalLanes, 3);
  const now = new Date();
  const nowTop = (minutesOfDay(now) / 60) * HOUR_H;

  return html`<div class="cal-time" style=${{ '--days': days, '--hour-h': `${HOUR_H}px` }}>
    <div class="cal-head">
      <div class="cal-gutter-head" />
      ${list.map((d) => html`<div key=${d.getTime()} class=${cx('cal-dayhead', isToday(d) && 'is-today', (d.getDay() === 0 || d.getDay() === 6) && 'is-weekend')}>
        <span class="wd">${fmt(d, 'weekdayShort')}</span><span class="num">${d.getDate()}</span>
      </div>`)}
    </div>
    <div class="cal-allday" style=${{ '--lanes': Math.max(1, maxLanes) }}>
      <div class="cal-allday-label">
        ${totalLanes > 3 ? html`<button class="cal-allday-more" onClick=${() => setAllDayOpen(!allDayOpen)}>${allDayOpen ? 'less' : `+${totalLanes - 3}`}</button>` : 'all-day'}
      </div>
      <div class="cal-allday-cols" onDblClick=${(e) => {
        if (e.target.closest('.cal-chip')) return;
        const idx = dayAt(e.clientX);
        const d = list[idx].getTime();
        onCreate({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }, d, addDays(d, 1).getTime(), true);
      }}>
        ${list.map((d, i) => html`<div class="cal-allday-cell" key=${i} />`)}
        ${adItems.filter((it) => it.lane < maxLanes).map((it) => html`<button key=${it.ev.occurrenceKey}
          class=${cx('cal-chip is-bar', it.ev.occurrenceKey === activeKey && 'is-active', it.ev.isDraft && 'is-draft')}
          data-series=${it.ev.series?.id || it.ev.id}
          style=${{ '--c': it.ev.color, left: `calc(${(it.startCol / days) * 100}% + 2px)`, width: `calc(${(it.span / days) * 100}% - 4px)`, top: `${it.lane * 24 + 3}px` }}
          onClick=${(e) => !it.ev.isDraft && onOpen(it.ev, e.currentTarget)}>
          ${it.ev.title || 'New event'}
        </button>`)}
        ${taskByDay.map((ts, i) => ts.map((t, j) => adLanes + j < maxLanes && html`<div key=${t.id} class=${cx('cal-chip is-task', t.done && 'is-done')}
          style=${{ left: `calc(${(i / days) * 100}% + 2px)`, width: `calc(${100 / days}% - 4px)`, top: `${(adLanes + j) * 24 + 3}px` }}>
          <button class="cal-task-check" aria-label=${t.done ? 'Mark not done' : 'Complete'} onClick=${() => setDone(t, !t.done)}>${t.done && html`<${Icon} name="check" size=${10} stroke=${3} />`}</button>
          <span onClick=${() => openApp('tasks', { type: 'task', id: t.id })}>${t.title}</span>
        </div>`))}
      </div>
    </div>
    <div class="cal-scroll" ref=${scrollRef}>
      <div class="cal-grid">
        <div class="cal-gutter">
          ${Array.from({ length: 23 }, (_, h) => html`<span key=${h} style=${{ top: `${(h + 1) * HOUR_H}px` }}>${fmtHour(h + 1)}</span>`)}
          ${list.some((d) => isToday(d)) && html`<span class="cal-now-label" style=${{ top: `${nowTop}px` }}>${fmtTime(now, { short: true })}</span>`}
        </div>
        <div class="cal-cols" ref=${colsRef}>
          ${columns.map(({ d, segs, lay }, i) => html`<div key=${d.getTime()} class=${cx('cal-col', (d.getDay() === 0 || d.getDay() === 6) && 'is-weekend', isToday(d) && 'is-today')}
            onPointerDown=${(e) => onColumnDown(e, i)}>
            ${segs.map(({ ev, seg }) => html`<${EventBlock} key=${ev.occurrenceKey} ev=${ev} seg=${seg} lay=${lay.get(ev.occurrenceKey)}
              active=${ev.occurrenceKey === activeKey} dragging=${drag && drag.ev && drag.ev.occurrenceKey === ev.occurrenceKey}
              onPointerDown=${(e) => onEventDown(e, ev)} />`)}
            ${ghostFor(d)}
            ${isToday(d) && html`<div class="cal-now" style=${{ top: `${nowTop}px` }} />`}
          </div>`)}
        </div>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------

function MonthView({ grid, cursor, occ, dueTasks, draft, activeKey, onCreate, onOpen, onMove, weekStart, defaultDuration, goDay, setDayList, calMap }) {
  const weeks = grid.length / 7;
  const wrapRef = useRef(null);
  const [rowH, setRowH] = useState(120);
  const [drag, setDrag] = useState(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setRowH(el.clientHeight / weeks));
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);
  const lanesFit = Math.max(1, Math.floor((rowH - 32) / 22));

  const items = useMemo(() => {
    const ts = dueTasks.map((t) => {
      const s = fromKey(t.due).getTime();
      return { id: `task-${t.id}`, occurrenceKey: `task-${t.id}`, title: t.title, start: s, end: s + 1, isTask: true, task: t };
    });
    const d = draft ? [{ ...draft, occurrenceKey: 'draft', isDraft: true, color: calMap[draft.calendarId]?.color }] : [];
    return [...occ, ...d, ...ts];
  }, [occ, dueTasks, draft]);

  const cellAt = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-day]');
    return el ? Number(el.dataset.day) : null;
  };

  const onChipDown = (e, ev) => {
    if (e.button !== 0 || ev.isTask || ev.isDraft) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const from = cellAt(e.clientX, e.clientY);
    let moved = false;
    let target = from;
    const move = (pe) => {
      if (ev.readOnly) return;
      if (!moved && Math.hypot(pe.clientX - e.clientX, pe.clientY - e.clientY) < 5) return;
      moved = true;
      target = cellAt(pe.clientX, pe.clientY) ?? target;
      setDrag({ ev, x: pe.clientX, y: pe.clientY, target });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved) { onOpen(ev, el); return; }
      if (target != null && from != null && target !== from) {
        const dDay = Math.round((grid[target] - grid[from]) / DAY);
        const s = addDays(new Date(ev.start), dDay).getTime();
        const cellEl = wrapRef.current.querySelector(`[data-day="${target}"]`);
        onMove(ev, s, s + (ev.end - ev.start), cellEl);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return html`<div class="cal-month" style=${{ '--weeks': weeks }}>
    <div class="cal-month-head">${weekdayNames(weekStart, 'weekdayShort').map((w) => html`<span>${w}</span>`)}</div>
    <div class="cal-month-grid" ref=${wrapRef}>
      ${Array.from({ length: weeks }, (_, w) => {
        const ws = grid[w * 7];
        const we = addDays(ws, 7).getTime();
        const rowItems = layoutWeekRow(items.filter((e) => e.start < we && (e.isTask ? e.start >= ws.getTime() : e.end > ws.getTime())), ws, 7);
        const perDayCount = Array(7).fill(0);
        const perDayHidden = Array(7).fill(0);
        for (const it of rowItems) for (let c = it.startCol; c < it.startCol + it.span; c++) { perDayCount[c]++; }
        const shown = [];
        for (const it of rowItems) {
          let fits = true;
          for (let c = it.startCol; c < it.startCol + it.span; c++) {
            const limit = perDayCount[c] > lanesFit ? lanesFit - 1 : lanesFit;
            if (it.lane >= limit) fits = false;
          }
          if (fits) shown.push(it);
          else for (let c = it.startCol; c < it.startCol + it.span; c++) perDayHidden[c]++;
        }
        return html`<div class="mrow" key=${ws.getTime()}>
          ${Array.from({ length: 7 }, (_, c) => {
            const d = grid[w * 7 + c];
            const idx = w * 7 + c;
            const isDropTarget = drag && drag.target === idx;
            return html`<div key=${c} data-day=${idx}
              class=${cx('mcell', d.getMonth() !== cursor.getMonth() && 'is-other', isToday(d) && 'is-today', (d.getDay() === 0 || d.getDay() === 6) && 'is-weekend', isDropTarget && 'is-drop')}
              onDblClick=${(e) => { if (e.target.closest('.mchip')) return; const s = withTime(d, '09:00'); onCreate(e.currentTarget, s, s + defaultDuration * MINUTE); }}>
              <button class="mdate" onClick=${() => goDay(d)} aria-label=${fmt(d, 'full')}>${d.getDate() === 1 ? `${fmt(d, 'monthShort')} 1` : d.getDate()}</button>
              ${perDayHidden[c] > 0 && html`<button class="mmore" style=${{ top: `${30 + (lanesFit - 1) * 22}px` }}
                onClick=${(e) => setDayList({ anchor: e.currentTarget, day: d, items: items.filter((x) => x.isTask ? x.task.due === dayKey(d) : x.start < addDays(d, 1).getTime() && x.end > d.getTime()) })}>+${perDayHidden[c]} more</button>`}
            </div>`;
          })}
          ${shown.map((it) => {
            const ev = it.ev;
            const bar = ev.allDay || it.span > 1;
            return html`<div key=${ev.occurrenceKey} data-series=${ev.series?.id || ev.id}
              class=${cx('mchip', bar ? 'is-bar' : 'is-dot', ev.isTask && 'is-task', ev.isTask && ev.task.done && 'is-done', ev.occurrenceKey === activeKey && 'is-active', ev.isDraft && 'is-draft', drag && drag.ev.occurrenceKey === ev.occurrenceKey && 'is-source')}
              style=${{ '--c': ev.color || 'var(--text-3)', left: `calc(${(it.startCol / 7) * 100}% + 3px)`, width: `calc(${(it.span / 7) * 100}% - 6px)`, top: `${30 + it.lane * 22}px` }}
              onPointerDown=${(e) => onChipDown(e, ev)}>
              ${ev.isTask
                ? html`<button class="cal-task-check" onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); setDone(ev.task, !ev.task.done); }}>${ev.task.done && html`<${Icon} name="check" size=${9} stroke=${3} />`}</button><span class="mchip-title" onClick=${() => openApp('tasks', { type: 'task', id: ev.task.id })}>${ev.title}</span>`
                : bar ? html`<span class="mchip-title">${ev.title || 'New event'}</span>`
                : html`<i class="mchip-dot" /><span class="mchip-time">${fmtTime(ev.start, { short: true })}</span><span class="mchip-title">${ev.title || 'New event'}</span>`}
            </div>`;
          })}
        </div>`;
      })}
    </div>
    ${drag && html`<div class="mchip-float" style=${{ '--c': drag.ev.color, left: `${drag.x + 10}px`, top: `${drag.y - 12}px` }}>${drag.ev.title}</div>`}
  </div>`;
}

function DayListPopover({ anchor, day, items, onClose, onOpen, goDay }) {
  return html`<${Popover} anchor=${anchor} onClose=${onClose} placement="bottom-center" width=${260} class="cal-daylist">
    <div class="cal-daylist-head">
      <span class="wd">${fmt(day, 'weekdayLong')}</span>
      <button class="num" onClick=${() => goDay(day)}>${day.getDate()}</button>
    </div>
    <div class="cal-daylist-items">
      ${items.map((ev) => ev.isTask
        ? html`<div class="mchip is-dot is-task" key=${ev.occurrenceKey}><span class="mchip-title">☐ ${ev.title}</span></div>`
        : html`<button key=${ev.occurrenceKey} class=${cx('mchip', ev.allDay ? 'is-bar' : 'is-dot')} style=${{ '--c': ev.color, position: 'relative' }} onClick=${(e) => onOpen(ev, e.currentTarget)}>
            ${!ev.allDay && html`<i class="mchip-dot" /><span class="mchip-time">${fmtTime(ev.start, { short: true })}</span>`}
            <span class="mchip-title">${ev.title}</span>
          </button>`)}
    </div>
  </${Popover}>`;
}

// ---------------------------------------------------------------------------
// Event editor
// ---------------------------------------------------------------------------

function toForm(occ) {
  const endInclusive = occ.allDay ? addDays(new Date(occ.end), -1) : new Date(occ.end);
  return {
    title: occ.title || '',
    calendarId: occ.calendarId,
    allDay: !!occ.allDay,
    startDate: dayKey(occ.start),
    startTime: timeValue(occ.start),
    endDate: dayKey(occ.allDay ? Math.max(occ.start, endInclusive.getTime()) : occ.end),
    endTime: timeValue(occ.end),
    repeat: ruleToPreset(occ.recurrence),
    until: occ.recurrence?.until ? dayKey(occ.recurrence.until) : '',
    location: occ.location || '',
    notes: occ.notes || '',
    color: occ.series?.color ?? occ.color ?? null,
    ownColor: !!(occ.series?.color || (occ.id && get('events', occ.id)?.color)),
  };
}

function fromForm(f, original) {
  let start, end;
  if (f.allDay) {
    start = fromKey(f.startDate).getTime();
    end = addDays(fromKey(f.endDate < f.startDate ? f.startDate : f.endDate), 1).getTime();
  } else {
    start = withTime(fromKey(f.startDate), f.startTime || '09:00');
    end = withTime(fromKey(f.endDate || f.startDate), f.endTime || '10:00');
    if (end <= start) end = start + 30 * MINUTE;
  }
  const orig = original?.recurrence || null;
  let recurrence;
  if (f.repeat === 'none') recurrence = null;
  else if (f.repeat === 'custom' || f.repeat === ruleToPreset(orig)) recurrence = orig;
  else recurrence = presetToRule(f.repeat, start);
  if (recurrence) recurrence = { ...recurrence, until: f.until ? fromKey(f.until).getTime() : null };
  return { title: f.title.trim(), calendarId: f.calendarId, allDay: f.allDay, start, end, location: f.location.trim(), notes: f.notes, recurrence };
}

function EventEditor({ anchor, isNew, occ, cals, writable, onClose, onChange }) {
  const [f, setF] = useState(() => toForm(occ));
  const titleRef = useRef(null);
  const saveRef = useRef(null);
  const readOnly = !!occ.readOnly;
  const cal = cals.find((c) => c.id === f.calendarId);
  const series = occ.series || occ;
  const isRepeating = !!series.recurrence && !isNew;

  useEffect(() => { if (isNew) setTimeout(() => titleRef.current?.focus(), 60); }, []);

  const set = (patchObj) => {
    setF((cur) => {
      const next = { ...cur, ...patchObj };
      // Moving the start keeps the duration.
      if ((patchObj.startDate || patchObj.startTime) && !cur.allDay) {
        const oldS = withTime(fromKey(cur.startDate), cur.startTime);
        const oldE = withTime(fromKey(cur.endDate), cur.endTime);
        const newS = withTime(fromKey(next.startDate), next.startTime);
        const newE = newS + Math.max(15 * MINUTE, oldE - oldS);
        next.endDate = dayKey(newE);
        next.endTime = timeValue(newE);
      } else if (patchObj.startDate && cur.allDay) {
        const span = (fromKey(cur.endDate) - fromKey(cur.startDate)) / DAY;
        next.endDate = dayKey(addDays(fromKey(next.startDate), Math.max(0, Math.round(span))));
      }
      if (isNew) onChange({ ...occ, ...fromForm(next, occ) });
      return next;
    });
  };

  const save = async () => {
    const changes = fromForm(f, series);
    if (!changes.title) changes.title = 'New event';
    const evChanges = { ...changes, color: f.ownColor ? f.color : null };
    if (isNew) {
      const ev = put('events', { id: uid('e'), ...evChanges, exdates: [] });
      onClose();
      toast(`Added “${ev.title}”`, { icon: 'calendar', action: { label: 'Undo', onClick: () => remove('events', ev.id) } });
      return;
    }
    let scope = 'all';
    if (isRepeating) {
      scope = await askScope(saveRef.current, 'Save');
      if (!scope) return;
    }
    const undo = saveOccurrence(occ, evChanges, scope);
    onClose();
    if (undo) toast('Event updated', { icon: 'check-circle', action: { label: 'Undo', onClick: undo } });
  };

  const del = async (e) => {
    const btn = e.currentTarget;
    let scope = 'all';
    if (isRepeating) {
      scope = await askScope(btn, 'Delete');
      if (!scope) return;
    }
    const undo = deleteOccurrence(occ, scope);
    onClose();
    toast(`Deleted “${occ.title || 'event'}”`, { icon: 'trash', action: undo && { label: 'Undo', onClick: undo } });
  };

  const duplicate = () => {
    const changes = fromForm(f, series);
    const target = writable[0];
    put('events', { id: uid('e'), ...changes, calendarId: occ.readOnly ? target?.id : changes.calendarId, recurrence: occ.readOnly ? null : changes.recurrence, exdates: [] });
    onClose();
    toast('Copied to your calendar', { icon: 'copy' });
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target === titleRef.current)) { e.preventDefault(); save(); }
  };

  if (readOnly) {
    return html`<${Popover} anchor=${anchor} onClose=${onClose} placement="right-start" width=${320} class="ev-editor">
      <div class="ev-view">
        <div class="ev-view-title"><i style=${{ background: cal?.color }} />${occ.title}</div>
        <div class="ev-view-when">${occ.allDay ? fmt(occ.start, 'full') : `${fmt(occ.start, 'full')} · ${fmtTime(occ.start)} – ${fmtTime(occ.end)}`}</div>
        ${occ.recurrence && html`<div class="ev-view-row"><${Icon} name="repeat" size=${14} />${describeRule(occ.recurrence)}</div>`}
        ${occ.location && html`<div class="ev-view-row"><${Icon} name="map-pin" size=${14} />${occ.location}</div>`}
        ${occ.notes && html`<div class="ev-view-notes">${occ.notes}</div>`}
        <div class="ev-view-row muted"><${Icon} name="link" size=${14} />From “${cal?.name}” (read-only)</div>
        <div class="ev-actions"><span class="spacer" /><button class="btn btn-sm" onClick=${duplicate}><${Icon} name="copy" size=${14} />Copy to my calendar</button></div>
      </div>
    </${Popover}>`;
  }

  const initial = useRef(JSON.stringify(f));
  const onOutside = () => {
    if (isNew || JSON.stringify(f) === initial.current) onClose();
    else save();
  };
  return html`<${Popover} anchor=${anchor} onClose=${onOutside} onEscape=${onClose} placement="right-start" width=${372} class="ev-editor" label=${isNew ? 'New event' : 'Edit event'}>
    <form class="ev-form" onSubmit=${(e) => { e.preventDefault(); save(); }} onKeyDown=${onKey}>
      <input ref=${titleRef} class="ev-title" value=${f.title} placeholder="New event" onInput=${(e) => set({ title: e.target.value })} aria-label="Title" />

      <button type="button" class="ev-cal" onClick=${(e) => openMenu(e.currentTarget, writable.map((c) => ({ label: c.name, swatch: c.color, checked: c.id === f.calendarId, onSelect: () => set({ calendarId: c.id }) })))}>
        <i style=${{ background: f.ownColor && f.color ? f.color : cal?.color }} />${cal?.name || 'Calendar'}<${Icon} name="chevron-down" size=${13} />
      </button>

      <div class="ev-grid">
        <span class="ev-label">All-day</span>
        <div><${Toggle} checked=${f.allDay} onChange=${(v) => set({ allDay: v })} label="All-day" /></div>
        <span class="ev-label">Starts</span>
        <div class="ev-when">
          <input type="date" class="field field-sm" value=${f.startDate} onInput=${(e) => e.target.value && set({ startDate: e.target.value })} />
          ${!f.allDay && html`<input type="time" step="900" class="field field-sm" value=${f.startTime} onInput=${(e) => e.target.value && set({ startTime: e.target.value })} />`}
        </div>
        <span class="ev-label">Ends</span>
        <div class="ev-when">
          <input type="date" class="field field-sm" value=${f.endDate} onInput=${(e) => e.target.value && set({ endDate: e.target.value })} />
          ${!f.allDay && html`<input type="time" step="900" class="field field-sm" value=${f.endTime} onInput=${(e) => e.target.value && set({ endTime: e.target.value })} />`}
        </div>
        <span class="ev-label">Repeat</span>
        <div class="ev-when">
          <select class="field field-sm" value=${f.repeat} onChange=${(e) => set({ repeat: e.target.value })}>
            ${REPEAT_PRESETS.map((p) => html`<option value=${p.id}>${p.label}</option>`)}
            ${f.repeat === 'custom' && html`<option value="custom">${describeRule(series.recurrence)}</option>`}
          </select>
        </div>
        ${f.repeat !== 'none' && html`<span class="ev-label">Until</span>
          <div class="ev-when"><input type="date" class="field field-sm" value=${f.until} onInput=${(e) => set({ until: e.target.value })} />
          ${f.until && html`<${IconButton} class="sm" icon="x" size=${13} label="Repeat forever" onClick=${() => set({ until: '' })} />`}</div>`}
      </div>

      <div class="ev-field"><${Icon} name="map-pin" size=${15} />
        <input class="ev-input" value=${f.location} placeholder="Add location" onInput=${(e) => set({ location: e.target.value })} />
      </div>
      <div class="ev-field is-notes"><${Icon} name="note" size=${15} />
        <${AutoTextarea} class="ev-input" value=${f.notes} placeholder="Add notes" onInput=${(e) => set({ notes: e.target.value })} />
      </div>
      <div class="ev-field"><${Icon} name="palette" size=${15} />
        <div class="ev-colors">
          <button type="button" class=${cx('ev-color-auto', !f.ownColor && 'is-on')} onClick=${() => set({ ownColor: false, color: null })}>Calendar</button>
          <${ColorDots} colors=${CAL_COLORS} value=${f.ownColor ? f.color : null} size=${16} onChange=${(c) => set({ ownColor: true, color: c })} />
        </div>
      </div>

      <div class="ev-actions">
        ${!isNew && html`<${IconButton} icon="trash" class="is-danger" label="Delete event" onClick=${del} />`}
        ${!isNew && html`<${IconButton} icon="copy" label="Duplicate" onClick=${duplicate} />`}
        <span class="spacer" />
        <button type="button" class="btn btn-sm btn-ghost" onClick=${onClose}>Cancel</button>
        <button type="submit" ref=${saveRef} class="btn btn-sm btn-primary">${isNew ? 'Add event' : 'Save'}</button>
      </div>
    </form>
  </${Popover}>`;
}
