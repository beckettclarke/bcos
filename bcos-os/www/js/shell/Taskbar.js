// The taskbar: Start, search, pinned and running apps in the middle, and the
// tray (sync status, clock) on the right, with a "show desktop" sliver at the
// far edge — the way Windows does it.

import { html, useMemo, useRef } from '../lib/html.js';
import { useSettings, useCollection, useStatus } from '../lib/store.js';
import { todayKey, fmt, fmtTime, greeting } from '../lib/date.js';
import { cx, modKey } from '../lib/util.js';
import { Icon, BcosMark } from '../ui/icons.js';
import { Popover, Avatar, useTick, openContextMenu } from '../ui/components.js';
import { APPS, appById } from './apps.js';
import { useOS, openApp, toggleApp, closeApp, minimizeApp, setSpotlight, setStart } from './os.js';

const PINNED = ['calendar', 'tasks', 'notes', 'journal', 'mail', 'settings'];

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

function TaskButton({ id, state, badge }) {
  const app = appById(id);
  const running = state.running.includes(id);
  const front = state.app === id;
  const menu = (e) => openContextMenu(e, [
    { label: app.name, icon: 'arrow-up', onSelect: () => openApp(id) },
    running && { label: front ? 'Minimise' : 'Show', icon: 'minus', onSelect: () => (front ? minimizeApp() : openApp(id)) },
    running && { divider: true },
    running && { label: 'Close window', icon: 'x', danger: true, onSelect: () => closeApp(id) },
  ].filter(Boolean));
  return html`<button class=${cx('tb-app', running && 'is-running', front && 'is-front')} data-dock-app=${id}
    aria-label=${app.name} aria-pressed=${front ? 'true' : 'false'} title=${app.name}
    onClick=${(e) => toggleApp(id, e.currentTarget)} onContextMenu=${menu}
    onAuxClick=${(e) => { if (e.button === 1 && running) closeApp(id); }}>
    <${app.glyph} size=${26} />
    ${badge > 0 && html`<span class="badge">${badge > 99 ? '99+' : badge}</span>`}
    <span class="tb-indicator" />
  </button>`;
}

function StartMenu({ anchor, badges }) {
  const s = useSettings();
  const first = (s.name || '').trim().split(/\s+/)[0];
  return html`<${Popover} anchor=${anchor} onClose=${() => setStart(false)} placement="top-start" offset=${12} class="start-menu" label="Start">
    <button class="start-search" onClick=${() => setSpotlight(true)}>
      <${Icon} name="search" size=${16} /><span>Search apps, notes, tasks…</span><kbd>${modKey}K</kbd>
    </button>
    <div class="start-head">Apps</div>
    <div class="start-grid">
      ${APPS.map((app) => html`<button key=${app.id} class="start-app" onClick=${(e) => openApp(app.id, null, e.currentTarget.querySelector('.app-glyph'))}>
        <span class="start-app-icon"><${app.glyph} size=${40} />${badges[app.id] > 0 && html`<span class="badge">${badges[app.id]}</span>`}</span>
        <span>${app.name}</span>
      </button>`)}
    </div>
    <footer class="start-foot">
      <span class="start-user"><${Avatar} name=${s.name || 'You'} size=${30} /><span>${greeting()}${first ? `, ${first}` : ''}</span></span>
      <button class="start-power" onClick=${() => openApp('settings')} title="Settings" aria-label="Settings"><${Icon} name="settings" size=${17} /></button>
    </footer>
  </${Popover}>`;
}

function Tray() {
  useTick(15000);
  const st = useStatus();
  const now = new Date();
  let icon = 'cloud-check', label = 'Synced to your Umbrel', tone = '';
  if (st.mode === 'local') { icon = 'database'; label = 'Saved in this browser only'; tone = 'muted'; }
  else if (st.authLost) { icon = 'lock'; label = 'Signed out of Umbrel — reload to sign in'; tone = 'warn'; }
  else if (!st.online) { icon = 'cloud-off'; label = 'Offline — changes will sync when the Umbrel is back'; tone = 'warn'; }
  else if (st.syncing) { icon = 'cloud'; label = 'Syncing…'; }
  return html`<div class="tb-tray">
    <span class=${cx('tb-sync', tone && `is-${tone}`)} title=${label} aria-label=${label}><${Icon} name=${icon} size=${16} /></span>
    <button class="tb-clock" onClick=${() => openApp('calendar')} title=${fmt(now, 'weekdayMonthDay')}>
      <b>${fmtTime(now)}</b><span>${now.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' })}</span>
    </button>
    <button class="tb-desktop" onClick=${minimizeApp} aria-label="Show desktop" title="Show desktop" />
  </div>`;
}

export function Taskbar() {
  const state = useOS();
  const badges = useBadges();
  const startRef = useRef(null);
  // Pinned apps first, then anything running that isn't pinned.
  const items = [...PINNED, ...state.running.filter((id) => !PINNED.includes(id))];

  return html`<nav class="taskbar" aria-label="Taskbar">
    <div class="tb-center">
      <button ref=${startRef} class=${cx('tb-start', state.start && 'is-open')} aria-label="Start" aria-expanded=${state.start ? 'true' : 'false'}
        onClick=${() => setStart(!state.start)}>
        <${BcosMark} size=${26} />
      </button>
      <button class="tb-search" onClick=${() => setSpotlight(true)} aria-label="Search">
        <${Icon} name="search" size=${16} /><span>Search</span>
      </button>
      ${items.map((id) => html`<${TaskButton} key=${id} id=${id} state=${state} badge=${badges[id]} />`)}
    </div>
    <${Tray} />
    ${state.start && startRef.current && html`<${StartMenu} anchor=${startRef.current} badges=${badges} />`}
  </nav>`;
}
