// Settings — modelled on umbrelOS: a device card on the left, grouped rows
// on the right, with tabs and search.

import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { useSettings, setSettings, useStatus, serverInfo, exportAll, importAll, resetAll, uploadImage, status } from '../lib/store.js';
import { cx, formatBytes, formatDuration, download, pickFile, downscaleImage, modKey } from '../lib/util.js';
import { Icon, BcosMark } from '../ui/icons.js';
import { Segmented, Toggle, Avatar, confirm, toast, useNarrow } from '../ui/components.js';
import { WALLPAPERS, ACCENTS, wallpaperStyle } from '../shell/theme.js';
import { WIDGETS } from '../shell/widgets.js';
import { APPS } from '../shell/apps.js';
import AISettings from './settings-ai.js';
import { presets } from '../lib/ai.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'apps', label: 'Apps' },
  { id: 'ai', label: 'AI' },
  { id: 'data', label: 'Data' },
];

const SHORTCUTS = [
  ['Search everything', `${modKey} K`],
  ['Open Settings', `${modKey} ,`],
  ['Minimise the app', 'Esc'],
  ['Start menu', 'Ctrl Esc'],
  ['Calendar: today / day / week / month', 'T · D · W · M'],
  ['Calendar: new event', 'N'],
  ['Tasks: new task / complete', 'N · Space'],
  ['Notes: new note / search / focus', `${modKey}N · ${modKey}F · ${modKey}⇧F`],
  ['Notes: blocks / link a note', '/ · [['],
  ['Mail: compose / reply / archive', 'C · R · E'],
  ['Journal: previous / next day', '← · →'],
];

export default function SettingsApp({ intent, nonce }) {
  const s = useSettings();
  const st = useStatus();
  const narrow = useNarrow();
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [info, setInfo] = useState(null);
  const [nameDraft, setNameDraft] = useState(s.name);

  useEffect(() => {
    let alive = true;
    const load = () => serverInfo().then((i) => alive && setInfo(i));
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => { if (intent?.section) setTab(intent.section); }, [nonce]);
  useEffect(() => { setNameDraft(s.name); }, [s.name]);

  const uploadWallpaper = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const blob = await downscaleImage(file, 2880, 0.88);
      const url = await uploadImage(blob, 'wallpaper');
      setSettings({ wallpaper: 'custom', customWallpaper: url });
      toast('Wallpaper updated', { icon: 'image' });
    } catch {
      toast('That image couldn’t be used', { icon: 'alert' });
    }
  };

  const rows = [
    {
      id: 'name', tab: 'account', icon: 'user', title: 'Your name', desc: 'Used in the greeting on your home screen',
      control: html`<input class="field field-sm settings-name" value=${nameDraft} onInput=${(e) => setNameDraft(e.target.value)}
        onBlur=${() => nameDraft.trim() !== s.name && setSettings({ name: nameDraft.trim() })} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} />`,
    },
    {
      id: 'wallpaper', tab: 'appearance', icon: 'image', title: 'Wallpaper', desc: 'Your BCOS wallpaper and theme', wide: true,
      control: html`<div class="wall-picker">
        ${WALLPAPERS.map((w) => html`<button key=${w.id} class=${cx('wall-thumb', s.wallpaper === w.id && 'is-on')} style=${wallpaperStyle(w.id)} title=${w.name} aria-label=${w.name} onClick=${() => setSettings({ wallpaper: w.id })} />`)}
        ${s.customWallpaper && html`<button class=${cx('wall-thumb', s.wallpaper === 'custom' && 'is-on')} style=${wallpaperStyle('custom', s.customWallpaper)} title="Your photo" onClick=${() => setSettings({ wallpaper: 'custom' })} />`}
        ${st.mode === 'server' && html`<button class="wall-thumb is-add" title="Upload a photo" aria-label="Upload a photo" onClick=${uploadWallpaper}><${Icon} name="plus" size=${16} /></button>`}
      </div>`,
    },
    {
      id: 'accent', tab: 'appearance', icon: 'palette', title: 'Accent colour', desc: 'Buttons, highlights and selection',
      control: html`<div class="accent-picker">${ACCENTS.map((a) => html`<button key=${a.id} class=${cx('accent-dot', s.accent === a.id && 'is-on')} style=${{ '--c': a.color }} title=${a.name} aria-label=${a.name} onClick=${() => setSettings({ accent: a.id })} />`)}</div>`,
    },
    {
      id: 'widgets', tab: 'appearance', icon: 'grid', title: 'Widgets', desc: 'Pick up to three for your home screen', wide: true,
      control: html`<div class="widget-picker">
        ${WIDGETS.map((w) => {
          const on = s.widgets.includes(w.id);
          const idx = s.widgets.indexOf(w.id);
          return html`<button key=${w.id} class=${cx('widget-choice', on && 'is-on')} onClick=${() => {
            const next = on ? s.widgets.filter((x) => x !== w.id) : [...s.widgets, w.id].slice(-3);
            setSettings({ widgets: next });
          }}>
            <span class="widget-choice-check">${on ? idx + 1 : ''}</span>
            <span class="widget-choice-name">${w.name}</span>
            <span class="widget-choice-desc">${w.desc}</span>
          </button>`;
        })}
      </div>`,
    },
    {
      id: 'motion', tab: 'appearance', icon: 'sparkle', title: 'Reduce motion', desc: 'Cross-fade instead of zooming and sliding',
      control: html`<${Toggle} checked=${s.reduceMotion} onChange=${(v) => setSettings({ reduceMotion: v })} label="Reduce motion" />`,
    },
    {
      id: 'clock', tab: 'apps', icon: 'clock', title: '24-hour time', desc: 'Show times like 14:30 instead of 2:30 PM',
      control: html`<${Toggle} checked=${s.use24h} onChange=${(v) => setSettings({ use24h: v })} label="24-hour time" />`,
    },
    {
      id: 'week', tab: 'apps', icon: 'calendar', title: 'Week starts on', desc: 'Calendar, journal and habits',
      control: html`<${Segmented} size="sm" value=${s.weekStart} onChange=${(v) => setSettings({ weekStart: v })} options=${[{ value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }]} />`,
    },
    {
      id: 'duration', tab: 'apps', icon: 'clock', title: 'Default event length', desc: 'For new events in Calendar',
      control: html`<select class="field field-sm settings-select" value=${s.calendar.defaultDuration} onChange=${(e) => setSettings({ calendar: { defaultDuration: Number(e.target.value) } })}>
        ${[15, 30, 45, 60, 90, 120].map((m) => html`<option value=${m}>${m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>`)}
      </select>`,
    },
    {
      id: 'daystart', tab: 'apps', icon: 'sun', title: 'Day starts at', desc: 'Where Calendar scrolls to on other days',
      control: html`<select class="field field-sm settings-select" value=${s.calendar.dayStart} onChange=${(e) => setSettings({ calendar: { dayStart: Number(e.target.value) } })}>
        ${[5, 6, 7, 8, 9, 10].map((h) => html`<option value=${h}>${h}:00</option>`)}
      </select>`,
    },
    {
      id: 'ai', tab: 'apps', icon: 'sparkle', title: 'AI providers & presets',
      desc: presets().length ? `${presets().length} preset${presets().length === 1 ? '' : 's'} — used by Journal import, smart cards and food` : 'Connect OpenAI, Anthropic, Google, DeepSeek, Qwen, Kimi, GLM, OpenRouter and more',
      control: html`<button class="btn btn-sm" onClick=${() => setTab('ai')}>Manage</button>`,
    },
    {
      id: 'sync', tab: 'data', icon: st.mode === 'local' ? 'database' : st.online ? 'cloud-check' : 'cloud-off', title: 'Sync',
      desc: st.mode === 'local' ? 'Saved in this browser only — run BCOS on your Umbrel to sync' : st.online ? `Everything is saved on your Umbrel${st.lastSync ? ' and up to date' : ''}` : 'Offline — changes are queued and will sync automatically',
      control: html`<span class=${cx('sync-pill', st.mode === 'local' ? 'is-muted' : st.online ? 'is-ok' : 'is-warn')}>${st.mode === 'local' ? 'Local' : st.online ? 'Synced' : 'Offline'}</span>`,
    },
    {
      id: 'export', tab: 'data', icon: 'download', title: 'Export your data', desc: 'Download everything as one JSON file',
      control: html`<button class="btn btn-sm" onClick=${() => { download(`bcos-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportAll(), null, 2)); toast('Backup downloaded', { icon: 'download' }); }}>Export</button>`,
    },
    {
      id: 'import', tab: 'data', icon: 'upload', title: 'Restore from a backup', desc: 'Replaces everything with the backup’s contents',
      control: html`<button class="btn btn-sm" onClick=${async () => {
        const file = await pickFile('.json,application/json');
        if (!file) return;
        let dump;
        try { dump = JSON.parse(await file.text()); } catch { toast('That file isn’t valid JSON', { icon: 'alert' }); return; }
        if (!(await confirm({ title: 'Restore this backup?', body: 'Everything currently in BCOS will be replaced.', confirmLabel: 'Restore', danger: true }))) return;
        try { await importAll(dump); toast('Backup restored', { icon: 'check-circle' }); } catch (err) { toast(err.message, { icon: 'alert' }); }
      }}>Restore…</button>`,
    },
    {
      id: 'reset', tab: 'data', icon: 'trash', title: 'Erase everything', desc: 'Delete all data and start again from empty', danger: true,
      control: html`<button class="btn btn-sm btn-danger" onClick=${async () => {
        if (!(await confirm({ title: 'Erase all BCOS data?', body: 'Every event, task, note, journal entry and message will be deleted. Export a backup first if you might want it.', confirmLabel: 'Erase', danger: true }))) return;
        try { await resetAll(); toast('BCOS was reset', { icon: 'refresh' }); } catch (err) { toast(err.message, { icon: 'alert' }); }
      }}>Erase…</button>`,
    },
  ];

  const query = q.trim().toLowerCase();
  const shown = rows.filter((r) => (tab === 'all' || r.tab === tab) && (!query || `${r.title} ${r.desc}`.toLowerCase().includes(query)));
  const groups = tab === 'all' && !query
    ? [['account', 'appearance'], ['apps'], ['data']].map((tabs) => shown.filter((r) => tabs.includes(r.tab))).filter((g) => g.length)
    : [shown];

  const first = (s.name || '').trim().split(/\s+/)[0];
  return html`<div class="settings">
    <h1 class="settings-title">Settings</h1>
    <div class="settings-grid">
      <aside class="settings-left">
        <div class="device-card">
          <div class="device-preview" style=${wallpaperStyle(s.wallpaper, s.customWallpaper)}>
            <div class="device-preview-shade" />
            <div class="device-preview-ui">
              <${BcosMark} size=${18} />
              <span class="device-preview-greet">Hello, ${first || 'there'}.</span>
              <span class="device-preview-widgets"><i /><i /><i /></span>
              <span class="device-preview-icons">${APPS.map((a) => html`<${a.glyph} size=${12} />`)}</span>
            </div>
          </div>
          <${Avatar} name=${s.name || 'BCOS'} size=${54} class="device-avatar" />
          <div class="device-name">${first ? `${first}’s` : 'Your'} <span>BCOS</span></div>
        </div>
        <div class="info-table">
          <div><span>Running</span><b>BCOS ${info?.version || status.version || '0.2.0'}</b></div>
          <div><span>Server</span><b>${info ? `${info.platform}` : st.mode === 'local' ? 'Browser only' : '—'}</b></div>
          <div><span>Host</span><b>${info?.hostname || '—'}</b></div>
          <div><span>Your data</span><b>${info ? formatBytes(info.dataBytes) : '—'}</b></div>
          ${info?.disk && html`<div><span>Disk free</span><b>${formatBytes(info.disk.free)}</b></div>`}
          <div><span>Uptime</span><b>${info ? formatDuration(info.hostUptime) : '—'}</b></div>
        </div>
        <div class="settings-left-actions">
          <button class="btn btn-sm" onClick=${() => location.reload()}><${Icon} name="refresh" size=${14} />Reload</button>
          <button class="btn btn-sm" onClick=${() => download(`bcos-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportAll(), null, 2))}><${Icon} name="download" size=${14} />Backup</button>
        </div>
        <div class="shortcuts">
          <div class="shortcuts-title">Keyboard shortcuts</div>
          ${SHORTCUTS.map(([a, b]) => html`<div class="shortcut"><span>${a}</span><kbd>${b}</kbd></div>`)}
        </div>
      </aside>
      <section class="settings-right">
        <div class="settings-tabs">
          <${Segmented} value=${tab} onChange=${setTab} options=${TABS.map((t) => ({ value: t.id, label: t.label }))} />
          ${!narrow && html`<div class="search-field settings-search"><${Icon} name="search" size=${14} /><input class="field" placeholder="Search" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>`}
        </div>
        ${tab === 'ai' && !query ? html`<${AISettings} />` : groups.map((g, i) => html`<div class="settings-group" key=${i}>
          ${g.map((r) => html`<div key=${r.id} class=${cx('settings-row', r.wide && 'is-wide', r.danger && 'is-danger')}>
            <span class="settings-icon"><${Icon} name=${r.icon} size=${16} stroke=${2} /></span>
            <div class="settings-text"><div class="settings-row-title">${r.title}</div><div class="settings-row-desc">${r.desc}</div></div>
            <div class="settings-control">${r.control}</div>
          </div>`)}
        </div>`)}
        ${!shown.length && !(tab === 'ai' && !query) && html`<div class="notes-empty">No settings match “${q}”.</div>`}
      </section>
    </div>
  </div>`;
}
