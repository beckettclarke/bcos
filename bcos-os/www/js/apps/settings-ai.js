// Settings → AI: provider keys (stored on the server), presets that pair a
// provider with a model, and which preset each AI feature uses.

import { html, useState } from '../lib/html.js';
import { useSettings, setSettings, useStatus } from '../lib/store.js';
import { PROVIDERS, PROVIDER_GROUPS, AI_TASKS, useAI, saveProvider, fetchModels, providerInfo, refreshProviders } from '../lib/ai.js';
import { ProviderIcon } from '../ui/ai.js';
import { Icon } from '../ui/icons.js';
import { toast, confirm, Segmented } from '../ui/components.js';
import { cx, uid } from '../lib/util.js';

export default function AISettings() {
  const s = useSettings();
  const st = useStatus();
  const ai = useAI();
  const [open, setOpen] = useState(null);

  if (st.mode !== 'server') {
    return html`<div class="ai-empty"><${Icon} name="cloud-off" size=${20} /><div><b>AI needs your Umbrel</b><span>API keys are kept on the BCOS server, so AI features only work when BCOS is running there.</span></div></div>`;
  }

  const ready = new Set((ai.providers || []).filter((p) => p.ready).map((p) => p.id));
  const cfg = s.ai;
  const setAI = (changes) => setSettings({ ai: changes });
  const updatePreset = (id, changes) => setAI({ presets: cfg.presets.map((p) => (p.id === id ? { ...p, ...changes } : p)) });
  const addPreset = () => {
    const provider = [...ready][0] || 'anthropic';
    const model = providerInfo(provider)?.models?.[0] || '';
    const p = { id: uid('ap_'), name: '', provider, model, temperature: null };
    setAI({ presets: [...cfg.presets, p], defaultPreset: cfg.presets.length ? cfg.defaultPreset : p.id });
  };
  const removePreset = async (p) => {
    if (!(await confirm({ title: `Delete “${p.name || p.model || 'preset'}”?`, body: 'Features using it will ask which preset to use instead.', confirmLabel: 'Delete', danger: true }))) return;
    const tasks = Object.fromEntries(Object.entries(cfg.tasks || {}).filter(([, v]) => v !== p.id));
    setAI({ presets: cfg.presets.filter((x) => x.id !== p.id), tasks, defaultPreset: cfg.defaultPreset === p.id ? 'ask' : cfg.defaultPreset });
  };
  const presetName = (p) => p.name || p.model || 'Untitled';

  return html`<div class="ai-settings">
    <section class="ai-section">
      <header class="ai-section-head">
        <div><h2>Presets</h2><p>A preset is a model you like for a kind of job — a fast one for food, a careful one for imports.</p></div>
        <button class="btn btn-sm btn-primary" onClick=${addPreset}><${Icon} name="plus" size=${14} />New preset</button>
      </header>
      ${!cfg.presets.length && html`<div class="ai-hint">No presets yet. Add a provider key below, then create a preset.</div>`}
      <div class="ai-presets">
        ${cfg.presets.map((p) => html`<${PresetRow} key=${p.id} p=${p} ready=${ready} models=${ai.models[p.provider]}
          isDefault=${cfg.defaultPreset === p.id} onChange=${(c) => updatePreset(p.id, c)} onRemove=${() => removePreset(p)}
          onMakeDefault=${() => setAI({ defaultPreset: p.id })} />`)}
      </div>
    </section>

    <section class="ai-section">
      <header class="ai-section-head"><div><h2>When a feature runs</h2><p>Use your default preset, a specific one, or choose each time.</p></div></header>
      <div class="ai-group">
        <div class="ai-row">
          <span class="ai-row-icon"><${Icon} name="sparkle" size=${15} /></span>
          <div class="ai-row-text"><b>Default</b><span>Used by every feature set to “Default”</span></div>
          <select class="field field-sm ai-select" value=${cfg.defaultPreset || 'ask'} onChange=${(e) => setAI({ defaultPreset: e.target.value })}>
            <option value="ask">Ask each time</option>
            ${cfg.presets.map((p) => html`<option value=${p.id}>${presetName(p)}</option>`)}
          </select>
        </div>
        ${AI_TASKS.map((t) => html`<div class="ai-row" key=${t.id}>
          <span class="ai-row-icon is-plain"><${Icon} name=${t.id.endsWith('food') ? 'coffee' : t.id.endsWith('import') ? 'download' : 'layers'} size=${15} /></span>
          <div class="ai-row-text"><b>${t.name}</b><span>${t.desc}</span></div>
          <select class="field field-sm ai-select" value=${cfg.tasks?.[t.id] || 'default'} onChange=${(e) => setAI({ tasks: { ...cfg.tasks, [t.id]: e.target.value } })}>
            <option value="default">Default</option>
            <option value="ask">Ask each time</option>
            ${cfg.presets.map((p) => html`<option value=${p.id}>${presetName(p)}</option>`)}
          </select>
        </div>`)}
      </div>
    </section>

    <section class="ai-section">
      <header class="ai-section-head">
        <div><h2>Providers</h2><p>Keys are stored on your Umbrel and never sent back to the browser.</p></div>
        <button class="btn btn-sm btn-ghost" onClick=${refreshProviders} disabled=${ai.loading}><${Icon} name="refresh" size=${14} />Refresh</button>
      </header>
      ${ai.error && html`<div class="ai-hint is-warn">${ai.error}</div>`}
      ${PROVIDER_GROUPS.map((g) => html`<div class="ai-group-wrap" key=${g.id}>
        <div class="ai-group-label">${g.label}</div>
        <div class="ai-group">
          ${PROVIDERS.filter((p) => p.group === g.id).map((p) => html`<${ProviderRow} key=${p.id} p=${p}
            st=${ai.providers?.find((x) => x.id === p.id)} open=${open === p.id} onToggle=${() => setOpen(open === p.id ? null : p.id)} />`)}
        </div>
      </div>`)}
    </section>
  </div>`;
}

function ProviderRow({ p, st, open, onToggle }) {
  const [key, setKey] = useState('');
  const [base, setBase] = useState(null);
  const [busy, setBusy] = useState(false);
  const needsBase = p.id === 'custom' || p.id === 'ollama';
  const [advanced, setAdvanced] = useState(needsBase);
  const baseVal = base ?? st?.baseUrl ?? '';

  const save = async (changes, msg) => {
    setBusy(true);
    try { await saveProvider(p.id, changes); setKey(''); setBase(null); if (msg) toast(msg, { icon: 'check-circle' }); }
    catch (err) { toast(err.message, { icon: 'alert' }); }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try { const m = await fetchModels(p.id); toast(`${p.name} is working — ${m.length} models available`, { icon: 'check-circle' }); }
    catch (err) { toast(err.message, { icon: 'alert', duration: 7000 }); }
    setBusy(false);
  };

  return html`<div class=${cx('ai-provider', open && 'is-open')}>
    <button class="ai-row ai-provider-head" onClick=${onToggle} aria-expanded=${open}>
      <${ProviderIcon} id=${p.id} size=${30} />
      <div class="ai-row-text"><b>${p.name}</b><span>${p.blurb}</span></div>
      ${st?.ready ? html`<span class="ai-pill is-ok"><i />${st.hasKey ? st.keyHint : 'Ready'}</span>` : html`<span class="ai-pill">${needsBase ? 'Set up' : 'Add key'}</span>`}
      <${Icon} name="chevron-down" size=${15} class="ai-chev" />
    </button>
    ${open && html`<div class="ai-provider-body">
      ${p.id !== 'ollama' && html`<form class="ai-field-row" onSubmit=${(e) => { e.preventDefault(); key.trim() && save({ key }, 'Key saved'); }}>
        <input class="field field-sm" type="password" autocomplete="off" spellcheck="false" placeholder=${st?.hasKey ? `Replace key (${st.keyHint})` : 'Paste API key'} value=${key} onInput=${(e) => setKey(e.target.value)} />
        <button class="btn btn-sm btn-primary" disabled=${!key.trim() || busy}>Save</button>
      </form>`}
      ${advanced ? html`<form class="ai-field-row" onSubmit=${(e) => { e.preventDefault(); save({ baseUrl: baseVal }, 'Base URL saved'); }}>
        <input class="field field-sm" spellcheck="false" placeholder=${p.baseUrlHint || st?.defaultBaseUrl || 'https://…'} value=${baseVal} onInput=${(e) => setBase(e.target.value)} />
        <button class="btn btn-sm" disabled=${busy || base === null}>Save URL</button>
      </form>` : html`<button class="ai-link" onClick=${() => setAdvanced(true)}>Custom base URL…</button>`}
      <div class="ai-provider-actions">
        ${p.keyUrl && html`<a class="ai-link" href=${p.keyUrl} target="_blank" rel="noopener noreferrer">Get a key<${Icon} name="external" size=${12} /></a>`}
        <span class="spacer" />
        ${st?.hasKey && html`<button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => save({ key: '' }, 'Key removed')}>Remove key</button>`}
        <button class="btn btn-sm" disabled=${busy || !st?.ready} onClick=${test}>${busy ? html`<span class="spinner sm" />` : html`<${Icon} name="bolt" size=${13} />`}Test</button>
      </div>
    </div>`}
  </div>`;
}

const TEMPS = [{ value: '', label: 'Auto' }, { value: '0', label: 'Precise' }, { value: '0.4', label: 'Balanced' }, { value: '0.9', label: 'Creative' }];

function PresetRow({ p, ready, models, isDefault, onChange, onRemove, onMakeDefault }) {
  const [loading, setLoading] = useState(false);
  const info = providerInfo(p.provider);
  const suggestions = [...new Set([...(models || []).map((m) => m.id), ...(info?.models || [])])];
  const listId = `models-${p.id}`;
  const loadModels = async () => {
    setLoading(true);
    try { const m = await fetchModels(p.provider); toast(`${m.length} models from ${info?.name}`, { icon: 'check-circle' }); }
    catch (err) { toast(err.message, { icon: 'alert', duration: 7000 }); }
    setLoading(false);
  };
  return html`<div class=${cx('ai-preset', isDefault && 'is-default')}>
    <div class="ai-preset-top">
      <${ProviderIcon} id=${p.provider} size=${34} />
      <input class="ai-preset-name" placeholder=${p.model || 'Name this preset'} value=${p.name} onInput=${(e) => onChange({ name: e.target.value })} />
      ${isDefault ? html`<span class="ai-pill is-accent">Default</span>` : html`<button class="btn btn-sm btn-ghost" onClick=${onMakeDefault}>Make default</button>`}
      <button class="icon-btn sm is-danger" aria-label="Delete preset" onClick=${onRemove}><${Icon} name="trash" size=${14} /></button>
    </div>
    <div class="ai-preset-grid">
      <label class="ai-mini"><span>Provider</span>
        <select class="field field-sm" value=${p.provider} onChange=${(e) => onChange({ provider: e.target.value, model: providerInfo(e.target.value)?.models?.[0] || '' })}>
          ${PROVIDERS.map((x) => html`<option value=${x.id}>${x.name}${ready.has(x.id) ? '' : ' — not set up'}</option>`)}
        </select>
      </label>
      <label class="ai-mini is-model"><span>Model</span>
        <div class="ai-model-field">
          <input class="field field-sm" list=${listId} spellcheck="false" placeholder="model id" value=${p.model} onInput=${(e) => onChange({ model: e.target.value.trim() })} />
          <datalist id=${listId}>${suggestions.map((m) => html`<option value=${m} />`)}</datalist>
          <button class="icon-btn sm" title="Load models from provider" aria-label="Load models" disabled=${!ready.has(p.provider) || loading} onClick=${loadModels}>
            ${loading ? html`<span class="spinner sm" />` : html`<${Icon} name="refresh" size=${13} />`}
          </button>
        </div>
      </label>
      <label class="ai-mini"><span>Style</span>
        <${Segmented} size="sm" value=${p.temperature == null ? '' : String(p.temperature)} onChange=${(v) => onChange({ temperature: v === '' ? null : Number(v) })} options=${TEMPS} />
      </label>
    </div>
    ${!ready.has(p.provider) && html`<div class="ai-hint is-warn">${info?.name} isn’t set up yet — add its key below.</div>`}
  </div>`;
}
