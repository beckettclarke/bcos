// Pointer-driven drag and drop for lists, boards and drop targets.
//
// Mark containers with data-dnd-zone="<id>" and their items with
// data-dnd-id="<id>"; anything with data-dnd-target="<id>" (a sidebar list,
// a folder) also accepts drops. While dragging, the card follows the pointer
// 1:1 from where it was grabbed, neighbours slide apart to show where it will
// land, and on release it springs into its new slot.

import { Spring } from './motion.js';

let active = null;

const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

/**
 * Begin a possible drag from a pointerdown. `onDrop({ id, zone, index, target })`
 * is called on a successful drop; return false from it to animate back.
 * `onClick` runs instead when the pointer never really moved.
 */
export function startDrag(e, { id, el, root = document, onDrop, onClick, handle = false }) {
  if (e.button !== 0 || active) return;
  if (isTouch(e) && !handle) return; // touch drags start from a handle so lists still scroll
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;

  const move = (ev) => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      started = true;
      begin(e, { id, el, root, onDrop });
    }
    ev.preventDefault();
    update(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('keydown', key, true);
    if (!started) { if (ev.type === 'pointerup') onClick?.(ev); return; }
    finish(ev.type === 'pointercancel');
  };
  const key = (ev) => { if (ev.key === 'Escape' && active) { ev.preventDefault(); ev.stopPropagation(); finish(true); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); } };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('keydown', key, true);
}

function begin(e, { id, el, root, onDrop }) {
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.classList.add('dnd-ghost');
  ghost.removeAttribute('data-dnd-id');
  Object.assign(ghost.style, { position: 'fixed', left: '0px', top: '0px', width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', zIndex: '5000', pointerEvents: 'none' });
  document.body.appendChild(ghost);
  requestAnimationFrame(() => ghost.classList.add('is-lifted'));

  const zones = [...root.querySelectorAll('[data-dnd-zone]')].map((z) => ({
    id: z.dataset.dndZone,
    el: z,
    rect: z.getBoundingClientRect(),
    items: [...z.querySelectorAll('[data-dnd-id]')].filter((it) => it.closest('[data-dnd-zone]') === z).map((it) => ({ id: it.dataset.dndId, el: it, rect: it.getBoundingClientRect() })),
  }));
  const targets = [...root.querySelectorAll('[data-dnd-target]')].map((t) => ({ id: t.dataset.dndTarget, el: t, rect: t.getBoundingClientRect() }));
  const source = zones.find((z) => z.items.some((it) => it.id === id));
  const gap = source && source.items.length > 1 ? Math.max(0, source.items[1].rect.top - source.items[0].rect.bottom) : 6;

  el.classList.add('dnd-source');
  document.documentElement.classList.add('dnd-active');

  active = {
    id, el, ghost, onDrop, zones, targets, source,
    from: source ? source.items.findIndex((it) => it.id === id) : -1,
    h: rect.height + gap,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top,
    origin: rect,
    x: rect.left,
    y: rect.top,
    zone: null,
    index: -1,
    target: null,
  };
}

function contains(r, x, y, pad = 0) {
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function update(px, py) {
  const a = active;
  if (!a) return;
  a.x = px - a.grabX;
  a.y = py - a.grabY;
  a.ghost.style.transform = `translate3d(${a.x}px, ${a.y}px, 0)`;

  const target = a.targets.find((t) => contains(t.rect, px, py));
  if (target !== a.target) {
    a.target?.el.classList.remove('is-drop');
    target?.el.classList.add('is-drop');
    a.target = target || null;
  }

  const zone = target ? null : a.zones.find((z) => contains(z.rect, px, py, 24));
  let index = -1;
  if (zone) {
    const others = zone.items.filter((it) => it.id !== a.id);
    index = others.findIndex((it) => py < it.rect.top + it.rect.height / 2);
    if (index < 0) index = others.length;
  }
  if (zone === a.zone && index === a.index) return;
  a.zone = zone || null;
  a.index = index;

  for (const z of a.zones) {
    const others = z.items.filter((it) => it.id !== a.id);
    others.forEach((it, i) => {
      let dy = 0;
      const orig = z.items.indexOf(it);
      if (z === a.source && orig > a.from) dy -= a.h;
      if (z === a.zone && i >= a.index) dy += a.h;
      it.el.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : '';
    });
    z.el.style.paddingBottom = z === a.zone && z !== a.source ? `${a.h}px` : '';
    z.el.classList.toggle('is-drop-zone', z === a.zone);
  }
}

function clearTransforms(a) {
  document.documentElement.classList.add('dnd-settling');
  for (const z of a.zones) {
    z.el.style.paddingBottom = '';
    z.el.classList.remove('is-drop-zone');
    for (const it of z.items) it.el.style.transform = '';
  }
  a.target?.el.classList.remove('is-drop');
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('dnd-settling')));
}

async function finish(cancelled) {
  const a = active;
  if (!a) return;
  active = null;
  document.documentElement.classList.remove('dnd-active');

  let accepted = false;
  if (!cancelled && (a.target || a.zone)) {
    clearTransforms(a);
    accepted = a.onDrop?.({ id: a.id, zone: a.zone?.id ?? null, index: a.index, target: a.target?.id ?? null }) !== false;
  } else {
    clearTransforms(a);
  }
  // Let the re-render land, then fly the ghost to wherever the item now lives.
  await Promise.resolve();
  await new Promise((r) => requestAnimationFrame(r));

  let dest = a.origin;
  let vanish = false;
  if (accepted && a.target) { dest = a.target.el.getBoundingClientRect(); vanish = true; }
  else if (accepted) {
    const now = document.querySelector(`[data-dnd-id="${CSS.escape(a.id)}"]`);
    if (now) dest = now.getBoundingClientRect();
  }

  const ghost = a.ghost;
  ghost.classList.remove('is-lifted');
  if (vanish) ghost.classList.add('is-vanishing');
  const tx = vanish ? dest.left + dest.width / 2 - a.origin.width / 2 : dest.left;
  const ty = vanish ? dest.top + dest.height / 2 - a.origin.height / 2 : dest.top;
  let done = 0;
  const end = () => {
    if (++done < 2) return;
    ghost.remove();
    document.querySelectorAll('.dnd-source').forEach((n) => n.classList.remove('dnd-source'));
  };
  const sx = new Spring(a.x, { response: 0.32, damping: 0.86, precision: 0.3, onRest: end });
  const sy = new Spring(a.y, { response: 0.32, damping: 0.86, precision: 0.3, onRest: end });
  const paint = () => { ghost.style.transform = `translate3d(${sx.value}px, ${sy.value}px, 0)${vanish ? ' scale(0.4)' : ''}`; };
  sx.onUpdate = paint;
  sy.onUpdate = paint;
  sx.to(tx);
  sy.to(ty);
}

/** Order value that puts an item at `index` among `ordered` (sorted, without it). */
export function orderAt(ordered, index, key = 'order') {
  const before = ordered[index - 1]?.[key];
  const after = ordered[index]?.[key];
  if (before == null && after == null) return Date.now();
  if (before == null) return after - 1024;
  if (after == null) return before + 1024;
  return (before + after) / 2;
}
