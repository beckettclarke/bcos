// The home screen: greeting, widgets and the app grid.

import { html } from '../lib/html.js';
import { useSettings } from '../lib/store.js';
import { greeting } from '../lib/date.js';
import { BcosMark } from '../ui/icons.js';
import { useTick } from '../ui/components.js';
import { APPS } from './apps.js';
import { openApp } from './os.js';
import { Widget } from './widgets.js';
import { useBadges } from './Taskbar.js';

function AppTile({ app, index, badge }) {
  return html`<button class="app-tile rise" style=${{ '--d': 5 + index * 0.6 }}
    onClick=${(e) => openApp(app.id, null, e.currentTarget.querySelector('.app-icon'))}>
    <span class="app-icon">
      <${app.glyph} size=${64} />
      ${badge > 0 && html`<span class="badge">${badge > 99 ? '99+' : badge}</span>`}
    </span>
    <span class="app-name">${app.name}</span>
  </button>`;
}

export function Desktop() {
  const s = useSettings();
  const badges = useBadges();
  useTick(60000);
  const first = (s.name || '').trim().split(/\s+/)[0];
  return html`<div class="desktop-inner">
    <header class="hero">
      <div class="rise" style=${{ '--d': 0 }}><${BcosMark} size=${70} /></div>
      <h1 class="greeting rise" style=${{ '--d': 1 }}>${greeting()}${first ? `, ${first}` : ''}.</h1>
    </header>
    <section class="widgets" aria-label="Widgets">
      ${s.widgets.slice(0, 3).map((id, i) => html`<div class="rise" key=${id} style=${{ '--d': 2 + i * 0.7 }}><${Widget} id=${id} /></div>`)}
    </section>
    <nav class="app-grid" aria-label="Apps">
      ${APPS.map((app, i) => html`<${AppTile} key=${app.id} app=${app} index=${i} badge=${badges[app.id]} />`)}
    </nav>
  </div>`;
}
