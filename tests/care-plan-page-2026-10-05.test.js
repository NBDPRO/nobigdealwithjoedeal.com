/**
 * tests/care-plan-page-2026-10-05.test.js
 *
 * The Roof Care Plan online signup on /services/roof-care-plan (PR 3 of 3,
 * Jo 2026-10-05): docs/assets/js/care-plan-checkout.js + the page markup.
 *   1. ships dark: the section is hidden and "Get My Care Plan" still goes to
 *      the contact form unless the server says the plan is on
 *   2. the gate: off → nothing; test → only ?preview=careplan or an invite;
 *      live → everyone; any error reaching the server → off
 *   3. renewal terms shown + required before checkout, same words as the
 *      server records (functions/care-plan-logic.js)
 *   4. the browser is only ever sent to Stripe's own pages
 *   5. the thank-you screen's "Manage or cancel" works in every mode
 * Fake DOM + fetch; nothing leaves the process.
 * Run: node tests/care-plan-page-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const PAGE = read('docs/services/roof-care-plan.html');
const SRC = read('docs/assets/js/care-plan-checkout.js');
const YEARLY = '$199 today, then $199 every year until you cancel — the plan renews automatically. No lock-in: cancel anytime from your billing link or by calling or texting Joe, and you will not be charged again. Your plan stays active through the time you have already paid for.';

console.log('\n1. the page markup ships dark');
{
  const sec = (PAGE.match(/<section class="cp-join" id="careplan-join"[^>]*>/) || [''])[0];
  ok('the signup section exists and is HIDDEN by default', /\bhidden\b/.test(sec));
  const ctas = PAGE.match(/<a href="[^"]*" class="btn-(primary|white)" data-careplan-cta>/g) || [];
  ok('both "Get My Care Plan" buttons still go to the contact form (/#contact) until the plan is on', ctas.length === 2 && ctas.every((a) => /href="\/#contact"/.test(a)), String(ctas.length));
  ok('the script loads deferred, after quick-lead-form.js, with its stylesheet', /<script defer src="\/assets\/js\/quick-lead-form\.js"><\/script>\r?\n<script defer src="\/assets\/js\/care-plan-checkout\.js"><\/script>/.test(PAGE) && /href="\/assets\/css\/care-plan-checkout\.css"/.test(PAGE));
  ok('no inline handlers in the new section', !/careplan-join[\s\S]*?<\/section>/.exec(PAGE)[0].match(/\son[a-z]+=/i));
  ok('the terms checkbox is required; honeypot nbd_hp present', /name="cp_terms" required/.test(PAGE) && /name="nbd_hp"/.test(PAGE));
  const shown = (PAGE.match(/<span data-cp-terms-text>([\s\S]*?)<\/span>/) || [])[1] || '';
  ok('the default terms shown are the yearly disclosure, word for word', shown.replace(/&mdash;/g, '—') === YEARLY, shown);
  ok('the page still promises $199 a year or $19 a month, cancel anytime', /\$199 a year or \$19 a month/.test(PAGE) && /cancel anytime/.test(PAGE));
  ok('says payment is on Stripe\'s page, card never touches the site', /Stripe&rsquo;s secure checkout page; your card never touches this site/.test(PAGE));
}

// ── a small fake DOM ─────────────────────────────────────────────────────
function el(attrs) {
  const listeners = {};
  const kids = {};
  const classes = new Set();
  const e = Object.assign({
    hidden: false, textContent: '', disabled: false, attrs: {},
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    fire(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(Object.assign({ preventDefault() {}, target: e }, ev || {}))); },
    querySelector(sel) { if (!(sel in kids)) kids[sel] = el(); return kids[sel]; },
    scrollIntoView() {},
    _kids: kids,
  }, attrs || {});
  return e;
}
function boot(opts) {
  const o = opts || {};
  const sec = el({ hidden: true });
  const form = sec.querySelector('form[data-cp-form]');
  const fields = { cp_firstName: { value: 'Pat' }, cp_lastName: { value: 'Q' }, cp_email: { value: 'pat@example.com' }, cp_phone: { value: '513 555 0142' }, cp_address: { value: '12 Oak St' }, cp_zip: { value: '45202' }, nbd_hp: { value: '' } };
  form.elements = fields;
  const radios = { year: { value: 'year' }, month: { value: 'month' } };
  let picked = o.interval || 'year';
  form.querySelector = (sel) => {
    if (sel === 'input[name="cp_interval"]:checked') return radios[picked];
    if (sel === 'input[name="cp_terms"]') return { checked: o.terms !== false };
    if (sel === 'button[type="submit"]') return form._btn || (form._btn = el());
    return el();
  };
  const ctas = [el({ attrs: { href: '/#contact' } }), el({ attrs: { href: '/#contact' } })];
  const calls = [];
  let href = null;
  const doc = {
    readyState: 'complete', documentElement: el(),
    getElementById: (id) => (id === 'careplan-join' ? sec : null),
    querySelectorAll: (sel) => (sel === 'a[data-careplan-cta]' ? ctas : []),
    querySelector: () => null, addEventListener() {}, head: { appendChild(s) { if (s.onload) s.onload(); } }, createElement: () => ({}),
  };
  const fetch = (url, init) => {
    calls.push({ url, init });
    if (!init || init.method === 'GET') {
      if (o.modeFails) return Promise.reject(new Error('net'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ mode: o.mode || 'off' }) });
    }
    const body = JSON.parse(init.body);
    const r = o.respond ? o.respond(body) : { status: 200, data: { url: body.action === 'portal' ? 'https://billing.stripe.com/p/x' : 'https://checkout.stripe.com/c/x' } };
    return Promise.resolve({ ok: r.status < 300, status: r.status, json: () => Promise.resolve(r.data) });
  };
  const win = { location: { search: o.search || '', set href(v) { href = v; }, get href() { return href; } }, nbdTurnstileExecute: () => Promise.resolve('tok_' + 'x'.repeat(12)) };
  win.window = win;
  const sandbox = { window: win, document: doc, fetch, URLSearchParams, setTimeout, clearTimeout, AbortController, JSON, Promise, console };
  Object.defineProperty(sandbox, 'location', { get: () => win.location });
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'care-plan-checkout.js' });
  return { sec, form, ctas, calls, win, pick: (v) => { picked = v; }, href: () => href, T: win.NBDCarePlanCheckout._test };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

(async () => {
  console.log('\n2. the gate');
  {
    const T = boot().T;
    ok('off → closed for everyone', !T.enabledFor('off', {}) && !T.enabledFor('off', { preview: true }) && !T.enabledFor('off', { invite: 'x' }));
    ok('test → only ?preview=careplan or an invite', !T.enabledFor('test', {}) && T.enabledFor('test', { preview: true }) && T.enabledFor('test', { invite: 'x' }));
    ok('live → everyone', T.enabledFor('live', {}));

    let b = boot({ mode: 'off' }); await tick();
    ok('OFF: section stays hidden, CTAs still /#contact', b.sec.hidden === true && b.ctas.every((a) => a.getAttribute('href') === '/#contact'));
    b = boot({ mode: 'test' }); await tick();
    ok('TEST without preview: unchanged', b.sec.hidden === true && b.ctas.every((a) => a.getAttribute('href') === '/#contact'));
    b = boot({ mode: 'test', search: '?preview=careplan' }); await tick();
    ok('TEST with ?preview=careplan: the form opens, CTAs point at it', b.sec.hidden === false && b.sec.querySelector('[data-cp-join]').hidden === false && b.ctas.every((a) => a.getAttribute('href') === '#careplan-join'));
    b = boot({ mode: 'live' }); await tick();
    ok('LIVE: open for everyone', b.sec.hidden === false && b.ctas.every((a) => a.getAttribute('href') === '#careplan-join'));
    b = boot({ modeFails: true }); await tick();
    ok('server unreachable → treated as off', b.sec.hidden === true && b.ctas.every((a) => a.getAttribute('href') === '/#contact'));
    b = boot({ mode: 'off', search: '?invite=' + 'a'.repeat(32) }); await tick();
    ok('an invite while OFF says "call Joe", no form', b.sec.hidden === false && b.sec.querySelector('[data-cp-join]').hidden === true && /Call or text Joe/.test(b.sec.querySelector('[data-cp-msg]').textContent));
  }

  console.log('\n3. terms + checkout request');
  {
    const T = boot().T;
    ok('the yearly terms are exactly the server\'s wording', T.disclosureText('year') === YEARLY);
    const logicPath = path.join(ROOT, 'functions', 'care-plan-logic.js');
    if (fs.existsSync(logicPath)) {
      const C = require(logicPath);
      ok('…and match functions/care-plan-logic.js disclosureText for both plans', T.disclosureText('year') === C.disclosureText('year') && T.disclosureText('month') === C.disclosureText('month'));
    } else {
      ok('…(server wording pinned literally above; care-plan-logic.js not on this tree)', true);
    }
    let b = boot({ mode: 'live', terms: false }); await tick();
    b.form.fire('submit');
    await tick();
    ok('terms not ticked → no request, a clear message', b.calls.filter((c) => c.init && c.init.method === 'POST').length === 0 && /renewal terms/.test(b.sec.querySelector('[data-cp-msg]').textContent));
    b = boot({ mode: 'test', search: '?preview=careplan' }); await tick();
    b.pick('month');
    b.form.fire('submit');
    await tick();
    const post = b.calls.find((c) => c.init && c.init.method === 'POST');
    const body = post ? JSON.parse(post.init.body) : {};
    ok('the request: checkout, monthly, termsAccepted true, preview true, the person, a Turnstile token', body.action === 'checkout' && body.interval === 'month' && body.termsAccepted === true && body.preview === true
      && body.firstName === 'Pat' && body.email === 'pat@example.com' && body.phone === '513 555 0142' && body.address === '12 Oak St' && /^tok_/.test(body.turnstileToken || ''), JSON.stringify(body));
    ok('…then off to Stripe Checkout', b.href() === 'https://checkout.stripe.com/c/x');
    b = boot({ mode: 'test', search: '?invite=' + 'b'.repeat(32) }); await tick();
    b.form.fire('submit');
    await tick();
    const ib = JSON.parse((b.calls.find((c) => c.init && c.init.method === 'POST') || { init: { body: '{}' } }).init.body);
    ok('an invite sends only the invite + plan + consent (no personal fields)', ib.invite === 'b'.repeat(32) && ib.termsAccepted === true && !('email' in ib) && !('preview' in ib));
    b = boot({ mode: 'live', respond: () => ({ status: 200, data: { url: 'https://evil.example/phish' } }) }); await tick();
    b.form.fire('submit');
    await tick();
    ok('a non-Stripe URL in the answer is never followed', b.href() === null);
    ok('safeStripeUrl: checkout and portal hosts only', T.safeStripeUrl('https://checkout.stripe.com/c/1', 'checkout') && !T.safeStripeUrl('https://billing.stripe.com/p/1', 'checkout')
      && T.safeStripeUrl('https://billing.stripe.com/p/1', 'portal') && !T.safeStripeUrl('http://checkout.stripe.com/x', 'checkout') && !T.safeStripeUrl(null, 'portal'));
    b = boot({ mode: 'live', respond: () => ({ status: 409, data: { error: 'already_member' } }) }); await tick();
    b.form.fire('submit');
    await tick();
    ok('already a member → says so, with Joe\'s number', /already a Roof Care Plan member/.test(b.sec.querySelector('[data-cp-msg]').textContent));
  }

  console.log('\n4. the thank-you screen + cancel (every mode)');
  {
    const b = boot({ mode: 'off', search: '?careplan=joined&session_id=cs_live_' + 'a'.repeat(20) }); await tick();
    ok('joined: the thank-you shows even while OFF; the form does not', b.sec.hidden === false && b.sec.querySelector('[data-cp-joined]').hidden === false && b.sec.querySelector('[data-cp-join]').hidden === true);
    ok('…without asking the server for the mode', !b.calls.some((c) => !c.init || c.init.method === 'GET'));
    b.sec.querySelector('[data-cp-manage]').fire('click');
    await tick();
    const pb = JSON.parse((b.calls.find((c) => c.init && c.init.method === 'POST') || { init: { body: '{}' } }).init.body);
    ok('"Manage or cancel" → portal with the session id → Stripe billing page', pb.action === 'portal' && pb.sessionId === 'cs_live_' + 'a'.repeat(20) && b.href() === 'https://billing.stripe.com/p/x');
    const bad = boot({ mode: 'live', search: '?careplan=joined&session_id=nope' }).T.readParams();
    ok('a malformed session id is ignored', bad.sessionId === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
