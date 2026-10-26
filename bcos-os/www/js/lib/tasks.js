// Task and habit rules shared by the Tasks app, widgets and search.

import { put, get, remove } from './store.js';
import { uid } from './util.js';
import { todayKey, fromKey, dayKey, addDays, addMonths, daysBetween, relativeDay, startOfWeek } from './date.js';

export const PRIORITIES = [
  { v: 0, label: 'None', short: '', color: null },
  { v: 1, label: 'Low', short: '!', color: '#60a5fa' },
  { v: 2, label: 'Medium', short: '!!', color: '#f5b60a' },
  { v: 3, label: 'High', short: '!!!', color: '#ef4444' },
];

export const STATUSES = [
  { id: 'todo', label: 'To do', color: '#94a3b8' },
  { id: 'doing', label: 'In progress', color: '#f2783c' },
  { id: 'done', label: 'Done', color: '#22c55e' },
];

export const QUADRANTS = [
  { p: 3, name: 'Do first', sub: 'Urgent and important', color: '#ef4444', icon: 'bolt' },
  { p: 2, name: 'Schedule', sub: 'Important, not urgent', color: '#f5b60a', icon: 'calendar' },
  { p: 1, name: 'Delegate', sub: 'Urgent, less important', color: '#60a5fa', icon: 'share' },
  { p: 0, name: 'Later', sub: 'Neither', color: '#94a3b8', icon: 'moon' },
];

export const REPEATS = [
  { id: null, label: 'Never' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Every week' },
  { id: 'monthly', label: 'Every month' },
  { id: 'yearly', label: 'Every year' },
];

export const LIST_COLORS = ['#f2783c', '#ef4444', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8'];
export const LIST_ICONS = ['list', 'briefcase', 'home', 'cart', 'book', 'heart', 'star', 'plane', 'dumbbell', 'graduation', 'code', 'gift', 'leaf', 'coffee', 'music', 'sparkle'];

export const SORTS = [
  { id: 'manual', label: 'Manual' },
  { id: 'due', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'title', label: 'Name' },
  { id: 'created', label: 'Date created' },
];

export function nextRepeatDue(due, repeat) {
  const base = due ? fromKey(due) : new Date();
  switch (repeat) {
    case 'daily': return dayKey(addDays(base, 1));
    case 'weekdays': {
      let d = addDays(base, 1);
      while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
      return dayKey(d);
    }
    case 'weekly': return dayKey(addDays(base, 7));
    case 'monthly': return dayKey(addMonths(base, 1));
    case 'yearly': return dayKey(addMonths(base, 12));
    default: return null;
  }
}

/**
 * Complete or reopen a task. Completing a repeating task also schedules the
 * next one, the way Reminders does. Returns the follow-up task, if any.
 */
export function setDone(task, done) {
  const cur = get('tasks', task.id) || task;
  put('tasks', { ...cur, done, status: done ? 'done' : (cur.status === 'done' ? 'todo' : cur.status || 'todo'), doneAt: done ? Date.now() : null });
  if (done && cur.repeat && !cur.spawnedNext) {
    const next = {
      ...cur,
      id: uid('t'),
      done: false,
      status: 'todo',
      doneAt: null,
      due: nextRepeatDue(cur.due, cur.repeat),
      subtasks: (cur.subtasks || []).map((s) => ({ ...s, done: false })),
      createdAt: Date.now(),
      spawnedNext: false,
    };
    put('tasks', next);
    put('tasks', { ...get('tasks', cur.id), spawnedNext: next.id });
    return next;
  }
  if (!done && cur.spawnedNext) {
    // Reopening undoes the follow-up if it hasn't been touched.
    const spawned = get('tasks', cur.spawnedNext);
    if (spawned && !spawned.done) remove('tasks', spawned.id);
    put('tasks', { ...get('tasks', cur.id), spawnedNext: false });
  }
  return null;
}

export function dueInfo(task) {
  if (!task.due) return null;
  const diff = daysBetween(Date.now(), fromKey(task.due));
  let tone = 'later';
  if (!task.done && diff < 0) tone = 'overdue';
  else if (diff === 0) tone = 'today';
  else if (diff === 1) tone = 'soon';
  let text = relativeDay(fromKey(task.due));
  if (task.dueTime) {
    const [h, m] = task.dueTime.split(':').map(Number);
    const d = fromKey(task.due);
    d.setHours(h, m);
    text += `, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return { text, tone, diff };
}

export function isOverdue(task) {
  return !task.done && task.due && task.due < todayKey();
}

export function sortTasks(tasks, mode = 'manual') {
  const arr = [...tasks];
  const byOrder = (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
  switch (mode) {
    case 'due': return arr.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.dueTime || '99').localeCompare(b.dueTime || '99') || byOrder(a, b));
    case 'priority': return arr.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.due || '9999').localeCompare(b.due || '9999') || byOrder(a, b));
    case 'title': return arr.sort((a, b) => a.title.localeCompare(b.title));
    case 'created': return arr.sort((a, b) => b.createdAt - a.createdAt);
    default: return arr.sort(byOrder);
  }
}

export const SMART_LISTS = [
  { id: 'today', name: 'Today', icon: 'sun', color: '#f2783c' },
  { id: 'upcoming', name: 'Upcoming', icon: 'calendar', color: '#3b82f6' },
  { id: 'important', name: 'Important', icon: 'flag', color: '#ef4444' },
  { id: 'all', name: 'All', icon: 'inbox', color: '#94a3b8' },
  { id: 'completed', name: 'Completed', icon: 'check-circle', color: '#22c55e' },
];

export function smartFilter(id, tasks) {
  const today = todayKey();
  switch (id) {
    case 'today': return tasks.filter((t) => t.due && (t.due <= today) && (!t.done || (t.doneAt && dayKey(t.doneAt) === today)));
    case 'upcoming': return tasks.filter((t) => !t.done && t.due && t.due > today);
    case 'important': return tasks.filter((t) => !t.done && (t.priority || 0) >= 3);
    case 'all': return tasks.filter((t) => !t.done);
    case 'completed': return tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    default: return tasks;
  }
}

export function subtaskProgress(task) {
  const subs = task.subtasks || [];
  if (!subs.length) return null;
  const done = subs.filter((s) => s.done).length;
  return { done, total: subs.length, pct: done / subs.length };
}

// --- habits ----------------------------------------------------------------

export const HABIT_COLORS = ['#f2783c', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];

/** How many check-ins fall in the period that contains `day`. */
export function periodCount(habit, day, weekStart = 0) {
  const log = habit.log || {};
  if (habit.freq !== 'weekly') return log[dayKey(day)] || 0;
  const ws = startOfWeek(day, weekStart);
  let n = 0;
  for (let i = 0; i < 7; i++) n += log[dayKey(addDays(ws, i))] || 0;
  return n;
}

export function habitStreak(habit, weekStart = 0) {
  const target = habit.freq === 'weekly' ? (habit.target || 3) : 1;
  const step = habit.freq === 'weekly' ? 7 : 1;
  let d = habit.freq === 'weekly' ? startOfWeek(new Date(), weekStart) : new Date();
  let streak = 0;
  // The current period counts if it's met; if not, it's not broken yet.
  if (periodCount(habit, d, weekStart) >= target) streak++;
  d = addDays(d, -step);
  for (let guard = 0; guard < 1000; guard++) {
    if (periodCount(habit, d, weekStart) >= target) { streak++; d = addDays(d, -step); }
    else break;
  }
  return streak;
}

export function habitRate(habit, days = 30) {
  const log = habit.log || {};
  let hit = 0;
  for (let i = 0; i < days; i++) if (log[dayKey(addDays(new Date(), -i))]) hit++;
  return hit / days;
}
