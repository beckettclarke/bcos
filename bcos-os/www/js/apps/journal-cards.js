// Smart cards: structured moments in a day (a flight, a race result, a place,
// a ride…) that replace hashtags. Each type declares its fields, so the editor
// form, the import and the AI schema all come from one place.

import { html, useState } from '../lib/html.js';
import { Popover } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { cx, uid } from '../lib/util.js';

const RIDE_MODES = [
  { id: 'uber', label: 'Uber', emoji: '🚗' },
  { id: 'lyft', label: 'Lyft', emoji: '🚙' },
  { id: 'taxi', label: 'Taxi', emoji: '🚕' },
  { id: 'transit', label: 'Transit', emoji: '🚇' },
  { id: 'drive', label: 'Drove', emoji: '🚘' },
  { id: 'driven', label: 'Got a lift', emoji: '🚘' },
  { id: 'walk', label: 'Walked', emoji: '🚶' },
  { id: 'bike', label: 'Biked', emoji: '🚲' },
  { id: 'train', label: 'Train', emoji: '🚆' },
  { id: 'delivery', label: 'Delivery', emoji: '🛵' },
];
const PLACE_KINDS = [
  { id: 'home', label: 'Home', emoji: '🏠' },
  { id: 'friend', label: 'Friend’s place', emoji: '🏡' },
  { id: 'school', label: 'School', emoji: '🏫' },
  { id: 'gym', label: 'Gym / club', emoji: '🏋️' },
  { id: 'restaurant', label: 'Restaurant', emoji: '🍽️' },
  { id: 'cafe', label: 'Café', emoji: '☕️' },
  { id: 'shop', label: 'Shop', emoji: '🛍️' },
  { id: 'hotel', label: 'Hotel', emoji: '🏨' },
  { id: 'venue', label: 'Venue', emoji: '🏟️' },
  { id: 'outdoors', label: 'Outdoors', emoji: '🌲' },
  { id: 'city', label: 'City', emoji: '🏙️' },
  { id: 'other', label: 'Place', emoji: '📍' },
];
const MEDIA_KINDS = [
  { id: 'show', label: 'Show', emoji: '📺' },
  { id: 'movie', label: 'Movie', emoji: '🎬' },
  { id: 'music', label: 'Music', emoji: '🎧' },
  { id: 'book', label: 'Book', emoji: '📖' },
  { id: 'game', label: 'Game', emoji: '🎮' },
  { id: 'podcast', label: 'Podcast', emoji: '🎙️' },
];
const opt = (list, id) => list.find((x) => x.id === id) || list[list.length - 1];

export const CARD_TYPES = [
  {
    id: 'flight', label: 'Flight', emoji: '✈️', tint: '#4c8dff', wide: true,
    fields: [
      { key: 'airline', label: 'Airline', placeholder: 'American Airlines' },
      { key: 'number', label: 'Flight', placeholder: 'AA 1234' },
      { key: 'from', label: 'From', placeholder: 'PHL', upper: true, half: true },
      { key: 'to', label: 'To', placeholder: 'YYZ', upper: true, half: true },
      { key: 'depart', label: 'Departs', type: 'time', half: true },
      { key: 'arrive', label: 'Arrives', type: 'time', half: true },
      { key: 'seat', label: 'Seat', placeholder: '14A', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"flight","airline":"American Airlines","number":"AA 4567","from":"PHL","to":"YYZ","depart":"19:45","arrive":"21:20","seat":"","note":""}',
  },
  {
    id: 'race', label: 'Race', emoji: '🏁', tint: '#ff8a3d', wide: true,
    fields: [
      { key: 'event', label: 'Event', placeholder: 'Head of the Trent' },
      { key: 'category', label: 'Boat / category', placeholder: '2x', half: true },
      { key: 'crew', label: 'With', placeholder: 'Jack', half: true, list: true },
      { key: 'place', label: 'Place', type: 'number', half: true },
      { key: 'of', label: 'Out of', type: 'number', half: true },
      { key: 'time', label: 'Time', placeholder: '14:01.3', half: true },
      { key: 'emoji', label: 'Verdict', placeholder: '👍', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"race","event":"Schuylkill Navy Regatta","category":"2x","crew":["Jack"],"place":16,"of":48,"time":"14:01","emoji":"👍","note":"Good line, pushed to a 1:41 at the end"}',
  },
  {
    id: 'workout', label: 'Workout', emoji: '💪', tint: '#34c759',
    fields: [
      { key: 'activity', label: 'Activity', placeholder: 'Rowing' },
      { key: 'where', label: 'Where', placeholder: 'Hanlan', half: true },
      { key: 'duration', label: 'Duration', placeholder: '45 min', half: true },
      { key: 'with', label: 'With', placeholder: 'Jack', list: true },
      { key: 'emoji', label: 'Icon', placeholder: '🚣', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"workout","activity":"Rowing","where":"Hanlan","duration":"","with":["Jack"],"emoji":"🚣","note":"2x, two laps to the gap and back"}',
  },
  {
    id: 'place', label: 'Place', emoji: '📍', tint: '#ff5a5f',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'Jack Astor’s' },
      { key: 'kind', label: 'Kind', type: 'select', options: PLACE_KINDS, half: true },
      { key: 'city', label: 'City', placeholder: 'Peterborough', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"place","name":"Jack Astor\'s","kind":"restaurant","city":"","note":""}  (kind: home|friend|school|gym|restaurant|cafe|shop|hotel|venue|outdoors|city|other)',
  },
  {
    id: 'ride', label: 'Ride', emoji: '🚗', tint: '#8e8e93',
    fields: [
      { key: 'mode', label: 'How', type: 'select', options: RIDE_MODES },
      { key: 'from', label: 'From', placeholder: 'Hotel', half: true },
      { key: 'to', label: 'To', placeholder: 'Airport', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"ride","mode":"lyft","from":"","to":"Airport","note":""}  (mode: uber|lyft|taxi|transit|drive|driven|walk|bike|train|delivery)',
  },
  {
    id: 'event', label: 'Event', emoji: '🎟️', tint: '#bf5af2',
    fields: [
      { key: 'title', label: 'Title', placeholder: 'Chem test' },
      { key: 'emoji', label: 'Icon', placeholder: '📝', half: true },
      { key: 'kind', label: 'Kind', placeholder: 'test', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"event","title":"Sleepover at Jack\'s","emoji":"🛌","kind":"sleepover","note":""}',
  },
  {
    id: 'media', label: 'Watched & played', emoji: '📺', tint: '#ff375f',
    fields: [
      { key: 'title', label: 'Title', placeholder: 'Pluribus' },
      { key: 'kind', label: 'Kind', type: 'select', options: MEDIA_KINDS, half: true },
      { key: 'detail', label: 'Detail', placeholder: 'S1 E4', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"media","title":"Pluribus","kind":"show","detail":"","note":""}  (kind: show|movie|music|book|game|podcast)',
  },
];

export const cardType = (id) => CARD_TYPES.find((t) => t.id === id);

/** Icon and one line of text for a card, used in lists, filters and search. */
export function cardSummary(c) {
  switch (c.type) {
    case 'flight': return { emoji: '✈️', text: [c.from && c.to ? `${c.from} → ${c.to}` : '', c.airline].filter(Boolean).join(' · ') || 'Flight' };
    case 'race': return { emoji: c.emoji || '🏁', text: [c.category, c.place ? `${ordinal(c.place)}${c.of ? ` of ${c.of}` : ''}` : '', c.time].filter(Boolean).join(' · ') || c.event || 'Race' };
    case 'workout': return { emoji: c.emoji || '💪', text: [c.activity, c.where].filter(Boolean).join(' · ') || 'Workout' };
    case 'place': return { emoji: opt(PLACE_KINDS, c.kind).emoji, text: c.name || 'Place' };
    case 'ride': return { emoji: opt(RIDE_MODES, c.mode).emoji, text: [opt(RIDE_MODES, c.mode).label, c.to && `to ${c.to}`].filter(Boolean).join(' ') };
    case 'event': return { emoji: c.emoji || '🎟️', text: c.title || 'Event' };
    case 'media': return { emoji: opt(MEDIA_KINDS, c.kind).emoji, text: c.title || 'Media' };
    default: return { emoji: '•', text: c.title || c.name || c.type };
  }
}

export const ordinal = (n) => {
  const v = Number(n);
  if (!v) return '';
  const s = ['th', 'st', 'nd', 'rd'], m = v % 100;
  return `${v}${s[(m - 20) % 10] || s[m] || s[0]}`;
};

const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(/,|\band\b|&/)).map((x) => String(x).trim()).filter(Boolean);
const list = (v) => toList(v).join(', ');

/** Clean up a card from an import or a model. Returns null if it's not usable. */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = cardType(raw.type);
  if (!t) return null;
  const c = { id: raw.id || uid('c'), type: t.id };
  for (const f of t.fields) {
    let v = raw[f.key];
    if (v == null || v === '') continue;
    if (f.list) v = toList(v);
    else if (f.type === 'number') v = Number(String(v).replace(/[^\d.]/g, '')) || undefined;
    else if (f.upper) v = String(v).trim().toUpperCase();
    else if (f.type === 'select') v = f.options.some((o) => o.id === v) ? v : f.options[f.options.length - 1].id;
    else v = String(v).trim();
    if (v !== undefined && !(Array.isArray(v) && !v.length)) c[f.key] = v;
  }
  return c;
}

export const CARDS_DOC = CARD_TYPES.map((t) => `- ${t.label}: ${t.schema}`).join('\n');

// --- rendering ---------------------------------------------------------------

const minutes = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function flightDuration(c) {
  const a = minutes(c.depart), b = minutes(c.arrive);
  if (a == null || b == null) return '';
  let d = b - a;
  if (d <= 0) d += 24 * 60;
  return `${Math.floor(d / 60)}h ${String(d % 60).padStart(2, '0')}m`;
}

/** The visual card. `onClick` opens the editor. */
export function Card({ card: c, onClick }) {
  const t = cardType(c.type);
  if (!t) return null;
  const style = { '--tint': t.tint };
  const cls = cx('jc', `jc-${c.type}`, t.wide && 'is-wide');

  if (c.type === 'flight') {
    const dur = flightDuration(c);
    return html`<button class=${cls} style=${style} onClick=${onClick}>
      <div class="jc-top"><span class="jc-badge">✈️</span><span class="jc-kicker">${c.airline || 'Flight'}${c.number ? ` · ${c.number}` : ''}</span>${c.seat && html`<span class="jc-chip">Seat ${c.seat}</span>`}</div>
      <div class="jc-route">
        <div class="jc-port"><b>${c.from || '———'}</b><span>${c.depart || ' '}</span></div>
        <div class="jc-path"><i /><span>${dur || ' '}</span><i /></div>
        <div class="jc-port is-end"><b>${c.to || '———'}</b><span>${c.arrive || ' '}</span></div>
      </div>
      ${c.note && html`<p class="jc-note">${c.note}</p>`}
    </button>`;
  }

  if (c.type === 'race') {
    return html`<button class=${cls} style=${style} onClick=${onClick}>
      <div class="jc-race-row">
        <div class="jc-result">
          ${c.place ? html`<b>${ordinal(c.place)}</b>${c.of && html`<span>of ${c.of}</span>`}` : html`<b class="is-emoji">${c.emoji || '🏁'}</b>`}
        </div>
        <div class="jc-race-text">
          <span class="jc-kicker">${c.event || 'Race'}</span>
          <span class="jc-title">${[c.category, c.crew?.length ? `with ${list(c.crew)}` : ''].filter(Boolean).join(' ') || 'Race'}${c.place && c.emoji ? ` ${c.emoji}` : ''}</span>
          ${c.time && html`<span class="jc-time"><${Icon} name="clock" size=${12} />${c.time}</span>`}
        </div>
      </div>
      ${c.note && html`<p class="jc-note">${c.note}</p>`}
    </button>`;
  }

  const s = cardSummary(c);
  let title = s.text, sub = '';
  if (c.type === 'workout') { title = c.activity || 'Workout'; sub = [c.where, c.duration, c.with?.length && `with ${list(c.with)}`].filter(Boolean).join(' · '); }
  if (c.type === 'place') { sub = [opt(PLACE_KINDS, c.kind).label, c.city].filter(Boolean).join(' · '); }
  if (c.type === 'ride') { title = opt(RIDE_MODES, c.mode).label; sub = [c.from, c.to].filter(Boolean).join(' → '); }
  if (c.type === 'event') { sub = c.kind ? c.kind.charAt(0).toUpperCase() + c.kind.slice(1) : ''; }
  if (c.type === 'media') { sub = [opt(MEDIA_KINDS, c.kind).label, c.detail].filter(Boolean).join(' · '); }
  return html`<button class=${cx(cls, c.type === 'ride' && 'is-compact')} style=${style} onClick=${onClick}>
    <div class="jc-row">
      <span class="jc-icon">${s.emoji}</span>
      <span class="jc-text"><span class="jc-title">${title}</span>${sub && html`<span class="jc-sub">${sub}</span>`}</span>
    </div>
    ${c.note && html`<p class="jc-note">${c.note}</p>`}
  </button>`;
}

/** Popover form for one card. */
export function CardEditor({ anchor, card, onSave, onDelete, onClose }) {
  const t = cardType(card.type);
  const [draft, setDraft] = useState(card);
  const set = (k, v) => setDraft({ ...draft, [k]: v });
  const done = () => { onSave(normalizeCard(draft) || draft); onClose(); };
  return html`<${Popover} anchor=${anchor} onClose=${done} placement="bottom-start" class="jc-editor" width=${340} label=${`Edit ${t.label}`}>
    <form onSubmit=${(e) => { e.preventDefault(); done(); }}>
      <div class="jc-editor-head" style=${{ '--tint': t.tint }}><span class="jc-badge">${t.emoji}</span><b>${t.label}</b></div>
      <div class="jc-form">
        ${t.fields.map((f) => html`<label key=${f.key} class=${cx('jc-field', f.half && 'is-half')}>
          <span>${f.label}</span>
          ${f.type === 'select' ? html`<select class="field field-sm" value=${draft[f.key] || f.options[0].id} onChange=${(e) => set(f.key, e.target.value)}>
              ${f.options.map((o) => html`<option value=${o.id}>${o.emoji} ${o.label}</option>`)}
            </select>`
          : f.type === 'textarea' ? html`<textarea class="field" rows="2" value=${draft[f.key] || ''} onInput=${(e) => set(f.key, e.target.value)} />`
          : html`<input class="field field-sm" type=${f.type === 'number' ? 'number' : f.type === 'time' ? 'time' : 'text'} placeholder=${f.placeholder || ''}
              value=${f.list ? list(draft[f.key]) : draft[f.key] ?? ''} onInput=${(e) => set(f.key, e.target.value)} />`}
        </label>`)}
      </div>
      <div class="jc-editor-foot">
        <button type="button" class="btn btn-sm btn-ghost is-danger-text" onClick=${() => { onDelete(); onClose(); }}><${Icon} name="trash" size=${13} />Remove</button>
        <button type="submit" class="btn btn-sm btn-primary">Done</button>
      </div>
    </form>
  </${Popover}>`;
}

// --- AI: find cards in an entry --------------------------------------------------

export const ENRICH_SYSTEM = `You read one day of someone's personal journal and pull out structured details. Be faithful: only include things that clearly happened that day. Use the person's own words for notes, briefly. Hashtags like #flight, #race/2x, #rowing/hanlan, #uber, #restaurant/name, #house/name are the writer's shorthand — turn them into cards. People are first names or family words (Mum, Dad) of people they spent time with; never include the writer. Answer only with JSON.`;

export function enrichPrompt(markdown) {
  return `Journal entry:\n"""\n${markdown}\n"""\n\nReturn JSON:\n{"icon":"one emoji that sums up the day","title":"short title if the day had a main event, else empty","people":["Jack"],"tags":["regatta"],"cards":[...]}\n\nCard types:\n${CARDS_DOC}`;
}
