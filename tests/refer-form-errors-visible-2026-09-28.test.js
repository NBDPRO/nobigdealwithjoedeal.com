/**
 * tests/refer-form-errors-visible-2026-09-28.test.js
 *
 * THE BUG: docs/pro/js/refer.js (the public "a neighbor sent us your way"
 * referral form) clears its status line at the top of every submit with
 * hide() — an INLINE display:none — and setStatus(msg) then only set the text
 * and class. Inline style beats the stylesheet's .status.error{display:block},
 * so EVERY error was invisible: missing name, short phone, bad email, the
 * server's "daily limit" / "invalid link", and a network failure. The friend
 * just saw the button come back. Found on the emulator 2026-09-28.
 *
 * THE FIX: setStatus(msg) calls show(statusEl).
 *
 * This runs the REAL refer.js in a vm sandbox against a minimal fake DOM and
 * drives the submit handler — asserting on the element's resulting inline
 * display, not on source text. Break-test: remove the show() and the
 * visibility assertions go red.
 *
 * Zero deps. Run: node tests/refer-form-errors-visible-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'refer.js'), 'utf8');

function makePage(values, fetchImpl) {
  const els = {};
  function el(id, extra) {
    els[id] = Object.assign({ id, style: {}, className: id === 'status' ? 'status' : '', textContent: '', value: '', disabled: false, _listeners: {} }, extra || {});
    els[id].addEventListener = (t, fn) => { els[id]._listeners[t] = fn; };
    return els[id];
  }
  ['referForm', 'emptyState', 'doneState', 'status', 'submitBtn'].forEach((id) => el(id));
  els.submitBtn.textContent = 'Send my info';
  ['firstName', 'lastName', 'phone', 'email', 'address', 'notes'].forEach((id) => el(id, { value: (values && values[id]) || '' }));
  const document = {
    title: '',
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
  };
  const sandbox = {
    document,
    location: { hostname: 'nobigdealwithjoedeal.com', search: '?ref=DRC-0001-9GV0' },
    URLSearchParams,
    fetch: fetchImpl || (async () => { throw new Error('offline'); }),
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  async function submit() {
    await els.referForm._listeners.submit({ preventDefault() {} });
  }
  return { els, submit };
}

const visible = (e) => e.style.display !== 'none';

(async () => {
  console.log('REFERRAL FORM — errors are visible to the friend');

  {
    const p = makePage({ firstName: '', phone: '5135550142' });
    await p.submit();
    ok('missing first name: message set', /First name is required/.test(p.els.status.textContent));
    ok('missing first name: message VISIBLE (not inline display:none)', visible(p.els.status), 'display=' + p.els.status.style.display);
  }
  {
    const p = makePage({ firstName: 'Zed', phone: '555-01' });
    await p.submit();
    ok('short phone: "needs at least 10 digits" shown', /at least 10 digits/.test(p.els.status.textContent) && visible(p.els.status));
    ok('…with the error style', /\berror\b/.test(p.els.status.className));
  }
  {
    const p = makePage({ firstName: 'Zed', phone: '5135550142' }, async () => ({ ok: false, json: async () => ({ error: 'This referrer has reached the daily limit. Try again tomorrow.' }) }));
    await p.submit();
    ok('server refusal (daily limit) shown to the friend', /daily limit/.test(p.els.status.textContent) && visible(p.els.status));
    ok('…and the button is re-enabled', p.els.submitBtn.disabled === false);
  }
  {
    const p = makePage({ firstName: 'Zed', phone: '5135550142' });
    await p.submit();
    ok('network failure: "Network error" shown', /Network error/.test(p.els.status.textContent) && visible(p.els.status));
  }
  {
    // Second attempt after a first error: the clear at the top of submit must
    // not leave the next message hidden.
    const p = makePage({ firstName: '', phone: '5135550142' });
    await p.submit();
    p.els.firstName.value = 'Zed'; p.els.phone.value = '555';
    await p.submit();
    ok('second error after a first one is still visible', /at least 10 digits/.test(p.els.status.textContent) && visible(p.els.status));
  }
  {
    const p = makePage({ firstName: 'Zed', phone: '5135550142' }, async () => ({ ok: true, json: async () => ({ ok: true, leadId: 'x' }) }));
    await p.submit();
    ok('success: form hidden, thank-you shown', p.els.referForm.style.display === 'none' && p.els.doneState.style.display === 'block');
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
