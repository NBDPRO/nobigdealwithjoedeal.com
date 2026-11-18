/**
 * clause-set-v1-review-2026-11-18.test.js — the independent security review of the clause set v1 branch
 * (items 1-10). See documentation/projects/CLAUSE-SET-V1-2026-11-18.md ("Review fixes").
 * Run: node tests/clause-set-v1-review-2026-11-18.test.js   (needs functions/node_modules for pdf-lib)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/clause-v1-harness');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
const readRepo = (p) => fs.readFileSync(path.join(H.ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// The registry module loaded with a chosen wording table (undefined = the file did not load).
function loadRegistry(textObj) {
  const real = path.join(H.ROOT, 'functions');
  const mod = { exports: {} };
  const req = (p) => {
    if (p === './clause-set-text') return textObj;
    return require(path.join(real, p));
  };
  vm.runInNewContext(readRepo('functions/clause-set.js'), { module: mod, require: req, window: undefined, console }, { filename: 'clause-set.js' });
  return mod.exports;
}

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  section('5. the wording file missing is a refusal, never a contract with sections dropped');
  {
    const bare = loadRegistry({});
    let threw = false, msg = '';
    try { bare.renderV1({ state: 'OH', paymentSource: 'cash', terms: {} }); } catch (e) { threw = true; msg = String(e.message); }
    ok('renderV1 THROWS when the clause table is empty', threw && /wording/i.test(msg), msg);

    const env = H.docs({ flags: { docClauseSetV1: true }, noClauseText: true });
    const G = env.win.NBDDocGen;
    ok('wording not loaded: NBDClauseText is undefined', env.win.NBDClauseText === undefined);
    ok('flag on, wording missing: _clauseV1On() is false (never a half-printed set)', G._clauseV1On() === false);
    ok('flag on, wording missing: the flag is still reported as wanted', G._clauseV1Wanted() === true);
    const v = H.VARIANTS.oh_cash;
    const html = H.render(env, 'renderContract', v);
    ok('wording missing: the contract keeps EVERY legacy section (nothing dropped)',
      /Cancellation &amp; Rescission Rights|Cancellation & Rescission Rights/.test(html) && /Entire Agreement/.test(html) && /Dispute Resolution/.test(html) && /Change Orders/.test(html));
    env.sandbox.__toasts = env.toasts.length;
    const before = env.toasts.length;
    const sent = G._docSendGate('contract', H.contractData(env.win, v), html);
    ok('wording missing: the send gate REFUSES the contract', sent === false);
    ok('wording missing: the refusal says the clause wording did not load',
      env.toasts.slice(before).some((t) => /clause wording/i.test(t.m)), JSON.stringify(env.toasts.slice(before)));
    const envOk = H.docs({ flags: { docClauseSetV1: true } });
    ok('control: wording loaded: _clauseV1On() is true', envOk.win.NBDDocGen._clauseV1On() === true);

    const loader = readRepo('docs/pro/js/script-loader.js');
    const bundle = loader.slice(loader.indexOf('docgen: ['), loader.indexOf('estimate engine', loader.indexOf('docgen: [')) > 0 ? loader.indexOf('// Estimate engine (PR 2c)') : loader.length);
    const a = bundle.indexOf('js/clause-set-text.js'), b = bundle.indexOf('js/clause-set.js'), c = bundle.indexOf('js/document-generator.js');
    ok('the wording file and the registry load in the same loader group (docgen), wording first, before the generator',
      a > 0 && b > a && c > b);
    ok('no page loads either file outside the loader group',
      !/clause-set/.test(readRepo('docs/pro/customer.html')) && !/clause-set/.test(readRepo('docs/pro/dashboard.html')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
