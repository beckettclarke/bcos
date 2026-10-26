// The dock. Icons magnify under the pointer on springs; neighbours slide
// apart with transforms only, so the layout never moves under the cursor.

import { html, useEffect, useRef } from '../lib/html.js';
import { Spring } from '../lib/motion.js';
import { cx } from '../lib/util.js';
import { useOS, openApp, closeApp } from './os.js';
import { appById } from './apps.js';
import { useBadges } from './Desktop.js';

const ITEMS = ['calendar', 'tasks', 'notes', 'journal', 'mail', '|', 'settings'];
const BASE = 50;      // icon size at rest
const GAP = 10;
const MAX = 0.36;     // extra scale at the pointer
const RANGE = 150;    // px either side that feel the pull

export function Dock() {
  const state = useOS();
  const badges = useBadges();
  const dockRef = useRef(null);
  const bgRef = useRef(null);
  const springs = useRef(null);
  const raf = useRef(0);

  if (!springs.current) {
    springs.current = ITEMS.map(() => new Spring(1, { response: 0.26, damping: 0.92, precision: 0.0005 }));
  }

  const write = () => {
    raf.current = 0;
    const dock = dockRef.current;
    if (!dock) return;
    const els = dock.querySelectorAll('.dock-item, .dock-divider');
    const extra = springs.current.map((s, i) => (ITEMS[i] === '|' ? 0 : (s.value - 1) * BASE));
    const total = extra.reduce((a, b) => a + b, 0);
    let run = 0;
    els.forEach((el, i) => {
      const shift = run + extra[i] / 2 - total / 2;
      run += extra[i];
      el.style.transform = `translateX(${shift.toFixed(2)}px)`;
      el.style.setProperty('--s', springs.current[i].value.toFixed(4));
    });
    if (bgRef.current) bgRef.current.style.inset = `0 ${(-total / 2).toFixed(2)}px`;
  };
  const schedule = () => { if (!raf.current) raf.current = requestAnimationFrame(write); };

  useEffect(() => {
    springs.current.forEach((s) => { s.onUpdate = schedule; });
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const centers = useRef([]);
  const measure = () => {
    const dock = dockRef.current;
    const els = [...dock.querySelectorAll('.dock-item, .dock-divider')];
    // Rest positions, ignoring the transforms we add.
    centers.current = els.map((el) => el.offsetLeft + el.offsetWidth / 2 + dock.getBoundingClientRect().left);
  };

  const onMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (!centers.current.length) measure();
    springs.current.forEach((s, i) => {
      if (ITEMS[i] === '|') return;
      const d = Math.abs(e.clientX - centers.current[i]);
      const pull = d < RANGE ? (Math.cos((Math.PI * d) / RANGE) + 1) / 2 : 0;
      s.to(1 + MAX * pull);
    });
  };
  const onLeave = () => {
    centers.current = [];
    springs.current.forEach((s) => s.to(1));
  };

  return html`<nav class="dock rise" style=${{ '--d': 8 }} ref=${dockRef} onPointerMove=${onMove} onPointerEnter=${measure} onPointerLeave=${onLeave} aria-label="Dock">
    <div class="dock-bg" ref=${bgRef} />
    ${ITEMS.map((id, i) => {
      if (id === '|') return html`<div class="dock-divider" key=${`d${i}`} />`;
      const app = appById(id);
      const open = state.app === id;
      const badge = badges[id];
      return html`<div class="dock-item" key=${id} data-dock-app=${id}>
        <button class=${cx('dock-icon', open && 'is-open')} aria-label=${app.name} aria-current=${open ? 'true' : undefined}
          onClick=${(e) => (open ? closeApp() : openApp(id, null, state.app ? null : e.currentTarget))}>
          <${app.glyph} size=${BASE} />
          ${badge > 0 && html`<span class="badge">${badge > 99 ? '99+' : badge}</span>`}
        </button>
        <span class="dock-tip">${app.name}</span>
        <span class=${cx('dock-dot', open && 'is-on')} />
      </div>`;
    })}
  </nav>`;
}

export const DOCK_SIZE = { BASE, GAP };
