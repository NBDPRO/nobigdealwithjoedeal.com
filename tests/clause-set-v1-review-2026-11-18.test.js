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

  // ═══════════════════════════════════════════════════════════════════════
  section('3. paymentTerms bounds and types (_numOk, server module and its loaded twin)');
  {
    const CSS = [require('../functions/clause-set.js'), loadRegistry(require('../functions/clause-set-text.js'))];
    CSS.forEach((CS, i) => {
      const tag = i === 0 ? 'server' : 'twin';
      ok(tag + ': numOk is exported', typeof CS.numOk === 'function');
      const n = CS.numOk;
      if (typeof n !== 'function') return;
      ok(tag + ': in-range numbers pass', n(15, 'lateGraceDays') && n(8, 'lateInterestPct') && n(0, 'cardFeePct') && n(10, 'cardFeePct') && n(12550, 'deckingPerSheetCents') && n(1, 'deckingSheetsBeforeChangeOrder') && n(200, 'deckingSheetsBeforeChangeOrder') && n(7.5, 'lateInterestPct'));
      const bad = [-1, NaN, Infinity, ' ', '', '0x10', '1e3', '15', true, false, [], [5], {}, null, undefined, 1e9];
      ok(tag + ': negative, NaN, strings (" ", "0x10", "1e3", "15"), booleans, arrays, objects, null, 1e9 all fail for every field',
        bad.every((v) => CS.PT_FIELDS.every((k) => n(v, k) === false)), bad.filter((v) => CS.PT_FIELDS.some((k) => n(v, k))).map(String).join(','));
      ok(tag + ': pct fields 0-100, cardFeePct 0-10', n(100, 'lateInterestPct') && !n(101, 'lateInterestPct') && !n(100.5, 'restockPct') && n(10, 'cardFeePct') && !n(10.01, 'cardFeePct'));
      ok(tag + ': day fields are integers 0-365', n(365, 'disputeDays') && !n(366, 'disputeDays') && !n(1.5, 'disputeDays') && n(0, 'claimNoticeDays'));
      ok(tag + ': decking cents integer 0-100000; sheets integer 1-200', n(100000, 'deckingPerSheetCents') && !n(100001, 'deckingPerSheetCents') && !n(10.5, 'deckingPerSheetCents') && !n(0, 'deckingSheetsBeforeChangeOrder') && !n(201, 'deckingSheetsBeforeChangeOrder'));
      const r = CS.renderV1({ state: 'OH', paymentSource: 'cash', party: CS.partyFor({}, true), facts: {},
        terms: Object.assign({}, CS.paymentTermsFor({}, true), { lateInterestPct: '1e3', disputeDays: -5, deckingPerSheetCents: 5000 }) });
      ok(tag + ': an out-of-range or string term is MISSING (the token stays, the send is refused), never printed',
        r.missing.indexOf('lateInterestPct') !== -1 && r.missing.indexOf('disputeDays') !== -1 && !/1e3|-5 days/.test(JSON.stringify(r.sections)));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('2. paymentTerms: blank by tenant identity, never by value (client and server agree)');
  {
    const env = H.docs({});
    const W = env.win;
    await W._saveCompanyProfile({ brand: { legalName: 'Oak Roofing LLC' }, paymentTerms: { lateInterestPct: 8, lateGraceDays: 15 } });
    const L = W._legal().paymentTerms;
    ok('a non-NBD tenant that SET lateInterestPct 8 (NBD\'s own number) keeps 8', L.lateInterestPct === 8, String(L.lateInterestPct));
    ok('a non-NBD tenant that set lateGraceDays 15 keeps 15', L.lateGraceDays === 15, String(L.lateGraceDays));
    ok('a field the tenant did not set is unset (null), even where NBD has a default', L.disputeDays === null && L.restockPct === null && L.claimNoticeDays === null, JSON.stringify(L));
    const CS = require('../functions/clause-set.js');
    const server = CS.paymentTermsFor({ lateInterestPct: 8, lateGraceDays: 15 }, false);
    ok('the server reads the same tenant the same way (8 and 15 kept, the rest unset)',
      server.lateInterestPct === 8 && server.lateGraceDays === 15 && server.disputeDays === null);
    ok('client _legal() and server paymentTermsFor agree field for field', CS.PT_FIELDS.every((k) => L[k] === server[k]));
    // another tenant, nothing set
    const env2 = H.docs({});
    await env2.win._saveCompanyProfile({ brand: { legalName: 'Elm Exteriors Inc' } });
    ok('a non-NBD tenant that set nothing has every field unset on the client', CS.PT_FIELDS.every((k) => env2.win._legal().paymentTerms[k] === null), JSON.stringify(env2.win._legal().paymentTerms));
    // NBD: untouched (defaults), and an NBD override still counts
    const env3 = H.docs({});
    await env3.win._saveCompanyProfile({ paymentTerms: { lateInterestPct: 6 } });
    const N = env3.win._legal().paymentTerms;
    ok('NBD keeps its defaults and its own override', N.lateInterestPct === 6 && N.lateGraceDays === 15 && N.restockPct === 15);
    // a later save for the tenant keeps what an earlier one set
    await W._saveCompanyProfile({ paymentTerms: { disputeDays: 10 } });
    const L2 = W._legal().paymentTerms;
    ok('a second save adds a field and keeps the first save\'s values', L2.disputeDays === 10 && L2.lateInterestPct === 8);
  }

  // @@SECTIONS@@

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
