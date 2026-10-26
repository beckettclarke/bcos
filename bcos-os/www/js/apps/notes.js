// Notes — folders, tags, pinning, search, templates, rich editing, note
// links with backlinks, an outline for long notes, focus mode, trash, and
// Markdown import/export.

import { html, useState, useEffect, useMemo, useRef } from '../lib/html.js';
import { useCollection, useSettings, setSettings, put, patch, remove, get, all } from '../lib/store.js';
import { timeAgo, listStamp, daysBetween, fmt, isToday } from '../lib/date.js';
import { cx, uid, plural, download, pickFile, splitMatch, isTyping, modKey } from '../lib/util.js';
import { startDrag } from '../lib/dnd.js';
import { Icon } from '../ui/icons.js';
import { IconButton, openMenu, openContextMenu, confirm, prompt, toast, useNarrow, EmptyState, useTick, Segmented } from '../ui/components.js';
import { RichEditor, digest, toMarkdown, fromMarkdown, refreshNoteLinks } from './editor.js';

const FOLDER_COLORS = ['#f2783c', '#8b5cf6', '#3b82f6', '#22c55e', '#ec4899', '#eab308', '#14b8a6', '#94a3b8'];

const TEMPLATES = [
  { id: 'blank', label: 'Blank note', icon: 'note', title: '', html: '<p><br></p>' },
  { id: 'meeting', label: 'Meeting notes', icon: 'user', title: 'Meeting — ', html: `<p><strong>When:</strong> ${'{date}'}<br><strong>Who:</strong> </p><h2>Agenda</h2><ol><li><br></li></ol><h2>Notes</h2><p><br></p><h2>Action items</h2><ul class="checklist"><li data-checked="false"><br></li></ul>` },
  { id: 'daily', label: 'Daily plan', icon: 'sun', title: 'Plan for {date}', html: '<h2>Top three</h2><ul class="checklist"><li data-checked="false"><br></li><li data-checked="false"><br></li><li data-checked="false"><br></li></ul><h2>Schedule</h2><ul><li><br></li></ul><h2>Notes</h2><p><br></p>' },
  { id: 'project', label: 'Project brief', icon: 'briefcase', title: 'Project: ', html: '<h2>Goal</h2><p><br></p><h2>Why it matters</h2><p><br></p><h2>Milestones</h2><ul class="checklist"><li data-checked="false"><br></li></ul><h2>Open questions</h2><ul><li><br></li></ul>' },
  { id: 'checklist', label: 'Checklist', icon: 'checklist', title: '', html: '<ul class="checklist"><li data-checked="false"><br></li></ul>' },
  { id: 'journal', label: 'Reflection', icon: 'pen', title: 'Reflection — {date}', html: '<h2>What went well</h2><p><br></p><h2>What was hard</h2><p><br></p><h2>What I learned</h2><p><br></p>' },
];

const fillDate = (s) => s.replaceAll('{date}', fmt(new Date(), 'monthDayYear'));

export function createNote({ folderId = null, template = 'blank', title } = {}) {
  const t = TEMPLATES.find((x) => x.id === template) || TEMPLATES[0];
  const body = fillDate(t.html);
  const n = { id: uid('n'), folderId, title: title ?? fillDate(t.title), html: body, pinned: false, trashed: false, ...digest(body) };
  return put('notes', n);
}

function saveBody(id, bodyHtml) {
  const cur = get('notes', id);
  if (!cur || cur.html === bodyHtml) return;
  put('notes', { ...cur, html: bodyHtml, ...digest(bodyHtml) });
}

function trashNote(n) {
  put('notes', { ...n, trashed: true, trashedAt: Date.now(), pinned: false });
  toast(`Moved “${n.title || 'Untitled'}” to Recently Deleted`, { icon: 'trash', action: { label: 'Undo', onClick: () => put('notes', { ...get('notes', n.id), trashed: false, trashedAt: null, pinned: n.pinned }) } });
}

function exportNote(n, kind = 'md') {
  const name = (n.title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-');
  if (kind === 'md') download(`${name}.md`, `# ${n.title || 'Untitled'}\n\n${toMarkdown(n.html)}`, 'text/markdown');
  else download(`${name}.html`, `<!doctype html><meta charset="utf-8"><title>${n.title}</title><style>body{font:16px/1.6 system-ui;max-width:680px;margin:40px auto;padding:0 20px}ul.checklist{list-style:none;padding-left:0}ul.checklist li::before{content:"☐ "}ul.checklist li[data-checked=true]::before{content:"☑ "}img{max-width:100%}</style><h1>${n.title}</h1>${n.html}`, 'text/html');
}

function noteMenu(n, folders, { onOpen } = {}) {
  if (n.trashed) return [
    { label: 'Restore', icon: 'restore', onSelect: () => put('notes', { ...n, trashed: false, trashedAt: null }) },
    { label: 'Delete permanently…', icon: 'trash', danger: true, onSelect: () => deleteForever([n]) },
  ];
  return [
    onOpen && { label: 'Open', icon: 'note', onSelect: onOpen },
    { label: n.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onSelect: () => put('notes', { ...n, pinned: !n.pinned }, { touch: false }) },
    { divider: true },
    { heading: 'Move to' },
    { label: 'No folder', icon: 'note', checked: !n.folderId, onSelect: () => put('notes', { ...n, folderId: null }, { touch: false }) },
    ...folders.map((f) => ({ label: f.name, swatch: f.color, checked: f.id === n.folderId, onSelect: () => put('notes', { ...n, folderId: f.id }, { touch: false }) })),
    { divider: true },
    { label: 'Duplicate', icon: 'copy', onSelect: () => put('notes', { ...n, id: uid('n'), title: `${n.title || 'Untitled'} copy`, pinned: false, createdAt: undefined }) },
    { label: 'Copy as Markdown', icon: 'file-down', onSelect: () => { navigator.clipboard?.writeText(toMarkdown(n.html)); toast('Copied as Markdown', { icon: 'copy' }); } },
    { label: 'Export Markdown', icon: 'download', onSelect: () => exportNote(n, 'md') },
    { label: 'Export HTML', icon: 'download', onSelect: () => exportNote(n, 'html') },
    { divider: true },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => trashNote(n) },
  ].filter(Boolean);
}

async function deleteForever(notes) {
  const ok = await confirm({ title: notes.length === 1 ? 'Delete this note forever?' : `Delete ${notes.length} notes forever?`, body: 'This can’t be undone.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  notes.forEach((n) => remove('notes', n.id));
}

function dateGroup(ms) {
  const d = daysBetween(ms, Date.now());
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return 'Previous 7 days';
  if (d < 30) return 'Previous 30 days';
  return fmt(ms, 'monthYear');
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function NotesApp({ intent, nonce }) {
  const s = useSettings();
  const narrow = useNarrow();
  const notes = useCollection('notes');
  const foldersRaw = useCollection('folders');
  const folders = useMemo(() => [...foldersRaw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [foldersRaw]);
  const [scope, setScope] = useState({ kind: 'all' }); // all | folder | tag | trash
  const [activeId, setActiveId] = useState(null);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(false);
  const [mobilePane, setMobilePane] = useState('list');
  const [showSide, setShowSide] = useState(false);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  useTick(30000);

  const sort = s.notes.sort || 'edited';
  const view = s.notes.view || 'list';

  const inScope = useMemo(() => notes.filter((n) => {
    if (scope.kind === 'trash') return n.trashed;
    if (n.trashed) return false;
    if (scope.kind === 'folder') {
      const kids = folders.filter((f) => f.parentId === scope.id).map((f) => f.id);
      return n.folderId === scope.id || kids.includes(n.folderId);
    }
    if (scope.kind === 'tag') return (n.tags || []).includes(scope.tag);
    if (scope.kind === 'pinned') return n.pinned;
    return true;
  }), [notes, scope, folders]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    let list = q ? inScope.filter((n) => (n.title || '').toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q) || (n.tags || []).some((t) => `#${t}`.includes(q))) : inScope;
    const by = sort === 'title' ? (a, b) => (a.title || '').localeCompare(b.title || '') : sort === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => b.updatedAt - a.updatedAt;
    list = [...list].sort(by);
    if (scope.kind !== 'trash') list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return list;
  }, [inScope, q, sort, scope.kind]);

  const active = activeId ? notes.find((n) => n.id === activeId) : null;

  // Keep a note selected on wide screens.
  useEffect(() => {
    if (narrow) return;
    if (!active || (!shown.includes(active) && !q)) setActiveId(shown[0]?.id || null);
  }, [scope, shown.length, narrow]);

  const openNote = (id) => {
    const n = get('notes', id);
    if (!n) return;
    if (!inScope.includes(n)) setScope(n.trashed ? { kind: 'trash' } : { kind: 'all' });
    setActiveId(id);
    setMobilePane('editor');
  };

  const newNote = (template = 'blank', title) => {
    const folderId = scope.kind === 'folder' ? scope.id : null;
    if (scope.kind === 'trash' || scope.kind === 'tag' || scope.kind === 'pinned') setScope({ kind: 'all' });
    const n = createNote({ folderId, template, title });
    if (scope.kind === 'tag') put('notes', { ...n, html: `${n.html}<p>#${scope.tag}</p>`, ...digest(`${n.html}<p>#${scope.tag}</p>`) });
    setQuery('');
    setActiveId(n.id);
    setMobilePane('editor');
    setTimeout(() => document.querySelector('.note-title-input')?.focus(), 80);
  };

  // --- intents ---
  useEffect(() => {
    if (!intent) return;
    if (intent.type === 'note') openNote(intent.id);
    if (intent.type === 'new') setTimeout(() => newNote('blank', intent.title || ''), 250);
  }, [nonce]);

  // --- keyboard ---
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); newNote(); return; }
      if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setFocus((f) => !f); return; }
      if (isTyping(e) || mod || document.querySelector('.popover')) return;
      const idx = shown.findIndex((n) => n.id === activeId);
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveId(shown[Math.min(shown.length - 1, idx + 1)]?.id || activeId); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveId(shown[Math.max(0, idx - 1)]?.id || activeId); }
      if ((e.key === 'Backspace' || e.key === 'Delete') && active && !active.trashed) { e.preventDefault(); trashNote(active); setActiveId(shown[idx + 1]?.id || shown[idx - 1]?.id || null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDropNote = ({ id, target }) => {
    const n = get('notes', id);
    if (!n || !target) return false;
    if (target === 'trash') { trashNote(n); return true; }
    if (target === 'all') { put('notes', { ...n, folderId: null, trashed: false }, { touch: false }); return true; }
    if (target === 'pinned') { put('notes', { ...n, pinned: true }, { touch: false }); return true; }
    if (target.startsWith('folder:')) {
      const f = get('folders', target.slice(7));
      put('notes', { ...n, folderId: f.id, trashed: false }, { touch: false });
      toast(`Moved to ${f.name}`, { icon: 'folder' });
      return true;
    }
    return false;
  };

  const pickScope = (sc) => { setScope(sc); setQuery(''); setShowSide(false); setMobilePane('list'); };
  const scopeTitle = scope.kind === 'all' ? 'All Notes' : scope.kind === 'trash' ? 'Recently Deleted' : scope.kind === 'pinned' ? 'Pinned' : scope.kind === 'tag' ? `#${scope.tag}` : folders.find((f) => f.id === scope.id)?.name || 'Folder';

  return html`<div ref=${rootRef} class=${cx('app notes', focus && 'is-focus', view === 'gallery' && 'is-gallery', showSide && 'show-side', narrow && `pane-${mobilePane}`)}>
    <${NotesSidebar} scope=${scope} pick=${pickScope} notes=${notes} folders=${folders} />

    <section class="notes-list-pane">
      <header class="notes-list-head">
        <${IconButton} class="back-btn" icon="sidebar" label="Folders" onClick=${() => setShowSide(!showSide)} />
        <div class="notes-list-title">
          <h1>${scopeTitle}</h1>
          <span>${plural(shown.length, 'note')}</span>
        </div>
        <div class="spacer" />
        ${scope.kind === 'trash'
          ? shown.length > 0 && html`<button class="btn btn-sm btn-danger" onClick=${() => deleteForever(shown)}>Empty</button>`
          : html`<${IconButton} icon="more" label="View options" onClick=${(e) => openMenu(e.currentTarget, [
              { heading: 'View' },
              { label: 'List', icon: 'list', checked: view === 'list', onSelect: () => setSettings({ notes: { view: 'list' } }) },
              { label: 'Gallery', icon: 'grid', checked: view === 'gallery', onSelect: () => setSettings({ notes: { view: 'gallery' } }) },
              { divider: true },
              { heading: 'Sort by' },
              { label: 'Date edited', checked: sort === 'edited', onSelect: () => setSettings({ notes: { sort: 'edited' } }) },
              { label: 'Date created', checked: sort === 'created', onSelect: () => setSettings({ notes: { sort: 'created' } }) },
              { label: 'Title', checked: sort === 'title', onSelect: () => setSettings({ notes: { sort: 'title' } }) },
              { divider: true },
              { label: 'Import Markdown…', icon: 'file-up', onSelect: async () => {
                const file = await pickFile('.md,.markdown,.txt,text/markdown,text/plain');
                if (!file) return;
                const text = await file.text();
                const titleLine = text.match(/^#\s+(.+)$/m);
                const body = fromMarkdown(titleLine ? text.replace(titleLine[0], '') : text);
                const n = put('notes', { id: uid('n'), folderId: scope.kind === 'folder' ? scope.id : null, title: titleLine ? titleLine[1].trim() : file.name.replace(/\.(md|markdown|txt)$/i, ''), html: body, pinned: false, trashed: false, ...digest(body) });
                setActiveId(n.id);
                toast('Imported note', { icon: 'file-up' });
              } },
            ], { placement: 'bottom-end' })} />
            <div class="split-btn">
              <button class="btn btn-sm btn-primary" onClick=${() => newNote()} title=${`New note (${modKey}N)`}><${Icon} name="compose" size=${15} /></button>
              <button class="btn btn-sm btn-primary split-caret" aria-label="New from template" onClick=${(e) => openMenu(e.currentTarget, [
                { heading: 'New from template' },
                ...TEMPLATES.map((t) => ({ label: t.label, icon: t.icon, onSelect: () => newNote(t.id) })),
              ], { placement: 'bottom-end' })}><${Icon} name="chevron-down" size=${13} /></button>
            </div>`}
      </header>
      <div class="search-field notes-search">
        <${Icon} name="search" size=${14} />
        <input ref=${searchRef} class="field field-sm" placeholder="Search notes" value=${query} onInput=${(e) => setQuery(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } if (e.key === 'Enter' && shown[0]) openNote(shown[0].id); }} />
      </div>
      <${NoteList} notes=${shown} activeId=${activeId} query=${q} folders=${folders} view=${view} trash=${scope.kind === 'trash'}
        onOpen=${openNote} onDrop=${onDropNote} root=${rootRef} />
    </section>

    <section class="notes-editor-pane">
      ${active
        ? html`<${NoteEditor} key=${active.id} note=${active} folders=${folders} focus=${focus} setFocus=${setFocus} onOpenNote=${openNote}
            onBack=${() => setMobilePane('list')} narrow=${narrow} font=${s.notes.font || 'sans'} />`
        : html`<${EmptyState} icon="note" title=${scope.kind === 'trash' ? 'Nothing deleted' : 'No note selected'} body=${scope.kind === 'trash' ? 'Deleted notes stay here until you empty them.' : 'Pick a note, or start a new one.'}>
            ${scope.kind !== 'trash' && html`<button class="btn btn-primary" onClick=${() => newNote()}><${Icon} name="compose" size=${15} />New note</button>`}
          </${EmptyState}>`}
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function NotesSidebar({ scope, pick, notes, folders }) {
  const live = notes.filter((n) => !n.trashed);
  const tags = useMemo(() => {
    const m = new Map();
    for (const n of live) for (const t of n.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);
  const [open, setOpen] = useState(() => new Set());
  const count = (fid) => live.filter((n) => n.folderId === fid || folders.some((f) => f.parentId === fid && f.id === n.folderId)).length;
  const top = folders.filter((f) => !f.parentId);

  const newFolder = async (parentId = null) => {
    const name = await prompt({ title: parentId ? 'New subfolder' : 'New folder', placeholder: 'Folder name', confirmLabel: 'Create' });
    if (!name?.trim()) return;
    const f = put('folders', { id: uid('fold'), name: name.trim(), parentId, color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length], order: folders.length });
    if (parentId) setOpen((o) => new Set(o).add(parentId));
    pick({ kind: 'folder', id: f.id });
  };

  const folderMenu = (f) => [
    { label: 'Rename…', icon: 'edit', onSelect: async () => { const n = await prompt({ title: 'Rename folder', value: f.name }); if (n?.trim()) put('folders', { ...f, name: n.trim() }); } },
    !f.parentId && { label: 'New subfolder…', icon: 'folder-plus', onSelect: () => newFolder(f.id) },
    { label: 'Colour', icon: 'palette', onSelect: () => setTimeout(() => openMenu(document.querySelector(`[data-dnd-target="folder:${f.id}"]`), FOLDER_COLORS.map((c) => ({ label: c === f.color ? 'Current' : ' ', swatch: c, onSelect: () => put('folders', { ...f, color: c }) })), { placement: 'right-start', width: 120 }), 0) },
    { divider: true },
    { label: 'Delete folder…', icon: 'trash', danger: true, onSelect: async () => {
      const inside = live.filter((n) => n.folderId === f.id);
      const kids = folders.filter((x) => x.parentId === f.id);
      const ok = await confirm({ title: `Delete “${f.name}”?`, body: inside.length ? `Its ${plural(inside.length, 'note')} will move to Recently Deleted.` : 'The folder is empty.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      inside.forEach((n) => put('notes', { ...n, trashed: true, trashedAt: Date.now() }));
      kids.forEach((k) => put('folders', { ...k, parentId: null }));
      remove('folders', f.id);
      pick({ kind: 'all' });
    } },
  ].filter(Boolean);

  const folderRow = (f, depth = 0) => {
    const kids = folders.filter((x) => x.parentId === f.id);
    const isOpen = open.has(f.id);
    return html`<div key=${f.id}>
      <button data-dnd-target=${`folder:${f.id}`} class=${cx('side-item folder-item', scope.kind === 'folder' && scope.id === f.id && 'is-active')} style=${{ paddingLeft: `${10 + depth * 16}px`, '--item-color': f.color }}
        onClick=${() => pick({ kind: 'folder', id: f.id })} onContextMenu=${(e) => openContextMenu(e, folderMenu(f))}>
        ${kids.length ? html`<span class="folder-caret" onClick=${(e) => { e.stopPropagation(); setOpen((o) => { const n = new Set(o); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; }); }}><${Icon} name=${isOpen ? 'chevron-down' : 'chevron-right'} size=${12} /></span>` : null}
        <${Icon} name="folder" size=${16} style=${{ color: f.color }} />
        <span class="name">${f.name}</span>
        <span class="count">${count(f.id) || ''}</span>
      </button>
      ${isOpen && kids.map((k) => folderRow(k, depth + 1))}
    </div>`;
  };

  return html`<aside class="app-side notes-side">
    <div class="side-head"><span class="side-title">Notes</span></div>
    <div class="side-section">
      <button data-dnd-target="all" class=${cx('side-item', scope.kind === 'all' && 'is-active')} onClick=${() => pick({ kind: 'all' })}><${Icon} name="note" size=${16} /><span class="name">All Notes</span><span class="count">${live.length}</span></button>
      <button data-dnd-target="pinned" class=${cx('side-item', scope.kind === 'pinned' && 'is-active')} onClick=${() => pick({ kind: 'pinned' })}><${Icon} name="pin" size=${16} /><span class="name">Pinned</span><span class="count">${live.filter((n) => n.pinned).length || ''}</span></button>
    </div>
    <div class="side-section">
      <div class="side-label"><span>Folders</span><${IconButton} class="sm" icon="folder-plus" size=${15} label="New folder" onClick=${() => newFolder()} /></div>
      ${top.map((f) => folderRow(f))}
      ${!top.length && html`<div class="side-hint">Group notes into folders.</div>`}
    </div>
    ${tags.length > 0 && html`<div class="side-section">
      <div class="side-label"><span>Tags</span></div>
      <div class="tag-cloud">
        ${tags.map(([t, n]) => html`<button key=${t} class=${cx('tag-chip', scope.kind === 'tag' && scope.tag === t && 'is-on')} onClick=${() => pick(scope.kind === 'tag' && scope.tag === t ? { kind: 'all' } : { kind: 'tag', tag: t })}>#${t}<span>${n}</span></button>`)}
      </div>
    </div>`}
    <div class="side-foot">
      <button data-dnd-target="trash" class=${cx('side-item', scope.kind === 'trash' && 'is-active')} onClick=${() => pick({ kind: 'trash' })}><${Icon} name="trash" size=${16} /><span class="name">Recently Deleted</span><span class="count">${notes.filter((n) => n.trashed).length || ''}</span></button>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function Snippet({ text, query }) {
  const t = (text || '').slice(0, 220);
  if (!query) return t || 'No additional text';
  const i = t.toLowerCase().indexOf(query);
  const start = i > 40 ? i - 30 : 0;
  const [a, b, c] = splitMatch(t.slice(start), query);
  return html`${start ? '…' : ''}${a}${b && html`<mark>${b}</mark>`}${c}`;
}

function NoteList({ notes, activeId, query, folders, view, trash, onOpen, onDrop, root }) {
  if (!notes.length) {
    return html`<div class="notes-empty">${query ? `No notes match “${query}”.` : trash ? 'Recently Deleted is empty.' : 'No notes here yet.'}</div>`;
  }
  const folderOf = Object.fromEntries(folders.map((f) => [f.id, f]));
  const groups = [];
  for (const n of notes) {
    const g = n.pinned && !trash ? 'Pinned' : dateGroup(n.updatedAt);
    if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, items: [] });
    groups[groups.length - 1].items.push(n);
  }
  const drag = (e, n) => startDrag(e, { id: n.id, el: e.currentTarget, root: root.current, onDrop, onClick: () => onOpen(n.id) });

  return html`<div class=${cx('note-list', view === 'gallery' && 'is-gallery')}>
    ${groups.map((g) => html`<div class="note-group" key=${g.name}>
      <div class="note-group-name">${g.name === 'Pinned' && html`<${Icon} name="pin" size=${12} />`}${g.name}</div>
      <div class="note-group-items">
        ${g.items.map((n) => {
          const folder = folderOf[n.folderId];
          return html`<div key=${n.id} class=${cx('note-item', n.id === activeId && 'is-active')} data-dnd-id=${n.id}
            onPointerDown=${(e) => drag(e, n)} onContextMenu=${(e) => openContextMenu(e, noteMenu(n, folders, { onOpen: () => onOpen(n.id) }))}>
            ${view === 'gallery' && html`<div class="note-card-preview">${n.image ? html`<img src=${n.image} alt="" loading="lazy" />` : html`<p>${(n.text || '').slice(0, 260)}</p>`}</div>`}
            <div class="note-item-body">
              <div class="note-item-title">${n.title ? html`<${Snippet} text=${n.title} query=${query} />` : html`<span class="muted">Untitled</span>`}</div>
              <div class="note-item-line">
                <span class="note-item-date">${listStamp(n.updatedAt)}</span>
                ${view !== 'gallery' && html`<span class="note-item-snippet"><${Snippet} text=${n.text} query=${query} /></span>`}
              </div>
              ${(folder || n.checklist || (n.tags || []).length > 0) && html`<div class="note-item-meta">
                ${folder && html`<span class="note-item-folder"><${Icon} name="folder" size=${11} style=${{ color: folder.color }} />${folder.name}</span>`}
                ${n.checklist && html`<span class=${cx('note-item-check', n.checklist.done === n.checklist.total && 'is-done')}><${Icon} name="checklist" size=${11} />${n.checklist.done}/${n.checklist.total}</span>`}
                ${(n.tags || []).slice(0, 3).map((t) => html`<span class="note-item-tag">#${t}</span>`)}
              </div>`}
            </div>
            ${view !== 'gallery' && n.image && html`<img class="note-item-thumb" src=${n.image} alt="" loading="lazy" />`}
          </div>`;
        })}
      </div>
    </div>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Editor pane
// ---------------------------------------------------------------------------

function NoteEditor({ note, folders, focus, setFocus, onOpenNote, onBack, narrow, font }) {
  const [title, setTitle] = useState(note.title || '');
  const [headings, setHeadings] = useState([]);
  const titleTimer = useRef(0);
  const bodyRef = useRef(null);
  const folder = folders.find((f) => f.id === note.folderId);
  const words = (note.text || '').split(/\s+/).filter(Boolean).length;
  const backlinks = useCollection('notes').filter((n) => !n.trashed && n.id !== note.id && (n.links || []).includes(note.id));

  const latestTitle = useRef(note.title || '');
  const titlePending = useRef(false);
  const commitTitle = () => {
    clearTimeout(titleTimer.current);
    if (!titlePending.current) return;
    titlePending.current = false;
    const cur = get('notes', note.id);
    if (cur && cur.title !== latestTitle.current) put('notes', { ...cur, title: latestTitle.current });
  };
  const saveTitle = (v) => {
    latestTitle.current = v;
    titlePending.current = true;
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(commitTitle, 300);
  };
  useEffect(() => () => commitTitle(), []);
  // Keep link chips in other notes in step with renamed titles.
  useEffect(() => { refreshNoteLinks(bodyRef.current?.root?.()); }, [note.title]);

  const readOnly = note.trashed;

  return html`<div class=${cx('note-editor', `font-${font}`)}>
    <header class="note-bar">
      <${IconButton} class="back-btn" icon="arrow-left" label="Back to notes" onClick=${onBack} />
      ${!narrow && html`<${IconButton} icon=${focus ? 'minimize' : 'maximize'} label=${focus ? 'Exit focus mode' : 'Focus mode'} active=${focus} onClick=${() => setFocus(!focus)} />`}
      <div class="spacer" />
      ${!readOnly && html`
        <button class="chip note-folder-chip" onClick=${(e) => openMenu(e.currentTarget, [
          { heading: 'Move to' },
          { label: 'No folder', icon: 'note', checked: !note.folderId, onSelect: () => put('notes', { ...note, folderId: null }, { touch: false }) },
          ...folders.map((f) => ({ label: f.name, swatch: f.color, checked: f.id === note.folderId, onSelect: () => put('notes', { ...note, folderId: f.id }, { touch: false }) })),
        ], { placement: 'bottom-end' })}><${Icon} name="folder" size=${13} style=${folder ? { color: folder.color } : null} />${folder ? folder.name : 'No folder'}</button>
        <${IconButton} icon="pin" label=${note.pinned ? 'Unpin' : 'Pin'} active=${note.pinned} onClick=${() => put('notes', { ...note, pinned: !note.pinned }, { touch: false })} />
        <${IconButton} icon="more" label="Note options" onClick=${(e) => openMenu(e.currentTarget, [
          { heading: 'Font' },
          ...[['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']].map(([id, label]) => ({ label, checked: font === id, onSelect: () => setSettings({ notes: { font: id } }) })),
          { divider: true },
          ...noteMenu(note, folders),
          { label: 'Print', icon: 'printer', onSelect: () => window.print() },
        ], { placement: 'bottom-end' })} />`}
    </header>

    ${readOnly && html`<div class="note-trash-banner">
      <${Icon} name="trash" size=${15} />
      <span>This note is in Recently Deleted.</span>
      <button class="btn btn-sm" onClick=${() => put('notes', { ...note, trashed: false, trashedAt: null })}><${Icon} name="restore" size=${14} />Restore</button>
      <button class="btn btn-sm btn-danger" onClick=${() => deleteForever([note])}>Delete forever</button>
    </div>`}

    <div class="note-scroll">
      <div class="note-doc">
        <input class="note-title-input" value=${title} placeholder="Title" readOnly=${readOnly}
          onInput=${(e) => { setTitle(e.target.value); saveTitle(e.target.value); }}
          onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); bodyRef.current?.focus(); } }} aria-label="Note title" />
        <div class="note-meta">
          <span>Edited ${timeAgo(note.updatedAt)}</span>
          <span>${plural(words, 'word')}</span>
          <span>${Math.max(1, Math.round(words / 230))} min read</span>
          ${(note.tags || []).map((t) => html`<span class="note-tag">#${t}</span>`)}
        </div>
        <${RichEditor} docKey=${note.id} html=${note.html} toolbar=${!readOnly} readOnly=${readOnly}
          placeholder="Start writing… type / for blocks, [[ to link a note"
          onChange=${(h, key) => saveBody(key, h)} onOpenNote=${onOpenNote} onHeadings=${setHeadings}
          onReady=${(api) => { bodyRef.current = api; }} />
        ${backlinks.length > 0 && html`<div class="backlinks">
          <div class="backlinks-title"><${Icon} name="note-link" size=${14} />Linked from ${plural(backlinks.length, 'note')}</div>
          ${backlinks.map((b) => html`<button key=${b.id} class="backlink" onClick=${() => onOpenNote(b.id)}>
            <span class="backlink-title">${b.title || 'Untitled'}</span>
            <span class="backlink-snippet">${(b.text || '').slice(0, 120)}</span>
          </button>`)}
        </div>`}
      </div>
      ${headings.length >= 2 && !narrow && html`<nav class="note-outline" aria-label="Contents">
        <div class="note-outline-title">Contents</div>
        ${headings.map((h) => html`<button key=${h.i} class=${`lvl-${h.level}`} onClick=${() => {
          h.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          h.el.classList.add('flash');
          setTimeout(() => h.el.classList.remove('flash'), 1200);
        }}>${h.text}</button>`)}
      </nav>`}
    </div>
  </div>`;
}
