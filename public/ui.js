// Shared UI primitives — Harry's Control Room.
// Self-contained: modal/toast create their own DOM nodes on first use, so nothing in
// index.html needs to pre-declare containers for these. Pure additions — nothing here
// is imported by the live app.js yet (that starts in Phase 1).
import { icon } from './icons.js';

// ---------------- toast ----------------
let toastStack = null;
function ensureToastStack() {
  if (toastStack) return toastStack;
  toastStack = document.createElement('div');
  toastStack.className = 'toast-stack';
  document.body.appendChild(toastStack);
  return toastStack;
}

// toast('Batch created ✓') or toast('Save failed', { tone: 'danger' })
export function toast(message, { tone = 'neutral', duration = 2800 } = {}) {
  const stack = ensureToastStack();
  const el = document.createElement('div');
  el.className = tone === 'neutral' ? 'toast' : `toast toast-${tone}`;
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ---------------- modal (replaces confirm() / prompt()) ----------------
let modalRoot = null;
let modalResolve = null;
let modalMode = 'confirm'; // 'confirm' | 'prompt' — decides what a cancel resolves to

function ensureModalRoot() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.className = 'modal-overlay';
  document.body.appendChild(modalRoot);
  modalRoot.addEventListener('click', (e) => { if (e.target === modalRoot) cancelModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalRoot.classList.contains('show')) cancelModal(); });
  return modalRoot;
}

function cancelModal() {
  resolveModal(modalMode === 'prompt' ? null : false);
}

function resolveModal(result) {
  if (!modalRoot) return;
  modalRoot.classList.remove('show');
  if (modalResolve) {
    const r = modalResolve;
    modalResolve = null;
    setTimeout(() => r(result), 0);
  }
}

function renderModal({ title, bodyHtml, confirmLabel, cancelLabel, danger, showInput, inputPlaceholder, inputValue }) {
  const root = ensureModalRoot();
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${title}</div>
      <div class="modal-body">
        ${bodyHtml || ''}
        ${showInput ? `<input class="input" type="text" placeholder="${inputPlaceholder || ''}" value="${inputValue || ''}">` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-modal-cancel>${cancelLabel}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal-confirm>${confirmLabel}</button>
      </div>
    </div>`;
  requestAnimationFrame(() => root.classList.add('show'));

  const input = root.querySelector('.modal-body .input');
  if (input) setTimeout(() => input.focus(), 50);

  root.querySelector('[data-modal-cancel]').onclick = cancelModal;
  root.querySelector('[data-modal-confirm]').onclick = () => resolveModal(showInput ? (input ? input.value : '') : true);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveModal(input.value); });
}

// await confirmModal({ title: 'Delete this batch?', body: 'This cannot be undone.', danger: true })
// -> resolves true/false. Replaces confirm().
export function confirmModal({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    modalMode = 'confirm';
    modalResolve = resolve;
    renderModal({ title, bodyHtml: body ? `<p>${body}</p>` : '', confirmLabel, cancelLabel, danger });
  });
}

// await promptModal({ title: 'Cancel this class?', label: 'Reason (sent to students)' })
// -> resolves the entered string, or null if cancelled. Replaces prompt().
export function promptModal({ title = 'Enter a value', body = '', placeholder = '', value = '', confirmLabel = 'Save', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    modalMode = 'prompt';
    modalResolve = resolve;
    renderModal({ title, bodyHtml: body ? `<p>${body}</p>` : '', confirmLabel, cancelLabel, showInput: true, inputPlaceholder: placeholder, inputValue: value });
  });
}

// ---------------- badges ----------------
// badge('converted', 'success') -> pill string. Omit tone for a neutral pill.
export function badge(text, tone) {
  return `<span class="badge${tone ? ' badge-' + tone : ''}">${text}</span>`;
}

// countBadge(3) -> small numeric chip for sub-tab nav; countBadge(0) -> '' (nothing to show).
export function countBadge(n) {
  return n > 0 ? `<span class="badge-count">${n > 99 ? '99+' : n}</span>` : '';
}

// statusPill('WhatsApp connected', 'success') -> dotted status pill, for header-level state.
export function statusPill(text, tone) {
  return `<span class="status-pill${tone ? ' status-pill-' + tone : ''}"><span class="dot"></span>${text}</span>`;
}

// ---------------- list row ----------------
// row({ icon: 'mail', primary: 'priya@gmail.com', actionsHtml: '<button ...>' })
// -> the one row component every list in the app (emails, leads, backlog, payments,
// learning queue) should render through, instead of a bespoke <div> per screen.
export function row({ icon: iconName, primary, secondary = '', actionsHtml = '' }) {
  return `<div class="list-row">
    <div class="row-main">
      ${iconName ? `<span class="row-icon">${icon(iconName)}</span>` : ''}
      <div class="row-text">
        <div class="row-primary">${primary}</div>
        ${secondary ? `<div class="row-secondary">${secondary}</div>` : ''}
      </div>
    </div>
    ${actionsHtml ? `<div class="row-actions">${actionsHtml}</div>` : ''}
  </div>`;
}

// ---------------- error banner (replaces silent catch{}) ----------------
// showErrorBanner(document.querySelector('#lrLeadList'), 'Could not load leads.', () => loadLeadsTab())
export function showErrorBanner(container, message, onRetry) {
  if (!container) return;
  let el = container.querySelector(':scope > .error-banner');
  if (!el) {
    el = document.createElement('div');
    el.className = 'error-banner';
    container.prepend(el);
  }
  el.innerHTML = `<span class="msg">${icon('alertCircle', { size: 14 })} ${message}</span>`;
  if (onRetry) {
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.onclick = () => { clearErrorBanner(container); onRetry(); };
    el.appendChild(btn);
  }
}

export function clearErrorBanner(container) {
  const el = container && container.querySelector(':scope > .error-banner');
  if (el) el.remove();
}
