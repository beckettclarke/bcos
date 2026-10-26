// The root: wallpaper, home screen, the app sheet, dock, search and layers.

import { html, useEffect } from '../lib/html.js';
import { useSettings } from '../lib/store.js';
import { setClock24 } from '../lib/date.js';
import { setReducedMotion } from '../lib/motion.js';
import { isTyping } from '../lib/util.js';
import { MenuHost, DialogHost, Toaster } from '../ui/components.js';
import { Wallpaper, applyAccent } from './theme.js';
import { Desktop, SearchPill, StatusBar } from './Desktop.js';
import { Dock } from './Dock.js';
import { Sheet } from './Sheet.js';
import { Spotlight } from './Spotlight.js';
import { useOS, setSpotlight, openApp } from './os.js';

export function App() {
  const s = useSettings();
  const state = useOS();

  setClock24(s.use24h);
  useEffect(() => applyAccent(s.accent), [s.accent]);
  useEffect(() => setReducedMotion(s.reduceMotion), [s.reduceMotion]);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setSpotlight(!state.spotlight); return; }
      if (mod && e.key === ',') { e.preventDefault(); openApp('settings'); return; }
      if (!state.app && !state.spotlight && !isTyping(e) && !mod && (e.key === '/' || (e.key.length === 1 && /\S/.test(e.key) && !e.altKey))) {
        // Typing on the home screen starts a search, like Spotlight.
        e.preventDefault();
        setSpotlight(true, e.key === '/' ? '' : e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.spotlight, state.app]);

  return html`
    <${Wallpaper} />
    <main id="desktop" class="desktop"><${Desktop} /></main>
    <${StatusBar} />
    <${SearchPill} />
    <${Sheet} />
    <${Dock} />
    <${Spotlight} />
    <${MenuHost} />
    <${DialogHost} />
    <${Toaster} />`;
}
