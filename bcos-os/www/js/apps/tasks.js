// Tasks — smart lists, your own lists, list/board/matrix views, subtasks,
// repeating tasks, drag and drop, and habits.

import { html, useState, useEffect, useMemo, useRef } from '../lib/html.js';
import { useCollection, useSettings, setSettings, put, patch, remove, get, all } from '../lib/store.js';
import { PRIORITIES, STATUSES, QUADRANTS, REPEATS, LIST_COLORS, LIST_ICONS, SORTS, SMART_LISTS, HABIT_COLORS, setDone, dueInfo, sortTasks, smartFilter, subtaskProgress, habitStreak, habitRate, periodCount, nextRepeatDue } from '../lib/tasks.js';
import { todayKey, dayKey, fromKey, addDays, startOfWeek, relativeDay, fmt, isToday, daysBetween, timeAgo } from '../lib/date.js';
import { cx, uid, plural, isTyping, clamp } from '../lib/util.js';
import { startDrag, orderAt } from '../lib/dnd.js';
import { Icon } from '../ui/icons.js';
import { Popover, Segmented, IconButton, openMenu, openContextMenu, confirm, toast, useNarrow, useEscape, ColorDots, AutoTextarea, EmptyState, useDraft } from '../ui/components.js';

const COMPLETE_DELAY = 900;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newTask(fields) {
  return { id: uid('t'), title: '', notes: '', listId: null, due: null, dueTime: null, priority: 0, status: 'todo', done: false, subtasks: [], tags: [], repeat: null, order: Date.now(), ...fields };
}

function deleteTask(task) {
  remove('tasks', task.id);
  toast(`Deleted “${task.title}”`, { icon: 'trash', action: { label: 'Undo', onClick: () => put('tasks', task, { touch: false }) } });
}

function dueMenu(task, onPick) {
  const pick = (due) => (onPick ? onPick(due) : patch('tasks', task.id, { due }));
  const nextMon = (() => { let d = addDays(new Date(), 1); while (d.getDay() !== 1) d = addDays(d, 1); return d; })();
  return [
    { label: 'Today', icon: 'sun', shortcut: fmt(new Date(), 'weekdayShort'), onSelect: () => pick(todayKey()) },
    { label: 'Tomorrow', icon: 'arrow-right', shortcut: fmt(addDays(new Date(), 1), 'weekdayShort'), onSelect: () => pick(dayKey(addDays(new Date(), 1))) },
    { label: 'Next week', icon: 'calendar', shortcut: fmt(nextMon, 'monthDay'), onSelect: () => pick(dayKey(nextMon)) },
    { label: 'No date', icon: 'x', onSelect: () => pick(null) },
  ];
}

function taskMenu(task, lists, { onOpen } = {}) {
  return [
    { label: task.done ? 'Mark as not done' : 'Complete', icon: 'check-circle', onSelect: () => setDone(task, !task.done) },
    onOpen && { label: 'Open details', icon: 'sidebar', onSelect: onOpen },
    { divider: true },
    { heading: 'Due' },
    ...dueMenu(task),
    { divider: true },
    { heading: 'Priority' },
    ...[...PRIORITIES].reverse().map((p) => ({ label: p.label, icon: 'flag', checked: (task.priority || 0) === p.v, onSelect: () => patch('tasks', task.id, { priority: p.v }) })),
    { divider: true },
    { heading: 'Move to' },
    ...lists.map((l) => ({ label: l.name, swatch: l.color, checked: l.id === task.listId, onSelect: () => patch('tasks', task.id, { listId: l.id }) })),
    { divider: true },
    { label: 'Duplicate', icon: 'copy', onSelect: () => put('tasks', { ...task, id: uid('t'), done: false, status: task.status === 'done' ? 'todo' : task.status, doneAt: null, createdAt: undefined, spawnedNext: false, order: (task.order || 0) + 0.5 }) },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteTask(task) },
  ].filter(Boolean);
}

/** Groups to show for the current view, each with an optional drop patch. */
function groupsFor(sel, visible, lists, completedMode) {
  const today = todayKey();
  const listName = Object.fromEntries(lists.map((l) => [l.id, l]));
  if (sel.kind === 'smart') {
    switch (sel.id) {
      case 'today': {
        const overdue = sortTasks(visible.filter((t) => !t.done && t.due < today), 'due');
        const now = sortTasks(visible.filter((t) => t.due === today && !t.done), 'priority');
        const done = visible.filter((t) => t.done);
        return [
          overdue.length && { key: 'overdue', name: 'Overdue', tone: 'danger', items: overdue, drop: { due: today } },
          { key: 'today', name: 'Today', items: now, drop: { due: today } },
          done.length && { key: 'done', name: 'Completed today', items: done, done: true },
        ].filter(Boolean);
      }
      case 'upcoming': {
        const groups = [];
        for (let i = 1; i <= 7; i++) {
          const k = dayKey(addDays(new Date(), i));
          groups.push({ key: `d:${k}`, name: i === 1 ? 'Tomorrow' : fmt(fromKey(k), 'weekdayLong'), sub: fmt(fromKey(k), 'monthDay'), items: sortTasks(visible.filter((t) => t.due === k), 'priority'), drop: { due: k }, compact: true });
        }
        const lastKey = dayKey(addDays(new Date(), 7));
        const later = sortTasks(visible.filter((t) => t.due > lastKey), 'due');
        groups.push({ key: 'later', name: 'Later', items: later });
        return groups;
      }
      case 'completed': {
        const by = new Map();
        for (const t of visible) {
          const k = t.doneAt ? dayKey(t.doneAt) : 'earlier';
          if (!by.has(k)) by.set(k, []);
          by.get(k).push(t);
        }
        return [...by.entries()].map(([k, items]) => ({ key: `c:${k}`, name: k === 'earlier' ? 'Earlier' : relativeDay(fromKey(k)), items, done: true }));
      }
      case 'all': {
        return lists.map((l) => ({ key: `l:${l.id}`, name: l.name, color: l.color, items: sortTasks(visible.filter((t) => t.listId === l.id), l.sort || 'manual'), drop: { listId: l.id } }))
          .concat([{ key: 'l:none', name: 'No list', items: visible.filter((t) => !listName[t.listId]) }])
          .filter((g) => g.items.length);
      }
      default:
        return [{ key: sel.id, name: null, items: sortTasks(visible, 'priority') }];
    }
  }
  const list = listName[sel.id];
  const open = sortTasks(visible.filter((t) => !t.done), list?.sort || 'manual');
  const done = visible.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  return [
    { key: `list:${sel.id}`, name: null, items: open, sortable: (list?.sort || 'manual') === 'manual', drop: {} },
    completedMode !== 'hide' && done.length && { key: 'done', name: 'Completed', items: done, done: true, collapsible: true },
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function TasksApp({ intent, nonce }) {
  const s = useSettings();
  const narrow = useNarrow();
  const tasks = useCollection('tasks');
  const listsRaw = useCollection('lists');
  const lists = useMemo(() => [...listsRaw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [listsRaw]);
  const [sel, setSel] = useState({ kind: 'smart', id: 'today' });
  const [openId, setOpenId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(() => new Map());
  const [showSide, setShowSide] = useState(false);
  const rootRef = useRef(null);
  const addRef = useRef(null);

  const list = sel.kind === 'list' ? lists.find((l) => l.id === sel.id) : null;
  const smart = sel.kind === 'smart' ? SMART_LISTS.find((x) => x.id === sel.id) : null;
  const views = s.tasks.views || {};
  const view = sel.kind === 'habits' ? 'habits' : (list ? list.view : views[sel.id]) || 'list';
  const setView = (v) => {
    if (list) put('lists', { ...list, view: v });
    else setSettings({ tasks: { views: { ...views, [sel.id]: v } } });
  };

  // Keep just-completed tasks where they were for a moment.
  const toggle = (task) => {
    const done = !task.done;
    setDone(task, done);
    if (done) {
      setRecent((m) => new Map(m).set(task.id, Date.now()));
      setTimeout(() => setRecent((m) => { const n = new Map(m); n.delete(task.id); return n; }), COMPLETE_DELAY);
      toast(`Completed “${task.title}”`, { icon: 'check-circle', action: { label: 'Undo', onClick: () => setDone(get('tasks', task.id) || task, false) } });
    }
  };

  const visible = useMemo(() => {
    let base;
    if (sel.kind === 'smart') base = smartFilter(sel.id, tasks);
    else if (sel.kind === 'list') base = tasks.filter((t) => t.listId === sel.id);
    else base = [];
    if (sel.kind === 'smart' && sel.id !== 'completed') {
      for (const id of recent.keys()) {
        const t = tasks.find((x) => x.id === id);
        if (t && !base.includes(t)) base = [...base, t];
      }
    }
    const q = query.trim().toLowerCase();
    if (q) base = base.filter((t) => t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q) || (t.subtasks || []).some((x) => x.title.toLowerCase().includes(q)));
    return base;
  }, [tasks, sel, recent, query]);

  const groups = useMemo(() => {
    const gs = groupsFor(sel, visible, lists, s.tasks.completed);
    // Recently completed tasks stay in their open group until the delay passes.
    if (recent.size) {
      for (const g of gs) if (g.done) g.items = g.items.filter((t) => !recent.has(t.id));
      if (sel.kind === 'list' || sel.id === 'today') {
        const target = gs.find((g) => !g.done && g.key !== 'overdue') || gs[0];
        for (const id of recent.keys()) {
          const t = tasks.find((x) => x.id === id);
          if (t && t.done && !gs.some((g) => !g.done && g.items.includes(t))) target.items = [...target.items, t];
        }
      }
    }
    return gs;
  }, [sel, visible, lists, s.tasks.completed, recent]);

  const flat = groups.flatMap((g) => g.items);

  const counts = useMemo(() => {
    const out = {};
    for (const sl of SMART_LISTS) out[sl.id] = sl.id === 'completed' ? null : smartFilter(sl.id, tasks).filter((t) => !t.done).length;
    for (const l of lists) out[l.id] = tasks.filter((t) => t.listId === l.id && !t.done).length;
    return out;
  }, [tasks, lists]);

  // --- intents ---
  useEffect(() => {
    if (!intent) return;
    if (intent.type === 'list') setSel(intent.id === 'habits' ? { kind: 'habits' } : SMART_LISTS.some((x) => x.id === intent.id) ? { kind: 'smart', id: intent.id } : { kind: 'list', id: intent.id });
    if (intent.type === 'task') {
      const t = get('tasks', intent.id);
      if (t) { setSel(t.listId && get('lists', t.listId) ? { kind: 'list', id: t.listId } : { kind: 'smart', id: 'all' }); setOpenId(t.id); setSelectedId(t.id); }
    }
    if (intent.type === 'new') setTimeout(() => addRef.current?.focus(), 400);
  }, [nonce]);

  // --- keyboard ---
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.popover, .spotlight')) return;
      const idx = flat.findIndex((t) => t.id === selectedId);
      const cur = flat[idx];
      if (e.key === 'ArrowDown' || e.key === 'j') { setSelectedId(flat[Math.min(flat.length - 1, idx + 1)]?.id ?? null); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { setSelectedId(flat[Math.max(0, idx - 1)]?.id ?? null); }
      else if (e.key === 'n') { addRef.current?.focus(); }
      else if (cur && e.key === ' ') { toggle(cur); }
      else if (cur && e.key === 'Enter') { setOpenId(cur.id); }
      else if (cur && (e.key === 'Backspace' || e.key === 'Delete')) { deleteTask(cur); setSelectedId(flat[idx + 1]?.id || flat[idx - 1]?.id || null); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- drag and drop ---
  const onDrop = ({ id, zone, index, target }) => {
    const task = get('tasks', id);
    if (!task) return false;
    if (target) {
      if (target.startsWith('list:')) { patch('tasks', id, { listId: target.slice(5) }); toast(`Moved to ${get('lists', target.slice(5))?.name}`, { icon: 'arrow-right' }); }
      else if (target === 'smart:today') patch('tasks', id, { due: todayKey() });
      else if (target === 'smart:upcoming') patch('tasks', id, { due: dayKey(addDays(new Date(), 1)) });
      else if (target === 'smart:important') patch('tasks', id, { priority: 3 });
      else if (target === 'smart:completed') { if (!task.done) toggle(task); }
      else return false;
      return true;
    }
    if (zone?.startsWith('status:')) {
      const status = zone.slice(7);
      const col = sortTasks(visible.filter((t) => (t.status || 'todo') === status && t.id !== id), 'manual');
      const done = status === 'done';
      if (done !== !!task.done) setDone(task, done);
      patch('tasks', id, { status, order: orderAt(col, index) });
      return true;
    }
    if (zone?.startsWith('prio:')) {
      const p = Number(zone.slice(5));
      const col = sortTasks(visible.filter((t) => (t.priority || 0) === p && t.id !== id && !t.done), 'manual');
      patch('tasks', id, { priority: p, order: orderAt(col, index) });
      return true;
    }
    const g = groups.find((x) => x.key === zone);
    if (!g) return false;
    const others = g.items.filter((t) => t.id !== id);
    const changes = { ...(g.drop || {}) };
    if (g.sortable || (list && (list.sort || 'manual') === 'manual')) changes.order = orderAt(others, index);
    if (!Object.keys(changes).length) return false;
    patch('tasks', id, changes);
    return true;
  };
  const drag = (e, task, el, handle = false) => startDrag(e, {
    id: task.id, el, root: rootRef.current, handle, onDrop,
    onClick: (ev) => { if (ev.target.closest('button')) return; setSelectedId(task.id); setOpenId(task.id); },
  });

  const openTask = openId && tasks.find((t) => t.id === openId);
  const title = list ? list.name : smart ? smart.name : 'Habits';
  const color = list ? list.color : smart ? smart.color : '#f2783c';
  const icon = list ? list.icon : smart ? smart.icon : 'target';
  const openCount = visible.filter((t) => !t.done).length;

  const pick = (next) => { setSel(next); setOpenId(null); setSelectedId(null); setQuery(''); setShowSide(false); };

  return html`<div class=${cx('app tasks', openTask && 'has-inspector', showSide && 'show-side')} ref=${rootRef} style=${{ '--list': color }}>
    <${Sidebar} sel=${sel} pick=${pick} lists=${lists} counts=${counts} />
    <section class="app-main">
      <header class="app-bar">
        <${IconButton} class="back-btn" icon="sidebar" label="Lists" onClick=${() => setShowSide(!showSide)} />
        <span class="tasks-title-icon" style=${{ background: color }}><${Icon} name=${icon} size=${17} stroke=${2} /></span>
        <h1 class="app-title">${title}</h1>
        ${view !== 'habits' && html`<span class="tasks-count">${openCount}</span>`}
        <div class="spacer" />
        ${view !== 'habits' && html`<div class="search-field tasks-search"><${Icon} name="search" size=${14} /><input class="field field-sm" placeholder="Filter" value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>`}
        ${view !== 'habits' && sel.id !== 'completed' && html`<${Segmented} size="sm" value=${view} onChange=${setView} options=${[
          { value: 'list', icon: 'list', title: 'List' },
          { value: 'board', icon: 'board', title: 'Board' },
          { value: 'matrix', icon: 'grid', title: 'Priority matrix' },
        ]} />`}
        ${(list || (smart && sel.id !== 'completed')) && html`<${IconButton} icon="more" label="List options" onClick=${(e) => openMenu(e.currentTarget, [
          ...(list ? [{ heading: 'Sort by' }, ...SORTS.map((so) => ({ label: so.label, checked: (list.sort || 'manual') === so.id, onSelect: () => put('lists', { ...list, sort: so.id }) })), { divider: true }] : []),
          { heading: 'Completed tasks' },
          { label: 'Show at the bottom', checked: s.tasks.completed !== 'hide', onSelect: () => setSettings({ tasks: { completed: 'section' } }) },
          { label: 'Hide', checked: s.tasks.completed === 'hide', onSelect: () => setSettings({ tasks: { completed: 'hide' } }) },
          ...(list ? [{ divider: true }, { label: 'Edit list…', icon: 'edit', onSelect: () => editList(list, rootRef.current?.querySelector(`[data-dnd-target="list:${list.id}"]`)) },
            { label: 'Clear completed', icon: 'check-circle', onSelect: () => clearCompleted(list) },
            { label: 'Delete list…', icon: 'trash', danger: true, onSelect: () => deleteList(list, pick) }] : []),
        ], { placement: 'bottom-end' })} />`}
      </header>

      ${view === 'habits'
        ? html`<${HabitsView} weekStart=${s.weekStart} />`
        : html`<${QuickAdd} inputRef=${addRef} sel=${sel} lists=${lists} />
          <div class="app-body tasks-body">
            ${view === 'list' && html`<${ListView} groups=${groups} sel=${sel} lists=${lists} recent=${recent} selectedId=${selectedId} openId=${openId} toggle=${toggle} drag=${drag} setOpenId=${setOpenId} query=${query} />`}
            ${view === 'board' && html`<${BoardView} tasks=${visible} sel=${sel} lists=${lists} recent=${recent} toggle=${toggle} drag=${drag} openId=${openId} />`}
            ${view === 'matrix' && html`<${MatrixView} tasks=${visible.filter((t) => !t.done || recent.has(t.id))} lists=${lists} sel=${sel} recent=${recent} toggle=${toggle} drag=${drag} openId=${openId} />`}
          </div>`}
    </section>
    ${openTask && html`<${Inspector} key=${openTask.id} task=${openTask} lists=${lists} toggle=${toggle} onClose=${() => setOpenId(null)} narrow=${narrow} />`}
  </div>`;
}

async function deleteList(list, pick) {
  const ts = all('tasks').filter((t) => t.listId === list.id);
  const ok = await confirm({ title: `Delete “${list.name}”?`, body: ts.length ? `Its ${plural(ts.length, 'task')} will be deleted too.` : 'This list is empty.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  remove('lists', list.id);
  ts.forEach((t) => remove('tasks', t.id));
  pick({ kind: 'smart', id: 'today' });
  toast(`Deleted ${list.name}`, { icon: 'trash', action: { label: 'Undo', onClick: () => { put('lists', list); ts.forEach((t) => put('tasks', t, { touch: false })); } } });
}

function clearCompleted(list) {
  const ts = all('tasks').filter((t) => t.listId === list.id && t.done);
  if (!ts.length) return;
  ts.forEach((t) => remove('tasks', t.id));
  toast(`Cleared ${plural(ts.length, 'completed task')}`, { icon: 'check-circle', action: { label: 'Undo', onClick: () => ts.forEach((t) => put('tasks', t, { touch: false })) } });
}

// ---------------------------------------------------------------------------
// Sidebar & list editor
// ---------------------------------------------------------------------------

let editListState = null;
const editListeners = new Set();
function editList(list, anchor) { editListState = { list, anchor }; editListeners.forEach((f) => f()); }

function Sidebar({ sel, pick, lists, counts }) {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((x) => x + 1); editListeners.add(f); return () => editListeners.delete(f); }, []);
  const habits = useCollection('habits').filter((h) => !h.archived);
  const todayHabitsLeft = habits.filter((h) => h.freq !== 'weekly' && !(h.log || {})[todayKey()]).length;

  const addList = (e) => {
    const l = { id: uid('list'), name: 'New list', color: LIST_COLORS[lists.length % LIST_COLORS.length], icon: LIST_ICONS[(lists.length + 1) % LIST_ICONS.length], view: 'list', sort: 'manual', order: (lists[lists.length - 1]?.order ?? 0) + 1 };
    put('lists', l);
    pick({ kind: 'list', id: l.id });
    const anchor = e.currentTarget;
    setTimeout(() => editList(l, document.querySelector(`[data-dnd-target="list:${l.id}"]`) || anchor), 60);
  };

  return html`<aside class="app-side tasks-side">
    <div class="smart-grid">
      ${SMART_LISTS.map((sl) => html`<button key=${sl.id} data-dnd-target=${`smart:${sl.id}`}
        class=${cx('smart-tile', sel.kind === 'smart' && sel.id === sl.id && 'is-active')} style=${{ '--c': sl.color }} onClick=${() => pick({ kind: 'smart', id: sl.id })}>
        <span class="smart-icon"><${Icon} name=${sl.icon} size=${15} stroke=${2.1} /></span>
        <span class="smart-count">${counts[sl.id] ?? ''}</span>
        <span class="smart-name">${sl.name}</span>
      </button>`)}
      <button class=${cx('smart-tile', sel.kind === 'habits' && 'is-active')} style=${{ '--c': '#a855f7' }} onClick=${() => pick({ kind: 'habits' })}>
        <span class="smart-icon"><${Icon} name="target" size=${15} stroke=${2.1} /></span>
        <span class="smart-count">${todayHabitsLeft || ''}</span>
        <span class="smart-name">Habits</span>
      </button>
    </div>

    <div class="side-section">
      <div class="side-label"><span>My lists</span><${IconButton} class="sm" icon="plus" size=${15} label="New list" onClick=${addList} /></div>
      ${lists.map((l) => html`<button key=${l.id} data-dnd-target=${`list:${l.id}`}
        class=${cx('side-item', sel.kind === 'list' && sel.id === l.id && 'is-active')}
        onClick=${() => pick({ kind: 'list', id: l.id })}
        onDblClick=${(e) => editList(l, e.currentTarget)}
        onContextMenu=${(e) => openContextMenu(e, [
          { label: 'Edit list…', icon: 'edit', onSelect: () => editList(l, e.target.closest('.side-item')) },
          { label: 'Clear completed', icon: 'check-circle', onSelect: () => clearCompleted(l) },
          { divider: true },
          { label: 'Delete list…', icon: 'trash', danger: true, onSelect: () => deleteList(l, pick) },
        ])}>
        <span class="side-icon-tile" style=${{ background: l.color }}><${Icon} name=${l.icon || 'list'} size=${13} stroke=${2.2} /></span>
        <span class="name">${l.name}</span>
        <span class="count">${counts[l.id] || ''}</span>
      </button>`)}
    </div>
    ${editListState && html`<${ListEditor} key=${editListState.list.id} ...${editListState} onClose=${() => { editListState = null; force((x) => x + 1); }} />`}
  </aside>`;
}

function ListEditor({ list, anchor, onClose }) {
  const cur = get('lists', list.id) || list;
  const [name, setName] = useState(cur.name);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const save = (changes) => put('lists', { ...(get('lists', list.id) || cur), ...changes });
  const live = get('lists', list.id) || cur;
  return html`<${Popover} anchor=${anchor} onClose=${() => { save({ name: name.trim() || 'Untitled' }); onClose(); }} placement="right-start" width=${290} class="list-editor">
    <div class="list-editor-body">
      <div class="list-editor-head">
        <span class="side-icon-tile is-lg" style=${{ background: live.color }}><${Icon} name=${live.icon || 'list'} size=${20} stroke=${2.1} /></span>
        <input ref=${inputRef} class="field" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { save({ name: name.trim() || 'Untitled' }); onClose(); } }} aria-label="List name" />
      </div>
      <${ColorDots} colors=${LIST_COLORS} value=${live.color} size=${22} onChange=${(c) => save({ color: c })} />
      <div class="icon-grid">
        ${LIST_ICONS.map((ic) => html`<button class=${cx('icon-choice', live.icon === ic && 'is-on')} onClick=${() => save({ icon: ic })} aria-label=${ic}><${Icon} name=${ic} size=${16} /></button>`)}
      </div>
    </div>
  </${Popover}>`;
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

function QuickAdd({ inputRef, sel, lists }) {
  const defaults = () => {
    const d = { due: null, priority: 0, listId: sel.kind === 'list' ? sel.id : lists[0]?.id || null };
    if (sel.kind === 'smart' && sel.id === 'today') d.due = todayKey();
    if (sel.kind === 'smart' && sel.id === 'upcoming') d.due = dayKey(addDays(new Date(), 1));
    if (sel.kind === 'smart' && sel.id === 'important') d.priority = 3;
    return d;
  };
  const [title, setTitle] = useState('');
  const [opts, setOpts] = useState(defaults);
  const [focused, setFocused] = useState(false);
  const [datePick, setDatePick] = useState(null);
  useEffect(() => { setOpts(defaults()); }, [sel.kind, sel.id]);

  const add = () => {
    const t = title.trim();
    if (!t) return;
    const siblings = all('tasks').filter((x) => x.listId === opts.listId);
    const order = Math.max(0, ...siblings.map((x) => x.order || 0)) + 1024;
    put('tasks', newTask({ title: t, ...opts, order }));
    setTitle('');
  };

  const list = lists.find((l) => l.id === opts.listId);
  const prio = PRIORITIES.find((p) => p.v === opts.priority);
  const dueLabel = opts.due ? relativeDay(fromKey(opts.due)) : 'Due';
  const showOpts = focused || title;

  return html`<div class=${cx('quick-add', showOpts && 'is-open')}>
    <span class="quick-add-plus"><${Icon} name="plus" size=${17} stroke=${2.2} /></span>
    <input ref=${inputRef} class="quick-add-input" placeholder=${sel.kind === 'smart' ? `Add a task to ${SMART_LISTS.find((x) => x.id === sel.id)?.name || 'Tasks'}` : 'Add a task'}
      value=${title} onInput=${(e) => setTitle(e.target.value)} onFocus=${() => setFocused(true)} onBlur=${() => setTimeout(() => setFocused(false), 150)}
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') { setTitle(''); e.target.blur(); } }} />
    <div class="quick-add-opts">
      <button class=${cx('chip', opts.due && 'is-on')} onPointerDown=${(e) => e.preventDefault()} onClick=${(e) => openMenu(e.currentTarget, [
        ...dueMenu(null, (due) => setOpts({ ...opts, due })),
        { label: 'Pick a date…', icon: 'calendar-days', onSelect: () => setDatePick(e.currentTarget) },
      ])}><${Icon} name="calendar" size=${13} />${dueLabel}</button>
      <button class=${cx('chip', opts.priority && 'is-on')} style=${prio?.color ? { color: prio.color } : null} onPointerDown=${(e) => e.preventDefault()}
        onClick=${(e) => openMenu(e.currentTarget, [...PRIORITIES].reverse().map((p) => ({ label: p.label, icon: 'flag', checked: p.v === opts.priority, onSelect: () => setOpts({ ...opts, priority: p.v }) })))}>
        <${Icon} name="flag" size=${13} />${opts.priority ? prio.label : 'Priority'}</button>
      ${sel.kind !== 'list' && html`<button class="chip" onPointerDown=${(e) => e.preventDefault()} onClick=${(e) => openMenu(e.currentTarget, lists.map((l) => ({ label: l.name, swatch: l.color, checked: l.id === opts.listId, onSelect: () => setOpts({ ...opts, listId: l.id }) })))}>
        <span class="swatch" style=${{ background: list?.color }} />${list?.name || 'List'}</button>`}
      <span class="kbd-hint"><kbd>↵</kbd></span>
    </div>
    ${datePick && html`<${Popover} anchor=${datePick} onClose=${() => setDatePick(null)} placement="bottom-start" width=${220}>
      <div class="date-pop"><input type="date" class="field" value=${opts.due || todayKey()} onChange=${(e) => { setOpts({ ...opts, due: e.target.value || null }); setDatePick(null); inputRef.current?.focus(); }} /></div>
    </${Popover}>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Task row & card
// ---------------------------------------------------------------------------

function CheckCircle({ task, toggle, size = 20 }) {
  const p = PRIORITIES.find((x) => x.v === (task.priority || 0));
  return html`<button class=${cx('task-check', task.done && 'is-done')} style=${{ '--c': p?.color || 'var(--text-3)', width: size, height: size }}
    onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); toggle(task); }} aria-label=${task.done ? 'Mark as not done' : 'Complete'} aria-pressed=${!!task.done}>
    <svg viewBox="0 0 20 20" width=${size} height=${size}><path d="M5.5 10.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>`;
}

function TaskMeta({ task, lists, showList }) {
  const due = dueInfo(task);
  const prog = subtaskProgress(task);
  const list = showList && lists.find((l) => l.id === task.listId);
  const items = [
    due && html`<span class=${cx('meta-due', `is-${due.tone}`)}><${Icon} name="calendar" size=${12} />${due.text}</span>`,
    task.repeat && html`<span class="meta-icon" title=${REPEATS.find((r) => r.id === task.repeat)?.label}><${Icon} name="repeat" size=${12} /></span>`,
    prog && html`<span class=${cx('meta-sub', prog.done === prog.total && 'is-complete')}><${Icon} name="checklist" size=${12} />${prog.done}/${prog.total}</span>`,
    task.notes && html`<span class="meta-icon" title="Has notes"><${Icon} name="note" size=${12} /></span>`,
    list && html`<span class="meta-list"><span class="swatch" style=${{ background: list.color }} />${list.name}</span>`,
  ].filter(Boolean);
  return items.length ? html`<div class="task-meta">${items}</div>` : null;
}

function TaskRow({ task, lists, showList, toggle, drag, selected, open, completing }) {
  const ref = useRef(null);
  const p = PRIORITIES.find((x) => x.v === (task.priority || 0));
  return html`<div ref=${ref} class=${cx('task-row', task.done && 'is-done', completing && 'is-completing', selected && 'is-selected', open && 'is-open')}
    data-dnd-id=${task.id}
    onPointerDown=${(e) => drag(e, task, ref.current)}
    onContextMenu=${(e) => openContextMenu(e, taskMenu(task, lists))}>
    <span class="task-grip" onPointerDown=${(e) => { e.stopPropagation(); drag(e, task, ref.current, true); }}><${Icon} name="grip" size=${14} /></span>
    <${CheckCircle} task=${task} toggle=${toggle} />
    <div class="task-main">
      <div class="task-title">
        ${task.priority > 0 && html`<span class="task-prio" style=${{ color: p.color }}>${p.short}</span>`}
        <span class="task-title-text">${task.title}</span>
      </div>
      <${TaskMeta} task=${task} lists=${lists} showList=${showList} />
    </div>
    <${IconButton} class="sm task-more" icon="more" size=${15} label="Task options" onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => openMenu(e.currentTarget, taskMenu(task, lists), { placement: 'bottom-end' })} />
  </div>`;
}

function TaskCard({ task, lists, showList, toggle, drag, open, completing }) {
  const ref = useRef(null);
  const prog = subtaskProgress(task);
  return html`<div ref=${ref} class=${cx('task-card', task.done && 'is-done', completing && 'is-completing', open && 'is-open')} data-dnd-id=${task.id}
    onPointerDown=${(e) => drag(e, task, ref.current)} onContextMenu=${(e) => openContextMenu(e, taskMenu(task, lists))}>
    <div class="task-card-top">
      <${CheckCircle} task=${task} toggle=${toggle} size=${18} />
      <span class="task-title-text">${task.title}</span>
      <span class="task-grip" onPointerDown=${(e) => { e.stopPropagation(); drag(e, task, ref.current, true); }}><${Icon} name="grip" size=${13} /></span>
    </div>
    ${prog && html`<div class="task-card-prog"><span style=${{ width: `${prog.pct * 100}%` }} /></div>`}
    <${TaskMeta} task=${task} lists=${lists} showList=${showList} />
  </div>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function ListView({ groups, sel, lists, recent, selectedId, openId, toggle, drag, query }) {
  const [collapsed, setCollapsed] = useState(() => new Set(['done']));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total && sel.id !== 'upcoming') {
    const msg = query ? ['No matches', `Nothing here matches “${query}”.`]
      : sel.id === 'today' ? ['Nothing due today', 'Enjoy the space, or plan something with the bar above.']
      : sel.id === 'completed' ? ['Nothing completed yet', 'Finished tasks will collect here.']
      : sel.id === 'important' ? ['Nothing urgent', 'High-priority tasks show up here.']
      : ['All clear', 'Add a task with the bar above.'];
    return html`<${EmptyState} icon=${sel.id === 'today' ? 'sun' : 'check-circle'} title=${msg[0]} body=${msg[1]} />`;
  }
  const showList = sel.kind === 'smart';
  return html`<div class="task-groups">
    ${groups.map((g) => {
      const isCollapsed = g.collapsible && collapsed.has(g.key);
      if (g.compact && !g.items.length) {
        return html`<div class="task-group is-empty" key=${g.key} data-dnd-zone=${g.key}>
          <div class="task-group-head"><span>${g.name}</span>${g.sub && html`<span class="sub">${g.sub}</span>`}</div>
        </div>`;
      }
      return html`<div class=${cx('task-group', g.tone && `is-${g.tone}`)} key=${g.key}>
        ${g.name && html`<button class="task-group-head" disabled=${!g.collapsible} onClick=${() => g.collapsible && setCollapsed((c) => { const n = new Set(c); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>
          ${g.collapsible && html`<${Icon} name=${isCollapsed ? 'chevron-right' : 'chevron-down'} size=${14} />`}
          ${g.color && html`<span class="swatch" style=${{ background: g.color }} />`}
          <span>${g.name}</span>${g.sub && html`<span class="sub">${g.sub}</span>`}<span class="count">${g.items.length}</span>
        </button>`}
        ${!isCollapsed && html`<div class="task-list" data-dnd-zone=${g.done ? undefined : g.key}>
          ${g.items.map((t) => html`<${TaskRow} key=${t.id} task=${t} lists=${lists} showList=${showList} toggle=${toggle} drag=${drag}
            selected=${t.id === selectedId} open=${t.id === openId} completing=${recent.has(t.id)} />`)}
        </div>`}
      </div>`;
    })}
  </div>`;
}

function BoardView({ tasks, sel, lists, recent, toggle, drag, openId }) {
  const [adding, setAdding] = useState(null);
  const [text, setText] = useState('');
  const showList = sel.kind === 'smart';
  const addTo = (status) => {
    const t = text.trim();
    if (!t) { setAdding(null); return; }
    const listId = sel.kind === 'list' ? sel.id : lists[0]?.id;
    put('tasks', newTask({ title: t, listId, status, done: status === 'done', doneAt: status === 'done' ? Date.now() : null, due: sel.id === 'today' ? todayKey() : null }));
    setText('');
  };
  return html`<div class="board">
    ${STATUSES.map((st) => {
      const items = sortTasks(tasks.filter((t) => (t.status || (t.done ? 'done' : 'todo')) === st.id), 'manual');
      return html`<div class="board-col" key=${st.id} style=${{ '--c': st.color }}>
        <div class="board-col-head"><i />${st.label}<span class="count">${items.length}</span></div>
        <div class="board-cards" data-dnd-zone=${`status:${st.id}`}>
          ${items.map((t) => html`<${TaskCard} key=${t.id} task=${t} lists=${lists} showList=${showList} toggle=${toggle} drag=${drag} open=${t.id === openId} completing=${recent.has(t.id)} />`)}
        </div>
        ${adding === st.id
          ? html`<input class="field board-add-input" autofocus placeholder="Task name" value=${text} onInput=${(e) => setText(e.target.value)}
              onKeyDown=${(e) => { if (e.key === 'Enter') addTo(st.id); if (e.key === 'Escape') { setAdding(null); setText(''); } }} onBlur=${() => { addTo(st.id); setAdding(null); }} ref=${(el) => el && setTimeout(() => el.focus(), 0)} />`
          : html`<button class="board-add" onClick=${() => setAdding(st.id)}><${Icon} name="plus" size=${14} />Add</button>`}
      </div>`;
    })}
  </div>`;
}

function MatrixView({ tasks, lists, sel, recent, toggle, drag, openId }) {
  return html`<div class="matrix">
    ${QUADRANTS.map((q) => {
      const items = sortTasks(tasks.filter((t) => (t.priority || 0) === q.p), 'due');
      return html`<div class="quad" key=${q.p} style=${{ '--c': q.color }}>
        <div class="quad-head"><span class="quad-icon"><${Icon} name=${q.icon} size=${14} stroke=${2.1} /></span><div><div class="quad-name">${q.name}</div><div class="quad-sub">${q.sub}</div></div><span class="count">${items.length}</span></div>
        <div class="quad-cards" data-dnd-zone=${`prio:${q.p}`}>
          ${items.map((t) => html`<${TaskRow} key=${t.id} task=${t} lists=${lists} showList=${sel.kind === 'smart'} toggle=${toggle} drag=${drag} open=${t.id === openId} completing=${recent.has(t.id)} />`)}
          ${!items.length && html`<div class="quad-empty">Drop tasks here</div>`}
        </div>
      </div>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function Inspector({ task, lists, toggle, onClose, narrow }) {
  const [title, setTitle, flushTitle] = useDraft(task.title, (v) => patch('tasks', task.id, { title: v.trim() || 'Untitled' }));
  const [notes, setNotes, flushNotes] = useDraft(task.notes || '', (v) => patch('tasks', task.id, { notes: v }));
  const [newSub, setNewSub] = useState('');
  const subRefs = useRef({});
  useEscape(onClose);
  const list = lists.find((l) => l.id === task.listId);
  const prog = subtaskProgress(task);
  const subs = task.subtasks || [];
  const setSubs = (next) => patch('tasks', task.id, { subtasks: next });

  const addSub = (after = null, text = newSub) => {
    const t = text.trim();
    if (!t && after === null) return;
    const sub = { id: uid('s'), title: t, done: false };
    const i = after == null ? subs.length : subs.findIndex((x) => x.id === after) + 1;
    setSubs([...subs.slice(0, i), sub, ...subs.slice(i)]);
    if (after == null) setNewSub('');
    else setTimeout(() => subRefs.current[sub.id]?.focus(), 30);
  };

  return html`<aside class=${cx('inspector', narrow && 'is-full')}>
    <div class="inspector-head">
      <${IconButton} icon=${narrow ? 'arrow-left' : 'x'} label="Close details" onClick=${() => { flushTitle(); flushNotes(); onClose(); }} />
      <span class="inspector-crumb"><span class="swatch" style=${{ background: list?.color }} />${list?.name || 'No list'}</span>
      <div class="spacer" />
      <${IconButton} icon="more" label="More" onClick=${(e) => openMenu(e.currentTarget, taskMenu(task, lists), { placement: 'bottom-end' })} />
    </div>
    <div class="inspector-body">
      <div class="inspector-title-row">
        <${CheckCircle} task=${task} toggle=${toggle} size=${24} />
        <${AutoTextarea} class=${cx('inspector-title', task.done && 'is-done')} value=${title} onInput=${(e) => setTitle(e.target.value.replace(/\n/g, ''))} onBlur=${flushTitle}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }} aria-label="Task title" />
      </div>
      <${AutoTextarea} class="inspector-notes" value=${notes} placeholder="Notes" minRows=${2} onInput=${(e) => setNotes(e.target.value)} onBlur=${flushNotes} />

      <div class="inspector-section">
        <div class="inspector-label">Subtasks ${prog && html`<span>${prog.done}/${prog.total}</span>`}</div>
        ${prog && html`<div class="subtask-progress"><span style=${{ width: `${prog.pct * 100}%` }} /></div>`}
        <div class="subtasks">
          ${subs.map((sub) => html`<div class=${cx('subtask', sub.done && 'is-done')} key=${sub.id}>
            <button class=${cx('task-check sm', sub.done && 'is-done')} style=${{ '--c': 'var(--text-3)' }} onClick=${() => setSubs(subs.map((x) => x.id === sub.id ? { ...x, done: !x.done } : x))} aria-label="Toggle subtask">
              <svg viewBox="0 0 20 20" width="16" height="16"><path d="M5.5 10.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <input ref=${(el) => { subRefs.current[sub.id] = el; }} class="subtask-input" value=${sub.title}
              onChange=${(e) => setSubs(subs.map((x) => x.id === sub.id ? { ...x, title: e.target.value } : x))}
              onKeyDown=${(e) => {
                if (e.key === 'Enter') { e.preventDefault(); setSubs(subs.map((x) => x.id === sub.id ? { ...x, title: e.target.value } : x)); setTimeout(() => addSub(sub.id, ' '), 0); }
                if (e.key === 'Backspace' && !e.target.value) { e.preventDefault(); const i = subs.indexOf(sub); setSubs(subs.filter((x) => x.id !== sub.id)); setTimeout(() => subRefs.current[subs[i - 1]?.id]?.focus(), 0); }
              }} />
            <${IconButton} class="sm subtask-del" icon="x" size=${13} label="Remove subtask" onClick=${() => setSubs(subs.filter((x) => x.id !== sub.id))} />
          </div>`)}
          <div class="subtask is-new">
            <${Icon} name="plus" size=${15} />
            <input class="subtask-input" placeholder="Add a subtask" value=${newSub} onInput=${(e) => setNewSub(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } }} />
          </div>
        </div>
      </div>

      <div class="inspector-grid">
        <span class="inspector-label"><${Icon} name="calendar" size=${14} />Due</span>
        <div class="inspector-row">
          <input type="date" class="field field-sm" value=${task.due || ''} onChange=${(e) => patch('tasks', task.id, { due: e.target.value || null })} />
          ${task.due && html`<input type="time" class="field field-sm" value=${task.dueTime || ''} onChange=${(e) => patch('tasks', task.id, { dueTime: e.target.value || null })} />`}
        </div>
        <span />
        <div class="inspector-row chips">
          ${dueMenu(task).map((m) => html`<button class="chip" onClick=${m.onSelect}>${m.label}</button>`)}
        </div>

        <span class="inspector-label"><${Icon} name="repeat" size=${14} />Repeat</span>
        <select class="field field-sm" value=${task.repeat || ''} onChange=${(e) => patch('tasks', task.id, { repeat: e.target.value || null, due: task.due || (e.target.value ? todayKey() : null) })}>
          ${REPEATS.map((r) => html`<option value=${r.id || ''}>${r.label}</option>`)}
        </select>

        <span class="inspector-label"><${Icon} name="flag" size=${14} />Priority</span>
        <${Segmented} size="sm" value=${task.priority || 0} onChange=${(v) => patch('tasks', task.id, { priority: v })} options=${PRIORITIES.map((p) => ({ value: p.v, label: p.label }))} />

        <span class="inspector-label"><${Icon} name="board" size=${14} />Status</span>
        <${Segmented} size="sm" value=${task.status || (task.done ? 'done' : 'todo')} onChange=${(v) => { if ((v === 'done') !== !!task.done) setDone(task, v === 'done'); patch('tasks', task.id, { status: v }); }} options=${STATUSES.map((x) => ({ value: x.id, label: x.label }))} />

        <span class="inspector-label"><${Icon} name="list" size=${14} />List</span>
        <button class="field field-sm inspector-list" onClick=${(e) => openMenu(e.currentTarget, lists.map((l) => ({ label: l.name, swatch: l.color, checked: l.id === task.listId, onSelect: () => patch('tasks', task.id, { listId: l.id }) })))}>
          <span class="swatch" style=${{ background: list?.color }} />${list?.name || 'No list'}<${Icon} name="chevron-down" size=${13} />
        </button>
      </div>

      <div class="inspector-foot">
        <span>Created ${timeAgo(task.createdAt)}${task.done && task.doneAt ? ` · Completed ${timeAgo(task.doneAt)}` : ''}</span>
        <button class="btn btn-sm btn-danger" onClick=${() => { deleteTask(task); onClose(); }}><${Icon} name="trash" size=${14} />Delete</button>
      </div>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

function HabitsView({ weekStart }) {
  const habits = useCollection('habits').filter((h) => !h.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const [editing, setEditing] = useState(null);
  const days = Array.from({ length: 14 }, (_, i) => addDays(new Date(), i - 13));
  const weeks = Array.from({ length: 8 }, (_, i) => startOfWeek(addDays(new Date(), (i - 7) * 7), weekStart));

  const toggleDay = (h, d) => {
    const k = dayKey(d);
    const log = { ...(h.log || {}) };
    if (log[k]) delete log[k]; else log[k] = 1;
    patch('habits', h.id, { log });
  };

  const totalToday = habits.filter((h) => h.freq !== 'weekly').length;
  const doneToday = habits.filter((h) => h.freq !== 'weekly' && (h.log || {})[todayKey()]).length;

  return html`<div class="app-body habits">
    <div class="habits-top">
      <div class="habits-summary">
        <div class="habits-big">${doneToday}<span>/${totalToday}</span></div>
        <div class="habits-sub">daily habits done today</div>
      </div>
      <button class="btn btn-primary" onClick=${(e) => setEditing({ anchor: e.currentTarget, habit: null })}><${Icon} name="plus" size=${15} />New habit</button>
    </div>
    ${!habits.length && html`<${EmptyState} icon="target" title="Build a habit" body="Track something you want to do every day or a few times a week. Streaks show up on the home screen too." />`}
    <div class="habit-list">
      ${habits.map((h) => {
        const weekly = h.freq === 'weekly';
        const target = weekly ? (h.target || 3) : 1;
        const streak = habitStreak(h, weekStart);
        return html`<div class="habit" key=${h.id} style=${{ '--c': h.color }}
          onContextMenu=${(e) => openContextMenu(e, [
            { label: 'Edit habit…', icon: 'edit', onSelect: () => setEditing({ anchor: e.target.closest('.habit'), habit: h }) },
            { label: 'Archive', icon: 'archive', onSelect: () => { patch('habits', h.id, { archived: true }); toast(`Archived ${h.name}`, { action: { label: 'Undo', onClick: () => patch('habits', h.id, { archived: false }) } }); } },
            { label: 'Delete', icon: 'trash', danger: true, onSelect: () => { remove('habits', h.id); toast(`Deleted ${h.name}`, { icon: 'trash', action: { label: 'Undo', onClick: () => put('habits', h, { touch: false }) } }); } },
          ])}>
          <button class="habit-id" onClick=${(e) => setEditing({ anchor: e.currentTarget, habit: h })}>
            <span class="habit-emoji">${h.emoji || '•'}</span>
            <span class="habit-text">
              <span class="habit-name">${h.name}</span>
              <span class="habit-stats"><${Icon} name="flame" size=${12} />${plural(streak, weekly ? 'week' : 'day')}${!weekly && html`<span class="dot">·</span>${Math.round(habitRate(h) * 100)}% this month`}${weekly && html`<span class="dot">·</span>${target}× a week`}</span>
            </span>
          </button>
          <div class="habit-track">
            ${weekly
              ? weeks.map((w) => {
                const n = periodCount(h, w, weekStart);
                const isNow = sameWeek(w, new Date(), weekStart);
                return html`<button class=${cx('habit-week', n >= target && 'is-met', isNow && 'is-now')} title=${`Week of ${fmt(w, 'monthDay')}: ${n}/${target}`}
                  onClick=${() => isNow && toggleDay(h, new Date())}>
                  <span class="habit-week-bar" style=${{ height: `${Math.min(1, n / target) * 100}%` }} />
                  <span class="habit-week-n">${n}</span>
                </button>`;
              })
              : days.map((d) => {
                const on = !!(h.log || {})[dayKey(d)];
                return html`<button class=${cx('habit-day', on && 'is-on', isToday(d) && 'is-today')} title=${fmt(d, 'full')} onClick=${() => toggleDay(h, d)} aria-pressed=${on}>
                  <span class="habit-day-wd">${fmt(d, 'weekdayShort').slice(0, 1)}</span>
                  <span class="habit-dot">${on && html`<${Icon} name="check" size=${12} stroke=${3} />`}</span>
                </button>`;
              })}
          </div>
        </div>`;
      })}
    </div>
    ${editing && html`<${HabitEditor} ...${editing} onClose=${() => setEditing(null)} count=${habits.length} />`}
  </div>`;
}

const sameWeek = (a, b, ws) => startOfWeek(a, ws).getTime() === startOfWeek(b, ws).getTime();

function HabitEditor({ anchor, habit, onClose, count }) {
  const [f, setF] = useState(() => habit ? { ...habit } : { name: '', emoji: '✨', color: HABIT_COLORS[count % HABIT_COLORS.length], freq: 'daily', target: 3 });
  const save = () => {
    if (!f.name.trim()) { onClose(); return; }
    put('habits', { ...(habit || { id: uid('h'), log: {}, order: count }), ...f, name: f.name.trim() });
    onClose();
  };
  return html`<${Popover} anchor=${anchor} onClose=${save} onEscape=${onClose} placement="bottom-end" width=${300}>
    <form class="habit-form" onSubmit=${(e) => { e.preventDefault(); save(); }}>
      <div class="habit-form-head">
        <input class="habit-emoji-input" value=${f.emoji} maxLength=${4} onInput=${(e) => setF({ ...f, emoji: e.target.value })} aria-label="Emoji" />
        <input class="field" autofocus placeholder="Habit name" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} ref=${(el) => el && !habit && setTimeout(() => el.focus(), 0)} />
      </div>
      <${ColorDots} colors=${HABIT_COLORS} value=${f.color} onChange=${(c) => setF({ ...f, color: c })} />
      <${Segmented} value=${f.freq} onChange=${(v) => setF({ ...f, freq: v })} options=${[{ value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Times a week' }]} />
      ${f.freq === 'weekly' && html`<div class="habit-target">
        <${IconButton} icon="minus" label="Fewer" onClick=${() => setF({ ...f, target: clamp((f.target || 3) - 1, 1, 7) })} />
        <span>${f.target || 3}× a week</span>
        <${IconButton} icon="plus" label="More" onClick=${() => setF({ ...f, target: clamp((f.target || 3) + 1, 1, 7) })} />
      </div>`}
      <div class="dialog-actions"><button type="button" class="btn btn-sm btn-ghost" onClick=${onClose}>Cancel</button><button class="btn btn-sm btn-primary">${habit ? 'Save' : 'Add habit'}</button></div>
    </form>
  </${Popover}>`;
}
