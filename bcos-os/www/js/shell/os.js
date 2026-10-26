// Which apps are running, which one is in front, where it was opened from,
// and what it was asked to do. Anything (taskbar, widgets, search, another
// app) opens apps through here.
//
// Like a desktop OS, apps keep running when you switch away: `running` is the
// taskbar order, `app` is the one on screen (null shows the home screen).

import { useEffect, useReducer } from '../lib/html.js';

export const os = { app: null, running: [], intent: null, origin: null, spotlight: false, start: false, nonce: 0 };
const listeners = new Set();
let version = 0;
const emit = () => { version++; listeners.forEach((fn) => fn()); };

export function useOS() {
  const [, force] = useReducer((x) => x + 1, 0);
  const seen = version;
  useEffect(() => {
    listeners.add(force);
    // Catch up on anything that changed between render and subscribing
    // (e.g. a back/forward navigation while BCOS was still booting).
    if (version !== seen) force();
    return () => listeners.delete(force);
  }, []);
  return os;
}

const rectOf = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
};

function syncHash() {
  const want = os.app ? `#/${os.app}` : '';
  if (location.hash === want) return;
  if (want) history.pushState(null, '', want);
  else history.pushState(null, '', location.pathname + location.search);
}

/**
 * Open (or bring to front) an app. `from` is the element it should grow out
 * of; without one it grows out of its taskbar button. `intent` is passed to
 * the app ({ type, ... }).
 */
export function openApp(id, intent = null, from = null) {
  os.origin = rectOf(from) || rectOf(document.querySelector(`[data-dock-app="${id}"]`));
  if (!os.running.includes(id)) os.running = [...os.running, id];
  os.app = id;
  os.intent = intent;
  os.nonce++;
  os.spotlight = false;
  os.start = false;
  syncHash();
  emit();
}

/** Send the front app to the taskbar and show the home screen. */
export function minimizeApp() {
  if (!os.app) return;
  os.origin = rectOf(document.querySelector(`[data-dock-app="${os.app}"]`));
  os.app = null;
  os.intent = null;
  syncHash();
  emit();
}

/** Quit an app (the front one by default). */
export function closeApp(id = os.app) {
  if (!id) return;
  os.running = os.running.filter((x) => x !== id);
  if (os.app === id) { os.app = null; os.intent = null; }
  syncHash();
  emit();
}

/** Taskbar click: open, bring forward, or minimise if already in front. */
export function toggleApp(id, from) {
  if (os.app === id) minimizeApp();
  else openApp(id, null, from);
}

/** Open or close search. `seed` is a first character typed on the home screen. */
export function setSpotlight(open, seed = '') {
  os.spotlight = open;
  os.spotlightSeed = open ? seed : '';
  if (open) os.start = false;
  emit();
}

export function setStart(open) {
  os.start = open;
  if (open) os.spotlight = false;
  emit();
}

export function appFromHash() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  return m ? m[1] : null;
}

window.addEventListener('popstate', () => {
  const id = appFromHash();
  if (id === os.app) return;
  if (id) {
    if (!os.running.includes(id)) os.running = [...os.running, id];
    os.app = id; os.intent = null; os.nonce++;
  } else { os.app = null; os.intent = null; }
  emit();
});
