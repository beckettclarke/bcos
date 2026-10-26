// Journal facts used by both the Journal app and the home-screen widget.

import { todayKey, dayKey, addDays, fromKey } from '../lib/date.js';

export const MOODS = [
  { v: 1, label: 'Awful', face: '😣', color: '#8b8fa3' },
  { v: 2, label: 'Low', face: '😕', color: '#6b9bd1' },
  { v: 3, label: 'Okay', face: '😐', color: '#a3b18a' },
  { v: 4, label: 'Good', face: '🙂', color: '#f4b740' },
  { v: 5, label: 'Great', face: '😄', color: '#f2783c' },
];

export const ACTIVITIES = [
  { id: 'work', label: 'Work', emoji: '💼' },
  { id: 'study', label: 'Study', emoji: '📚' },
  { id: 'exercise', label: 'Exercise', emoji: '🏃' },
  { id: 'friends', label: 'Friends', emoji: '🫶' },
  { id: 'family', label: 'Family', emoji: '🏡' },
  { id: 'outside', label: 'Outdoors', emoji: '🌲' },
  { id: 'reading', label: 'Reading', emoji: '📖' },
  { id: 'music', label: 'Music', emoji: '🎧' },
  { id: 'gaming', label: 'Gaming', emoji: '🎮' },
  { id: 'rest', label: 'Rest', emoji: '😴' },
  { id: 'creative', label: 'Creating', emoji: '🎨' },
  { id: 'travel', label: 'Travel', emoji: '✈️' },
];

export const PROMPTS = [
  'What made today feel like today?',
  'What are you looking forward to?',
  'What took more energy than it should have?',
  'Who did you enjoy being around today?',
  'What’s one thing you’d do differently?',
  'What did you learn, even something small?',
  'What are you grateful for right now?',
  'What’s been on your mind lately?',
  'Describe a moment you want to remember.',
  'What would make tomorrow great?',
  'What are you proud of this week?',
  'Where did you feel most like yourself?',
];

export const promptFor = (key) => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROMPTS[h % PROMPTS.length];
};

export const hasContent = (e) => !!(e && ((e.text && e.text.trim()) || e.mood));

export function journalStats(entries) {
  const byDay = new Map(entries.filter(hasContent).map((e) => [e.id, e]));
  let streak = 0;
  let d = new Date();
  if (!byDay.has(todayKey())) d = addDays(d, -1);
  while (byDay.has(dayKey(d))) { streak++; d = addDays(d, -1); }

  const month = todayKey().slice(0, 7);
  const monthCount = [...byDay.keys()].filter((k) => k.startsWith(month)).length;

  const cutoff = dayKey(addDays(new Date(), -30));
  const moods = [...byDay.values()].filter((e) => e.mood && e.id >= cutoff).map((e) => e.mood);
  const avgMood = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null;

  const words = [...byDay.values()].reduce((n, e) => n + (e.text ? e.text.trim().split(/\s+/).filter(Boolean).length : 0), 0);

  let best = 0, run = 0, prev = null;
  for (const k of [...byDay.keys()].sort()) {
    run = prev && dayKey(addDays(fromKey(prev), 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { streak, best, monthCount, avgMood, total: byDay.size, words };
}
