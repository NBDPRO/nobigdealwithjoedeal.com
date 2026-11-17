/**
 * tests/margin-floor-part3-2026-11-17.test.js
 *
 * Part three of the estimate margin floor (plan:
 * documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md):
 *   - "Use this price" on a per-square job: the chosen package's price per
 *     square rises by whole dollars, and every package above it by the same, so
 *     Good / Better / Best keeps its order; the packages below do not move
 *   - who sees costs: the owner and a company admin see the dollar breakdown
 *     and the Internal View; a rep or a manager sees the margin % and band
 *   - the shared confirm (margin-floor.js confirmUnder) the job templates
 *     "Send to customer" uses
 *   - the "Under floor" tag in the estimates list, owner and admin only
 *
 * Runs the real engines in a vm. Costs are the published starter baseline.
 * Run: node tests/margin-floor-part3-2026-11-17.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + JSON.stringify(detail) : '')); }
}

function makeSandbox() {
  const byId = {};
  const el = (tag) => ({
    tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; }, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, remove() {},
  });
  const document = { head: el('head'), body: el('body'), createElement: el, getElementById: (id) => byId[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = { window: win, document, localStorage, navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' } };
  vm.createContext(sandbox);
  return { win, sandbox, store };
}
const FILES = [
  'docs/pro/js/estimate-config.js', 'docs/pro/js/ky-insurance-law.js', 'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js', 'docs/pro/js/roofivent-catalog.js', 'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js', 'docs/pro/js/estimate-catalog-xactimate.js', 'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js', 'docs/pro/js/job-templates.js', 'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/margin-floor.js', 'docs/pro/js/estimate-finalization.js', 'docs/pro/js/estimate-v2-ui.js',
];
function stack(o) {
  o = o || {};
  const env = makeSandbox();
  env.store.nbd_est_settings_v3 = JSON.stringify({ roundTo: 25 });
  env.win._companyProfile = { pricing: { marginFloor: { floorPct: o.floor || 60, targetPct: (o.floor || 60) + 5 } } };
  env.win._userClaims = o.claims || {}; env.win._user = { uid: 'u1' };
  env.asked = []; env.toasts = [];
  env.answers = (o.answers || []).slice();
  env.win.nbdConfirm = async (m) => { env.asked.push(m); return env.answers.length ? env.answers.shift() : false; };
  env.win.nbdPrompt = async () => (o.reason || '');
  env.win.showToast = (m, k) => env.toasts.push([m, k]);
  FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
  env.V2 = env.win.EstimateV2UI._test; env.MF = env.win.NBDMarginFloor; env.EB = env.win.EstimateBuilderV2;
  const st = env.V2.getState();
  st._reopenedClean = false; st._reopenedDoc = null;
  st.mode = o.mode || 'per-sq'; st.jobMode = o.jobMode || 'cash'; st.tier = o.tier || 'good'; st.county = '';
  st.measurements = Object.assign({}, st.measurements, { rawSqft: 2000, pitch: 6 });
  st.scope = ['RFG 240-GAF-HDZ', 'RFG SYN', 'LAB TO1'].map((code) => ({ code }));
  st.passThru = []; st.upgrades = []; st.minJobCharge = null;
  env.st = st;
  env.est = () => env.V2.effectiveEstimate();
  env.view = () => env.MF.view(env.est());
  return env;
}
// A plain page sandbox for files that need only a DOM stub and window.
function loadPage(files) {
  const els = {};
  const el = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}, appendChild() {} });
  const document = { getElementById: (id) => (els[id] = els[id] || el()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() };
  const toasts = [];
  const win = { document, addEventListener() {}, localStorage: { getItem: () => null, setItem() {} }, showToast: (m) => toasts.push(m) };
  win.window = win;
  const sb = { window: win, document, console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, Date, Math, JSON, navigator: {}, localStorage: win.localStorage, location: { hash: '' } };
  vm.createContext(sb);
  files.forEach((f) => vm.runInContext(read(f), sb, { filename: path.basename(f) }));
  return { win, g: sb, toasts, el: (id) => document.getElementById(id) };
}
const tierTotals = (env) => { const t = env.est().perSqTiers || {}; const o = {}; Object.keys(t).forEach((k) => { o[k] = t[k].total; }); return o; };

(async () => {
  console.log('\nThe engine takes a per-estimate raise, by tier');
  {
    const env = stack();
    const base = env.EB.calculatePerSq({ rawSqft: 2000, pitch: '6/12', tier: 'better', mode: 'cash' });
    const up = env.EB.calculatePerSq({ rawSqft: 2000, pitch: '6/12', tier: 'better', mode: 'cash', rateAddPerSq: { better: 11 } });
    const other = env.EB.calculatePerSq({ rawSqft: 2000, pitch: '6/12', tier: 'better', mode: 'cash', rateAddPerSq: { best: 11 } });
    ok('a raise on this tier lifts its price; a raise named for another tier does not', up.total > base.total && other.total === base.total, [base.total, up.total, other.total]);
    const junk = env.EB.calculatePerSq({ rawSqft: 2000, pitch: '6/12', tier: 'better', mode: 'cash', rateAddPerSq: { better: -50 } });
    ok('a negative or junk raise is ignored', junk.total === base.total && env.EB.calculatePerSq({ rawSqft: 2000, pitch: '6/12', tier: 'better', mode: 'cash', rateAddPerSq: { better: 'x' } }).total === base.total);
  }

  console.log('\nUse this price on a per-square job');
  {
    const env = stack({ tier: 'good' });
    const v0 = env.view();
    ok('a per-square job starts under the (high) floor', v0.known && v0.state === 'under', [v0.state, v0.marginPct]);
    const before = tierTotals(env);
    const plan = env.V2.floorRaisePlan();
    ok('the plan is a whole-dollar raise per square on the chosen package', plan.ok === true && plan.kind === 'per_sq' && plan.tier === 'good' && Number.isInteger(plan.perSq) && plan.perSq > 0, plan);
    ok('planning changes nothing', JSON.stringify(tierTotals(env)) === JSON.stringify(before) && env.st.floorPerSq === null);
    env.V2.floorRaiseApply(plan);
    const after = tierTotals(env);
    ok('applied, the job clears the floor and the promised total is the engine\'s', env.view().state !== 'under' && Math.round(env.est().total * 100) === plan.totalCents, [env.view().state, env.est().total, plan.totalCents]);
    const tiers = ['economy', 'good', 'better', 'best', 'beyond'].filter((t) => t in before);
    ok('the packages below the chosen one do not move', tiers.slice(0, tiers.indexOf('good')).every((t) => after[t] === before[t]), [before, after]);
    ok('the chosen package and every one above it rise', tiers.slice(tiers.indexOf('good')).every((t) => after[t] > before[t]));
    ok('the order of the packages is kept', tiers.every((t, i) => i === 0 || after[t] >= after[tiers[i - 1]]), after);
    ok('the raise reaches the engine as dollars per square for those tiers only', JSON.stringify(env.V2.floorRateAdd()) === JSON.stringify(tiers.slice(tiers.indexOf('good')).reduce((o, t) => { o[t] = plan.perSq; return o; }, {})), env.V2.floorRateAdd());
    env.st.floorPerSq = { fromTier: 'good', perSq: plan.perSq - 1 };
    ok('it is the smallest whole dollar: one less is still under', env.view().state === 'under');
    env.st.floorPerSq = { fromTier: 'good', perSq: plan.perSq };
    const pay = env.V2.buildSavePayload(env.est(), env.st);
    ok('saved with the estimate', pay.floorPerSq && pay.floorPerSq.fromTier === 'good' && pay.floorPerSq.perSq === plan.perSq, pay.floorPerSq);
    ok('the shop\'s Settings were not written', !/tierRates/.test(env.store.nbd_est_settings_v3 || ''));
    env.st.jobMode = 'insurance';
    ok('never on an insurance scope', env.V2.floorRateAdd() === null);
  }

  console.log('\nThe gate offers the per-square raise');
  {
    const env = stack({ claims: { companyId: 'co', role: 'sales_rep' }, answers: [true] });
    const r = await env.V2.floorGate(env.est());
    ok('a rep is offered the raise in package words, and may send once it is taken', r === true && /goes up \$[\d,]+ a square, and so does every package above it/.test(env.asked[0] || '') && env.view().state !== 'under', env.asked);
  }

  console.log('\nWho sees costs');
  {
    const roles = { owner: {}, company_admin: { companyId: 'co', role: 'company_admin' }, platform: { admin: true }, manager: { companyId: 'co', role: 'manager' }, rep: { companyId: 'co', role: 'sales_rep' } };
    const see = {};
    for (const [k, claims] of Object.entries(roles)) { const env = stack({ claims, mode: 'line-item' }); see[k] = env.MF.canSeeCosts(); }
    ok('the owner, a company admin and the platform admin see costs; a manager and a rep do not', see.owner && see.company_admin && see.platform && !see.manager && !see.rep, see);
    const rep = stack({ claims: roles.rep, mode: 'line-item', floor: 20 });
    const own = stack({ claims: roles.owner, mode: 'line-item', floor: 20 });
    const lr = rep.V2.marginLineFor(rep.est()), lo = own.V2.marginLineFor(own.est());
    ok('a rep sees the margin percentage with no dollar figure; the owner sees both', /Margin before tax: <strong>[\d.]+%<\/strong>/.test(lr) && !/\$/.test(lr) && /\(\$[\d,]+\)/.test(lo), [lr, lo]);
    let opened = false;
    rep.win.EstimateFinalization = Object.assign({}, rep.win.EstimateFinalization, { formatEstimate: () => { opened = true; return { html: '' }; } });
    await rep.win.EstimateV2UI.finalize('internal-view');
    ok('a rep is refused the Internal View with a plain message', !opened && rep.toasts.some(([m]) => /Only the owner or a company admin can open the Internal View/.test(m)), rep.toasts);
    const v2src = read('docs/pro/js/estimate-v2-ui.js');
    ok('the rollup hides the Internal button from a rep and shows only the tax and margin line',
      /if \(ivBtn\) ivBtn\.hidden = !_canSeeCosts\(\);[\s\S]{0,200}rollupEl\.innerHTML = taxDisplay\.replace/.test(v2src));
    // The classic estimator's Internal View toggle, run for real.
    const cl = loadPage(['docs/pro/js/margin-floor.js', 'docs/pro/js/estimates.js']);
    const panel = cl.el('internalViewPanel'); panel.style.display = 'none';
    cl.win._userClaims = { companyId: 'co', role: 'sales_rep' }; cl.win._user = { uid: 'u2' };
    cl.win.toggleInternalView();
    ok('a rep is refused the classic Internal View, with a plain message', panel.style.display === 'none' && /Only the owner or a company admin/.test(cl.toasts[0] || ''), cl.toasts);
    cl.win._userClaims = {}; cl.toasts.length = 0;
    cl.win.toggleInternalView();
    ok('the owner opens the classic Internal View', panel.style.display === 'block' && cl.toasts.length === 0, panel.style.display);
  }

  console.log('\nThe shared confirm (job templates Send to customer)');
  {
    const v = (env, cost) => env.MF.view({ mode: 'cash', grandTotal: 10780, taxAmount: 780, hardCost: cost }, { floorPct: 30, targetPct: 35 });
    const rep = stack({ claims: { companyId: 'co', role: 'sales_rep' } });
    const r1 = await rep.MF.confirmUnder(v(rep, 8000), { extra: 'Open it in the estimate builder to raise the price.' });
    ok('a rep is stopped, told the facts and where to raise it, and asked nothing', r1.ok === false && rep.asked.length === 0 && /20\.0% margin before tax/.test(rep.toasts[0][0]) && /estimate builder to raise the price/.test(rep.toasts[0][0]) && /save it as a draft/.test(rep.toasts[0][0]), rep.toasts);
    const own = stack({ answers: [true], reason: 'gap week' });
    const r2 = await own.MF.confirmUnder(v(own, 8000), {});
    ok('the owner is asked, and a yes gives a note with the reason', r2.ok === true && r2.note && r2.note.reason === 'gap week' && r2.note.marginPct === 20 && own.asked.length === 1, r2);
    const r3 = await own.MF.confirmUnder(v(own, 8000), { prev: r2.note });
    ok('a prior note the margin still holds is kept without asking', r3.ok === true && r3.note === r2.note && own.asked.length === 1);
    const r4 = await own.MF.confirmUnder(v(own, 7000), {});
    ok('at the floor nothing is asked', r4.ok === true && r4.note === null);
    const ui = read('docs/pro/js/job-templates-ui.js');
    const at = (t) => ui.indexOf(t);
    ok('Send to customer checks the estimate it just created before minting a link, and saves the note',
      at('MF.confirmUnder(v,') !== -1 && at('MF.confirmUnder(v,') < at('window.CustomerPortal.mintUrl(leadId)') && at('{ floorConfirm: r.note }') > at('MF.confirmUnder(v,'));
    const JTe = stack({ mode: 'line-item' }).win.JobTemplates;
    ok('the templates engine exposes what it last created (nothing yet)', typeof JTe.lastCreated === 'function' && JTe.lastCreated() === null);
  }

  console.log('\nThe Under floor tag');
  {
    // The estimates list, run for real.
    const list = (claims) => {
      const pg = loadPage(['docs/pro/js/margin-floor.js', 'docs/pro/js/dashboard-widgets.js']);
      pg.win._userClaims = claims; pg.win._user = { uid: 'u1' }; pg.win._leads = [];
      pg.g.renderEstimatesList([{ id: 'e1', name: 'A', grandTotal: 1000, floorConfirm: { by: 'u1', marginPct: 20 } }, { id: 'e2', name: 'B', grandTotal: 1000 }]);
      return pg.el('estListWrap').innerHTML;
    };
    const ownerList = list({}), repList = list({ companyId: 'co', role: 'sales_rep' });
    const tags = (html) => html.split('>Under floor</span>').length - 1;
    ok('the owner sees Under floor once, on the estimate that carries a note', tags(ownerList) === 1, ownerList.length);
    ok('a rep never sees the tag', tags(repList) === 0 && repList.length > 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
