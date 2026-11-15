/**
 * tests/money-copy-honest-2026-11-14.test.js — homeowner-facing money and
 * signing copy says only what is known (2026-11-14 review, finding 10).
 *
 *  1. docs/pro/invoice-success.html is the redirect after EVERY Stripe pay
 *     link (functions/stripe.js createStripePaymentLink), deposits and bank
 *     (ACH) payments included. It said "your invoice has been marked paid"
 *     and "No further action is needed" — false for a deposit (a balance
 *     remains) and for a bank payment that has not cleared.
 *  2. docs/pro/js/esign-sign.js promised "A signed copy is on its way to your
 *     email" on every completion, though submitEsignEnvelope reports whether
 *     the copy went out (copyEmailed) and a signer may have no email or the
 *     send may fail. copyEmailed is now THIS signer's copy, and the page only
 *     promises an email when it is true.
 *  3. docs/pro/js/estimate-view.js told a link that hit its open cap
 *     (portal-authz.js: 429 too_many_opens, permanent) to "Give it a minute
 *     and try again". It now reads the body's code, like portal.js does.
 *  4. docs/pro/js/portal.js _diffView: an open portal repainted on a payment,
 *     a bank payment starting and a new pay link, but not when the amount
 *     due changed with no link (Zelle / pay-by-bank only), when a bank
 *     payment stopped processing without posting (failed ACH), or when the
 *     balance went away without a payment (invoice voided).
 *
 * Run: node tests/money-copy-honest-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kit = require('./lib/src-kit');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
function liftBetween(src, start, end) {
  const i = src.indexOf(start); if (i < 0) return null;
  const j = src.indexOf(end, i); if (j < 0) return null;
  return src.slice(i, j + end.length);
}

(async function () {
  console.log('1. invoice-success.html (every pay link, deposits and ACH included)');
  {
    const page = kit.parseTags(kit.read('docs/pro/invoice-success.html'));
    const words = [page.$('title'), page.$('h1'), page.$('.sub'), page.$('.receipt-note')].map((e) => (e ? e.text : '')).join(' ').replace(/\s+/g, ' ');
    ok('found the title, heading, body and receipt note', !!(page.$('title') && page.$('h1') && page.$('.sub') && page.$('.receipt-note')));
    ok('does not claim the invoice was marked paid', !/marked paid/i.test(words), words);
    ok('does not say no further action is needed', !/no further action/i.test(words));
    ok('does not assert the money has been "received" as settled (ACH may still be clearing)', !/Payment Received/i.test(words));
    ok('says a remaining balance is confirmed by the contractor', /remaining balance/i.test(words) && /contractor/i.test(words));
    ok('mentions the emailed receipt', /receipt/i.test(words) && /email/i.test(words));
    const scripts = page.$$('script');
    ok('loads only its one external module script (no inline script)', scripts.length === 1 && scripts[0].attr('src') === 'js/pages/invoice-success.js' && scripts[0].attr('type') === 'module' && !scripts[0].html.trim());
  }

  console.log('\n2. e-sign completion only promises an emailed copy when one went out');
  {
    const fn = kit.read('functions/esign-envelope.js');
    ok('server: copyEmailed is THIS signer\'s copy, sent WITH the PDF attached',
      /copies\.push\(\{ signerId: s\.id, emailed: !!r\.emailed, attached: attach,[\s\S]*copyEmailed: copies\.some\(\(c\) => c\.emailed && c\.attached && c\.signerId === signer\.id\)/.test(fn));
    const js = kit.read('docs/pro/js/esign-sign.js');
    // One pin: the emailed promise sits in the copyEmailed === true branch, and
    // the else branch's message never mentions email.
    ok('the "on its way to your email" promise is behind r.data.copyEmailed === true; the other branch promises no email',
      /\} else if \(r\.data\.copyEmailed === true\) \{\s*showMsg\([^;]*on its way to your email[^;]*\);\s*\} else \{[^}]*?showMsg\((?:(?!email)[^;])*\);\s*\}/i.test(js));
  }

  console.log('\n3. estimate-view: a permanently blocked link is not told to try again');
  {
    const src = read('docs/pro/js/estimate-view.js');
    const fnSrc = liftBetween(src, '  function errorStateFor(', '\n  }\n');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fnSrc + '\nthis.f = errorStateFor;', ctx);
    const capped = ctx.f(429, 'too_many_opens');
    ok('429 too_many_opens: no retry, and the copy does not say "a minute" or "try again"',
      capped.retry === false && !/minute|try again/i.test(capped.title + ' ' + capped.body), JSON.stringify(capped));
    ok('429 too_many_opens: tells them to ask the rep for a fresh link', /fresh link/i.test(capped.body));
    const limiter = ctx.f(429, null);
    ok('a plain 429 (per-IP limiter, no code) is still transient with Try again', limiter.retry === true);
    ok('load() reads the response body for its code before choosing the state',
      /res\.clone\(\)\.json\(\)[\s\S]{0,200}errorStateFor\(res\.status, code\)/.test(src));
  }

  console.log('\n4. portal: an open page repaints on every balance change');
  {
    const PJS = read('docs/pro/js/portal.js');
    const diffSrc = liftBetween(PJS, '  function _diffView(prev, next) {', '\n  }\n');
    const paidSrc = liftBetween(PJS, '  function paidSoFarCents(paid) {', '\n  }\n');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(paidSrc + diffSrc + '\nthis.diff = _diffView;', ctx);
    const base = { progress: { currentLabel: 'Final payment' }, photos: [], paid: { totalPaidCents: 100000, payments: [] },
      balance: { stripePaymentLink: null, amountCents: 500000, processingCents: 0, kind: 'balance' } };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    ok('nothing changed → still no repaint', ctx.diff(base, clone(base)) === null);
    const more = clone(base); more.balance.amountCents = 650000;
    ok('amount due changed with no pay link → repaint', !!ctx.diff(base, more));
    const proc = clone(base); proc.balance.processingCents = 500000;
    const failedAch = clone(base);
    ok('bank payment stopped processing without posting → repaint', !!ctx.diff(proc, failedAch));
    const gone = clone(base); gone.balance = null;
    ok('balance went away without a payment (voided) → repaint', !!ctx.diff(base, gone));
    const paid = clone(base); paid.paid.totalPaidCents = 600000; paid.balance = null;
    const ev = ctx.diff(base, paid);
    ok('a posted payment still reads "Payment received" (one banner)', !!ev && ev.length === 1 && /Payment received/.test(ev[0].msg));
  }

  console.log('\n5. review round 2 (2026-11-14)');
  {
    // 9. A poll that comes back 429 too_many_opens (or 410) stops polling.
    const PJS = read('docs/pro/js/portal.js');
    const pollSrc = liftBetween(PJS, '  async function _pollOnce() {', '\n  }\n');
    const schedSrc = liftBetween(PJS, '  function _scheduleNextPoll() {', '\n  }\n');
    async function poll(status, body) {
      const ctx = { banners: [], timers: 0, document: { hidden: false }, Date };
      ctx.setTimeout = () => { ctx.timers++; return 1; };
      ctx.clearTimeout = () => {};
      vm.createContext(ctx);
      vm.runInContext(
        'var _pollInflight = false, _pollTimer = 1, _payWatchUntil = 0, POLL_INTERVAL_MS = 1, PAY_POLL_INTERVAL_MS = 1, _lastView = null, _pollStopped = false;\n' +
        'function _pulseLivePill() {}\nfunction getToken() { return "TOKEN123"; }\nfunction _diffView() { return null; }\nfunction renderView() {}\n' +
        'function _showUpdateBanner(ev) { banners.push(ev); }\n' + schedSrc + '\n' + pollSrc + '\nthis.pollOnce = _pollOnce;', ctx);
      ctx._fetchView = async () => ({ ok: false, status, clone() { return this; }, json: async () => body });
      vm.runInContext('_fetchView = this._fetchView;', ctx);
      await ctx.pollOnce();
      return ctx;
    }
    const capped = await poll(429, { code: 'too_many_opens' });
    ok('poll 429 too_many_opens: no further poll is scheduled', capped.timers === 0, 'timers=' + capped.timers);
    ok('poll 429 too_many_opens: a banner tells them to get a fresh link', capped.banners.length === 1 && /fresh link/i.test(capped.banners[0][0].msg));
    const gone = await poll(410, { code: 'expired' });
    ok('poll 410: no further poll is scheduled either (finally re-armed it)', gone.timers === 0, 'timers=' + gone.timers);
    const limiter = await poll(429, {});
    ok('poll 429 from the per-IP limiter (no code): keeps polling', limiter.timers === 1 && limiter.banners.length === 0);

    // 12. The banner is built with textContent, not innerHTML.
    const bannerSrc = liftBetween(PJS, '  function _showUpdateBanner(events) {', '\n  }\n') || '';
    const made = []; let htmlWrites = 0;
    const mk = (tag) => {
      const el = { tag, children: [], style: {}, attrs: {}, textContent: '', parentNode: null,
        setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, remove() {},
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; } };
      Object.defineProperty(el, 'innerHTML', { set() { htmlWrites++; }, get() { return ''; } });
      made.push(el); return el;
    };
    const bctx = { document: { getElementById: () => null, createElement: mk, body: mk('body') },
      requestAnimationFrame: () => {}, setTimeout: () => 0, Array };
    vm.createContext(bctx);
    vm.runInContext(bannerSrc + '\nthis.show = _showUpdateBanner;', bctx);
    const evil = '<img src=x onerror=alert(1)>';
    bctx.show([{ msg: evil }, { msg: '💳 Your balance was updated' }]);
    const bannerEl = made.find((e) => e.attrs.role === 'status');
    ok('update banner writes each message as text (no innerHTML, markup stays inert)',
      htmlWrites === 0 && !!bannerEl && bannerEl.children.length === 2 && bannerEl.children[0].textContent === evil, 'innerHTML writes=' + htmlWrites);

    // 10. copyEmailed only when the PDF was attached.
    // (copyEmailed + attached is pinned once in section 2.)
    ok('multi-signer line does not promise an email',
      /will get their own link to sign next\. Once everyone has signed, you will get a signed copy\.'/.test(kit.read('docs/pro/js/esign-sign.js')));

    // 11. The success page is reachable by any redirect: say it conditionally.
    const sub = (kit.parseTags(kit.read('docs/pro/invoice-success.html')).$('.sub') || {}).text || '';
    ok('success page does not assert the payment went through', !/got your payment/i.test(sub) && /^If your payment went through/i.test(sub.trim()), sub);
  }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' money copy honest: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(1); });
