// App windows. Every running app keeps a fullscreen window mounted (so its
// state survives switching away); only the one in front is shown. A window
// grows out of whatever opened it and shrinks back into its taskbar button
// when minimised.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { useOS, minimizeApp, closeApp, os } from './os.js';
import { appById, APPS } from './apps.js';
import { Icon } from '../ui/icons.js';
import { useEscape } from '../ui/components.js';

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

/** The transform that puts the window over `rect` (a taskbar button, a tile). */
function shrunkTo(el, rect) {
  if (!rect) return 'translate3d(0, 24px, 0) scale(0.96)';
  const r = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - (r.left + r.width / 2);
  const y = rect.top + rect.height / 2 - (r.top + r.height / 2);
  const s = Math.max(0.08, Math.min(0.4, rect.width / r.width));
  return `translate3d(${x}px, ${y}px, 0) scale(${s})`;
}

function AppWindow({ id, front, intent, nonce }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(front);
  const anim = useRef(null);
  const app = appById(id);
  // Background windows keep the last intent they were given, so switching
  // apps never re-runs another app's intent.
  const last = useRef({ intent, nonce });
  if (front) last.current = { intent, nonce };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    anim.current?.cancel();
    const reduced = reducedMotion();
    if (front) {
      setVisible(true);
      el.style.visibility = 'visible';
      const from = reduced ? 'none' : shrunkTo(el, os.origin);
      anim.current = el.animate(
        [{ transform: from, opacity: 0, borderRadius: '28px' }, { transform: 'none', opacity: 1, borderRadius: '0px' }],
        { duration: reduced ? 160 : 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
      requestAnimationFrame(() => el.focus({ preventScroll: true }));
    } else if (visible) {
      // Minimised: shrink into the taskbar. Switched away: stay put under the
      // window coming in, then hide.
      const minimized = !os.app;
      const to = reduced || !minimized ? 'none' : shrunkTo(el, os.origin);
      anim.current = el.animate(
        [{ transform: 'none', opacity: 1 }, { transform: to, opacity: minimized ? 0 : 1, borderRadius: minimized ? '28px' : '0px' }],
        { duration: reduced ? 140 : minimized ? 300 : 380, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
      );
      anim.current.onfinish = () => {
        el.style.visibility = 'hidden';
        anim.current?.cancel();
        setVisible(false);
      };
    }
  }, [front, front && nonce]);

  return html`<section class=${`appwin${front ? ' is-front' : ''}`} ref=${ref} tabindex="-1" role="region" aria-label=${app?.name}
    aria-hidden=${front ? undefined : 'true'} inert=${!front} style=${{ visibility: front || visible ? 'visible' : 'hidden', zIndex: front ? 41 : 40 }}>
    <header class="appwin-caption" onDblClick=${(e) => { if (!e.target.closest('button')) minimizeApp(); }}>
      <span class="appwin-title"><${app.glyph} size=${18} />${app.name}</span>
      <div class="appwin-controls">
        <button class="appwin-btn" onClick=${minimizeApp} aria-label="Minimise" title="Minimise"><${Icon} name="minus" size=${16} /></button>
        <button class="appwin-btn is-close" onClick=${() => closeApp(id)} aria-label=${`Close ${app.name}`} title="Close"><${Icon} name="x" size=${16} /></button>
      </div>
    </header>
    <div class="appwin-body" data-app=${id}>
      <${AppHost} id=${id} intent=${last.current.intent} nonce=${last.current.nonce} />
    </div>
  </section>`;
}

export function Windows() {
  const state = useOS();
  useEscape(minimizeApp, !!state.app);

  // The home screen goes inert (and stops painting) under a fullscreen app.
  useEffect(() => {
    const desk = document.getElementById('desktop');
    if (desk) desk.inert = !!state.app;
    document.documentElement.classList.toggle('app-open', !!state.app);
  }, [state.app]);

  return html`<div class="windows">
    ${state.running.map((id) => html`<${AppWindow} key=${id} id=${id} front=${state.app === id}
      intent=${state.app === id ? state.intent : null} nonce=${state.nonce} />`)}
  </div>`;
}
