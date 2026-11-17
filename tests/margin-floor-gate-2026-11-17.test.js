/**
 * tests/margin-floor-gate-2026-11-17.test.js
 *
 * The margin floor gate in the V2 estimate builder (estimate-v2-ui.js
 * _floorGate; plan: documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md).
 *
 * Before a price reaches a customer (send for signature, the deal link, a
 * customer-facing document) an estimate under the COMPANY's floor:
 *   - stops a rep or a manager, with the margin, the floor and the price that
 *     reaches it, and writes nothing
 *   - asks the owner or a company admin; a yes keeps a private note on the
 *     estimate, a no stops
 *   - asks again only when the margin has dropped below what was confirmed
 * and it never fires when no floor is set, on an insurance scope, on a job with
 * an uncosted line, or at or above the floor. The note is saved with the
 * estimate, restored on reopen and cleared for a new one.
 *
 * This is the SCREEN gate. Nothing on the server enforces it yet.
 *
 * Every figure here is made up.
 * Pure-Node. Run: node tests/margin-floor-gate-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const FLOOR = { pricing: { marginFloor: { floorPct: 30, targetPct: 35 } } };
const WHO = {
  owner: { claims: {}, uid: 'u_owner' },                                   // a solo owner has no role claim
  admin: { claims: { companyId: 'co', role: 'company_admin' }, uid: 'u_ca' },
  manager: { claims: { companyId: 'co', role: 'manager' }, uid: 'u_mgr' },
  rep: { claims: { companyId: 'co', role: 'sales_rep' }, uid: 'u_rep' },
};

function load(opts) {
  const o = opts || {};
  const asked = [], toasts = [];
  const win = {}; win.window = win;
  win.EstimateLogic = { resolveEstimate: () => ({}), buildContext: (x) => x, MEASUREMENT_VARS: [] };
  win.EstimateBuilderV2 = { loadSettings: () => ({ countyTax: {} }), calculateAllTiers: () => ({}), calculatePerSq: () => ({}) };
  if (o.profile !== null) win._companyProfile = o.profile || FLOOR;
  const who = WHO[o.who || 'owner'];
  win._userClaims = who.claims; win._user = { uid: who.uid };
  win.nbdConfirm = async (m) => { asked.push(m); return o.answer !== false; };
  win.showToast = (m, k) => { toasts.push([m, k]); };
  const sandbox = {
    window: win, console: { log() {}, warn() {}, error() {} },
    document: { createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), addEventListener() {}, getElementById: () => null, querySelector: () => null },
    Date, Math, JSON, Set, setTimeout, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
  };
  vm.createContext(sandbox);
  if (o.noFloorFile !== true) vm.runInContext(read('margin-floor.js'), sandbox);
  vm.runInContext(read('estimate-v2-ui.js'), sandbox, { filename: 'estimate-v2-ui.js' });
  return { T: win.EstimateV2UI._test, asked, toasts, win };
}

// $10,000 before tax. Cost 8,000 -> 20% (under). Cost 7,000 -> 30% (on the floor).
const est = (cost, extra) => Object.assign({ mode: 'cash', total: 10780, tax: 780, subtotal: 10000, hardCost: cost, materialCost: cost, laborCost: 0, internal: { hardCost: cost, margin: 1, marginPct: 1 } }, extra || {});

(async () => {
  console.log('\nWhen the gate does not fire');
  {
    for (const [label, e, o] of [
      ['at the floor', est(7000), {}],
      ['above the target', est(5000), {}],
      ['an insurance scope, whatever its margin', est(9500, { mode: 'insurance', total: 10000, tax: 0 }), {}],
      ['a job with an uncosted line', est(8000, { costUnsetCount: 1 }), {}],
      ['a company with no floor set', est(9000), { profile: null }],
      ['a company whose only "floor" is the expense budget one', est(9000), { profile: { budgetDefaults: { marginFloorPct: 30 } } }],
      ['margin-floor.js not loaded', est(9000), { noFloorFile: true }],
    ]) {
      const L = load(Object.assign({ who: 'rep' }, o));
      const r = await L.T.floorGate(e);
      ok(label + ': passes, asks nothing, notes nothing', r === true && L.asked.length === 0 && L.toasts.length === 0 && L.T.floorConfirm() == null, [r, L.asked, L.toasts]);
    }
    const none = load({ who: 'rep' });
    ok('no estimate at all passes (the caller reports the empty scope)', (await none.T.floorGate(null)) === true);
  }

  console.log('\nUnder the floor: a rep or a manager is stopped');
  {
    for (const who of ['rep', 'manager']) {
      const L = load({ who });
      const said = [];
      const r = await L.T.floorGate(est(8000), (m, k) => said.push([m, k]));
      const msg = (L.toasts[0] || [''])[0];
      ok('a ' + who + ' is stopped and is not asked to confirm', r === false && L.asked.length === 0 && L.T.floorConfirm() == null, [r, L.asked]);
      ok('the ' + who + ' is told the margin, the floor and the price that reaches it', /20\.0% margin before tax/.test(msg) && /floor is 30%/.test(msg) && /\$11,429 before tax/.test(msg) && /save it as a draft/.test(msg) && said.length === 1 && said[0][0] === msg, msg);
    }
  }

  console.log('\nUnder the floor: the owner or a company admin is asked');
  {
    for (const who of ['owner', 'admin']) {
      const yes = load({ who });
      const r = await yes.T.floorGate(est(8000));
      const n = yes.T.floorConfirm();
      ok('the ' + who + ' is asked once, with the facts', r === true && yes.asked.length === 1 && /20\.0% margin/.test(yes.asked[0]) && /\$11,429/.test(yes.asked[0]) && /anyway\?/.test(yes.asked[0]), yes.asked);
      ok('a yes keeps a private note: who, role, margin, floor, when', n && n.by === WHO[who].uid && n.role === (who === 'owner' ? 'owner' : 'company_admin') && n.marginPct === 20 && n.floorPct === 30 && typeof n.atMs === 'number', n);
      const no = load({ who, answer: false });
      ok('a no stops and keeps no note', (await no.T.floorGate(est(8000))) === false && no.T.floorConfirm() == null);
    }
  }

  console.log('\nAsking again');
  {
    const L = load({ who: 'owner' });
    await L.T.floorGate(est(8000));                       // confirmed at 20%
    ok('the same margin again: the confirm stands', (await L.T.floorGate(est(8000))) === true && L.asked.length === 1);
    ok('a better margin, still under the floor: the confirm stands', (await L.T.floorGate(est(7500))) === true && L.asked.length === 1);
    ok('a lower margin: asked again, and the note moves to the new margin', (await L.T.floorGate(est(8500))) === true && L.asked.length === 2 && L.T.floorConfirm().marginPct === 15, L.T.floorConfirm());
    const R = load({ who: 'rep' });
    R.T.floorConfirm({ by: 'u_owner', role: 'owner', marginPct: 20, floorPct: 30, atMs: 1 });
    ok('a rep may send an estimate the owner already confirmed, while the margin holds', (await R.T.floorGate(est(8000))) === true && R.toasts.length === 0);
    ok('a rep is stopped again once the margin drops below the confirmed one', (await R.T.floorGate(est(8500))) === false && R.toasts.length === 1);
  }

  console.log('\nThe note travels with the estimate');
  {
    const L = load({ who: 'owner' });
    const note = { by: 'u_owner', role: 'owner', marginPct: 20, floorPct: 30, atMs: 5 };
    L.T.floorConfirm(note);
    const payload = L.T.buildSavePayload({ method: 'line-item', total: 10780, tax: 780, subtotal: 10000, lines: [], tier: 'better', mode: 'cash', context: {} }, {
      customer: {}, tier: 'better', jobMode: 'cash', scope: [], passThru: [], measurements: {}, floorConfirm: note,
    });
    ok('the save payload carries the note', payload && payload.floorConfirm && payload.floorConfirm.by === 'u_owner' && payload.floorConfirm.marginPct === 20, payload && payload.floorConfirm);
    const src = read('estimate-v2-ui.js');
    ok('a reopened estimate restores its own note, and a new estimate starts with none', /state\.floorConfirm = \(doc\.floorConfirm && typeof doc\.floorConfirm === 'object'\)/.test(src) && /const _FRESH_ESTIMATE = JSON\.stringify\(\{[\s\S]{0,900}?floorConfirm: state\.floorConfirm,/.test(src));
    const order = (fn, a, b) => { const body = src.slice(src.indexOf(fn)); const i = body.indexOf(a), j = body.indexOf(b); return i !== -1 && j !== -1 && i < j; };
    ok('the deal link gates before it saves, so a confirm is saved with the estimate', order('async function _prepareDealLink(say) {', '_floorGate(estimate, say, { allPackages: true })', 'await save()'));
    ok('send for signature gates before it saves', order('async function sendForSignature(opts) {', "return 'floor';", 'save({'));
    ok('a customer document is gated and the Internal View is not', /if \(format !== 'internal-view' && !\(await _floorGate\(effectiveEstimate\(\)\)\)\) return;/.test(src));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
