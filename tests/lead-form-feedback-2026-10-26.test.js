/**
 * tests/lead-form-feedback-2026-10-26.test.js — the public lead forms tell the
 * visitor what happened (overnight pass, 2026-10-26).
 *
 *   funnel-1    quick lead form (185 service/area pages): its status slots are
 *               the FIRST children of an ~890px form while Send is the last, so
 *               on a phone an empty submit looked like a dead button and the
 *               "Got it" message sat off-screen. Invalid submits now mark the
 *               bad inputs (aria-invalid) and focus the first; every message is
 *               scrolled into view and focused.
 *   marketing-7 the three dropdowns in that form were 15.2px, so iPhone Safari
 *               zoomed the page when one was tapped (16px is the floor).
 *   marketing-9 / funnel-6
 *               the gateway client showed the browser's or server's raw string
 *               ("Network error: Failed to fetch", "Rate limit exceeded",
 *               "Verification failed", "Submission failed"); it now returns a
 *               plain-language reason with the call/text number, and the raw
 *               text goes to the console only.
 *   funnel-4    /storm-alerts and /inspect: the confirmation took focus nowhere
 *               and (storm-alerts) was above the viewport on a phone.
 *
 * Every script is EXECUTED (vm + a small fake DOM), not grepped.
 * Zero deps. Run: node tests/lead-form-feedback-2026-10-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

const JOE = '(859) 420-7382';

// ── The gateway client, executed with a scripted fetch ───────────────────────
function loadClient({ pathname = '/estimate', fetchImpl } = {}) {
  const warns = [];
  const document = {
    head: { appendChild() {} }, body: { appendChild() {} }, activeElement: null,
    addEventListener() {},
    createElement() { return { style: {}, dataset: {}, setAttribute() {}, appendChild() {} }; },
    createTextNode() { return {}; },
    querySelector() { return null; },
  };
  const window = {
    document, location: { pathname, hostname: 'nobigdealwithjoedeal.com' },
    AbortController, setTimeout, clearTimeout,
    fetch: fetchImpl,
    console: { warn: (...a) => warns.push(a.map(String).join(' ')), log() {}, error() {} },
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(read('docs/assets/js/public-lead-submit.js'), window, { filename: 'public-lead-submit.js' });
  window.__NBD_TURNSTILE_SITEKEY = '';   // no token step on this fake page
  return { window, warns };
}
const answers = (status, body) => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const RAW = /Failed to fetch|Load failed|Network error|Rate limit exceeded|Verification failed|Submission failed/i;

// ── quick-lead-form.js, executed against a fake DOM built from its own markup ─
function loadQuickForm({ submitPublicLead, intake, values = {} } = {}) {
  const els = {}; let html = '';
  const focusLog = [], warns = [];
  const mk = (id) => ({
    id, value: values[id.replace(/^qlf-\d+-/, '')] || '', attrs: {}, textContent: '', calls: [], listeners: {}, disabled: false, checked: false, parentNode: null,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    focus(o) { this.calls.push(['focus', o]); focusLog.push(this.id); },
    scrollIntoView(o) { this.calls.push(['scrollIntoView', o]); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    classList: { add() {}, remove() {} },
  });
  const form = mk('form');
  form.reset = function () { this.calls.push(['reset']); };
  form.insertBefore = function (n) { this.calls.push(['insertBefore', n]); n.parentNode = this; };
  const document = {
    readyState: 'complete',
    getElementById(id) { if (!html.includes('id="' + id + '"')) return null; return els[id] || (els[id] = (() => { const e = mk(id); e.parentNode = form; return e; })()); },
    querySelector() { return null; },
    querySelectorAll(sel) { return sel === '[data-nbd-quick-form]' ? [host] : []; },
    createElement() { return mk('created'); },
    head: { appendChild() {} },
    addEventListener() {},
  };
  const host = {
    offsetTop: 0,
    getAttribute: (k) => ({ 'data-service': 'Roof Repair', 'data-city': 'Mason' }[k] || null),
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: (sel) => (sel === 'form' ? form : null),
  };
  const window = { document, location: { pathname: '/services/roof-repair-mason-oh' }, submitPublicLead, NBDIntake: intake, console: { warn: (...a) => warns.push(a.map(String).join(' ')), log() {}, error() {} } };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(read('docs/assets/js/quick-lead-form.js'), window, { filename: 'quick-lead-form.js' });
  const uid = (html.match(/id="(qlf-\d+)-h"/) || [])[1];
  const el = (suffix) => document.getElementById(uid + '-' + suffix);
  return { window, form, html, uid, el, focusLog, warns, submit: async () => { form.listeners.submit[0]({ preventDefault() {} }); await settle(); } };
}
const GOOD = { fn: 'Pat', ph: '(859) 555-0100', ad: '12 Elm St, Mason OH', hp: '' };
const centered = (e) => e.calls.some((c) => c[0] === 'scrollIntoView' && c[1] && c[1].block === 'center');

// ── a tiny harness for the page scripts that hide a form and show a card ──────
function fakeEls(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      id, value: '', style: {}, attrs: {}, textContent: '', calls: [], checked: false, disabled: false, hidden: false, className: '', childElementCount: 0,
      classList: { add: (c) => { els[id].className += ' ' + c; }, remove() {}, contains: () => false },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      focus(o) { this.calls.push(['focus', o]); }, scrollIntoView(o) { this.calls.push(['scrollIntoView', o]); },
      addEventListener() {}, remove() {}, appendChild() {}, querySelector: () => null,
    };
  }
  return els;
}

(async () => {
  // ═══ marketing-9 / funnel-6 — plain-language failures from the gateway client ═══
  console.log('\nmarketing-9 / funnel-6 — submitPublicLead never hands the visitor a raw string');
  {
    const cases = [
      ['offline (fetch throws TypeError)', { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) }, /couldn.t reach our server/i, 'Failed to fetch', undefined],
      ['Safari wording ("Load failed")', { fetchImpl: () => Promise.reject(new TypeError('Load failed')) }, /couldn.t reach our server/i, 'Load failed', undefined],
      ['429 rate limit', { fetchImpl: answers(429, { error: 'Rate limit exceeded' }) }, /wait a minute/i, 'Rate limit exceeded', 429],
      ['403 verification', { fetchImpl: answers(403, { error: 'Verification failed', reason: 'x' }) }, /couldn.t verify/i, 'Verification failed', 403],
      ['500 server error', { fetchImpl: answers(500, { error: 'Submission failed' }) }, /went wrong on our end/i, 'Submission failed', 500],
    ];
    for (const [label, opts, wording, rawText, status] of cases) {
      const { window, warns } = loadClient(opts);
      const r = await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100' });
      ok(`${label}: not ok, and the status is kept`, r.ok === false && r.status === status, r);
      ok(`${label}: plain-language reason`, wording.test(r.reason), r.reason);
      ok(`${label}: no raw browser/server string in the reason`, !RAW.test(r.reason), r.reason);
      ok(`${label}: names the call/text number`, r.reason.includes(JOE), r.reason);
      ok(`${label}: marked friendly, so a form can show it as is`, r.friendly === true, r);
      ok(`${label}: the raw text is kept in console.warn only`, warns.some((w) => w.includes(rawText)), warns);
    }
    // The server's own words stay for the cases where they ARE the instruction.
    const phone = await loadClient({ fetchImpl: answers(400, { error: 'Please enter a valid 10-digit US phone number.', field: 'phone' }) }).window.submitPublicLead('contact', {});
    ok('a field-specific 400 keeps the server text (the phone message)', phone.reason === 'Please enter a valid 10-digit US phone number.' && phone.friendly !== true, phone);
    const opaque = await loadClient({ fetchImpl: answers(400, { error: 'Invalid submission' }) }).window.submitPublicLead('contact', {});
    ok('the opaque 400 stays "Invalid submission" (inspect-form translates it)', opaque.reason === 'Invalid submission' && opaque.status === 400 && opaque.friendly !== true, opaque);
    // Timeout path already had friendly copy: it gains the number, keeps its flag.
    const stall = loadClient({ fetchImpl: (u, init) => new Promise((res, rej) => init.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; rej(e); })) });
    const realSet = stall.window.setTimeout;
    stall.window.setTimeout = (fn, ms) => realSet(fn, ms >= 15000 ? 5 : ms);   // fire the 20 s abort now
    const t = await stall.window.submitPublicLead('inspect', { name: 'Pat' });
    ok('a timeout is still timedOut with "taking too long", and now names the number', t.timedOut === true && /taking too long/i.test(t.reason) && t.reason.includes(JOE) && !/abort/i.test(t.reason), t);
    // A contractor microsite must never show NBD's number.
    for (const [label, opts] of [['offline', { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) }], ['429', { fetchImpl: answers(429, {}) }], ['500', { fetchImpl: answers(500, {}) }]]) {
      const r = await loadClient(Object.assign({ pathname: '/sites/t/acme-roofing' }, opts)).window.submitPublicLead('contact', {});
      ok(`tenant microsite (${label}): the plain reason has no NBD number and no "Joe"`, r.ok === false && r.friendly === true && !/859|420-7382|Joe/.test(r.reason) && r.reason.length > 20, r.reason);
    }
  }

  // ═══ funnel-1 — quick lead form ═══
  console.log('\nfunnel-1 — quick lead form: an empty submit marks the fields and lands on the message');
  {
    let sent = 0;
    const q = loadQuickForm({ submitPublicLead: async () => { sent++; return { ok: true }; } });
    ok('the form rendered (control)', !!q.uid && !!q.el('err') && !!q.el('ok') && !!q.el('btn'), q.uid);
    ok('both status slots can take focus (tabindex="-1")', /id="[^"]*-err"[^>]*tabindex="-1"/.test(q.html) && /id="[^"]*-ok"[^>]*tabindex="-1"/.test(q.html));
    await q.submit();
    ok('empty submit: the message names what is missing', /first name/.test(q.el('err').textContent) && /phone/.test(q.el('err').textContent) && /address/.test(q.el('err').textContent), q.el('err').textContent);
    ok('…every bad input gets aria-invalid="true"', ['fn', 'ph', 'ad'].every((s) => q.el(s).getAttribute('aria-invalid') === 'true'), ['fn', 'ph', 'ad'].map((s) => q.el(s).attrs));
    ok('…focus goes to the FIRST bad input (first name)', q.focusLog[q.focusLog.length - 1] === q.uid + '-fn', q.focusLog);
    ok('…the message is scrolled to the middle of the screen', centered(q.el('err')), q.el('err').calls);
    ok('…and nothing was sent', sent === 0);
  }
  {
    const q = loadQuickForm({ submitPublicLead: async () => ({ ok: true }), values: { fn: 'Pat', ph: '123', ad: '12 Elm St, Mason OH' } });
    await q.submit();
    const t = q.el('err').textContent;
    ok('only the phone is bad → the message asks only for the phone', /10-digit phone/.test(t) && !/first name|street address/.test(t), t);
    ok('…only the phone is marked invalid, and it takes focus', q.el('ph').getAttribute('aria-invalid') === 'true' && q.el('fn').getAttribute('aria-invalid') === null && q.el('ad').getAttribute('aria-invalid') === null && q.focusLog[q.focusLog.length - 1] === q.uid + '-ph', q.focusLog);
    const onInput = (q.form.listeners.input || [])[0];
    if (onInput) onInput({ target: q.el('ph') });
    ok('typing in a marked field clears its mark', !!onInput && q.el('ph').getAttribute('aria-invalid') === null);
    q.el('ph').value = '(859) 555-0100';
    q.window.submitPublicLead = async () => ({ ok: true });
    await q.submit();
    ok('a fixed form clears the old mark and the old message', q.el('ph').getAttribute('aria-invalid') === null && !/phone/.test(q.el('err').textContent), q.el('err').textContent);
  }
  console.log('\nfunnel-1 — the scheduling-choice error is also shown where it can be seen');
  {
    const radio = fakeEls(['radio']).radio;
    const fs1 = { classList: { add() {} }, querySelector: (s) => (s === 'input' ? radio : null) };
    const q = loadQuickForm({ values: GOOD, submitPublicLead: async () => ({ ok: true }), intake: { read: () => ({ error: 'Choose how you’d like to schedule: pick a time now, or ask us to contact you.', el: fs1 }), afterSubmit: async () => {} } });
    q.el('fn').value = GOOD.fn; q.el('ph').value = GOOD.ph; q.el('ad').value = GOOD.ad;
    await q.submit();
    ok('the error text is set, scrolled to, and the first radio takes focus', /Choose how/.test(q.el('err').textContent) && centered(q.el('err')) && radio.calls.some((c) => c[0] === 'focus'), q.el('err').textContent);
  }
  console.log('\nfunnel-1 — success and failure are scrolled to and focused');
  {
    const after = [];
    const q = loadQuickForm({ submitPublicLead: async () => ({ ok: true, id: 'x' }), intake: { read: () => ({ fields: { scheduling: 'contact_me' }, files: [] }), afterSubmit: async (box) => { after.push(box); } } });
    q.el('fn').value = GOOD.fn; q.el('ph').value = GOOD.ph; q.el('ad').value = GOOD.ad;
    await q.submit();
    const o = q.el('ok');
    ok('success: the confirmation text is set', /Got it/.test(o.textContent), o.textContent);
    ok('…scrolled to the middle of the screen', centered(o), o.calls);
    ok('…and focused (screen readers land on it)', q.focusLog[q.focusLog.length - 1] === q.uid + '-ok', q.focusLog);
    ok('…the calendar/photo block renders next to the message, not at the bottom of the form', after.length === 1 && after[0] !== q.form && q.form.calls.some((c) => c[0] === 'insertBefore' && c[1] === after[0]), after.length);
  }
  for (const [label, outcome, expected] of [
    ['friendly gateway reason', { ok: false, reason: 'We couldn’t reach our server. Check your connection and try again, or call or text Joe at ' + JOE + '.', friendly: true }, 'reason'],
    ['opaque gateway reason', { ok: false, reason: 'Invalid submission', status: 400 }, 'generic'],
    ['gateway script failed to load', new Error('gateway load failed'), 'generic'],
  ]) {
    const q = loadQuickForm({ submitPublicLead: outcome instanceof Error ? async () => { throw outcome; } : async () => outcome });
    q.el('fn').value = GOOD.fn; q.el('ph').value = GOOD.ph; q.el('ad').value = GOOD.ad;
    await q.submit();
    const t = q.el('err').textContent;
    ok(`failure (${label}): ${expected === 'reason' ? 'shows the plain reason as is' : 'shows the generic call/text line'}`,
      expected === 'reason' ? t === outcome.reason : t === 'Could not send — please call or text ' + JOE + '.', t);
    ok(`failure (${label}): no raw "(…)" suffix, and the raw text is in the console only`, !/Invalid submission|gateway|\)\s*$/.test(t.replace(JOE, '')) && q.warns.some((w) => w.includes(outcome.reason || outcome.message)), { t, warns: q.warns });
    ok(`failure (${label}): scrolled to, focused, and Send is usable again`, centered(q.el('err')) && q.focusLog[q.focusLog.length - 1] === q.uid + '-err' && q.el('btn').disabled === false, q.focusLog);
  }

  console.log('\nmarketing-9 — a contractor microsite shows the sentence once, with the contractor\'s own number');
  {
    const run = async (pathname, outcome, phone) => {
      const stubs = {};
      const mkStub = (id) => ({
        id, value: '', style: {}, attrs: {}, textContent: '', hidden: false, disabled: false, className: '', listeners: {}, children: [],
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] || null; },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }, appendChild(c) { this.children.push(c); return c; },
        classList: { add() {}, remove() {} }, closest: () => null, reset() {}, parentNode: null,
      });
      const document = {
        readyState: 'complete', title: '',
        documentElement: { style: { setProperty() {} } },
        getElementById: (id) => stubs[id] || (stubs[id] = mkStub(id)),
        createElement: () => mkStub('created'), addEventListener() {},
      };
      const cfg = { ok: true, name: 'Acme Roofing', siteKey: 'acme', contact: phone ? { phone } : {} };
      const window = {
        document, location: { pathname, search: '', hostname: 'nobigdealwithjoedeal.com' },
        submitPublicLead: async () => outcome,
      };
      const ctx = vm.createContext({ window, document, fetch: async () => ({ ok: true, json: async () => cfg }), URLSearchParams, Date, console: { warn() {}, log() {}, error() {} } });
      vm.runInContext(read('docs/sites/t/site.js'), ctx);
      await settle();
      document.getElementById('qFirst').value = 'Pat'; document.getElementById('qPhone').value = '(513) 555-0100'; document.getElementById('qAddress').value = '12 Elm St, Mason OH';
      await document.getElementById('quoteForm').listeners.submit[0]({ preventDefault() {} });
      await settle();
      return document.getElementById('formErr').textContent;
    };
    const plain = 'We couldn\u2019t reach our server. Check your connection and try again.';
    const t1 = await run('/sites/t/acme', { ok: false, friendly: true, network: true, reason: plain }, '(513) 555-0100');
    ok('a friendly reason is shown as one sentence, then the contractor\'s own number', t1 === plain + ' Or call (513) 555-0100.', t1);
    ok('…with no "Could not send your request —" lead-in and no NBD number', !/Could not send/.test(t1) && !/859|420-7382/.test(t1), t1);
    const t2 = await run('/sites/t/acme', { ok: false, friendly: true, reason: plain }, '');
    ok('without a contractor phone the sentence just ends', t2 === plain, t2);
    const t3 = await run('/sites/t/acme', { ok: false, status: 400, reason: 'Invalid submission' }, '(513) 555-0100');
    ok('a non-friendly reason keeps the old lead-in', t3 === 'Could not send your request — Invalid submission. Or call (513) 555-0100.', t3);
  }

  // ═══ marketing-7 — dropdowns at 16px, and the cache keys that carry it ═══
  console.log('\nmarketing-7 — selects are 16px so iPhone Safari does not zoom');
  {
    const css = read('docs/assets/css/intake-extras.css');
    const rule = (css.match(/\.nbd-intake-field select\s*\{([^}]*)\}/) || [])[1] || '';
    ok('.nbd-intake-field select is font-size:16px', /(^|;)\s*font-size:\s*16px\b/.test(rule), rule);
    ok('…keeps the 44px touch target', /min-height:\s*44px/.test(rule), rule);
    const ie = read('docs/assets/js/intake-extras.js');
    const cssV = +((ie.match(/intake-extras\.css\?v=(\d+)/) || [])[1] || 0);
    ok('intake-extras.js asks for the stylesheet under a bumped ?v= (the 24 h cache would otherwise hide the fix)', cssV >= 2, cssV);
    const qf = read('docs/assets/js/quick-lead-form.js');
    const jsV = +((qf.match(/intake-extras\.js\?v=(\d+)/) || [])[1] || 0);
    ok('quick-lead-form.js loads intake-extras.js under a bumped ?v= (so the 185 pages pick up the new ?v= above)', jsV >= 2, jsV);
  }

  // ═══ funnel-4 — /storm-alerts and /inspect confirmations ═══
  console.log('\nfunnel-4 — /storm-alerts: the sign-up confirmation takes focus and is on screen');
  for (const [label, saved] of [['saved', true], ['not saved', false]]) {
    const els = fakeEls(['alertName', 'alertPhone', 'alertZip', 'alertConcern', 'alertHoneypot', 'sa-consent', 'sa-error', 'formState', 'successState']);
    els.alertName.value = 'Pat'; els.alertPhone.value = '(859) 555-0100'; els.alertZip.value = '45202'; els['sa-consent'].checked = true;
    const btn = fakeEls(['btn']).btn;
    const document = { getElementById: (id) => els[id] || null, querySelector: (s) => (s === '.signup-btn' ? btn : null) };
    const window = { _saveStormAlert: async () => saved };
    const ctx = vm.createContext({ document, window, console });
    vm.runInContext(read('docs/assets/js/inline/c5a2295382.js') + '\n;this.submitAlert = submitAlert;', ctx);
    await ctx.submitAlert();
    const s = els.successState;
    if (saved) {
      ok(`${label}: the card is shown and the form hidden`, s.style.display === 'block' && els.formState.style.display === 'none');
      ok(`${label}: the card is focusable (tabindex -1) and announced (role=status)`, s.attrs.tabindex === '-1' && s.attrs.role === 'status', s.attrs);
      ok(`${label}: it takes focus`, s.calls.some((c) => c[0] === 'focus'));
      ok(`${label}: and is scrolled to the middle of the screen (the nav is sticky, so not "start")`, centered(s), s.calls);
    } else {
      ok(`${label}: the card stays hidden and no focus is stolen from the error`, s.style.display !== 'block' && !s.calls.length);
    }
  }
  console.log('\nfunnel-4 — /inspect: the thank-you card takes focus');
  {
    const els = fakeEls(['inspectForm', 'f-name', 'f-address', 'f-phone', 'ins-consent', 'inspectSubmit', 'inspectSuccess', 'insThanksTitle', 'insThanksText', 'insPickTime', 'insDetails']);
    els['f-name'].value = 'Pat Example'; els['f-address'].value = '12 Elm St, Goshen OH'; els['f-phone'].value = '8595550100';
    let submit = null;
    els.inspectForm.addEventListener = (t, fn) => { if (t === 'submit') submit = fn; };
    function FormData() {}
    FormData.prototype.forEach = function (cb) { cb('Pat Example', 'name'); };
    const reply = { current: { ok: true, photoToken: null } };
    const window = {
      location: { search: '' },
      NBDIntake: { read: () => ({ fields: { scheduling: 'contact_me' }, files: [] }), html: () => '', calendarUrl: () => '', afterSubmit() {} },
      submitPublicLead: () => Promise.resolve(reply.current),
    };
    const document = { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => fakeEls(['p']).p, addEventListener() {} };
    vm.runInNewContext(read('docs/assets/js/inspect-form.js'), { window, document, FormData, URLSearchParams, console: { error() {}, warn() {}, log() {} } });
    submit({ preventDefault() {} }); await settle();
    const s = els.inspectSuccess;
    ok('the success card is shown', /visible/.test(s.className));
    ok('…focusable (tabindex -1) and focused, so screen readers land on the confirmation', s.attrs.tabindex === '-1' && s.calls.some((c) => c[0] === 'focus'), s.calls);
    ok('…it was already scrolled into view (unchanged)', s.calls.some((c) => c[0] === 'scrollIntoView'));
    // The plain reason from the gateway client is shown as is.
    const friendly = 'This is taking too long. Check your connection and try again, or call or text Joe at ' + JOE + '.';
    reply.current = { ok: false, timedOut: true, reason: friendly, friendly: true };
    const fresh = fakeEls(['inspectForm', 'f-name', 'f-address', 'f-phone', 'ins-consent', 'inspectSubmit', 'inspectSuccess']);
    fresh['f-name'].value = 'Pat Example'; fresh['f-address'].value = '12 Elm St, Goshen OH'; fresh['f-phone'].value = '8595550100';
    let created = null; let sub2 = null;
    fresh.inspectForm.addEventListener = (t, fn) => { if (t === 'submit') sub2 = fn; };
    fresh.inspectForm.appendChild = (n) => { created = n; };
    const doc2 = { readyState: 'complete', getElementById: (id) => (id === 'inspectFormError' ? null : fresh[id] || null), createElement: () => fakeEls(['p']).p, addEventListener() {} };
    vm.runInNewContext(read('docs/assets/js/inspect-form.js'), { window, document: doc2, FormData, URLSearchParams, console: { error() {}, warn() {}, log() {} } });
    sub2({ preventDefault() {} }); await settle();
    ok('a failed send shows the gateway\'s plain reason in the red box', !!created && created.textContent === friendly, created && created.textContent);
  }
  console.log('\nfunnel-4 — the pages carry the bumped cache keys and the font preloads');
  {
    const sa = read('docs/storm-alerts.html'), ins = read('docs/inspect.html');
    ok('storm-alerts.html loads c5a2295382.js under ?v=3 or later', +((sa.match(/c5a2295382\.js\?v=(\d+)/) || [])[1] || 0) >= 3);
    ok('inspect.html loads inspect-form.js under ?v=7 or later', +((ins.match(/inspect-form\.js\?v=(\d+)/) || [])[1] || 0) >= 7);
    for (const [name, html] of [['storm-alerts.html', sa], ['inspect.html', ins]]) {
      ok(`${name} preloads Bebas Neue and Montserrat (as /book does)`,
        /<link rel="preload" href="\/assets\/fonts\/bebas-neue-400-latin\.woff2" as="font" type="font\/woff2" crossorigin>/.test(html) &&
        /<link rel="preload" href="\/assets\/fonts\/montserrat-400-latin\.woff2" as="font" type="font\/woff2" crossorigin>/.test(html));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
