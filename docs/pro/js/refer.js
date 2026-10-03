(function () {
  'use strict';
  // Emulator switch (same Audit #3 rule as nbd-comms.js / esign-sign.js /
  // portal.js / sign-page.js) — this is a public, unauthenticated page, so
  // it's the same untestable-from-localhost pattern as the other token pages.
  const FUNCTIONS_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
    (typeof location !== 'undefined' && location.hostname) || ''
  )
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';

  function getRef() {
    try {
      const p = new URLSearchParams(location.search);
      return (p.get('ref') || '').trim().toUpperCase();
    } catch (e) { return ''; }
  }

  function show(el) { el.style.display = 'block'; }
  function hide(el) { el.style.display = 'none'; }

  const ref = getRef();
  // The referrer's personal code (review-engine.js puts it on the link the
  // review ask carries, 2026-10-03). Passed through as-is; the server only
  // honours it when it is THIS referrer's own code.
  const code = (function () {
    try { return (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24); }
    catch (e) { return ''; }
  })();
  // White-label (2026-07-19): portal.js appends &co=<tenant name> for non-NBD
  // tenants so this landing page brands itself. textContent only (never HTML),
  // length-capped; absent param -> NBD literals untouched.
  try {
    let _co = new URLSearchParams(location.search).get('co');
    if (_co) {
      _co = String(_co).slice(0, 80);
      document.title = 'Send a referral · ' + _co;
      const _heroP = document.querySelector('.hero p');
      if (_heroP) _heroP.textContent = 'Quick form below — ' + _co + ' will be in touch about your roof. No pressure, no spam.';
    }
  } catch (e) { /* branding is best-effort */ }
  const form = document.getElementById('referForm');
  const empty = document.getElementById('emptyState');
  const done = document.getElementById('doneState');
  const statusEl = document.getElementById('status');
  const btn = document.getElementById('submitBtn');

  if (!ref) {
    show(empty);
    return;
  }
  show(form);

  // show() on every message: the clear at the top of each submit sets an INLINE
  // display:none, which beats the .status.error { display:block } class — so
  // until 2026-09-28 every error on this page (missing name, bad phone, daily
  // limit, invalid link, network failure) was invisible and the friend just
  // saw the button come back.
  function setStatus(msg, kind) {
    if (!msg) { hide(statusEl); statusEl.className = 'status'; return; }
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (kind || '');
    show(statusEl);
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setStatus('');
    const firstName = document.getElementById('firstName').value.trim();
    const lastName  = document.getElementById('lastName').value.trim();
    const phone     = document.getElementById('phone').value.trim();
    const email     = document.getElementById('email').value.trim();
    const address   = document.getElementById('address').value.trim();
    const notes     = document.getElementById('notes').value.trim();

    if (!firstName) { setStatus('First name is required.', 'error'); return; }
    const digits = phone.replace(/\D/g, '');
    if (!digits && !email) { setStatus('Phone or email is required.', 'error'); return; }
    if (digits && digits.length < 10) { setStatus('Phone needs at least 10 digits.', 'error'); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus('Email looks invalid.', 'error'); return;
    }

    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = 'Sending…';

    try {
      const res = await fetch(FUNCTIONS_BASE + '/submitReferral', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ ref, firstName, lastName, phone, email, address, notes }, code ? { code } : {})),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(json.error || 'Could not send your info. Try again.', 'error');
        btn.disabled = false;
        btn.textContent = origLabel;
        return;
      }
      hide(form);
      show(done);
    } catch (err) {
      setStatus('Network error — please try again.', 'error');
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  });
})();
