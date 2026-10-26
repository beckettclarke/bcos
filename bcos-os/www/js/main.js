// Boot: paint from the local cache, connect to the Umbrel, then render.

import { html, render } from './lib/html.js';
import { boot } from './lib/store.js';
import { seed } from './lib/seed.js';
import { refreshStaleFeeds } from './lib/feeds.js';
import { App } from './shell/App.js';
import { preloadApps } from './shell/Windows.js';
import { appFromHash, openApp } from './shell/os.js';
import { appById } from './shell/apps.js';

async function start() {
  await boot({ seed });
  render(html`<${App} />`, document.getElementById('root'));
  document.documentElement.classList.add('is-booted');
  document.getElementById('boot')?.addEventListener('transitionend', (e) => e.target.remove(), { once: true });

  const initial = appFromHash();
  if (initial && appById(initial)) setTimeout(() => openApp(initial), 450);

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  idle(() => { preloadApps(); refreshStaleFeeds(); });
}

start();
