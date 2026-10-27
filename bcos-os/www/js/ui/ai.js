// AI UI shared by every app: provider icons, the "which preset?" menu, and
// runTask(), which picks the preset for a feature and runs it.

import { html } from '../lib/html.js';
import { providerInfo, presetFor, presets, chat, chatStream } from '../lib/ai.js';
import { openMenu, toast } from './components.js';
import { openApp } from '../shell/os.js';
import { Icon } from './icons.js';
import { cx } from '../lib/util.js';

/** A provider's logo on a white app-icon tile. */
export function ProviderIcon({ id, size = 28, class: cls }) {
  const p = providerInfo(id);
  return html`<span class=${cx('ai-tile', cls)} style=${{ width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.28)}px` }}>
    ${p?.icon ? html`<img src=${`vendor/ai/${p.icon}`} alt="" width=${Math.round(size * 0.62)} height=${Math.round(size * 0.62)} draggable="false" />`
      : html`<${Icon} name="sparkle" size=${Math.round(size * 0.55)} />`}
  </span>`;
}

const modelLabel = (m = '') => m.split('/').pop();

/** Resolves the preset to run a task with, asking via a menu when needed (null if dismissed). */
export function choosePreset(taskId, anchor, { forceAsk = false } = {}) {
  const list = presets();
  if (!list.length) {
    toast('Add an AI preset first', { icon: 'sparkle', action: { label: 'Settings', onClick: () => openApp('settings', { section: 'ai' }) } });
    return Promise.resolve(null);
  }
  const r = presetFor(taskId);
  if (r.preset && !forceAsk) return Promise.resolve(r.preset);
  return new Promise((resolve) => {
    openMenu(anchor, [
      { heading: 'Run with' },
      ...list.map((p) => ({
        label: p.name || modelLabel(p.model),
        glyph: html`<${ProviderIcon} id=${p.provider} size=${18} />`,
        shortcut: p.name ? modelLabel(p.model) : '',
        onSelect: () => resolve(p),
      })),
      { divider: true },
      { label: 'Manage presets…', icon: 'settings', onSelect: () => { resolve(null); openApp('settings', { section: 'ai' }); } },
    ], { placement: 'bottom-end', width: 280, onDismiss: () => resolve(null) });
  });
}

/**
 * Pick a preset for `taskId` (anchored to the button that started it) and run
 * one chat (streamed when opts.onText is given). Resolves the answer, or null if the user dismissed the picker.
 */
export async function runTask(taskId, anchor, opts) {
  const preset = await choosePreset(taskId, anchor, opts);
  if (!preset) return null;
  return { preset, result: opts.onText ? await chatStream(preset, opts, opts.onText) : await chat(preset, opts) };
}
