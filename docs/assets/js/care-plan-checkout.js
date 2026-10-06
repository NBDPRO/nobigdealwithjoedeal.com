/**
 * care-plan-checkout.js — online signup for the Roof Care Plan on
 * /services/roof-care-plan (2026-10-05, Jo approved). PR 3 of 3; the server
 * side is functions/care-plan.js (carePlanPublic). Design note:
 * documentation/projects/ROOF-CARE-PLAN-2026-10-05.md
 *
 * SHIPS DARK. The page's "Get My Care Plan" buttons keep going to the
 * contact form, and the #careplan-join section stays hidden, unless the
 * server says the plan is on (GET carePlanPublic → mode):
 *   live → everyone gets the checkout
 *   test → only ?preview=careplan (Jo's own test) or a CRM invite link
 *   off  → nothing changes (an invite link says "call Joe")
 * Any error reaching the server = off. Cancelling ("Manage or cancel" on
 * the thank-you screen, Stripe Customer Portal) works in every mode.
 *
 * Payment happens on Stripe's own Checkout page; nothing card-shaped is ever
 * typed here. The renewal terms are shown, and must be ticked, before the
 * button works; the server refuses a request without that consent and
 * records which wording was shown.
 */
(function () {
  'use strict';

  var BASE = (window.__NBD_FUNCTIONS_BASE || 'https://us-central1-nobigdeal-pro.cloudfunctions.net').replace(/\/+$/, '');
  var ENDPOINT = BASE + '/carePlanPublic';
  var JOE = '(859) 420-7382';

  // Same wording as functions/care-plan-logic.js disclosureText() — pinned by
  // tests/care-plan-page-2026-10-05.test.js so the page and the server agree.
  function disclosureText(interval) {
    var yearly = interval === 'year';
    var price = yearly ? '$199' : '$19';
    var every = yearly ? 'every year' : 'every month';
    return price + ' today, then ' + price + ' ' + every + ' until you cancel — the plan renews automatically. ' +
      'No lock-in: cancel anytime from your billing link or by calling or texting Joe, and you will not be charged again. ' +
      'Your plan stays active through the time you have already paid for.';
  }

  /** Is checkout open for this visitor? Pure (tested). */
  function enabledFor(mode, params) {
    if (mode === 'live') return true;
    if (mode === 'test') return !!(params.preview || params.invite);
    return false;
  }
  /** Only ever send the browser to Stripe's own pages. Pure (tested). */
  function safeStripeUrl(url, kind) {
    var host = kind === 'portal' ? 'https://billing.stripe.com/' : 'https://checkout.stripe.com/';
    return typeof url === 'string' && url.indexOf(host) === 0 ? url : null;
  }

  function readParams() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (_) { q = { get: function () { return null; } }; }
    var invite = q.get('invite');
    return {
      invite: invite && /^[A-Za-z0-9_-]{20,128}$/.test(invite) ? invite : null,
      preview: q.get('preview') === 'careplan',
      state: q.get('careplan'),
      sessionId: (q.get('session_id') || '').match(/^cs_(test|live)_[A-Za-z0-9]{10,200}$/) ? q.get('session_id') : null,
    };
  }

  function post(body) {
    return fetch(ENDPOINT, {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }
  function getMode() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 5000);
    return fetch(ENDPOINT, { method: 'GET', mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { clearTimeout(timer); return d && (d.mode === 'live' || d.mode === 'test') ? d.mode : 'off'; })
      .catch(function () { clearTimeout(timer); return 'off'; });
  }
  function ensureTurnstile() {
    if (typeof window.nbdTurnstileExecute === 'function') return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/assets/js/public-lead-submit.js';
      s.onload = resolve;
      s.onerror = function () { resolve(); };   // the server decides without a token
      document.head.appendChild(s);
    });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function show(el, on) { if (el) el.hidden = !on; }
  function say(sec, msg, isError) {
    var box = $('[data-cp-msg]', sec);
    if (!box) return;
    box.textContent = msg || '';
    box.classList.toggle('is-error', !!isError);
    box.hidden = !msg;
  }

  function wireForm(sec, params) {
    var form = $('form[data-cp-form]', sec);
    if (!form || form._cpWired) return;
    form._cpWired = true;
    var terms = $('[data-cp-terms-text]', sec);
    function interval() { var r = $('input[name="cp_interval"]:checked', form); return r ? r.value : 'year'; }
    function paintTerms() { if (terms) terms.textContent = disclosureText(interval()); }
    form.addEventListener('change', function (e) { if (e.target && e.target.name === 'cp_interval') paintTerms(); });
    paintTerms();
    // Start the Turnstile download on the first touch, like the lead forms.
    form.addEventListener('focusin', function once() { form.removeEventListener('focusin', once); ensureTurnstile(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type="submit"]', form);
      var agree = $('input[name="cp_terms"]', form);
      if (!agree || !agree.checked) { say(sec, 'Please tick the box to confirm the renewal terms.', true); return; }
      var body = { action: 'checkout', interval: interval(), termsAccepted: true, nbd_hp: (form.elements.nbd_hp && form.elements.nbd_hp.value) || '' };
      if (params.invite) body.invite = params.invite;
      else {
        ['firstName', 'lastName', 'email', 'phone', 'address', 'zip'].forEach(function (k) {
          var el = form.elements['cp_' + k];
          body[k] = el ? String(el.value || '').trim() : '';
        });
        if (params.preview) body.preview = true;
        if (!body.firstName || !body.email || !body.phone || !body.address) { say(sec, 'Please fill in your name, email, phone and the home address.', true); return; }
      }
      if (btn) { btn.disabled = true; btn.textContent = 'Opening secure checkout…'; }
      say(sec, '');
      ensureTurnstile()
        .then(function () { return typeof window.nbdTurnstileExecute === 'function' ? window.nbdTurnstileExecute().catch(function () { return ''; }) : ''; })
        .then(function (token) { if (token) body.turnstileToken = token; return post(body); })
        .then(function (r) {
          var url = r.ok ? safeStripeUrl(r.data && r.data.url, 'checkout') : null;
          if (url) { window.location.href = url; return; }
          if (r.status === 409) say(sec, 'You are already a Roof Care Plan member. Questions? Call or text Joe at ' + JOE + '.', true);
          else say(sec, ((r.data && r.data.error && r.data.error !== 'not_available') ? r.data.error + ' ' : '') + 'If it keeps failing, call or text Joe at ' + JOE + '.', true);
          if (btn) { btn.disabled = false; btn.textContent = 'Continue to secure checkout'; }
        })
        .catch(function () {
          say(sec, 'Could not reach checkout. Call or text Joe at ' + JOE + '.', true);
          if (btn) { btn.disabled = false; btn.textContent = 'Continue to secure checkout'; }
        });
    });
  }

  function openCheckout(sec, params) {
    show(sec, true);
    show($('[data-cp-join]', sec), true);
    // The page's "Get My Care Plan" buttons now open this form instead of the
    // contact form.
    document.querySelectorAll('a[data-careplan-cta]').forEach(function (a) { a.setAttribute('href', '#careplan-join'); });
    if (params.invite) {
      show($('[data-cp-person]', sec), false);
      var h = $('[data-cp-title]', sec);
      if (h) h.textContent = 'Finish joining the Roof Care Plan';
    }
    if (params.state === 'cancelled') say(sec, 'Checkout was cancelled — nothing was charged.', false);
    wireForm(sec, params);
    if (params.invite || params.preview || params.state === 'cancelled') {
      try { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { sec.scrollIntoView(); }
    }
  }

  function showJoined(sec, params) {
    show(sec, true);
    show($('[data-cp-join]', sec), false);
    show($('[data-cp-joined]', sec), true);
    var btn = $('[data-cp-manage]', sec);
    if (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        post({ action: 'portal', sessionId: params.sessionId }).then(function (r) {
          var url = r.ok ? safeStripeUrl(r.data && r.data.url, 'portal') : null;
          if (url) { window.location.href = url; return; }
          btn.disabled = false;
          say(sec, 'Could not open your billing page. Call or text Joe at ' + JOE + ' and he will take care of it.', true);
        }).catch(function () {
          btn.disabled = false;
          say(sec, 'Could not open your billing page. Call or text Joe at ' + JOE + '.', true);
        });
      });
    }
    try { sec.scrollIntoView({ block: 'start' }); } catch (_) { /* ignore */ }
  }

  function init() {
    var sec = document.getElementById('careplan-join');
    if (!sec) return;
    var params = readParams();
    // The thank-you screen (and its cancel button) never goes dark.
    if (params.state === 'joined' && params.sessionId) { showJoined(sec, params); return; }
    getMode().then(function (mode) {
      if (enabledFor(mode, params)) { openCheckout(sec, params); return; }
      if (params.invite) {
        show(sec, true);
        show($('[data-cp-join]', sec), false);
        say(sec, 'Online signup is not open right now. Call or text Joe at ' + JOE + ' and he will set up your plan.', false);
      }
    });
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  window.NBDCarePlanCheckout = { _test: { disclosureText: disclosureText, enabledFor: enabledFor, safeStripeUrl: safeStripeUrl, readParams: readParams } };
})();
