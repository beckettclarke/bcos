// Journal facts used by the Journal app, its import, and the home-screen widget.
//
// An entry (collection `journal`, id = 'YYYY-MM-DD'):
//   { id, date, v: 2, icon, title, rating (0.5–5), mood (1–7), html, text,
//     meals: { breakfast|lunch|dinner|snacks: [Food] }, cards: [Card],
//     people: [name], tags: [tag], photos: [{ id, url }] }
// Version-1 entries used a 1–5 mood and `activities`; moodOf/tagsOf read both.

import { todayKey, dayKey, addDays, fromKey } from '../lib/date.js';

// Apple-style "state of mind", the scale Diarly uses.
export const MOODS = [
  { v: 1, label: 'Very unpleasant', short: 'Awful', face: '😫', color: '#7c6cf2' },
  { v: 2, label: 'Unpleasant', short: 'Bad', face: '😞', color: '#5b8def' },
  { v: 3, label: 'Slightly unpleasant', short: 'Meh', face: '🙁', color: '#4fb0c6' },
  { v: 4, label: 'Neutral', short: 'Okay', face: '😐', color: '#8e9aa8' },
  { v: 5, label: 'Slightly pleasant', short: 'Good', face: '🙂', color: '#a3cf5f' },
  { v: 6, label: 'Pleasant', short: 'Great', face: '😊', color: '#f5c242' },
  { v: 7, label: 'Very pleasant', short: 'Amazing', face: '😄', color: '#ff8a3d' },
];

const LEGACY_MOOD = [1, 2, 4, 5, 7];
const LEGACY_ACTIVITY = { work: 'work', study: 'study', exercise: 'exercise', friends: 'friends', family: 'family', outside: 'outdoors', reading: 'reading', music: 'music', gaming: 'gaming', rest: 'rest', creative: 'creating', travel: 'travel' };

export const moodOf = (e) => (!e?.mood ? null : e.v >= 2 ? e.mood : LEGACY_MOOD[e.mood - 1] || null);
export const moodInfo = (v) => MOODS.find((m) => m.v === v) || null;
export const tagsOf = (e) => [...new Set([...(e?.tags || []), ...(e?.activities || []).map((a) => LEGACY_ACTIVITY[a] || a)])];

export const MEALS = [
  { id: 'breakfast', label: 'Breakfast', emoji: '🥞' },
  { id: 'lunch', label: 'Lunch', emoji: '🥗' },
  { id: 'dinner', label: 'Dinner', emoji: '🍝' },
  { id: 'snacks', label: 'Snacks', emoji: '🍿' },
];

export const foodCount = (e) => MEALS.reduce((n, m) => n + (e?.meals?.[m.id]?.length || 0), 0);

export const hasContent = (e) => !!(e && ((e.text && e.text.trim()) || e.mood || e.rating || e.title || e.icon
  || e.cards?.length || e.photos?.length || foodCount(e) || e.people?.length || e.tags?.length || e.activities?.length));

/** Mood, ratings, streaks and words across all entries. */
export function journalStats(entries) {
  const byDay = new Map(entries.filter(hasContent).map((e) => [e.id, e]));
  let streak = 0;
  let d = new Date();
  if (!byDay.has(todayKey())) d = addDays(d, -1);
  while (byDay.has(dayKey(d))) { streak++; d = addDays(d, -1); }

  const month = todayKey().slice(0, 7);
  const monthCount = [...byDay.keys()].filter((k) => k.startsWith(month)).length;

  const cutoff = dayKey(addDays(new Date(), -30));
  const recent = [...byDay.values()].filter((e) => e.id >= cutoff);
  const moods = recent.map(moodOf).filter(Boolean);
  const avgMood = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
  const ratings = recent.map((e) => e.rating).filter(Boolean);
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

  const words = [...byDay.values()].reduce((n, e) => n + (e.text ? e.text.trim().split(/\s+/).filter(Boolean).length : 0), 0);

  let best = 0, run = 0, prev = null;
  for (const k of [...byDay.keys()].sort()) {
    run = prev && dayKey(addDays(fromKey(prev), 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { streak, best, monthCount, avgMood, avgRating, total: byDay.size, words };
}
