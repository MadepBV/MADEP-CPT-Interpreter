// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Native <dialog> plumbing shared by the app's modals (design §3.15 anatomy, §4.4 contract).
//
// `showModal()` is what gives a modal its accessibility for free: the focus trap, `Esc`, the
// `inert` rest of the page and the top layer (no z-index race with the sticky chrome). This module
// adds the three things the platform does not: focus is restored to whatever opened the dialog,
// a click on the backdrop cancels, and the element is removed from the DOM on close so nothing
// accumulates. `openModal()` is the seam; `confirmDialog()` is the blocking-question form that
// replaces `window.confirm()` — it returns a promise, so callers that were synchronous must keep a
// synchronous fast path where they had one (see stratigraphy/view.js).
//
// It lives next to the import-review dialog because that is the app's first (and, until Stage 6
// grows one, only other) modal; a later PR that gives the app a `src/lib/ui/` should move it there.
//
// Environments without `<dialog>` (the Node golden harness stubs elements as plain objects) fall
// back to an `open` attribute plus a hand-rolled Tab trap; nothing here throws when a method or an
// event is missing.

let seq = 0;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Opens `dialog` (already in the document) as a modal and returns `close(result)`.
 *
 * @param {HTMLDialogElement} dialog
 * @param {(result: any) => void} onClose  called once, with whatever `close()` was given
 * @returns {(result?: any) => void}
 */
export function openModal(dialog, onClose) {
  const opener = typeof document !== 'undefined' ? document.activeElement : null;
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    dialog.removeEventListener?.('cancel', onCancel);
    dialog.removeEventListener?.('mousedown', onBackdrop);
    dialog.removeEventListener?.('keydown', onKeydown);
    try {
      dialog.close?.();
    } catch {
      /* not a real <dialog>, or already closed */
    }
    dialog.remove?.();
    // Focus goes back where it came from — the file input, the button, the table cell (§4.4).
    if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) {
      try {
        opener.focus();
      } catch {
        /* the opener may have been re-rendered away */
      }
    }
    onClose?.(result);
  }

  // Escape: <dialog> fires `cancel` and would close itself; take it over so the DOM is cleaned up
  // and focus restored through the one path.
  function onCancel(event) {
    event.preventDefault?.();
    close(null);
  }
  // Click outside the sheet: the dialog element fills the viewport, its only child is the sheet.
  function onBackdrop(event) {
    if (event.target === dialog) close(null);
  }
  // Only reached when showModal() is unavailable — the platform traps focus itself otherwise.
  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      close(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll?.(FOCUSABLE) || []).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  dialog.addEventListener?.('cancel', onCancel);
  dialog.addEventListener?.('mousedown', onBackdrop);

  if (typeof dialog.showModal === 'function') {
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute?.('open', '');
    }
  } else {
    dialog.setAttribute?.('open', '');
    dialog.addEventListener?.('keydown', onKeydown);
  }

  return close;
}

/**
 * The blocking question. Replaces `window.confirm()` with the app's own sheet.
 *
 *   if (await confirmDialog({ title: '…', body: '…', confirmLabel: 'Doorgaan' })) …
 *
 * @param {{title: string, body?: string, confirmLabel?: string, cancelLabel?: string, tone?: 'default'|'danger'}} opts
 * @returns {Promise<boolean>}  false when cancelled, dismissed or run without a DOM
 */
export function confirmDialog({ title, body = '', confirmLabel = 'Doorgaan', cancelLabel = 'Annuleer', tone = 'default' } = {}) {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = `madep-confirm-${++seq}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'modal-host';
    dialog.setAttribute('aria-labelledby', id);
    dialog.innerHTML = `
      <div class="modal modal--ask glass-sheet">
        <div class="modal__head">
          <h2 class="modal__title" id="${id}">${esc(title)}</h2>
        </div>
        <div class="modal__body">
          ${body ? `<p class="modal__ask-body">${esc(body).replace(/\n/g, '<br>')}</p>` : ''}
        </div>
        <div class="modal__foot">
          <button type="button" class="btn" data-ask="cancel">${esc(cancelLabel)}</button>
          <button type="button" class="btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}" data-ask="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);

    const close = openModal(dialog, (result) => resolve(result === true));
    dialog.querySelectorAll('[data-ask]').forEach((btn) => {
      btn.addEventListener('click', () => close(btn.dataset.ask === 'ok'));
    });
    // A destructive question opens on "cancel": the safe answer is the one under the return key.
    dialog.querySelector(tone === 'danger' ? '[data-ask="cancel"]' : '[data-ask="ok"]')?.focus?.();
  });
}
