// A compact emoji picker: curated sets with keywords, search, and a field
// for typing any emoji the set doesn't have.

import { html, useState, useRef, useEffect } from '../lib/html.js';
import { Popover } from './components.js';
import { Icon } from './icons.js';
import { cx } from '../lib/util.js';

// [emoji, keywords]
const SETS = [
  { id: 'days', label: 'Days', items: [
    ['🚣', 'rowing row boat regatta race'], ['🏁', 'race finish'], ['🏆', 'win trophy'], ['🥇', 'gold medal first'], ['💪', 'workout gym strong'], ['🏃', 'run running'], ['🚴', 'bike cycling'], ['🏊', 'swim'], ['⛷️', 'ski'], ['🏋️', 'lift gym weights'], ['⚽️', 'soccer football'], ['🏀', 'basketball'], ['🎾', 'tennis'], ['⛳️', 'golf'],
    ['✈️', 'flight plane travel airport'], ['🧳', 'trip luggage travel'], ['🚗', 'car drive road trip'], ['🚆', 'train'], ['🏨', 'hotel'], ['🗺️', 'map trip'], ['🏖️', 'beach vacation'], ['🏔️', 'mountain'], ['🏕️', 'camping'], ['🌆', 'city'],
    ['🏫', 'school'], ['📚', 'study books homework'], ['📝', 'test exam'], ['🎓', 'graduation'], ['💼', 'work job'], ['💻', 'coding computer laptop'], ['🧪', 'chemistry science lab'], ['🎨', 'art drawing'], ['🎬', 'movie film video'], ['🎵', 'music'], ['🎸', 'guitar'], ['🎮', 'gaming games'], ['📺', 'tv show'], ['📖', 'reading book'],
    ['🎉', 'party celebrate'], ['🎂', 'birthday cake'], ['🎄', 'christmas'], ['🎃', 'halloween'], ['🛌', 'sleep sleepover rest'], ['🏠', 'home'], ['👨‍👩‍👦', 'family'], ['🫶', 'friends love'], ['❤️', 'love heart date'], ['🍽️', 'dinner restaurant food'], ['☕️', 'coffee cafe'], ['🛍️', 'shopping'],
    ['🤒', 'sick ill'], ['🦷', 'dentist'], ['🏥', 'hospital doctor'], ['😴', 'tired lazy'], ['🌧️', 'rain'], ['❄️', 'snow cold'], ['☀️', 'sun sunny'], ['🌙', 'night'], ['⭐️', 'star great'], ['🔥', 'fire great hype'], ['💡', 'idea'], ['🎯', 'goal'],
  ] },
  { id: 'food', label: 'Food', items: [
    ['🥞', 'pancakes'], ['🧇', 'waffle'], ['🍳', 'eggs'], ['🥓', 'bacon'], ['🥐', 'croissant'], ['🥯', 'bagel'], ['🍞', 'bread toast'], ['🥣', 'cereal oats yogurt'], ['🍌', 'banana'], ['🍎', 'apple'], ['🍊', 'orange'], ['🍓', 'strawberry'], ['🫐', 'blueberry'], ['🍇', 'grapes'], ['🍉', 'watermelon'], ['🥑', 'avocado'],
    ['🥪', 'sandwich'], ['🌯', 'wrap burrito'], ['🌮', 'taco'], ['🍔', 'burger'], ['🍟', 'fries'], ['🍕', 'pizza'], ['🌭', 'hot dog'], ['🥗', 'salad'], ['🍝', 'pasta'], ['🍜', 'ramen noodles'], ['🍣', 'sushi'], ['🍛', 'curry'], ['🍚', 'rice'], ['🥟', 'dumpling'], ['🍲', 'soup stew'], ['🍗', 'chicken'], ['🥩', 'steak meat'], ['🐟', 'fish'], ['🍤', 'shrimp'], ['🧆', 'meatballs falafel'], ['🥦', 'broccoli veg'], ['🥔', 'potato'], ['🌽', 'corn'], ['🥕', 'carrot'], ['🧀', 'cheese'],
    ['🍫', 'chocolate bar'], ['🍬', 'candy gum mints'], ['🍪', 'cookie'], ['🍰', 'cake'], ['🧁', 'cupcake muffin'], ['🍩', 'donut'], ['🍦', 'ice cream'], ['🥧', 'pie'], ['🍿', 'popcorn'], ['🥨', 'pretzel snack mix'], ['🍘', 'crackers'], ['🥜', 'nuts peanut'], ['🍯', 'honey'],
    ['🥤', 'soda pop coke drink'], ['🧃', 'juice gatorade'], ['☕️', 'coffee'], ['🍵', 'tea matcha'], ['🥛', 'milk'], ['💧', 'water'], ['🍺', 'beer'], ['🍷', 'wine'], ['🧋', 'bubble tea boba'],
  ] },
  { id: 'faces', label: 'Feelings', items: [
    ['😄', 'happy great'], ['😊', 'pleased'], ['🙂', 'ok good'], ['😐', 'neutral meh'], ['🙁', 'sad'], ['😞', 'down'], ['😫', 'exhausted awful'], ['😤', 'annoyed'], ['😡', 'angry'], ['😭', 'crying'], ['🥲', 'bittersweet'], ['🤩', 'excited'], ['🥳', 'party'], ['😎', 'cool'], ['🤯', 'mind blown'], ['🫩', 'tired meh'], ['🤒', 'sick'], ['😴', 'sleepy'], ['🥶', 'cold'], ['🥵', 'hot'], ['👍', 'good thumbs up'], ['👎', 'bad'], ['🙏', 'grateful'], ['💀', 'dead lol'],
  ] },
];

export const ALL_EMOJI = SETS.flatMap((s) => s.items);

export function EmojiPicker({ anchor, value, onPick, onClose, sets = ['days', 'food', 'faces'], allowClear = true, placement = 'bottom-start' }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState(sets[0]);
  const inputRef = useRef(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);
  const query = q.trim().toLowerCase();
  const typed = q.trim() && /\p{Extended_Pictographic}/u.test(q.trim()) ? q.trim() : null;
  const shown = query && !typed ? ALL_EMOJI.filter(([e, k]) => k.includes(query)) : (SETS.find((s) => s.id === tab)?.items || []);
  const pick = (e) => { onPick(e); onClose(); };
  return html`<${Popover} anchor=${anchor} onClose=${onClose} placement=${placement} class="emoji-pop" width=${308} label="Choose an emoji">
    <div class="emoji-head">
      <div class="search-field"><${Icon} name="search" size=${13} />
        <input ref=${inputRef} class="field field-sm" placeholder="Search or type an emoji" value=${q} onInput=${(e) => setQ(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (typed) pick([...typed][0] && typed); else if (shown[0]) pick(shown[0][0]); } }} />
      </div>
    </div>
    ${!query && html`<div class="emoji-tabs">${sets.map((id) => html`<button key=${id} class=${cx('emoji-tab', tab === id && 'is-on')} onClick=${() => setTab(id)}>${SETS.find((s) => s.id === id).label}</button>`)}</div>`}
    <div class="emoji-grid">
      ${typed && html`<button class="emoji-cell is-typed" onClick=${() => pick(typed)}>${typed}</button>`}
      ${shown.map(([e, k]) => html`<button key=${e} class=${cx('emoji-cell', e === value && 'is-on')} title=${k.split(' ')[0]} onClick=${() => pick(e)}>${e}</button>`)}
      ${!shown.length && !typed && html`<div class="emoji-none">No match — paste any emoji above</div>`}
    </div>
    ${allowClear && value && html`<button class="emoji-clear" onClick=${() => pick(null)}><${Icon} name="x" size=${12} />Remove icon</button>`}
  </${Popover}>`;
}
