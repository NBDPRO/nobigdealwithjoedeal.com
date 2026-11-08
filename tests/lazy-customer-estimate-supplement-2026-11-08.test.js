/**
 * tests/lazy-customer-estimate-supplement-2026-11-08.test.js — the supplement
 * engine (docs/pro/js/estimate-supplement.js) leaves the customer page's boot
 * path and loads the first time a rep opens the supplement builder
 * (boot-weight lane, CW-estimate-supplement, 2026-11-08).
 *
 * Before: an eager <script defer> on customer.html, 46 KB readable / 26 KB
 * shipped, parsed on every customer card. Its only reader is supplement-ui.js,
 * and only after a "+ Supplement" click (openForEstimate); the buttons
 * themselves paint without it. After: supplement-ui.js asks ScriptLoader for
 * the engine on that click, then carries on. Pins:
 *   - the real script-loader.js + supplement-ui.js run in a vm with a fake
 *     page whose <head> keeps every appended tag (as a browser does): boot
 *     paints the button and fetches nothing; the click fetches the engine once
 *     and opens the modal when it lands, even for a click made before it landed;
 *   - a failed fetch leaves the card working (toast, no throw, buttons still
 *     paint), its dead tag is dropped, and the second click fetches the engine
 *     again (ScriptLoader removes a failed tag), with the same toast if that
 *     fails too;
 *   - money: the lazily loaded engine prices a supplement exactly as the
 *     required engine does (same totals, same rounding);
 *   - the engine has no load-time side effect but defining
 *     window.EstimateSupplement, and nothing else under docs/pro reads it;
 *   - customer.html has no eager engine tag, keeps supplement-ui.js and the
 *     claim-wording filter eager, and the lazy src is the estimates bundle's
 *     own entry (one cache key, one ?v), with script-loader.js untouched.
 *
 * Run: node tests/lazy-customer-estimate-supplement-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String((e && e.message) || e)); });

const LOADER = read('docs/pro/js/script-loader.js');
const UI = read('docs/pro/js/supplement-ui.js');
const ENGINE = read('docs/pro/js/estimate-supplement.js');
const ENGINE_PATH = '/pro/js/estimate-supplement.js';
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

// ── a fake customer page: a <head> that keeps appended tags, estimate rows ──
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), id: '', className: '', textContent: '', innerHTML: '', title: '', type: '',
    dataset: {}, style: {}, children: [], listeners: {}, parentNode: null, _q: {},
    addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    // The modal's controls: one stub per selector (the UI null-guards all but #nbd-sup-close).
    querySelector(sel) {
      if (sel === '.nbd-sup-trigger') return el.children.find((c) => c.className === 'nbd-sup-trigger') || (el._actions && el._actions.children.find((c) => c.className === 'nbd-sup-trigger')) || null;
      if (sel === '.nbd-est-actions') return el._actions || null;
      if (el.tagName === 'DIV' && el.id === 'nbd-supplement-modal') return (el._q[sel] = el._q[sel] || makeEl('button'));
      return null;
    },
    querySelectorAll() { return []; },
    getAttribute(n) { return n === 'src' ? el.src : (n === 'href' ? el.href : null); },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el); },
    focus() {},
  };
  return el;
}
function makeRow(estId) {
  const row = makeEl('div');
  row.className = 'nbd-est-row';
  row.dataset.estId = estId;
  row._actions = makeEl('div');
  return row;
}
function triggerOf(row) { return row._actions.children.find((c) => c.className === 'nbd-sup-trigger') || null; }

function makePage(opts) {
  opts = opts || {};
  const toasts = [], observers = [], appended = [];
  const rows = [makeRow('E1')];
  // The page's own eager tags this test cares about (the loader's tag scan sees them).
  const pageTags = ['js/script-loader.js?v=210', '/pro/js/claim-wording-filter.js?v=1', '/pro/js/supplement-ui.js?v=4']
    .map((s) => { const t = makeEl('script'); t.src = s; return t; });
  const head = makeEl('head');
  head.appendChild = (c) => { head.children.push(c); c.parentNode = head; appended.push(c); return c; };
  const body = makeEl('body');
  const document = {
    baseURI: 'https://nbd.test/pro/customer.html?id=L1', readyState: 'complete', head, body,
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === 'script[src]') return pageTags.concat(head.children.filter((c) => c.tagName === 'SCRIPT'));
      if (/nbd-est-row/.test(sel)) return rows.filter((r) => !r.dataset.supplementWired);
      return [];
    },
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    createElement: makeEl,
    addEventListener() {}, removeEventListener() {},
  };
  const timers = [];
  const w = {
    document, URL, console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    MutationObserver: function (cb) { observers.push(cb); this.observe = () => {}; this.disconnect = () => {}; },
    CustomEvent: function (t, init) { this.type = t; this.detail = init && init.detail; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    showToast: (msg, kind) => toasts.push([msg, kind]),
    _customerEstimates: [{ id: 'E1', leadId: 'L1', number: 'EST-7', grandTotal: 12000,
      rows: [{ code: 'RFG-SHGL', name: 'Shingles', unit: 'SQ', quantity: 20, materialCostPerUnit: 120, laborCostPerUnit: 80, lineTotal: 4000 }] }],
    _customerId: 'L1',
  };
  w.window = w;
  vm.createContext(w);
  if (opts.loader !== false) vm.runInContext(LOADER, w, { filename: 'script-loader.js' });
  vm.runInContext(UI, w, { filename: 'supplement-ui.js' });
  timers.splice(0).forEach((fn) => fn()); // readyState 'complete' → setTimeout(_bootstrap, 0)
  const engineTags = () => appended.filter((c) => c.tagName === 'SCRIPT' && String(c.src).split('?')[0].endsWith('estimate-supplement.js'));
  return {
    w, rows, toasts, observers, appended, engineTags,
    click(row) { const b = triggerOf(row); return b.listeners.click[0]({ stopPropagation() {} }); },
    land(tag) { vm.runInContext(ENGINE, w, { filename: 'estimate-supplement.js' }); tag.onload(); },
    modal: () => body.children.find((c) => c.id === 'nbd-supplement-modal') || null,
    modals: () => body.children.filter((c) => c.id === 'nbd-supplement-modal').length,
  };
}

(async function main() {
  console.log('\nBOOT: the button paints, the engine is not fetched');
  {
    const p = makePage();
    ok('the "+ Supplement" button is on the estimate row at boot', !!triggerOf(p.rows[0]) && triggerOf(p.rows[0]).textContent === '+ Supplement');
    ok('nothing is fetched at boot', p.appended.length === 0, p.appended.map((c) => c.src));
    ok('the engine is not on the page at boot', typeof p.w.EstimateSupplement === 'undefined');
  }

  console.log('\nCLICK: load, then open');
  {
    const p = makePage();
    p.click(p.rows[0]);
    const tags = p.engineTags();
    ok('the click asks ScriptLoader for the engine (one <script> appended)', tags.length === 1, p.appended.map((c) => c.src));
    ok('…by its resolved path under /pro/js/', tags.length === 1 && new URL(tags[0].src, p.w.document.baseURI).pathname === ENGINE_PATH, tags[0] && tags[0].src);
    p.click(p.rows[0]);
    ok('a second click before the file lands fetches nothing more (same pending load)', p.engineTags().length === 1, p.engineTags().length);
    await settle();
    ok('no modal while the file is still on its way', p.modal() === null);
    ok('no error toast while it is on its way', p.toasts.length === 0, JSON.stringify(p.toasts));
    if (tags[0]) p.land(tags[0]);
    await settle();
    const m = p.modal();
    ok('once the file lands, the click does its job: the supplement modal opens', !!m);
    ok('…once (the second click re-renders the same modal)', p.modals() === 1, p.modals());
    ok('…for the clicked estimate, version 1, priced from the parent total',
      !!m && /Supplement #1/.test(m.innerHTML) && /Insurance Supplement — EST-7/.test(m.innerHTML)
      && /Original: \$12,000 → Revised: \$12,000/.test(m.innerHTML), m && m.innerHTML.slice(0, 200));
    ok('no error toast on the happy path', p.toasts.length === 0, JSON.stringify(p.toasts));
    p.click(p.rows[0]);
    await settle();
    ok('a later click with the engine loaded fetches nothing', p.engineTags().length === 1, p.engineTags().length);

    // Money: the lazily loaded engine prices exactly as the required one.
    const lazy = p.w.EstimateSupplement;
    const req = require(path.join(ROOT, 'docs', 'pro', 'js', 'estimate-supplement.js'));
    const price = (E) => {
      const s = E.createSupplement(p.w._customerEstimates[0], { leadId: 'L1', parentEstimateId: 'E1', version: 1 });
      E.addItem(s, { code: 'RFG-DECK', name: 'Decking', unit: 'SH', quantity: 2, materialCost: 10, laborCost: 5 });
      E.modifyItemQuantity(s, 'RFG-SHGL', 22, 'Steep slope waste');
      return ['supplementMaterial', 'supplementLabor', 'supplementOhp', 'supplementSubtotal', 'supplementTotal', 'newGrandTotal', 'deltaPct'].map((k) => s[k]);
    };
    ok('the lazily loaded engine is the real one', !!lazy && typeof lazy.calculateDelta === 'function' && typeof lazy.createSupplement === 'function');
    const a = lazy ? price(lazy) : null, b = price(req);
    ok('money: lazily loaded and required engines give the same supplement totals', !!a && JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) + ' vs ' + JSON.stringify(b));
    ok('money: the totals are the known ones (material 260, labor 170, OH&P 99, total 600 after the $25 rounding, new grand total 12,600, +5%)',
      b[0] === 260 && b[1] === 170 && b[2] === 99 && b[4] === 600 && b[5] === 12600 && b[6] === 5, JSON.stringify(b));
  }

  console.log('\nFAILED FETCH: the card keeps working, and the next tap fetches again');
  {
    const p = makePage();
    p.click(p.rows[0]);
    const tags = p.engineTags();
    let threw = null;
    try { if (tags[0]) tags[0].onerror(); await settle(); } catch (e) { threw = e; }
    ok('no throw when the fetch fails', threw === null, threw && threw.message);
    ok('no modal', p.modal() === null);
    ok('the rep is told, with an error toast that says to tap again',
      p.toasts.length === 1 && p.toasts[0][1] === 'error' && /Could not load the supplement engine/.test(p.toasts[0][0]) && /tap \+ Supplement again/.test(p.toasts[0][0]), JSON.stringify(p.toasts));
    ok('the dead tag is gone from <head>', !!tags[0] && tags[0].parentNode.children.indexOf(tags[0]) === -1);
    p.click(p.rows[0]);
    await settle();
    const again = p.engineTags();   // every engine <script> ever appended: one per fetch
    ok('a second click fetches the engine again (ScriptLoader dropped the dead tag)', again.length === 2 && again[1] !== tags[0], again.length);
    if (again[1]) again[1].onerror();
    await settle();
    ok('…and a second failure gets the same toast, no modal', p.toasts.length === 2 && p.toasts[1][0] === p.toasts[0][0] && p.modal() === null, JSON.stringify(p.toasts));
    const row2 = makeRow('E2');
    p.rows.push(row2);
    p.observers.forEach((cb) => cb([]));
    ok('the rest of the card still works: a re-rendered estimate row still gets its button', !!triggerOf(row2));
  }

  console.log('\nNO SCRIPTLOADER on the page');
  {
    const p = makePage({ loader: false });
    let threw = null;
    try { p.click(p.rows[0]); await settle(); } catch (e) { threw = e; }
    ok('the click does not throw', threw === null, threw && threw.message);
    ok('it toasts the same message and opens nothing', p.toasts.length === 1 && /Could not load the supplement engine/.test(p.toasts[0][0]) && p.modal() === null, JSON.stringify(p.toasts));
  }

  console.log('\nTHE ENGINE: safe to load late, one reader');
  {
    const gets = [], sets = [];
    const target = {};
    const win = new Proxy(target, {
      get(t, k) { if (typeof k === 'string') gets.push(k); return t[k]; },
      set(t, k, v) { sets.push(k); t[k] = v; return true; },
    });
    const ctx = { window: win, console: { log() {} } };
    vm.createContext(ctx);
    vm.runInContext(ENGINE, ctx, { filename: 'estimate-supplement.js' });
    ok('at load it only defines window.EstimateSupplement (no DOM, no listeners, no totals computed)', sets.join() === 'EstimateSupplement' && gets.length === 0, 'sets ' + sets.join() + ' / gets ' + gets.join());

    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');
    const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(m?js|html)$/.test(e.name)) out.push(f); } return out; };
    const readers = walk(path.join(ROOT, 'docs', 'pro'), [])
      .filter((f) => /\bEstimateSupplement\b/.test(strip(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    ok('under docs/pro only supplement-ui.js reads window.EstimateSupplement (and the engine defines it)',
      readers.sort().join() === ['docs/pro/js/estimate-supplement.js', 'docs/pro/js/supplement-ui.js'].join(), readers.join(', '));
  }

  console.log('\nTHE PAGES and the loader');
  {
    const cust = read('docs/pro/customer.html').replace(/<!--[\s\S]*?-->/g, '');
    ok('customer.html has no eager estimate-supplement.js tag', !/<script\b[^>]*\bsrc="[^"]*estimate-supplement\.js/.test(cust));
    const iL = cust.search(/<script defer src="js\/script-loader\.js\?v=\d+"><\/script>/);
    const iF = cust.search(/<script defer src="\/pro\/js\/claim-wording-filter\.js\?v=\d+"><\/script>/);
    const iU = cust.search(/<script defer src="\/pro\/js\/supplement-ui\.js\?v=\d+"><\/script>/);
    ok('supplement-ui.js is still an eager deferred tag (it paints the buttons), after script-loader.js', iU > 0 && iL > 0 && iL < iU);
    ok('the claim-wording filter stays eager (the letter refuses to build without it; the engine only arrives on a click)', iF > 0);
    const dash = read('docs/pro/dashboard.html').replace(/<!--[\s\S]*?-->/g, '');
    ok('control: dashboard.html has no eager engine tag either (it rides the estimates bundle there)', !/<script\b[^>]*\bsrc="[^"]*estimate-supplement\.js/.test(dash));

    const m = /ScriptLoader\.load\('([^']*estimate-supplement\.js[^']*)'\)/.exec(UI);
    const ctx = { window: { addEventListener() {} }, document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), head: { appendChild() {} }, baseURI: 'https://x.test/pro/customer.html' }, console, setTimeout, URL };
    ctx.window.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
    const B = ctx.window.ScriptLoader.bundles;
    const est = B.estimates || [];
    ok('supplement-ui.js loads the engine by the estimates bundle\'s own entry (one cache key, one ?v)', !!m && est.indexOf(m[1]) >= 0, m && m[1]);
    const base = est.map((s) => String(s).split('?')[0]);
    const iCw = base.indexOf('js/claim-wording-filter.js'), iEn = base.indexOf('js/estimate-supplement.js'), iUi = base.indexOf('js/supplement-ui.js');
    ok('the estimates bundle (the dashboard path) still runs filter → engine → UI', iCw >= 0 && iCw < iEn && iEn < iUi, base.join(', '));
    ok('script-loader.js gains no supplement bundle (it is at its byte ceiling)', Object.keys(B).every((k) => !/supplement/i.test(k)));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-customer-estimate-supplement-2026-11-08.test.js"') >= 0);
  }

  ok('no unhandled promise rejection anywhere above', unhandled.length === 0, unhandled.join(' | '));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ the suite crashed: ' + (e && e.stack || e)); process.exit(1); });
