/**
 * tests/lazy-customer-numbers-logic-2026-11-08.test.js — numbers-logic.js
 * leaves the customer page's boot path (boot-weight lane, batch 4b,
 * 2026-11-08).
 *
 * Before: an eager <script defer> on every customer card (~36 KB raw). Its
 * only readers on customer.html:
 *   - customer-numbers.js, the Numbers panel: it shows only for a sale, a loss
 *     or a storm-tagged lead, and an open lead (most cards) paints nothing;
 *   - lost-reason-picker.js, opened from that panel's "Pick a reason" button
 *     (a lost lead already lost: the customer page has no move-to-Lost —
 *     progressStage skips every lost-role stage);
 *   - stage-write.js's sale test, which has its own by-hand fallback with the
 *     same rule (window.stageRole is set on this page).
 * After: customer-numbers.js decides with a copy of the sale / lost test and
 * fetches numbers-logic.js (ScriptLoader.load) only for a lead the panel
 * shows; the "Pick a reason" button waits for the rules before the picker.
 *
 * Pins, with the REAL script-loader.js in a vm and a fake <head> that lists
 * the tags appended to it and lets a tag remove() itself, as a browser does:
 *   - nothing is fetched at boot for an open lead (or before a lead loads);
 *   - a sale / lost / storm lead fetches the rules once, and the panel paints
 *     when they land (renders before then wait, with no second fetch);
 *   - "Pick a reason" tapped before the rules land waits, then opens the picker;
 *   - a failed fetch throws nothing and says so (panel line, picker toast);
 *     ScriptLoader drops the dead tag, so the next tap fetches again and works;
 *   - no ScriptLoader on the page throws nothing;
 *   - the copied sale / lost test matches numbers-logic.js on every case;
 *   - customer.html no longer tags numbers-logic.js; the dashboard (whose
 *     Win Rate widget and KPI row read it at boot) and leaderboard keep theirs.
 *
 * Run: node tests/lazy-customer-numbers-logic-2026-11-08.test.js
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

const CN = read('docs/pro/js/customer-numbers.js');
const RULES = read('docs/pro/js/numbers-logic.js');
const LOADER = read('docs/pro/js/script-loader.js');
const CUSTOMER = read('docs/pro/customer.html');
const DASHBOARD = read('docs/pro/dashboard.html');
const LEADERBOARD = read('docs/pro/leaderboard.html');
const N = require(path.join(ROOT, 'docs/pro/js/numbers-logic.js'));
const flush = () => new Promise((r) => setImmediate(r));

// A customer page: window IS the global, <head> lists appended tags until one
// remove()s itself, #numbersPanel is a host whose innerHTML the panel writes.
function makePage(opts) {
  opts = opts || {};
  const head = [], appended = [], intervals = [], toasts = [], prompts = [], listeners = {};
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(), attrs: {}, parentNode: null,
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute(n, v) { this.attrs[n] = String(v); },
      getAttribute(n) {
        if (n === 'src') return this.src == null ? null : this.src;
        if (n === 'href') return this.href == null ? null : this.href;
        return n in this.attrs ? this.attrs[n] : null;
      },
      addEventListener() {},
    };
  }
  const classes = new Set();
  const host = {
    id: 'numbersPanel', innerHTML: '',
    classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } },
  };
  const document = {
    readyState: 'complete',
    baseURI: 'https://x.test/pro/customer.html',
    head: {
      appendChild(e) { head.push(e); appended.push(e); e.parentNode = document.head; return e; },
      removeChild(e) { const i = head.indexOf(e); if (i >= 0) head.splice(i, 1); e.parentNode = null; return e; },
    },
    createElement: el,
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === 'script[src]') return head.filter((e) => e.tagName === 'SCRIPT' && e.src);
      if (sel === 'link[rel="stylesheet"][href]') return head.filter((e) => e.tagName === 'LINK' && e.rel === 'stylesheet' && e.href);
      return [];
    },
    getElementById: (id) => (id === 'numbersPanel' ? host : null),
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };
  const ctx = {
    document, URL, Promise,
    console: { log() {}, info() {}, error() {}, warn() {} },
    setTimeout(fn) { return 0; },
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    addEventListener() {},
    showToast(m, k) { toasts.push([k, m]); },
    stageRole: opts.stageRole,
    _customerId: 'lead-1',
    _currentLead: opts.lead || null,
    NBDLostReason: {
      prompt(l) { prompts.push({ lead: l, rulesThere: !!ctx.NBDNumbers }); return Promise.resolve(false); },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const page = {
    ctx, head, appended, intervals, toasts, prompts, host, classes,
    run(src, name) { vm.runInContext(src, ctx, { filename: name }); },
    rulesTags() { return head.filter((e) => e.tagName === 'SCRIPT' && /numbers-logic\.js/.test(String(e.src))); },
    rulesFetches() { return appended.filter((e) => /numbers-logic\.js/.test(String(e.src))); },
    // The panel's first-paint poll: one tick sees the lead and renders.
    tick() { intervals.slice().forEach((fn) => fn()); },
    tap(cn) {
      const b = { dataset: { cn }, closest(sel) { return sel === '#numbersPanel [data-cn]' || sel === '#numbersPanel' ? b : null; } };
      return Promise.all((listeners.click || []).map((fn) => fn({ target: b })));
    },
    land(tag) { page.run(RULES, 'numbers-logic.js'); tag.onload(); },
  };
  if (opts.loader !== false) page.run(LOADER, 'script-loader.js');
  return page;
}
function boot(opts) {
  const page = makePage(opts);
  let threw = null;
  try { page.run(CN, 'customer-numbers.js'); } catch (e) { threw = e; }
  page.threw = threw;
  return page;
}

const OPEN = { id: 'lead-1', firstName: 'Ann', stage: 'inspected' };
const WON = { id: 'lead-1', firstName: 'Ann', stage: 'closed', jobValue: 15000 };
const LOST = { id: 'lead-1', firstName: 'Ann', stage: 'lost' };

(async function main() {
  console.log('\nNUMBERS RULES: nothing at boot for an open lead');
  {
    const p = boot({ lead: OPEN });
    ok('customer-numbers.js runs on the real script-loader.js without throwing', !p.threw, p.threw && p.threw.message);
    p.tick(); await flush();
    ok('an open lead fetches nothing (no numbers-logic.js tag)', p.rulesFetches().length === 0, p.appended.map((e) => e.src).join(', '));
    ok('and the panel stays empty, as before', p.host.innerHTML === '' && !p.classes.has('panel'), p.host.innerHTML);
  }
  {
    const p = boot({ lead: null });
    p.tick(); await flush();
    ok('before a lead loads, nothing is fetched either', p.rulesFetches().length === 0);
  }

  console.log('\nNUMBERS RULES: a won lead');
  {
    const p = boot({ lead: WON });
    p.tick(); await flush();
    const tags = p.rulesTags();
    ok('a sale fetches numbers-logic.js: one tag', tags.length === 1, p.appended.map((e) => e.src).join(', '));
    ok('the tag is the same file and ?v= the page used to carry', tags[0] && /^js\/numbers-logic\.js\?v=\d+$/.test(tags[0].src), tags[0] && tags[0].src);
    ok('nothing paints before the rules land', p.host.innerHTML === '');
    try { p.ctx.NBDCustomerNumbers.render(); } catch (e) { /* reported by the count below */ }
    await flush();
    ok('a second render while loading does not fetch again', p.rulesFetches().length === 1, p.rulesFetches().length);
    if (tags[0]) p.land(tags[0]);
    await flush(); await flush();
    ok('once the rules land, the panel paints the sold-package picker', /data-cn="tier"/.test(p.host.innerHTML) && p.classes.has('panel'), p.host.innerHTML.slice(0, 200));
    ok('no error toast on the happy path', !p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
    p.ctx.NBDCustomerNumbers.render();
    await flush();
    ok('a later render paints at once, with no second fetch', /data-cn="tier"/.test(p.host.innerHTML) && p.rulesFetches().length === 1);
  }
  {
    const p = boot({ lead: Object.assign({}, OPEN, { stormId: 'storm-2026-05-01', stormPlace: 'Hamilton' }) });
    p.tick(); await flush();
    const tags = p.rulesTags();
    ok('a storm-tagged open lead fetches the rules too (the panel shows the storm)', tags.length === 1);
    if (tags[0]) p.land(tags[0]);
    await flush(); await flush();
    ok('...and paints the storm row', /Storm/.test(p.host.innerHTML) && /Hamilton/.test(p.host.innerHTML), p.host.innerHTML.slice(0, 200));
  }

  console.log('\nNUMBERS RULES: "Pick a reason" before the rules land');
  {
    const p = boot({ lead: LOST });
    let threw = null, r = null;
    try { r = p.tap('lost'); } catch (e) { threw = e; }
    await flush();
    const tags = p.rulesTags();
    ok('the tap fetches the rules (one tag; the panel render shares it)', tags.length === 1, p.rulesFetches().length);
    ok('the picker does not open before they land', p.prompts.length === 0);
    p.tick(); await flush();
    ok('the panel render while the tap waits adds no second fetch', p.rulesFetches().length === 1, p.rulesFetches().length);
    if (tags[0]) p.land(tags[0]);
    try { await r; } catch (e) { threw = e; }
    await flush(); await flush();
    ok('once they land, the same tap opens the picker, with the rules there', p.prompts.length === 1 && p.prompts[0].rulesThere === true, JSON.stringify(p.prompts));
    ok('nothing threw', !threw, threw && threw.message);
    ok('the panel paints the lost row', /Pick a reason/.test(p.host.innerHTML), p.host.innerHTML.slice(0, 200));
  }

  console.log('\nNUMBERS RULES: a failed fetch');
  {
    const p = boot({ lead: WON });
    let threw = null;
    try { p.tick(); } catch (e) { threw = e; }
    await flush();
    const tags = p.rulesTags();
    if (tags[0]) tags[0].onerror();
    await flush(); await flush();
    ok('the failed fetch throws nothing', !threw, threw && threw.message);
    ok('the panel says so, asking for a tap (not a refresh)',
      /check your connection/i.test(p.host.innerHTML) && /tap again/i.test(p.host.innerHTML) && !/refresh|reload/i.test(p.host.innerHTML) && /data-cn="retry"/.test(p.host.innerHTML),
      p.host.innerHTML);
    ok('ScriptLoader drops the dead tag from <head>', !!tags[0] && p.rulesTags().length === 0 && tags[0].parentNode === null);
    let threw2 = null, r2 = null;
    try { r2 = p.tap('retry'); } catch (e) { threw2 = e; }
    await flush();
    const again = p.rulesFetches();
    ok('the tap fetches again: a second, new tag', again.length === 2 && again[1] !== tags[0], again.length);
    if (again[1]) p.land(again[1]);
    try { await r2; } catch (e) { threw2 = e; }
    await flush(); await flush();
    ok('...and when it lands the panel paints', !threw2 && /data-cn="tier"/.test(p.host.innerHTML), p.host.innerHTML.slice(0, 200));
  }
  {
    const p = boot({ lead: LOST });
    let threw = null, r = null;
    try { r = p.tap('lost'); } catch (e) { threw = e; }
    await flush();
    const tags = p.rulesTags();
    if (tags[0]) tags[0].onerror();
    try { await r; } catch (e) { threw = e; }
    await flush(); await flush();
    ok('"Pick a reason" with a failed fetch throws nothing and opens no picker', !threw && p.prompts.length === 0, threw && threw.message);
    ok('the rep is told, in the house wording', p.toasts.some((t) => t[0] === 'error' && /^Could not load the .+ — check your connection and tap again/.test(t[1])), JSON.stringify(p.toasts));
    p.toasts.length = 0;
    let r2 = null;
    try { r2 = p.tap('lost'); } catch (e) { threw = e; }
    await flush();
    const again = p.rulesFetches();
    ok('the next tap fetches again', again.length === 2 && p.rulesTags().length === 1, again.length);
    if (p.rulesTags()[0]) p.land(p.rulesTags()[0]);
    try { await r2; } catch (e) { threw = e; }
    await flush(); await flush();
    ok('...and opens the picker, with no error toast', !threw && p.prompts.length === 1 && !p.toasts.some((t) => t[0] === 'error'), JSON.stringify({ prompts: p.prompts.length, toasts: p.toasts }));
  }

  console.log('\nNUMBERS RULES: no ScriptLoader on the page');
  {
    const p = boot({ lead: WON, loader: false });
    let threw = p.threw;
    try { p.tick(); } catch (e) { threw = e; }
    await flush();
    ok('a won lead throws nothing; the panel stays empty', !threw && p.host.innerHTML === '', (threw && threw.message) || p.host.innerHTML);
    let r = null;
    try { r = p.tap('lost'); await r; } catch (e) { threw = e; }
    await flush();
    ok('"Pick a reason" throws nothing, opens no picker and says why', !threw && p.prompts.length === 0 && p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
  }

  console.log('\nNUMBERS RULES: the copied sale / lost test');
  {
    const p = boot({ lead: null });
    const mayShow = p.ctx.NBDCustomerNumbers && p.ctx.NBDCustomerNumbers.mayShow;
    ok('customer-numbers.js exposes mayShow', typeof mayShow === 'function');
    const stages = [''].concat(N.WON_KEYS, N.JOB_KEYS, ['contract_signed', 'lost', 'new', 'contacted', 'inspected', 'estimate_submitted', 'negotiating',
      'claim_filed', 'my_custom_stage', 'Custom Stage', 'Contract Signed', 'contract-signed'], Object.keys({
      'new': 1, 'new lead': 1, 'inspected': 1, 'estimate sent': 1, 'approved': 1, 'in progress': 1, 'complete': 1, 'lost': 1,
      'contacted': 1, 'negotiating': 1, 'closed won': 1, 'closed lost': 1, 'won': 1, 'closed_won': 1, 'closed-won': 1 }),
      ['New', 'Complete', 'Lost', 'Approved', 'Closed Won', 'In Progress', '  closed  ']);
    const roles = [undefined, 'new', 'active', 'job', 'won', 'lost', 'bogus'];
    const fns = [undefined, (k) => (k === 'my_custom_stage' ? 'won' : k === 'custom_stage' ? 'lost' : N.roleOf({ stage: k }, () => null)), () => 'nonsense', () => { throw new Error('x'); }];
    const bad = [];
    let n = 0;
    if (typeof mayShow === 'function') {
      fns.forEach((fn, fi) => {
        p.ctx.stageRole = fn;
        stages.forEach((s) => roles.forEach((r) => [false, true].forEach((storm) => [false, true].forEach((under) => {
          const l = { stage: s };
          if (r !== undefined) { if (under) l._stageRole = r; else l.stageRole = r; }
          if (under) l._stageKey = s;
          if (storm) l.stormId = 'storm-2026-05-01';
          const want = !!(N.isSale(l, fn) || N.isLostLead(l, fn) || l.stormId);
          let got;
          try { got = mayShow(l); } catch (e) { got = 'threw ' + e.message; }
          n++;
          if (got !== want) bad.push(JSON.stringify(l) + ' fn' + fi + ' want ' + want + ' got ' + got);
        }))));
      });
      ok('mayShow(lead) === isSale || isLostLead || stormId on all ' + n + ' cases', bad.length === 0, bad.slice(0, 3).join(' | '));
      ok('mayShow(null) is false', mayShow(null) === false);
    }
    const wanted = /var WON_KEYS = (\[[^\]]+\]);/.exec(RULES), have = /const WON_KEYS = (\[[^\]]+\]);/.exec(CN);
    ok('the copied WON_KEYS list is numbers-logic.js\'s, word for word', !!wanted && !!have && wanted[1] === have[1]);
    const wj = /var JOB_KEYS = (\[[^\]]+\]);/.exec(RULES), hj = /const JOB_KEYS = (\[[^\]]+\]);/.exec(CN);
    ok('the copied JOB_KEYS list is numbers-logic.js\'s, word for word', !!wj && !!hj && wj[1] === hj[1]);
  }

  console.log('\nNUMBERS RULES: the pages');
  {
    ok('customer.html has no eager numbers-logic.js tag', !/<script[^>]*src="[^"]*numbers-logic\.js/.test(CUSTOMER));
    ok('customer.html keeps customer-numbers.js (the panel) and the picker deferred',
      /<script defer src="js\/customer-numbers\.js\?v=\d+"><\/script>/.test(CUSTOMER) && /<script defer src="js\/lost-reason-picker\.js\?v=\d+"><\/script>/.test(CUSTOMER));
    ok('customer-numbers.js comes after script-loader.js', CUSTOMER.indexOf('src="js/customer-numbers.js') > CUSTOMER.indexOf('src="js/script-loader.js') && CUSTOMER.indexOf('src="js/script-loader.js') > 0);
    ok('the #numbersPanel mount is unchanged', /<div id="numbersPanel" class="mb-md"><\/div>/.test(CUSTOMER));
    ok('customer-numbers.js asks for the same file the dashboard tags (one cache key)', (() => {
      const m = /<script defer src="(js\/numbers-logic\.js\?v=\d+)"><\/script>/.exec(DASHBOARD);
      return !!m && CN.indexOf("'" + m[1] + "'") !== -1;
    })());
    ok('dashboard.html keeps its eager tag (Win Rate widget, KPI row and kanban read it at boot)', /<script defer src="js\/numbers-logic\.js\?v=\d+"><\/script>/.test(DASHBOARD));
    ok('leaderboard.html keeps its eager tag (out of scope)', /<script defer src="js\/numbers-logic\.js\?v=\d+"><\/script>/.test(LEADERBOARD));
    ok('script-loader.js gains no numbers bundle (blocking budget)', !/['"]js\/numbers-logic\.js/.test(LOADER));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
