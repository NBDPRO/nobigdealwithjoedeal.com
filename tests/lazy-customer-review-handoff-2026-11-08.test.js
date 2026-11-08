#!/usr/bin/env node
/**
 * tests/lazy-customer-review-handoff-2026-11-08.test.js — the customer page's
 * "Job done" hand-off (qr-code.js + review-handoff.js) loads only for a lead
 * at Install Done or later (customer-page boot lane, 2026-11-08).
 *
 * Before: two deferred <script> tags on every customer page open. At boot the
 * only things either did were review-handoff.js's click listener and its 1.5 s
 * poll that unhides #jobDoneHandoffBtn for a job-done lead. After:
 * js/review-handoff-lazy.js runs that poll with the same stage rule and, when
 * the button shows (or on the first click), loads both files as the
 * `reviewhandoff` ScriptLoader bundle. Pins, with the REAL script-loader.js,
 * the REAL shim and the REAL qr-code.js / review-handoff.js run in a vm whose
 * <head> keeps every appended tag (as a browser does):
 *   - control: today's eager review-handoff.js shows the button on the first
 *     poll in this harness; the shim shows it on that same poll;
 *   - an early-stage lead: the button stays hidden and nothing is fetched;
 *   - the lead reaches Install Done on the page: the button shows on the next
 *     poll with the lead id, the bundle loads QR first, review-handoff.js takes
 *     the button over and the shim's poll stops;
 *   - a click before the files land opens the card when they land, once for a
 *     double tap; a click after they land is review-handoff.js's alone;
 *   - a failed fetch: the button hides again (a failed eager tag never showed
 *     it), a waiting click is told to reload, nothing throws, and nothing is
 *     fetched again (ScriptLoader keeps the failed tag until a reload);
 *   - no ScriptLoader / no button / no lead: nothing shows, nothing throws;
 *   - the shim's job-done rule is review-handoff.js's (same stages, same answers);
 *   - customer.html: one deferred shim tag after script-loader.js, neither file
 *     eager, the stylesheet and the button markup unchanged; Field's needs too.
 *
 * Run: node tests/lazy-customer-review-handoff-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const readMaybe = (p) => { try { return read(p); } catch (e) { return ''; } };
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const SHIM_PATH = 'docs/pro/js/review-handoff-lazy.js';
const SHIM = readMaybe(SHIM_PATH);
const LOADER = read('docs/pro/js/script-loader.js');
const HANDOFF = read('docs/pro/js/review-handoff.js');
const FILES = ['js/qr-code.js?v=1', 'js/review-handoff.js?v=1'];
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

// ── a customer page: real ScriptLoader, a <head> that keeps its tags, manual timers ──
function makePage(opts) {
  opts = opts || {};
  const head = [];
  const body = [];
  const listeners = {};
  const intervals = new Map();
  const toasts = [];
  const errors = [];
  const held = [];
  let network = opts.network || 'instant';
  let nextTimer = 1;
  const page = { head, body, listeners, intervals, toasts, errors, opens: 0 };
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, URL, setTimeout, clearTimeout };

  function makeEl(tag) {
    const attrs = Object.create(null);
    const classes = new Set();
    const e = {
      tagName: String(tag).toUpperCase(), hidden: false, parentNode: null, innerHTML: '', className: '', id: '',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) {
        if (k === 'src' && e.src !== undefined) return e.src;
        if (k === 'href' && e.href !== undefined) return e.href;
        return k in attrs ? attrs[k] : null;
      },
      hasAttribute(k) { return k in attrs; },
      removeAttribute(k) { delete attrs[k]; },
      // only `[attr]` selector lists are ever asked of the button / overlay
      closest(sel) { return sel.split(',').some((s) => { const m = /^\s*\[([a-z-]+)\]\s*$/.exec(s); return !!m && e.hasAttribute(m[1]); }) ? e : null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() { doc.activeElement = e; },
    };
    return e;
  }
  function runScript(el) {
    const src = String(el.src);
    if (opts.fail && opts.fail.test(src)) { if (el.onerror) el.onerror(); return; }
    const file = 'docs/pro/' + src.split('?')[0];
    try { vm.runInContext(read(file), ctx, { filename: file }); } catch (e) { errors.push(e); }
    if (el.onload) el.onload();
  }
  const headEl = {
    appendChild(el) {
      head.push(el); el.parentNode = headEl;
      if (el.tagName === 'SCRIPT') { if (network === 'held') held.push(el); else Promise.resolve().then(() => runScript(el)); }
      return el;
    },
  };
  const bodyEl = {
    appendChild(el) { body.push(el); el.parentNode = bodyEl; if (el.className === 'rh-overlay') page.opens++; return el; },
    removeChild(el) { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); el.parentNode = null; return el; },
  };
  const btn = opts.noButton ? null : makeEl('button');
  if (btn) { btn.id = 'jobDoneHandoffBtn'; btn.setAttribute('data-rh-open', ''); btn.hidden = true; }
  const doc = {
    baseURI: 'https://nbd.test/pro/customer.html',
    head: headEl, body: bodyEl, documentElement: makeEl('html'), activeElement: null,
    createElement: makeEl,
    getElementById: (id) => (btn && id === 'jobDoneHandoffBtn' ? btn : null),
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === 'script[src]') return head.filter((t) => t.tagName === 'SCRIPT');
      if (/^link\[rel="stylesheet"\]/.test(sel)) return head.filter((t) => t.tagName === 'LINK' && t.rel === 'stylesheet');
      return [];
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const l = listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
  };
  Object.assign(ctx, {
    document: doc,
    setInterval: (fn, ms) => { const id = nextTimer++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    showToast: (m, k) => toasts.push([m, k]),
  });
  ctx.window = ctx;
  if (opts.lead) { ctx._currentLead = opts.lead; ctx._customerId = opts.lead.id; }
  vm.createContext(ctx);
  if (!opts.noLoader) vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
  page.run = (code, name) => { try { vm.runInContext(code, ctx, { filename: name }); } catch (e) { errors.push(e); } };
  page.run(opts.eager ? HANDOFF : SHIM, opts.eager ? 'review-handoff.js' : 'review-handoff-lazy.js');
  page.ctx = ctx; page.btn = btn;
  page.tick = () => { try { Array.from(intervals.values()).forEach((t) => t.fn()); } catch (e) { errors.push(e); } };
  page.click = () => {
    const ev = { target: btn, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
    try { (listeners.click || []).slice().forEach((fn) => fn(ev)); } catch (e) { errors.push(e); }
    return ev;
  };
  page.release = () => { network = 'instant'; held.splice(0).forEach((el) => Promise.resolve().then(() => runScript(el))); };
  page.scripts = () => head.filter((t) => t.tagName === 'SCRIPT').map((t) => String(t.src));
  page.overlays = () => body.filter((el) => el.className === 'rh-overlay').length;
  return page;
}

(async () => {
  console.log('\nREVIEW HAND-OFF LAZY: the shim exists');
  ok('docs/pro/js/review-handoff-lazy.js exists', SHIM.length > 0);

  console.log('\nREVIEW HAND-OFF LAZY: same button, same poll');
  {
    const today = makePage({ lead: { id: 'L0', stage: 'install_complete' }, eager: true });
    today.tick();
    ok('control: today\'s eager review-handoff.js, in this harness, shows the button on the first poll', today.btn.hidden === false && today.btn.getAttribute('data-lead-id') === 'L0');
    const p = makePage({ lead: { id: 'L0', stage: 'install_complete' } });
    ok('the shim polls every 1.5 s, as review-handoff.js did', Array.from(p.intervals.values()).map((t) => t.ms).join() === '1500', Array.from(p.intervals.values()).map((t) => t.ms));
    ok('nothing is fetched at boot, before the first poll', p.scripts().length === 0, p.scripts());
    p.tick();
    ok('the shim shows the button on that same first poll, with the same lead id', p.btn.hidden === false && p.btn.getAttribute('data-lead-id') === 'L0');
    await flush();
  }

  console.log('\nREVIEW HAND-OFF LAZY: an early stage, then Install Done');
  {
    const p = makePage({ lead: { id: 'L1', stage: 'contract_signed' } });
    p.tick(); p.tick(); await flush();
    ok('an early-stage lead: the button stays hidden', p.btn.hidden === true);
    ok('...and neither file is fetched or run', p.scripts().length === 0 && !p.ctx.NBDReviewHandoff && !p.ctx.NBDQr, p.scripts());
    const B = p.ctx.ScriptLoader && p.ctx.ScriptLoader.bundles;
    ok('the reviewhandoff bundle is registered at runtime on the real ScriptLoader: QR first, same ?v=', !!B && (B.reviewhandoff || []).join() === FILES.join(), B && B.reviewhandoff);
    p.ctx._currentLead.stage = 'install_complete';   // customer-bootstrap.module.js writes a stage change in place
    p.tick();
    ok('the lead reaches Install Done: the next poll shows the button, with the lead id', p.btn.hidden === false && p.btn.getAttribute('data-lead-id') === 'L1');
    await flush();
    ok('...and loads the bundle once, QR first', p.scripts().join() === FILES.join(), p.scripts());
    ok('...both files ran', !!p.ctx.NBDQr && typeof p.ctx.NBDQr.svg === 'function' && !!p.ctx.NBDReviewHandoff && typeof p.ctx.NBDReviewHandoff.open === 'function');
    ok('...review-handoff.js owns the button now: the shim\'s poll stopped, the file\'s own poll runs', p.intervals.size === 1 && !p.intervals.has(1), Array.from(p.intervals.keys()));
    ok('...the button is still shown for the lead', p.btn.hidden === false && p.btn.getAttribute('data-lead-id') === 'L1');
    p.tick(); p.tick(); await flush();
    ok('later polls fetch nothing more', p.scripts().length === 2, p.scripts());
    p.ctx._currentLead.stage = 'new';
    p.tick();
    ok('the file\'s poll follows the stage (back to an early stage hides it)', p.btn.hidden === true);
    ok('no errors anywhere', p.errors.length === 0, p.errors.map(String));
  }

  console.log('\nREVIEW HAND-OFF LAZY: a click before the files land');
  {
    const p = makePage({ lead: { id: 'L2', stage: 'final_payment', firstName: 'Dana' }, network: 'held' });
    p.tick(); await flush();
    ok('a lead already job-done: the first poll shows the button and starts the fetch', p.btn.hidden === false && p.scripts().join() === FILES[0], p.scripts());
    const ev = p.click();
    p.click();   // a double tap
    ok('a click before the files land is taken; no card yet', ev.defaultPrevented === true && p.overlays() === 0 && p.opens === 0);
    p.release(); await flush();
    ok('...the card opens once the files land, once for a double tap', p.opens === 1 && p.overlays() === 1, p.opens);
    const card = p.body.find((el) => el.className === 'rh-overlay');
    ok('...for this lead', !!card && /Thank you, Dana!/.test(card.innerHTML), card && card.innerHTML.slice(0, 200));
    const ev2 = p.click(); await flush();
    ok('a click after they land is review-handoff.js\'s alone: one card per click', p.opens === 2 && p.overlays() === 1 && ev2.defaultPrevented === true, p.opens);
    ok('no errors anywhere', p.errors.length === 0, p.errors.map(String));
  }

  console.log('\nREVIEW HAND-OFF LAZY: a failed fetch');
  {
    const p = makePage({ lead: { id: 'L3', stage: 'closed' }, network: 'held', fail: /review-handoff\.js/ });
    p.tick();
    const ev = p.click();
    p.release(); await flush();
    ok('the failed tag stays in <head>, as in a browser', p.scripts().join() === FILES.join(), p.scripts());
    ok('the button hides again (a failed eager tag never showed it)', p.btn.hidden === true);
    ok('the waiting click is told the card did not load and to reload', ev.defaultPrevented === true && p.toasts.length === 1 && /did not load/i.test(p.toasts[0][0]) && /reload/i.test(p.toasts[0][0]) && p.toasts[0][1] === 'error', p.toasts);
    ok('no card, and nothing threw', p.overlays() === 0 && p.errors.length === 0, p.errors.map(String));
    ok('the shim\'s poll has stopped', p.intervals.size === 0, Array.from(p.intervals.keys()));
    p.tick(); p.tick(); p.click(); await flush();
    ok('it stays failed until a reload: later polls and clicks fetch nothing and keep the button hidden', p.scripts().length === 2 && p.btn.hidden === true && p.overlays() === 0, p.scripts());
    ok('...a later click is told to reload again (no silent dead button)', p.toasts.length === 2 && /reload/i.test(p.toasts[1][0]), p.toasts);
    ok('...still nothing threw', p.errors.length === 0, p.errors.map(String));
  }

  console.log('\nREVIEW HAND-OFF LAZY: nothing to do');
  {
    const p = makePage({ lead: { id: 'L4', stage: 'closed' }, noLoader: true });
    p.tick(); await flush();
    ok('no ScriptLoader on the page: the button stays hidden (nothing could open it), nothing fetched, nothing thrown', p.btn.hidden === true && p.scripts().length === 0 && p.errors.length === 0, p.errors.map(String));
    const q = makePage({ lead: { id: 'L5', stage: 'closed' }, noButton: true });
    q.tick(); await flush();
    ok('no #jobDoneHandoffBtn on the page: no poll, nothing fetched', q.intervals.size === 0 && q.scripts().length === 0 && q.errors.length === 0);
    const r = makePage({});
    r.tick(); await flush();
    ok('no lead loaded yet: the button stays hidden, nothing fetched', r.btn.hidden === true && r.scripts().length === 0 && r.errors.length === 0);
    const s = makePage({ lead: { id: 'L6', stage: 'closed', deleted: true } });
    s.tick(); await flush();
    ok('a deleted lead at a done stage: hidden, nothing fetched', s.btn.hidden === true && s.scripts().length === 0);
    const t = makePage({ lead: { id: 'L7', stage: 'install_scheduled' } });
    t.run(SHIM, 'again.js');
    ok('running the shim twice adds no second listener or poll (sentinel)', (t.listeners.click || []).length === 1 && t.intervals.size === 1, (t.listeners.click || []).length + ' / ' + t.intervals.size);
  }

  console.log('\nREVIEW HAND-OFF LAZY: the job-done rule is review-handoff.js\'s');
  {
    const H = require(path.join(ROOT, 'docs/pro/js/review-handoff.js'));
    const p = makePage({ noButton: true });
    const L = p.ctx.NBDReviewHandoffLazy;
    const lazyDone = L && typeof L.isJobDone === 'function' ? L.isJobDone : () => 'missing';
    const keys = (src) => { const m = /var DONE_STAGES = \{([\s\S]*?)\};/.exec(src); return m ? Array.from(m[1].matchAll(/'?([a-z_-]+)'?\s*:/g), (x) => x[1]).sort().join() : ''; };
    ok('the same stage list, word for word', keys(HANDOFF).split(',').length === 12 && keys(SHIM) === keys(HANDOFF), keys(SHIM) + ' vs ' + keys(HANDOFF));
    const stages = keys(HANDOFF).split(',').concat(['Install Complete', 'Final Photos', 'CLOSED', ' closed ', 'Closed Won', 'new', 'inspected', 'contract_signed', 'install_scheduled', 'estimate_sent_cash', 'custom_x', '', null]);
    // Dates whole seconds from the epoch: the shim runs in the vm's realm, so an outer-realm Date reaches it through
    // Date.parse(String(d)), which drops milliseconds (in a page there is one realm and instanceof Date holds).
    const times = [undefined, 0, 5, NaN, Infinity, '2026-01-01', 'not a date', { toMillis: () => 7 }, { toDate: () => new Date(9) }, { seconds: 3 }, { seconds: 0 }, new Date(Date.UTC(2026, 0, 1)), new Date(0)];
    const fixtures = [null, undefined, {}, { deleted: true, stage: 'closed' }, { _stageKey: 'final_payment', stage: 'new' }, { _stageKey: 'new', stage: 'closed' }];
    stages.forEach((s) => fixtures.push({ stage: s }));
    times.forEach((t) => { fixtures.push({ stage: 'custom_x', installCompletedAt: t }); fixtures.push({ stage: 'new', completedAt: t }); });
    const bad = fixtures.filter((f) => lazyDone(f) !== H.isJobDone(f));
    ok('the same answer for all ' + fixtures.length + ' fixtures (stages, case and spaces, Timestamps, dates, deleted)', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
    ok('control: the fixtures cover both answers', fixtures.some((f) => H.isJobDone(f) === true) && fixtures.some((f) => H.isJobDone(f) === false));
  }

  console.log('\nREVIEW HAND-OFF LAZY: customer.html');
  {
    const cust = read('docs/pro/customer.html');
    const html = cust.replace(/<!--[\s\S]*?-->/g, '');
    ok('the shim is one deferred external tag', (html.match(/<script defer src="js\/review-handoff-lazy\.js\?v=\d+"><\/script>/g) || []).length === 1);
    ok('...after the deferred script-loader.js it registers and loads through', html.indexOf('js/script-loader.js') > 0 && html.indexOf('js/review-handoff-lazy.js') > html.indexOf('js/script-loader.js'));
    const eager = ['qr-code', 'review-handoff'].filter((n) => new RegExp('<script[^>]*src="[^"]*js/' + n + '\\.js').test(html));
    ok('neither qr-code.js nor review-handoff.js is an eager tag any more', eager.length === 0, eager);
    ok('the stylesheet stays an eager link (it styles the hidden button at boot)', /<link rel="stylesheet" href="css\/review-handoff\.css\?v=1">/.test(html) && /#jobDoneHandoffBtn\[hidden\] \{ display: none; \}/.test(read('docs/pro/css/review-handoff.css')));
    ok('the button markup is unchanged: hidden, data-rh-open, no inline handler', /<button type="button" class="btn" id="jobDoneHandoffBtn" data-rh-open hidden title="[^"]+">\s*📱 Job done\s*<\/button>/.test(html));
    const LS = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
    const fn = LS.get('field') && LS.get('field').needs;
    ok('Field (the dashboard) still loads both files through its own needs, same paths and ?v=', !!fn && fn.script.join() === ['js/layouts/kit.js'].concat(FILES).join(), fn && fn.script);
    ok('script-loader.js is untouched: no hand-off bundle inside the blocking file', !/reviewhandoff|review-handoff|qr-code/.test(LOADER));
    ok('the shim has no inline handler and no style attribute', !!SHIM && !/\son[a-z]+=\s*["']|style=/i.test(SHIM.replace(/\/\/.*$/gm, '')));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-customer-review-handoff-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
