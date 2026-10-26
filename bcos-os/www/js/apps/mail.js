// Mail — mailboxes, threads of messages, a reader, and a compose window.
// It's a local mailbox for now: messages live in BCOS, and sending files a
// copy in Sent. Connecting a real account (IMAP/SMTP) is the next step.

import { html, useState, useEffect, useMemo, useRef } from '../lib/html.js';
import { useCollection, useSettings, put, patch, remove, get } from '../lib/store.js';
import { listStamp, fmt, fmtTime } from '../lib/date.js';
import { cx, uid, plural, isTyping, splitMatch, modKey } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { IconButton, Avatar, EmptyState, toast, useNarrow, openContextMenu, openMenu, confirm, useEscape } from '../ui/components.js';

const BOXES = [
  { id: 'inbox', name: 'Inbox', icon: 'inbox' },
  { id: 'starred', name: 'Starred', icon: 'star' },
  { id: 'sent', name: 'Sent', icon: 'send' },
  { id: 'drafts', name: 'Drafts', icon: 'compose' },
  { id: 'archive', name: 'Archive', icon: 'archive' },
  { id: 'trash', name: 'Trash', icon: 'trash' },
];

const inBox = (m, box) => box === 'starred' ? m.starred && m.mailbox !== 'trash' : m.mailbox === box;

function parseAddresses(str) {
  return str.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(.*?)\s*<([^>]+)>$/);
    return m ? { name: m[1].replace(/"/g, '').trim(), email: m[2].trim() } : { name: '', email: s };
  });
}
const fmtAddr = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);

function Linkified({ text }) {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/g);
  return parts.map((p, i) => (i % 2 ? html`<a href=${p} target="_blank" rel="noopener noreferrer">${p}</a>` : p));
}

function move(m, mailbox, label) {
  const before = m.mailbox;
  patch('mail', m.id, { mailbox });
  toast(label, { icon: mailbox === 'trash' ? 'trash' : 'archive', action: { label: 'Undo', onClick: () => patch('mail', m.id, { mailbox: before }) } });
}

export default function MailApp({ intent, nonce }) {
  useSettings();
  const narrow = useNarrow();
  const mail = useCollection('mail');
  const [box, setBox] = useState('inbox');
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');
  const [compose, setCompose] = useState(null);
  const [showSide, setShowSide] = useState(false);

  const counts = useMemo(() => Object.fromEntries(BOXES.map((b) => [b.id, mail.filter((m) => inBox(m, b.id) && (b.id === 'drafts' || !m.read)).length])), [mail]);
  const q = query.trim().toLowerCase();
  const list = useMemo(() => mail
    .filter((m) => (q ? m.mailbox !== 'trash' || box === 'trash' : inBox(m, box)))
    .filter((m) => !q || [m.subject, m.body, m.from?.name, m.from?.email, ...(m.to || []).map((t) => t.name + t.email)].some((x) => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date - a.date), [mail, box, q]);
  const open = openId ? mail.find((m) => m.id === openId) : null;

  const select = (m) => {
    if (m.mailbox === 'drafts') { setCompose({ draftId: m.id, to: (m.to || []).map(fmtAddr).join(', '), subject: m.subject, body: m.body }); return; }
    setOpenId(m.id);
    if (!m.read) patch('mail', m.id, { read: true });
  };

  // Keep something open on wide screens.
  useEffect(() => {
    if (narrow) return;
    if (!open || !list.includes(open)) {
      const first = list.find((m) => m.mailbox !== 'drafts');
      setOpenId(first?.id || null);
      if (first && !first.read) patch('mail', first.id, { read: true });
    }
  }, [box, list.length, narrow]);

  useEffect(() => {
    if (!intent) return;
    if (intent.type === 'compose') setCompose({ to: '', subject: '', body: '' });
    if (intent.type === 'mailbox') setBox(intent.id);
    if (intent.type === 'message') { const m = get('mail', intent.id); if (m) { setBox(m.mailbox); select(m); } }
  }, [nonce]);

  const reply = (m, all = false) => {
    const me = 'beckett@bcos.local';
    const to = [m.from, ...(all ? (m.to || []) : [])].filter((a) => a && a.email !== me);
    setCompose({
      to: to.map(fmtAddr).join(', '),
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      body: `\n\nOn ${fmt(m.date, 'monthDayYear')} at ${fmtTime(m.date)}, ${m.from?.name || m.from?.email} wrote:\n${m.body.split('\n').map((l) => `> ${l}`).join('\n')}`,
      replyTo: m.id,
    });
  };
  const forward = (m) => setCompose({ to: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, body: `\n\n---------- Forwarded message ----------\nFrom: ${fmtAddr(m.from)}\nDate: ${fmt(m.date, 'monthDayYear')}\nSubject: ${m.subject}\n\n${m.body}` });

  const neighbour = (dir) => {
    const i = list.findIndex((m) => m.id === openId);
    return list[i + dir];
  };

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || compose || document.querySelector('.popover')) return;
      const k = e.key;
      if (k === 'c') setCompose({ to: '', subject: '', body: '' });
      else if (k === 'j' || k === 'ArrowDown') { const n = neighbour(1); if (n) select(n); }
      else if (k === 'k' || k === 'ArrowUp') { const n = neighbour(-1); if (n) select(n); }
      else if (open && k === 'r') reply(open);
      else if (open && k === 'e') { const n = neighbour(1) || neighbour(-1); move(open, 'archive', 'Archived'); setOpenId(n?.id || null); }
      else if (open && (k === '#' || k === 'Backspace' || k === 'Delete')) { const n = neighbour(1) || neighbour(-1); if (open.mailbox === 'trash') remove('mail', open.id); else move(open, 'trash', 'Moved to Trash'); setOpenId(n?.id || null); }
      else if (open && k === 's') patch('mail', open.id, { starred: !open.starred });
      else if (open && k === 'u') { patch('mail', open.id, { read: false }); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const msgMenu = (m) => [
    { label: m.read ? 'Mark as unread' : 'Mark as read', icon: 'mail', onSelect: () => patch('mail', m.id, { read: !m.read }) },
    { label: m.starred ? 'Unstar' : 'Star', icon: 'star', onSelect: () => patch('mail', m.id, { starred: !m.starred }) },
    { divider: true },
    { label: 'Reply', icon: 'reply', onSelect: () => reply(m) },
    { label: 'Forward', icon: 'forward', onSelect: () => forward(m) },
    { divider: true },
    m.mailbox !== 'archive' && { label: 'Archive', icon: 'archive', onSelect: () => move(m, 'archive', 'Archived') },
    m.mailbox !== 'inbox' && { label: 'Move to Inbox', icon: 'inbox', onSelect: () => move(m, 'inbox', 'Moved to Inbox') },
    m.mailbox === 'trash'
      ? { label: 'Delete forever', icon: 'trash', danger: true, onSelect: () => remove('mail', m.id) }
      : { label: 'Move to Trash', icon: 'trash', danger: true, onSelect: () => move(m, 'trash', 'Moved to Trash') },
  ].filter(Boolean);

  const boxName = BOXES.find((b) => b.id === box)?.name;

  return html`<div class=${cx('app mail', showSide && 'show-side', narrow && (open ? 'pane-reader' : 'pane-list'))}>
    <aside class="app-side mail-side">
      <button class="btn btn-primary btn-block" onClick=${() => setCompose({ to: '', subject: '', body: '' })}><${Icon} name="compose" size=${15} />Compose</button>
      <div class="side-section">
        ${BOXES.map((b) => html`<button key=${b.id} class=${cx('side-item', box === b.id && !q && 'is-active')} onClick=${() => { setBox(b.id); setQuery(''); setShowSide(false); }}>
          <${Icon} name=${b.icon} size=${16} /><span class="name">${b.name}</span><span class="count">${counts[b.id] || ''}</span>
        </button>`)}
      </div>
      <div class="mail-account">
        <${Avatar} name="Beckett Clarke" size=${30} />
        <div><div class="mail-account-name">Local mailbox</div><div class="mail-account-sub">Account sync coming soon</div></div>
      </div>
    </aside>

    <section class="mail-list-pane">
      <header class="notes-list-head">
        <${IconButton} class="back-btn" icon="sidebar" label="Mailboxes" onClick=${() => setShowSide(!showSide)} />
        <div class="notes-list-title"><h1>${q ? 'Search' : boxName}</h1><span>${q ? plural(list.length, 'result') : counts[box] ? `${counts[box]} unread` : plural(list.length, 'message')}</span></div>
        <div class="spacer" />
        ${box === 'trash' && list.length > 0 && html`<button class="btn btn-sm btn-danger" onClick=${async () => { if (await confirm({ title: 'Empty Trash?', body: `${plural(list.length, 'message')} will be deleted forever.`, confirmLabel: 'Empty', danger: true })) list.forEach((m) => remove('mail', m.id)); }}>Empty</button>`}
      </header>
      <div class="search-field notes-search"><${Icon} name="search" size=${14} /><input class="field field-sm" placeholder="Search mail" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => e.key === 'Escape' && setQuery('')} /></div>
      <div class="mail-list">
        ${list.length ? list.map((m) => {
          const who = m.mailbox === 'sent' || m.mailbox === 'drafts' ? `To: ${(m.to || []).map((t) => t.name || t.email).join(', ') || '—'}` : m.from?.name || m.from?.email;
          return html`<button key=${m.id} class=${cx('mail-item', !m.read && 'is-unread', m.id === openId && 'is-active')} onClick=${() => select(m)} onContextMenu=${(e) => openContextMenu(e, msgMenu(m))}>
            <span class="mail-unread-dot" />
            <${Avatar} name=${m.mailbox === 'sent' ? (m.to?.[0]?.name || m.to?.[0]?.email || '?') : (m.from?.name || m.from?.email)} size=${36} />
            <span class="mail-item-body">
              <span class="mail-item-top"><span class="mail-item-who">${m.mailbox === 'drafts' ? html`<span class="mail-draft">Draft</span> ` : ''}${who}</span><span class="mail-item-date">${listStamp(m.date)}</span></span>
              <span class="mail-item-subject">${m.starred && html`<${Icon} name="star" size=${12} class="mail-star" />`}${highlight(m.subject || '(no subject)', q)}</span>
              <span class="mail-item-snippet">${highlight(m.body.replace(/\s+/g, ' ').slice(0, 140), q)}</span>
            </span>
          </button>`;
        }) : html`<div class="notes-empty">${q ? `No mail matches “${query}”.` : `${boxName} is empty.`}</div>`}
      </div>
    </section>

    <section class="mail-reader-pane">
      ${open ? html`<${Reader} key=${open.id} m=${open} reply=${reply} forward=${forward} menu=${msgMenu}
          onBack=${() => setOpenId(null)} onGone=${() => { const n = neighbour(1) || neighbour(-1); setOpenId(n?.id || null); }} />`
        : html`<${EmptyState} icon="mail" title="No message selected" body=${`Press C to write a new message.`} />`}
    </section>

    ${compose && html`<${Compose} key=${compose.draftId || compose.replyTo || 'new'} ...${compose} onClose=${() => setCompose(null)} />`}
  </div>`;
}

function highlight(text, q) {
  if (!q) return text;
  const [a, b, c] = splitMatch(text, q);
  return b ? html`${a}<mark>${b}</mark>${c}` : text;
}

function Reader({ m, reply, forward, menu, onBack, onGone }) {
  return html`<article class="mail-reader">
    <header class="mail-reader-bar">
      <${IconButton} class="back-btn" icon="arrow-left" label="Back" onClick=${onBack} />
      <${IconButton} icon="reply" label="Reply (R)" onClick=${() => reply(m)} />
      <${IconButton} icon="forward" label="Forward" onClick=${() => forward(m)} />
      <span class="rt-sep" />
      ${m.mailbox !== 'archive' && html`<${IconButton} icon="archive" label="Archive (E)" onClick=${() => { onGone(); move(m, 'archive', 'Archived'); }} />`}
      <${IconButton} icon="trash" label="Delete" onClick=${() => { onGone(); if (m.mailbox === 'trash') remove('mail', m.id); else move(m, 'trash', 'Moved to Trash'); }} />
      <${IconButton} icon="mail" label="Mark as unread (U)" onClick=${() => patch('mail', m.id, { read: false })} />
      <div class="spacer" />
      <${IconButton} icon="star" label=${m.starred ? 'Unstar (S)' : 'Star (S)'} active=${m.starred} class="mail-star-btn" onClick=${() => patch('mail', m.id, { starred: !m.starred })} />
      <${IconButton} icon="more" label="More" onClick=${(e) => openMenu(e.currentTarget, menu(m), { placement: 'bottom-end' })} />
    </header>
    <div class="mail-reader-scroll">
      <h1 class="mail-subject">${m.subject || '(no subject)'}</h1>
      <div class="mail-from">
        <${Avatar} name=${m.from?.name || m.from?.email} size=${42} />
        <div class="mail-from-text">
          <div class="mail-from-name">${m.from?.name || m.from?.email}<span>${m.from?.name ? `<${m.from.email}>` : ''}</span></div>
          <div class="mail-from-to">To ${(m.to || []).map((t) => t.name || t.email).join(', ') || 'me'}</div>
        </div>
        <div class="mail-from-date">${fmt(m.date, 'weekdayMonthDay')}, ${fmtTime(m.date)}</div>
      </div>
      <div class="mail-body"><${Linkified} text=${m.body} /></div>
      <div class="mail-quick-reply">
        <button class="btn" onClick=${() => reply(m)}><${Icon} name="reply" size=${15} />Reply</button>
        <button class="btn" onClick=${() => forward(m)}><${Icon} name="forward" size=${15} />Forward</button>
      </div>
    </div>
  </article>`;
}

function Compose({ draftId, to: to0 = '', subject: subj0 = '', body: body0 = '', onClose }) {
  const [to, setTo] = useState(to0);
  const [subject, setSubject] = useState(subj0);
  const [body, setBody] = useState(body0);
  const [min, setMin] = useState(false);
  const idRef = useRef(draftId || uid('m'));
  const toRef = useRef(null);
  const bodyRef = useRef(null);
  useEffect(() => {
    if (to0) { bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(0, 0); } else toRef.current?.focus();
  }, []);
  useEscape(() => close(), !min);

  const dirty = to.trim() || subject.trim() || body.trim();
  const close = () => {
    if (dirty && (to !== to0 || subject !== subj0 || body !== body0 || !draftId)) {
      put('mail', { id: idRef.current, mailbox: 'drafts', read: true, starred: false, date: Date.now(), from: { name: 'Beckett Clarke', email: 'beckett@bcos.local' }, to: parseAddresses(to), subject, body });
      toast('Saved to Drafts', { icon: 'compose' });
    }
    onClose();
  };
  const send = () => {
    const recipients = parseAddresses(to);
    if (!recipients.length) { toast('Add at least one recipient', { icon: 'alert' }); toRef.current?.focus(); return; }
    put('mail', { id: idRef.current, mailbox: 'sent', read: true, starred: false, date: Date.now(), from: { name: 'Beckett Clarke', email: 'beckett@bcos.local' }, to: recipients, subject: subject || '(no subject)', body });
    onClose();
    toast('Saved to Sent — real delivery arrives with account sync', { icon: 'send' });
  };
  const discard = () => {
    if (draftId) remove('mail', draftId);
    onClose();
  };

  return html`<div class=${cx('compose', min && 'is-min')} role="dialog" aria-label="New message" data-layer="20" onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}>
    <header class="compose-head" onClick=${() => min && setMin(false)}>
      <span>${subject || 'New message'}</span>
      <div class="spacer" />
      <${IconButton} class="sm" icon=${min ? 'maximize' : 'minus'} size=${14} label=${min ? 'Expand' : 'Minimise'} onClick=${(e) => { e.stopPropagation(); setMin(!min); }} />
      <${IconButton} class="sm" icon="x" size=${14} label="Close" onClick=${(e) => { e.stopPropagation(); close(); }} />
    </header>
    ${!min && html`
      <label class="compose-row"><span>To</span><input ref=${toRef} value=${to} onInput=${(e) => setTo(e.target.value)} placeholder="name@example.com" /></label>
      <label class="compose-row"><span>Subject</span><input value=${subject} onInput=${(e) => setSubject(e.target.value)} /></label>
      <textarea ref=${bodyRef} class="compose-body" value=${body} onInput=${(e) => setBody(e.target.value)} placeholder="Write your message…" />
      <footer class="compose-foot">
        <button class="btn btn-primary" onClick=${send}><${Icon} name="send" size=${15} />Send</button>
        <span class="kbd-hint">${modKey}↵</span>
        <div class="spacer" />
        <${IconButton} icon="trash" label="Discard" onClick=${discard} />
      </footer>`}
  </div>`;
}
