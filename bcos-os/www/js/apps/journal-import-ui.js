// The Import sheet: documents read by AI one at a time, or JSON pasted from
// any LLM, then a preview where days can be checked before they're saved.

import { html, useState, useRef, useMemo } from '../lib/html.js';
import { Portal, Segmented, toast, useEscape } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { ProviderIcon, choosePreset } from '../ui/ai.js';
import { chat, parseJSON } from '../lib/ai.js';
import { cx, plural, formatBytes, download } from '../lib/util.js';
import { fmt, fromKey } from '../lib/date.js';
import { IMPORT_GUIDE, IMPORT_SYSTEM, documentPrompt, entriesForFile, readImport, saveImport, existingDays, dateFromName } from './journal-import.js';
import { cardSummary } from './journal-cards.js';
import { foodCount, moodInfo } from './journal-shared.js';

const TEXT_TYPES = /\.(md|markdown|txt|text|json|html?|rtf|csv)$/i;

export function ImportSheet({ onClose, onDone }) {
  const [mode, setMode] = useState('docs');
  const [files, setFiles] = useState([]); // { key, name, size, text, status, error, count }
  const [results, setResults] = useState({}); // file key → entries
  const [jsonText, setJsonText] = useState('');
  const [preset, setPreset] = useState(null);
  const [running, setRunning] = useState(false);
  const [conflict, setConflict] = useState('merge');
  const [excluded, setExcluded] = useState(new Set());
  const [over, setOver] = useState(false);
  const stopRef = useRef(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  useEscape(() => { if (!running) onClose(); });

  const [jsonEntries, jsonError] = useMemo(() => {
    if (!jsonText.trim()) return [[], ''];
    try { return [readImport(parseJSON(jsonText)), '']; }
    catch (err) { return [[], err.message]; }
  }, [jsonText]);

  const entries = useMemo(() => {
    const list = mode === 'json' ? jsonEntries : files.flatMap((f) => (results[f.key] || []).map((e, i) => ({ ...e, _key: `${f.key}:${i}`, _file: f.name })));
    return list.map((e, i) => ({ ...e, _key: e._key || `j:${i}` })).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  }, [mode, jsonEntries, files, results]);
  const existing = useMemo(existingDays, [entries.length]);
  const chosen = entries.filter((e) => !excluded.has(e._key) && e.date);

  const addFiles = async (list) => {
    const picked = [...list].filter((f) => TEXT_TYPES.test(f.name) || f.type.startsWith('text/'));
    if (picked.length < list.length) toast(`Skipped ${plural(list.length - picked.length, 'file')} that aren’t text`, { icon: 'alert' });
    const read = await Promise.all(picked.map(async (f) => ({ key: `${f.name}:${f.size}:${f.lastModified}`, name: f.name, size: f.size, text: await f.text(), status: 'waiting' })));
    const have = new Set(filesRef.current.map((f) => f.key));
    if (mode === 'json' && read.length === 1 && /\.json$/i.test(read[0].name)) { setJsonText(read[0].text); return; }
    setMode('docs');
    setFiles([...filesRef.current, ...read.filter((f) => !have.has(f.key))].sort((a, b) => (dateFromName(a.name) || a.name).localeCompare(dateFromName(b.name) || b.name)));
  };
  const choose = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = mode === 'docs';
    input.accept = mode === 'json' ? '.json,application/json' : '.md,.markdown,.txt,.text,.json,.html,text/*';
    input.onchange = () => input.files?.length && addFiles(input.files);
    input.click();
  };

  const setFile = (key, patch) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const run = async (e) => {
    const p = preset || (await choosePreset('journal.import', e.currentTarget));
    if (!p) return;
    setPreset(p);
    stopRef.current = false;
    setRunning(true);
    for (const f of filesRef.current) {
      if (stopRef.current) break;
      if (f.status === 'done') continue;
      setFile(f.key, { status: 'reading', error: '' });
      try {
        const json = await chat(p, { system: IMPORT_SYSTEM, prompt: documentPrompt(f.name, f.text), json: true });
        const got = entriesForFile(f.name, json);
        setResults((r) => ({ ...r, [f.key]: got }));
        setFile(f.key, { status: 'done', count: got.length });
      } catch (err) {
        setFile(f.key, { status: 'failed', error: err.message });
        if (/401|key/i.test(err.message)) { toast(err.message, { icon: 'alert', duration: 7000 }); break; }
      }
    }
    setRunning(false);
  };

  const commit = () => {
    const { saved, skipped } = saveImport(chosen, conflict);
    toast(`Imported ${plural(saved, 'day')}${skipped ? ` · ${skipped} skipped` : ''}`, { icon: 'check-circle' });
    onDone?.(chosen[chosen.length - 1]?.date);
    onClose();
  };

  const copyGuide = async () => {
    try { await navigator.clipboard.writeText(IMPORT_GUIDE); toast('LLM instructions copied — paste them with your journal into any AI', { icon: 'copy', duration: 5000 }); }
    catch { download('bcos-journal-import.md', IMPORT_GUIDE, 'text/markdown'); }
  };

  const done = files.filter((f) => f.status === 'done').length;
  const pending = files.filter((f) => f.status !== 'done').length;

  return html`<${Portal}>
    <div class="jx-scrim" onPointerDown=${(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div class=${cx('jx-sheet', over && 'is-over')} role="dialog" aria-label="Import journal"
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${(e) => { if (e.currentTarget === e.target) setOver(false); }}
        onDrop=${(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); }}>
        <header class="jx-head">
          <div class="jx-title"><h2>Import</h2><p>Bring in days from Diarly or anywhere else.</p></div>
          <${Segmented} size="sm" value=${mode} onChange=${setMode} options=${[{ value: 'docs', label: 'Documents' }, { value: 'json', label: 'JSON' }]} />
          <button class="icon-btn" aria-label="Close" onClick=${onClose} disabled=${running}><${Icon} name="x" size=${16} /></button>
        </header>

        <div class="jx-body">
          <div class="jx-source">
            ${mode === 'docs' ? html`
              ${!files.length ? html`<button class="jx-drop" onClick=${choose}>
                <span class="jx-drop-icon"><${Icon} name="upload" size=${22} /></span>
                <b>Drop your Diarly export here</b>
                <span>Markdown or text files, as many as you like. Each one is read by your AI preset, one at a time — the file name is sent too, so dates in names are kept.</span>
                <span class="btn btn-sm">Choose files…</span>
              </button>` : html`<div class="jx-files">
                <div class="jx-files-head">
                  <span>${plural(files.length, 'document')}${done ? ` · ${done} read` : ''}</span>
                  <button class="btn btn-sm btn-ghost" onClick=${choose} disabled=${running}><${Icon} name="plus" size=${13} />Add</button>
                  ${!running && html`<button class="btn btn-sm btn-ghost" onClick=${() => { setFiles([]); setResults({}); }}>Clear</button>`}
                </div>
                <div class="jx-file-list">
                  ${files.map((f) => html`<div key=${f.key} class=${cx('jx-file', `is-${f.status}`)}>
                    <span class="jx-file-status">${f.status === 'reading' ? html`<span class="spinner sm" />` : f.status === 'done' ? html`<${Icon} name="check" size=${13} stroke=${2.4} />` : f.status === 'failed' ? html`<${Icon} name="alert" size=${13} />` : html`<i />`}</span>
                    <span class="jx-file-name">${f.name}</span>
                    <span class="jx-file-meta" title=${f.error || ''}>${f.status === 'done' ? plural(f.count, 'day') : f.status === 'failed' ? 'Failed' : formatBytes(f.size)}</span>
                    ${f.status === 'failed' && !running && html`<button class="jx-retry" onClick=${() => setFile(f.key, { status: 'waiting' })}>Retry</button>`}
                  </div>`)}
                </div>
                <div class="jx-run">
                  ${preset && html`<span class="jx-preset"><${ProviderIcon} id=${preset.provider} size=${18} />${preset.name || preset.model}</span>`}
                  <span class="spacer" />
                  ${running ? html`<button class="btn btn-sm" onClick=${() => { stopRef.current = true; }}>Stop after this one</button>`
                    : pending > 0 && html`<button class="btn btn-sm btn-primary" onClick=${run}><${Icon} name="sparkle" size=${13} />${done ? `Read ${plural(pending, 'more document')}` : `Read ${plural(pending, 'document')} with AI`}</button>`}
                </div>
                ${running && html`<div class="jx-progress"><i style=${{ width: `${(done / files.length) * 100}%` }} /></div>`}
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
              <span class="muted">${entries.length ? `${chosen.length} of ${plural(entries.length, 'day')}` : 'Nothing yet'}</span>
            </div>
            <div class="jx-days">
              ${entries.map((e) => {
                const on = !excluded.has(e._key);
                const exists = existing.has(e.date);
                const mood = moodInfo(e.mood);
                return html`<label key=${e._key} class=${cx('jx-day', !on && 'is-off', !e.date && 'is-bad')}>
                  <input type="checkbox" checked=${on && !!e.date} disabled=${!e.date} onChange=${() => { const n = new Set(excluded); on ? n.add(e._key) : n.delete(e._key); setExcluded(n); }} />
                  <span class="jx-day-icon">${e.icon || '·'}</span>
                  <span class="jx-day-text">
                    <span class="jx-day-date">${e.date ? fmt(fromKey(e.date), 'fullYear') : 'No date found'}${exists && html`<em>${conflict === 'skip' ? 'skip' : conflict === 'replace' ? 'replace' : 'merge'}</em>`}</span>
                    <span class="jx-day-sub">${e.title || (e.text || '').slice(0, 90) || e._file || ''}</span>
                    <span class="jx-day-chips">
                      ${e.rating && html`<span>★ ${e.rating}</span>`}
                      ${mood && html`<span><i style=${{ background: mood.color }} />${mood.short}</span>`}
                      ${e.cards.slice(0, 4).map((c) => html`<span>${cardSummary(c).emoji} ${cardSummary(c).text}</span>`)}
                      ${foodCount(e) > 0 && html`<span>🍽️ ${foodCount(e)}</span>`}
                      ${e.people.length > 0 && html`<span>👥 ${e.people.slice(0, 3).join(', ')}</span>`}
                    </span>
                  </span>
                </label>`;
              })}
              ${!entries.length && html`<div class="jx-empty">Days you import show up here so you can check them first.</div>`}
            </div>
          </div>
        </div>

        <footer class="jx-foot">
          <button class="btn btn-sm btn-ghost" onClick=${copyGuide}><${Icon} name="copy" size=${13} />Copy LLM instructions</button>
          <span class="spacer" />
          <span class="jx-conflict-label">Days that exist</span>
          <${Segmented} size="sm" value=${conflict} onChange=${setConflict} options=${[{ value: 'merge', label: 'Merge' }, { value: 'replace', label: 'Replace' }, { value: 'skip', label: 'Skip' }]} />
          <button class="btn btn-primary" disabled=${!chosen.length || running} onClick=${commit}>Import ${chosen.length ? plural(chosen.length, 'day') : ''}</button>
        </footer>
      </div>
    </div>
  </${Portal}>`;
}
