/**
 * tests/phone-quick-wins-2026-10-08.test.js
 *
 * "Record payment" one tap from Home, from the 2026-10-07 phone audit
 * (nbd-content/crm-phone-audit-2026-10-07.md, item 2). Re-sliced 2026-10-13
 * from #2316 onto main; the other quick wins from that PR are NOT in this file.
 *
 *   Q1  the Record payment sheet and its siblings (<div class="modal"> cards
 *       from shared modules) had no background on customer.html — the page
 *       showed through. Save rendered navy like Cancel.
 *   Q2  Home "Money to collect" → one tap opens Record payment for THAT
 *       invoice (customer.html?id=…&pay=<invoiceId>, customer-pay-link.js).
 *   B   Save stays above the iPhone keyboard: keyboard-viewport.js fits open
 *       sheets to window.visualViewport while the keyboard is up, and Save is
 *       sticky to the bottom of the sheet's scroll.
 *
 * Behavioural where the code allows it: each module is loaded whole in a vm
 * with a fake window/document and driven. The CSS / markup checks pin the
 * rules the E2E spec (tests/e2e/phone-quick-wins.spec.js) measures in a real
 * browser. Pure Node:  node tests/phone-quick-wins-2026-10-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

// A small fake DOM: enough for the modules under test to load and paint.
function fakeEnv(over) {
  const els = {};
  const listeners = {};
  const document = {
    readyState: 'complete',
    documentElement: { style: { opacity: '1', setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} } },
    body: {},
    activeElement: null,
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null }),
  };
  const window = Object.assign({
    document,
    location: { search: '', pathname: '/pro/customer.html', hash: '' },
    history: { state: null, replaceState() {} },
    addEventListener() {},
    dispatchEvent() {},
    innerHeight: 844,
    requestAnimationFrame: (f) => { f(); return 1; },
  }, over || {});
  window.window = window;
  const ctx = vm.createContext(Object.assign({
    window, document, console, URLSearchParams, Promise, Date, Math, JSON, String, Number, Array, Object, Set, Map, RegExp, Error,
    setTimeout: () => 0, clearTimeout() {}, MutationObserver: function () { this.observe = () => {}; },
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    Event: function (n) { this.type = n; },
    navigator: {},
  }, {}));
  return { ctx, window, document, els, listeners };
}
function load(env, rel) { vm.runInContext(rd(rel), env.ctx, { filename: rel }); }

(async () => {
  // ── Q2: Home's money row → Record payment for that invoice ───────────
  console.log('\nQ2 Home "Money to collect" → Record payment, one tap');
  {
    function paint(claims) {
      const env = fakeEnv();
      const el = { innerHTML: '', hidden: true, attrs: {}, getAttribute(k) { return this.attrs[k] || null; }, setAttribute(k, v) { this.attrs[k] = v; } };
      env.els.todayPlan = el;
      const w = env.window;
      w._userClaims = claims;
      w._user = { uid: 'u1' };
      w._leadsLoaded = true;
      w._leads = [{ id: 'lead-carl' }];
      w.NBDTasks = { loaded: () => true };
      w.NBDTodayPlan = {
        buildTodayPlan: () => ({ appointments: [], calls: [], promised: [], estimates: [], stalled: [], noNextStep: null, total: 1,
          money: [{ key: 'inv:inv-77', kind: 'invoice', invoiceId: 'inv-77', leadId: 'lead-carl', name: 'Carl Mendez', cents: 1120000, phone: '5135550119', overdue: true, number: 'INV-1001' }] }),
        headline: () => '1 thing today', stormLine: () => '', fmtCents: (c) => '$' + (c / 100).toLocaleString('en-US'), ymdLocal: () => '2026-10-08',
      };
      load(env, 'docs/pro/js/today-home.js');
      w.NBDToday.render();
      return el.innerHTML;
    }
    const html = paint({ role: 'company_admin' });
    const m = html.match(/<a class="tp-btn tp-go" href="([^"]+)">([^<]+)<\/a>/);
    ok('the money row has one primary link', !!m, html.slice(0, 400));
    if (m) {
      const href = m[1].replace(/&amp;/g, '&');
      ok('it opens the customer page with &pay=<that invoice> (was the plain customer link, ~12 screens above Record payment)',
        href === '/pro/customer.html?id=lead-carl&pay=inv-77', href);
      ok('it is labelled "Record payment"', /Record payment/.test(m[2]), m[2]);
    }
    const ro = paint({ role: 'viewer' });
    ok('a viewer (read-only) gets the plain customer link, no pay deep link', /href="\/pro\/customer\.html\?id=lead-carl">Open</.test(ro) && !/pay=/.test(ro), ro.slice(0, 300));
  }

  // ── Q2: the deep link itself ─────────────────────────────────────────
  console.log('\nQ2 customer-pay-link.js reads the link');
  {
    const env = fakeEnv();
    const replaced = [];
    env.window.location = { search: '?id=lead-carl&pay=inv-77', pathname: '/pro/customer', hash: '' };
    env.window.history = { state: null, replaceState: (s, t, url) => replaced.push(url) };
    load(env, 'docs/pro/js/customer-pay-link.js');
    const P0 = env.window.NBDCustomerPayLink;
    ok('NBDCustomerPayLink.parsePayLink is exported', P0 && typeof P0.parsePayLink === 'function');
    const P = P0 || { parsePayLink: () => ({}) };
    ok('&pay is dropped from the address bar at once (a reload or Back never reopens the sheet)',
      replaced.length === 1 && replaced[0] === '/pro/customer?id=lead-carl', JSON.stringify(replaced));
    const p = (s) => JSON.stringify(P.parsePayLink(s));
    ok('no pay param → null', P.parsePayLink('?id=abc') === null);
    ok('?id=abc&pay=inv_9 → that lead + invoice', p('?id=abc&pay=inv_9') === JSON.stringify({ leadId: 'abc', invoiceId: 'inv_9', rest: 'id=abc' }), p('?id=abc&pay=inv_9'));
    ok('pay=1 → open the sheet with no invoice pinned', P.parsePayLink('?id=abc&pay=1').invoiceId === null && P.parsePayLink('?id=abc&pay=1').leadId === 'abc');
    ok('a malformed invoice id is not trusted', P.parsePayLink('?id=abc&pay=' + encodeURIComponent('x"><img')).invoiceId === null);
    ok('a malformed lead id opens nothing', P.parsePayLink('?id=' + encodeURIComponent('../x') + '&pay=1').leadId === null);
    ok('other params survive', P.parsePayLink('?id=abc&tab=files&pay=q').rest === 'id=abc&tab=files');
    const src = stripComments(rd('docs/pro/js/customer-pay-link.js'));
    ok('it opens the page\'s own sheet (NBDCustomerInvoices.recordPayment), never writes itself',
      /NBDCustomerInvoices\.recordPayment\(link\.leadId\)/.test(src) && !/addDoc|updateDoc|setDoc|markPaid\(/.test(src));
    ok('viewers are never offered the sheet', /isViewer\(\)\) return/.test(src));
    const html = rd('docs/pro/customer.html');
    ok('customer.html loads customer-pay-link.js (defer)', /<script defer src="js\/customer-pay-link\.js\?v=\d+"><\/script>/.test(html));
  }

  // ── Q1: a solid sheet with a primary Save ────────────────────────────
  console.log('\nQ1 the Record payment sheet is solid; Save is the primary button');
  {
    const html = stripComments(rd('docs/pro/customer.html'));
    const rule = html.match(/\.modal-bg\s*>\s*\.modal\s*\{([^}]*)\}/);
    ok('customer.html styles the shared .modal card (it was only styled in dashboard-app.css, which this page does not load)', !!rule);
    if (rule) {
      ok('…with a solid background', /background:\s*var\(--s\)/.test(rule[1]), rule[1]);
      ok('…padding', /padding:\s*\d+px/.test(rule[1]));
      ok('…and its own scroll inside the screen', /max-height:\s*90dvh/.test(rule[1]) && /overflow-y:\s*auto/.test(rule[1]));
    }
    const css = stripComments(rd('docs/pro/css/invoice-pipeline.css'));
    const save = css.match(/\.ipx-btn-save(?:\.ipx-btn-save){3}\.btn-green\s*\{([^}]*)\}/);
    ok('Save payment has its own solid colour on both pages (customer.html has no .btn-green rule)', !!save && /background:\s*var\(--green/.test(save[1]), save && save[1]);
    ok('Save is sticky to the bottom of the sheet\'s scroll', !!save && /position:\s*sticky/.test(save[1]) && /bottom:\s*0/.test(save[1]));
    ok('a focused field scrolls to just above the sticky Save, not under it', /\.modal:has\(>\s*\.ipx-btn-save\.btn-green\)\s*\{[^}]*scroll-padding-bottom:\s*\d+px/.test(css));
    const ip = rd('docs/pro/js/invoice-pipeline.js');
    ok('both payment sheets still render Save as .btn-green.ipx-btn-save (the hook the CSS keys on)',
      (ip.match(/class="btn btn-green ipx-btn-save">Save payment</g) || []).length === 2);
  }

  // ── B: above the keyboard ────────────────────────────────────────────
  console.log('\nB  keyboard-viewport.js fits open sheets above the iPhone keyboard');
  {
    const added = [], removed = [], props = {};
    const env = fakeEnv();
    const vvListeners = {};
    env.window.visualViewport = { height: 844, offsetTop: 0, addEventListener: (n, f) => { vvListeners[n] = f; } };
    // A real frame callback runs later, after requestAnimationFrame returned.
    const frames = [];
    env.window.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
    const flush = () => { while (frames.length) frames.shift()(); };
    env.document.documentElement = {
      style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } },
      classList: { add: (c) => added.push(c), remove: (c) => removed.push(c) },
    };
    load(env, 'docs/pro/js/keyboard-viewport.js');
    const K0 = env.window.NBDKeyboardViewport;
    ok('NBDKeyboardViewport.compute is exported', K0 && typeof K0.compute === 'function');
    const K = K0 || { compute: () => ({}) };
    const c = (ih, vv) => JSON.stringify(K.compute(ih, vv));
    ok('no keyboard (visual = layout height) → closed', K.compute(844, { height: 844, offsetTop: 0 }).open === false);
    ok('the address bar collapsing (~80px) is not a keyboard', K.compute(844, { height: 764, offsetTop: 0 }).open === false);
    ok('a 336px keyboard → open, sheet height 508', c(844, { height: 508, offsetTop: 0 }) === JSON.stringify({ open: true, h: 508, top: 0 }), c(844, { height: 508, offsetTop: 0 }));
    ok('iOS panned the page 120px → the sheet follows (top 120)', K.compute(844, { height: 508.4, offsetTop: 120.2 }).top === 120);
    ok('no visualViewport (old browser) → closed, nothing breaks', K.compute(844, null).open === false);
    ok('it listens to visualViewport resize + scroll', typeof vvListeners.resize === 'function' && typeof vvListeners.scroll === 'function');
    if (!vvListeners.resize) vvListeners.resize = () => {};
    env.window.visualViewport.height = 508;
    vvListeners.resize(); flush();
    ok('keyboard up → <html class="nbd-kb-open"> and --nbd-vv-h: 508px', added.includes('nbd-kb-open') && props['--nbd-vv-h'] === '508px' && props['--nbd-vv-top'] === '0px', JSON.stringify({ added, props }));
    env.window.visualViewport.height = 844;
    vvListeners.resize(); flush();
    ok('keyboard down → class and variables removed', removed.includes('nbd-kb-open') && !('--nbd-vv-h' in props), JSON.stringify({ removed, props }));
    const mp = stripComments(rd('docs/pro/css/mobile-polish.css'));
    ok('mobile-polish.css fits an open .modal-bg to the visible area while the keyboard is up',
      /html\.nbd-kb-open \.modal-bg\.open\s*\{[^}]*top:\s*var\(--nbd-vv-top[^}]*height:\s*var\(--nbd-vv-h/.test(mp));
    ok('…and caps the card to it', /html\.nbd-kb-open \.modal-bg\.open > \.modal,\s*html\.nbd-kb-open \.modal-bg\.open > \.modal-content\s*\{[^}]*max-height:\s*calc\(var\(--nbd-vv-h/.test(mp));
    for (const page of ['customer.html', 'dashboard.html']) {
      ok(page + ' loads keyboard-viewport.js (defer)', /<script defer src="js\/keyboard-viewport\.js\?v=\d+"><\/script>/.test(rd('docs/pro/' + page)));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
