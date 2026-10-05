// Small UI helpers: escaping, formatting, toasts, modals, API client.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const usd = (micros, d = 2) => '$' + ((micros || 0) / 1e6).toFixed(d);
export const pct = (x) => ((x || 0) * 100).toFixed(1) + '%';
export const num = (n) => (n || 0).toLocaleString();
export const dt = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const date = (ms) => (ms ? new Date(ms).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
export function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(1, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
}
export const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(method, path, body, opts = {}) {
  const headers = { 'X-Requested-With': 'xs' };
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = opts.contentType || 'text/plain'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch {}
  if (r.status === 401 && !opts.quiet) window.dispatchEvent(new CustomEvent('xs-unauth'));
  if (!r.ok) throw new ApiError(data?.error || `Request failed (${r.status})`, r.status);
  return data;
}

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}
/** Run an async action with error toast; returns undefined on failure. */
export async function attempt(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r ?? true; }
  catch (e) { toast(e.message, 'bad'); }
}

export function modal({ title, subtitle = '', body = '', wide = false, actions = true, okText = 'Save', cancelText = 'Cancel', onMount, onOk, danger = false }) {
  const root = $('#modal-root');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><h2>${esc(title)}</h2>${subtitle ? `<div class="muted">${subtitle}</div>` : ''}<div class="modal-body">${body}</div>
    ${actions ? `<div class="actions"><button data-x="cancel">${esc(cancelText)}</button>${onOk ? `<button class="${danger ? 'danger' : 'primary'}" data-x="ok">${esc(okText)}</button>` : ''}</div>` : ''}</div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    if (b.dataset.x === 'cancel') close();
    if (b.dataset.x === 'ok' && onOk) {
      b.disabled = true;
      try { const keep = await onOk(bg); if (keep !== false) close(); } catch (err) { toast(err.message, 'bad'); }
      b.disabled = false;
    }
  });
  root.append(bg);
  onMount?.(bg, close);
  bg.querySelector('input,select,textarea')?.focus();
  return { el: bg, close };
}
export function confirmDialog(title, message, okText = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title, body: `<p>${message}</p>`, okText, danger, onOk: () => { done = true; resolve(true); } });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe($('#modal-root'), { childList: true });
  });
}
export const formData = (root) => Object.fromEntries($$('[name]', root).map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
