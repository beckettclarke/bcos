// The home screen: greeting, widgets, app grid, the search pill and status.

import { html, useMemo } from '../lib/html.js';
import { useSettings, useCollection, useStatus } from '../lib/store.js';
import { greeting, todayKey, fmt, fmtTime } from '../lib/date.js';
import { cx, modKey } from '../lib/util.js';
import { Icon, BcosMark } from '../ui/icons.js';
import { useTick } from '../ui/components.js';
import { APPS } from './apps.js';
import { openApp, setSpotlight } from './os.js';
import { Widget } from './widgets.js';

export function useBadges() {
  const mail = useCollection('mail');
  const tasks = useCollection('tasks');
  return useMemo(() => {
    const today = todayKey();
    return {
      mail: mail.filter((m) => m.mailbox === 'inbox' && !m.read).length,
      tasks: tasks.filter((t) => !t.done && t.due && t.due <= today).length,
    };
  }, [mail, tasks]);
}

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

export function SearchPill() {
  return html`<button class="search-pill rise" style=${{ '--d': 9 }} onClick=${() => setSpotlight(true)} aria-label="Search">
    <span class="search-pill-orb" />
    <span>Search</span>
    <kbd>${modKey}K</kbd>
  </button>`;
}

export function StatusBar() {
  useTick(15000);
  const st = useStatus();
  const now = new Date();
  let icon = 'cloud-check', label = 'Synced to your Umbrel', tone = '';
  if (st.mode === 'local') { icon = 'database'; label = 'Saved in this browser only'; tone = 'muted'; }
  else if (st.authLost) { icon = 'lock'; label = 'Signed out of Umbrel — reload to sign in'; tone = 'warn'; }
  else if (!st.online) { icon = 'cloud-off'; label = 'Offline — changes will sync when the Umbrel is back'; tone = 'warn'; }
  else if (st.syncing) { icon = 'cloud'; label = 'Syncing…'; }
  return html`<div class="statusbar">
    <span class=${cx('status-sync', tone && `is-${tone}`)} title=${label} aria-label=${label}><${Icon} name=${icon} size=${15} /></span>
    <span class="status-clock">${fmt(now, 'weekdayMonthDay')}<b>${fmtTime(now)}</b></span>
  </div>`;
}
