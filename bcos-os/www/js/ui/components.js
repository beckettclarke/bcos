// Shared UI: layers (portal, popover, menu, dialog), toasts, and controls.

import { html, render, useState, useEffect, useLayoutEffect, useRef, useReducer, useCallback } from '../lib/html.js';
import { cx, clamp, initials, hashHue } from '../lib/util.js';
import { Icon } from './icons.js';

// ---------------------------------------------------------------------------
// Layers & Escape. Every floating thing takes the next layer number; a click
// outside closes a layer only if it landed on something below it, and Escape
// always goes to the top-most layer first.
// ---------------------------------------------------------------------------

let layerSeq = 10;
const escapeStack = [];

/** When a layer last closed from an outside click — lets the click that
 * dismissed a popover avoid also acting on what's underneath. */
export const layers = { lastOutsideClose: 0 };
export const justClosedLayer = () => performance.now() - layers.lastOutsideClose < 120;

// Bubble phase, so anything that handles Escape itself (an inline menu in the
// editor, a search field) can stop it first. Escape in a text field that isn't
// part of a floating layer just leaves the field; the next one closes things.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !escapeStack.length) return;
  const t = e.target;
  const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  e.preventDefault();
  if (editable && !t.closest('[data-layer]')) { t.blur(); return; }
  escapeStack[escapeStack.length - 1].handler(e);
});

/** Register an Escape handler while `active`. The newest registration wins. */
export function useEscape(handler, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry = { handler: (e) => ref.current(e) };
    escapeStack.push(entry);
    return () => { const i = escapeStack.indexOf(entry); if (i >= 0) escapeStack.splice(i, 1); };
  }, [active]);
}

export function Portal({ children }) {
  const host = useRef(null);
  if (!host.current) host.current = document.createElement('div');
  useLayoutEffect(() => {
    const el = host.current;
    (document.getElementById('portal') || document.body).appendChild(el);
    return () => { render(null, el); el.remove(); };
  }, []);
  useLayoutEffect(() => { render(children, host.current); });
  return null;
}

function layerOf(el) {
  const hit = el && el.closest && el.closest('[data-layer]');
  return hit ? Number(hit.dataset.layer) : 0;
}

/** Close on pointer-down outside the layer (ignoring layers above it). */
function useOutside(ref, layer, onClose, ignoreEl) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    const down = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      if (ignoreEl && ignoreEl.contains && ignoreEl.contains(e.target)) return;
      if (layerOf(e.target) > layer) return;
      layers.lastOutsideClose = performance.now();
      cb.current?.();
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', down, true), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', down, true); };
  }, []);
}

const rectOf = (a) => (a && a.getBoundingClientRect ? a.getBoundingClientRect() : a);

/**
 * A floating panel anchored to an element or rect. It grows out of its
 * anchor (transform-origin points at it) and flips to stay on screen.
 */
export function Popover({ anchor, onClose, onEscape, placement = 'bottom-start', offset = 8, class: cls, style, width, children, closeOnEscape = true, label }) {
  const ref = useRef(null);
  const layer = useRef(++layerSeq).current;
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const r = rectOf(anchor);
    if (!el || !r) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, m = 10;
    let [side, align = 'center'] = placement.split('-');
    if (side === 'bottom' && r.bottom + offset + h > vh - m && r.top - offset - h > m) side = 'top';
    else if (side === 'top' && r.top - offset - h < m && r.bottom + offset + h < vh - m) side = 'bottom';
    else if (side === 'right' && r.right + offset + w > vw - m && r.left - offset - w > m) side = 'left';
    else if (side === 'left' && r.left - offset - w < m && r.right + offset + w < vw - m) side = 'right';
    let top, left;
    if (side === 'bottom' || side === 'top') {
      left = align === 'end' ? r.right - w : align === 'start' ? r.left : r.left + r.width / 2 - w / 2;
      top = side === 'bottom' ? r.bottom + offset : r.top - h - offset;
    } else {
      top = align === 'end' ? r.bottom - h : align === 'start' ? r.top : r.top + r.height / 2 - h / 2;
      left = side === 'right' ? r.right + offset : r.left - w - offset;
    }
    left = clamp(left, m, Math.max(m, vw - w - m));
    top = clamp(top, m, Math.max(m, vh - h - m));
    const ox = clamp(r.left + r.width / 2 - left, 0, w);
    const oy = clamp(r.top + r.height / 2 - top, 0, h);
    setPos({ top, left, origin: `${ox}px ${oy}px` });
  }, [anchor, placement]);

  useOutside(ref, layer, onClose, anchor && anchor.nodeType ? anchor : null);
  useEscape(() => (onEscape || onClose)?.(), closeOnEscape);

  return html`<${Portal}>
    <div ref=${ref} data-layer=${layer} role="dialog" aria-label=${label}
      class=${cx('popover', pos && 'is-placed', cls)}
      style=${{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, transformOrigin: pos?.origin, width, zIndex: 1000 + layer, ...style }}>
      ${children}
    </div>
  </${Portal}>`;
}

// ---------------------------------------------------------------------------
// Menus (dropdowns and context menus) through one global host.
// ---------------------------------------------------------------------------

let menuState = null;
const menuListeners = new Set();
const setMenu = (s) => { menuState = s; menuListeners.forEach((fn) => fn()); };

/** items: [{ label, icon, onSelect, danger, checked, shortcut, disabled } | { divider: true } | { heading }] */
export function openMenu(anchor, items, { placement = 'bottom-start', width, onDismiss } = {}) {
  setMenu({ anchor: anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor, items, placement, width, onDismiss, key: Math.random() });
}

export function openContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ anchor: { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 }, items, placement: 'bottom-start', key: Math.random() });
}

export const closeMenu = () => setMenu(null);

export function MenuHost() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { menuListeners.add(force); return () => menuListeners.delete(force); }, []);
  if (!menuState) return null;
  return html`<${Menu} key=${menuState.key} ...${menuState} onClose=${closeMenu} />`;
}

function Menu({ anchor, items, placement, width, onClose, onDismiss }) {
  const [active, setActive] = useState(-1);
  const listRef = useRef(null);
  const chosen = useRef(false);
  useEffect(() => () => { if (!chosen.current) onDismiss?.(); }, []);
  const selectable = items.map((it, i) => (!it.divider && !it.heading && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useEffect(() => { listRef.current?.focus(); }, []);

  const choose = (it) => { chosen.current = true; onClose(); setTimeout(() => it.onSelect?.(), 0); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = selectable.indexOf(active);
      const next = e.key === 'ArrowDown' ? selectable[(idx + 1) % selectable.length] : selectable[(idx - 1 + selectable.length) % selectable.length];
      setActive(next);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    }
  };

  return html`<${Popover} anchor=${anchor} onClose=${onClose} placement=${placement} offset=${4} class="menu-pop" width=${width}>
    <div class="menu" role="menu" tabindex="-1" ref=${listRef} onKeyDown=${onKey}>
      ${items.map((it, i) => it.divider ? html`<div class="menu-divider" />`
        : it.heading ? html`<div class="menu-heading">${it.heading}</div>`
        : html`<button type="button" role="menuitem" disabled=${it.disabled}
            class=${cx('menu-item', it.danger && 'is-danger', i === active && 'is-active')}
            onPointerEnter=${() => setActive(i)} onClick=${() => choose(it)}>
            <span class="menu-icon">${it.checked ? html`<${Icon} name="check" size=${15} />` : it.icon ? html`<${Icon} name=${it.icon} size=${15} />` : it.swatch ? html`<span class="swatch" style=${{ background: it.swatch }} />` : null}</span>
            <span class="menu-label">${it.label}</span>
            ${it.shortcut && html`<span class="menu-shortcut">${it.shortcut}</span>`}
          </button>`)}
    </div>
  </${Popover}>`;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

let dialogState = null;
const dialogListeners = new Set();
const setDialog = (s) => { dialogState = s; dialogListeners.forEach((fn) => fn()); };

/** Ask before something that can't be undone. Resolves true/false. */
export function confirm({ title, body, confirmLabel = 'OK', danger = false, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => setDialog({ title, body, confirmLabel, cancelLabel, danger, resolve }));
}

/** A one-field prompt. Resolves the string, or null when cancelled. */
export function prompt({ title, body, value = '', placeholder = '', confirmLabel = 'Save' }) {
  return new Promise((resolve) => setDialog({ title, body, confirmLabel, cancelLabel: 'Cancel', input: { value, placeholder }, resolve }));
}

export function DialogHost() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { dialogListeners.add(force); return () => dialogListeners.delete(force); }, []);
  if (!dialogState) return null;
  return html`<${Dialog} key=${dialogState.title} ...${dialogState} />`;
}

function Dialog({ title, body, confirmLabel, cancelLabel, danger, input, resolve }) {
  const [value, setValue] = useState(input?.value || '');
  const layer = useRef(++layerSeq).current;
  const okRef = useRef(null);
  const inputRef = useRef(null);
  const done = (result) => { setDialog(null); resolve(result); };
  useEscape(() => done(input ? null : false));
  useEffect(() => { (inputRef.current || okRef.current)?.focus(); inputRef.current?.select(); }, []);
  return html`<${Portal}>
    <div class="dialog-scrim" data-layer=${layer} style=${{ zIndex: 1000 + layer }} onPointerDown=${(e) => { if (e.target === e.currentTarget) done(input ? null : false); }}>
      <form class="dialog" role="alertdialog" aria-label=${title} onSubmit=${(e) => { e.preventDefault(); done(input ? value : true); }}>
        <h2 class="dialog-title">${title}</h2>
        ${body && html`<p class="dialog-body">${body}</p>`}
        ${input && html`<input ref=${inputRef} class="field" value=${value} placeholder=${input.placeholder} onInput=${(e) => setValue(e.target.value)} />`}
        <div class="dialog-actions">
          <button type="button" class="btn" onClick=${() => done(input ? null : false)}>${cancelLabel}</button>
          <button type="submit" ref=${okRef} class=${cx('btn', danger ? 'btn-danger' : 'btn-primary')}>${confirmLabel}</button>
        </div>
      </form>
    </div>
  </${Portal}>`;
}

// ---------------------------------------------------------------------------
// Toasts. Destructive actions offer Undo here instead of asking first.
// ---------------------------------------------------------------------------

let toasts = [];
const toastListeners = new Set();
const emitToasts = () => toastListeners.forEach((fn) => fn());

export function toast(message, { action, icon, tone, duration = 4200 } = {}) {
  const id = Math.random().toString(36).slice(2);
  toasts = [...toasts.filter((t) => !t.leaving).slice(-2), { id, message, action, icon, tone }];
  emitToasts();
  setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id) {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.leaving) return;
  t.leaving = true;
  emitToasts();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== id); emitToasts(); }, 220);
}

export function Toaster() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { toastListeners.add(force); return () => toastListeners.delete(force); }, []);
  return html`<div class="toaster" aria-live="polite">
    ${toasts.map((t) => html`<div key=${t.id} class=${cx('toast', t.leaving && 'is-leaving', t.tone && `is-${t.tone}`)}>
      ${t.icon && html`<${Icon} name=${t.icon} size=${16} />`}
      <span>${t.message}</span>
      ${t.action && html`<button class="toast-action" onClick=${() => { t.action.onClick(); dismissToast(t.id); }}>${t.action.label}</button>`}
    </div>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function IconButton({ icon, label, onClick, active, class: cls, size = 17, disabled, ...rest }) {
  return html`<button type="button" class=${cx('icon-btn', active && 'is-active', cls)} title=${label} aria-label=${label} aria-pressed=${active == null ? undefined : !!active} onClick=${onClick} disabled=${disabled} ...${rest}>
    <${Icon} name=${icon} size=${size} />
  </button>`;
}

/** A pill switcher whose highlight slides to the chosen option. */
export function Segmented({ options, value, onChange, class: cls, size }) {
  const ref = useRef(null);
  const [ind, setInd] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector(`[data-value="${CSS.escape(String(value))}"]`);
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = ref.current?.querySelector(`[data-value="${CSS.escape(String(value))}"]`);
      if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [value]);
  return html`<div class=${cx('segmented', size && `is-${size}`, cls)} ref=${ref} role="tablist">
    ${ind && html`<span class="segmented-ind" style=${{ transform: `translateX(${ind.x}px)`, width: `${ind.w}px` }} />`}
    ${options.map((o) => html`<button type="button" role="tab" aria-selected=${o.value === value} data-value=${o.value}
      class=${cx('segmented-opt', o.value === value && 'is-on')} onClick=${() => onChange(o.value)} title=${o.title}>
      ${o.icon && html`<${Icon} name=${o.icon} size=${15} />`}${o.label && html`<span>${o.label}</span>`}
    </button>`)}
  </div>`;
}

export function Toggle({ checked, onChange, label }) {
  return html`<button type="button" role="switch" aria-checked=${!!checked} aria-label=${label}
    class=${cx('toggle', checked && 'is-on')} onClick=${() => onChange(!checked)}><span class="toggle-knob" /></button>`;
}

export function Avatar({ name = '', size = 32, class: cls }) {
  const hue = hashHue(name);
  return html`<span class=${cx('avatar', cls)} style=${{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(145deg, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 65% 45%))` }}>${initials(name)}</span>`;
}

export function EmptyState({ icon, title, body, children, class: cls }) {
  return html`<div class=${cx('empty', cls)}>
    ${icon && html`<div class="empty-icon"><${Icon} name=${icon} size=${26} stroke=${1.5} /></div>`}
    ${title && html`<div class="empty-title">${title}</div>`}
    ${body && html`<div class="empty-body">${body}</div>`}
    ${children}
  </div>`;
}

export function ColorDots({ colors, value, onChange, size = 20 }) {
  return html`<div class="color-dots">
    ${colors.map((c) => html`<button type="button" class=${cx('color-dot', c === value && 'is-on')} style=${{ '--c': c, width: size, height: size }} aria-label=${c} onClick=${() => onChange(c)} />`)}
  </div>`;
}

/** Textarea that grows with its content. */
export function AutoTextarea({ value, onInput, class: cls, minRows = 1, ...rest }) {
  const ref = useRef(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [value]);
  return html`<textarea ref=${ref} rows=${minRows} class=${cx('autotext', cls)} value=${value} onInput=${(e) => { onInput?.(e); fit(); }} ...${rest} />`;
}

/** Keep a draft locally while typing and save it after a pause or on blur. */
export function useDraft(source, save, delay = 450) {
  const [draft, setDraft] = useState(source);
  const saveRef = useRef(save);
  saveRef.current = save;
  const timer = useRef(0);
  const dirty = useRef(false);
  const latest = useRef(draft);
  useEffect(() => { if (!dirty.current) { setDraft(source); latest.current = source; } }, [source]);
  const change = (v) => {
    setDraft(v);
    latest.current = v;
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { dirty.current = false; saveRef.current(v); }, delay);
  };
  const flush = () => {
    if (!dirty.current) return;
    clearTimeout(timer.current);
    dirty.current = false;
    saveRef.current(latest.current);
  };
  useEffect(() => () => flush(), []);
  return [draft, change, flush];
}

/** Matches a media query and re-renders when it flips. */
export function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export const useNarrow = () => useMedia('(max-width: 760px)');

/** Re-render every `ms` (for clocks and "x min ago"). */
export function useTick(ms = 30000) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { const t = setInterval(force, ms); return () => clearInterval(t); }, [ms]);
}
