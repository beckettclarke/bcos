// The app window. It grows out of the icon that opened it, pushes the desktop
// back, and can be pulled down to dismiss. Open/close/drag all run on springs
// that start from wherever the sheet is right now, so any of them can be
// interrupted — tap the icon again mid-close and it simply turns around.

import { html, useEffect, useRef, useState } from '../lib/html.js';
import { Spring, VelocityTracker, project, rubberband, reducedMotion } from '../lib/motion.js';
import { useOS, closeApp, os } from './os.js';
import { appById, APPS } from './apps.js';
import { useEscape, useNarrow } from '../ui/components.js';
import { Icon } from '../ui/icons.js';

const loaded = new Map();

/** Fetch the app modules in the background so first opens are instant. */
export function preloadApps() {
  for (const app of APPS) {
    if (loaded.has(app.id)) continue;
    app.load().then((m) => loaded.set(app.id, m.default)).catch(() => {});
  }
}

function AppHost({ id, intent, nonce }) {
  const [Comp, setComp] = useState(() => loaded.get(id) || null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (Comp) return;
    appById(id)?.load()
      .then((m) => { loaded.set(id, m.default); setComp(() => m.default); })
      .catch((err) => { console.error(err); setError(err); });
  }, [id]);
  if (error) return html`<div class="app-loading"><${Icon} name="alert" size=${22} /><span>${appById(id)?.name} couldn’t load. Try reloading.</span></div>`;
  if (!Comp) return html`<div class="app-loading"><span class="spinner" /></div>`;
  return html`<${Comp} intent=${intent} nonce=${nonce} />`;
}

const NO_DRAG = 'button, a, input, textarea, select, label, [contenteditable="true"], [data-nodrag], .segmented, .popover';

export function Sheet() {
  const state = useOS();
  const narrow = useNarrow();
  const [shown, setShown] = useState(state.app);
  const sheetRef = useRef(null);
  const scrimRef = useRef(null);
  const anim = useRef(null);
  if (!anim.current) {
    anim.current = {
      p: new Spring(0, { response: 0.44, damping: 1, precision: 0.0004 }),
      y: new Spring(0, { response: 0.36, damping: 1, precision: 0.2 }),
      from: { x: 0, y: 0, s: 0.94 },
      height: 800,
      tracker: new VelocityTracker(),
    };
  }

  const apply = () => {
    const el = sheetRef.current;
    const scrim = scrimRef.current;
    if (!el || !scrim) return;
    const a = anim.current;
    const p = a.p.value;
    const y = a.y.value;
    const reduced = reducedMotion();
    const o = a.from;
    const s = reduced ? 1 : o.s + (1 - o.s) * p;
    const tx = reduced ? 0 : o.x * (1 - p);
    const ty = reduced ? 0 : o.y * (1 - p) + y;
    const shrink = 1 - Math.min(Math.max(y, 0), 900) / 6000;
    const settled = p >= 0.9999 && Math.abs(y) < 0.5;
    el.style.transform = settled ? '' : `translate3d(${tx}px, ${ty}px, 0) scale(${s * shrink})`;
    el.style.opacity = String(Math.min(1, p * 2.4));
    el.style.visibility = p < 0.002 ? 'hidden' : 'visible';
    el.classList.toggle('is-animating', !settled);
    const back = p * (1 - Math.min(1, Math.max(0, y) / a.height));
    scrim.style.opacity = String(back);
    scrim.style.visibility = back < 0.002 ? 'hidden' : 'visible';
    const desk = document.getElementById('desktop');
    if (desk) {
      desk.style.transform = back > 0.002 && !reduced ? `scale(${1 - 0.055 * back}) translateZ(0)` : '';
      desk.style.opacity = back > 0.002 ? String(1 - 0.55 * back) : '';
      desk.inert = back > 0.5;
    }
    document.documentElement.classList.toggle('app-open', back > 0.5);
  };

  const originFor = (rect) => {
    const el = sheetRef.current;
    const prev = el.style.transform;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = prev;
    anim.current.height = r.height;
    if (!rect) return { x: 0, y: r.height * 0.1, s: 0.93 };
    return {
      x: rect.left + rect.width / 2 - (r.left + r.width / 2),
      y: rect.top + rect.height / 2 - (r.top + r.height / 2),
      s: Math.max(0.12, Math.min(0.5, rect.width / r.width)),
    };
  };

  useEffect(() => {
    const a = anim.current;
    a.p.onUpdate = apply;
    a.y.onUpdate = apply;
    apply();
  }, []);

  useEffect(() => {
    const a = anim.current;
    if (state.app) {
      const opening = a.p.target === 0;
      setShown(state.app);
      if (opening) {
        a.p.onRest = null;
        if (a.p.value < 0.02) { a.from = originFor(state.origin); a.y.set(0); }
        a.p.to(1, { response: 0.46, damping: 1 });
        requestAnimationFrame(() => sheetRef.current?.focus({ preventScroll: true }));
      }
    } else if (a.p.target !== 0) {
      a.p.onRest = () => { if (!os.app) { setShown(null); a.y.set(0); } };
      a.p.to(0, { response: 0.36, damping: 1 });
    }
  }, [state.app, state.nonce]);

  useEscape(closeApp, !!state.app);

  const onPointerDown = (e) => {
    if (e.button !== 0 || !state.app) return;
    const el = sheetRef.current;
    const r = el.getBoundingClientRect();
    if (e.clientY - r.top > (narrow ? 64 : 58) || e.target.closest(NO_DRAG)) return;
    const a = anim.current;
    a.height = r.height;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseY = a.y.value;
    let dragging = false;
    a.tracker.reset();
    a.tracker.add(e.clientX, e.clientY);

    const move = (ev) => {
      const dy = ev.clientY - startY;
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dy) < 6 || Math.abs(dy) < Math.abs(dx)) return;
        dragging = true;
        a.y.stop();
        el.classList.add('is-dragging');
      }
      ev.preventDefault();
      a.tracker.add(ev.clientX, ev.clientY);
      const raw = baseY + dy;
      a.y.set(raw >= 0 ? raw : rubberband(raw, a.height));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      el.classList.remove('is-dragging');
      const v = a.tracker.velocity().y;
      const resting = a.y.value + project(v, 0.99);
      if (resting > Math.min(260, a.height * 0.3) && v > -150) {
        // Leave the way it was thrown: keep going down, then fade.
        a.from = { x: 0, y: 0, s: 0.97 };
        a.y.to(a.height * 0.85, { velocity: v, response: 0.42, damping: 1 });
        closeApp();
      } else {
        a.y.to(0, { velocity: v, response: 0.34, damping: 0.84 });
      }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const app = shown && appById(shown);
  return html`
    <div class="sheet-scrim" ref=${scrimRef} onPointerDown=${closeApp} />
    <div class="sheet" ref=${sheetRef} role="dialog" aria-modal="true" aria-label=${app?.name} tabindex="-1" onPointerDown=${onPointerDown}>
      <div class="sheet-grabber" aria-hidden="true" />
      <button class="sheet-close" onClick=${closeApp} aria-label="Close ${app?.name || ''}" title="Close (Esc)">
        <${Icon} name="x" size=${15} stroke=${2.2} />
      </button>
      ${shown && html`<div class="sheet-content" key=${shown} data-app=${shown}>
        <${AppHost} id=${shown} intent=${state.app === shown ? state.intent : null} nonce=${state.nonce} />
      </div>`}
    </div>`;
}
