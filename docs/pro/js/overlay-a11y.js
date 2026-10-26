/* ══════════════════════════════════════════════════════════════════════
   overlay-a11y.js — window.nbdOverlay: the keyboard contract for the CRM's
   SELF-BUILT dialogs (overnight pass 2026-10-26, finding crm-5).

   nbd-modal.js already gives every .modal-bg modal Escape, focus-in and
   focus-back. These eight did not use it and had nothing of their own, so
   Escape did nothing, focus stayed on the page behind, Tab walked that page,
   and the single-letter hotkeys ("n", "e") fired behind them:
     Customize widgets (widgets.js)        New knock (d2d-tracker-ui-2026b.js)
     Import Home Depot (hd-import.js)      Place sign (yard-signs.js)
     Ask Joe scenarios (decision-engine.js) Appearance + Theme guide (maps.js)
     What's new (whats-new.js)

   CONTRACT (call it once, right after the overlay is in the DOM and showing):

     nbdOverlay.attach(el, {
       label: 'Import Home Depot purchases', // aria-label, only if el has no name
       close: fn,                            // what Escape does: the SAME thing the
                                             // visible close button does
       isOpen: fn(el)                        // optional; default = connected and not
                                             // display:none / visibility:hidden
     });

   What attach() does:
   • Gives the dialog role="dialog" aria-modal="true" and the label, unless it
     already has them. That also makes nbdModal.anyOpen() true, which is what
     keeps the global hotkeys off (it looks for a visible aria-modal / dialog).
   • Moves focus to the first tabbable inside (or the dialog itself).
   • Remembers the opener. A dialog re-rendered under the same id (Decision
     Engine: picker -> detail -> picker) keeps the opener of the one it replaced.
   • ONE window keydown listener, for the top-most attached dialog only:
     Escape runs close(); Tab / Shift+Tab wrap inside it, and a Tab from behind
     it lands inside. A modal opened OVER an attached dialog (nbdModal.confirm, a
     <dialog>) has no Tab trap of its own: while focus is in it, Tab / Shift+Tab
     wrap inside THAT modal, never to the dialog behind.
   • Watches the dialog (class / hidden / style, and removal). The moment it is
     no longer open, by ANY path (close button, backdrop, Escape, code), it takes
     back the attributes it added and returns focus to the opener, unless focus
     has already moved somewhere real.

   LAYERING: the listener is on window and nbd-modal.js's Escape handler is on
   document and calls stopPropagation(), so a confirm opened over a dialog
   closes first and the dialog stays; the next Escape closes the dialog.
   Escape does NOT honour a prior preventDefault(): shortcuts-help.js calls it on
   the first Escape of a session (its "panel is open" test reads true for a panel
   that was never opened), which would swallow the first Escape. A list inside
   the dialog that wants the first Escape (the knock sheet's address
   suggestions) handles that in its own close().

   CSP: no inline handlers; this file binds its own listener.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.nbdOverlay) return; // single owner

  var TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
  var DIALOG = '[role="dialog"], [role="alertdialog"]';
  var entries = []; // oldest first; the last one still open is the top layer
  var watcher = null;

  function shown(el) {
    if (!el || !el.isConnected || el.hidden) return false;
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function alive(e) { return e.el.isConnected && (e.isOpen ? !!e.isOpen(e.el) : shown(e.el)); }

  function tabbable(n) {
    if (n.matches(':disabled') || n.tabIndex < 0 || n.hidden || n.closest('[inert]')) return false;
    if (n.tagName === 'INPUT' && n.type === 'hidden') return false;
    // The inside of a closed <details> keeps its boxes (getClientRects() is not empty) but the
    // browser skips it in the tab order; only the <summary> itself is a stop.
    var closed = n.closest('details:not([open])');
    if (closed) { var sm = n.closest('summary'); if (!sm || sm.parentNode !== closed) return false; }
    return n.getClientRects().length > 0 && window.getComputedStyle(n).visibility !== 'hidden';
  }
  function tabbables(root) { return Array.prototype.filter.call(root.querySelectorAll(TABBABLE), tabbable); }

  function focusNode(n) {
    try { n.focus({ preventScroll: true }); } catch (_) { try { n.focus(); } catch (__) { /* detached */ } }
  }

  // The modal focus is in, when it is not one of ours: a confirm or <dialog> opened over an
  // attached dialog. Anything inside (or around) an attached dialog is ours, so a stray focus
  // in a lower dialog is still pulled up to the top one.
  var OTHER_MODAL = '.modal-bg.open, dialog[open], [role="alertdialog"], [aria-modal="true"]';
  function layerOf(top, a) {
    var m = a && a.closest ? a.closest(OTHER_MODAL) : null;
    if (!m) return top.el;
    for (var i = 0; i < entries.length; i++) if (entries[i].el.contains(m) || m.contains(entries[i].el)) return top.el;
    return m;
  }

  function find(el) {
    for (var i = 0; i < entries.length; i++) if (entries[i].el === el) return entries[i];
    return null;
  }
  function top() {
    for (var i = entries.length - 1; i >= 0; i--) if (alive(entries[i])) return entries[i];
    return null;
  }

  // Set an attribute only if the dialog does not carry it already; remember it so
  // release() can take it back (a static dialog that stays in the DOM must not
  // keep aria-modal while it is closed).
  function put(e, node, name, value) {
    if (node.hasAttribute(name)) return;
    node.setAttribute(name, value);
    e.added.push({ node: node, name: name });
  }

  function moveFocusIn(e) {
    var first = tabbables(e.el)[0];
    if (!first) { put(e, e.el, 'tabindex', '-1'); first = e.el; }
    focusNode(first);
  }

  function watch() {
    if (!window.MutationObserver) return;
    if (!watcher) watcher = new MutationObserver(sweep);
    watcher.disconnect();
    entries.forEach(function (e) {
      watcher.observe(e.el, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
      if (e.el.parentNode) watcher.observe(e.el.parentNode, { childList: true });
    });
    if (entries.length) watcher.observe(document.body, { childList: true });
  }

  function release(e) {
    var i = entries.indexOf(e);
    if (i < 0) return;
    entries.splice(i, 1);
    e.added.forEach(function (a) { a.node.removeAttribute(a.name); });
    var a = document.activeElement, back = e.opener;
    if (back && back.isConnected && tabbable(back) && (!a || a === document.body || e.el.contains(a))) focusNode(back);
    watch();
  }
  function sweep() {
    for (var i = entries.length - 1; i >= 0; i--) if (entries[i] && !alive(entries[i])) release(entries[i]);
  }

  function attach(el, opts) {
    if (!el || el.nodeType !== 1) return;
    opts = opts || {};
    var e = find(el);
    if (e) { if (typeof opts.close === 'function') e.close = opts.close; return; } // already open: keep the first opener
    var active = document.activeElement;
    var opener = (active && active !== document.body && !el.contains(active)) ? active : null;
    if (!opener && el.id) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].el.isConnected && entries[i].el.id === el.id) { opener = entries[i].opener; entries.splice(i, 1); break; }
      }
    }
    e = { el: el, close: opts.close, isOpen: opts.isOpen, opener: opener, added: [] };
    var dlg = el.matches(DIALOG) ? el : el.querySelector(DIALOG);
    if (!dlg) { dlg = el; put(e, dlg, 'role', 'dialog'); }
    put(e, dlg, 'aria-modal', 'true');
    if (opts.label && !dlg.hasAttribute('aria-label') && !dlg.hasAttribute('aria-labelledby')) put(e, dlg, 'aria-label', opts.label);
    entries.push(e);
    watch();
    moveFocusIn(e);
    // A dialog that fades in can still be visibility:hidden for a frame, and focus() no-ops there.
    setTimeout(function () { if (find(el) && !el.contains(document.activeElement)) moveFocusIn(e); }, 60);
  }

  window.addEventListener('keydown', function (ev) {
    if (ev.isComposing || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key !== 'Escape' && ev.key !== 'Tab') return;
    var e = top();
    if (!e) return;
    if (ev.key === 'Escape') {
      if (typeof e.close !== 'function') return;
      ev.preventDefault();
      try { e.close(); } catch (err) { console.warn('[nbdOverlay] close failed:', err && err.message); }
      return;
    }
    var a = document.activeElement, scope = layerOf(e, a), list = tabbables(scope);
    if (!list.length) { ev.preventDefault(); focusNode(scope); return; }
    var first = list[0], last = list[list.length - 1];
    if (!scope.contains(a) || a === scope) { ev.preventDefault(); focusNode(ev.shiftKey ? last : first); }
    else if (ev.shiftKey && a === first) { ev.preventDefault(); focusNode(last); }
    else if (!ev.shiftKey && a === last) { ev.preventDefault(); focusNode(first); }
  });

  window.nbdOverlay = { attach: attach };
})();
