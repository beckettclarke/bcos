// The Import sheet: documents read by AI (three at a time, streamed live), or
// JSON pasted from any LLM, then a preview where days can be checked before
// they're saved.
//
// Documents are a saved queue (collection `journal_imports`: { id, name, size,
// text, status, error, attempts, entries }), so a rate limit, a closed tab or
// a bad key never loses work — failed files wait to be retried.

import { html, useState, useRef, useMemo, useEffect } from '../lib/html.js';
import { Portal, Segmented, toast, useEscape, confirm } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { ProviderIcon, choosePreset } from '../ui/ai.js';
import { chatStream, parseJSON } from '../lib/ai.js';
import { useCollection, put, remove, get, all } from '../lib/store.js';
import { cx, plural, formatBytes, download, uid } from '../lib/util.js';
import { fmt, fromKey } from '../lib/date.js';
import { IMPORT_GUIDE, IMPORT_SYSTEM, documentPrompt, entriesForFile, readImport, saveImport, existingDays, dateFromName } from './journal-import.js';
import { cardSummary, cardIcon } from './journal-cards.js';
import { foodCount, moodInfo } from './journal-shared.js';

const TEXT_TYPES = /\.(md|markdown|txt|text|json|html?|rtf|csv)$/i;
const CONCURRENCY = 3;
const MAX_TRIES = 4;
const COL = 'journal_imports';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sortKey = (j) => dateFromName(j.name) || j.name;

export function ImportSheet({ onClose, onDone }) {
  const jobs = useCollection(COL).slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const [mode, setMode] = useState('docs');
  const [jsonText, setJsonText] = useState('');
  const [preset, setPreset] = useState(null);
  const [running, setRunning] = useState(false);
  const [flying, setFlying] = useState({}); // job id → streamed text so far
  const [cooldown, setCooldown] = useState(0); // rate-limited until (ms)
  const [conflict, setConflict] = useState('merge');
  const [excluded, setExcluded] = useState(new Set());
  const [over, setOver] = useState(false);
  const stopRef = useRef(false);
  const ctrlRef = useRef(null);
  const coolRef = useRef(0);
  useEscape(onClose);
  useEffect(() => () => ctrlRef.current?.abort(), []);
  const [, tick] = useState(0);
  useEffect(() => { if (cooldown <= Date.now()) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [cooldown]);

  const [jsonEntries, jsonError] = useMemo(() => {
    if (!jsonText.trim()) return [[], ''];
    try { return [readImport(parseJSON(jsonText)), '']; }
    catch (err) { return [[], err.message]; }
  }, [jsonText]);

  const entries = useMemo(() => {
    const list = mode === 'json' ? jsonEntries.map((e, i) => ({ ...e, _key: `j:${i}` }))
      : jobs.filter((j) => j.status === 'done').flatMap((j) => (j.entries || []).map((e, i) => ({ ...e, _key: `${j.id}:${i}`, _job: j.id })));
    return list.sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  }, [mode, jsonEntries, jobs]);
  const existing = useMemo(existingDays, [entries.length]);
  const chosen = entries.filter((e) => !excluded.has(e._key) && e.date);

  // Anything left "reading" by a closed sheet is just waiting again.
  const statusOf = (j) => (j.status === 'reading' && !(j.id in flying) ? 'waiting' : j.status);
  const counts = jobs.reduce((n, j) => { n[statusOf(j)] = (n[statusOf(j)] || 0) + 1; return n; }, {});

  const addFiles = async (list) => {
    const picked = [...list].filter((f) => TEXT_TYPES.test(f.name) || f.type.startsWith('text/'));
    if (picked.length < list.length) toast(`Skipped ${plural(list.length - picked.length, 'file')} that aren’t text`, { icon: 'alert' });
    if (mode === 'json' && picked.length === 1 && /\.json$/i.test(picked[0].name)) { setJsonText(await picked[0].text()); return; }
    setMode('docs');
    const have = new Set(jobs.map((j) => `${j.name}:${j.size}`));
    for (const f of picked) {
      if (have.has(`${f.name}:${f.size}`)) continue;
      put(COL, { id: uid('ji'), name: f.name, size: f.size, text: await f.text(), status: 'waiting', attempts: 0 });
    }
  };
  const choose = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = mode === 'docs';
    input.accept = mode === 'json' ? '.json,application/json' : '.md,.markdown,.txt,.text,.json,.html,text/*';
    input.onchange = () => input.files?.length && addFiles(input.files);
    input.click();
  };

  const patchJob = (id, changes) => { const cur = get(COL, id); if (cur) put(COL, { ...cur, ...changes }); };

  async function readOne(p, job, signal) {
    for (;;) {
      while (Date.now() < coolRef.current) { if (signal.aborted) return; await sleep(500); }
      patchJob(job.id, { status: 'reading', error: '' });
      setFlying((f) => ({ ...f, [job.id]: '' }));
      try {
        const json = await chatStream(p, { system: IMPORT_SYSTEM, prompt: documentPrompt(job.name, job.text), json: true, signal },
          (text) => setFlying((f) => ({ ...f, [job.id]: text })));
        const got = entriesForFile(job.name, json);
        patchJob(job.id, { status: 'done', entries: got, error: '' });
        return;
      } catch (err) {
        if (signal.aborted) { patchJob(job.id, { status: 'waiting' }); return; }
        const attempts = (get(COL, job.id)?.attempts || 0) + 1;
        const limited = err.status === 429;
        if (limited && attempts < MAX_TRIES) {
          // Back off everyone, then try this file again.
          const until = Date.now() + 15000 * attempts;
          coolRef.current = Math.max(coolRef.current, until);
          setCooldown(coolRef.current);
          patchJob(job.id, { status: 'waiting', attempts, error: err.message });
          continue;
        }
        patchJob(job.id, { status: 'failed', attempts, error: limited ? `Rate limited — retry later. ${err.message}` : err.message });
        if (err.status === 401) { stopRef.current = true; toast(err.message, { icon: 'alert', duration: 7000 }); }
        return;
      } finally {
        setFlying((f) => { const n = { ...f }; delete n[job.id]; return n; });
      }
    }
  }

  const run = async (e, { retryFailed = false } = {}) => {
    const p = preset || (await choosePreset('journal.import', e.currentTarget));
    if (!p) return;
    setPreset(p);
    if (retryFailed) for (const j of jobs) if (j.status === 'failed') patchJob(j.id, { status: 'waiting', attempts: 0, error: '' });
    stopRef.current = false;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRunning(true);
    const taken = new Set();
    const next = () => all(COL).slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .find((j) => !taken.has(j.id) && (j.status === 'waiting' || j.status === 'reading'));
    const worker = async () => {
      for (;;) {
        if (stopRef.current || ctrl.signal.aborted) return;
        const job = next();
        if (!job) return;
        taken.add(job.id);
        await readOne(p, job, ctrl.signal);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setRunning(false);
    setCooldown(0);
  };

  const commit = () => {
    const { saved, skipped } = saveImport(chosen, conflict);
    if (mode === 'docs') for (const j of jobs) if (j.status === 'done') remove(COL, j.id);
    toast(`Imported ${plural(saved, 'day')}${skipped ? ` · ${skipped} skipped` : ''}`, { icon: 'check-circle' });
    onDone?.(chosen[chosen.length - 1]?.date);
    onClose();
  };

  const clearAll = async () => {
    if (!(await confirm({ title: 'Clear the import queue?', body: 'Files and anything read from them but not yet imported are removed.', confirmLabel: 'Clear', danger: true }))) return;
    ctrlRef.current?.abort();
    for (const j of jobs) remove(COL, j.id);
  };

  const copyGuide = async () => {
    try { await navigator.clipboard.writeText(IMPORT_GUIDE); toast('LLM instructions copied — paste them with your journal into any AI', { icon: 'copy', duration: 5000 }); }
    catch { download('bcos-journal-import.md', IMPORT_GUIDE, 'text/markdown'); }
  };

  const pending = (counts.waiting || 0) + (counts.reading || 0);
  const live = Object.entries(flying);
  const coolLeft = Math.max(0, Math.ceil((cooldown - Date.now()) / 1000));

  return html`<${Portal}>
    <div class="jx-scrim" onPointerDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class=${cx('jx-sheet', over && 'is-over')} role="dialog" aria-label="Import journal"
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${(e) => { if (e.currentTarget === e.target) setOver(false); }}
        onDrop=${(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); }}>
        <header class="jx-head">
          <div class="jx-title"><h2>Import</h2><p>${mode === 'docs' ? 'Your files are read by AI, three at a time. The queue is saved — close this any time.' : 'Paste JSON in the bcos.journal/1 format.'}</p></div>
          <${Segmented} size="sm" value=${mode} onChange=${setMode} options=${[{ value: 'docs', label: 'Documents' }, { value: 'json', label: 'JSON' }]} />
          <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
        </header>

        <div class="jx-body">
          <div class="jx-source">
            ${mode === 'docs' ? html`
              ${!jobs.length ? html`<button class="jx-drop" onClick=${choose}>
                <span class="jx-drop-icon"><${Icon} name="upload" size=${20} /></span>
                <b>Drop your Diarly export here</b>
                <span>Markdown or text files, as many as you like. Each file’s name is sent with it, so dates in names are kept.</span>
                <span class="btn btn-sm">Choose files…</span>
              </button>` : html`<div class="jx-files">
                <div class="jx-files-head">
                  <span>${plural(jobs.length, 'file')}${counts.done ? ` · ${counts.done} read` : ''}${counts.failed ? ` · ${counts.failed} failed` : ''}</span>
                  <button class="btn btn-sm btn-ghost" onClick=${choose}><${Icon} name="plus" size=${13} />Add</button>
                  <button class="btn btn-sm btn-ghost" onClick=${clearAll}>Clear</button>
                </div>
                <div class="jx-file-list">
                  ${jobs.map((j) => {
                    const st = statusOf(j);
                    return html`<div key=${j.id} class=${cx('jx-file', `is-${st}`)} title=${j.error || ''}>
                      <span class="jx-file-status">${st === 'reading' ? html`<span class="spinner sm" />` : st === 'done' ? html`<${Icon} name="check" size=${13} stroke=${2.4} />` : st === 'failed' ? html`<${Icon} name="alert" size=${13} />` : html`<i />`}</span>
                      <span class="jx-file-name">${j.name}</span>
                      <span class="jx-file-meta">${st === 'done' ? plural(j.entries?.length || 0, 'day') : st === 'failed' ? (j.error || 'Failed').slice(0, 42) : st === 'reading' ? 'Reading…' : formatBytes(j.size)}</span>
                      ${!running && html`<button class="jx-x" aria-label="Remove" onClick=${() => remove(COL, j.id)}><${Icon} name="x" size=${11} /></button>`}
                    </div>`;
                  })}
                </div>
                <div class="jx-run">
                  ${preset && html`<span class="jx-preset"><${ProviderIcon} id=${preset.provider} size=${18} />${preset.name || preset.model}</span>`}
                  ${coolLeft > 0 && html`<span class="jx-cool">Rate limited · resuming in ${coolLeft}s</span>`}
                  <span class="spacer" />
                  ${running ? html`<button class="btn btn-sm" onClick=${() => { stopRef.current = true; }}>Stop after these</button>`
                    : html`
                      ${counts.failed > 0 && html`<button class="btn btn-sm" onClick=${(e) => run(e, { retryFailed: true })}><${Icon} name="refresh" size=${13} />Retry ${counts.failed} failed</button>`}
                      ${pending > 0 && html`<button class="btn btn-sm btn-primary" onClick=${run}><${Icon} name="sparkle" size=${13} />Read ${plural(pending, 'file')}</button>`}`}
                </div>
                ${running && html`<div class="jx-progress"><i style=${{ width: `${((counts.done || 0) / jobs.length) * 100}%` }} /></div>`}
              </div>`}`
            : html`<div class="jx-json">
              <textarea class="field jx-textarea" spellcheck="false" placeholder=${'Paste JSON in the bcos.journal/1 format…\n\nTip: “Copy LLM instructions” below, paste them into ChatGPT, Claude or Gemini with your Diarly entries, then paste the answer here.'}
                value=${jsonText} onInput=${(e) => setJsonText(e.target.value)} />
              <div class="jx-json-foot">
                ${jsonError ? html`<span class="jx-error"><${Icon} name="alert" size=${13} />${jsonError}</span>` : jsonEntries.length ? html`<span class="jx-ok"><${Icon} name="check-circle" size=${13} />${plural(jsonEntries.length, 'day')} found</span>` : html`<span />`}
                <button class="btn btn-sm btn-ghost" onClick=${choose}><${Icon} name="file-up" size=${13} />Open .json</button>
              </div>
            </div>`}
          </div>

          <div class="jx-preview">
            <div class="jx-preview-head">
              <b>Preview</b>
              <span class="muted">${entries.length ? `${chosen.length} of ${plural(entries.length, 'day')}` : live.length ? 'Reading…' : 'Nothing yet'}</span>
            </div>
            <div class="jx-days">
              ${mode === 'docs' && live.map(([id, text]) => html`<div key=${id} class="jx-live">
                <div class="jx-live-head"><span class="spinner sm" />${get(COL, id)?.name}<span class="muted">${text.length ? `${text.length.toLocaleString()} chars` : 'Waiting for the model…'}</span></div>
                <pre class="jx-live-text">${text.slice(-700) || ' '}</pre>
              </div>`)}
              ${entries.map((e) => {
                const on = !excluded.has(e._key);
                const exists = existing.has(e.date);
                const mood = moodInfo(e.mood);
                return html`<label key=${e._key} class=${cx('jx-day', !on && 'is-off', !e.date && 'is-bad')}>
                  <input type="checkbox" checked=${on && !!e.date} disabled=${!e.date} onChange=${() => { const n = new Set(excluded); on ? n.add(e._key) : n.delete(e._key); setExcluded(n); }} />
                  <span class="jx-day-icon">${e.icon || '·'}</span>
                  <span class="jx-day-text">
                    <span class="jx-day-date">${e.date ? fmt(fromKey(e.date), 'fullYear') : 'No date found'}${exists && html`<em>${conflict}</em>`}</span>
                    <span class="jx-day-sub">${(e.text || '').slice(0, 110)}</span>
                    <span class="jx-day-chips">
                      ${e.rating && html`<span><${Icon} name="star-fill" size=${10} /> ${e.rating}</span>`}
                      ${mood && html`<span><i style=${{ background: mood.color }} />${mood.short}</span>`}
                      ${e.cards.slice(0, 4).map((c) => html`<span><${Icon} name=${cardIcon(c)} size=${11} />${cardSummary(c)}</span>`)}
                      ${foodCount(e) > 0 && html`<span><${Icon} name="utensils" size=${11} />${foodCount(e)}</span>`}
                      ${e.people.length > 0 && html`<span><${Icon} name="user" size=${11} />${e.people.slice(0, 3).join(', ')}</span>`}
                    </span>
                  </span>
                </label>`;
              })}
              ${!entries.length && !live.length && html`<div class="jx-empty">Days show up here as they’re read, so you can check them before importing.</div>`}
            </div>
          </div>
        </div>

        <footer class="jx-foot">
          <button class="btn btn-sm btn-ghost" onClick=${copyGuide}><${Icon} name="copy" size=${13} />Copy LLM instructions</button>
          <span class="spacer" />
          <span class="jx-conflict-label">Days that exist</span>
          <${Segmented} size="sm" value=${conflict} onChange=${setConflict} options=${[{ value: 'merge', label: 'Merge' }, { value: 'replace', label: 'Replace' }, { value: 'skip', label: 'Skip' }]} />
          <button class="btn btn-primary" disabled=${!chosen.length} onClick=${commit}>Import ${chosen.length ? plural(chosen.length, 'day') : ''}</button>
        </footer>
      </div>
    </div>
  </${Portal}>`;
}
