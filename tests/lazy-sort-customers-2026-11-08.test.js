/**
 * tests/lazy-sort-customers-2026-11-08.test.js — "Sort my customers"
 * (sort-customers.js) loads on the first Pipeline render instead of on every
 * dashboard boot (boot-weight lane, 2026-11-08).
 *
 * Before: an eager <script defer> on every boot whose only boot work was a
 * refresh() that found no #sortCustomersWrap and returned: the banner's mount
 * lives in the Pipeline <template> (tpl-view-crm), cloned in on the first
 * goTo('crm'), and the app boots into Home. After: renderLeads
 * (crm-pipeline.js) registers the `sortcustomers` ScriptLoader bundle at
 * runtime and loads it the first time it renders with the mount in the page.
 * Pins:
 *   - the REAL renderLeads, in a vm: nothing is fetched while the mount is
 *     absent (boot on Home); once it exists the bundle is registered and
 *     loaded, and the banner is refreshed when the file lands; after that
 *     refresh() runs straight away and nothing more is fetched; no loader, a
 *     throwing or rejecting loadBundle, a failed fetch or a throwing refresh
 *     never break the render (the board keeps working, just without banner);
 *   - on the REAL script-loader.js the bundle fetches js/sort-customers.js
 *     (which exists), once, and script-loader.js itself does not carry it
 *     (a blocking script at its byte ceiling);
 *   - sort-customers.js paints the banner as soon as it runs when the mount
 *     is there (so arriving late still shows it), and running it twice keeps
 *     one copy (sentinel);
 *   - dashboard.html: no eager tag; the mount is only inside tpl-view-crm;
 *     Home is the boot view; crm-pipeline.js loads after script-loader.js;
 *     triage-deck.js (the "One at a time" deck) and the stylesheet stay.
 *
 * Run: node tests/lazy-sort-customers-2026-11-08.test.js
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
const tick = () => new Promise((r) => setImmediate(r));
const unhandled = [];
process.on('unhandledRejection', (r) => { unhandled.push(r); });

const PIPE = read('docs/pro/js/crm-pipeline.js');
const SC = read('docs/pro/js/sort-customers.js');
const LOADER = read('docs/pro/js/script-loader.js');

// ── the real crm-pipeline.js in a vm, with a fake page ──────────────────────
// opts.loader: 'fake' (default) | 'none' | 'real' (the real script-loader.js)
function page(opts) {
  opts = opts || {};
  const st = { loads: [], refreshes: 0, warns: [], appended: [], mounted: !!opts.mounted };
  const wrap = { id: 'sortCustomersWrap', hidden: true, innerHTML: '' };
  const el = (tag) => ({ tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [] });
  const document = {
    baseURI: 'https://x.test/pro/dashboard.html',
    getElementById: (id) => (id === 'sortCustomersWrap' && st.mounted ? wrap : null),
    querySelector: () => null, querySelectorAll: () => [], createElement: el, addEventListener() {},
    body: el('body'), head: { appendChild(n) { st.appended.push(n); } },
  };
  const w = { document, addEventListener() {}, _leads: [], NBDTodayPlan: { followUpDue: () => false } };
  w.window = w;
  const sc = () => ({ refresh() { st.refreshes++; if (opts.refreshThrows) throw new Error('paint failed'); } });
  if (!opts.loader || opts.loader === 'fake') {
    w.ScriptLoader = {
      bundles: opts.bundles || {},
      loadBundle(name) {
        st.loads.push(name);
        if (opts.throwSync) throw new Error('loader blew up');
        if (opts.reject) return Promise.reject(new Error('network'));
        if (opts.arrive !== false) w.NBDSortCustomers = sc();
        return Promise.resolve();
      },
    };
  }
  const con = { log() {}, info() {}, debug() {}, group() {}, groupEnd() {}, warn: (...a) => st.warns.push(a.map(String).join(' ')), error: (...a) => st.warns.push(a.map(String).join(' ')) };
  const ctx = { window: w, document, console: con, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    debounce: (f) => f, setTimeout, clearTimeout, Promise, URL };
  vm.createContext(ctx);
  if (opts.loader === 'real') vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
  vm.runInContext(PIPE, ctx, { filename: 'crm-pipeline.js' });
  st.w = w; st.wrap = wrap; st.sc = sc;
  st.render = () => vm.runInContext('renderLeads([], undefined)', ctx);
  return st;
}
function renders(st) { try { st.render(); return true; } catch (e) { return e; } }

(async function main() {
  console.log('\nLAZY SORT CUSTOMERS: the trigger in the real renderLeads');
  {
    const st = page({ mounted: false });
    ok('control: the real renderLeads runs to its end in the vm', renders(st) === true, renders(st));
    ok('boot on Home (no #sortCustomersWrap yet): renderLeads fetches nothing', st.loads.length === 0, st.loads);
    ok('...and registers nothing on the boot path', !st.w.ScriptLoader.bundles.sortcustomers, JSON.stringify(st.w.ScriptLoader.bundles));
    st.mounted = true; // goTo('crm') hydrated the Pipeline template
    st.render();
    ok('the first render with the mount registers the sortcustomers bundle on window.ScriptLoader', Array.isArray(st.w.ScriptLoader.bundles.sortcustomers), JSON.stringify(st.w.ScriptLoader.bundles));
    const list = st.w.ScriptLoader.bundles.sortcustomers || [];
    ok('the bundle is exactly js/sort-customers.js?v=N', list.length === 1 && /^js\/sort-customers\.js\?v=\d+$/.test(list[0]), list);
    ok('the bundle file exists', !!list[0] && fs.existsSync(path.join(ROOT, 'docs/pro', list[0].split('?')[0])), list[0]);
    ok('...and loads it', st.loads.join() === 'sortcustomers', st.loads);
    await tick();
    ok('when the file lands, the banner is refreshed once (paints on the first Pipeline open)', st.refreshes === 1, st.refreshes);
    st.render();
    ok('later renders call refresh() straight away', st.refreshes === 2, st.refreshes);
    ok('...and fetch nothing more', st.loads.length === 1, st.loads);
    ok('no warning on the happy path', st.warns.length === 0, st.warns);
  }
  {
    const st = page({ mounted: true, bundles: { sortcustomers: ['js/sort-customers.js?v=999'] } });
    st.render();
    ok('a bundle already registered is not overwritten (registered once)', st.w.ScriptLoader.bundles.sortcustomers.join() === 'js/sort-customers.js?v=999', st.w.ScriptLoader.bundles.sortcustomers);
  }
  {
    const st = page({ mounted: true, loader: 'none' });
    ok('no ScriptLoader on the page: the render completes and nothing throws', renders(st) === true, renders(st));
  }
  {
    const st = page({ mounted: true, throwSync: true });
    const r = renders(st);
    ok('a loadBundle that throws: the render still completes (the board keeps working)', r === true, r);
    ok('...and says so in the console', st.warns.some((m) => /sort-customers/.test(m)), st.warns);
  }
  {
    const before = unhandled.length;
    const st = page({ mounted: true, reject: true });
    const r = renders(st);
    await tick(); await tick();
    ok('a loadBundle that rejects: the render completes and no rejection goes unhandled', r === true && unhandled.length === before, unhandled.slice(before).map(String));
  }
  {
    const st = page({ mounted: true, arrive: false });
    const r = renders(st);
    await tick();
    ok('a failed fetch (resolved, no NBDSortCustomers): nothing throws, nothing is refreshed', r === true && st.refreshes === 0, st.refreshes);
    st.render();
    ok('...and the next render asks the loader again (it answers at once after a failure)', st.loads.length === 2, st.loads);
  }
  {
    const before = unhandled.length;
    const st = page({ mounted: true, refreshThrows: true });
    const r = renders(st);
    await tick(); await tick();
    ok('a refresh that throws once the file lands: caught, nothing unhandled', r === true && st.refreshes === 1 && unhandled.length === before, unhandled.slice(before).map(String));
    const r2 = renders(st);
    ok('...and a later direct refresh that throws is caught too', r2 === true && st.refreshes === 2, r2);
  }

  console.log('\nLAZY SORT CUSTOMERS: the bundle on the real script-loader.js');
  {
    const st = page({ mounted: false, loader: 'real' });
    const SL = st.w.ScriptLoader;
    ok('control: the real loader ran in the vm', !!SL && typeof SL.loadBundle === 'function' && !!SL.bundles);
    ok('control: script-loader.js itself does not carry sortcustomers (it is a blocking script at its byte ceiling)', !SL.bundles.sortcustomers);
    const before = Object.keys(SL.bundles).length;
    st.render();
    ok('boot on Home: no bundle registered, nothing appended to <head>', Object.keys(SL.bundles).length === before && st.appended.length === 0, st.appended.map((n) => n.src || n.href));
    st.mounted = true;
    st.render();
    st.render(); // a second render before the file has landed
    await tick(); await tick();
    ok('crm-pipeline.js registers exactly one bundle on the real ScriptLoader', Object.keys(SL.bundles).length === before + 1 && !!SL.bundles.sortcustomers);
    const scripts = st.appended.filter((n) => n.tagName === 'SCRIPT');
    ok('the real loader appends ONE <script> for js/sort-customers.js, in order (async=false), for two renders', scripts.length === 1 && /^js\/sort-customers\.js\?v=\d+$/.test(scripts[0].src) && scripts[0].async === false,
      scripts.map((n) => n.src + ' async=' + n.async));
    // The file runs (its own refresh() paints), then the tag's onload resolves the bundle.
    st.w.NBDSortCustomers = st.sc();
    if (scripts[0] && typeof scripts[0].onload === 'function') scripts[0].onload();
    await tick(); await tick();
    ok('once the file has run, the bundle resolves and the banner is refreshed', st.refreshes >= 1, st.refreshes);
    ok('the loader counts the bundle loaded', SL.isLoaded('sortcustomers') === true);
  }

  console.log('\nLAZY SORT CUSTOMERS: sort-customers.js arriving after the mount');
  {
    const wrap = { id: 'sortCustomersWrap', hidden: true, innerHTML: '' };
    const docListeners = {};
    const document = {
      getElementById: (id) => (id === 'sortCustomersWrap' ? wrap : null),
      addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
      querySelector: () => null, body: { appendChild() {} }, createElement: () => ({}),
    };
    const winListeners = {};
    const w = {
      document, _user: { uid: 'u1' }, _userClaims: { role: 'owner' },
      _leads: [{ id: 'a', userId: 'u1', firstName: 'Pat', stage: 'new' }, { id: 'b', userId: 'u1', jobType: 'cash' }],
      addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    };
    w.window = w;
    const ctx = { window: w, document, console };
    vm.createContext(ctx);
    vm.runInContext(SC, ctx, { filename: 'sort-customers.js' });
    ok('it paints the banner as soon as it runs (the mount is there, the leads are loaded)', wrap.hidden === false && /class="sc-banner"/.test(wrap.innerHTML) && /<strong>1<\/strong> needs a job type/.test(wrap.innerHTML), wrap.innerHTML);
    ok('it exposes window.NBDSortCustomers.refresh for crm-pipeline.js', !!w.NBDSortCustomers && typeof w.NBDSortCustomers.refresh === 'function');
    ok('it listens for later lead loads (nbd:data-refreshed)', (winListeners['nbd:data-refreshed'] || []).length === 1);
    const api = w.NBDSortCustomers;
    vm.runInContext(SC, ctx, { filename: 'sort-customers.js' });
    ok('running it twice keeps one copy: same API, one click listener, one refresh listener (sentinel)', w.NBDSortCustomers === api && (docListeners.click || []).length === 1 && (winListeners['nbd:data-refreshed'] || []).length === 1);
  }

  console.log('\nLAZY SORT CUSTOMERS: dashboard.html');
  {
    const dash = read('docs/pro/dashboard.html');
    ok('sort-customers.js is not an eager tag any more', !/<script[^>]*src="js\/sort-customers\.js/.test(dash));
    const tpl = /<template id="tpl-view-crm">([\s\S]*?)<\/template><!-- \/tpl-view-crm -->/.exec(dash);
    const outside = dash.replace(tpl ? tpl[0] : '', '');
    ok('the banner mount #sortCustomersWrap lives only inside tpl-view-crm (absent until the first Pipeline open)', !!tpl && /id="sortCustomersWrap"/.test(tpl[1]) && !/id="sortCustomersWrap"/.test(outside));
    ok('Home is the boot view; the Pipeline view starts empty and inactive', /<div class="view active" id="view-home"/.test(dash) && /<div class="view" id="view-crm" data-view-template="tpl-view-crm"><\/div>/.test(dash));
    const sl = dash.indexOf('src="js/script-loader.js'), cp = dash.indexOf('<script defer src="js/crm-pipeline.js');
    ok('crm-pipeline.js (the trigger) is still a deferred tag, after the blocking script-loader.js (registration needs it)', sl > 0 && cp > sl);
    ok('triage-deck.js ("One at a time" deck) is still eager', /<script defer src="js\/triage-deck\.js\?v=\d+"><\/script>/.test(dash));
    ok('the banner stylesheet is still linked', /<link rel="stylesheet" href="css\/sort-customers\.css\?v=\d+">/.test(dash));
    ok('script-loader.js is untouched by this lane: no sortcustomers bundle inside the blocking file', !/sortcustomers|sort-customers/.test(LOADER));
    const manifest = read('tests/ci-manifest.json');
    ok('this suite is in the node bucket', manifest.indexOf('"lazy-sort-customers-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
