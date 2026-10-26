// The root: wallpaper, home screen, app windows, taskbar, search and layers.

import { html, useEffect } from '../lib/html.js';
import { useSettings } from '../lib/store.js';
import { setClock24 } from '../lib/date.js';
import { setReducedMotion } from '../lib/motion.js';
import { isTyping } from '../lib/util.js';
import { MenuHost, DialogHost, Toaster } from '../ui/components.js';
import { Wallpaper, applyAccent } from './theme.js';
import { Desktop } from './Desktop.js';
import { Taskbar } from './Taskbar.js';
import { Windows } from './Windows.js';
import { Spotlight } from './Spotlight.js';
import { useOS, setSpotlight, setStart, openApp } from './os.js';

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
      // Ctrl+Esc opens Start, like Windows.
      if (e.ctrlKey && e.key === 'Escape') { e.preventDefault(); setStart(!state.start); return; }
      if (!state.app && !state.spotlight && !isTyping(e) && !mod && (e.key === '/' || (e.key.length === 1 && /\S/.test(e.key) && !e.altKey))) {
        // Typing on the home screen starts a search, like Spotlight.
        e.preventDefault();
        setSpotlight(true, e.key === '/' ? '' : e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.spotlight, state.app, state.start]);

  return html`
    <${Wallpaper} />
    <main id="desktop" class="desktop"><${Desktop} /></main>
    <${Windows} />
    <${Taskbar} />
    <${Spotlight} />
    <${MenuHost} />
    <${DialogHost} />
    <${Toaster} />`;
}
