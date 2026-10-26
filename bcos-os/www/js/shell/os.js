// Which app is open, where it was opened from, and what it was asked to do.
// Anything (dock, widgets, search, another app) opens apps through here.

import { useEffect, useReducer } from '../lib/html.js';

export const os = { app: null, intent: null, origin: null, spotlight: false, nonce: 0 };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export function useOS() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { listeners.add(force); return () => listeners.delete(force); }, []);
  return os;
}

const rectOf = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
};

/**
 * Open an app. `from` is the element it should grow out of; without one it
 * grows out of its dock icon. `intent` is passed to the app ({ type, ... }).
 */
export function openApp(id, intent = null, from = null) {
  const wasOpen = os.app;
  os.origin = rectOf(from) || (wasOpen ? os.origin : rectOf(document.querySelector(`[data-dock-app="${id}"] .dock-icon`)));
  os.app = id;
  os.intent = intent;
  os.nonce++;
  os.spotlight = false;
  if (location.hash !== `#/${id}`) history.pushState(null, '', `#/${id}`);
  emit();
}

export function closeApp() {
  if (!os.app) return;
  os.app = null;
  os.intent = null;
  if (location.hash) history.pushState(null, '', location.pathname + location.search);
  emit();
}

/** Open or close search. `seed` is a first character typed on the home screen. */
export function setSpotlight(open, seed = '') {
  os.spotlight = open;
  os.spotlightSeed = open ? seed : '';
  emit();
}

export function appFromHash() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  return m ? m[1] : null;
}

window.addEventListener('popstate', () => {
  const id = appFromHash();
  if (id === os.app) return;
  if (id) { os.app = id; os.intent = null; os.nonce++; }
  else { os.app = null; os.intent = null; }
  emit();
});
