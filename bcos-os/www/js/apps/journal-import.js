// Journal import. Two ways in, one format:
//   1. JSON in the "bcos.journal/1" format — written by any LLM you hand
//      IMPORT_GUIDE to (Copy LLM instructions), or by hand.
//   2. Documents (Diarly exports, notes…) sent one at a time to an AI preset,
//      which answers in that same format.
// Either way entries go through normalizeEntry and are previewed before saving.

import { all, get, put } from '../lib/store.js';
import { escapeHtml, uid } from '../lib/util.js';
import { sanitize, digest } from './editor.js';
import { MOODS, MEALS } from './journal-shared.js';
import { normalizeMeals } from './journal-food.js';
import { normalizeCard, CARDS_DOC } from './journal-cards.js';

export const FORMAT = 'bcos.journal/1';

const EXAMPLE = {
  format: FORMAT,
  entries: [{
    date: '2026-10-25',
    icon: '🚣',
    rating: 4.5,
    mood: 'slightly pleasant',
    people: ['Jack', 'Remo', 'Dad'],
    tags: ['trip', 'regatta'],
    body: '- Woke up 8:00, packed up and met Remo in the lobby\n- {{card 1}}\n- Rowed back, Remo carried our oars to the trailer\n- Lyft to the airport {{card 2}}\n- {{card 3}}\n- Customs was quick, Dad picked me up',
    meals: {
      breakfast: [{ name: 'Pancakes', qty: 2, emoji: '🥞', kind: 'food' }, { name: 'Bacon', qty: 3, unit: 'strips', emoji: '🥓', kind: 'food' }, { name: 'Orange Juice', emoji: '🧃', kind: 'drink' }],
      lunch: [],
      dinner: [{ name: 'Burger', emoji: '🍔', kind: 'food' }, { name: 'Root Beer', qty: 2, emoji: '🥤', kind: 'drink' }],
      snacks: [{ name: 'Gatorade Zero', qty: 2, emoji: '🧃', kind: 'drink', zero: true }],
    },
    cards: [
      { type: 'race', event: 'Schuylkill Navy Regatta', category: '2x', crew: ['Jack'], place: 16, of: 48, time: '14:01', note: 'Decent line and pace, pushed to a 1:41 at the end. Beat the Argos 2x by 37s' },
      { type: 'ride', mode: 'lyft', to: 'Airport' },
      { type: 'flight', airline: 'American Airlines', domain: 'aa.com', from: 'PHL', to: 'YYZ', depart: '19:45', arrive: '21:20', note: 'Music the whole flight' },
    ],
  }],
};

/** The document you paste into any LLM along with your journal. */
export const IMPORT_GUIDE = `# BCOS Journal import — instructions for an AI model

You are converting someone's personal journal into JSON for BCOS, their personal
journal app. Read every document they give you and answer with ONE JSON object in
the format below and nothing else (no prose, no code fences). Be faithful: never
invent events, foods, people or numbers. Keep their voice and wording in "body".

## Output format

{
  "format": "${FORMAT}",
  "entries": [ Entry, Entry, ... ]   // one per day, oldest first
}

### Entry

| field   | type | notes |
| ------- | ---- | ----- |
| date    | "YYYY-MM-DD" | Required. Diarly exports usually put the date ONLY in the file name (e.g. "2026-10-25.md" or "October 25, 2026.md") — use it. Otherwise take it from a date heading in the document. If one document has several days, make one entry per day. |
| icon    | emoji | One emoji that sums up the day (🚣 regatta, ✈️ travel day, 🏫 normal school day, 🎂 birthday…). |
| rating  | number | Day rating out of 5, halves allowed (4.5). Omit if not given. |
| mood    | string or 1–7 | One of: ${MOODS.map((m) => `"${m.label.toLowerCase()}"`).join(', ')} (1 = very unpleasant … 7 = very pleasant). Omit if not given. |
| people  | string[] | People they spent time with (first names, or Mum/Dad…). Never the writer. |
| tags    | string[] | Lower-case themes that are NOT already captured by a card (trip, regatta, sleepover, test, school…). No "#". |
| body    | Markdown | What happened, as they wrote it: "- " bullets, sub-bullets indented with a tab, "## " for a section heading, **bold** allowed. Remove the "Things that happened" heading, the food section, rating, tags and mood lines — those go in their own fields. Replace hashtags with plain words ("#lyft" → "Lyft", "#rowing/hanlan" → "rowing at Hanlan", "#house/jack" → "Jack's house"). Put each card where it happened with a marker {{card N}} (N = the card's position in "cards", starting at 1) — see "Placing cards". |
| meals   | object | { "breakfast": Food[], "lunch": Food[], "dinner": Food[], "snacks": Food[] }. Use [] for "-" or missing meals. |
| cards   | Card[] | Structured moments — see below. Order them as they happened. |

### Placing cards

Cards appear inline in the day's timeline, so the body must say where each one goes:
- When a bullet IS the card (e.g. "🚣 #race/2x | 16th of 48, 14:01 time"), replace that bullet's text with the marker: "- {{card 2}}". Move its sub-bullets into the card's "note" (short) instead of keeping them as sub-bullets.
- When a bullet mentions the card but says more (e.g. "Called #lyft to airport, got through security quickly"), keep the words and add the marker at the end: "- Lyft to the airport, got through security quickly {{card 3}}".
- Every card must be placed exactly once.

### Food

{ "name": "Coke Zero", "qty": 1, "unit": "", "emoji": "🥤", "kind": "drink", "zero": true, "kcal": 0 }

- Split combined lines: "2 pancakes, 2 eggs and 3 strips of bacon with orange juice" → 4 items.
- name: short, Title Case, keep brands ("Jack Astor's Fries", "Gatorade Zero"). qty defaults to 1.
- unit only for counted portions ("strips", "slice", "bag", "pack").
- emoji: the single best food emoji. kind: "food", "drink" or "sweet".
- zero: true for diet / zero-sugar drinks. kcal: optional realistic estimate for that quantity.

### Cards

Cards replace hashtags with structure. Make a card when the day clearly contains one:

${CARDS_DOC}

Their hashtags, and what each becomes (the writer's own list; N = any name):
- Flights: "#flight | Airline | 7:45-9:20 #phl-yyz", route tags like "#rsw-yyz", "#yyz-bos" → flight card (from/to IATA codes, 24-hour times; evening flights are PM).
- Races: "#race/2x | 16th of 48, 14:01 time" (also race/1x, race/4x, race/4x+) → race card (category "2x", place 16, of 48, time "14:01"). "#regattawin", "#rowing/gold|silver|bronze" → that race's "medal". Sub-bullets become a short note.
- Training: "#rowing", "#rowing/<place>" (hanlan…), "#practice/1x|4x", "#rowing/double", "#rowing/dockout", "#workout", "#workout/weights|steadystate", "#gym", "#run", "#swim", "#biking", "#hike", "#skiing", "#golf" → workout card. "#ergtest", "#2ktest", "#6ktest", "#rowingpb", "#pb", "#maxwatts" → workout card with the score in "result" (add "PB" when it was one).
- Getting around: "#uber", "#lyft", "#taxi/N", "#ttc" (transit, domain "ttc.ca"), "#walk", "#escooter", "#drive"/"#driving" (they drove) → ride card. "#drivinglesson", "#driving/N" → ride card mode "drive" with N in "with". "#drivingtest" → event card.
- Orders: "#ubereats", "#doordash" → order card kind "food" (the restaurant in "item"). "#package", "#package/amazon|temu|taobao|aliexpress|lit", "#temu", "#taobao", "#temupackage" → order card kind "package". "#walmartdelivery" → order kind "groceries".
- Places: "#food/N", "#restaurant/N" → place card kind restaurant/cafe (real name: "jackastors" → "Jack Astor's", "a&w" → "A&W"; set "domain" for chains). "#store/N", "#costco", "#ikea", "#target", "#yorkdale", "#pusateris" → place kind "shop". "#house/N", "#friendshouse" → place kind "friend" ("<N>'s house") and N in people. "#granite", "#graniteWF" → place kind "gym" (Granite Club). "#hotel", "#chalet" → place kind "hotel". "#havergal" etc. → place kind "school". "#beach", "#hike/N", "#camping/N" → place kind "outdoors".
- Health & care: "#dentist", "#orthodontist", "#doctor", "#hospital", "#oralsurgeon", "#surgery", "#vaccine", "#haircut" → appointment card. "#sick", "#injury", "#vomit" → tags.
- School: "#test", "#exam", "#exam/ap", "#quiz", "#SAT", "#examreturn", "#reportcard", "#presentation" → event card (kind "test", title like "Chem test"). "#sub/N", "#sub" (a substitute teacher) → event card kind "sub", title "Sub: <N>". "#firedrill", "#assembly", "#fieldtrip", "#schoolphotos", "#schoolconcert", "#halfday", "#snowday", "#firstday", "#graduation" → event card.
- Watching & playing: "#movie" (and any show/film/game they mention watching or playing) → media card. "#leafsgame", "#wwdc", "#escaperoom", "#wonderland", "#birthdayparty", "#birthday/N", "#play/performance|rehearsal", "#roboticscomp", "#contest" → event card.
- People: "#people/N", "#jack", "#griff", "#andrewg", "#kovacs", "#linda", "#Alannah", "#apollo", etc. → add to "people".
- Trips: "#trip", "#trip/N", "#florida", "#philadelphia", "#vacation", "#camping/N" → tag "trip" (plus place cards for where they went).
- Everything else ("#weather/heat", "#snow", "#interestingdream", "#dream/long", "#important", "#favourite", "#lockedin", "#productive", "#boring", "#shitday", "#controversy", "#memory", "#story", …) → lower-case tags without "#" or "/" (e.g. "weather-heat", "dream").

## Example

${JSON.stringify(EXAMPLE, null, 2)}

## Checklist before answering
- Every entry has a valid "date".
- Every card has exactly one {{card N}} marker in "body".
- No "title" field — days don't have titles.
- Valid JSON: double quotes, no trailing commas, no comments.
- Only the JSON object — nothing before or after it.
`;

// --- markdown body → editor HTML (nested bullets, headings, bold) -------------------

const MARK_RE = /\{\{\s*card\s+([\w-]+)\s*\}\}/gi;
const figure = (id) => `<figure data-card="${id}" contenteditable="false"></figure>`;

const inline = (t) => escapeHtml(t)
  .replace(/\*\*([^*]+?)\s*\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');

/** Markdown body → editor HTML. `ids` maps a {{card N}} marker (1-based, or a card id) to a card id. */
export function bodyToHtml(md, ids = []) {
  const idFor = (ref) => (/^\d+$/.test(ref) ? ids[Math.max(0, Number(ref) - 1)] : ids.includes(ref) ? ref : null);
  const marks = (t) => t.replace(MARK_RE, (m, ref) => { const id = idFor(ref); return id ? figure(id) : ''; });
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const stack = []; // open list depths
  const depthOf = (ws) => ws.replace(/ {2,4}/g, '\t').replace(/ /g, '').length;
  const closeTo = (d) => { while (stack.length > d) { out.push('</li></ul>'); stack.pop(); } };
  for (const line of lines) {
    const li = line.match(/^([ \t]*)[-*+•]\s+(.*)$/);
    if (li && /^(\{\{[^}]+\}\}\s*)+$/.test(li[2].trim())) {
      // A bullet that is only a card: the card stands on its own, out of the list.
      closeTo(0);
      out.push(marks(li[2].trim()));
      continue;
    }
    if (li) {
      const d = Math.min(depthOf(li[1]), stack.length) + 1;
      if (d > stack.length) { out.push('<ul><li>'); stack.push(d); }
      else { closeTo(d); out.push('</li><li>'); }
      out.push(marks(inline(li[2])));
      continue;
    }
    closeTo(0);
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) out.push(`<h${Math.max(2, h[1].length)}>${inline(h[2])}</h${Math.max(2, h[1].length)}>`);
    else if (/^\s*(\{\{[^}]+\}\}\s*)+$/.test(line)) out.push(marks(line.trim()));
    else if (line.trim()) out.push(`<p>${marks(inline(line.trim())).replace(/<figure[^>]*><\/figure>/g, (f) => `</p>${f}<p>`)}</p>`);
  }
  closeTo(0);
  return sanitize(out.join(''));
}

// --- normalising -----------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function moodValue(m) {
  if (m == null || m === '') return null;
  if (typeof m === 'number') return m >= 1 && m <= 7 ? Math.round(m) : null;
  const s = String(m).toLowerCase().replace(/[_-]/g, ' ').trim();
  return MOODS.find((x) => x.label.toLowerCase() === s)?.v ?? null;
}

/** One entry from the import format → a BCOS journal item (without saving). */
export function normalizeEntry(raw) {
  let date = String(raw?.date || '').slice(0, 10);
  if (!DATE_RE.test(date)) date = '';
  const mapped = (raw.cards || []).map(normalizeCard); // keeps positions, so {{card N}} still lines up
  const cards = mapped.filter(Boolean);
  let htmlBody = raw.html ? sanitize(raw.html) : bodyToHtml(raw.body || raw.text || '', mapped.map((c) => c?.id || null));
  // Cards only exist in the timeline, so any the body didn't place go at the end.
  const unplaced = cards.filter((c) => !htmlBody.includes(`data-card="${c.id}"`));
  if (unplaced.length) htmlBody = sanitize(htmlBody + unplaced.map((c) => figure(c.id)).join(''));
  const rating = Number(raw.rating);
  return {
    id: date, date,
    v: 2,
    icon: raw.icon || null,
    rating: rating > 0 && rating <= 5 ? Math.round(rating * 2) / 2 : null,
    mood: moodValue(raw.mood),
    people: [...new Set((raw.people || []).map((p) => String(p).trim()).filter(Boolean))],
    tags: [...new Set((raw.tags || []).map((t) => String(t).replace(/^#/, '').trim().toLowerCase()).filter(Boolean))],
    html: htmlBody,
    text: digest(htmlBody).text,
    meals: normalizeMeals(raw.meals || {}),
    cards,
    photos: [],
  };
}

/** Accepts { entries }, a bare array, or a single entry. Throws on nonsense. */
export function readImport(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.entries) ? json.entries : json?.date ? [json] : null;
  if (!list) throw new Error('Expected { "format": "bcos.journal/1", "entries": [...] }');
  return list.filter((e) => e && typeof e === 'object').map(normalizeEntry);
}

// --- merging & saving -------------------------------------------------------------

const has = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');

/** mode: 'merge' (fill gaps, append cards/food), 'replace', or 'skip'. */
export function combine(existing, incoming, mode) {
  if (!existing || mode === 'replace') return { ...incoming, photos: existing?.photos || [], createdAt: existing?.createdAt };
  const out = { ...existing, v: 2 };
  for (const k of ['icon', 'rating', 'mood']) if (!has(existing[k]) && has(incoming[k])) out[k] = incoming[k];
  if (existing.v !== 2 && incoming.mood) out.mood = incoming.mood; // a v1 mood is on the old scale
  if (!existing.text?.trim()) { out.html = incoming.html; out.text = incoming.text; }
  else if (incoming.text?.trim() && !existing.text.includes(incoming.text.slice(0, 60))) { out.html = `${existing.html || ''}${incoming.html}`; out.text = `${existing.text}\n${incoming.text}`; }
  out.people = [...new Set([...(existing.people || []), ...incoming.people])];
  out.tags = [...new Set([...(existing.tags || []), ...incoming.tags])];
  out.cards = [...(existing.cards || []), ...incoming.cards];
  out.meals = Object.fromEntries(MEALS.map((m) => [m.id, existing.meals?.[m.id]?.length ? existing.meals[m.id] : incoming.meals[m.id] || []]));
  return out;
}

export function saveImport(entries, mode) {
  let saved = 0, skipped = 0;
  for (const e of entries) {
    if (!e.date) { skipped++; continue; }
    const cur = get('journal', e.date);
    if (cur && mode === 'skip') { skipped++; continue; }
    put('journal', combine(cur, e, mode));
    saved++;
  }
  return { saved, skipped };
}

export const existingDays = () => new Set(all('journal').map((e) => e.id));

// --- AI: one document at a time ----------------------------------------------------

export const IMPORT_SYSTEM = `${IMPORT_GUIDE}\n\nYou will receive ONE document at a time, with its file name. Answer with the JSON object for just that document.`;

export function documentPrompt(name, text) {
  return `File name: ${name}\nToday's date (for resolving relative dates only): ${new Date().toISOString().slice(0, 10)}\n\nDocument:\n"""\n${text}\n"""`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

/** A date in a file name: "2026-10-25 Saturday.md", "2026.10.25", "October 25, 2026", "25 Oct 2026". */
export function dateFromName(name = '') {
  const n = String(name).toLowerCase();
  let m = n.match(/(20\d{2}|19\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  m = n.match(/([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS.includes(m[1].slice(0, 3))) return `${m[3]}-${pad(MONTHS.indexOf(m[1].slice(0, 3)) + 1)}-${pad(m[2])}`;
  m = n.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})/);
  if (m && MONTHS.includes(m[2].slice(0, 3))) return `${m[3]}-${pad(MONTHS.indexOf(m[2].slice(0, 3)) + 1)}-${pad(m[1])}`;
  return '';
}

/**
 * Entries a model returned for one file. The file name's date fills in a
 * missing date, and wins outright when the file produced a single day.
 */
export function entriesForFile(name, json) {
  const entries = readImport(json);
  const d = dateFromName(name);
  if (d) {
    if (entries.length === 1) entries[0].date = entries[0].id = d;
    else for (const e of entries) if (!e.date) e.date = e.id = d;
  }
  return entries;
}

export const newJobId = () => uid('imp');
