// AI: the provider catalogue, provider status from the server, presets, and
// running a task. Keys never reach the browser — the server holds them and
// proxies every call (see ai.js next to server.js).
//
// A preset is { id, name, provider, model, temperature }. Each AI feature
// ("task") is mapped in settings.ai.tasks to a preset id, 'default' (use
// settings.ai.defaultPreset) or 'ask' (pick one each time it runs).

import { useEffect, useReducer } from './html.js';
import { api, settings, status } from './store.js';

export const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', icon: 'openai.svg', group: 'labs', keyUrl: 'https://platform.openai.com/api-keys', blurb: 'GPT models' },
  { id: 'anthropic', name: 'Anthropic', icon: 'claude-color.svg', group: 'labs', keyUrl: 'https://console.anthropic.com/settings/keys', blurb: 'Claude models', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  { id: 'google', name: 'Google', icon: 'gemini-color.svg', group: 'labs', keyUrl: 'https://aistudio.google.com/apikey', blurb: 'Gemini models' },
  { id: 'xai', name: 'xAI', icon: 'grok.svg', group: 'labs', keyUrl: 'https://console.x.ai', blurb: 'Grok models' },
  { id: 'deepseek', name: 'DeepSeek', icon: 'deepseek-color.svg', group: 'open', keyUrl: 'https://platform.deepseek.com/api_keys', blurb: 'DeepSeek models', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'alibaba', name: 'Alibaba Cloud', icon: 'qwen-color.svg', group: 'open', keyUrl: 'https://modelstudio.console.alibabacloud.com', blurb: 'Qwen via Model Studio' },
  { id: 'moonshot', name: 'Moonshot', icon: 'kimi-color.svg', group: 'open', keyUrl: 'https://platform.moonshot.ai/console/api-keys', blurb: 'Kimi models' },
  { id: 'zhipu', name: 'Z.ai', icon: 'zhipu-color.svg', group: 'open', keyUrl: 'https://z.ai/manage-apikey/apikey-list', blurb: 'GLM models' },
  { id: 'mistral', name: 'Mistral', icon: 'mistral-color.svg', group: 'open', keyUrl: 'https://console.mistral.ai/api-keys', blurb: 'Mistral models' },
  { id: 'openrouter', name: 'OpenRouter', icon: 'openrouter.svg', group: 'gateway', keyUrl: 'https://openrouter.ai/keys', blurb: 'Hundreds of models, one key' },
  { id: 'nvidia', name: 'NVIDIA NIM', icon: 'nvidia-color.svg', group: 'gateway', keyUrl: 'https://build.nvidia.com', blurb: 'Hosted open models' },
  { id: 'groq', name: 'Groq', icon: 'groq.svg', group: 'gateway', keyUrl: 'https://console.groq.com/keys', blurb: 'Very fast inference' },
  { id: 'ollama', name: 'Ollama', icon: 'ollama.svg', group: 'local', blurb: 'Models on your own machine', baseUrlHint: 'http://umbrel.local:11434/v1' },
  { id: 'custom', name: 'Custom', icon: null, group: 'local', blurb: 'Any OpenAI-compatible API', baseUrlHint: 'https://…/v1' },
];

export const PROVIDER_GROUPS = [
  { id: 'labs', label: 'Frontier labs' },
  { id: 'open', label: 'Open-weight labs' },
  { id: 'gateway', label: 'Gateways' },
  { id: 'local', label: 'Local & custom' },
];

export const providerInfo = (id) => PROVIDERS.find((p) => p.id === id);

/** Every AI feature in BCOS. Add one here and it shows up in Settings → AI. */
export const AI_TASKS = [
  { id: 'journal.import', name: 'Journal import', desc: 'Turns Diarly Markdown into structured days' },
  { id: 'journal.enrich', name: 'Smart cards', desc: 'Finds flights, races, places, people and an icon in an entry' },
  { id: 'journal.food', name: 'Smart food', desc: 'Icons, portions and calories for what you ate' },
];

// --- provider status (from the server) ---------------------------------------

const state = { providers: null, loading: false, error: null, models: {} };

// A 404 from /api/ai means the server process predates AI support.
const STALE = 'Your BCOS server is out of date — restart it (or update BCOS on your Umbrel) to use AI';
const explain = (err) => (err?.status === 404 ? Object.assign(new Error(STALE), { status: 404 }) : err);
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export async function refreshProviders() {
  if (status.mode !== 'server') { state.error = 'AI needs the BCOS server'; state.providers = []; emit(); return; }
  state.loading = true; emit();
  try { state.providers = (await api('ai/providers')).providers; state.error = null; }
  catch (err) { state.error = explain(err).message; }
  state.loading = false; emit();
}

export function useAI() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    if (!state.providers && !state.loading) refreshProviders();
    return () => listeners.delete(force);
  }, []);
  return state;
}

export const providerStatus = (id) => state.providers?.find((p) => p.id === id);

export async function saveProvider(id, changes) {
  const { provider } = await api(`ai/providers/${id}`, { method: 'PUT', body: changes });
  state.providers = (state.providers || []).map((p) => (p.id === id ? provider : p));
  emit();
  return provider;
}

export async function fetchModels(id) {
  const { models } = await api(`ai/models/${id}`, { timeout: 25000 }).catch((err) => { throw explain(err); });
  state.models[id] = models;
  emit();
  return models;
}

// --- presets & running -------------------------------------------------------

export const presets = () => settings().ai.presets || [];

/** The preset a task will use, or { ask: true } when it should ask. */
export function presetFor(taskId) {
  const ai = settings().ai;
  const list = ai.presets || [];
  let choice = ai.tasks?.[taskId] || 'default';
  if (choice === 'default') choice = ai.defaultPreset || 'ask';
  if (choice === 'ask') return list.length === 1 ? { preset: list[0] } : { ask: true };
  const preset = list.find((p) => p.id === choice);
  return preset ? { preset } : { ask: true };
}

/** Pull the first JSON object or array out of a model's reply. */
export function parseJSON(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const start = t.search(/[{[]/);
  if (start < 0) throw new Error('The model didn’t answer with JSON');
  const open = t[start], close = open === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  try { return JSON.parse(t.slice(start, end + 1)); }
  catch { throw new Error('The model’s JSON was cut off or invalid — try again or use a bigger model'); }
}

/**
 * Like chat(), but streams: onText(fullTextSoFar) is called as the answer
 * arrives. Errors carry `.status` (401 bad key, 429 rate limited).
 */
export async function chatStream(preset, { system, prompt, messages, json = false, maxTokens, signal }, onText) {
  if (!preset) throw new Error('No AI preset — add one in Settings → AI');
  if (status.mode !== 'server') throw new Error('AI needs the BCOS server');
  let res;
  try {
    res = await fetch('api/ai/stream', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: preset.provider, model: preset.model, temperature: preset.temperature ?? undefined, system, messages: messages || [{ role: 'user', content: prompt }], json, maxTokens }),
    });
  } catch (err) { throw Object.assign(new Error(err.name === 'AbortError' ? 'Cancelled' : 'Couldn’t reach your Umbrel'), { status: err.name === 'AbortError' ? 499 : 503 }); }
  if (!res.ok || !res.body) {
    let msg = `Something went wrong (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw explain(Object.assign(new Error(msg), { status: res.status }));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.error) throw Object.assign(new Error(m.error), { status: m.status });
      if (m.d) { text += m.d; onText?.(text); }
    }
  }
  return json ? parseJSON(text) : text;
}

/** Run one chat with a specific preset. Resolves text, or parsed JSON when json is set. */
export async function chat(preset, { system, prompt, messages, json = false, maxTokens, timeout = 240000 }) {
  if (!preset) throw new Error('No AI preset — add one in Settings → AI');
  const r = await api('ai/chat', {
    method: 'POST',
    timeout,
    body: {
      provider: preset.provider,
      model: preset.model,
      temperature: preset.temperature ?? undefined,
      system,
      messages: messages || [{ role: 'user', content: prompt }],
      json,
      maxTokens,
    },
  }).catch((err) => { throw explain(err); });
  return json ? parseJSON(r.text) : r.text;
}
