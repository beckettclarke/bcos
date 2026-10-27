// Mail — mailboxes, a reader, and a compose window, across real accounts.
//
// Accounts (iCloud, Gmail, Yahoo, Fastmail or any IMAP/SMTP server) are
// connected and synced by the BCOS server (see mail.js next to server.js);
// their messages land in the `mail` collection tagged with `account`. Changes
// to those (read, star, move, delete) go to the mail server first through the
// API, which then updates the collection. Messages without an account are the
// local mailbox, which works exactly as before.

import { html, useState, useEffect, useMemo, useRef } from '../lib/html.js';
import { useCollection, useSettings, settings, put, patch, remove, get, absorb, api, all } from '../lib/store.js';
import { listStamp, fmt, fmtTime } from '../lib/date.js';
import { cx, uid, plural, isTyping, splitMatch, modKey, formatBytes, hashHue } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { IconButton, Avatar, EmptyState, toast, useNarrow, openContextMenu, openMenu, confirm, useEscape, Portal } from '../ui/components.js';
import { os } from '../shell/os.js';

const BOXES = [
  { id: 'inbox', name: 'Inbox', icon: 'inbox' },
  { id: 'starred', name: 'Starred', icon: 'star' },
  { id: 'sent', name: 'Sent', icon: 'send' },
  { id: 'drafts', name: 'Drafts', icon: 'compose' },
  { id: 'archive', name: 'Archive', icon: 'archive' },
  { id: 'junk', name: 'Junk', icon: 'alert' },
  { id: 'trash', name: 'Trash', icon: 'trash' },
];

// Messages written without an account (kept only in BCOS) come from you.
const localMe = () => ({ name: settings().name || 'Me', email: 'me@bcos.local' });
const SYNC_EVERY = 3 * 60 * 1000;

const inBox = (m, box) => box === 'starred' ? m.starred && m.mailbox !== 'trash' && m.mailbox !== 'junk' : m.mailbox === box;
const inAccount = (m, acct) => acct === 'all' || (acct === 'local' ? !m.account : m.account === acct);

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

// --- talking to accounts -------------------------------------------------------

/** Replace what we have for an account with what the server just synced. */
function absorbAccount(accountId, items) {
  const keep = new Set(items.map((m) => m.id));
  const gone = all('mail').filter((m) => m.account === accountId && !keep.has(m.id)).map((m) => m.id);
  absorb('mail', items, gone);
}

const syncing = new Set();
export async function syncAccount(id, { quiet = true } = {}) {
  if (syncing.has(id)) return;
  syncing.add(id);
  const acct = get('mail_accounts', id);
  if (acct) absorb('mail_accounts', [{ ...acct, syncing: true }]);
  try {
    const r = await api(`mail/sync/${id}`, { method: 'POST', timeout: 180000 });
    absorb('mail_accounts', [r.account]);
    absorbAccount(id, r.items || []);
    if (!quiet) toast(r.added ? `${plural(r.added, 'new message')}` : 'Up to date', { icon: 'check' });
  } catch (err) {
    const cur = get('mail_accounts', id);
    if (cur) absorb('mail_accounts', [{ ...cur, syncing: false, error: err.message }]);
    if (!quiet) toast(err.message, { icon: 'alert', tone: 'danger' });
  } finally { syncing.delete(id); }
}

async function remote(m, op, args, optimistic) {
  const before = get('mail', m.id);
  if (optimistic) absorb('mail', [{ ...m, ...optimistic }]);
  try {
    const r = await api(`mail/action/${m.id}`, { method: 'POST', body: { op, ...args } });
    if (r.item) absorb('mail', [r.item]);
    if (r.removed) absorb('mail', [], [r.removed]);
    return true;
  } catch (err) {
    if (before) absorb('mail', [before]);
    toast(err.message, { icon: 'alert', tone: 'danger' });
    return false;
  }
}

function setFlags(m, changes) {
  if (m.account) remote(m, 'flags', changes, changes);
  else patch('mail', m.id, changes);
}

function move(m, mailbox, label) {
  const before = m.mailbox;
  if (m.account) {
    const acct = get('mail_accounts', m.account);
    if (!acct?.folders?.[mailbox]) { toast(`${acct?.name || 'This account'} has no ${mailbox} folder`, { icon: 'alert' }); return; }
    remote(m, 'move', { to: mailbox }, { mailbox }).then((ok) => ok && toast(label, {
      icon: mailbox === 'trash' ? 'trash' : 'archive',
      action: { label: 'Undo', onClick: () => { const cur = get('mail', m.id); if (cur) remote(cur, 'move', { to: before }, { mailbox: before }); } },
    }));
    return;
  }
  patch('mail', m.id, { mailbox });
  toast(label, { icon: mailbox === 'trash' ? 'trash' : 'archive', action: { label: 'Undo', onClick: () => patch('mail', m.id, { mailbox: before }) } });
}

function destroy(m) {
  if (m.account) { absorb('mail', [], [m.id]); remote(m, 'delete', {}, null).then((ok) => { if (!ok) absorb('mail', [m]); }); }
  else remove('mail', m.id);
}

// --- the app -------------------------------------------------------------------

export default function MailApp({ intent, nonce }) {
  useSettings();
  const narrow = useNarrow();
  const mail = useCollection('mail');
  const accounts = useCollection('mail_accounts');
  const [box, setBox] = useState('inbox');
  const [acct, setAcct] = useState('all');
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');
  const [compose, setCompose] = useState(null);
  const [showSide, setShowSide] = useState(false);
  const [adding, setAdding] = useState(null);

  const hasLocal = useMemo(() => mail.some((m) => !m.account), [mail]);
  const myAddresses = useMemo(() => new Set([localMe().email, ...accounts.map((a) => a.email)]), [accounts]);
  const scoped = useMemo(() => mail.filter((m) => inAccount(m, acct)), [mail, acct]);
  const boxes = BOXES.filter((b) => b.id !== 'junk' || accounts.some((a) => a.folders?.junk));

  const counts = useMemo(() => Object.fromEntries(BOXES.map((b) => [b.id, scoped.filter((m) => inBox(m, b.id) && (b.id === 'drafts' || !m.read)).length])), [scoped]);
  const q = query.trim().toLowerCase();
  const list = useMemo(() => scoped
    .filter((m) => (q ? (m.mailbox !== 'trash' && m.mailbox !== 'junk') || box === m.mailbox : inBox(m, box)))
    .filter((m) => !q || [m.subject, m.body, m.from?.name, m.from?.email, ...(m.to || []).map((t) => t.name + t.email)].some((x) => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date - a.date), [scoped, box, q]);
  const open = openId ? mail.find((m) => m.id === openId) : null;

  // Sync when Mail opens, then every few minutes while it's running.
  useEffect(() => {
    const run = () => all('mail_accounts').forEach((a) => syncAccount(a.id));
    run();
    const t = setInterval(() => { if (document.visibilityState === 'visible') run(); }, SYNC_EVERY);
    return () => clearInterval(t);
  }, []);

  const select = (m) => {
    if (m.mailbox === 'drafts') { setCompose({ draftId: m.id, account: m.account || m.fromAccount, to: (m.to || []).map(fmtAddr).join(', '), subject: m.subject, body: m.body }); return; }
    setOpenId(m.id);
    if (!m.read) setFlags(m, { read: true });
  };

  // Keep something open on wide screens.
  useEffect(() => {
    if (narrow) return;
    if (!open || !list.includes(open)) {
      const first = list.find((m) => m.mailbox !== 'drafts');
      setOpenId(first?.id || null);
      if (first && !first.read) setFlags(first, { read: true });
    }
  }, [box, acct, list.length, narrow]);

  const defaultAccount = () => (acct !== 'all' && acct !== 'local' ? acct : accounts[0]?.id || null);
  const newMessage = (extra = {}) => setCompose({ account: defaultAccount(), to: '', subject: '', body: '', ...extra });

  useEffect(() => {
    if (!intent) return;
    if (intent.type === 'compose') newMessage();
    if (intent.type === 'mailbox') setBox(intent.id);
    if (intent.type === 'message') { const m = get('mail', intent.id); if (m) { setBox(m.mailbox); select(m); } }
    if (intent.type === 'add-account') setAdding({});
  }, [nonce]);

  const reply = (m, everyone = false) => {
    const first = m.mailbox === 'sent' ? (m.to || []) : [m.replyTo || m.from];
    const to = [...first, ...(everyone ? [...(m.to || []), ...(m.cc || [])] : [])]
      .filter((a, i, arr) => a && a.email && !myAddresses.has(a.email.toLowerCase()) && arr.findIndex((b) => b?.email === a.email) === i);
    setCompose({
      account: m.account || defaultAccount(),
      to: to.map(fmtAddr).join(', '),
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      body: `\n\nOn ${fmt(m.date, 'monthDayYear')} at ${fmtTime(m.date)}, ${m.from?.name || m.from?.email} wrote:\n${(m.body || '').split('\n').map((l) => `> ${l}`).join('\n')}`,
      replyTo: m.id,
      inReplyTo: m.messageId,
      references: m.references || m.messageId,
    });
  };
  const forward = (m) => setCompose({ account: m.account || defaultAccount(), to: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, body: `\n\n---------- Forwarded message ----------\nFrom: ${fmtAddr(m.from)}\nDate: ${fmt(m.date, 'monthDayYear')}\nSubject: ${m.subject}\n\n${m.body}` });

  const neighbour = (dir) => {
    const i = list.findIndex((m) => m.id === openId);
    return list[i + dir];
  };

  useEffect(() => {
    const onKey = (e) => {
      if (os.app !== 'mail' || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || compose || adding || document.querySelector('.popover, .dialog-scrim')) return;
      const k = e.key;
      if (k === 'c') newMessage();
      else if (k === 'j' || k === 'ArrowDown') { const n = neighbour(1); if (n) select(n); }
      else if (k === 'k' || k === 'ArrowUp') { const n = neighbour(-1); if (n) select(n); }
      else if (open && k === 'r') reply(open);
      else if (open && k === 'e') { const n = neighbour(1) || neighbour(-1); move(open, 'archive', 'Archived'); setOpenId(n?.id || null); }
      else if (open && (k === '#' || k === 'Backspace' || k === 'Delete')) { const n = neighbour(1) || neighbour(-1); if (open.mailbox === 'trash') destroy(open); else move(open, 'trash', 'Moved to Trash'); setOpenId(n?.id || null); }
      else if (open && k === 's') setFlags(open, { starred: !open.starred });
      else if (open && k === 'u') setFlags(open, { read: false });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const msgMenu = (m) => [
    { label: m.read ? 'Mark as unread' : 'Mark as read', icon: 'mail', onSelect: () => setFlags(m, { read: !m.read }) },
    { label: m.starred ? 'Unstar' : 'Star', icon: 'star', onSelect: () => setFlags(m, { starred: !m.starred }) },
    { divider: true },
    { label: 'Reply', icon: 'reply', onSelect: () => reply(m) },
    { label: 'Reply all', icon: 'reply', onSelect: () => reply(m, true) },
    { label: 'Forward', icon: 'forward', onSelect: () => forward(m) },
    { divider: true },
    m.mailbox !== 'archive' && { label: 'Archive', icon: 'archive', onSelect: () => move(m, 'archive', 'Archived') },
    m.mailbox !== 'inbox' && { label: 'Move to Inbox', icon: 'inbox', onSelect: () => move(m, 'inbox', 'Moved to Inbox') },
    m.account && m.mailbox !== 'junk' && get('mail_accounts', m.account)?.folders?.junk && { label: 'Move to Junk', icon: 'alert', onSelect: () => move(m, 'junk', 'Moved to Junk') },
    m.mailbox === 'trash'
      ? { label: 'Delete forever', icon: 'trash', danger: true, onSelect: () => destroy(m) }
      : { label: 'Move to Trash', icon: 'trash', danger: true, onSelect: () => move(m, 'trash', 'Moved to Trash') },
  ].filter(Boolean);

  const accountMenu = (a) => [
    { label: 'Sync now', icon: 'refresh', onSelect: () => syncAccount(a.id, { quiet: false }) },
    { label: 'Change password…', icon: 'lock', onSelect: () => setAdding({ edit: a }) },
    { divider: true },
    { label: 'Remove account', icon: 'trash', danger: true, onSelect: async () => {
      if (!(await confirm({ title: `Remove ${a.email}?`, body: 'Its messages disappear from BCOS. Nothing is deleted from the mail server.', confirmLabel: 'Remove', danger: true }))) return;
      try {
        await api(`mail/accounts/${a.id}`, { method: 'DELETE' });
        absorb('mail_accounts', [], [a.id]);
        absorbAccount(a.id, []);
        if (acct === a.id) setAcct('all');
        toast('Account removed', { icon: 'check' });
      } catch (err) { toast(err.message, { icon: 'alert', tone: 'danger' }); }
    } },
  ];

  const boxName = BOXES.find((b) => b.id === box)?.name;
  const scopeName = acct === 'all' ? '' : acct === 'local' ? 'On this BCOS' : accounts.find((a) => a.id === acct)?.name;
  const anySyncing = accounts.some((a) => a.syncing);

  return html`<div class=${cx('app mail', showSide && 'show-side', narrow && (open ? 'pane-reader' : 'pane-list'))}>
    <aside class="app-side mail-side">
      <button class="btn btn-primary btn-block" onClick=${() => newMessage()}><${Icon} name="compose" size=${15} />Compose</button>
      <div class="side-section">
        ${boxes.map((b) => html`<button key=${b.id} class=${cx('side-item', box === b.id && !q && 'is-active')} onClick=${() => { setBox(b.id); setQuery(''); setShowSide(false); }}>
          <${Icon} name=${b.icon} size=${16} /><span class="name">${b.name}</span><span class="count">${counts[b.id] || ''}</span>
        </button>`)}
      </div>

      <div class="side-section mail-accounts">
        <div class="side-label"><span>Accounts</span>
          ${accounts.length > 0 ? html`<${IconButton} icon="refresh" size=${13} label="Sync all" class=${cx('sm', anySyncing && 'is-spinning')} onClick=${() => accounts.forEach((a) => syncAccount(a.id, { quiet: false }))} />` : null}
        </div>
        ${(accounts.length > 1 || (accounts.length > 0 && hasLocal)) && html`<button class=${cx('side-item', acct === 'all' && 'is-active')} onClick=${() => { setAcct('all'); setShowSide(false); }}>
          <${Icon} name="inbox" size=${16} /><span class="name">All accounts</span>
        </button>`}
        ${accounts.map((a) => html`<button key=${a.id} class=${cx('side-item mail-acct', acct === a.id && 'is-active')} title=${a.error ? a.error : a.lastSync ? `${a.email} · synced ${fmtTime(a.lastSync)}` : a.email}
          onClick=${() => { setAcct(acct === a.id ? 'all' : a.id); setShowSide(false); }} onContextMenu=${(e) => openContextMenu(e, accountMenu(a))}>
          <span class="mail-acct-dot" style=${{ '--h': hashHue(a.email) }}>${(a.label || a.name || '?')[0]}</span>
          <span class="name"><span>${a.name}</span><small>${a.email}</small></span>
          ${a.syncing ? html`<span class="spinner sm" />` : a.error ? html`<span class="mail-acct-warn"><${Icon} name="alert" size=${14} /></span>` : null}
          <span class="mail-acct-more" role="button" tabindex="0" aria-label="Account options" onClick=${(e) => { e.stopPropagation(); openMenu(e.currentTarget, accountMenu(a), { placement: 'bottom-end' }); }}><${Icon} name="more" size=${15} /></span>
        </button>`)}
        ${hasLocal && accounts.length > 0 && html`<button class=${cx('side-item', acct === 'local' && 'is-active')} onClick=${() => { setAcct(acct === 'local' ? 'all' : 'local'); setShowSide(false); }}>
          <${Icon} name="database" size=${16} /><span class="name">On this BCOS</span>
        </button>`}
        <button class="side-item mail-add" onClick=${() => setAdding({})}><${Icon} name="plus" size=${16} /><span class="name">Add account</span></button>
      </div>
    </aside>

    <section class="mail-list-pane">
      <header class="notes-list-head">
        <${IconButton} class="back-btn" icon="sidebar" label="Mailboxes" onClick=${() => setShowSide(!showSide)} />
        <div class="notes-list-title"><h1>${q ? 'Search' : boxName}</h1><span>${scopeName ? `${scopeName} · ` : ''}${q ? plural(list.length, 'result') : counts[box] ? `${counts[box]} unread` : plural(list.length, 'message')}</span></div>
        <div class="spacer" />
        ${box === 'trash' && list.length > 0 && html`<button class="btn btn-sm btn-danger" onClick=${async () => { if (await confirm({ title: 'Empty Trash?', body: `${plural(list.length, 'message')} will be deleted forever.`, confirmLabel: 'Empty', danger: true })) list.forEach(destroy); }}>Empty</button>`}
      </header>
      <div class="search-field notes-search"><${Icon} name="search" size=${14} /><input class="field field-sm" placeholder="Search mail" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => e.key === 'Escape' && setQuery('')} /></div>
      ${!accounts.length && html`<button class="mail-connect" onClick=${() => setAdding({})}>
        <span class="mail-connect-icons">${['icloud', 'gmail', 'yahoo'].map((p) => html`<${ProviderMark} key=${p} id=${p} size=${26} />`)}</span>
        <span><b>Connect your email</b><small>iCloud, Gmail, Yahoo, Fastmail or any IMAP account</small></span>
        <${Icon} name="chevron-right" size=${16} />
      </button>`}
      <div class="mail-list">
        ${list.length ? list.map((m) => {
          const outgoing = m.mailbox === 'sent' || m.mailbox === 'drafts';
          const who = outgoing ? `To: ${(m.to || []).map((t) => t.name || t.email).join(', ') || '—'}` : m.from?.name || m.from?.email;
          const a = m.account && acct === 'all' && accounts.length > 1 ? accounts.find((x) => x.id === m.account) : null;
          return html`<button key=${m.id} class=${cx('mail-item', !m.read && 'is-unread', m.id === openId && 'is-active')} onClick=${() => select(m)} onContextMenu=${(e) => openContextMenu(e, msgMenu(m))}>
            <span class="mail-unread-dot" />
            <${Avatar} name=${outgoing ? (m.to?.[0]?.name || m.to?.[0]?.email || '?') : (m.from?.name || m.from?.email)} size=${36} />
            <span class="mail-item-body">
              <span class="mail-item-top"><span class="mail-item-who">${m.mailbox === 'drafts' ? html`<span class="mail-draft">Draft</span> ` : ''}${who}</span><span class="mail-item-date">${listStamp(m.date)}</span></span>
              <span class="mail-item-subject">${m.starred && html`<${Icon} name="star" size=${12} class="mail-star" />`}${m.attachments?.length > 0 && html`<${Icon} name="paperclip" size=${12} class="mail-clip" />`}${highlight(m.subject || '(no subject)', q)}</span>
              <span class="mail-item-snippet">${a && html`<span class="mail-item-acct" style=${{ '--h': hashHue(a.email) }}>${a.label || a.name}</span>`}${highlight((m.body || '').replace(/\s+/g, ' ').slice(0, 140), q)}</span>
            </span>
          </button>`;
        }) : html`<div class="notes-empty">${q ? `No mail matches “${query}”.` : anySyncing ? 'Syncing…' : `${boxName} is empty.`}</div>`}
      </div>
    </section>

    <section class="mail-reader-pane">
      ${open ? html`<${Reader} key=${open.id} m=${open} reply=${reply} forward=${forward} menu=${msgMenu}
          onBack=${() => setOpenId(null)} onGone=${() => { const n = neighbour(1) || neighbour(-1); setOpenId(n?.id || null); }} />`
        : html`<${EmptyState} icon="mail" title="No message selected" body=${`Press C to write a new message.`} />`}
    </section>

    ${compose && html`<${Compose} key=${compose.draftId || compose.replyTo || 'new'} ...${compose} accounts=${accounts} onAddAccount=${() => setAdding({})} onClose=${() => setCompose(null)} />`}
    ${adding && html`<${AccountSheet} edit=${adding.edit} onClose=${() => setAdding(null)} onAdded=${(a) => { setAdding(null); setAcct(accounts.length ? a.id : 'all'); }} />`}
  </div>`;
}

function highlight(text, q) {
  if (!q) return text;
  const [a, b, c] = splitMatch(text, q);
  return b ? html`${a}<mark>${b}</mark>${c}` : text;
}

// --- reading -------------------------------------------------------------------

/** HTML mail in a sandbox: no scripts, links open in a new tab, sized to fit. */
function HtmlBody({ source }) {
  const ref = useRef(null);
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">
<base target="_blank"><style>
html{background:#fff;color:#1d1d1f;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;overflow-wrap:anywhere}
body{margin:0;padding:22px 24px}img{max-width:100%;height:auto}table{max-width:100%!important}pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #ddd;color:#555}
</style></head><body>${source}</body></html>`, [source]);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro;
    const fit = () => {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      frame.style.height = `${Math.max(120, d.documentElement.scrollHeight)}px`;
    };
    const onLoad = () => {
      fit();
      try { ro = new ResizeObserver(fit); ro.observe(frame.contentDocument.body); } catch {}
      frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
    };
    frame.addEventListener('load', onLoad);
    return () => { frame.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [doc]);
  // allow-same-origin (without allow-scripts) only lets BCOS measure the page.
  return html`<iframe ref=${ref} class="mail-html" title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc=${doc} />`;
}

function Reader({ m, reply, forward, menu, onBack, onGone }) {
  const [full, setFull] = useState(null);
  const [err, setErr] = useState(null);
  const [plain, setPlain] = useState(false);
  useEffect(() => {
    if (!m.account) return;
    let live = true;
    api(`mail/message/${m.id}`, { timeout: 60000 }).then((b) => live && setFull(b)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [m.id]);

  const text = full?.text || m.body || '';
  const showHtml = full?.html && !plain;
  const attachments = full?.attachments || m.attachments || [];
  const account = m.account ? get('mail_accounts', m.account) : null;

  return html`<article class="mail-reader">
    <header class="mail-reader-bar">
      <${IconButton} class="back-btn" icon="arrow-left" label="Back" onClick=${onBack} />
      <${IconButton} icon="reply" label="Reply (R)" onClick=${() => reply(m)} />
      <${IconButton} icon="forward" label="Forward" onClick=${() => forward(m)} />
      <span class="rt-sep" />
      ${m.mailbox !== 'archive' && html`<${IconButton} icon="archive" label="Archive (E)" onClick=${() => { onGone(); move(m, 'archive', 'Archived'); }} />`}
      <${IconButton} icon="trash" label="Delete" onClick=${() => { onGone(); if (m.mailbox === 'trash') destroy(m); else move(m, 'trash', 'Moved to Trash'); }} />
      <${IconButton} icon="mail" label="Mark as unread (U)" onClick=${() => setFlags(m, { read: false })} />
      <div class="spacer" />
      <${IconButton} icon="star" label=${m.starred ? 'Unstar (S)' : 'Star (S)'} active=${m.starred} class="mail-star-btn" onClick=${() => setFlags(m, { starred: !m.starred })} />
      <${IconButton} icon="more" label="More" onClick=${(e) => openMenu(e.currentTarget, [
        ...menu(m),
        full?.html && { divider: true },
        full?.html && { label: plain ? 'Show formatted' : 'Show plain text', icon: 'note', onSelect: () => setPlain(!plain) },
      ].filter(Boolean), { placement: 'bottom-end' })} />
    </header>
    <div class="mail-reader-scroll">
      <h1 class="mail-subject">${m.subject || '(no subject)'}</h1>
      <div class="mail-from">
        <${Avatar} name=${m.from?.name || m.from?.email} size=${42} />
        <div class="mail-from-text">
          <div class="mail-from-name">${m.from?.name || m.from?.email}<span>${m.from?.name ? `<${m.from.email}>` : ''}</span></div>
          <div class="mail-from-to">To ${(m.to || []).map((t) => t.name || t.email).join(', ') || 'me'}${m.cc?.length ? ` · Cc ${m.cc.map((t) => t.name || t.email).join(', ')}` : ''}${account ? html` · <span class="mail-from-acct">${account.email}</span>` : ''}</div>
        </div>
        <div class="mail-from-date">${fmt(m.date, 'weekdayMonthDay')}, ${fmtTime(m.date)}</div>
      </div>
      ${attachments.length > 0 && html`<div class="mail-attachments">${attachments.map((a, i) => html`<span key=${i} class="mail-attachment" title=${a.name}><${Icon} name="paperclip" size=${13} /><span>${a.name}</span>${a.size ? html`<small>${formatBytes(a.size)}</small>` : ''}</span>`)}</div>`}
      ${showHtml
        ? html`<div class="mail-html-wrap"><${HtmlBody} source=${full.html} /></div>`
        : html`<div class="mail-body">${m.account && !full && !err ? html`<span class="mail-loading"><span class="spinner sm" /> Loading message…</span>` : html`<${Linkified} text=${text} />`}</div>`}
      ${err && html`<div class="mail-body-err"><${Icon} name="alert" size=${14} /> Showing a preview — ${err}</div>`}
      ${full?.truncated && html`<div class="mail-body-err"><${Icon} name="info" size=${14} /> This message is very large; BCOS shows the first part.</div>`}
      <div class="mail-quick-reply">
        <button class="btn" onClick=${() => reply(m)}><${Icon} name="reply" size=${15} />Reply</button>
        <button class="btn" onClick=${() => forward(m)}><${Icon} name="forward" size=${15} />Forward</button>
      </div>
    </div>
  </article>`;
}

// --- writing -------------------------------------------------------------------

function Compose({ draftId, account: acct0 = null, to: to0 = '', subject: subj0 = '', body: body0 = '', inReplyTo, references, accounts, onAddAccount, onClose }) {
  const [account, setAccount] = useState(acct0 && accounts.some((a) => a.id === acct0) ? acct0 : accounts[0]?.id || null);
  const [to, setTo] = useState(to0);
  const [subject, setSubject] = useState(subj0);
  const [body, setBody] = useState(body0);
  const [min, setMin] = useState(false);
  const [sending, setSending] = useState(false);
  const idRef = useRef(draftId || uid('m'));
  const toRef = useRef(null);
  const bodyRef = useRef(null);
  useEffect(() => {
    if (to0) { bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(0, 0); } else toRef.current?.focus();
  }, []);
  useEscape(() => close(), !min && !sending);

  const from = accounts.find((a) => a.id === account);
  const fromAddr = from ? { name: from.name, email: from.email } : localMe();
  const dirty = to.trim() || subject.trim() || body.trim();
  const close = () => {
    if (dirty && (to !== to0 || subject !== subj0 || body !== body0 || !draftId)) {
      put('mail', { id: idRef.current, mailbox: 'drafts', read: true, starred: false, date: Date.now(), fromAccount: account, from: fromAddr, to: parseAddresses(to), subject, body });
      toast('Saved to Drafts', { icon: 'compose' });
    }
    onClose();
  };
  const send = async () => {
    if (sending) return;
    const recipients = parseAddresses(to);
    if (!recipients.length) { toast('Add at least one recipient', { icon: 'alert' }); toRef.current?.focus(); return; }
    const bad = recipients.find((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    if (bad) { toast(`“${bad.email}” doesn’t look like an email address`, { icon: 'alert' }); toRef.current?.focus(); return; }
    if (!from) {
      put('mail', { id: idRef.current, mailbox: 'sent', read: true, starred: false, date: Date.now(), from: fromAddr, to: recipients, subject: subject || '(no subject)', body });
      onClose();
      toast('Saved to Sent on this BCOS — add an account to really send', { icon: 'send' });
      return;
    }
    setSending(true);
    try {
      await api('mail/send', { method: 'POST', timeout: 60000, body: { account, to: recipients, subject, text: body, inReplyTo, references } });
      if (draftId) remove('mail', draftId);
      onClose();
      toast(`Sent from ${from.email}`, { icon: 'send' });
      setTimeout(() => syncAccount(account), 1500);
    } catch (err) {
      setSending(false);
      toast(err.message, { icon: 'alert', tone: 'danger', duration: 7000 });
    }
  };
  const discard = () => {
    if (draftId) remove('mail', draftId);
    onClose();
  };

  return html`<div class=${cx('compose', min && 'is-min', sending && 'is-sending')} role="dialog" aria-label="New message" data-layer="20" onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}>
    <header class="compose-head" onClick=${() => min && setMin(false)}>
      <span>${subject || 'New message'}</span>
      <div class="spacer" />
      <${IconButton} class="sm" icon=${min ? 'maximize' : 'minus'} size=${14} label=${min ? 'Expand' : 'Minimise'} onClick=${(e) => { e.stopPropagation(); setMin(!min); }} />
      <${IconButton} class="sm" icon="x" size=${14} label="Close" onClick=${(e) => { e.stopPropagation(); close(); }} />
    </header>
    ${!min && html`
      <label class="compose-row"><span>From</span>
        ${accounts.length
          ? html`<select class="compose-from" value=${account || ''} onChange=${(e) => (e.target.value === '+' ? onAddAccount() : setAccount(e.target.value))}>
              ${accounts.map((a) => html`<option key=${a.id} value=${a.id}>${`${a.name} <${a.email}>`}</option>`)}
              <option value="+">Add account…</option>
            </select>`
          : html`<span class="compose-local">This BCOS only <button type="button" class="link-btn" onClick=${onAddAccount}>Connect an account</button></span>`}
      </label>
      <label class="compose-row"><span>To</span><input ref=${toRef} value=${to} onInput=${(e) => setTo(e.target.value)} placeholder="name@example.com" /></label>
      <label class="compose-row"><span>Subject</span><input value=${subject} onInput=${(e) => setSubject(e.target.value)} /></label>
      <textarea ref=${bodyRef} class="compose-body" value=${body} onInput=${(e) => setBody(e.target.value)} placeholder="Write your message…" />
      <footer class="compose-foot">
        <button class="btn btn-primary" onClick=${send} disabled=${sending}>${sending ? html`<span class="spinner sm" />Sending…` : html`<${Icon} name="send" size=${15} />Send`}</button>
        <span class="kbd-hint">${modKey}↵</span>
        <div class="spacer" />
        <${IconButton} icon="trash" label="Discard" onClick=${discard} />
      </footer>`}
  </div>`;
}

// --- accounts ------------------------------------------------------------------

const PROVIDERS = [
  { id: 'icloud', name: 'iCloud', domains: /@(icloud|me|mac)\.com$/i,
    help: html`iCloud needs an <b>app-specific password</b>, not your Apple Account password. Make one at <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer">account.apple.com</a> → Sign-In and Security → App-Specific Passwords.` },
  { id: 'gmail', name: 'Gmail', domains: /@(gmail|googlemail)\.com$/i,
    help: html`Gmail needs an <b>app password</b> (turn on 2-Step Verification first). Make one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">myaccount.google.com/apppasswords</a>. Google Workspace accounts may need IMAP enabled by an admin.` },
  { id: 'yahoo', name: 'Yahoo', domains: /@(yahoo|ymail|rocketmail)\./i,
    help: html`Yahoo needs an <b>app password</b>: Yahoo Account → <a href="https://login.yahoo.com/account/security" target="_blank" rel="noopener noreferrer">Account Security</a> → Generate app password.` },
  { id: 'fastmail', name: 'Fastmail', domains: /@(fastmail\.(com|fm)|fastmail\.\w+)$/i,
    help: html`Fastmail needs an <b>app password</b> with IMAP and SMTP access: Settings → Privacy & Security → <a href="https://app.fastmail.com/settings/security/apps" target="_blank" rel="noopener noreferrer">App passwords</a>.` },
  { id: 'other', name: 'Other',
    help: html`Any provider with IMAP and SMTP. Find the server names in your provider’s help pages (search “IMAP settings”). Outlook.com and Hotmail no longer allow password sign-in for IMAP, so they can’t be added this way.` },
];

const PROVIDER_COLORS = { icloud: ['#5ac8fa', '#007aff'], gmail: ['#ff6b5b', '#d93025'], yahoo: ['#9b5cff', '#5f01d1'], fastmail: ['#4f8cff', '#0b4fd6'], other: ['#8e8e93', '#48484a'] };
function ProviderMark({ id, size = 34 }) {
  const [a, b] = PROVIDER_COLORS[id] || PROVIDER_COLORS.other;
  const glyph = { icloud: '☁', gmail: 'M', yahoo: 'Y!', fastmail: 'F', other: '@' }[id] || '@';
  return html`<span class="provider-mark" style=${{ width: size, height: size, fontSize: size * 0.44, background: `linear-gradient(160deg, ${a}, ${b})` }}>${glyph}</span>`;
}

function AccountSheet({ edit, onClose, onAdded }) {
  const [provider, setProvider] = useState(edit?.provider || null);
  const [form, setForm] = useState({ name: edit?.name || '', email: edit?.email || '', password: '', username: '', imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465', smtpSecurity: 'ssl' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  useEscape(() => !busy && onClose());

  const p = PROVIDERS.find((x) => x.id === provider);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const body = { provider, name: form.name.trim(), email: form.email.trim(), password: form.password, username: form.username.trim() || undefined };
    if (provider === 'other') {
      body.imap = { host: form.imapHost.trim(), port: Number(form.imapPort) || 993, secure: Number(form.imapPort) !== 143 };
      body.smtp = { host: form.smtpHost.trim(), port: Number(form.smtpPort) || 465, secure: form.smtpSecurity === 'ssl' };
    }
    try {
      const r = edit
        ? await api(`mail/accounts/${edit.id}`, { method: 'PUT', body, timeout: 60000 })
        : await api('mail/accounts', { method: 'POST', body, timeout: 60000 });
      absorb('mail_accounts', [r.account]);
      toast(edit ? 'Password updated' : `${r.account.email} connected — syncing your mail`, { icon: 'check' });
      onAdded(r.account);
      syncAccount(r.account.id, { quiet: false });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  // Typing a known address on "Other" switches to the right preset.
  const onEmail = (e) => {
    const v = e.target.value;
    setForm({ ...form, email: v });
    if (provider === 'other') {
      const match = PROVIDERS.find((x) => x.domains?.test(v.trim()));
      if (match) setProvider(match.id);
    }
  };

  return html`<${Portal}>
    <div class="dialog-scrim acct-scrim" data-layer="900" style=${{ zIndex: 1900 }} onPointerDown=${(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form class="dialog acct-sheet" onSubmit=${submit} aria-label="Add a mail account">
        ${!provider ? html`
          <h2 class="dialog-title">Add a mail account</h2>
          <p class="dialog-body">BCOS reads mail over IMAP and sends with SMTP. Your password is stored only on your Umbrel.</p>
          <div class="provider-grid">
            ${PROVIDERS.map((x) => html`<button type="button" key=${x.id} class="provider-tile" onClick=${() => setProvider(x.id)}>
              <${ProviderMark} id=${x.id} /><span>${x.id === 'other' ? 'Other IMAP' : x.name}</span>
            </button>`)}
          </div>
          <div class="dialog-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button></div>
        ` : html`
          <div class="acct-head">
            ${!edit && html`<${IconButton} icon="chevron-left" label="Back" onClick=${() => { setProvider(null); setError(null); }} />`}
            <${ProviderMark} id=${provider} size=${30} />
            <h2 class="dialog-title">${edit ? `Update ${edit.email}` : p.id === 'other' ? 'Other mail account' : `Add ${p.name}`}</h2>
          </div>
          <p class="acct-help">${p.help}</p>
          ${!edit && html`<label class="acct-field"><span>Your name</span><input class="field" value=${form.name} onInput=${set('name')} placeholder="Shown to people you email" autocomplete="name" /></label>`}
          <label class="acct-field"><span>Email</span><input class="field" type="email" required value=${form.email} onInput=${onEmail} disabled=${!!edit}
            placeholder=${{ icloud: 'you@icloud.com', gmail: 'you@gmail.com', yahoo: 'you@yahoo.com', fastmail: 'you@fastmail.com' }[provider] || 'you@example.com'} autocomplete="email" autofocus /></label>
          <label class="acct-field"><span>${provider === 'other' ? 'Password' : 'App password'}</span><input class="field" type="password" required value=${form.password} onInput=${set('password')} placeholder=${provider === 'gmail' ? 'xxxx xxxx xxxx xxxx' : provider === 'icloud' ? 'xxxx-xxxx-xxxx-xxxx' : ''} autocomplete="off" /></label>
          ${provider === 'other' && !edit && html`
            <div class="acct-servers">
              <label class="acct-field grow"><span>Incoming (IMAP) server</span><input class="field" required value=${form.imapHost} onInput=${set('imapHost')} placeholder="imap.example.com" /></label>
              <label class="acct-field port"><span>Port</span><input class="field" inputmode="numeric" value=${form.imapPort} onInput=${set('imapPort')} /></label>
            </div>
            <div class="acct-servers">
              <label class="acct-field grow"><span>Outgoing (SMTP) server</span><input class="field" required value=${form.smtpHost} onInput=${set('smtpHost')} placeholder="smtp.example.com" /></label>
              <label class="acct-field port"><span>Port</span><input class="field" inputmode="numeric" value=${form.smtpPort} onInput=${(e) => setForm({ ...form, smtpPort: e.target.value, smtpSecurity: e.target.value === '465' ? 'ssl' : 'starttls' })} /></label>
              <label class="acct-field port"><span>Security</span><select class="field" value=${form.smtpSecurity} onChange=${set('smtpSecurity')}><option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option></select></label>
            </div>
            <label class="acct-field"><span>Username <small>(if not your email)</small></span><input class="field" value=${form.username} onInput=${set('username')} autocomplete="off" /></label>
          `}
          ${error && html`<div class="acct-error"><${Icon} name="alert" size=${15} /><span>${error}</span></div>`}
          <div class="dialog-actions">
            <button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? html`<span class="spinner sm" />Signing in…` : edit ? 'Save' : 'Sign in'}</button>
          </div>
        `}
      </form>
    </div>
  </${Portal}>`;
}
