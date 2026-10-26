// Journal — one entry a day, with mood, activities, a daily prompt, a mood
// calendar, streaks, and "on this day".

import { html, useState, useEffect, useMemo, useRef } from '../lib/html.js';
import { useCollection, put, get, remove } from '../lib/store.js';
import { todayKey, dayKey, fromKey, addDays, addMonths, startOfMonth, monthGrid, fmt, isToday, isoWeek, sameDay } from '../lib/date.js';
import { cx, escapeHtml, plural, isTyping } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { IconButton, toast, useNarrow, openMenu, confirm } from '../ui/components.js';
import { useSettings } from '../lib/store.js';
import { RichEditor, digest, toMarkdown } from './editor.js';
import { MOODS, ACTIVITIES, promptFor, journalStats, hasContent } from './journal-shared.js';

const entryHtml = (e) => e?.html ?? (e?.text ? e.text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') : '');

function saveEntry(key, changes) {
  const cur = get('journal', key) || { id: key, date: key, mood: null, activities: [], html: '', text: '' };
  const next = { ...cur, ...changes };
  if (changes.html !== undefined) Object.assign(next, { text: digest(changes.html).text });
  if (!hasContent(next) && !(next.activities || []).length) { if (get('journal', key)) remove('journal', key); return; }
  put('journal', next);
}

export default function JournalApp({ intent, nonce }) {
  const s = useSettings();
  const narrow = useNarrow();
  const entries = useCollection('journal');
  const [day, setDay] = useState(todayKey());
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [showSide, setShowSide] = useState(false);

  useEffect(() => {
    if (intent?.type === 'day') { const k = intent.date || todayKey(); setDay(k); setMonth(startOfMonth(fromKey(k))); }
  }, [nonce]);

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || document.querySelector('.popover')) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 't') pick(todayKey());
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const byDay = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const stats = useMemo(() => journalStats(entries), [entries]);
  const pick = (k) => { setDay(k); setMonth(startOfMonth(fromKey(k))); setShowSide(false); };
  const go = (n) => { const k = dayKey(addDays(fromKey(day), n)); if (k <= todayKey()) pick(k); };
  const entry = byDay.get(day);

  const recent = useMemo(() => entries.filter(hasContent).sort((a, b) => b.id.localeCompare(a.id)), [entries]);

  return html`<div class=${cx('app journal', showSide && 'show-side')}>
    <aside class="app-side journal-side">
      <div class="side-head"><span class="side-title">Journal</span>
        <button class="btn btn-sm" onClick=${() => pick(todayKey())} disabled=${day === todayKey()}>Today</button>
      </div>
      <div class="j-stats">
        <div class="j-stat"><${Icon} name="flame" size=${16} /><b>${stats.streak}</b><span>day streak</span></div>
        <div class="j-stat"><${Icon} name="book-open" size=${16} /><b>${stats.monthCount}</b><span>this month</span></div>
        <div class="j-stat"><${Icon} name="pen" size=${16} /><b>${stats.words >= 1000 ? `${(stats.words / 1000).toFixed(1)}k` : stats.words}</b><span>words</span></div>
      </div>
      <${MoodCalendar} month=${month} setMonth=${setMonth} byDay=${byDay} day=${day} pick=${pick} weekStart=${s.weekStart} />
      <${MoodLine} byDay=${byDay} />
      <div class="side-section j-entries">
        <div class="side-label"><span>Entries</span><span class="muted">${recent.length}</span></div>
        ${recent.slice(0, 40).map((e) => {
          const mood = MOODS.find((m) => m.v === e.mood);
          return html`<button key=${e.id} class=${cx('j-entry', e.id === day && 'is-active')} onClick=${() => pick(e.id)}>
            <span class="j-entry-date"><b>${fromKey(e.id).getDate()}</b><span>${fmt(fromKey(e.id), 'monthShort')}</span></span>
            <span class="j-entry-text">
              <span class="j-entry-day">${fmt(fromKey(e.id), 'weekdayLong')}${mood && html` <span class="j-entry-mood">${mood.face}</span>`}</span>
              <span class="j-entry-snippet">${(e.text || '').slice(0, 90) || 'Mood only'}</span>
            </span>
          </button>`;
        })}
      </div>
    </aside>
    <section class="app-main journal-main">
      <${EntryEditor} key=${day} day=${day} entry=${entry} byDay=${byDay} go=${go} toggleSide=${() => setShowSide(!showSide)} pick=${pick} />
    </section>
  </div>`;
}

function MoodCalendar({ month, setMonth, byDay, day, pick, weekStart }) {
  const grid = monthGrid(month, weekStart);
  const today = todayKey();
  return html`<div class="j-cal">
    <div class="mini-head">
      <span class="mini-title">${fmt(month, 'monthLong')} <span class="light">${month.getFullYear()}</span></span>
      <${IconButton} class="sm" icon="chevron-left" size=${14} label="Previous month" onClick=${() => setMonth(addMonths(month, -1))} />
      <${IconButton} class="sm" icon="chevron-right" size=${14} label="Next month" onClick=${() => setMonth(addMonths(month, 1))} disabled=${dayKey(addMonths(month, 1)) > today} />
    </div>
    <div class="j-cal-grid">
      ${grid.map((d) => {
        const k = dayKey(d);
        const e = byDay.get(k);
        const mood = e && MOODS.find((m) => m.v === e.mood);
        const other = d.getMonth() !== month.getMonth();
        const future = k > today;
        return html`<button key=${k} disabled=${future}
          class=${cx('j-day', other && 'is-other', hasContent(e) && 'has-entry', k === day && 'is-active', k === today && 'is-today')}
          style=${mood ? { '--m': mood.color } : null} onClick=${() => pick(k)} aria-label=${fmt(d, 'full')}>
          ${d.getDate()}
        </button>`;
      })}
    </div>
  </div>`;
}

function MoodLine({ byDay }) {
  const days = Array.from({ length: 30 }, (_, i) => dayKey(addDays(new Date(), i - 29)));
  const pts = days.map((k, i) => ({ i, m: byDay.get(k)?.mood })).filter((p) => p.m);
  if (pts.length < 2) return null;
  const W = 220, H = 54;
  const x = (i) => (i / 29) * (W - 8) + 4;
  const y = (m) => H - 6 - ((m - 1) / 4) * (H - 12);
  const path = pts.map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.m).toFixed(1)}`).join(' ');
  return html`<div class="j-moodline">
    <div class="side-label"><span>Mood · 30 days</span></div>
    <svg viewBox=${`0 0 ${W} ${H}`} width="100%" height=${H} preserveAspectRatio="none">
      <defs><linearGradient id="jm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2783c" /><stop offset="0.5" stop-color="#f4b740" /><stop offset="1" stop-color="#6b9bd1" /></linearGradient></defs>
      <path d=${path} fill="none" stroke="url(#jm)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      ${pts.map((p) => html`<circle cx=${x(p.i)} cy=${y(p.m)} r="2.6" fill=${MOODS[p.m - 1].color} />`)}
    </svg>
  </div>`;
}

function EntryEditor({ day, entry, byDay, go, toggleSide, pick }) {
  const d = fromKey(day);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef(0);
  const prompt = promptFor(day);
  const words = (entry?.text || '').split(/\s+/).filter(Boolean).length;
  const flashSaved = () => { setSaved(true); clearTimeout(savedTimer.current); savedTimer.current = setTimeout(() => setSaved(false), 1600); };

  const setMood = (v) => { saveEntry(day, { mood: entry?.mood === v ? null : v }); };
  const toggleActivity = (id) => {
    const cur = entry?.activities || [];
    saveEntry(day, { activities: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };

  // On this day: the same date a month ago and a year ago.
  const memories = [
    { label: 'A month ago', key: dayKey(addMonths(d, -1)) },
    { label: 'A year ago', key: dayKey(addMonths(d, -12)) },
    { label: 'A week ago', key: dayKey(addDays(d, -7)) },
  ].map((m) => ({ ...m, e: byDay.get(m.key) })).filter((m) => hasContent(m.e) && m.e.text);

  const mood = MOODS.find((m) => m.v === entry?.mood);

  return html`<div class="j-editor" style=${mood ? { '--m': mood.color } : null}>
    <div class="j-glow" />
    <header class="j-head">
      <${IconButton} class="back-btn" icon="calendar" label="Calendar" onClick=${toggleSide} />
      <${IconButton} icon="chevron-left" label="Previous day" onClick=${() => go(-1)} />
      <${IconButton} icon="chevron-right" label="Next day" onClick=${() => go(1)} disabled=${day >= todayKey()} />
      <div class="spacer" />
      <span class=${cx('j-saved', saved && 'is-on')}><${Icon} name="check" size=${13} />Saved</span>
      ${entry && html`<${IconButton} icon="more" label="Entry options" onClick=${(e) => openMenu(e.currentTarget, [
        { label: 'Copy as Markdown', icon: 'copy', onSelect: () => { navigator.clipboard?.writeText(`# ${fmt(d, 'fullYear')}\n\n${toMarkdown(entryHtml(entry))}`); toast('Copied', { icon: 'copy' }); } },
        { label: 'Delete entry…', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirm({ title: 'Delete this entry?', body: fmt(d, 'fullYear'), confirmLabel: 'Delete', danger: true }))) return;
          const before = entry;
          remove('journal', day);
          toast('Entry deleted', { icon: 'trash', action: { label: 'Undo', onClick: () => put('journal', before, { touch: false }) } });
        } },
      ], { placement: 'bottom-end' })} />`}
    </header>
    <div class="j-scroll">
      <div class="j-doc">
        <div class="j-kicker">${isToday(d) ? 'Today' : fmt(d, 'weekdayLong')} · ${d.getFullYear()} · Week ${isoWeek(d)}</div>
        <h1 class="j-date">${fmt(d, 'full')}</h1>

        <div class="j-moods" role="radiogroup" aria-label="Mood">
          ${MOODS.map((m) => html`<button key=${m.v} role="radio" aria-checked=${entry?.mood === m.v}
            class=${cx('j-mood', entry?.mood === m.v && 'is-on')} style=${{ '--c': m.color }} onClick=${() => setMood(m.v)}>
            <span class="j-mood-face">${m.face}</span><span class="j-mood-label">${m.label}</span>
          </button>`)}
        </div>

        <div class="j-acts">
          ${ACTIVITIES.map((a) => html`<button key=${a.id} class=${cx('chip j-act', (entry?.activities || []).includes(a.id) && 'is-on')} onClick=${() => toggleActivity(a.id)}>
            <span>${a.emoji}</span>${a.label}
          </button>`)}
        </div>

        <div class="j-prompt"><${Icon} name="sparkle" size=${14} /><span>${prompt}</span></div>

        <${RichEditor} docKey=${day} html=${entryHtml(entry)} class="j-rich" placeholder="Write about your day…"
          autofocus=${isToday(d) && !entry?.text}
          onChange=${(h, key) => { saveEntry(key, { html: h }); flashSaved(); }} />

        <div class="j-foot">${plural(words, 'word')}</div>

        ${memories.length > 0 && html`<div class="j-memories">
          <div class="j-memories-title"><${Icon} name="restore" size=${14} />On this day</div>
          ${memories.map((m) => html`<button key=${m.key} class="j-memory" onClick=${() => pick(m.key)}>
            <span class="j-memory-when">${m.label} · ${fmt(fromKey(m.key), 'monthDay')} ${MOODS.find((x) => x.v === m.e.mood)?.face || ''}</span>
            <span class="j-memory-text">${m.e.text.slice(0, 160)}</span>
          </button>`)}
        </div>`}
      </div>
    </div>
  </div>`;
}
