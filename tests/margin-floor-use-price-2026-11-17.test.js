/**
 * tests/margin-floor-use-price-2026-11-17.test.js
 *
 * "Use this price" in the V2 estimate builder (estimate-v2-ui.js
 * _floorRaisePlan / _floorRaiseApply and the gate that offers it; plan:
 * documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md).
 *
 * When a cash line-item job is under the company's margin floor, the builder
 * offers to raise THIS estimate to the floor:
 *   - with material on the job it raises the material markup for this estimate
 *     only, so line prices rise and the printed Profit % does not move
 *   - with no material to mark up it raises the profit percentage, and says so
 *   - the raise is the smallest (to a tenth of a percent) that clears the
 *     floor through the real engine, so rounding, a minimum charge and fees are
 *     accounted for by the code that prices the job
 *   - the shop's Settings are never written
 *   - it is saved with the estimate and cleared for a new one
 *   - never on an insurance scope, never on a per-square price
 *
 * Runs the real engines in a vm (the stack of
 * tests/pricing-shop-settings-2026-11-17.test.js). Costs are the published
 * starter baseline; no company's figures are used.
 *
 * Run: node tests/margin-floor-use-price-2026-11-17.test.js
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
    tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
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
// A floor well above what the default ladder (25 / 10 / 10) gives, so the job is under it.
function stack(opts) {
  const o = opts || {};
  const env = makeSandbox();
  env.store.nbd_est_settings_v3 = JSON.stringify(Object.assign({ roundTo: 25 }, o.settings || {}));
  env.win._companyProfile = o.profile === null ? undefined : { pricing: { marginFloor: { floorPct: o.floor || 40, targetPct: (o.floor || 40) + 5 } } };
  env.win._userClaims = o.claims || {}; env.win._user = { uid: 'u1' };
  env.asked = []; env.toasts = [];
  env.answers = (o.answers || []).slice();
  env.win.nbdConfirm = async (m) => { env.asked.push(m); return env.answers.length ? env.answers.shift() : false; };
  env.win.nbdPrompt = async () => (o.reason === undefined ? '' : o.reason);
  env.win.showToast = (m, k) => env.toasts.push([m, k]);
  FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
  env.V2 = env.win.EstimateV2UI._test;
  env.MF = env.win.NBDMarginFloor;
  const st = env.V2.getState();
  st._reopenedClean = false; st._reopenedDoc = null;
  st.mode = 'line-item'; st.jobMode = o.jobMode || 'cash'; st.tier = 'better'; st.county = '';
  st.measurements = Object.assign({}, st.measurements, { rawSqft: 2000, pitch: 6 });
  st.scope = (o.scope || ['RFG 240-GAF-HDZ', 'RFG SYN', 'LAB TO1']).map((code) => ({ code }));
  st.passThru = []; st.upgrades = []; st.minJobCharge = null;
  env.st = st;
  env.est = () => env.V2.effectiveEstimate();
  env.view = () => env.MF.view(env.est());
  return env;
}

(async () => {
  console.log('\nThe plan: a material job');
  {
    const env = stack();
    const before = env.est(), v0 = env.view();
    ok('the job starts under the floor, with a known cost', !!before && v0.known === true && v0.state === 'under', v0 && [v0.state, v0.marginPct]);
    const keep = JSON.stringify([env.st.floorMarkupPct, env.st.floorProfitPct, env.store.nbd_est_settings_v3]);
    const plan = env.V2.floorRaisePlan();
    ok('a plan raises the material markup, not the profit', plan.ok === true && plan.kind === 'markup' && plan.pct > 0.25, plan);
    ok('planning changes nothing: state and Settings are as they were', JSON.stringify([env.st.floorMarkupPct, env.st.floorProfitPct, env.store.nbd_est_settings_v3]) === keep && env.view().state === 'under');
    ok('the rate is a whole tenth of a percent', Math.abs(plan.pct * 1000 - Math.round(plan.pct * 1000)) < 1e-9, plan.pct);

    env.V2.floorRaiseApply(plan);
    const after = env.est(), v1 = env.view();
    ok('applied, the job is at or above the floor', v1.state === 'ok' && v1.marginPct >= 40, [v1.state, v1.marginPct]);
    ok('the price the plan promised is the price the engine gives', Math.round(after.total * 100) === plan.totalCents && v1.preTaxCents === plan.preTaxCents, [after.total, plan]);
    ok('the printed profit and overhead percentages did not move', after.profitPct === before.profitPct && after.overheadPct === before.overheadPct, [after.profitPct, after.overheadPct]);
    ok('the total still lands on the shop\'s rounding step', Math.round(after.total * 100) % 2500 === 0, after.total);
    ok('cost did not change: only the price did', after.hardCost === before.hardCost && after.total > before.total);
    ok('the shop\'s Settings were not written', JSON.parse(env.store.nbd_est_settings_v3).materialMarkupPct === undefined, env.store.nbd_est_settings_v3);

    env.st.floorMarkupPct = plan.pct - 0.001;
    ok('it is the smallest such rate: one tenth of a percent less is under the floor', env.view().state === 'under');
    env.st.floorMarkupPct = plan.pct;
    ok('a second plan on a job that now clears has nothing to do', env.V2.floorRaisePlan().ok === false && env.V2.floorRaisePlan().reason === 'not_under');

    const payload = env.V2.buildSavePayload(after, env.st);
    ok('the raise is saved with the estimate', payload.floorMarkupPct === plan.pct && payload.floorProfitPct === null && payload.materialMarkupPct === plan.pct, [payload.floorMarkupPct, payload.materialMarkupPct]);
  }

  console.log('\nThe plan: no material, a minimum charge, and where it does not apply');
  {
    const lab = stack({ scope: ['LAB TO1', 'LAB MOB'] });
    const b = lab.est();
    const plan = lab.V2.floorRaisePlan();
    ok('a labor-only job is raised on the profit percentage', lab.view().state === 'under' && plan.ok === true && plan.kind === 'profit' && plan.pct > b.profitPct, plan);
    lab.V2.floorRaiseApply(plan);
    ok('applied, it clears the floor and the markup is untouched', lab.view().state === 'ok' && lab.st.floorMarkupPct === null && lab.est().profitPct === plan.pct);

    const min = stack({ scope: ['LAB MOB'], settings: { minRepairCharge: 5000 } });
    ok('a job a minimum charge already lifts over the floor needs no raise', min.view().state === 'ok' && min.V2.floorRaisePlan().reason === 'not_under', [min.view().state, min.est().total]);

    const ins = stack({ jobMode: 'insurance' });
    ok('an insurance scope is never offered a raise', ins.V2.floorRaisePlan().ok === false && ins.view().state === 'exempt');
    ins.st.floorMarkupPct = 3;
    const insEst = ins.est();
    ok('a stored raise is ignored on an insurance scope', Number(insEst.materialMarkupPct) < 3, insEst.materialMarkupPct);

    const off = stack({ profile: null });
    ok('a company with no floor set is never offered a raise', off.V2.floorRaisePlan().ok === false);
  }

  console.log('\nThe gate offers it');
  {
    const rep = stack({ claims: { companyId: 'co', role: 'sales_rep' }, answers: [true] });
    const r = await rep.V2.floorGate(rep.est());
    ok('a rep who accepts the raise may send, and no under-floor note is kept', r === true && rep.asked.length === 1 && /Raise this estimate to \$[\d,]+ before tax/.test(rep.asked[0]) && rep.view().state === 'ok' && rep.V2.floorConfirm() == null, [r, rep.asked]);
    ok('the offer says the profit percentage on the document stays', /profit percentage on the customer document stays/.test(rep.asked[0]));

    const repNo = stack({ claims: { companyId: 'co', role: 'sales_rep' }, answers: [false] });
    ok('a rep who declines is stopped, the price is unchanged, and is told to save a draft', (await repNo.V2.floorGate(repNo.est())) === false && repNo.view().state === 'under' && repNo.st.floorMarkupPct === null && /save it as a draft/.test((repNo.toasts[0] || [''])[0]) && repNo.asked.length === 1, repNo.toasts);

    const own = stack({ answers: [false, true], reason: '  neighbour   referral ' });
    const ro = await own.V2.floorGate(own.est());
    const note = own.V2.floorConfirm();
    ok('the owner who declines the raise is then asked to send as it is', ro === true && own.asked.length === 2 && /anyway\?/.test(own.asked[1]) && own.view().state === 'under');
    ok('the private note keeps the optional reason, tidied', note && note.by === 'u1' && note.role === 'owner' && note.reason === 'neighbour referral' && typeof note.marginPct === 'number', note);
    const own2 = stack({ answers: [false, true], reason: '' });
    await own2.V2.floorGate(own2.est());
    ok('no reason given: the note has none', own2.V2.floorConfirm() && !('reason' in own2.V2.floorConfirm()));
    const ownNo = stack({ answers: [false, false] });
    ok('the owner who declines both is stopped with no note', (await ownNo.V2.floorGate(ownNo.est())) === false && ownNo.V2.floorConfirm() == null);

    const labOwner = stack({ scope: ['LAB TO1', 'LAB MOB'], answers: [true] });
    await labOwner.V2.floorGate(labOwner.est());
    ok('on a labor-only job the offer says the printed profit percentage will change', /no material to mark up/.test(labOwner.asked[0]) && /customer document prints/.test(labOwner.asked[0]), labOwner.asked[0]);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
