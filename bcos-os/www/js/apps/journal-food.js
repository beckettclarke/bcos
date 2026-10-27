// Food: turn "2 pancakes, 2 eggs and 3 strips of bacon with orange juice"
// into items with an icon, a quantity and a kind — offline, instantly. The
// "Smart" pass asks a model to fix icons and add portions and calories.
//
// Food = { id, name, qty, unit, emoji, kind: 'food'|'drink'|'sweet', zero, kcal, note }

import { uid } from '../lib/util.js';
import { MEALS } from './journal-shared.js';

// First match wins, so dishes come before their ingredients
// ("chocolate cake" is cake, "banana honey sandwich" is a sandwich).
const DB = [
  [/sandwich|panini|\bsub\b|blt|sarnie|grilled cheese/, '🥪'],
  [/burrito|wrap|shawarma/, '🌯'],
  [/taco|quesadilla|nacho/, '🌮'],
  [/cheeseburger|burger|slider/, '🍔'],
  [/pizza|calzone/, '🍕'],
  [/hot ?dog/, '🌭'],
  [/fries|poutine/, '🍟'],
  [/salad|caesar|poke/, '🥗'],
  [/ramen|pho|udon|noodle|pad thai|lo mein/, '🍜'],
  [/pasta|spaghetti|lasagna|penne|mac (and|n|&) cheese|carbonara|pesto|fettuccine|ravioli|gnocchi/, '🍝'],
  [/sushi|sashimi|maki/, '🍣'],
  [/curry|biryani|tikka|butter chicken/, '🍛'],
  [/dumpling|gyoza|bao|dim sum/, '🥟'],
  [/soup|stew|chili|broth/, '🍲'],
  [/pancake|crepe/, '🥞'],
  [/waffle/, '🧇'],
  [/cupcake|muffin/, '🧁'],
  [/cake|cheesecake|brownie/, '🍰'],
  [/cookie|biscuit/, '🍪'],
  [/donut|doughnut|timbit/, '🍩'],
  [/ice cream|gelato|sundae|froyo|mcflurry/, '🍦'],
  [/\bpie\b|tart/, '🥧'],
  [/croissant|pastry|danish/, '🥐'],
  [/bagel/, '🥯'],
  [/cereal|oat|granola|porridge|yogh?urt|parfait/, '🥣'],
  [/egg|omelet|frittata/, '🍳'],
  [/bacon/, '🥓'],
  [/toast|bread|baguette|roll\b|bun\b/, '🍞'],
  [/meatball|falafel/, '🧆'],
  [/chicken|wings?\b|nugget|tender|drumstick/, '🍗'],
  [/steak|beef|brisket|ribs?\b|pork|lamb|sausage|ham\b/, '🥩'],
  [/shrimp|prawn|tempura/, '🍤'],
  [/fish|salmon|tuna|cod|halibut/, '🐟'],
  [/rice|risotto|fried rice/, '🍚'],
  [/broccoli|greens|spinach|kale|veg/, '🥦'],
  [/potato|mash|wedges/, '🥔'],
  [/corn/, '🌽'],
  [/carrot/, '🥕'],
  [/avocado|guac/, '🥑'],
  [/cheese/, '🧀'],
  [/banana/, '🍌'],
  [/apple\b/, '🍎'],
  [/orange\b|clementine|mandarin/, '🍊'],
  [/grape/, '🍇'],
  [/strawberr/, '🍓'],
  [/blueberr|berries/, '🫐'],
  [/watermelon|melon/, '🍉'],
  [/peach/, '🍑'],
  [/pretzel|snack mix|trail mix|chex/, '🥨'],
  [/popcorn/, '🍿'],
  [/chips|crisps|doritos|pringles/, '🥔'],
  [/cracker|rice cake/, '🍘'],
  [/nuts?\b|almond|peanut|cashew|pistachio/, '🥜'],
  [/honey/, '🍯'],
  [/chocolate|hershey|kit ?kat|snickers|twix|m&ms|reese|aero|coffee crisp|protein bar|granola bar|\bbar\b/, '🍫'],
  [/gum\b|mentos|candy|sweets|skittles|gumm|sour patch|lollipop|jelly bean|tic tac/, '🍬'],
];

const DRINKS = [
  [/coffee|latte|espresso|cappuccino|americano|macchiato|mocha|cold brew|frapp|hot chocolate|double double/, '☕️'],
  [/matcha|tea\b|chai/, '🍵'],
  [/smoothie|milkshake|shake\b|slushie|bubble tea|boba/, '🥤'],
  [/juice|lemonade|gatorade|powerade|bodyarmor|electrolyte|prime\b/, '🧃'],
  [/milk\b|chocolate milk/, '🥛'],
  [/\bcoke\b|\bcola\b|pepsi|sprite|fanta|7 ?up|ginger ale|root beer|dr\.? pepper|mountain dew|soda|\bpop\b|crush\b|a&w|red bull|monster|celsius|energy drink/, '🥤'],
  [/beer|lager|\bale\b|ipa\b|cider/, '🍺'],
  [/wine|champagne|prosecco/, '🍷'],
  [/water|perrier|san pellegrino|bubly|la croix/, '💧'],
];

const SWEET = new Set(['🧁', '🍰', '🍪', '🍩', '🍦', '🥧', '🍫', '🍬', '🍯']);
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, half: 0.5 };
const UNITS = 'pack|packs|bag|bags|bottle|bottles|can|cans|cup|cups|glass|glasses|slice|slices|piece|pieces|strip|strips|bowl|bowls|plate|plates|box|boxes|bar|bars|scoop|scoops|handful|handfuls|serving|servings';
const KEEP_PLURAL = /(fries|chips|crisps|nachos|mentos|skittles|oats|noodles|greens|m&ms|nuts|wings|ribs|leftovers|chex|sweets|crackers|tenders|nuggets|pretzels)$/i;

export function iconFor(name) {
  const n = ` ${String(name).toLowerCase()} `;
  for (const [re, e] of DRINKS) if (re.test(n)) return { emoji: e, kind: 'drink' };
  for (const [re, e] of DB) if (re.test(n)) return { emoji: e, kind: SWEET.has(e) ? 'sweet' : 'food' };
  return { emoji: '🍽️', kind: 'food' };
}

const singular = (w) => (KEEP_PLURAL.test(w) ? w : w.replace(/ies$/i, 'y').replace(/(ch|sh|x|ss|o)es$/i, '$1').replace(/([^s])s$/i, '$1'));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** One item from text like "2x Gatorade zero" or "3 strips of bacon". */
export function parseItem(raw) {
  let t = String(raw).trim().replace(/^[-*•]\s*/, '').replace(/\s+/g, ' ');
  if (!t || /^[-–—]+$/.test(t)) return null;
  let qty = 1, unit = '';
  let m = t.match(/^(\d+(?:\.\d+)?|½)\s*(?:x|×)?\s+(.*)$/i) || t.match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple of|half)\s+(.*)$/i);
  if (m) { qty = m[1] === '½' ? 0.5 : Number(m[1]) || NUMBER_WORDS[m[1].toLowerCase().replace(' of', '')] || 1; t = m[2]; }
  else if ((m = t.match(/^(.*?)\s*(?:x|×)\s*(\d+)$/i))) { t = m[1]; qty = Number(m[2]); }
  const u = t.match(new RegExp(`^(${UNITS})\\s+of\\s+(.*)$`, 'i'));
  if (u) { unit = qty === 1 ? singular(u[1].toLowerCase()) : u[1].toLowerCase(); t = u[2]; }
  if (qty > 1 && !unit) t = t.replace(/(\S+)$/, (w) => singular(w));
  const name = cap(t.trim());
  const { emoji, kind } = iconFor(name);
  return { id: uid('f'), name, qty, unit, emoji, kind, zero: /\b(zero|diet|sugar[- ]free|light)\b/i.test(name) || undefined };
}

/** Split a meal line ("Burger and salad, 2 root beers and chocolate cake slice") into items. */
export function parseFoodText(text) {
  return String(text || '')
    .split(/\n|,|;|\s+\+\s+|\s+&\s+|\s+and\s+|\s+with\s+|\s+plus\s+/i)
    .map(parseItem)
    .filter(Boolean);
}

export const foodLabel = (f) => (f.unit ? `${f.name} · ${f.qty} ${f.unit}` : f.qty && f.qty !== 1 ? `${f.name} ×${f.qty}` : f.name);
export const mealText = (items = []) => items.map((f) => (f.unit ? `${f.qty} ${f.unit} of ${f.name.toLowerCase()}` : f.qty !== 1 ? `${f.qty} ${f.name}` : f.name)).join(', ');

export function foodSummary(meals = {}) {
  const items = MEALS.flatMap((m) => meals[m.id] || []);
  const drinks = items.filter((f) => f.kind === 'drink').length;
  const kcal = items.reduce((n, f) => n + (Number(f.kcal) || 0), 0);
  return { items: items.length, drinks, kcal, estimated: items.some((f) => f.kcal) };
}

// --- the "Smart" pass ------------------------------------------------------------

export const FOOD_SYSTEM = `You tidy up a food diary. For each item, return a short clean name (Title Case, keep brands like "Coke Zero" or "Jack Astor's"), a quantity, an optional unit (e.g. "strips", "slice", "bag"), exactly one emoji that best depicts the item, a kind ("food", "drink" or "sweet"), "zero": true for zero-sugar/diet drinks, and a realistic calorie estimate for that quantity as an integer "kcal". Split combined lines into separate items. Never invent foods that aren't mentioned. Answer only with JSON.`;

export function foodPrompt(meals) {
  const lines = MEALS.map((m) => `${m.label}: ${mealText(meals?.[m.id] || []) || '—'}`).join('\n');
  return `Food diary for one day:\n${lines}\n\nReturn JSON exactly like:\n{"breakfast":[{"name":"Pancakes","qty":2,"unit":"","emoji":"🥞","kind":"food","kcal":350}],"lunch":[],"dinner":[],"snacks":[]}`;
}

/** Normalise a model's (or an import's) meals object. */
export function normalizeMeals(raw) {
  const out = {};
  for (const m of MEALS) {
    const list = raw?.[m.id] ?? raw?.[m.label] ?? (m.id === 'snacks' ? raw?.snack : undefined);
    if (typeof list === 'string') { out[m.id] = parseFoodText(list); continue; }
    if (!Array.isArray(list)) { out[m.id] = []; continue; }
    out[m.id] = list.map((f) => {
      if (typeof f === 'string') return parseItem(f);
      if (!f || !f.name) return null;
      const guess = iconFor(f.name);
      return {
        id: uid('f'),
        name: String(f.name).trim(),
        qty: Number(f.qty) > 0 ? Number(f.qty) : 1,
        unit: f.unit ? String(f.unit) : '',
        emoji: f.emoji || guess.emoji,
        kind: ['food', 'drink', 'sweet'].includes(f.kind) ? f.kind : guess.kind,
        zero: f.zero || undefined,
        kcal: Number(f.kcal) > 0 ? Math.round(Number(f.kcal)) : undefined,
        note: f.note || undefined,
      };
    }).filter(Boolean);
  }
  return out;
}
