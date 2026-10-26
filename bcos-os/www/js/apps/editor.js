// The rich text editor used by Notes and Journal.
//
// It edits real HTML in a contenteditable, kept to a small, sanitised set of
// tags. Markdown works as you type (# heading, - list, [] checklist, > quote,
// ``` code, --- divider, **bold**, `code`), "/" opens a block menu, "[[" links
// another note, and selecting text shows a formatting bubble.

import { html, useState, useEffect, useRef, useLayoutEffect } from '../lib/html.js';
import { cx, escapeHtml, downscaleImage, modKey } from '../lib/util.js';
import { uploadImage, all } from '../lib/store.js';
import { fmt } from '../lib/date.js';
import { Icon } from '../ui/icons.js';
import { Portal, Popover, toast, openMenu } from '../ui/components.js';

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

const KEEP = new Set(['P', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'BR', 'IMG', 'STRONG', 'EM', 'U', 'S', 'CODE', 'MARK', 'A']);
const RENAME = { B: 'STRONG', I: 'EM', STRIKE: 'S', DEL: 'S', H4: 'H3', H5: 'H3', H6: 'H3', DIV: 'P', SECTION: 'P', ARTICLE: 'P' };
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'HEAD', 'TITLE']);
const SAFE_URL = /^(https?:|mailto:|#$)/i;
const SAFE_IMG = /^(https?:|data:image\/(png|jpe?g|gif|webp);|api\/files\/|\/api\/files\/)/i;

export function sanitize(dirty) {
  const doc = new DOMParser().parseFromString(`<body>${dirty || ''}</body>`, 'text/html');
  const out = document.createElement('div');
  const walk = (src, dst) => {
    for (const node of [...src.childNodes]) {
      if (node.nodeType === 3) { dst.appendChild(document.createTextNode(node.nodeValue)); continue; }
      if (node.nodeType !== 1) continue;
      let tag = node.nodeName;
      if (DROP.has(tag)) continue;
      tag = RENAME[tag] || tag;
      if (node.nodeName === 'SPAN' && /font-weight:\s*(bold|[6-9]00)/.test(node.getAttribute('style') || '')) tag = 'STRONG';
      if (!KEEP.has(tag)) { walk(node, dst); continue; }
      const el = document.createElement(tag);
      if (tag === 'A') {
        const note = node.getAttribute('data-note');
        const href = node.getAttribute('href') || '';
        if (note) { el.setAttribute('data-note', note); el.setAttribute('href', '#'); el.setAttribute('contenteditable', 'false'); el.className = 'note-link'; }
        else if (SAFE_URL.test(href)) el.setAttribute('href', href);
        else { walk(node, dst); continue; }
      }
      if (tag === 'IMG') {
        const src = node.getAttribute('src') || '';
        if (!SAFE_IMG.test(src)) continue;
        el.setAttribute('src', src);
        el.setAttribute('alt', node.getAttribute('alt') || '');
      }
      if (tag === 'UL' && (node.classList.contains('checklist') || node.getAttribute('data-type') === 'checklist')) el.className = 'checklist';
      if (tag === 'LI' && node.closest && (node.parentNode?.classList?.contains('checklist') || node.hasAttribute('data-checked'))) el.setAttribute('data-checked', node.getAttribute('data-checked') === 'true' ? 'true' : 'false');
      dst.appendChild(el);
      if (tag !== 'IMG' && tag !== 'HR' && tag !== 'BR') walk(node, el);
    }
  };
  walk(doc.body, out);
  // Bare text at the top level belongs in a paragraph.
  let p = null;
  for (const node of [...out.childNodes]) {
    const inline = node.nodeType === 3 || /^(STRONG|EM|U|S|CODE|MARK|A|BR|IMG)$/.test(node.nodeName);
    if (inline) {
      if (node.nodeType === 3 && !node.nodeValue.trim() && !p) { node.remove(); continue; }
      if (!p) { p = document.createElement('p'); out.insertBefore(p, node); }
      p.appendChild(node);
    } else p = null;
  }
  return out.innerHTML;
}

// ---------------------------------------------------------------------------
// Markdown in and out
// ---------------------------------------------------------------------------

function inlineMd(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  t = t.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\[\[([^\]]+)\]\]/g, (m, title) => {
    const n = all('notes').find((x) => !x.trashed && (x.title || '').toLowerCase() === title.trim().toLowerCase());
    return n ? `<a data-note="${n.id}" href="#">${escapeHtml(n.title)}</a>` : m;
  });
  return t;
}

export function fromMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = Math.min(3, h[1].length); out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inlineMd(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s/.test(lines[i])) {
        const m = lines[i++].match(/^\s*[-*+]\s+\[([ xX])\]\s(.*)$/);
        buf.push(`<li data-checked="${m[1] !== ' '}">${inlineMd(m[2])}</li>`);
      }
      out.push(`<ul class="checklist">${buf.join('')}</ul>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(`<li>${inlineMd(lines[i++].replace(/^\s*[-*+]\s+/, ''))}</li>`);
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(`<li>${inlineMd(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inlineMd).join('<br>')}</p>`);
  }
  return sanitize(out.join(''));
}

export function looksLikeMarkdown(text) {
  return /(^|\n)(#{1,3}\s|[-*+]\s|\d+\.\s|>\s|```|[-*+]\s\[[ x]\])/.test(text) || /\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text);
}

export function toMarkdown(htmlStr) {
  const root = document.createElement('div');
  root.innerHTML = htmlStr;
  const inline = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.nodeValue.replace(/​/g, '');
    if (n.nodeType !== 1) return '';
    const inner = inline(n);
    switch (n.nodeName) {
      case 'STRONG': return `**${inner}**`;
      case 'EM': return `*${inner}*`;
      case 'S': return `~~${inner}~~`;
      case 'U': return inner;
      case 'CODE': return `\`${inner}\``;
      case 'MARK': return `==${inner}==`;
      case 'A': return n.dataset.note ? `[[${inner}]]` : `[${inner}](${n.getAttribute('href')})`;
      case 'IMG': return `![${n.getAttribute('alt') || ''}](${n.getAttribute('src')})`;
      case 'BR': return '\n';
      default: return inner;
    }
  }).join('');
  const block = (node, depth = 0) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.nodeValue.trim() ? n.nodeValue : '';
    if (n.nodeType !== 1) return '';
    const pad = '  '.repeat(depth);
    switch (n.nodeName) {
      case 'H1': return `# ${inline(n)}\n\n`;
      case 'H2': return `## ${inline(n)}\n\n`;
      case 'H3': return `### ${inline(n)}\n\n`;
      case 'BLOCKQUOTE': return `> ${inline(n)}\n\n`;
      case 'PRE': return `\`\`\`\n${n.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
      case 'HR': return '---\n\n';
      case 'UL':
      case 'OL': {
        const check = n.classList.contains('checklist');
        const items = [...n.children].map((li, i) => {
          const sub = [...li.children].filter((c) => c.nodeName === 'UL' || c.nodeName === 'OL');
          const clone = li.cloneNode(true);
          clone.querySelectorAll('ul,ol').forEach((x) => x.remove());
          const marker = check ? `- [${li.dataset.checked === 'true' ? 'x' : ' '}]` : n.nodeName === 'OL' ? `${i + 1}.` : '-';
          return `${pad}${marker} ${inline(clone).trim()}\n${sub.map((s) => block({ childNodes: [s] }, depth + 1)).join('')}`;
        }).join('');
        return depth ? items : `${items}\n`;
      }
      default: { const t = inline(n).trim(); return t ? `${t}\n\n` : ''; }
    }
  }).join('');
  return block(root).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Plain text and derived facts for search, lists and backlinks. */
export function digest(htmlStr) {
  const root = document.createElement('div');
  root.innerHTML = htmlStr;
  root.querySelectorAll('li, p, h1, h2, h3, blockquote, pre').forEach((el) => el.append(' '));
  const text = root.textContent.replace(/​/g, '').replace(/\s+/g, ' ').trim();
  const tags = [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{1,40})/gu)].map((m) => m[1].toLowerCase()))].filter((t) => !/^\d+$/.test(t));
  const links = [...new Set([...root.querySelectorAll('a[data-note]')].map((a) => a.dataset.note))];
  const image = root.querySelector('img')?.getAttribute('src') || null;
  const checks = root.querySelectorAll('ul.checklist > li');
  const checked = root.querySelectorAll('ul.checklist > li[data-checked="true"]');
  return { text, tags, links, image, checklist: checks.length ? { done: checked.length, total: checks.length } : null };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const BLOCK_RE = /^(P|H1|H2|H3|LI|BLOCKQUOTE|PRE|DIV)$/;

function blockOf(node, root) {
  while (node && node !== root) {
    if (node.nodeType === 1 && BLOCK_RE.test(node.nodeName)) return node;
    node = node.parentNode;
  }
  return null;
}

function caretRange() {
  const sel = window.getSelection();
  return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
}

function textBeforeCaret(block) {
  const r = caretRange();
  if (!r || !block) return '';
  const pre = document.createRange();
  pre.selectNodeContents(block);
  try { pre.setEnd(r.startContainer, r.startOffset); } catch { return ''; }
  return pre.toString();
}

/** A DOM range covering characters [start, end) of a block's text. */
function rangeFromOffsets(block, start, end) {
  const r = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node;
  let setStart = false;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!setStart && start <= pos + len) { r.setStart(node, start - pos); setStart = true; }
    if (setStart && end <= pos + len) { r.setEnd(node, end - pos); return r; }
    pos += len;
  }
  if (!setStart) r.setStart(block, 0);
  r.setEnd(block, block.childNodes.length);
  return r;
}

function deleteRange(range) {
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('delete');
}

function caretRect() {
  const r = caretRange();
  if (!r) return null;
  let rect = r.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height && !rect.top)) {
    const span = document.createElement('span');
    span.textContent = '​';
    const clone = r.cloneRange();
    clone.insertNode(span);
    rect = span.getBoundingClientRect();
    span.remove();
  }
  return { left: rect.left, right: rect.right || rect.left, top: rect.top, bottom: rect.bottom, width: rect.width || 1, height: rect.height || 18 };
}

const exec = (c, v = null) => document.execCommand(c, false, v);

function caretToEnd(block) {
  if (!block) return;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function markEmpty(root) {
  const empty = !root.textContent.replace(/\u200b/g, '').trim() && !root.querySelector('img, hr, li, pre, blockquote, h1, h2, h3');
  root.classList.toggle('is-empty', empty);
}

// ---------------------------------------------------------------------------
// Block commands
// ---------------------------------------------------------------------------

export const BLOCKS = [
  { id: 'p', label: 'Text', icon: 'type', hint: 'Plain paragraph', keys: 'text paragraph body' },
  { id: 'h1', label: 'Heading 1', icon: 'h1', hint: '#', keys: 'title heading h1' },
  { id: 'h2', label: 'Heading 2', icon: 'h2', hint: '##', keys: 'heading subtitle h2' },
  { id: 'h3', label: 'Heading 3', icon: 'h3', hint: '###', keys: 'heading h3 small' },
  { id: 'check', label: 'Checklist', icon: 'checklist', hint: '[]', keys: 'todo checklist task checkbox' },
  { id: 'ul', label: 'Bulleted list', icon: 'list', hint: '-', keys: 'bullet list unordered' },
  { id: 'ol', label: 'Numbered list', icon: 'list-ol', hint: '1.', keys: 'number ordered list' },
  { id: 'quote', label: 'Quote', icon: 'quote', hint: '>', keys: 'quote blockquote callout' },
  { id: 'code', label: 'Code block', icon: 'code-block', hint: '```', keys: 'code pre monospace' },
  { id: 'hr', label: 'Divider', icon: 'divider', hint: '---', keys: 'divider line separator hr' },
  { id: 'image', label: 'Image', icon: 'image', hint: 'Upload', keys: 'image photo picture upload' },
  { id: 'note', label: 'Link to a note', icon: 'note-link', hint: '[[', keys: 'link note page wiki' },
  { id: 'date', label: 'Today’s date', icon: 'calendar', hint: '', keys: 'date today' },
];

function currentBlockTag(root) {
  const b = blockOf(caretRange()?.startContainer, root);
  if (!b) return 'P';
  if (b.nodeName === 'LI') {
    const list = b.parentNode;
    return list.classList?.contains('checklist') ? 'CHECK' : list.nodeName;
  }
  return b.nodeName;
}

function setBlock(tag, root) {
  const cur = currentBlockTag(root);
  if (cur === 'UL' || cur === 'OL' || cur === 'CHECK') {
    exec(cur === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
  }
  const now = currentBlockTag(root);
  exec('formatBlock', `<${now === tag && tag !== 'P' ? 'p' : tag.toLowerCase()}>`);
}

function toggleList(kind, root) {
  const cur = currentBlockTag(root);
  if (kind === 'check') {
    if (cur === 'CHECK') { exec('insertUnorderedList'); return; }
    if (cur !== 'UL') exec('insertUnorderedList');
    const li = blockOf(caretRange()?.startContainer, root);
    const ul = li?.closest('ul');
    if (ul) {
      ul.classList.add('checklist');
      [...ul.children].forEach((x) => { if (!x.hasAttribute('data-checked')) x.setAttribute('data-checked', 'false'); });
    }
    return;
  }
  if (cur === 'CHECK' && kind === 'ul') {
    const ul = blockOf(caretRange()?.startContainer, root)?.closest('ul');
    ul?.classList.remove('checklist');
    ul?.querySelectorAll(':scope > li').forEach((x) => x.removeAttribute('data-checked'));
    return;
  }
  exec(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
}

function wrapInline(tag, root) {
  const r = caretRange();
  if (!r || r.collapsed) return;
  const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
  const existing = anc.closest(tag);
  if (existing && root.contains(existing)) {
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    existing.remove();
    return;
  }
  exec('insertHTML', `<${tag}>${escapeHtml(r.toString())}</${tag}>`);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * props: docKey, html, onChange(html), placeholder, toolbar, class,
 * onOpenNote(id), autofocus, readOnly, onReady(api)
 */
export function RichEditor({ docKey, html: source, onChange, placeholder = 'Start writing…', toolbar = false, class: cls, onOpenNote, autofocus, readOnly = false, onReady, onHeadings }) {
  const rootRef = useRef(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const headingsRef = useRef(onHeadings);
  headingsRef.current = onHeadings;
  const timer = useRef(0);
  const pending = useRef(false);
  const loadedKey = useRef(docKey);
  const [state, setState] = useState({ marks: {}, block: 'P' });
  const [bubble, setBubble] = useState(null);
  const [menu, setMenu] = useState(null); // { kind: 'slash'|'note', block, start, query, rect, active }
  const [linkPop, setLinkPop] = useState(null);
  const menuRef = useRef(null);
  menuRef.current = menu;

  // Changes are reported with the key of the document they belong to, so a
  // save that lands while switching documents can't write into the new one.
  const emit = (now = false) => {
    clearTimeout(timer.current);
    if (rootRef.current) markEmpty(rootRef.current);
    pending.current = true;
    const key = loadedKey.current;
    const flush = () => {
      pending.current = false;
      const root = rootRef.current;
      if (!root || readOnly) return;
      changeRef.current?.(sanitize(root.innerHTML), key);
      reportHeadings();
    };
    if (now) flush(); else timer.current = setTimeout(flush, 350);
  };

  const reportHeadings = () => {
    const root = rootRef.current;
    if (!root || !headingsRef.current) return;
    headingsRef.current([...root.querySelectorAll('h1, h2, h3')].map((h, i) => ({ i, level: +h.nodeName[1], text: h.textContent.trim(), el: h })).filter((h) => h.text));
  };

  // Load a document.
  useLayoutEffect(() => {
    const root = rootRef.current;
    loadedKey.current = docKey;
    root.innerHTML = sanitize(source) || '<p><br></p>';
    refreshNoteLinks(root);
    markEmpty(root);
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
    setMenu(null);
    setBubble(null);
    reportHeadings();
    if (autofocus) {
      requestAnimationFrame(() => {
        root.focus({ preventScroll: true });
        const r = document.createRange();
        r.selectNodeContents(root);
        r.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      });
    }
    return () => { if (pending.current) emit(true); };
  }, [docKey]);

  useEffect(() => {
    onReady?.({
      focus: () => rootRef.current?.focus(),
      insertHtml: (h) => { rootRef.current?.focus(); exec('insertHTML', h); emit(); },
      root: () => rootRef.current,
    });
  }, [docKey]);

  // Selection-driven UI: toolbar state and the formatting bubble.
  useEffect(() => {
    const onSel = () => {
      const root = rootRef.current;
      const sel = window.getSelection();
      if (!root || !sel.rangeCount || !root.contains(sel.anchorNode)) { setBubble(null); return; }
      const marks = {
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        strike: document.queryCommandState('strikeThrough'),
        code: !!(sel.anchorNode.parentElement?.closest('code')),
        mark: !!(sel.anchorNode.parentElement?.closest('mark')),
        link: !!(sel.anchorNode.parentElement?.closest('a')),
      };
      setState({ marks, block: currentBlockTag(root) });
      const r = sel.getRangeAt(0);
      if (!r.collapsed && r.toString().trim() && !readOnly) {
        const rect = r.getBoundingClientRect();
        setBubble({ top: rect.top, left: rect.left + rect.width / 2, bottom: rect.bottom });
      } else setBubble(null);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [readOnly]);

  // --- commands ---
  const run = (id) => {
    const root = rootRef.current;
    root.focus();
    switch (id) {
      case 'p': exec('formatBlock', '<p>'); if (['UL', 'OL', 'CHECK'].includes(currentBlockTag(root))) setBlock('P', root); break;
      case 'h1': setBlock('H1', root); break;
      case 'h2': setBlock('H2', root); break;
      case 'h3': setBlock('H3', root); break;
      case 'quote': setBlock('BLOCKQUOTE', root); break;
      case 'code': setBlock('PRE', root); break;
      case 'ul': toggleList('ul', root); break;
      case 'ol': toggleList('ol', root); break;
      case 'check': toggleList('check', root); break;
      case 'hr': exec('insertHTML', '<hr><p><br></p>'); break;
      case 'bold': exec('bold'); break;
      case 'italic': exec('italic'); break;
      case 'underline': exec('underline'); break;
      case 'strike': exec('strikeThrough'); break;
      case 'inline-code': wrapInline('code', root); break;
      case 'mark': wrapInline('mark', root); break;
      case 'date': exec('insertText', fmt(new Date(), 'fullYear')); break;
      case 'image': pickImage(); break;
      case 'note': exec('insertText', '[['); openNoteMenu(); break;
      case 'link': openLink(); break;
      case 'clear': exec('removeFormat'); exec('unlink'); break;
      default: break;
    }
    emit();
  };

  const openLink = () => {
    const r = caretRange();
    if (!r) return;
    const a = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)?.closest('a');
    const rect = r.collapsed && a ? a.getBoundingClientRect() : r.getBoundingClientRect();
    setLinkPop({ range: r.cloneRange(), rect, href: a?.getAttribute('href') || 'https://', existing: a || null });
  };

  const applyLink = (href) => {
    const { range, existing } = linkPop;
    setLinkPop(null);
    const root = rootRef.current;
    root.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (!href) { if (existing) { const t = document.createRange(); t.selectNode(existing); sel.removeAllRanges(); sel.addRange(t); exec('unlink'); } emit(); return; }
    const url = /^(https?:|mailto:)/i.test(href) ? href : `https://${href}`;
    if (existing) existing.setAttribute('href', url);
    else if (range.collapsed) exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(url.replace(/^https?:\/\//, ''))}</a>`);
    else exec('createLink', url);
    emit();
  };

  const insertImageFile = async (file) => {
    if (!file || !/^image\//.test(file.type)) return;
    try {
      const blob = file.type === 'image/gif' ? file : await downscaleImage(file, 1800, 0.85);
      const url = await uploadImage(blob);
      rootRef.current.focus();
      exec('insertHTML', `<p><img src="${escapeHtml(url)}" alt=""></p><p><br></p>`);
      emit();
    } catch (err) {
      toast('That image couldn’t be added', { icon: 'alert' });
    }
  };

  const pickImage = () => {
    const r = caretRange()?.cloneRange();
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = () => {
      if (r) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      insertImageFile(input.files?.[0]);
    };
    input.click();
  };

  const openNoteMenu = () => {
    const root = rootRef.current;
    const block = blockOf(caretRange()?.startContainer, root);
    const before = textBeforeCaret(block);
    setMenu({ kind: 'note', block, start: before.length - 2, query: '', rect: caretRect(), active: 0 });
  };

  // --- menu items ---
  const menuItems = () => {
    const m = menuRef.current;
    if (!m) return [];
    const q = m.query.toLowerCase();
    if (m.kind === 'slash') return BLOCKS.filter((b) => !q || b.label.toLowerCase().includes(q) || b.keys.includes(q));
    return all('notes').filter((n) => !n.trashed && (!q || (n.title || '').toLowerCase().includes(q))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
      .map((n) => ({ id: n.id, label: n.title || 'Untitled', icon: 'note', hint: '' }));
  };

  const chooseMenu = (item) => {
    const m = menuRef.current;
    if (!m || !item) return;
    setMenu(null);
    const root = rootRef.current;
    root.focus();
    const before = textBeforeCaret(m.block);
    deleteRange(rangeFromOffsets(m.block, m.start, before.length));
    if (m.kind === 'slash') run(item.id);
    else {
      exec('insertHTML', `<a data-note="${escapeHtml(item.id)}" href="#" contenteditable="false" class="note-link">${escapeHtml(item.label)}</a>&nbsp;`);
      emit();
    }
  };

  // --- input handling ---
  const onBeforeInput = (e) => {
    if (readOnly) { e.preventDefault(); return; }
  };

  const onInput = (e) => {
    const root = rootRef.current;
    if (!root.firstChild) root.innerHTML = '<p><br></p>';
    markEmpty(root);
    const block = blockOf(caretRange()?.startContainer, root);
    const type = e.inputType;
    const data = e.data;

    // New checklist items start unticked.
    if (type === 'insertParagraph' && block?.nodeName === 'LI' && block.parentNode.classList.contains('checklist')) block.setAttribute('data-checked', 'false');
    if (type === 'insertParagraph' && block && block.nodeName !== 'LI' && block.parentNode === root && /^(H1|H2|H3)$/.test(block.nodeName) && !block.textContent) {
      exec('formatBlock', '<p>');
    }

    if (type === 'insertText' && block) {
      const before = textBeforeCaret(block);
      // Where this input began; typing gives one character, autocorrect and
      // IMEs can insert a whole run at once.
      const insStart = before.length - (data || '').length;

      // Block markdown at the start of a line.
      if (block.nodeName === 'P' || block.nodeName === 'DIV' || block.nodeName === 'LI') {
        const m = before.match(/^(#{1,3}|[-*+]|1[.)]|\[ ?\]|\[[xX]\]|>) /);
        if (m && insStart <= m[1].length) {
          const mk = m[1];
          const cmd = mk.startsWith('#') ? `h${mk.length}` : /^[-*+]$/.test(mk) ? 'ul' : /^1/.test(mk) ? 'ol' : mk === '>' ? 'quote' : /x/i.test(mk) ? 'checkx' : 'check';
          if (block.nodeName !== 'LI' || cmd === 'check' || cmd === 'checkx') {
            deleteRange(rangeFromOffsets(block, 0, mk.length + 1));
            if (cmd === 'checkx') { run('check'); blockOf(caretRange()?.startContainer, root)?.setAttribute('data-checked', 'true'); }
            else run(cmd);
            caretToEnd(blockOf(caretRange()?.startContainer, root));
            return;
          }
        }
      }
      if (before.startsWith('```') && insStart <= 3 && block.nodeName !== 'PRE') {
        deleteRange(rangeFromOffsets(block, 0, 3));
        run('code');
        caretToEnd(blockOf(caretRange()?.startContainer, root));
        return;
      }

      // Inline markdown once its closing marker has been typed.
      if (block.nodeName !== 'PRE' && /[*~=`]/.test(data || '')) {
        const inline = [
          { re: /\*\*([^*\s][^*]*?)\*\*/g, tag: 'strong', len: 2 },
          { re: /~~([^~\s][^~]*?)~~/g, tag: 's', len: 2 },
          { re: /==([^=\s][^=]*?)==/g, tag: 'mark', len: 2 },
          { re: /`([^`\s][^`]*?)`/g, tag: 'code', len: 1 },
          { re: /(?:^|(?<=[^*\w]))\*([^*\s][^*]*?)\*(?!\*)/g, tag: 'em', len: 1 },
        ];
        for (const { re, tag, len } of inline) {
          const hits = [...before.matchAll(re)].filter((h) => h.index + h[0].length > insStart);
          const hit = hits[hits.length - 1];
          if (!hit) continue;
          const startAt = hit.index;
          const endAt = hit.index + hit[0].length;
          const tail = before.slice(endAt);
          deleteRange(rangeFromOffsets(block, startAt, before.length));
          exec('insertHTML', `<${tag}>${escapeHtml(hit[1])}</${tag}>\u200b${escapeHtml(tail)}`);
          void len;
          break;
        }
      }

      // Slash menu and note links.
      if (data === '/' && (before === '/' || /\s\/$/.test(before)) && block.nodeName !== 'PRE') {
        setMenu({ kind: 'slash', block, start: before.length - 1, query: '', rect: caretRect(), active: 0 });
      } else if (data === '[' && before.endsWith('[[')) {
        setMenu({ kind: 'note', block, start: before.length - 2, query: '', rect: caretRect(), active: 0 });
      }
    }

    const m = menuRef.current;
    if (m) {
      const before = textBeforeCaret(m.block);
      if (!m.block.isConnected || before.length <= m.start || (m.kind === 'slash' && /\s/.test(before.slice(m.start + 1)))) setMenu(null);
      else setMenu({ ...m, query: before.slice(m.start + (m.kind === 'slash' ? 1 : 2)), active: 0 });
    }
    emit();
  };

  const onKeyDown = (e) => {
    const root = rootRef.current;
    const mod = e.metaKey || e.ctrlKey;
    const m = menuRef.current;
    if (m) {
      const items = menuItems();
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu({ ...m, active: (m.active + 1) % Math.max(1, items.length) }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu({ ...m, active: (m.active - 1 + items.length) % Math.max(1, items.length) }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { if (items.length) { e.preventDefault(); chooseMenu(items[m.active]); return; } }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }

    if (mod) {
      const k = e.key.toLowerCase();
      const map = {
        k: 'link', e: 'inline-code',
        ...(e.shiftKey ? { x: 'strike', h: 'mark' } : {}),
      };
      if (e.shiftKey && e.code === 'Digit7') { e.preventDefault(); run('ol'); return; }
      if (e.shiftKey && e.code === 'Digit8') { e.preventDefault(); run('ul'); return; }
      if (e.shiftKey && e.code === 'Digit9') { e.preventDefault(); run('check'); return; }
      if (e.altKey && /^Digit[0-3]$/.test(e.code)) { e.preventDefault(); run(['p', 'h1', 'h2', 'h3'][+e.code.slice(5)]); return; }
      if (map[k]) { e.preventDefault(); run(map[k]); return; }
      if (k === 'b' || k === 'i' || k === 'u') { setTimeout(() => emit(), 0); }
    }

    const block = blockOf(caretRange()?.startContainer, root);
    if (e.key === 'Enter' && !e.shiftKey && block) {
      const text = block.textContent;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(text.trim()) && block.nodeName === 'P') {
        e.preventDefault();
        block.textContent = '';
        const r = document.createRange(); r.selectNodeContents(block); r.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        exec('insertHTML', '<hr><p><br></p>');
        emit();
        return;
      }
      // Enter on an empty line in a quote or code block leaves it.
      if ((block.nodeName === 'BLOCKQUOTE' && !text.trim()) || (block.nodeName === 'PRE' && /\n\n$/.test(text) && textBeforeCaret(block).length === text.length)) {
        e.preventDefault();
        if (block.nodeName === 'PRE') block.textContent = text.replace(/\n+$/, '');
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        block.after(p);
        if (block.nodeName === 'BLOCKQUOTE') block.remove();
        const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        emit();
        return;
      }
      if (block.nodeName === 'PRE') { e.preventDefault(); exec('insertText', '\n'); return; }
    }
    if (e.key === 'Backspace' && block && /^(H1|H2|H3|BLOCKQUOTE|PRE)$/.test(block.nodeName) && textBeforeCaret(block).length === 0 && caretRange()?.collapsed) {
      e.preventDefault();
      exec('formatBlock', '<p>');
      emit();
      return;
    }
    if (e.key === 'Tab') {
      if (block?.nodeName === 'LI') { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); emit(); return; }
      if (block?.nodeName === 'PRE') { e.preventDefault(); exec('insertText', '  '); return; }
    }
  };

  const onClick = (e) => {
    const root = rootRef.current;
    const note = e.target.closest('a[data-note]');
    if (note && root.contains(note)) { e.preventDefault(); onOpenNote?.(note.dataset.note); return; }
    const a = e.target.closest('a[href]');
    if (a && root.contains(a) && (e.metaKey || e.ctrlKey || readOnly)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
    const li = e.target.closest('ul.checklist > li');
    if (li && root.contains(li)) {
      const r = li.getBoundingClientRect();
      if (e.clientX < r.left + 2 && e.clientX > r.left - 30) {
        e.preventDefault();
        if (readOnly) return;
        li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
        li.classList.add('just-toggled');
        setTimeout(() => li.classList.remove('just-toggled'), 400);
        emit();
      }
    }
  };

  const onPaste = (e) => {
    if (readOnly) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const file = [...(cd.files || [])].find((f) => /^image\//.test(f.type));
    if (file) { e.preventDefault(); insertImageFile(file); return; }
    const htmlData = cd.getData('text/html');
    const text = cd.getData('text/plain');
    const block = blockOf(caretRange()?.startContainer, rootRef.current);
    if (block?.nodeName === 'PRE') { e.preventDefault(); exec('insertText', text); return; }
    if (htmlData) { e.preventDefault(); exec('insertHTML', sanitize(htmlData)); emit(); return; }
    if (text && looksLikeMarkdown(text)) { e.preventDefault(); exec('insertHTML', fromMarkdown(text)); emit(); return; }
    if (text) { e.preventDefault(); exec('insertText', text); }
  };

  const onDrop = (e) => {
    const file = [...(e.dataTransfer?.files || [])].find((f) => /^image\//.test(f.type));
    if (!file || readOnly) return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(pos); }
    insertImageFile(file);
  };

  const items = menu ? menuItems() : [];
  const b = state.block;

  return html`<div class=${cx('rich', cls, readOnly && 'is-readonly')}>
    ${toolbar && !readOnly && html`<div class="rich-toolbar" onMouseDown=${(e) => { if (e.target.closest('button')) e.preventDefault(); }}>
      <button class="rt-style" onClick=${(e) => openStyleMenu(e.currentTarget, b, run)}>${{ H1: 'Title', H2: 'Heading', H3: 'Subheading', PRE: 'Code', BLOCKQUOTE: 'Quote', UL: 'List', OL: 'Numbered', CHECK: 'Checklist' }[b] || 'Body'}<${Icon} name="chevron-down" size=${12} /></button>
      <span class="rt-sep" />
      ${[['bold', 'bold', `Bold (${modKey}B)`], ['italic', 'italic', `Italic (${modKey}I)`], ['underline', 'underline', `Underline (${modKey}U)`], ['strike', 'strike', 'Strikethrough'], ['mark', 'highlight', 'Highlight'], ['inline-code', 'code', `Code (${modKey}E)`]].map(([id, icon, label]) => html`
        <button class=${cx('rt-btn', state.marks[id === 'inline-code' ? 'code' : id] && 'is-on')} title=${label} aria-label=${label} onClick=${() => run(id)}><${Icon} name=${icon} size=${16} /></button>`)}
      <span class="rt-sep" />
      ${[['check', 'checklist', 'Checklist', 'CHECK'], ['ul', 'list', 'Bulleted list', 'UL'], ['ol', 'list-ol', 'Numbered list', 'OL'], ['quote', 'quote', 'Quote', 'BLOCKQUOTE']].map(([id, icon, label, tag]) => html`
        <button class=${cx('rt-btn', b === tag && 'is-on')} title=${label} aria-label=${label} onClick=${() => run(id)}><${Icon} name=${icon} size=${16} /></button>`)}
      <span class="rt-sep" />
      <button class=${cx('rt-btn', state.marks.link && 'is-on')} title=${`Link (${modKey}K)`} aria-label="Link" onClick=${() => run('link')}><${Icon} name="link" size=${16} /></button>
      <button class="rt-btn" title="Link to a note ([[)" aria-label="Link to a note" onClick=${() => run('note')}><${Icon} name="note-link" size=${16} /></button>
      <button class="rt-btn" title="Image" aria-label="Image" onClick=${() => run('image')}><${Icon} name="image" size=${16} /></button>
    </div>`}
    <div ref=${rootRef} class="rich-body" contenteditable=${readOnly ? 'false' : 'true'} spellcheck="true" data-placeholder=${placeholder}
      onBeforeInput=${onBeforeInput} onInput=${onInput} onKeyDown=${onKeyDown} onClick=${onClick} onPaste=${onPaste} onDrop=${onDrop}
      onBlur=${() => pending.current && emit(true)} role="textbox" aria-multiline="true" aria-label=${placeholder} />

    ${bubble && !menu && !linkPop && html`<${Portal}>
      <div class="rich-bubble" style=${{ left: `${bubble.left}px`, top: `${bubble.top}px` }} onMouseDown=${(e) => e.preventDefault()}>
        ${[['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strike', 'strike'], ['mark', 'highlight'], ['inline-code', 'code'], ['link', 'link']].map(([id, icon]) => html`
          <button class=${cx('rt-btn', state.marks[id === 'inline-code' ? 'code' : id] && 'is-on')} onClick=${() => run(id)} aria-label=${id}><${Icon} name=${icon} size=${15} /></button>`)}
        <span class="rt-sep" />
        <button class=${cx('rt-btn', b === 'H1' && 'is-on')} onClick=${() => run('h1')} aria-label="Title"><${Icon} name="h1" size=${15} /></button>
        <button class=${cx('rt-btn', b === 'H2' && 'is-on')} onClick=${() => run('h2')} aria-label="Heading"><${Icon} name="h2" size=${15} /></button>
        <button class=${cx('rt-btn', b === 'BLOCKQUOTE' && 'is-on')} onClick=${() => run('quote')} aria-label="Quote"><${Icon} name="quote" size=${15} /></button>
      </div>
    </${Portal}>`}

    ${menu && html`<${Portal}>
      <div class="rich-menu" style=${{ left: `${menu.rect.left}px`, top: `${menu.rect.bottom + 6}px` }} onMouseDown=${(e) => e.preventDefault()}>
        <div class="rich-menu-head">${menu.kind === 'slash' ? (menu.query ? `Blocks matching “${menu.query}”` : 'Insert block') : 'Link to note'}</div>
        ${items.length ? items.map((it, i) => html`<button key=${it.id} class=${cx('rich-menu-item', i === menu.active && 'is-active')}
          onMouseEnter=${() => setMenu({ ...menu, active: i })} onClick=${() => chooseMenu(it)}>
          <span class="rich-menu-icon"><${Icon} name=${it.icon} size=${16} /></span>
          <span class="rich-menu-label">${it.label}</span>
          ${it.hint && html`<span class="rich-menu-hint">${it.hint}</span>`}
        </button>`) : html`<div class="rich-menu-empty">${menu.kind === 'note' ? 'No notes match' : 'Nothing matches'}</div>`}
      </div>
    </${Portal}>`}

    ${linkPop && html`<${LinkPopover} ...${linkPop} onDone=${applyLink} onCancel=${() => { setLinkPop(null); rootRef.current?.focus(); }} />`}
  </div>`;
}

function LinkPopover({ rect, href, existing, onDone, onCancel }) {
  const [v, setV] = useState(href);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return html`<${Popover} anchor=${rect} onClose=${onCancel} placement="bottom-center" width=${300}>
    <form class="link-pop" onSubmit=${(e) => { e.preventDefault(); onDone(v.trim() === 'https://' ? '' : v.trim()); }}>
      <${Icon} name="link" size=${15} />
      <input ref=${ref} class="field field-sm" value=${v} onInput=${(e) => setV(e.target.value)} placeholder="Paste a link" />
      ${existing && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => onDone('')}>Remove</button>`}
      <button class="btn btn-sm btn-primary">${existing ? 'Update' : 'Add'}</button>
    </form>
  </${Popover}>`;
}

function openStyleMenu(anchor, current, run) {
  openMenu(anchor, [
    { label: 'Title', icon: 'h1', checked: current === 'H1', shortcut: '⌥⌘1', onSelect: () => run('h1') },
    { label: 'Heading', icon: 'h2', checked: current === 'H2', shortcut: '⌥⌘2', onSelect: () => run('h2') },
    { label: 'Subheading', icon: 'h3', checked: current === 'H3', shortcut: '⌥⌘3', onSelect: () => run('h3') },
    { label: 'Body', icon: 'type', checked: current === 'P', shortcut: '⌥⌘0', onSelect: () => run('p') },
    { divider: true },
    { label: 'Quote', icon: 'quote', checked: current === 'BLOCKQUOTE', onSelect: () => run('quote') },
    { label: 'Code block', icon: 'code-block', checked: current === 'PRE', onSelect: () => run('code') },
  ], { width: 220 });
}

/** Keep note-link chips showing each note's current title. */
export function refreshNoteLinks(root) {
  if (!root) return;
  const notes = new Map(all('notes').map((n) => [n.id, n]));
  root.querySelectorAll('a[data-note]').forEach((a) => {
    const n = notes.get(a.dataset.note);
    a.setAttribute('contenteditable', 'false');
    a.classList.add('note-link');
    a.classList.toggle('is-broken', !n || n.trashed);
    if (n && n.title && a.textContent !== n.title) a.textContent = n.title;
  });
}
