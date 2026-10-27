// AI providers — the browser never sees an API key. Keys (and any base URL
// override) live in DATA_DIR/ai-providers.json (0600); the browser asks this
// module to list models or run a chat, and it speaks each provider's dialect.
//
// Three dialects cover everyone: OpenAI-style /chat/completions (OpenAI and
// the many compatible APIs), Anthropic /messages, and Gemini generateContent.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = {
  openai: { kind: 'openai', base: 'https://api.openai.com/v1' },
  anthropic: { kind: 'anthropic', base: 'https://api.anthropic.com/v1' },
  google: { kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta' },
  xai: { kind: 'openai', base: 'https://api.x.ai/v1' },
  deepseek: { kind: 'openai', base: 'https://api.deepseek.com/v1' },
  alibaba: { kind: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  moonshot: { kind: 'openai', base: 'https://api.moonshot.ai/v1' },
  zhipu: { kind: 'openai', base: 'https://api.z.ai/api/paas/v4' },
  openrouter: { kind: 'openai', base: 'https://openrouter.ai/api/v1' },
  nvidia: { kind: 'openai', base: 'https://integrate.api.nvidia.com/v1' },
  mistral: { kind: 'openai', base: 'https://api.mistral.ai/v1' },
  groq: { kind: 'openai', base: 'https://api.groq.com/openai/v1' },
  ollama: { kind: 'openai', base: 'http://localhost:11434/v1', keyless: true },
  custom: { kind: 'openai', base: '', keyless: true },
};

const fail = (status, message) => Object.assign(new Error(message), { status });

/** A provider's error answer → an Error with a status the browser can act on (401 key, 429 rate limit). */
function providerError(status, text) {
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const msg = data?.error?.message || data?.error?.msg || (typeof data?.error === 'string' ? data.error : '') || data?.message || String(text || '').slice(0, 200);
  const code = status === 401 || status === 403 ? 401 : status === 429 || status === 529 || /rate.?limit|quota|overloaded/i.test(msg) ? 429 : 502;
  return fail(code, `Provider answered ${status}${msg ? `: ${msg}` : ''}`);
}

function createAI({ DATA_DIR }) {
  const FILE = path.join(DATA_DIR, 'ai-providers.json');
  let secrets = {};
  try { secrets = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch {}

  const save = () => {
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  };

  const describe = (id) => {
    const p = PROVIDERS[id];
    const s = secrets[id] || {};
    return {
      id,
      kind: p.kind,
      defaultBaseUrl: p.base,
      baseUrl: s.baseUrl || '',
      hasKey: !!s.key,
      keyHint: s.key ? `…${s.key.slice(-4)}` : '',
      // Keyless (local) providers count as set up once you've pointed them somewhere.
      ready: p.keyless ? !!s.baseUrl : !!s.key,
    };
  };

  const resolve = (id) => {
    const p = PROVIDERS[id];
    if (!p) throw fail(400, 'Unknown provider');
    const s = secrets[id] || {};
    const base = (s.baseUrl || p.base).replace(/\/+$/, '');
    if (!base) throw fail(400, 'Set a base URL for this provider first');
    if (!s.key && !p.keyless) throw fail(400, 'Add an API key for this provider in Settings → AI');
    return { ...p, base, key: s.key || '' };
  };

  async function call(url, init, timeoutMs = 180000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw providerError(r.status, text);
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      if (err.name === 'AbortError') throw fail(504, 'The model took too long to answer');
      if (err.status) throw err;
      throw fail(502, `Couldn’t reach the provider (${err.cause?.code || err.message})`);
    } finally { clearTimeout(timer); }
  }

  const openaiHeaders = (p, id) => ({
    'Content-Type': 'application/json',
    ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}),
    ...(id === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/bcos', 'X-Title': 'BCOS' } : {}),
  });

  async function models(id) {
    const p = resolve(id);
    if (p.kind === 'anthropic') {
      const d = await call(`${p.base}/models?limit=100`, { headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' } }, 20000);
      return (d.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
    }
    if (p.kind === 'gemini') {
      const d = await call(`${p.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': p.key } }, 20000);
      return (d.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
    }
    const d = await call(`${p.base}/models`, { headers: openaiHeaders(p, id) }, 20000);
    return (d.data || d.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id })).filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** { provider, model, system, messages: [{ role, content }], json, temperature, maxTokens } → { text, usage, ms } */
  async function chat(body) {
    const { provider, model, system = '', messages = [], json = false, temperature, maxTokens } = body || {};
    if (!model) throw fail(400, 'Pick a model for this preset');
    if (!Array.isArray(messages) || !messages.length) throw fail(400, 'Nothing to send');
    const p = resolve(provider);
    const t0 = Date.now();

    if (p.kind === 'anthropic') {
      const d = await call(`${p.base}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 16000,
          ...(system ? { system } : {}),
          ...(temperature != null ? { temperature } : {}),
          messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
        }),
      });
      const text = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      return { text, usage: { in: d.usage?.input_tokens, out: d.usage?.output_tokens }, ms: Date.now() - t0 };
    }

    if (p.kind === 'gemini') {
      const d = await call(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] })),
          generationConfig: {
            ...(json ? { responseMimeType: 'application/json' } : {}),
            ...(temperature != null ? { temperature } : {}),
            ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
          },
        }),
      });
      const text = (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
      return { text, usage: { in: d.usageMetadata?.promptTokenCount, out: d.usageMetadata?.candidatesTokenCount }, ms: Date.now() - t0 };
    }

    const payload = {
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role, content: String(m.content) }))],
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    };
    const send = (extra) => call(`${p.base}/chat/completions`, { method: 'POST', headers: openaiHeaders(p, provider), body: JSON.stringify({ ...payload, ...extra }) });
    let d;
    // Not every compatible API accepts response_format; the prompt asks for
    // JSON anyway, so retry without it rather than fail.
    if (json) { try { d = await send({ response_format: { type: 'json_object' } }); } catch (err) { if (err.status !== 502 || !/ 400| 422/.test(err.message)) throw err; d = await send({}); } }
    else d = await send({});
    const msg = d.choices?.[0]?.message || {};
    const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map((c) => c.text || '').join('');
    return { text, usage: { in: d.usage?.prompt_tokens, out: d.usage?.completion_tokens }, ms: Date.now() - t0 };
  }

  /**
   * Like chat(), but calls onDelta(text) as the answer streams in. `signal`
   * aborts the upstream request (the browser went away).
   */
  async function stream(body, onDelta, signal) {
    const { provider, model, system = '', messages = [], json = false, temperature, maxTokens } = body || {};
    if (!model) throw fail(400, 'Pick a model for this preset');
    if (!Array.isArray(messages) || !messages.length) throw fail(400, 'Nothing to send');
    const p = resolve(provider);
    const t0 = Date.now();
    let url, init, pick;

    if (p.kind === 'anthropic') {
      url = `${p.base}/messages`;
      init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({
        model, max_tokens: maxTokens || 16000, stream: true,
        ...(system ? { system } : {}), ...(temperature != null ? { temperature } : {}),
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
      }) };
      pick = (d) => (d.type === 'content_block_delta' ? d.delta?.text || '' : d.type === 'error' ? Promise.reject(fail(d.error?.type === 'overloaded_error' ? 429 : 502, d.error?.message || 'Stream error')) : '');
    } else if (p.kind === 'gemini') {
      url = `${p.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key }, body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] })),
        generationConfig: { ...(json ? { responseMimeType: 'application/json' } : {}), ...(temperature != null ? { temperature } : {}), ...(maxTokens ? { maxOutputTokens: maxTokens } : {}) },
      }) };
      pick = (d) => (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
    } else {
      url = `${p.base}/chat/completions`;
      const payload = {
        model, stream: true,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role, content: String(m.content) }))],
        ...(temperature != null ? { temperature } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}),
      };
      init = { method: 'POST', headers: openaiHeaders(p, provider), body: JSON.stringify(json ? { ...payload, response_format: { type: 'json_object' } } : payload) };
      init.retry = json ? { ...init, body: JSON.stringify(payload) } : null;
      pick = (d) => d.choices?.[0]?.delta?.content || '';
    }

    const ctrl = new AbortController();
    signal?.addEventListener('abort', () => ctrl.abort());
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 120000); };
    let timer;
    idle();
    try {
      let r = await fetch(url, { ...init, signal: ctrl.signal });
      if (!r.ok && init.retry && (r.status === 400 || r.status === 422)) r = await fetch(url, { ...init.retry, signal: ctrl.signal });
      if (!r.ok) throw providerError(r.status, await r.text());
      const decoder = new TextDecoder();
      let buf = '', text = '';
      for await (const chunk of r.body) {
        idle();
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let d;
          try { d = JSON.parse(data); } catch { continue; }
          if (d.error && p.kind !== 'anthropic') throw fail(/rate|quota/i.test(d.error.message || '') ? 429 : 502, d.error.message || 'Stream error');
          const piece = await pick(d);
          if (piece) { text += piece; onDelta(piece); }
        }
      }
      return { text, ms: Date.now() - t0 };
    } catch (err) {
      if (err.name === 'AbortError') throw fail(504, signal?.aborted ? 'Cancelled' : 'The model stopped answering');
      if (err.status) throw err;
      throw fail(502, `Couldn’t reach the provider (${err.cause?.code || err.message})`);
    } finally { clearTimeout(timer); }
  }

  return {
    stream,
    list: () => Object.keys(PROVIDERS).map(describe),
    update(id, { key, baseUrl } = {}) {
      if (!PROVIDERS[id]) throw fail(404, 'Unknown provider');
      const cur = { ...(secrets[id] || {}) };
      if (key !== undefined) { const k = String(key).trim(); if (k) cur.key = k; else delete cur.key; }
      if (baseUrl !== undefined) {
        const u = String(baseUrl).trim();
        if (u && !/^https?:\/\//i.test(u)) throw fail(400, 'The base URL must start with http:// or https://');
        if (u) cur.baseUrl = u; else delete cur.baseUrl;
      }
      if (Object.keys(cur).length) secrets[id] = cur; else delete secrets[id];
      save();
      return describe(id);
    },
    remove(id) { delete secrets[id]; save(); },
    reset() { secrets = {}; try { fs.rmSync(FILE, { force: true }); } catch {} },
    models,
    chat,
  };
}

module.exports = { createAI };
