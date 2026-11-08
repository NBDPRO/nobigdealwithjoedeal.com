/**
 * review-handoff-lazy.js — the customer page loads the "Job done" hand-off
 * (qr-code.js + review-handoff.js) only for a lead at Install Done or later
 * (customer-page boot lane, 2026-11-08).
 *
 * Both files used to be deferred <script> tags on every customer page open.
 * At boot all they did was register review-handoff.js's click listener and
 * its 1.5 s poll that unhides #jobDoneHandoffBtn when window._currentLead is
 * at Install Done or later. This file runs that poll with the same stage rule
 * (copied below: review-handoff.js is not loaded yet when the button must
 * show) and, when the button shows or on the first click, loads both files as
 * the `reviewhandoff` ScriptLoader bundle, registered at runtime like
 * dark-features.js's, so the blocking script-loader.js does not grow. Once
 * review-handoff.js has run it owns the button and every click, as before.
 *
 *   - A click before the files land opens the card when they land (once, even
 *     for a double tap).
 *   - A failed fetch hides the button again, as a failed eager tag left it,
 *     and a waiting click is told to reload: ScriptLoader keeps the failed
 *     tag, so it stays failed until the page reloads. The page keeps working.
 *   - css/review-handoff.css stays an eager <link>: it styles the hidden button.
 *
 * tests/lazy-customer-review-handoff-2026-11-08.test.js keeps the stage rule
 * identical to review-handoff.js's.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.NBDReviewHandoffLazy || window.NBDReviewHandoff) return;

  var BUNDLE = 'reviewhandoff';
  // QR first; same paths and ?v= as Field's needs (layout-system.js), so one cache key per file.
  var FILES = ['js/qr-code.js?v=1', 'js/review-handoff.js?v=1'];

  // ── review-handoff.js's job-done rule, copied ───────────────────────────
  var DONE_STAGES = {
    install_complete: 1, final_photos: 1, deductible_collected: 1, collections: 1,
    final_payment: 1, closed: 1, warranty_claim: 1, complete: 1, completed: 1,
    closed_won: 1, 'closed-won': 1, won: 1,
  };
  function ms(t) {
    if (!t) return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (t instanceof Date) return t.getTime();
    var d = Date.parse(t);
    return isFinite(d) ? d : 0;
  }
  function stageKeyOf(lead) {
    var raw = String((lead && (lead._stageKey || lead.stage)) || '').trim().toLowerCase();
    return raw.replace(/\s+/g, '_');
  }
  function isJobDone(lead) {
    if (!lead || lead.deleted === true) return false;
    if (DONE_STAGES[stageKeyOf(lead)]) return true;
    return !!(ms(lead.installCompletedAt) || ms(lead.completedAt));
  }

  var timer = null, loading = null, failed = false, waiting = false, pendingId = '';

  function loader() {
    var sl = window.ScriptLoader;
    if (!sl || typeof sl.loadBundle !== 'function') return null;
    if (sl.bundles && !sl.bundles[BUNDLE]) sl.bundles[BUNDLE] = FILES;
    return sl;
  }
  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }
  // After the bundle: review-handoff.js takes the button over, or (it did not load) the button goes back to hidden.
  function landed() {
    var H = window.NBDReviewHandoff;
    stop();
    if (H) { if (typeof H.syncCustomerButton === 'function') H.syncCustomerButton(); return H; }
    failed = true;
    var b = document.getElementById('jobDoneHandoffBtn');
    if (b) b.hidden = true;
    return null;
  }
  /** Load both files once. Resolves to window.NBDReviewHandoff, or null when they did not load. */
  function load() {
    if (window.NBDReviewHandoff) return Promise.resolve(landed());
    if (loading) return loading;
    var sl = loader();
    if (!sl) return Promise.resolve(null);
    try { loading = Promise.resolve(sl.loadBundle(BUNDLE)).then(landed, landed); } catch (e) { loading = Promise.resolve(landed()); }
    return loading;
  }

  /** review-handoff.js's customer-page poll: show the button for a job-done lead, and fetch the files then. */
  function sync() {
    if (window.NBDReviewHandoff) { landed(); return; }
    var b = document.getElementById('jobDoneHandoffBtn');
    if (!b || failed) return;
    var lead = window._currentLead;
    var show = !!lead && isJobDone(lead) && !!loader();
    b.hidden = !show;
    if (show) { b.setAttribute('data-lead-id', String(window._customerId || lead.id || '')); load(); }
  }

  // Until review-handoff.js has run, a tap on [data-rh-open] loads it and then opens the card; its own
  // document-level listener takes every tap after that.
  function onClick(ev) {
    if (window.NBDReviewHandoff) return;
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-rh-open]') : null;
    if (!t) return;
    ev.preventDefault();
    pendingId = t.getAttribute('data-lead-id') || '';
    if (waiting) return;
    waiting = true;
    load().then(function (H) {
      waiting = false;
      if (H && typeof H.open === 'function') { H.open(pendingId); return; }
      if (typeof window.showToast === 'function') window.showToast('The Job done card did not load. Reload the page to try again.', 'error');
    });
  }

  loader();
  document.addEventListener('click', onClick);
  if (document.getElementById('jobDoneHandoffBtn')) timer = setInterval(sync, 1500);

  window.NBDReviewHandoffLazy = { sync: sync, load: load, isJobDone: isJobDone, bundle: BUNDLE, files: FILES };
})();
