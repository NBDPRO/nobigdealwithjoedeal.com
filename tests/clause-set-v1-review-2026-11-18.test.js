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

  // ═══════════════════════════════════════════════════════════════════════
  section('9. a key-less lead FAILS the v1 build (it never reads as NBD)');
  {
    const DE = require('../functions/doc-evidence.js');
    const KyLaw = require('../functions/ky-insurance-law.js');
    const lead = { address: H.OH_ADDR, jobType: 'cash' };
    const run = (key, l) => { try { return { cs: DE.buildClauseSet(KyLaw, l || lead, {}, {}, key, {}) }; } catch (e) { return { err: e }; } };
    ['', null, undefined, 0].forEach((k) => {
      const r = run(k);
      ok('tenant key ' + JSON.stringify(k) + ': buildClauseSet throws a refusal', !!r.err && r.err.clauseRefused === true && /tenant|company/i.test(String(r.err.message)), r.err && r.err.message);
    });
    ok('the NBD owner uid still builds', !!run(process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1').cs);
    ok('another tenant\'s key builds', !!run('tenantX').cs);
    class HE extends Error { constructor(c, m) { super(m); this.code = c; } }
    let he = null;
    try { DE.buildClauseSetFor(HE, KyLaw, lead, {}, {}, '', {}); } catch (e) { he = e; }
    ok('buildClauseSetFor turns it into a failed-precondition HttpsError', he instanceof HE && he.code === 'failed-precondition' && /Company Profile|company/i.test(he.message), he && he.message);
    ok('the callers build through buildClauseSetFor (esign envelope, deal page)',
      /DE\.buildClauseSetFor\(/.test(readRepo('functions/esign-envelope.js')) && /DE\.buildClauseSetFor\(/.test(readRepo('functions/deal-acceptance.js')));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('6. the server gate runs under EITHER flag (docEvidenceFoundation or docClauseSetV1), fail closed');
  {
    const FN = path.join(H.ROOT, 'functions');
    module.paths.unshift(path.join(FN, 'node_modules'));
    const kit = require('./lib/doc-evidence-kit');
    const K = require(path.join(FN, 'ky-insurance-law.js'));
    const DE = require(path.join(FN, 'doc-evidence.js'));
    const ESL = require(path.join(FN, 'esign-logic.js'));
    const P = 'documents/U1/L1/d-1.html';
    const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
      + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
      + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
      + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
      + '</section><!--nbd-cancel-packet:end-->'
      + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
    const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
    const leadX = { userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' };
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', 'crypto'];
    const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')) });
    const flagsDoc = (f) => f;
    const seed = (flags, html) => {
      const s = { 'leads/L1': leadX, 'leads/L1/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'U1' }, 'companyProfile/U1': PROFILE, 'estimates/E1': { grandTotal: 14500 } };
      if (flags) s['feature_flags/_default'] = flagsDoc(flags);
      return s;
    };
    const breakFlags = (db) => { const o = db.doc; db.doc = (p) => (/^feature_flags\//.test(p) ? { get: async () => { throw new Error('down'); } } : o(p)); };
    async function mint(flags, html, mod) {
      const db = kit.makeDb(seed(flags)); const st = kit.makeStorage({ [P]: html });
      if (mod) mod(db);
      const L = kit.loadHandler('remote-signing.js', db, st, stubs(), REAL);
      try { return { v: await L.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana Whitfield' } }), db }; }
      catch (e) { return { e, db }; }
    }
    const tokens = (db) => db._all('doc_sign_tokens').length;
    const UNRES = CONTRACT.replace('Roofing Contract</h1>', 'Roofing Contract</h1><p>interest at {{lateInterestPct}} percent</p>');

    let r = await mint({ docClauseSetV1: true }, UNRES);
    ok('remote: docClauseSetV1 alone: a contract with an unresolved {{number}} is refused, no link', !!r.e && r.e.code === 'failed-precondition' && /placeholder|lateInterestPct/.test(r.e.message) && tokens(r.db) === 0, r.e && r.e.message);
    r = await mint({ docClauseSetV1: true }, CONTRACT);
    ok('remote: docClauseSetV1 alone: a complete contract still goes out', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
    ok('remote: docClauseSetV1 alone does NOT turn the consent checkbox on (that stays docEvidenceFoundation)', (r.db._all('doc_sign_tokens')[0] || {}).consentAsked === false);
    r = await mint({ docEvidenceFoundation: true }, UNRES);
    ok('remote: docEvidenceFoundation alone still refuses (unchanged)', !!r.e && tokens(r.db) === 0);
    r = await mint(null, UNRES);
    ok('remote: both flags off: the same contract goes out (flag-off behaviour unchanged)', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
    r = await mint(null, UNRES, breakFlags);
    ok('remote: an unreadable flag refuses with a retryable "unavailable"', !!r.e && r.e.code === 'unavailable' && tokens(r.db) === 0, r.e && (r.e.code + ' ' + r.e.message));

    // in-person
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const mkIP = (flags) => {
      const s = { 'leads/L1': leadX, 'leads/L1/documents/d1': { type: 'contract', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: P }, 'estimates/E1': { grandTotal: 14500 }, 'companyProfile/U1': PROFILE };
      if (flags) s['feature_flags/_default'] = flags;
      return kit.makeDb(s);
    };
    const call = async (db, html) => {
      const st = kit.makeStorage({ [P]: html });
      const W = kit.loadHandler('in-person-signing.js', db, st, { './in-person-signing-logic': Lg, './doc-evidence': DE }, []);
      try { return { v: await W.fns.recordInPersonSignature({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1' }, rawRequest: { headers: { 'x-forwarded-for': '203.0.113.5' }, get: () => 'RepPhone/1' } }) }; }
      catch (e) { return { e }; }
    };
    let c = await call(mkIP({ docClauseSetV1: true }), UNRES);
    ok('in-person: docClauseSetV1 alone: a stored copy with an unresolved {{number}} is refused', !!c.e && /placeholder|lateInterestPct/.test(String(c.e.message)), c.e && c.e.message);
    c = await call(mkIP({ docClauseSetV1: true }), CONTRACT);
    ok('in-person: docClauseSetV1 alone: a complete copy records', !!c.v && c.v.ok === true, c.e && c.e.message);
    c = await call(mkIP(null), UNRES);
    ok('in-person: both flags off: unchanged (the same copy is accepted)', !!c.v, c.e && c.e.message);
    const dbB = mkIP({ docClauseSetV1: true }); breakFlags(dbB);
    c = await call(dbB, CONTRACT);
    ok('in-person: an unreadable flag is a retryable refusal', !!c.e && c.e.code === 'unavailable', c.e && c.e.code);
    ok('the server sources read both flags through the strict gate', /clauseFlagForGate|flagForGate/.test(readRepo('functions/remote-signing.js')) && /clauseFlagForGate/.test(readRepo('functions/in-person-signing.js')));
  }

  // @@SECTIONS@@

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
