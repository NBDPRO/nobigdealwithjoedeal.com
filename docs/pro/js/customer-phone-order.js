/* customer-phone-order.js — the customer page, ordered for a phone on a roof.
 *
 * Phone audit 2026-10-07, item 1: at 390x844 the customer page was 15 phone
 * screens long. The quick-note box sat 4.9 screens down, Build Estimate 4.7,
 * and Record payment 12.3 — under 22 document-template tiles (2.6 screens on
 * their own). Desktop was 8.7 screens.
 *
 * Three jobs, none of which renders data or owns a handler of its own:
 *
 *   1. The roof-day action row (#roofActionRow in customer.html). Each button
 *      reaches the control that already did that job:
 *        Call     → clicks #callLink, so the header's own onclick writes the
 *                   Comm Log row and the tel: link dials;
 *        Text     → clicks the bottom quick bar's Text when it is on screen
 *                   (≤640px — its capture listener logs), else opens the same
 *                   sms: composer and logs through the same registry logger;
 *        Note / Estimate / Payment → plain data-action markup, dispatched by
 *                   the page delegate in customer-tasks-ui.js to the existing
 *                   openNotesModal / _openInDashboardEstimate /
 *                   NBDCustomerInvoices.recordPayment;
 *        Navigate → directions to the address shown in the header.
 *      Call and Text hide when the lead has no phone (same rule as the bar).
 *
 *   2. Folds. Rarely used panels are <details class="cpo-fold"
 *      data-fold="phone" open> in the markup, so desktop and a no-JS page
 *      keep them open. On a phone (≤900px, where the page is one column)
 *      they start closed. A jump to a section (#documentsTab from the jump
 *      nav, the checklist's "Generate →", or a #hash in the URL) opens the
 *      folds inside it, so a link never lands on a closed row. Portal
 *      Messages opens itself when the unread badge shows.
 *
 *   3. Money first. Invoices & Payments carries data-owed="1" while its
 *      "Total Owed" reads more than $0; the phone stylesheet floats it to the
 *      top of Overview. Read from the rendered summary, never recomputed.
 *
 * The ORDER itself is CSS (css/customer-phone-order.css): Overview's two
 * columns become display:contents inside a flex column, so panels from both
 * columns interleave by `order` without moving any markup.
 *
 * CSP: no inline handlers, nothing put on window.
 */
(function () {
  'use strict';

  var LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (LOADED['customer-phone-order']) return;
  LOADED['customer-phone-order'] = true;

  var PHONE_MAX = 900;

  function isPhone() {
    try { return window.matchMedia('(max-width:' + PHONE_MAX + 'px)').matches; }
    catch (e) { return (window.innerWidth || 1024) <= PHONE_MAX; }
  }
  function digits(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }
  function $(id) { return document.getElementById(id); }
  function curLead() {
    var l = window._currentLead;
    return (l && typeof l === 'object') ? l : {};
  }
  // The header is what the rep reads, and the edit modal rewrites it in
  // place, so it is the freshest source; the lead object is the fallback.
  function headerText(id) {
    var el = $(id);
    var t = el ? String(el.textContent || '').trim() : '';
    return (t && t !== '—') ? t : '';
  }
  function phoneDigits() { return digits(headerText('customerPhone') || curLead().phone); }
  function address() { return headerText('customerAddress') || String(curLead().address || '').trim(); }

  function directionsUrl(addr) {
    var q = encodeURIComponent(addr);
    return /iP(ad|hone|od)|Macintosh/.test(navigator.userAgent || '')
      ? 'https://maps.apple.com/?daddr=' + q
      : 'https://www.google.com/maps/dir/?api=1&destination=' + q;
  }

  function logComm(type, label) {
    var leadId = window._customerId;
    var reg = window.__NBD_CALL_REGISTRY;
    if (!leadId || !reg || typeof reg.logCommunication !== 'function') return;
    try {
      Promise.resolve(reg.logCommunication(leadId, type, label)).catch(function (err) {
        console.warn('[cpo] comm log failed:', err && err.message);
      });
    } catch (err) { console.warn('[cpo] comm log threw:', err && err.message); }
  }

  // ── 1. Action row ──────────────────────────────────────────────────
  function rowBtn(kind) {
    var r = $('roofActionRow');
    return r ? r.querySelector('[data-roof="' + kind + '"]') : null;
  }

  function syncRow() {
    var tel = phoneDigits();
    var call = rowBtn('call'), text = rowBtn('text'), nav = rowBtn('navigate');
    if (call) { call.hidden = !tel; call.setAttribute('href', 'tel:' + tel); }
    if (text) { text.hidden = !tel; text.setAttribute('href', 'sms:' + tel); }
    if (nav) {
      var a = address();
      nav.hidden = !a;
      nav.setAttribute('href', a ? directionsUrl(a) : '#');
    }
  }

  function onRowClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('#roofActionRow [data-roof]');
    if (!btn) return;
    var kind = btn.getAttribute('data-roof');
    if (kind === 'call') {
      // One handler: the header's Call link logs and dials.
      var hc = $('callLink');
      if (hc && /^tel:\d/.test(hc.getAttribute('href') || '')) {
        e.preventDefault();
        hc.click();
      }
      // No header link yet (lead still loading): let our own tel: through.
      return;
    }
    if (kind === 'text') {
      var tel = phoneDigits();
      if (!tel) { e.preventDefault(); return; }
      var bar = document.querySelector('#nbd-quick-action-bar a.qab-sms');
      if (bar) { e.preventDefault(); bar.click(); return; }
      btn.setAttribute('href', 'sms:' + tel);
      var l = curLead();
      logComm('sms', 'Texted ' + ((l.firstName || l.name) || 'customer') + ' from the action row');
      return;
    }
    if (kind === 'navigate') {
      var addr = address();
      if (!addr) { e.preventDefault(); return; }
      btn.setAttribute('href', directionsUrl(addr));
    }
    // note / estimate / payment: data-action → the page delegate.
  }

  // ── 2. Folds ───────────────────────────────────────────────────────
  function folds(root) {
    return Array.prototype.slice.call((root || document).querySelectorAll('details.cpo-fold[data-fold="phone"]'));
  }

  function stampCounts() {
    folds().forEach(function (d) {
      var c = d.querySelector('[data-fold-count]');
      if (!c) return;
      var n = document.querySelectorAll(c.getAttribute('data-fold-count')).length;
      c.textContent = n ? String(n) : '';
    });
  }

  // Open every fold inside the section an in-page link points at, and every
  // fold that CONTAINS the target, so the jump lands on content.
  function openFor(hash) {
    if (!hash || hash.charAt(0) !== '#' || hash.length < 2) return;
    var t;
    try { t = document.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) { t = null; }
    if (!t) return;
    if (t.matches && t.matches('details.cpo-fold')) t.open = true;
    folds(t).forEach(function (d) { d.open = true; });
    for (var p = t.parentElement; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && p.classList.contains('cpo-fold')) p.open = true;
    }
  }

  function onAnyClick(e) {
    var a = e.target && e.target.closest && e.target.closest('a[href^="#"]');
    if (a) openFor(a.getAttribute('href'));
  }

  function watchUnread() {
    var badge = $('msgUnreadBadge'), fold = $('messagesFold');
    if (!badge || !fold) return;
    var check = function () {
      if (badge.style.display !== 'none' && String(badge.textContent || '').trim()) fold.open = true;
    };
    check();
    try { new MutationObserver(check).observe(badge, { attributes: true, attributeFilter: ['style'], childList: true, characterData: true, subtree: true }); }
    catch (e) { /* optimisation */ }
  }

  // A Voice Intel error toast is appended inside #voiceIntelRoot, i.e. inside
  // the Voice fold; a closed <details> would hide it. Errors follow a tap in
  // the open panel, but if the rep folded it mid-upload, re-open it.
  function watchVoiceToasts() {
    var root = $('voiceIntelRoot'), fold = $('voiceFold');
    if (!root || !fold) return;
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType === 1 && n.classList && n.classList.contains('nbd-voice-toast')) { fold.open = true; return; }
          }
        }
      }).observe(root, { childList: true, subtree: true });
    } catch (e) { /* optimisation */ }
  }

  // ── 3. Money first ─────────────────────────────────────────────────
  function owedCents(list) {
    var items = list.querySelectorAll('.payment-summary .summary-item');
    for (var i = 0; i < items.length; i++) {
      var lab = items[i].querySelector('.summary-label');
      if (!lab || !/total owed/i.test(lab.textContent || '')) continue;
      var v = items[i].querySelector('.summary-value');
      var n = parseFloat(String(v ? v.textContent : '').replace(/[^0-9.]/g, ''));
      return isFinite(n) ? Math.round(n * 100) : 0;
    }
    return 0;
  }
  function watchMoney() {
    var list = $('invoiceList'), panel = $('invoicesPanel');
    if (!list || !panel) return;
    var check = function () {
      if (owedCents(list) > 0) panel.setAttribute('data-owed', '1');
      else panel.removeAttribute('data-owed');
    };
    check();
    try { new MutationObserver(check).observe(list, { childList: true, subtree: true, characterData: true }); }
    catch (e) { /* optimisation */ }
  }

  // ── boot ───────────────────────────────────────────────────────────
  function boot() {
    var r = $('roofActionRow');
    if (r) r.addEventListener('click', onRowClick);
    document.addEventListener('click', onAnyClick, true);

    stampCounts();
    if (isPhone()) {
      folds().forEach(function (d) { d.open = false; });
    }
    if (location.hash) openFor(location.hash);
    window.addEventListener('hashchange', function () { openFor(location.hash); });
    watchUnread();
    watchVoiceToasts();
    watchMoney();

    syncRow();
    // The lead lands after first paint; keep the row honest until it does,
    // and on every background refresh after.
    var tries = 0;
    var t = setInterval(function () {
      syncRow();
      if ((window._currentLead && window._customerId) || ++tries > 100) clearInterval(t);
    }, 300);
    window.addEventListener('nbd:data-refreshed', function () { setTimeout(syncRow, 60); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
