/**
 * tests/claim-panel-logic-2026-09-30.test.js
 *
 * The customer page's Insurance Claim panel is decided for the job on the
 * card (Jo, 2026-09-30, "build steps 1-4 and the shared check"):
 *   1. insurance job, or untyped with claim signs → the full workflow
 *   2. cash / finance / service / warranty with a claim on file → one read-only line
 *   3. the same with no claim → hidden
 *   4. untyped, no claim signs → "Insurance job?" with one-tap job types
 * The shared check lives in ky-insurance-law.js (normJobType / claimSignals /
 * claimPanelMode); the Kentucky-law isInsurance keeps its over-inclusive
 * behaviour, proven here against the pre-change implementation.
 *
 * Synthetic data only. Run: node tests/claim-panel-logic-2026-09-30.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const K = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'ky-insurance-law.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  console.log('\n1. the shared check');
  ok('normJobType: case and spaces don\'t matter; unknown types are not types', K.normJobType(' Insurance ') === 'insurance' && K.normJobType('CASH') === 'cash'
    && K.normJobType('replacement') === '' && K.normJobType(null) === '');
  ok('claim signals: carrier, claim #, a real claim status, panel progress, an insurance pipeline stage',
    K.hasClaimSignals({ insCarrier: 'ZZ Mutual' }) && K.hasClaimSignals({ claimNumber: 'C-1' }) && K.hasClaimSignals({ claimStatus: 'Denied' })
    && K.hasClaimSignals({ claimStage: 'documentation' }) && K.hasClaimSignals({ stage: 'scope_received' }) && K.hasClaimSignals({ _stageKey: 'claim_filed' }));
  ok('...but placeholders say nothing: "No Claim", "none", "N/A", blanks, a non-insurance stage',
    !K.hasClaimSignals({ claimStatus: 'No Claim', insCarrier: 'none', claimNumber: 'N/A', stage: 'contacted' }) && !K.hasClaimSignals({}));

  console.log('\n2. the panel, decided per job (the four steps)');
  const M = K.claimPanelMode;
  ok('step 1: an insurance job → full (any case)', M({ jobType: 'insurance' }) === 'full' && M({ jobType: 'Insurance' }) === 'full');
  ok('step 1: untyped but a carrier / claim # / insurance stage / progress → full',
    M({ insCarrier: 'ZZ Mutual' }) === 'full' && M({ claimNumber: 'C-9' }) === 'full' && M({ stage: 'adjuster_meeting_scheduled' }) === 'full' && M({ claimStage: 'approved' }) === 'full');
  ok('step 2: cash / finance / service / warranty WITH a claim on file → summary',
    ['cash', 'finance', 'service', 'warranty'].every((t) => M({ jobType: t, claimNumber: 'C-2' }) === 'summary') && M({ jobType: 'cash', claimStatus: 'Denied' }) === 'summary');
  ok('step 3: the same with no claim → hidden (the 160-customer case)', ['cash', 'finance', 'service', 'warranty'].every((t) => M({ jobType: t }) === 'hidden')
    && M({ jobType: 'cash', claimStatus: 'No Claim' }) === 'hidden');
  ok('step 4: untyped, nothing claim-like → prompt', M({}) === 'prompt' && M({ stage: 'new', claimStatus: 'No Claim' }) === 'prompt');
  ok('a cash job sitting on an insurance pipeline stage is still the TYPE\'s call (hidden), not the stage\'s', M({ jobType: 'cash', stage: 'claim_filed' }) === 'hidden');

  console.log('\n3. Kentucky law: isInsurance behaves exactly as before (over-inclusive on purpose)');
  {
    // The implementation before this change, verbatim in behaviour.
    const pres = (v) => { const s = (v == null ? '' : String(v)).trim().toLowerCase(); return !!s && ['none', 'n/a', 'na', '-', '—', 'no', 'null', 'undefined', 'false', '0'].indexOf(s) === -1; };
    const old = (ctx) => {
      ctx = ctx || {};
      const jt = String(ctx.jobType == null ? '' : ctx.jobType).trim().toLowerCase();
      const mode = String((ctx.mode || ctx.jobMode) == null ? '' : (ctx.mode || ctx.jobMode)).trim().toLowerCase();
      if (jt === 'insurance' || mode === 'insurance') return true;
      if (ctx.isInsurance === true || ctx.isInsuranceJob === true || ctx.insuranceClaim === true || ctx.insurance === true) return true;
      if (pres(ctx.claimNumber)) return true;
      if (pres(ctx.insuranceCarrier) || pres(ctx.insCarrier) || pres(ctx.insuranceCompany)) return true;
      const ins = ctx.insurance;
      if (ins && typeof ins === 'object' && (pres(ins.claimNumber) || pres(ins.carrier))) return true;
      return false;
    };
    const vals = { jobType: [undefined, 'insurance', ' Insurance', 'cash', 'replacement'], mode: [undefined, 'insurance', 'cash'], claimNumber: [undefined, 'C-1', 'none'],
      insCarrier: [undefined, 'ZZ', 'N/A'], insuranceCompany: [undefined, 'ZZ Co'], insurance: [undefined, true, { carrier: 'ZZ' }, { claimNumber: '' }], isInsuranceJob: [undefined, true] };
    const keys = Object.keys(vals);
    let n = 0, diff = null;
    (function walk(i, ctx) {
      if (diff) return;
      if (i === keys.length) { n++; if (old(ctx) !== K.isInsurance(ctx)) diff = JSON.stringify(ctx); return; }
      for (const v of vals[keys[i]]) walk(i + 1, Object.assign({}, ctx, v === undefined ? {} : { [keys[i]]: v }));
    })(0, {});
    ok('identical on all ' + n + ' combinations of type, mode, claim #, carrier and flags', !diff && n > 1000, diff);
    ok('a cash job with a carrier on file still counts for the law (it must never skip a KY protection)', K.isInsurance({ jobType: 'cash', insCarrier: 'ZZ' }) === true);
  }

  console.log('\n4. the panel itself (insurance-claim.js in a sandbox)');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'insurance-claim.js'), 'utf8');
    function run(lead, opts) {
      opts = opts || {};
      const container = { innerHTML: 'old', hidden: false };
      const writes = [];
      const win = {
        NBDJurisdiction: K,
        NBDRole: { isViewer: () => !!opts.viewer, guard: () => !opts.viewer },
        db: {}, doc: (db, c, id) => c + '/' + id, serverTimestamp: () => 'TS',
        getDoc: async () => ({ exists: () => true, data: () => lead }),
        updateDoc: async (p, d) => { writes.push([p, d]); },
        _currentLead: { id: 'L1', jobType: '' },
      };
      const document = { getElementById: (id) => (id === 'insuranceClaimWorkflow' ? container : null), addEventListener() {} };
      const sb = { window: win, document, console: { error() {}, warn() {}, log() {} } };
      vm.createContext(sb);
      vm.runInContext(src, sb);
      return { win, container, writes, render: () => win.InsuranceClaim.renderClaimWorkflow('insuranceClaimWorkflow', 'L1') };
    }
    let r = run({ jobType: 'insurance', claimNumber: 'C-1' }); await r.render();
    ok('insurance job → the full 11-step workflow with Advance', /Insurance Claim Progress/.test(r.container.innerHTML) && /data-ic-action="advance"/.test(r.container.innerHTML) && r.container.hidden === false);
    r = run({ jobType: 'cash' }); await r.render();
    ok('cash job, no claim → hidden and empty', r.container.hidden === true && r.container.innerHTML === '');
    r = run({ jobType: 'cash', claimNumber: '<b>C-7</b>', claimStatus: 'Denied', insCarrier: 'ZZ Mutual' }); await r.render();
    ok('cash job with a denied claim → one read-only line, no workflow, no Advance', /Claim on file:/.test(r.container.innerHTML) && /Denied · #/.test(r.container.innerHTML)
      && !/data-ic-action="advance"/.test(r.container.innerHTML) && !/Insurance Claim Progress/.test(r.container.innerHTML));
    ok('...and the claim # is escaped', /&lt;b&gt;C-7&lt;\/b&gt;/.test(r.container.innerHTML) && !/<b>C-7/.test(r.container.innerHTML));
    r = run({ stage: 'new' }); await r.render();
    ok('untyped, no claim signs → "Insurance job?" with the five job types', /Insurance job\?/.test(r.container.innerHTML)
      && ['insurance', 'cash', 'finance', 'service', 'warranty'].every((t) => new RegExp('data-ic-type="' + t + '"').test(r.container.innerHTML)));
    const ok1 = await r.win.InsuranceClaim.setJobType('L1', 'Cash');
    ok('a tap writes the normalized type to the lead (and the page\'s copy)', ok1 === true && r.writes.length === 1 && r.writes[0][0] === 'leads/L1'
      && r.writes[0][1].jobType === 'cash' && r.win._currentLead.jobType === 'cash');
    ok('an unknown type is refused, nothing written', (await r.win.InsuranceClaim.setJobType('L1', 'replacement')) === false && r.writes.length === 1);
    r = run({ stage: 'new' }, { viewer: true }); await r.render();
    ok('a viewer sees the question but no buttons, and cannot write', /Insurance job\?/.test(r.container.innerHTML) && !/data-ic-action="settype"/.test(r.container.innerHTML)
      && (await r.win.InsuranceClaim.setJobType('L1', 'cash')) === false && r.writes.length === 0);
    r = run({ insCarrier: 'ZZ Mutual' }); await r.render();
    ok('untyped with a carrier → the full workflow (step 1)', /Insurance Claim Progress/.test(r.container.innerHTML));
  }

  console.log('\n5. crm-stages inferJobType reads through the shared normalizer');
  {
    const cs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'crm-stages.js'), 'utf8');
    ok('inferJobType normalizes the stored type (\'Insurance\' was a stored value) and keeps unknown types',
      /const raw = String\(lead\.jobType \|\| ''\)\.trim\(\)\.toLowerCase\(\);\s*const jt = \(\(K && typeof K\.normJobType === 'function'\) \? K\.normJobType\(raw\) : ''\) \|\| raw;\s*if \(jt\) return jt;/.test(cs));
    const fnK = fs.readFileSync(path.join(__dirname, '..', 'functions', 'ky-insurance-law.js'), 'utf8');
    ok('functions/ky-insurance-law.js is byte-identical to the browser copy', fnK === fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'ky-insurance-law.js'), 'utf8'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
