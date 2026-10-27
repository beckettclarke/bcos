// Smart cards: structured moments in a day (a flight, a race result, a place,
// a ride…) that replace hashtags. They live inline in the day's story as
// <figure data-card="id"> placeholders (see RichEditor `embed`); the data is in
// entry.cards. Each type declares its fields, so the editor form, the import
// and the AI schema all come from one place.

import { html, useState } from '../lib/html.js';
import { settings } from '../lib/store.js';
import { Popover } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { cx, uid } from '../lib/util.js';

const RIDE_MODES = [
  { id: 'uber', label: 'Uber', icon: 'car', domain: 'uber.com' },
  { id: 'lyft', label: 'Lyft', icon: 'car', domain: 'lyft.com' },
  { id: 'taxi', label: 'Taxi', icon: 'car' },
  { id: 'transit', label: 'Transit', icon: 'bus' },
  { id: 'train', label: 'Train', icon: 'train' },
  { id: 'drive', label: 'Drove', icon: 'car' },
  { id: 'driven', label: 'Got a lift', icon: 'car' },
  { id: 'walk', label: 'Walked', icon: 'walk' },
  { id: 'bike', label: 'Biked', icon: 'bike' },
  { id: 'escooter', label: 'E-scooter', icon: 'bike' },
  { id: 'other', label: 'Ride', icon: 'car' },
];
const PLACE_KINDS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'friend', label: 'Friend’s place', icon: 'home' },
  { id: 'school', label: 'School', icon: 'graduation' },
  { id: 'gym', label: 'Gym / club', icon: 'dumbbell' },
  { id: 'restaurant', label: 'Restaurant', icon: 'utensils' },
  { id: 'cafe', label: 'Café', icon: 'coffee' },
  { id: 'shop', label: 'Shop', icon: 'bag' },
  { id: 'hotel', label: 'Hotel', icon: 'bed' },
  { id: 'venue', label: 'Venue', icon: 'ticket' },
  { id: 'outdoors', label: 'Outdoors', icon: 'leaf' },
  { id: 'city', label: 'City', icon: 'building' },
  { id: 'other', label: 'Place', icon: 'map-pin' },
];
const MEDIA_KINDS = [
  { id: 'show', label: 'Show', icon: 'tv' },
  { id: 'movie', label: 'Movie', icon: 'film' },
  { id: 'music', label: 'Music', icon: 'music' },
  { id: 'book', label: 'Book', icon: 'book' },
  { id: 'game', label: 'Game', icon: 'gamepad' },
  { id: 'podcast', label: 'Podcast', icon: 'mic' },
];
const ORDER_KINDS = [
  { id: 'food', label: 'Food delivery', icon: 'utensils' },
  { id: 'package', label: 'Package', icon: 'package' },
  { id: 'groceries', label: 'Groceries', icon: 'bag' },
];
const APPOINTMENT_KINDS = [
  { id: 'dentist', label: 'Dentist', icon: 'stethoscope' },
  { id: 'orthodontist', label: 'Orthodontist', icon: 'stethoscope' },
  { id: 'doctor', label: 'Doctor', icon: 'stethoscope' },
  { id: 'hospital', label: 'Hospital', icon: 'stethoscope' },
  { id: 'surgery', label: 'Surgery', icon: 'stethoscope' },
  { id: 'vaccine', label: 'Vaccine', icon: 'stethoscope' },
  { id: 'haircut', label: 'Haircut', icon: 'scissors' },
  { id: 'other', label: 'Appointment', icon: 'calendar' },
];
const MEDALS = [{ id: '', label: 'None' }, { id: 'gold', label: 'Gold' }, { id: 'silver', label: 'Silver' }, { id: 'bronze', label: 'Bronze' }];
const opt = (list, id) => list.find((x) => x.id === id) || list.find((x) => x.id === 'other') || list[0];

// Brands (stores, chains, services) → website, for logos when a card has no domain.
const BRANDS = [
  [/uber ?eats/i, 'ubereats.com'], [/doordash/i, 'doordash.com'], [/skip ?the ?dishes/i, 'skipthedishes.com'], [/instacart/i, 'instacart.ca'],
  [/amazon/i, 'amazon.ca'], [/temu/i, 'temu.com'], [/taobao/i, 'taobao.com'], [/aliexpress/i, 'aliexpress.com'], [/shein/i, 'shein.com'],
  [/mcdonald/i, 'mcdonalds.com'], [/starbucks/i, 'starbucks.com'], [/tim ?hortons?/i, 'timhortons.com'], [/chipotle/i, 'chipotle.com'],
  [/shake ?shack/i, 'shakeshack.com'], [/dq|dairy queen/i, 'dairyqueen.com'], [/a ?& ?w/i, 'aw.ca'], [/pizza ?pizza/i, 'pizzapizza.ca'],
  [/domino/i, 'dominos.ca'], [/popeyes/i, 'popeyes.com'], [/chick-?fil-?a/i, 'chick-fil-a.com'], [/papa ?john/i, 'papajohns.com'],
  [/little ?caesars/i, 'littlecaesars.com'], [/pizza ?hut/i, 'pizzahut.ca'], [/harvey'?s/i, 'harveys.ca'], [/krispy ?kreme/i, 'krispykreme.com'],
  [/baskin/i, 'baskinrobbins.com'], [/firehouse/i, 'firehousesubs.com'], [/burrito ?boyz|barburrito/i, 'barburrito.ca'], [/burger ?priest/i, 'theburgerspriest.com'],
  [/panago/i, 'panago.com'], [/sunset ?grill/i, 'sunsetgrill.ca'], [/menchie/i, 'menchies.com'], [/the ?keg/i, 'thekeg.com'], [/olive ?garden/i, 'olivegarden.com'],
  [/jack ?astor/i, 'jackastors.com'], [/eataly/i, 'eataly.com'], [/hero ?(certified )?burger/i, 'heroburgers.com'], [/dave'?s hot chicken/i, 'daveshotchicken.com'],
  [/big ?smoke/i, 'bigsmokeburger.ca'], [/real ?fruit/i, 'realfruitbubbletea.com'], [/the ?alley/i, 'the-alley.ca'], [/coco/i, 'coco-tea.com'],
  [/costco/i, 'costco.ca'], [/walmart/i, 'walmart.ca'], [/ikea/i, 'ikea.com'], [/home ?depot/i, 'homedepot.ca'], [/canadian ?tire/i, 'canadiantire.ca'],
  [/dollarama/i, 'dollarama.com'], [/loblaws/i, 'loblaws.ca'], [/shoppers/i, 'shoppersdrugmart.ca'], [/whole ?foods/i, 'wholefoodsmarket.com'],
  [/metro/i, 'metro.ca'], [/farm ?boy/i, 'farmboy.ca'], [/staples/i, 'staples.ca'], [/h ?& ?m/i, 'hm.com'], [/7-?eleven/i, '7-eleven.com'],
  [/circle ?k/i, 'circlek.com'], [/rexall/i, 'rexall.ca'], [/publix/i, 'publix.com'], [/target/i, 'target.com'], [/t ?& ?t/i, 'tntsupermarket.com'],
  [/foodland/i, 'foodland.ca'], [/pusateri/i, 'pusateris.com'], [/summerhill market/i, 'summerhillmarket.com'], [/apple ?store/i, 'apple.com'],
  [/ttc/i, 'ttc.ca'], [/go ?transit|go train/i, 'gotransit.com'], [/up express/i, 'upexpress.com'], [/via rail/i, 'viarail.ca'],
  [/brooks/i, 'brooksrunning.com'], [/urban ?outfitters/i, 'urbanoutfitters.com'], [/yorkdale/i, 'yorkdale.com'], [/canada'?s wonderland|wonderland/i, 'canadaswonderland.com'],
];
const brandDomain = (text) => BRANDS.find(([re]) => re.test(text || ''))?.[1] || null;

// Airline → logo domain, by IATA prefix of the flight number or by name.
const AIRLINES = [
  ['AA', /american/i, 'aa.com'], ['AC', /air canada/i, 'aircanada.com'], ['WS', /westjet/i, 'westjet.com'],
  ['PD', /porter/i, 'flyporter.com'], ['F8', /flair/i, 'flyflair.com'], ['DL', /delta/i, 'delta.com'],
  ['UA', /united/i, 'united.com'], ['B6', /jetblue/i, 'jetblue.com'], ['WN', /southwest/i, 'southwest.com'],
  ['AS', /alaska/i, 'alaskaair.com'], ['NK', /spirit/i, 'spirit.com'], ['F9', /frontier/i, 'flyfrontier.com'],
  ['BA', /british/i, 'britishairways.com'], ['LH', /lufthansa/i, 'lufthansa.com'], ['AF', /air france/i, 'airfrance.com'],
  ['KL', /klm/i, 'klm.com'], ['EK', /emirates/i, 'emirates.com'], ['QR', /qatar/i, 'qatarairways.com'],
  ['IB', /iberia/i, 'iberia.com'], ['EI', /aer lingus/i, 'aerlingus.com'], ['VS', /virgin atlantic/i, 'virginatlantic.com'],
  ['TS', /air transat/i, 'airtransat.com'], ['LX', /swiss/i, 'swiss.com'], ['NH', /\bana\b|all nippon/i, 'ana.co.jp'],
  ['JL', /japan airlines/i, 'jal.co.jp'], ['CX', /cathay/i, 'cathaypacific.com'], ['SQ', /singapore/i, 'singaporeair.com'],
  ['QF', /qantas/i, 'qantas.com'], ['TK', /turkish/i, 'turkishairlines.com'], ['AM', /aeromexico/i, 'aeromexico.com'],
];

export const CARD_TYPES = [
  {
    id: 'flight', label: 'Flight', icon: 'plane', pinned: true,
    fields: [
      { key: 'airline', label: 'Airline', placeholder: 'American Airlines', half: true },
      { key: 'number', label: 'Flight', placeholder: 'AA 1234', half: true },
      { key: 'from', label: 'From', placeholder: 'PHL', upper: true, half: true },
      { key: 'to', label: 'To', placeholder: 'YYZ', upper: true, half: true },
      { key: 'depart', label: 'Departs', type: 'time', half: true },
      { key: 'arrive', label: 'Arrives', type: 'time', half: true },
      { key: 'seat', label: 'Seat', placeholder: '14A', half: true },
      { key: 'domain', label: 'Logo website', placeholder: 'aa.com', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"flight","airline":"American Airlines","number":"AA 4567","from":"PHL","to":"YYZ","depart":"19:45","arrive":"21:20","seat":"","domain":"aa.com","note":""}',
  },
  {
    id: 'race', label: 'Race', icon: 'flag', pinned: true,
    fields: [
      { key: 'event', label: 'Event', placeholder: 'Head of the Trent' },
      { key: 'category', label: 'Boat / category', placeholder: '2x', half: true },
      { key: 'crew', label: 'With', placeholder: 'Jack', half: true, list: true },
      { key: 'place', label: 'Place', type: 'number', half: true },
      { key: 'of', label: 'Out of', type: 'number', half: true },
      { key: 'time', label: 'Time', placeholder: '14:01.3', half: true },
      { key: 'medal', label: 'Medal', type: 'select', options: MEDALS, half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"race","event":"Schuylkill Navy Regatta","category":"2x","crew":["Jack"],"place":16,"of":48,"time":"14:01","medal":"","note":"Good line, pushed to a 1:41 at the end"}  (medal: gold|silver|bronze when they medalled, else omit)',
  },
  {
    id: 'workout', label: 'Workout', icon: 'activity',
    fields: [
      { key: 'activity', label: 'Activity', placeholder: 'Rowing' },
      { key: 'where', label: 'Where', placeholder: 'Hanlan', half: true },
      { key: 'duration', label: 'Duration', placeholder: '45 min', half: true },
      { key: 'with', label: 'With', placeholder: 'Jack', list: true, half: true },
      { key: 'result', label: 'Result', placeholder: '2k · 6:58.4 PB', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"workout","activity":"Rowing","where":"Hanlan","duration":"","with":["Jack"],"result":"","note":"2x, two laps to the gap and back"}  (result: test scores and PBs, e.g. "2k 6:58.4 PB", "max watts 612")',
  },
  {
    id: 'place', label: 'Place', icon: 'map-pin',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'Jack Astor’s' },
      { key: 'kind', label: 'Kind', type: 'select', options: PLACE_KINDS, half: true },
      { key: 'city', label: 'City', placeholder: 'Peterborough', half: true },
      { key: 'domain', label: 'Logo website', placeholder: 'jackastors.com' },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"place","name":"Jack Astor\'s","kind":"restaurant","city":"","domain":"jackastors.com","note":""}  (kind: home|friend|school|gym|restaurant|cafe|shop|hotel|venue|outdoors|city|other; domain only for real businesses/chains with a website)',
  },
  {
    id: 'ride', label: 'Ride', icon: 'car',
    fields: [
      { key: 'mode', label: 'How', type: 'select', options: RIDE_MODES, half: true },
      { key: 'domain', label: 'Logo website', placeholder: 'ttc.ca', half: true },
      { key: 'from', label: 'From', placeholder: 'Hotel', half: true },
      { key: 'to', label: 'To', placeholder: 'Airport', half: true },
      { key: 'with', label: 'With', placeholder: 'Dad', list: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"ride","mode":"lyft","from":"","to":"Airport","with":[],"domain":"","note":""}  (mode: uber|lyft|taxi|transit|train|drive|driven|walk|bike|escooter; "drive" = they drove, a driving lesson is mode drive with the instructor in "with"; transit: set domain, e.g. "ttc.ca")',
  },
  {
    id: 'order', label: 'Order', icon: 'package',
    fields: [
      { key: 'service', label: 'From', placeholder: 'Uber Eats', half: true },
      { key: 'kind', label: 'Kind', type: 'select', options: ORDER_KINDS, half: true },
      { key: 'item', label: 'What', placeholder: 'Basta Pasta — 2 pizzas' },
      { key: 'domain', label: 'Logo website', placeholder: 'ubereats.com' },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"order","service":"DoorDash","kind":"food","item":"Basta Pasta","domain":"doordash.com","note":"Got two things wrong, they sent a replacement"}  (kind: food|package|groceries — Uber Eats/DoorDash meals, Amazon/Temu/Taobao/AliExpress packages, Walmart/Instacart deliveries)',
  },
  {
    id: 'appointment', label: 'Appointment', icon: 'stethoscope',
    fields: [
      { key: 'kind', label: 'Kind', type: 'select', options: APPOINTMENT_KINDS, half: true },
      { key: 'with', label: 'With', placeholder: 'Dr. Smith', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"appointment","kind":"orthodontist","with":"","note":"Got the retainer adjusted"}  (kind: dentist|orthodontist|doctor|hospital|surgery|vaccine|haircut|other)',
  },
  {
    id: 'event', label: 'Event', icon: 'ticket',
    fields: [
      { key: 'title', label: 'Title', placeholder: 'Chem test' },
      { key: 'kind', label: 'Kind', placeholder: 'test', half: true },
      { key: 'domain', label: 'Logo website', placeholder: '', half: true },
      { key: 'note', label: 'Note', type: 'textarea' },
    ],
    schema: '{"type":"event","title":"Sleepover at Jack\'s","kind":"sleepover","note":""}',
  },
  {
    id: 'media', label: 'Watched & played', icon: 'tv',
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

const EVENT_ICONS = [[/test|exam|quiz|school|class/i, 'graduation'], [/sleep/i, 'bed'], [/birthday|party|gift/i, 'gift'], [/regatta|race|game|match/i, 'trophy'], [/concert|show|gig/i, 'music'], [/trip|travel/i, 'plane']];
const WORKOUT_ICONS = [[/bike|cycl|spin/i, 'bike'], [/run|jog|walk|hike/i, 'walk'], [/gym|lift|weights|strength/i, 'dumbbell']];
const match = (list, text, fallback) => list.find(([re]) => re.test(text || ''))?.[1] || fallback;

/** The line icon for a card. */
export function cardIcon(c) {
  switch (c.type) {
    case 'ride': return opt(RIDE_MODES, c.mode).icon;
    case 'place': return opt(PLACE_KINDS, c.kind).icon;
    case 'media': return opt(MEDIA_KINDS, c.kind).icon;
    case 'order': return opt(ORDER_KINDS, c.kind).icon;
    case 'appointment': return opt(APPOINTMENT_KINDS, c.kind).icon;
    case 'race': return c.medal ? 'medal' : 'flag';
    case 'event': return match(EVENT_ICONS, `${c.kind} ${c.title}`, 'ticket');
    case 'workout': return match(WORKOUT_ICONS, c.activity, 'activity');
    default: return cardType(c.type)?.icon || 'circle';
  }
}

/** The website whose logo stands for this card, if any. */
export function cardDomain(c) {
  if (c.domain) return String(c.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (c.type === 'ride') return opt(RIDE_MODES, c.mode).domain || null;
  if (c.type === 'place') return brandDomain(c.name);
  if (c.type === 'order') return brandDomain(c.service) || brandDomain(c.item);
  if (c.type === 'event') return brandDomain(c.title);
  if (c.type === 'flight') {
    const code = String(c.number || '').toUpperCase().match(/^([A-Z0-9]{2})\s*\d/)?.[1];
    return (AIRLINES.find(([iata]) => iata === code) || AIRLINES.find(([, re]) => re.test(c.airline || '')))?.[2] || null;
  }
  return null;
}

/** A brand logo from logo.dev (needs a key in Settings). The line icon shows until the logo has loaded, and stays if it can't. */
export function Logo({ domain, icon, size = 36, class: cls }) {
  const key = settings().logoDevKey;
  const [state, setState] = useState({ url: null, ok: false, failed: false });
  const url = domain && key ? `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(key)}&size=${size * 2}&format=png&fallback=404` : null;
  const cur = state.url === url ? state : { url, ok: false, failed: false };
  return html`<span class=${cx('jc-tile', cur.ok && 'has-logo', cls)} style=${{ width: `${size}px`, height: `${size}px` }}>
    ${!cur.ok && html`<${Icon} name=${icon} size=${Math.round(size * 0.46)} />`}
    ${url && !cur.failed && html`<img src=${url} alt="" draggable="false" class=${cur.ok ? '' : 'is-loading'}
      onLoad=${() => setState({ url, ok: true, failed: false })} onError=${() => setState({ url, ok: false, failed: true })} />`}
  </span>`;
}

/** One line of text for a card, used in the pinned strip, filters and search. */
export function cardSummary(c) {
  switch (c.type) {
    case 'flight': return [c.from && c.to ? `${c.from} → ${c.to}` : '', c.airline].filter(Boolean).join(' · ') || 'Flight';
    case 'race': return [c.place ? `${ordinal(c.place)}${c.of ? ` of ${c.of}` : ''}` : '', c.category, c.time].filter(Boolean).join(' · ') || c.event || 'Race';
    case 'workout': return [c.activity, c.where].filter(Boolean).join(' · ') || 'Workout';
    case 'place': return c.name || 'Place';
    case 'ride': return [opt(RIDE_MODES, c.mode).label, c.to && `to ${c.to}`].filter(Boolean).join(' ');
    case 'event': return c.title || 'Event';
    case 'media': return c.title || 'Media';
    case 'order': return [c.service, c.item].filter(Boolean).join(' · ') || 'Order';
    case 'appointment': return [opt(APPOINTMENT_KINDS, c.kind).label, c.with].filter(Boolean).join(' · ');
    default: return c.title || c.name || c.type;
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
  const c = { id: raw.id && /^[\w-]{1,80}$/.test(raw.id) ? raw.id : uid('c'), type: t.id };
  for (const f of t.fields) {
    let v = raw[f.key];
    if (v == null || v === '') continue;
    if (f.list) v = toList(v);
    else if (f.type === 'number') v = Number(String(v).replace(/[^\d.]/g, '')) || undefined;
    else if (f.upper) v = String(v).trim().toUpperCase();
    else if (f.type === 'select') v = f.options.some((o) => o.id === v) ? v || undefined : f.options[0].id === '' ? undefined : opt(f.options, v).id;
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

/** The inline card. `onClick` opens the editor. */
export function Card({ card: c, onClick }) {
  const t = cardType(c.type);
  if (!t) return null;
  const logo = html`<${Logo} domain=${cardDomain(c)} icon=${cardIcon(c)} />`;

  if (c.type === 'flight') {
    const dur = flightDuration(c);
    return html`<button type="button" class="jc jc-flight" onClick=${onClick}>
      <div class="jc-row">
        ${logo}
        <span class="jc-text"><span class="jc-title">${c.airline || 'Flight'}</span><span class="jc-sub">${[c.number, c.seat && `Seat ${c.seat}`].filter(Boolean).join(' · ') || 'Flight'}</span></span>
      </div>
      <div class="jc-route">
        <div class="jc-port"><b>${c.from || '———'}</b><span>${c.depart || ' '}</span></div>
        <div class="jc-path"><i /><${Icon} name="plane" size=${14} /><span>${dur}</span><i /></div>
        <div class="jc-port is-end"><b>${c.to || '———'}</b><span>${c.arrive || ' '}</span></div>
      </div>
      ${c.note && html`<p class="jc-note">${c.note}</p>`}
    </button>`;
  }

  if (c.type === 'race') {
    return html`<button type="button" class="jc jc-race" onClick=${onClick}>
      <div class="jc-row">
        <span class="jc-result">${c.place ? html`<b>${ordinal(c.place)}</b>${c.of && html`<span>of ${c.of}</span>`}` : html`<${Icon} name="flag" size=${18} />`}</span>
        <span class="jc-text">
          <span class="jc-sub">${c.event || 'Race'}</span>
          <span class="jc-title">${[c.category, c.crew?.length ? `with ${list(c.crew)}` : ''].filter(Boolean).join(' ') || 'Race'}</span>
        </span>
        ${c.medal && html`<span class=${cx('jc-medal', `is-${c.medal}`)}><${Icon} name="medal" size=${13} />${c.medal[0].toUpperCase() + c.medal.slice(1)}</span>`}
        ${c.time && html`<span class="jc-meta"><${Icon} name="clock" size=${13} />${c.time}</span>`}
      </div>
      ${c.note && html`<p class="jc-note">${c.note}</p>`}
    </button>`;
  }

  let title = cardSummary(c), sub = '';
  let meta = '';
  if (c.type === 'workout') { title = c.activity || 'Workout'; sub = [c.where, c.duration, c.with?.length && `with ${list(c.with)}`].filter(Boolean).join(' · '); meta = c.result || ''; }
  if (c.type === 'order') { title = c.service || opt(ORDER_KINDS, c.kind).label; sub = c.item || opt(ORDER_KINDS, c.kind).label; }
  if (c.type === 'appointment') { title = opt(APPOINTMENT_KINDS, c.kind).label; sub = c.with || ''; }
  if (c.type === 'place') { sub = [opt(PLACE_KINDS, c.kind).label, c.city].filter(Boolean).join(' · '); }
  if (c.type === 'ride') { title = opt(RIDE_MODES, c.mode).label; sub = [[c.from, c.to].filter(Boolean).join(' → '), c.with?.length && `with ${list(c.with)}`].filter(Boolean).join(' · '); }
  if (c.type === 'event') { sub = c.kind ? c.kind.charAt(0).toUpperCase() + c.kind.slice(1) : ''; }
  if (c.type === 'media') { sub = [opt(MEDIA_KINDS, c.kind).label, c.detail].filter(Boolean).join(' · '); }
  return html`<button type="button" class=${cx('jc', `jc-${c.type}`)} onClick=${onClick}>
    <div class="jc-row">
      ${logo}
      <span class="jc-text"><span class="jc-title">${title}</span>${sub && html`<span class="jc-sub">${sub}</span>`}</span>
      ${meta && html`<span class="jc-meta">${meta}</span>`}
    </div>
    ${c.note && html`<p class="jc-note">${c.note}</p>`}
  </button>`;
}

/** The small version shown pinned at the top of the day. */
export function CardPin({ card: c, onClick }) {
  return html`<button type="button" class="jc-pin" onClick=${onClick}>
    <${Logo} domain=${cardDomain(c)} icon=${cardIcon(c)} size=${22} />
    <span>${cardSummary(c)}</span>
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
      <div class="jc-editor-head"><${Logo} domain=${cardDomain(draft)} icon=${cardIcon(draft)} size=${28} /><b>${t.label}</b></div>
      <div class="jc-form">
        ${t.fields.map((f) => html`<label key=${f.key} class=${cx('jc-field', f.half && 'is-half')}>
          <span>${f.label}</span>
          ${f.type === 'select' ? html`<select class="field field-sm" value=${draft[f.key] || f.options[0].id} onChange=${(e) => set(f.key, e.target.value)}>
              ${f.options.map((o) => html`<option value=${o.id}>${o.label}</option>`)}
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
  return `Journal entry:\n"""\n${markdown}\n"""\n\nReturn JSON:\n{"icon":"one emoji that sums up the day","people":["Jack"],"tags":["regatta"],"cards":[...]}\n\nEvery card must also have "after": the exact words (at least 4) of the line in the entry it belongs to, so it can be placed in the timeline.\n\nCard types:\n${CARDS_DOC}`;
}
