/* ══════════════════════════════════════════════════════════════════════
   nbd-modal.js — window.nbdModal: the ONE way to drive .modal-bg modals.
   (Foundations, CRM visual-audit batch 2/3 — 2026-07-20)

   CONTRACT FOR CONVERTERS (subsystem agents replacing ad-hoc overlays):

     nbdModal.open('myModal')            // id or element of a .modal-bg
     nbdModal.open(el, { static: true }) // backdrop click does NOT close
     nbdModal.close('myModal')
     nbdModal.confirm({
       title:   'Delete lead?',          // plain text (rendered textContent)
       body:    'This cannot be undone.',// plain text (rendered textContent)
       okLabel: 'Delete',                // default 'OK'
       cancelLabel: 'Cancel',            // default 'Cancel'
       danger:  true                     // ok button red instead of orange
     }).then(ok => { if (ok) ... });     // resolves false on cancel/Esc/backdrop

   RULES (cert-round invariants — do not regress):
   • Markup is the CANONICAL pair from dashboard-app.css (~:2178):
       <div class="modal-bg" id="..."><div class="modal">…</div></div>
     .modal-bg is ALWAYS display:flex; visibility/opacity gate on .open —
     so open/close is ONLY classList.toggle('open'). NEVER inline display.
   • CSP: zero inline handlers. This file binds its own delegated
     listeners (Esc + backdrop click) — converters do not re-bind them.
   • Esc closes the top-most nbdModal-opened modal; backdrop click closes
     unless opened with { static:true }.
   • Focus-lite: first [autofocus] / button / input inside the .modal gets
     focus on open; the previously focused element is restored on close.
   • User strings passed to confirm() are rendered with textContent —
     never pass pre-built HTML.
   • Stacking: .modal-bg sits at var(--z-overlay). Anything that must beat
     an open modal uses var(--z-overlay-top); toasts own var(--z-toast).
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.nbdModal) return; // single owner

  // Modals opened through this helper + their per-open options. We only
  // Esc/backdrop-close modals WE opened, so legacy self-managed modals
  // keep their own handlers without double-firing.
  var managed = new Map(); // el -> { static:bool, restoreFocus:Element|null, onClose:fn|null }

  function resolve(target) {
    var el = (typeof target === 'string') ? document.getElementById(target) : target;
    if (!el || !el.classList || !el.classList.contains('modal-bg')) return null;
    return el;
  }

  function focusFirst(bg) {
    var card = bg.querySelector('.modal') || bg;
    var el = card.querySelector('[autofocus]') ||
             card.querySelector('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href]');
    if (!el || typeof el.focus !== 'function') return;
    var attempt = function () {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    };
    attempt();
    // The canonical .modal-bg fades in via a visibility transition, so the
    // subtree still computes visibility:hidden at open() time and the
    // synchronous focus() silently no-ops. Retry once after the first
    // transition frame. (Plain timeout, not rAF — see d2d-map-raf-fix.)
    setTimeout(function () {
      if (bg.classList.contains('open') && !bg.contains(document.activeElement)) attempt();
    }, 60);
  }

  function open(target, opts) {
    var el = resolve(target);
    if (!el) return null;
    opts = opts || {};
    managed.set(el, {
      static: !!opts.static,
      restoreFocus: (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null,
      onClose: (typeof opts.onClose === 'function') ? opts.onClose : null
    });
    el.classList.add('open');
    focusFirst(el);
    return el;
  }

  function close(target) {
    var el = resolve(target);
    if (!el) return;
    el.classList.remove('open');
    var st = managed.get(el);
    managed.delete(el);
    if (st) {
      if (st.restoreFocus && document.contains(st.restoreFocus)) {
        try { st.restoreFocus.focus({ preventScroll: true }); } catch (e) { /* noop */ }
      }
      if (st.onClose) { try { st.onClose(); } catch (e) { console.warn('nbdModal onClose failed:', e && e.message); } }
    }
  }

  function topOpenManaged() {
    // Last-opened wins (Map preserves insertion order).
    var top = null;
    managed.forEach(function (st, el) {
      if (el.classList.contains('open')) top = el;
    });
    return top;
  }

  // Delegated: backdrop click closes (unless static). Only for managed modals.
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('modal-bg')) return;
    var st = managed.get(el);
    if (!st || !el.classList.contains('open') || st.static) return;
    close(el);
  });

  // Delegated: Esc closes the top-most managed modal.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var top = topOpenManaged();
    if (!top) return;
    var st = managed.get(top);
    if (st && st.static) return;
    e.stopPropagation();
    close(top);
  });

  // ── confirm(): promise-based OK/Cancel on a lazily-built singleton ──
  var confirmEl = null, confirmResolve = null;

  function buildConfirm() {
    var bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.id = 'nbdConfirmModal';

    var card = document.createElement('div');
    card.className = 'modal';
    card.setAttribute('role', 'alertdialog');
    card.style.maxWidth = '400px';

    var h = document.createElement('h3');
    h.className = 'nbd-confirm-title';
    h.style.cssText = 'font-family:\'Barlow Condensed\',sans-serif;font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;';

    var p = document.createElement('p');
    p.className = 'nbd-confirm-body';
    p.style.cssText = 'font-size:13px;color:var(--m);line-height:1.5;margin-bottom:18px;';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost nbd-confirm-cancel';

    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn nbd-confirm-ok';
    // Marker for focusFirst() — dynamically-inserted [autofocus] doesn't
    // auto-focus, but our open() picks it first.
    okBtn.setAttribute('autofocus', '');

    row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(row);
    bg.appendChild(card);
    document.body.appendChild(bg);

    cancelBtn.addEventListener('click', function () { settle(false); });
    okBtn.addEventListener('click', function () { settle(true); });
    return bg;
  }

  function settle(result) {
    if (!confirmEl) return;
    var r = confirmResolve;
    confirmResolve = null;
    close(confirmEl);
    if (r) r(result);
  }

  function confirm(opts) {
    opts = opts || {};
    if (!confirmEl) confirmEl = buildConfirm();
    // A second confirm while one is pending cancels the first.
    if (confirmResolve) settle(false);

    confirmEl.querySelector('.nbd-confirm-title').textContent = opts.title || 'Are you sure?';
    confirmEl.querySelector('.nbd-confirm-body').textContent = opts.body || '';
    var cancelBtn = confirmEl.querySelector('.nbd-confirm-cancel');
    var okBtn = confirmEl.querySelector('.nbd-confirm-ok');
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    okBtn.textContent = opts.okLabel || 'OK';
    okBtn.className = 'btn nbd-confirm-ok ' + (opts.danger ? 'btn-red' : 'btn-orange');

    return new Promise(function (res) {
      confirmResolve = res;
      // Backdrop/Esc close via the managed onClose hook → resolve(false).
      open(confirmEl, { onClose: function () {
        if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(false); }
      } });
    });
  }

  // Is ANY modal/dialog showing? Global single-letter hotkeys (n / e / c …)
  // must stay off while one is: on 2026-09-30 keystrokes typed in the Edit
  // Lead modal, with focus off an input, fired "e" and opened New Estimate
  // over it. Covers nbdModal-managed and self-managed .modal-bg, native
  // <dialog open>, and any visible aria-modal overlay (shortcuts panel,
  // command palette, estimate chooser …).
  function anyOpen() {
    if (document.querySelector('.modal-bg.open, dialog[open]')) return true;
    var list = document.querySelectorAll('[aria-modal="true"], [role="dialog"]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.hidden) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length) return true;
    }
    return false;
  }

  window.nbdModal = { open: open, close: close, confirm: confirm, anyOpen: anyOpen };
})();
