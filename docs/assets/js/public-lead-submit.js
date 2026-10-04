/**
 * public-lead-submit.js — tiny client for the submitPublicLead gateway.
 *
 * The four public-facing lead forms (free guide, contact homepage,
 * storm alert subscribe, estimate request) used to write directly to
 * Firestore. Post-C-3 those collections deny client writes — every
 * submission must go through the rate-limited, App-Checked,
 * Turnstile-verified Cloud Function.
 *
 * Usage (drop in a <script> tag on each page):
 *   <script src="/assets/js/public-lead-submit.js"></script>
 *   ...
 *   const out = await window.submitPublicLead('guide', {
 *     name, email, source: 'free-guide',
 *     turnstileToken  // optional if Turnstile widget wired on the page
 *   });
 *   if (out.ok) { ...thank-you path... }
 *
 * Return shape:
 *   { ok: true, id: 'firestore-doc-id' }
 *   { ok: false, reason: '...', status: <http status> }
 *
 * The function URL comes from window.__NBD_FUNCTIONS_BASE so each
 * host page can override for staging/prod without touching this file.
 */

(function () {
  'use strict';

  if (typeof window.submitPublicLead === 'function') return;

  const DEFAULT_BASE = 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
  function baseUrl() {
    return (window.__NBD_FUNCTIONS_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  }

  // ─── Turnstile auto-wiring ─────────────────────────────
  // Every page that loads this client is keyed by DEFAULT_TURNSTILE_SITEKEY.
  // A page can still set window.__NBD_TURNSTILE_SITEKEY before this script
  // runs to override it (an explicit '' opts the page out), or place a
  // <div class="cf-turnstile" data-sitekey="..."></div> element. We:
  //   1. Lazy-load https://challenges.cloudflare.com/turnstile/v0/api.js
  //      once, the first time submitPublicLead() is called.
  //   2. Expose nbdTurnstileExecute() → Promise<token>: render one widget on
  //      the first submit, then reset() + execute() it on every later submit,
  //      because tokens are single-use.
  // If no site key and no widget, we resolve '' and the server decides
  // whether to allow (unconfigured server = pass; configured = 403).
  //
  // Why a default (2026-09-13): the key used to reach only the four pages that
  // load docs/assets/js/inline/7cd8e505ab.js, while 181 pages can reach this
  // client — including 170 /areas + /services quick forms that inject it — so
  // setting TURNSTILE_SECRET would have 403'd 177 of them. The site key is
  // public by design. That stub stays the human-facing source of truth;
  // tests/turnstile-contract.test.js fails if this copy drifts from it.
  const DEFAULT_TURNSTILE_SITEKEY = '0x4AAAAAAEqcVVOXW3xyusXQ';

  // The longest a submit waits for a token (script load + challenge) before it
  // POSTs without one. Cut from 8s to 6s on 2026-09-13: on a network that stalls
  // challenges.cloudflare.com, this is exactly how long the visitor watches
  // "Sending…". Not 4s: that cut off 1 of 10 always-pass test-key first submits
  // on a fast connection. Once TURNSTILE_SECRET is set, a submit that hits this
  // is rejected, so re-measure before changing it
  // (documentation/runbooks/TURNSTILE-SETUP.md).
  const TURNSTILE_TIMEOUT_MS = 6000;

  function turnstileSiteKey() {
    return window.__NBD_TURNSTILE_SITEKEY === undefined
      ? DEFAULT_TURNSTILE_SITEKEY
      : String(window.__NBD_TURNSTILE_SITEKEY).trim();
  }

  let _turnstileLoadingPromise = null;
  function ensureTurnstileLoaded() {
    if (typeof window.turnstile === 'object' && window.turnstile) return Promise.resolve(true);
    if (_turnstileLoadingPromise) return _turnstileLoadingPromise;
    _turnstileLoadingPromise = new Promise((resolve) => {
      // Skip load if no site key + no widget element.
      const hasKey    = !!turnstileSiteKey();
      const hasWidget = !!document.querySelector('.cf-turnstile, .cf-turnstile-auto');
      if (!hasKey && !hasWidget) return resolve(false);
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return _turnstileLoadingPromise;
  }

  // One widget per page. Its callbacks are bound once, at render(), so they
  // must settle whichever submit is waiting NOW — closing over the first
  // submit's promise left every later submit to the safety timeout (or to
  // execute() handing back the already-spent token).
  let _widgetId = null;
  let _pending = null;
  function settlePending(token) {
    if (_pending) _pending(token || '');
  }

  // Returns a Promise<string> — empty string means "no token was
  // obtained" which is safe when the server isn't enforcing.
  function nbdTurnstileExecute() {
    const siteKey = turnstileSiteKey();
    return new Promise((done) => {
      let timer = null;
      const finish = (token) => {
        clearTimeout(timer);
        if (_pending === finish) _pending = null;
        done(token);
      };
      // A submit still waiting (double-click) gives up rather than hang.
      settlePending('');
      _pending = finish;
      // Safety timeout over the script load AND the challenge, cleared as soon
      // as a callback settles this submit. Armed before the load on purpose: a
      // network that drops challenges.cloudflare.com (rather than refusing it)
      // stalls the load, and the lead was never POSTed at all.
      timer = setTimeout(() => finish(''), TURNSTILE_TIMEOUT_MS);
      ensureTurnstileLoaded().then((loaded) => {
        if (_pending !== finish) return;  // timed out, or a newer submit took over
        if (!loaded || !window.turnstile) return finish('');
        // Find (or create) the container.
        let box = document.querySelector('.cf-turnstile-auto');
        if (!box && siteKey) {
          box = document.createElement('div');
          box.className = 'cf-turnstile-auto';
          box.style.cssText = 'display:flex;justify-content:center;margin:12px 0;';
          document.body.appendChild(box);
        }
        if (!box) return finish('');
        try {
          if (_widgetId == null) {
            // These callbacks outlive this submit, so they go through
            // settlePending rather than this promise's own resolver.
            const resolve = settlePending;
            _widgetId = window.turnstile.render(box, {
              sitekey: siteKey || box.dataset.sitekey || '',
              size: 'invisible',
              // Wait for execute() below; the default ('render') starts the
              // challenge immediately and execute() then warns it is running.
              execution: 'execute',
              callback: (token) => resolve(token || ''),
              'error-callback': () => resolve(''),
              'timeout-callback': () => resolve('')
            });
          } else {
            // Rendering into the same container again is rejected, and execute()
            // on a finished widget returns the previous, already-spent token.
            window.turnstile.reset(_widgetId);
          }
          try { window.turnstile.execute(_widgetId); } catch (e) {}
        } catch (e) { finish(''); }
      });
    });
  }
  window.nbdTurnstileExecute = nbdTurnstileExecute;

  // ─── Preload on first field focus (2026-10-03) ─────────
  // The script used to be fetched only when Submit was pressed, so the visitor
  // watched "Sending…" for the script download PLUS the challenge, inside the
  // 6s budget above — on a slow phone that budget ran out and the lead POSTed
  // tokenless. The first focus of ANY form field on a page that loads this
  // client now starts the download, so the token is usually ready by Submit.
  // Load only (no render, no execute — the widget still runs at submit).
  let _preloaded = false;
  function isField(el) {
    return !!(el && el.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) &&
      !/^(hidden|submit|button|reset|image)$/i.test(el.type || ''));
  }
  function preloadTurnstile() {
    if (_preloaded) return;
    _preloaded = true;
    try { ensureTurnstileLoaded(); } catch (e) { /* submit still loads it */ }
  }
  window.nbdTurnstilePreload = preloadTurnstile;

  // The form the visitor was last typing in — where a failed submit's
  // call/text fallback is shown.
  let _lastField = null;
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('focusin', function (e) {
      if (!isField(e.target)) return;
      _lastField = e.target;
      preloadTurnstile();
    }, true);
  }
  // This client is lazy-loaded on some pages (quick-lead-form.js injects it on
  // the first focus): the focus that triggered the load happened before this
  // listener existed, so honour it now.
  if (isField(document.activeElement)) { _lastField = document.activeElement; preloadTurnstile(); }

  // ─── Call / text fallback when a submit fails (2026-10-03) ─────────
  // Forms each had their own failure text (some named the number, some did
  // not, none offered a text link). Every failed submitPublicLead now also
  // puts one clear way through under the form the visitor was using:
  // "Call or text Joe — (859) 420-7382" with tel: and sms: links.
  // Not on tenant microsites (/sites/t/): those forms are a contractor's own
  // and must never show NBD's number. A page can opt out with
  // window.__NBD_LEAD_FALLBACK = false.
  const JOE_TEL = '+18594207382';
  const JOE_DISPLAY = '(859) 420-7382';
  function fallbackAllowed() {
    if (window.__NBD_LEAD_FALLBACK === false) return false;
    return !/^\/sites\/t(\/|$)/.test((window.location && window.location.pathname) || '');
  }
  function visible(el) {
    return !!(el && el.isConnected !== false && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length)));
  }
  function showLeadFallback(anchor) {
    if (!fallbackAllowed()) return null;
    let host = anchor || null;
    if (!host && _lastField) {
      host = (_lastField.closest && (_lastField.closest('form') || _lastField.closest('[data-nbd-lead-form]') || _lastField.closest('.funnel-card'))) || _lastField.parentNode;
    }
    if (!host || !visible(host)) return null;
    let box = host.querySelector && host.querySelector('.nbd-lead-fallback');
    if (!box) {
      box = document.createElement('p');
      box.className = 'nbd-lead-fallback';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'margin:12px 0 0;font-weight:700;font-size:.95rem;line-height:1.5;';
      const call = document.createElement('a');
      call.href = 'tel:' + JOE_TEL;
      call.textContent = JOE_DISPLAY;
      call.style.cssText = 'color:inherit;white-space:nowrap;text-decoration:underline;';
      const sms = document.createElement('a');
      sms.href = 'sms:' + JOE_TEL;
      sms.textContent = 'send a text';
      sms.style.cssText = 'color:inherit;white-space:nowrap;text-decoration:underline;';
      box.appendChild(document.createTextNode('Call or text Joe \u2014 '));
      box.appendChild(call);
      box.appendChild(document.createTextNode(' \u00b7 '));
      box.appendChild(sms);
      host.appendChild(box);
    }
    return box;
  }
  window.nbdLeadFailFallback = showLeadFallback;

  async function submitPublicLead(kind, fields) {
    if (!kind || typeof kind !== 'string') {
      return { ok: false, reason: 'Missing kind' };
    }
    // Pull a Turnstile token if we can. Pages that don't wire it
    // get an empty string — the server falls through to App Check
    // + rate limit + honeypot. Only attach the field when we actually
    // obtained a token: a blank turnstileToken can never satisfy a
    // configured server (min length 10), so sending it is pure noise.
    let turnstileToken = '';
    try { turnstileToken = await nbdTurnstileExecute(); } catch (e) {}

    const payload = Object.assign({ kind }, fields || {});
    if (turnstileToken) payload.turnstileToken = turnstileToken;
    try {
      const res = await fetch(baseUrl() + '/submitPublicLead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // We don't ship credentials — the endpoint is unauth'd and
        // gated by App Check + Turnstile + per-IP rate limit.
        credentials: 'omit',
        mode: 'cors'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showLeadFallback();
        return { ok: false, reason: data.error || 'Submission failed', status: res.status };
      }
      // Central conversion event: every public lead form routes through
      // here (guide/contact/inspect/estimate/storm/free_roof), so this is
      // the one place GA4 sees all of them. No PII in params.
      try {
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'generate_lead', {
            lead_kind: kind,
            lead_source: (fields && fields.source) || ''
          });
        }
      } catch (e) {}
      // photoToken (2026-09-30): a one-time grant to attach photos to this
      // submission (intake-extras.js uploads them). Only present when asked.
      return { ok: true, id: data.id || null, photoToken: data.photoToken || null };
    } catch (e) {
      showLeadFallback();
      return { ok: false, reason: 'Network error: ' + (e.message || 'unknown') };
    }
  }

  window.submitPublicLead = submitPublicLead;
  // Same functions origin, for the photo upload endpoint (intake-extras.js).
  window.nbdPublicFunctionsBase = baseUrl;
})();
