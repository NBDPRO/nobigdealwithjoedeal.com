// real-account.js — "Available in your real account" cards for the parts of
// Settings the browser-only sample account does not run (Pro demo phase 2,
// wave 4, 2026-10-07). Loaded by docs/pro/js/demo-mode.js, only under
// /pro/explore/.
//
// Out of scope in the sample account (plan: documentation/projects/
// PRO-DEMO-PHASE2-FULL-ACCOUNT-PLAN-2026-10-06.md): billing and checkout,
// team invites, sign-in methods (Google sign-in), Bots & API keys, the AI
// texting persona, push notifications and data import. Each one shows a card
// that says what it does in a real account. They are NEVER wired: a sealed
// panel's own controls are hidden (CSS, demo-mode.css), the push channel is
// switched off, and the import buttons open the card instead of the importer.
// Everything else in Settings works and saves in this browser only.
(function () {
  'use strict';
  if (typeof document === 'undefined' || !document.documentElement.classList.contains('nbd-demo')) return;

  var START = '/pro/register.html';
  // Whole Settings panels replaced by a card.
  var PANELS = {
    'stab-panel-billing': ['Plans, billing and card payments',
      'In your real account you pick a plan, manage your subscription here, and connect Stripe so homeowners can pay your invoices by card. The sample account has no billing: nothing here can charge you or anyone else. Its pay links are samples.'],
    'stab-panel-team': ['Your team',
      'In your real account you invite reps, managers and view-only users here, and each one signs in with their own login and sees what their role allows. The sample account has one sample owner and sends no invites.'],
    'stab-panel-access': ['Sign-in methods',
      'In your real account you choose how your team signs in: email and password, Google sign-in, or an email link. The sample account is already signed in as its sample owner, with no password and no Google account.'],
    'stab-panel-bots': ['Bots & API keys',
      'In your real account you connect your own AI assistant (Claude, ChatGPT, Grok or any app that speaks MCP) with a key made here. Bots file notes, reminders and drafts into your Agent inbox; they never contact a customer. The sample account makes no keys. Its Agent inbox shows what bots file.'],
    'stab-panel-ai-texting': ['AI texting persona',
      'In your real account you set how the AI texting assistant introduces itself and answers homeowners. AI runs on NBD Pro servers, so it is not in the sample account.']
  };
  // A card on top of a panel that otherwise still works (saved in this browser).
  var NOTES = {
    'stab-panel-notifications': ['Push notifications',
      'In your real account alerts can also come to your phone as push notifications. The sample account does not register this browser for push; the other choices here save in this browser only.']
  };
  var IMPORT = ['Import your customers',
    'In your real account you bring your leads and customers in from a spreadsheet (CSV) or another CRM in a few taps. The sample account already has its sample customers and imports nothing.'];

  function card(spec, small) {
    var box = document.createElement('div');
    box.className = 'nbd-demo-real-card' + (small ? ' is-note' : '');
    box.setAttribute('role', 'note');
    var k = document.createElement('div');
    k.className = 'nbd-demo-real-kicker';
    k.textContent = 'Available in your real account';
    var h = document.createElement('div');
    h.className = 'nbd-demo-real-title';
    h.textContent = spec[0];
    var p = document.createElement('p');
    p.className = 'nbd-demo-real-body';
    p.textContent = spec[1];
    box.appendChild(k); box.appendChild(h); box.appendChild(p);
    if (!small) {
      var a = document.createElement('a');
      a.className = 'nbd-demo-real-cta';
      a.href = START;
      a.textContent = 'Start free, no card';
      box.appendChild(a);
    }
    return box;
  }

  function apply() {
    Object.keys(PANELS).forEach(function (id) {
      var panel = document.getElementById(id);
      if (!panel) return;
      if (!panel.hasAttribute('data-nbd-demo-sealed')) panel.setAttribute('data-nbd-demo-sealed', '');
      if (!panel.querySelector(':scope > .nbd-demo-real-card')) panel.insertBefore(card(PANELS[id]), panel.firstChild);
    });
    Object.keys(NOTES).forEach(function (id) {
      var panel = document.getElementById(id);
      if (!panel || panel.querySelector(':scope > .nbd-demo-real-card')) return;
      panel.insertBefore(card(NOTES[id], true), panel.firstChild);
    });
    // Push stays off in the sample account.
    var push = document.getElementById('chPush');
    if (push && !push.disabled) { push.checked = false; push.disabled = true; push.setAttribute('data-nbd-demo-off', ''); }
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; try { apply(); } catch (_) { /* keep going */ } });
  }
  function start() {
    apply();
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (_) { setInterval(apply, 1000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // ── data import: the card, never the importer ──────────────────────────
  var SHEET_ID = 'nbd-demo-real-sheet';
  function closeSheet() { var s = document.getElementById(SHEET_ID); if (s) s.remove(); }
  function openSheet(spec) {
    closeSheet();
    var back = document.createElement('div');
    back.id = SHEET_ID;
    back.className = 'nbd-sp-back';
    var box = document.createElement('div');
    box.className = 'nbd-sp nbd-demo-real-sheet';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', spec[0]);
    box.appendChild(card(spec));
    var foot = document.createElement('div');
    foot.className = 'nbd-sp-foot';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'nbd-sp-btn';
    ok.textContent = 'Got it';
    ok.setAttribute('data-nbd-real', 'close');
    foot.appendChild(ok);
    box.appendChild(foot);
    back.appendChild(box);
    back.addEventListener('click', function (e) {
      if (e.target === back || (e.target.closest && e.target.closest('[data-nbd-real="close"]'))) closeSheet();
    });
    back.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    document.body.appendChild(back);
    try { ok.focus({ preventScroll: true }); } catch (_) { /* old browser */ }
    var st = window.__NBD_DEMO__;
    if (st) { st.realCards = st.realCards || []; st.realCards.push({ title: spec[0], at: Date.now() }); }
  }
  // Capture phase on the WINDOW, which runs before any listener on the
  // document or below it (the CRM's delegates): the importer never opens.
  var GATED = '[data-fn="openLeadImport"], [data-action="openLeadImport"], #crmEmptyImportBtn';
  window.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest(GATED) : null;
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openSheet(IMPORT);
  }, true);
  // A direct call (window.openLeadImport) opens the card too.
  try {
    Object.defineProperty(window, 'openLeadImport', {
      configurable: true,
      get: function () { return function () { openSheet(IMPORT); }; },
      set: function () { /* the real importer is not installed in the sample account */ }
    });
  } catch (_) { /* the click guard above still holds */ }

  window.NBD_DEMO_REAL_ACCOUNT = { panels: Object.keys(PANELS), notes: Object.keys(NOTES), apply: apply, openImport: function () { openSheet(IMPORT); } };
})();
