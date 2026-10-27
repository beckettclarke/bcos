// Journal — one entry a day. The sidebar is an endlessly scrolling month
// rail (photos, icons and mood dots) with filters and search; the entry has
// an icon, title, rating and mood, smart cards (flights, races, places…),
// the day's story, and a food log with icons.

import { html, render, useState, useEffect, useLayoutEffect, useMemo, useRef } from '../lib/html.js';
import { useCollection, put, get, remove, useSettings, setSettings, settings, useStatus, uploadImage } from '../lib/store.js';
import { todayKey, dayKey, fromKey, addDays, addMonths, startOfMonth, fmt, isToday, isoWeek, weekdayNames } from '../lib/date.js';
import { cx, escapeHtml, plural, isTyping, uid, downscaleImage, download } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { IconButton, toast, openMenu, confirm, Popover, useNarrow } from '../ui/components.js';
import { EmojiPicker } from '../ui/emoji.js';
import { runTask } from '../ui/ai.js';
import { RichEditor, digest, toMarkdown } from './editor.js';
import { MOODS, MEALS, moodOf, moodInfo, tagsOf, hasContent, journalStats, foodCount } from './journal-shared.js';
import { CARD_TYPES, Card, CardPin, CardEditor, cardType, cardSummary, cardIcon, normalizeCard, ENRICH_SYSTEM, enrichPrompt } from './journal-cards.js';
import { parseFoodText, foodLabel, foodSummary, iconFor, FOOD_SYSTEM, foodPrompt, normalizeMeals } from './journal-food.js';
import { ImportSheet } from './journal-import-ui.js';
import { os } from '../shell/os.js';

const entryHtml = (e) => e?.html ?? (e?.text ? e.text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') : '');

function saveEntry(key, changes) {
  const cur = get('journal', key) || { id: key, date: key };
  const next = { ...cur, ...changes, v: 2 };
  if (cur.v !== 2 && cur.mood && changes.mood === undefined) next.mood = moodOf(cur);
  if (changes.html !== undefined) next.text = digest(changes.html).text;
  if (!hasContent(next)) { if (get('journal', key)) remove('journal', key); return; }
  put('journal', next);
}

// --- filters -------------------------------------------------------------------

const hasCard = (type) => (e) => e.cards?.some((c) => c.type === type);
const QUICK = [
  { id: 'all', label: 'All' },
  { id: 'photos', label: 'Photos', test: (e) => e.photos?.length > 0 },
  { id: 'flight', label: 'Flights', test: hasCard('flight') },
  { id: 'race', label: 'Races', test: hasCard('race') },
  { id: 'top', label: '★ 4+', test: (e) => e.rating >= 4 },
];

function filterTest(f) {
  if (!f || f.id === 'all') return null;
  if (f.kind === 'card') return hasCard(f.value);
  if (f.kind === 'tag') return (e) => tagsOf(e).includes(f.value);
  if (f.kind === 'person') return (e) => e.people?.includes(f.value);
  if (f.kind === 'mood') return (e) => moodOf(e) === f.value;
  if (f.kind === 'place') return (e) => e.cards?.some((c) => c.type === 'place' && c.name === f.value);
  return QUICK.find((q) => q.id === f.id)?.test || null;
}

const tally = (lists) => {
  const m = new Map();
  for (const l of lists) for (const x of l) m.set(x, (m.get(x) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
};

// --- the app ---------------------------------------------------------------------

export default function JournalApp({ intent, nonce }) {
  const s = useSettings();
  const narrow = useNarrow();
  const entries = useCollection('journal');
  const [day, setDay] = useState(todayKey());
  const [showSide, setShowSide] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState({ id: 'all' });
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [jump, setJump] = useState(0); // bumps when the rail should bring `day` into view

  useEffect(() => {
    if (intent?.type === 'day') pick(intent.date || todayKey());
    if (intent?.type === 'import') setImporting(true);
  }, [nonce]);

  const byDay = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const stats = useMemo(() => journalStats(entries), [entries]);
  const test = filterTest(filter);
  const matches = useMemo(() => (test ? new Set(entries.filter((e) => hasContent(e) && test(e)).map((e) => e.id)) : null), [entries, filter]);

  const pick = (k, scroll = true) => { setDay(k); setShowSide(false); if (scroll) setJump((n) => n + 1); };
  const go = (n) => {
    if (matches?.size) {
      const keys = [...matches].sort();
      const next = n > 0 ? keys.find((k) => k > day) : keys.reverse().find((k) => k < day);
      if (next) return pick(next);
    }
    const k = dayKey(addDays(fromKey(day), n));
    if (k <= todayKey()) pick(k);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (os.app !== 'journal' || importing) return;
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

  return html`<div class=${cx('app journal', showSide && 'show-side', collapsed && !narrow && 'is-collapsed', s.journal.font === 'serif' && 'is-serif')}>
    <aside class="app-side journal-side">
      <${Sidebar} entries=${entries} byDay=${byDay} day=${day} pick=${pick} jump=${jump} weekStart=${s.weekStart}
        filter=${filter} setFilter=${setFilter} matches=${matches} query=${query} setQuery=${setQuery} stats=${stats} />
    </aside>
    <section class="app-main journal-main">
      <${EntryView} key=${day} day=${day} entry=${byDay.get(day)} byDay=${byDay} go=${go} pick=${pick} filtered=${!!matches}
        toggleSide=${() => (narrow ? setShowSide(!showSide) : setCollapsed(!collapsed))} collapsed=${collapsed && !narrow}
        openImport=${() => setImporting(true)} setFilter=${setFilter} />
    </section>
    ${importing && html`<${ImportSheet} onClose=${() => setImporting(false)} onDone=${(k) => k && pick(k)} />`}
  </div>`;
}

// --- sidebar ---------------------------------------------------------------------

function Sidebar({ entries, byDay, day, pick, jump, weekStart, filter, setFilter, matches, query, setQuery, stats }) {
  const [searching, setSearching] = useState(false);
  const [year, setYear] = useState(fromKey(day).getFullYear());
  const railApi = useRef(null);
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return [];
    return entries.filter((e) => hasContent(e) && [e.text, ...(e.people || []), ...tagsOf(e), ...(e.cards || []).map(cardSummary), ...MEALS.flatMap((m) => (e.meals?.[m.id] || []).map((f) => f.name))]
      .some((t) => t && String(t).toLowerCase().includes(q))).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 200);
  }, [entries, q]);

  const moreMenu = (el) => {
    const people = tally(entries.map((e) => e.people || [])).slice(0, 10);
    const tags = tally(entries.map(tagsOf)).slice(0, 10);
    const places = tally(entries.map((e) => (e.cards || []).filter((c) => c.type === 'place' && c.name).map((c) => c.name))).slice(0, 8);
    const item = (kind, value, label, icon) => ({ label, icon, checked: filter.kind === kind && filter.value === value, onSelect: () => setFilter({ id: `${kind}:${value}`, kind, value, label }) });
    openMenu(el, [
      { heading: 'Cards' },
      ...CARD_TYPES.filter((t) => !['flight', 'race'].includes(t.id)).map((t) => ({ ...item('card', t.id, t.label), icon: t.icon })),
      { divider: true }, { heading: 'Mood' },
      ...MOODS.slice().reverse().map((m) => ({ ...item('mood', m.v, m.label), swatch: m.color })),
      ...(people.length ? [{ divider: true }, { heading: 'People' }, ...people.map((p) => item('person', p, p, 'user'))] : []),
      ...(places.length ? [{ divider: true }, { heading: 'Places' }, ...places.map((p) => item('place', p, p, 'map-pin'))] : []),
      ...(tags.length ? [{ divider: true }, { heading: 'Tags' }, ...tags.map((t) => item('tag', t, t, 'hash'))] : []),
    ], { width: 230 });
  };
  const custom = filter.kind ? filter : null;

  return html`<div class="js">
    <div class="js-head">
      <div class="js-year">
        <button class="js-nav" aria-label="Previous year" onClick=${() => railApi.current?.toYear(year - 1)}><${Icon} name="chevron-left" size=${15} stroke=${2.2} /></button>
        <span class="js-year-num">${year}</span>
        <button class="js-nav" aria-label="Next year" disabled=${year >= new Date().getFullYear()} onClick=${() => railApi.current?.toYear(year + 1)}><${Icon} name="chevron-right" size=${15} stroke=${2.2} /></button>
      </div>
      <span class="spacer" />
      <button class=${cx('js-nav', searching && 'is-on')} aria-label="Search" onClick=${() => { setSearching(!searching); if (searching) setQuery(''); }}><${Icon} name="search" size=${15} /></button>
      <button class="js-today" onClick=${() => pick(todayKey())}>Today</button>
    </div>

    ${searching && html`<div class="js-search">
      <${Icon} name="search" size=${13} />
      <input autofocus placeholder="Search days, people, food…" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Escape') { setQuery(''); setSearching(false); } }} />
      ${query && html`<button aria-label="Clear" onClick=${() => setQuery('')}><${Icon} name="x" size=${12} /></button>`}
    </div>`}

    <div class="js-filters">
      ${QUICK.map((f) => html`<button key=${f.id} class=${cx('js-chip', filter.id === f.id && 'is-on')} onClick=${() => setFilter(f.id === filter.id ? { id: 'all' } : f)}>${f.label}</button>`)}
      ${custom ? html`<button class="js-chip is-on" onClick=${() => setFilter({ id: 'all' })}>${custom.label}<${Icon} name="x" size=${11} stroke=${2.4} /></button>`
        : html`<button class="js-chip" onClick=${(e) => moreMenu(e.currentTarget)}>More<${Icon} name="chevron-down" size=${11} stroke=${2.4} /></button>`}
    </div>
    ${matches && html`<div class="js-match">${plural(matches.size, 'day')} · use ← → to step through</div>`}

    ${q ? html`<div class="js-results">
      ${results.map((e) => html`<button key=${e.id} class=${cx('js-result', e.id === day && 'is-active')} onClick=${() => pick(e.id)}>
        <span class="js-result-icon" style=${e.photos?.[0] ? { backgroundImage: `url(${e.photos[0].url})` } : null}>${e.photos?.[0] ? '' : e.icon || html`<${Icon} name="book" size=${15} />`}</span>
        <span class="js-result-text"><b>${fmt(fromKey(e.id), 'full')}</b><span>${(e.text || '').slice(0, 110)}</span></span>
      </button>`)}
      ${!results.length && html`<div class="js-none">No days match “${query}”.</div>`}
    </div>` : html`<${MonthRail} byDay=${byDay} day=${day} pick=${pick} jump=${jump} weekStart=${weekStart} matches=${matches} onYear=${setYear} api=${railApi} />`}

    <div class="js-foot">
      <span><${Icon} name="flame" size=${13} />${plural(stats.streak, 'day')} streak</span>
      <span>${plural(stats.total, 'entry', 'entries')}</span>
    </div>
  </div>`;
}

// An endless column of months. It starts a year and a half back and grows
// upward as you scroll, keeping your place; Today sits at the bottom.
function MonthRail({ byDay, day, pick, jump, weekStart, matches, onYear, api }) {
  const today = todayKey();
  const end = startOfMonth(new Date());
  const [start, setStart] = useState(() => {
    const d = startOfMonth(addMonths(new Date(), -17));
    return fromKey(day) < d ? startOfMonth(addMonths(fromKey(day), -2)) : d;
  });
  const ref = useRef(null);
  const topRef = useRef(null);
  const anchor = useRef(null);   // scroll position to keep while months are added above
  const pending = useRef(null);  // { day } or { month } to reveal once it has rendered
  const mounted = useRef(false);
  const months = useMemo(() => {
    const out = [];
    for (let m = new Date(start); m <= end; m = addMonths(m, 1)) out.push(m);
    return out;
  }, [start.getTime(), end.getTime()]);

  const grow = (to) => {
    const el = ref.current;
    if (el) anchor.current = { h: el.scrollHeight, top: el.scrollTop };
    setStart(to || startOfMonth(addMonths(start, -12)));
  };

  const reveal = (target, smooth) => {
    const root = ref.current;
    if (!root) return;
    if (target.month) { root.querySelector(`[data-month="${target.month}"]`)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' }); return; }
    const el = root.querySelector(`[data-day="${target.day}"]`);
    if (!el) return;
    const box = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top >= box.top + 40 && r.bottom <= box.bottom - 10) return;
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  };

  // Keep the view still when months are added above it, then show anything waiting.
  useLayoutEffect(() => {
    const el = ref.current, a = anchor.current;
    if (el && a) { el.scrollTop = a.top + (el.scrollHeight - a.h); anchor.current = null; }
    if (pending.current) { reveal(pending.current, false); pending.current = null; }
  }, [months.length]);

  useEffect(() => {
    const el = ref.current, top = topRef.current;
    if (!el || !top) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !anchor.current) grow(); }, { root: el, rootMargin: '600px 0px 0px 0px' });
    io.observe(top);
    return () => io.disconnect();
  }, [start.getTime()]);

  // A hidden rail (phone, or collapsed) can't scroll, so centre the day when it appears.
  const dayRef = useRef(day);
  dayRef.current = day;
  useEffect(() => {
    const el = ref.current;
    let was = el.clientHeight;
    const ro = new ResizeObserver(() => { const h = el.clientHeight; if (!was && h) reveal({ day: dayRef.current }, false); was = h; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Bring the chosen day into view, growing the rail if it's further back.
  useLayoutEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    const d = fromKey(day);
    if (d < start) { pending.current = { day }; grow(startOfMonth(addMonths(d, -2))); return; }
    if (first) reveal({ day }, false);
    else requestAnimationFrame(() => reveal({ day }, true));
  }, [jump]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const heads = el.querySelectorAll('.jm');
    const top = el.getBoundingClientRect().top + 60;
    let y = null;
    for (const h of heads) { if (h.getBoundingClientRect().bottom > top) { y = h.dataset.year; break; } }
    if (y) onYear(Number(y));
  };
  useEffect(onScroll, []);

  api.current = {
    toYear(y) {
      const month = `${y}-01`;
      const target = new Date(y, 0, 1);
      if (target < start) { pending.current = { month }; grow(startOfMonth(addMonths(target, -2))); return; }
      if (target > end) return;
      reveal({ month }, true);
    },
  };

  const names = weekdayNames(weekStart, 'weekdayShort');
  return html`<div class="jr-wrap">
    <div class="jr-weekdays">${names.map((n) => html`<span>${n}</span>`)}</div>
    <div class="jr" ref=${ref} onScroll=${onScroll}>
      <div ref=${topRef} class="jr-sentinel"><span class="spinner sm" /></div>
      ${months.map((m) => html`<${Month} key=${m.getTime()} month=${m} byDay=${byDay} day=${day} today=${today} pick=${pick} weekStart=${weekStart} matches=${matches} />`)}
      <div class="jr-end" />
    </div>
  </div>`;
}

function Month({ month, byDay, day, today, pick, weekStart, matches }) {
  const y = month.getFullYear(), mo = month.getMonth();
  const lead = (new Date(y, mo, 1).getDay() - weekStart + 7) % 7;
  const count = new Date(y, mo + 1, 0).getDate();
  const keys = Array.from({ length: count }, (_, i) => dayKey(new Date(y, mo, i + 1)));
  const written = keys.filter((k) => hasContent(byDay.get(k))).length;
  return html`<section class="jm" data-month=${`${y}-${String(mo + 1).padStart(2, '0')}`} data-year=${y}>
    <h3 class="jm-title">${fmt(month, 'monthLong')} <span>${y}</span>${written > 0 && html`<em>${written}</em>`}</h3>
    <div class="jm-grid">
      ${Array.from({ length: lead }, (_, i) => html`<span key=${`l${i}`} />`)}
      ${keys.map((k, i) => {
        const e = byDay.get(k);
        const has = hasContent(e);
        const mood = moodInfo(moodOf(e));
        const photo = e?.photos?.[0]?.url;
        const glyph = e?.icon || '';
        const dim = matches && !matches.has(k);
        return html`<button key=${k} data-day=${k} disabled=${k > today}
          class=${cx('jd', has && 'has-entry', k === day && 'is-active', k === today && 'is-today', dim && 'is-dim', matches?.has(k) && 'is-match')}
          onClick=${() => pick(k, false)} aria-label=${fmt(fromKey(k), 'full')}>
          <span class=${cx('jd-tile', photo && 'has-photo')} style=${photo ? { backgroundImage: `url(${photo})` } : null}>
            ${!photo && glyph ? html`<span class="jd-glyph">${glyph}</span>` : null}
            ${photo && e.icon ? html`<span class="jd-badge">${e.icon}</span>` : null}
          </span>
          <span class="jd-num">${i + 1}</span>
          <span class="jd-dot" style=${mood ? { background: mood.color } : has ? null : { opacity: 0 }} />
        </button>`;
      })}
    </div>
  </section>`;
}

// --- the entry -------------------------------------------------------------------

// Card ids in the order they appear in the story.
const placedIds = (htmlStr = '') => [...htmlStr.matchAll(/data-card="([\w-]+)"/g)].map((m) => m[1]);
const figureHtml = (id) => `<figure data-card="${id}" contenteditable="false"></figure>`;
const squash = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Put a new card's figure after the line it belongs to (AI gives us that line's words). */
function placeFigure(root, id, after) {
  const want = squash(after);
  if (want.length >= 4) {
    for (const el of root.querySelectorAll('li, p, h2, h3, blockquote')) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('ul, ol, figure').forEach((x) => x.remove());
      const own = squash(clone.textContent);
      if (!own || !(own.includes(want) || own.includes(want.slice(0, 28)))) continue;
      if (el.nodeName === 'LI') {
        const sub = [...el.children].find((c) => c.nodeName === 'UL' || c.nodeName === 'OL');
        sub ? sub.insertAdjacentHTML('beforebegin', figureHtml(id)) : el.insertAdjacentHTML('beforeend', figureHtml(id));
      } else el.insertAdjacentHTML('afterend', figureHtml(id));
      return;
    }
  }
  root.insertAdjacentHTML('beforeend', figureHtml(id));
}

function EntryView({ day, entry, byDay, go, pick, toggleSide, collapsed, openImport, filtered, setFilter }) {
  const d = fromKey(day);
  const st = useStatus();
  const [pop, setPop] = useState(null); // { kind, anchor, ... }
  const [busy, setBusy] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  const editor = useRef(null);
  const e = entry || {};
  const mood = moodInfo(moodOf(entry));
  const save = (changes) => saveEntry(day, changes);
  const cardsNow = () => get('journal', day)?.cards || [];

  // Cards render into their <figure> placeholders inside the editor.
  const popRef = useRef(setPop);
  popRef.current = setPop;
  const embed = (el, id) => {
    const c = (entry?.cards || []).find((x) => x.id === id);
    render(c ? html`<${Card} card=${c} onClick=${(ev) => popRef.current({ kind: 'card', id, anchor: ev.currentTarget })} />` : null, el);
  };
  const order = placedIds(e.html);
  const pinned = order.map((id) => e.cards?.find((c) => c.id === id)).filter((c) => c && cardType(c.type)?.pinned);
  const jumpTo = (id) => {
    const el = editor.current?.root()?.querySelector(`figure[data-card="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash');
  };

  const addCard = (type) => {
    const c = { id: uid('c'), type };
    save({ cards: [...cardsNow(), c] });
    const api = editor.current;
    if (api?.hasCaret()) api.insertHtml(figureHtml(c.id));
    else { api?.root()?.insertAdjacentHTML('beforeend', figureHtml(c.id)); api?.changed(); }
    setTimeout(() => {
      const el = api?.root()?.querySelector(`figure[data-card="${c.id}"] .jc`);
      if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setPop({ kind: 'card', id: c.id, anchor: el }); }
    }, 80);
  };
  const deleteCard = (id) => {
    const api = editor.current;
    api?.root()?.querySelectorAll(`figure[data-card="${id}"]`).forEach((f) => f.remove());
    api?.changed();
    save({ cards: cardsNow().filter((x) => x.id !== id) });
  };
  const cardBlocks = CARD_TYPES.map((t) => ({ id: `card-${t.id}`, label: t.label, icon: t.icon, hint: 'Card', keys: `card ${t.id} ${t.label.toLowerCase()}`, run: () => addCard(t.id) }));

  const enrich = async (anchor) => {
    const md = toMarkdown(entryHtml(entry)).replace(/\{\{card [\w-]+\}\}\n*/g, '');
    if (!md.trim()) { toast('Write something first', { icon: 'pen' }); return; }
    setBusy('enrich');
    try {
      const r = await runTask('journal.enrich', anchor, { system: ENRICH_SYSTEM, prompt: enrichPrompt(md), json: true, onText: () => {} });
      if (!r) return;
      const cur = get('journal', day) || {};
      const seen = new Set((cur.cards || []).map((c) => `${c.type}:${cardSummary(c)}`.toLowerCase()));
      const fresh = (r.result.cards || []).map((raw) => ({ raw, c: normalizeCard(raw) })).filter(({ c }) => c && !seen.has(`${c.type}:${cardSummary(c)}`.toLowerCase()));
      save({
        icon: cur.icon || r.result.icon || null,
        people: [...new Set([...(cur.people || []), ...(r.result.people || [])])],
        tags: [...new Set([...(cur.tags || []), ...(r.result.tags || []).map((t) => String(t).toLowerCase())])],
        cards: [...(cur.cards || []), ...fresh.map(({ c }) => c)],
      });
      const root = editor.current?.root();
      if (root && fresh.length) { for (const { raw, c } of fresh) placeFigure(root, c.id, raw.after); editor.current.changed(); }
      toast(fresh.length ? `Added ${plural(fresh.length, 'card')} to the timeline` : 'Nothing new to add', { icon: 'sparkle' });
    } catch (err) { toast(err.message, { icon: 'alert', duration: 7000 }); }
    finally { setBusy(null); }
  };

  const smartFood = async (anchor) => {
    if (!foodCount(entry)) { toast('Log some food first', { icon: 'utensils' }); return; }
    setBusy('food');
    try {
      const r = await runTask('journal.food', anchor, { system: FOOD_SYSTEM, prompt: foodPrompt(e.meals), json: true, onText: () => {} });
      if (!r) return;
      save({ meals: normalizeMeals(r.result) });
      toast('Food tidied up', { icon: 'sparkle' });
    } catch (err) { toast(err.message, { icon: 'alert', duration: 7000 }); }
    finally { setBusy(null); }
  };

  const addPhotos = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
    input.onchange = async () => {
      setBusy('photo');
      const added = [];
      for (const f of input.files) {
        try { const id = uid('jp'); added.push({ id, url: await uploadImage(await downscaleImage(f, 2048, 0.86), id) }); }
        catch { toast(`Couldn’t add ${f.name}`, { icon: 'alert' }); }
      }
      if (added.length) save({ photos: [...(get('journal', day)?.photos || []), ...added] });
      setBusy(null);
    };
    input.click();
  };

  const memories = [
    { label: 'A year ago', key: dayKey(addMonths(d, -12)) },
    { label: 'A month ago', key: dayKey(addMonths(d, -1)) },
    { label: 'A week ago', key: dayKey(addDays(d, -7)) },
  ].map((m) => ({ ...m, e: byDay.get(m.key) })).filter((m) => hasContent(m.e));

  const moreMenu = (el) => openMenu(el, [
    { label: 'Import…', icon: 'download', onSelect: openImport },
    { label: 'Serif text', icon: 'type', checked: settings().journal.font === 'serif', onSelect: () => setSettings({ journal: { font: settings().journal.font === 'serif' ? 'sans' : 'serif' } }) },
    { divider: true },
    { label: 'Copy as Markdown', icon: 'copy', disabled: !entry, onSelect: () => { navigator.clipboard?.writeText(`# ${fmt(d, 'fullYear')}\n\n${toMarkdown(entryHtml(entry))}`); toast('Copied', { icon: 'copy' }); } },
    { label: 'Export day as JSON', icon: 'file-down', disabled: !entry, onSelect: () => download(`journal-${day}.json`, JSON.stringify({ format: 'bcos.journal/1', entries: [entry] }, null, 2)) },
    { divider: true },
    { label: 'Delete entry…', icon: 'trash', danger: true, disabled: !entry, onSelect: async () => {
      if (!(await confirm({ title: 'Delete this entry?', body: fmt(d, 'fullYear'), confirmLabel: 'Delete', danger: true }))) return;
      const before = entry;
      remove('journal', day);
      toast('Entry deleted', { icon: 'trash', action: { label: 'Undo', onClick: () => put('journal', before, { touch: false }) } });
    } },
  ], { placement: 'bottom-end' });

  const addMenu = (el) => openMenu(el, [
    ...CARD_TYPES.map((t) => ({ label: t.label, icon: t.icon, onSelect: () => addCard(t.id) })),
    ...(st.mode === 'server' ? [{ divider: true }, { label: 'Photos…', icon: 'image', onSelect: addPhotos }] : []),
  ], { placement: 'bottom-end', width: 210 });

  return html`<div class=${cx('je', scrolled && 'is-scrolled')}>
    <header class="je-bar">
      <button class="je-btn" aria-label=${collapsed ? 'Show sidebar' : 'Hide sidebar'} onClick=${toggleSide}><${Icon} name="sidebar" size=${17} /></button>
      <button class="je-btn" aria-label="Previous day" onClick=${() => go(-1)}><${Icon} name="chevron-left" size=${17} stroke=${2} /></button>
      <button class="je-btn" aria-label="Next day" onClick=${() => go(1)} disabled=${day >= todayKey() && !filtered}><${Icon} name="chevron-right" size=${17} stroke=${2} /></button>
      <span class="je-bar-date">${fmt(d, 'monthDayYear')}</span>
      <span class="spacer" />
      <button class="je-btn" aria-label="Add a card" title="Add a card" onClick=${(ev) => addMenu(ev.currentTarget)}><${Icon} name="plus" size=${17} /></button>
      <button class="je-btn" aria-label="Smart cards" title="Find cards, people and an icon with AI" disabled=${busy === 'enrich'} onClick=${(ev) => enrich(ev.currentTarget)}>
        ${busy === 'enrich' ? html`<span class="spinner sm" />` : html`<${Icon} name="sparkle" size=${17} />`}
      </button>
      <button class="je-btn" aria-label="More" onClick=${(ev) => moreMenu(ev.currentTarget)}><${Icon} name="more" size=${17} /></button>
    </header>

    <div class="je-scroll" onScroll=${(ev) => setScrolled(ev.currentTarget.scrollTop > 40)}>
      <article class="je-doc">
        <div class="je-hero">
          <button class=${cx('je-icon', !e.icon && 'is-empty')} aria-label="Day icon" onClick=${(ev) => setPop({ kind: 'icon', anchor: ev.currentTarget })}>
            ${e.icon || html`<${Icon} name="smile" size=${22} />`}
          </button>
          <div class="je-heading">
            <div class="je-kicker">${isToday(d) ? 'Today' : fmt(d, 'weekdayLong')} · Week ${isoWeek(d)}</div>
            <h1 class="je-date">${fmt(d, 'monthLong')} ${d.getDate()}<span>, ${d.getFullYear()}</span></h1>
          </div>
        </div>

        <div class="je-props">
          <${Stars} value=${e.rating || 0} onChange=${(rating) => save({ rating: rating || null })} />
          <button class=${cx('je-prop', mood && 'is-set')} onClick=${(ev) => setPop({ kind: 'mood', anchor: ev.currentTarget })}>
            ${mood ? html`<i class="je-mood-dot" style=${{ background: mood.color }} />${mood.label}` : html`<${Icon} name="smile" size=${14} />Mood`}
          </button>
          ${(e.people || []).map((p) => html`<button key=${p} class="je-prop is-set is-person" onClick=${(ev) => openMenu(ev.currentTarget, [
            { label: `Days with ${p}`, icon: 'calendar', onSelect: () => setFilter({ id: `person:${p}`, kind: 'person', value: p, label: p }) },
            { label: 'Remove', icon: 'x', danger: true, onSelect: () => save({ people: e.people.filter((x) => x !== p) }) },
          ])}><span class="je-avatar">${p[0]}</span>${p}</button>`)}
          <button class="je-prop is-add" aria-label="Add people" onClick=${(ev) => setPop({ kind: 'people', anchor: ev.currentTarget })}><${Icon} name="user" size=${14} />${e.people?.length ? '' : 'People'}</button>
          ${tagsOf(e).map((t) => html`<button key=${t} class="je-prop is-set is-tag" onClick=${(ev) => openMenu(ev.currentTarget, [
            { label: `Days tagged #${t}`, icon: 'calendar', onSelect: () => setFilter({ id: `tag:${t}`, kind: 'tag', value: t, label: `#${t}` }) },
            { label: 'Remove', icon: 'x', danger: true, onSelect: () => save({ tags: (e.tags || []).filter((x) => x !== t), activities: (e.activities || []).filter((x) => x !== t) }) },
          ])}>#${t}</button>`)}
          <button class="je-prop is-add" aria-label="Add a tag" onClick=${(ev) => setPop({ kind: 'tags', anchor: ev.currentTarget })}><${Icon} name="hash" size=${14} />${tagsOf(e).length ? '' : 'Tag'}</button>
        </div>

        ${pinned.length > 0 && html`<div class="je-pins">${pinned.map((c) => html`<${CardPin} key=${c.id} card=${c} onClick=${() => jumpTo(c.id)} />`)}</div>`}

        ${e.photos?.length > 0 && html`<div class="je-photos">
          ${e.photos.map((p) => html`<button key=${p.id} class="je-photo" style=${{ backgroundImage: `url(${p.url})` }}
            onClick=${(ev) => openMenu(ev.currentTarget, [
              { label: 'Open', icon: 'external', onSelect: () => window.open(p.url, '_blank', 'noopener') },
              { label: 'Make cover', icon: 'image', onSelect: () => save({ photos: [p, ...e.photos.filter((x) => x.id !== p.id)] }) },
              { label: 'Remove', icon: 'trash', danger: true, onSelect: () => save({ photos: e.photos.filter((x) => x.id !== p.id) }) },
            ])} />`)}
          ${st.mode === 'server' && html`<button class="je-photo is-add" aria-label="Add photos" onClick=${addPhotos}>${busy === 'photo' ? html`<span class="spinner sm" />` : html`<${Icon} name="plus" size=${18} />`}</button>`}
        </div>`}

        <section class="je-section je-story">
          <${RichEditor} docKey=${day} html=${entryHtml(entry)} class="je-rich" placeholder="What happened today? Type / to add a flight, ride, place…"
            autofocus=${isToday(d) && !e.text} embed=${embed} extraBlocks=${cardBlocks} onReady=${(api) => { editor.current = api; }}
            onChange=${(h) => { saveEntry(day, { html: h }); }} />
        </section>

        <${FoodLog} entry=${e} save=${save} busy=${busy === 'food'} onSmart=${smartFood} />

        ${memories.length > 0 && html`<section class="je-section je-memories">
          <div class="je-section-head"><h2>On this day</h2></div>
          <div class="je-memory-list">
            ${memories.map((m) => html`<button key=${m.key} class="je-memory" onClick=${() => pick(m.key)}>
              <span class="je-memory-icon" style=${m.e.photos?.[0] ? { backgroundImage: `url(${m.e.photos[0].url})` } : null}>${m.e.photos?.[0] ? '' : m.e.icon || html`<${Icon} name="book" size=${16} />`}</span>
              <span class="je-memory-text"><b>${m.label}</b><span>${(m.e.text || '').slice(0, 120)}</span></span>
            </button>`)}
          </div>
        </section>`}
      </article>
    </div>

    ${pop?.kind === 'icon' && html`<${EmojiPicker} anchor=${pop.anchor} value=${e.icon} onPick=${(icon) => save({ icon })} onClose=${() => setPop(null)} />`}
    ${pop?.kind === 'mood' && html`<${MoodPicker} anchor=${pop.anchor} value=${moodOf(entry)} onPick=${(m) => save({ mood: m })} onClose=${() => setPop(null)} />`}
    ${pop?.kind === 'people' && html`<${ListAdder} anchor=${pop.anchor} title="Add people" placeholder="Name" have=${e.people || []}
      suggestions=${tally([...byDay.values()].map((x) => x.people || []))} onAdd=${(p) => save({ people: [...new Set([...(get('journal', day)?.people || []), p])] })} onClose=${() => setPop(null)} />`}
    ${pop?.kind === 'tags' && html`<${ListAdder} anchor=${pop.anchor} title="Add a tag" placeholder="tag" prefix="#" have=${tagsOf(e)} lower
      suggestions=${tally([...byDay.values()].map(tagsOf))} onAdd=${(t) => save({ tags: [...new Set([...(get('journal', day)?.tags || []), t])] })} onClose=${() => setPop(null)} />`}
    ${pop?.kind === 'card' && (() => {
      const c = e.cards?.find((x) => x.id === pop.id);
      return c && html`<${CardEditor} key=${c.id} anchor=${pop.anchor} card=${c} onClose=${() => setPop(null)}
        onSave=${(next) => save({ cards: cardsNow().map((x) => (x.id === c.id ? { ...next, id: c.id } : x)) })}
        onDelete=${() => deleteCard(c.id)} />`;
    })()}
  </div>`;
}

function Stars({ value, onChange }) {
  const [hover, setHover] = useState(null);
  const shown = hover ?? value;
  const at = (ev, i) => { const r = ev.currentTarget.getBoundingClientRect(); return i + (ev.clientX - r.left < r.width / 2 ? 0.5 : 1); };
  return html`<div class="je-stars" role="slider" aria-label="Day rating" aria-valuemin="0" aria-valuemax="5" aria-valuenow=${value} tabindex="0"
    onPointerLeave=${() => setHover(null)}
    onKeyDown=${(ev) => { if (ev.key === 'ArrowRight') onChange(Math.min(5, value + 0.5)); else if (ev.key === 'ArrowLeft') onChange(Math.max(0, value - 0.5)); }}>
    ${[0, 1, 2, 3, 4].map((i) => {
      const fill = Math.max(0, Math.min(1, shown - i));
      return html`<button key=${i} tabindex="-1" class="je-star" onPointerMove=${(ev) => setHover(at(ev, i))} onClick=${(ev) => { const v = at(ev, i); onChange(v === value ? 0 : v); }}>
        <svg viewBox="0 0 24 24" width="17" height="17"><defs><clipPath id=${`sc${i}`}><rect x="0" y="0" width=${24 * fill} height="24" /></clipPath></defs>
          <path class="je-star-bg" d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.2l-5.8 3.2 1.2-6.5L2.6 9.4l6.5-.8z" />
          <path class="je-star-fg" clip-path=${`url(#sc${i})`} d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.2l-5.8 3.2 1.2-6.5L2.6 9.4l6.5-.8z" />
        </svg>
      </button>`;
    })}
    ${value > 0 && html`<span class="je-stars-val">${value}</span>`}
  </div>`;
}

function MoodPicker({ anchor, value, onPick, onClose }) {
  return html`<${Popover} anchor=${anchor} onClose=${onClose} class="je-moodpop" width=${260} label="Mood">
    <div class="je-moodscale">${MOODS.map((m) => html`<i style=${{ background: m.color }} />`)}</div>
    ${MOODS.slice().reverse().map((m) => html`<button key=${m.v} class=${cx('je-moodopt', value === m.v && 'is-on')} style=${{ '--c': m.color }} onClick=${() => { onPick(value === m.v ? null : m.v); onClose(); }}>
      <i />${m.label}${value === m.v && html`<${Icon} name="check" size=${14} />`}
    </button>`)}
  </${Popover}>`;
}

function ListAdder({ anchor, title, placeholder, prefix = '', have, suggestions, onAdd, onClose, lower }) {
  const [v, setV] = useState('');
  const norm = (x) => (lower ? x.trim().replace(/^#/, '').toLowerCase() : x.trim());
  const shown = suggestions.filter((s) => !have.includes(s) && s.toLowerCase().includes(v.trim().toLowerCase())).slice(0, 8);
  const add = (x) => { const n = norm(x); if (n) onAdd(n); setV(''); };
  return html`<${Popover} anchor=${anchor} onClose=${onClose} class="je-adder" width=${240} label=${title}>
    <form onSubmit=${(ev) => { ev.preventDefault(); add(v); }}>
      <input class="field field-sm" autofocus placeholder=${placeholder} value=${v} onInput=${(ev) => setV(ev.target.value)} />
    </form>
    ${shown.length > 0 && html`<div class="je-adder-list">${shown.map((s) => html`<button key=${s} onClick=${() => add(s)}>${prefix}${s}</button>`)}</div>`}
  </${Popover}>`;
}

// --- food ------------------------------------------------------------------------

function FoodLog({ entry: e, save, busy, onSmart }) {
  const [edit, setEdit] = useState(null); // { meal, id, anchor }
  const meals = e.meals || {};
  const sum = foodSummary(meals);
  const setMeal = (id, list) => save({ meals: { ...(get('journal', e.id)?.meals || meals), [id]: list } });
  const editing = edit && (meals[edit.meal] || []).find((f) => f.id === edit.id);

  return html`<section class="je-section je-food">
    <div class="je-section-head">
      <h2>Food</h2>
      ${sum.items > 0 && html`<span class="je-food-sum">${plural(sum.items, 'item')}${sum.drinks ? ` · ${plural(sum.drinks, 'drink')}` : ''}${sum.estimated ? ` · ~${sum.kcal.toLocaleString()} kcal` : ''}</span>`}
      <span class="spacer" />
      <button class="je-mini" disabled=${busy} onClick=${(ev) => onSmart(ev.currentTarget)}>${busy ? html`<span class="spinner sm" />` : html`<${Icon} name="sparkle" size=${13} />`}Tidy with AI</button>
    </div>
    <div class="je-meals">
      ${MEALS.map((m) => html`<div key=${m.id} class="je-meal">
        <div class="je-meal-label"><${Icon} name=${m.icon} size=${15} />${m.label}</div>
        <div class="je-meal-items">
          ${(meals[m.id] || []).map((f) => html`<button key=${f.id} class=${cx('je-food-item', `is-${f.kind}`)} onClick=${(ev) => setEdit({ meal: m.id, id: f.id, anchor: ev.currentTarget })}>
            <span class="je-food-emoji">${f.emoji}</span>${foodLabel(f)}${f.zero && html`<em>zero</em>`}
          </button>`)}
          <${FoodInput} placeholder=${(meals[m.id] || []).length ? 'Add…' : m.id === 'snacks' ? 'Snacks, drinks…' : `What was ${m.label.toLowerCase()}?`}
            onAdd=${(text) => setMeal(m.id, [...(get('journal', e.id)?.meals?.[m.id] || []), ...parseFoodText(text)])} />
        </div>
      </div>`)}
    </div>
    ${editing && html`<${FoodEditor} key=${editing.id} anchor=${edit.anchor} food=${editing} onClose=${() => setEdit(null)}
      onSave=${(f) => setMeal(edit.meal, (meals[edit.meal] || []).map((x) => (x.id === f.id ? f : x)))}
      onDelete=${() => setMeal(edit.meal, (meals[edit.meal] || []).filter((x) => x.id !== editing.id))} />`}
  </section>`;
}

function FoodInput({ placeholder, onAdd }) {
  const [v, setV] = useState('');
  const commit = () => { if (v.trim()) { onAdd(v); setV(''); } };
  return html`<input class="je-food-add" placeholder=${placeholder} value=${v} onInput=${(ev) => setV(ev.target.value)}
    onKeyDown=${(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } }} onBlur=${commit} />`;
}

function FoodEditor({ anchor, food, onSave, onDelete, onClose }) {
  const [f, setF] = useState(food);
  const [picking, setPicking] = useState(null);
  const set = (k, v) => setF({ ...f, [k]: v });
  const done = () => { onSave({ ...f, name: f.name.trim() || food.name, qty: Number(f.qty) > 0 ? Number(f.qty) : 1, kcal: Number(f.kcal) > 0 ? Number(f.kcal) : undefined }); onClose(); };
  return html`<${Popover} anchor=${anchor} onClose=${() => { if (!picking) done(); }} class="je-food-pop" width=${280} label="Edit food">
    <form onSubmit=${(ev) => { ev.preventDefault(); done(); }}>
      <div class="je-food-pop-top">
        <button type="button" class="je-food-pop-emoji" onClick=${(ev) => setPicking(ev.currentTarget)}>${f.emoji}</button>
        <input class="field field-sm" value=${f.name} onInput=${(ev) => { const name = ev.target.value; setF({ ...f, name, ...(f.emoji === iconFor(f.name).emoji ? { emoji: iconFor(name).emoji, kind: iconFor(name).kind } : {}) }); }} />
      </div>
      <div class="je-food-pop-grid">
        <label><span>Qty</span><input class="field field-sm" type="number" min="0" step="0.5" value=${f.qty} onInput=${(ev) => set('qty', ev.target.value)} /></label>
        <label><span>Unit</span><input class="field field-sm" placeholder="slice" value=${f.unit || ''} onInput=${(ev) => set('unit', ev.target.value)} /></label>
        <label><span>kcal</span><input class="field field-sm" type="number" min="0" placeholder="—" value=${f.kcal ?? ''} onInput=${(ev) => set('kcal', ev.target.value)} /></label>
      </div>
      <div class="je-food-pop-kinds">
        ${['food', 'drink', 'sweet'].map((k) => html`<button type="button" key=${k} class=${cx('js-chip', f.kind === k && 'is-on')} onClick=${() => set('kind', k)}>${k[0].toUpperCase() + k.slice(1)}</button>`)}
        <button type="button" class=${cx('js-chip', f.zero && 'is-on')} onClick=${() => set('zero', !f.zero || undefined)}>Zero sugar</button>
      </div>
      <div class="jc-editor-foot">
        <button type="button" class="btn btn-sm btn-ghost is-danger-text" onClick=${() => { onDelete(); onClose(); }}><${Icon} name="trash" size=${13} />Remove</button>
        <button type="submit" class="btn btn-sm btn-primary">Done</button>
      </div>
    </form>
    ${picking && html`<${EmojiPicker} anchor=${picking} value=${f.emoji} sets=${['food', 'days']} allowClear=${false} onPick=${(emoji) => emoji && set('emoji', emoji)} onClose=${() => setPicking(null)} />`}
  </${Popover}>`;
}
