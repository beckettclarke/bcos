// Wallpapers and accent colours, and applying them to the page.

import { html, useEffect, useState, useRef } from '../lib/html.js';
import { useSettings } from '../lib/store.js';

export const WALLPAPERS = [
  { id: 'peaks', name: 'Peaks', image: 'background.jpg', thumb: 'background.jpg' },
  {
    id: 'dusk', name: 'Dusk',
    css: 'radial-gradient(60% 55% at 18% 18%, #ff9a6b 0%, transparent 60%), radial-gradient(50% 50% at 85% 12%, #9d6bff 0%, transparent 60%), radial-gradient(70% 60% at 70% 85%, #1d3a8a 0%, transparent 65%), radial-gradient(55% 55% at 8% 92%, #c0306e 0%, transparent 60%), linear-gradient(160deg, #2a1640, #120d26)',
  },
  {
    id: 'aurora', name: 'Aurora',
    css: 'radial-gradient(55% 45% at 25% 20%, #3ee6b5 0%, transparent 60%), radial-gradient(45% 50% at 75% 30%, #2a8cff 0%, transparent 60%), radial-gradient(60% 50% at 55% 90%, #6a3df0 0%, transparent 65%), linear-gradient(180deg, #06202b, #0a0f24)',
  },
  {
    id: 'ember', name: 'Ember',
    css: 'radial-gradient(60% 50% at 30% 75%, #ff6a2b 0%, transparent 60%), radial-gradient(45% 45% at 80% 25%, #ff2d6f 0%, transparent 60%), radial-gradient(50% 50% at 15% 15%, #ffb347 0%, transparent 55%), linear-gradient(200deg, #2b0c14, #120708)',
  },
  {
    id: 'tide', name: 'Tide',
    css: 'radial-gradient(60% 55% at 80% 80%, #00c2d7 0%, transparent 60%), radial-gradient(55% 50% at 20% 25%, #3a6dff 0%, transparent 60%), radial-gradient(40% 40% at 60% 20%, #a5f3fc 0%, transparent 55%), linear-gradient(170deg, #0b2447, #071324)',
  },
  {
    id: 'midnight', name: 'Midnight',
    css: 'radial-gradient(50% 45% at 70% 20%, #3d2a6b 0%, transparent 65%), radial-gradient(55% 50% at 20% 85%, #1d3557 0%, transparent 65%), linear-gradient(180deg, #121218, #08080b)',
  },
];

export const ACCENTS = [
  { id: 'sunset', name: 'Sunset', color: '#f2783c', ink: '#fff' },
  { id: 'rose', name: 'Rose', color: '#f0577e', ink: '#fff' },
  { id: 'violet', name: 'Violet', color: '#9b7bff', ink: '#fff' },
  { id: 'ocean', name: 'Ocean', color: '#3b9eff', ink: '#fff' },
  { id: 'mint', name: 'Mint', color: '#2fd3a0', ink: '#06261c' },
  { id: 'gold', name: 'Gold', color: '#f4b740', ink: '#2b1d02' },
  { id: 'silver', name: 'Silver', color: '#d4d7de', ink: '#16171b' },
];

export function wallpaperStyle(id, custom) {
  if (id === 'custom' && custom) return { backgroundImage: `url("${custom}")` };
  const w = WALLPAPERS.find((x) => x.id === id) || WALLPAPERS[0];
  return w.image ? { backgroundImage: `url("${w.image}")` } : { backgroundImage: w.css };
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

export function applyAccent(id) {
  const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0];
  const root = document.documentElement.style;
  root.setProperty('--accent', a.color);
  root.setProperty('--accent-rgb', hexToRgb(a.color));
  root.setProperty('--accent-ink', a.ink);
}

/** Wallpaper layers that cross-fade when the choice changes. */
export function Wallpaper() {
  const s = useSettings();
  const key = s.wallpaper === 'custom' ? `custom:${s.customWallpaper}` : s.wallpaper;
  const [layers, setLayers] = useState([{ key, style: wallpaperStyle(s.wallpaper, s.customWallpaper) }]);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (layers[layers.length - 1].key === key) return;
    const style = wallpaperStyle(s.wallpaper, s.customWallpaper);
    const url = (style.backgroundImage.match(/^url\("(.+)"\)$/) || [])[1];
    const add = () => setLayers((ls) => [...ls.slice(-1), { key, style, fresh: true }]);
    if (url) { const img = new Image(); img.onload = add; img.onerror = add; img.src = url; } else add();
  }, [key]);

  return html`<div class="wallpaper" aria-hidden="true">
    ${layers.map((l, i) => html`<div key=${l.key} class=${`wallpaper-layer${l.fresh ? ' is-fresh' : ''}`} style=${l.style}
      onAnimationEnd=${() => i === layers.length - 1 && layers.length > 1 && setLayers([{ ...l, fresh: false }])} />`)}
    <div class="wallpaper-grain" />
    <div class="wallpaper-shade" />
  </div>`;
}
