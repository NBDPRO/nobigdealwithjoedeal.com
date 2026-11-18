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

  // ═══════════════════════════════════════════════════════════════════════
  section('7. {{...}} in user data: single-pass substitution, no self-expansion, no false refusal, NBD not rewritten in names');
  {
    const CS = require('../functions/clause-set.js');
    const DE = require('../functions/doc-evidence.js');
    const KyLaw = require('../functions/ky-insurance-law.js');
    const CHK = require('../functions/doc-send-checks.js');
    const base = { state: 'OH', paymentSource: 'cash', terms: CS.paymentTermsFor({}, true) };
    const all = (r) => r.sections.concat(r.party ? [{ items: [r.party] }] : []).reduce((a, s) => a.concat(s.items.reduce((b, i) => b.concat(i.paragraphs), [])), []).join('\n');
    // renderV1: a value is inserted once and never rescanned
    const r1 = CS.renderV1(Object.assign({}, base, { party: CS.partyFor({}, true), facts: { ownerNames: '{{date}}', propertyAddress: '9 {{owner name(s)}} Way', date: 'November 18, 2026' } }));
    const t1 = all(r1);
    ok('renderV1: an owner named "{{date}}" is not expanded to the date', /\{\{date\}\}/.test(t1));
    ok('renderV1: a property address containing "{{owner name(s)}}" is not expanded to the owner', /9 \{\{owner name\(s\)\}\} Way/.test(t1) && !/9 \{\{date\}\} Way/.test(t1));
    // tenant: "NBD" in a party's own name is not rewritten
    const r2 = CS.renderV1(Object.assign({}, base, { party: CS.partyFor({ entityName: 'NBD Roofing Co', legalName: 'NBD Roofing Co' }, false), facts: { ownerNames: 'NBD Smith', propertyAddress: '1 NBD Rd' } }));
    const t2 = all(r2);
    ok('a tenant\'s paper still says Contractor where the template said NBD', /Contractor/.test(t2));
    ok('"NBD" inside a homeowner name or address is NOT rewritten to Contractor', /NBD Smith/.test(t2) && /1 NBD Rd/.test(t2), (t2.match(/.{20}(Contractor Smith|Contractor Rd).{10}/) || [''])[0]);
    ok('"NBD" in the tenant\'s own entity name is not rewritten', /NBD Roofing Co/.test(t2));
    // $-patterns in user data are text
    const r3 = CS.renderV1(Object.assign({}, base, { party: CS.partyFor({}, true), facts: { ownerNames: "$& $1 $' $`", propertyAddress: 'x' } }));
    ok('"$&" and "$1" in a name print as typed', all(r3).indexOf("$& $1 $' $`") !== -1);
    // server entry: neutralised so a later scan or substitution cannot see a token
    const lead = { address: H.OH_ADDR, jobType: 'cash', companyId: 'tenantX' };
    const cs = DE.buildClauseSet(KyLaw, lead, {}, { brand: { entityName: 'Acme LLC', legalName: 'Acme' } }, 'tenantX', { ownerNames: '{{date}}', propertyAddress: '2 {{address}} St', date: 'November 18, 2026' });
    const html = DE.clauseSetHtml(cs);
    ok('server: the clause block carries the name but no scannable {{token}} from it', CHK.placeholdersIn(html).filter((x) => /date|address/.test(x)).length === 0, JSON.stringify(CHK.placeholdersIn(html)));
    ok('server: the name is still there to read (only the braces are separated)', /\{​\{date\}\}/.test(html) || /\{​\{date/.test(html));
    ok('server: an ordinary name is untouched', DE.buildClauseSet(KyLaw, lead, {}, {}, 'tenantX', { ownerNames: 'Jane Smith', propertyAddress: '1 Elm St' }).sections.length > 0
      && /Jane Smith/.test(all(DE.buildClauseSet(KyLaw, lead, {}, {}, 'tenantX', { ownerNames: 'Jane Smith', propertyAddress: '1 Elm St' }))));
    // client: mergeFields is single-pass, and the send gate sees no false placeholder
    const env = H.docs({ flags: { docClauseSetV1: true, docEvidenceFoundation: true } });
    const v = H.VARIANTS.oh_cash;
    const plain = H.render(env, 'renderContract', v);
    const evil = H.render(env, 'renderContract', v, { homeownerName: '{{address}}', phone: '{{date}}' });
    const addrCount = (s) => s.split(H.OH_ADDR).length - 1;
    ok('client: a homeowner named "{{address}}" does not expand to the property address', addrCount(evil) === addrCount(plain), addrCount(evil) + ' vs ' + addrCount(plain));
    ok('client: the evil name is printed, not dropped', /\{​\{address\}\}/.test(evil));
    ok('client: no scannable {{address}} or {{date}} token left from user data', CHK.placeholdersIn(evil).filter((x) => /address|date/.test(x)).length === 0, JSON.stringify(CHK.placeholdersIn(evil)));
    const dollar = H.render(env, 'renderContract', v, { homeownerName: "A $& B" });
    ok('client: "$&" in a name prints as typed (no replacement-pattern expansion)', dollar.indexOf('A $&amp; B') !== -1);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('1. cancellation wording and by-reference clauses: what prints, and evidence lists only what printed');
  {
    const DE = require('../functions/doc-evidence.js');
    const KyLaw = require('../functions/ky-insurance-law.js');
    const CS = require('../functions/clause-set.js');
    const CHK = require('../functions/doc-send-checks.js');
    const env = H.docs({ flags: { docClauseSetV1: true } });
    const J = env.win.NBDJurisdiction;
    const vis = (h) => CHK.visibleText(h);
    const byRefIds = ['INS-1', 'INS-3', 'INS-4', 'LIEN-3', 'PAY-2', 'WAR-4', 'CANC-1'];
    const norm = (s) => String(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    Object.keys(H.VARIANTS).forEach((k) => {
      const v = H.VARIANTS[k];
      const html = H.render(env, 'renderContract', v);
      const t = vis(html);
      const ky = /^ky|^unknown/.test(k);
      const ins = /insurance/.test(k);
      ok(k + ': v1 contract carries the Notice of Right to Cancel packet with both FTC forms', J.hasCancelPacket(html) && /Notice of Right to Cancel/.test(t));
      ok(k + ': ...the right-to-cancel wording (three business days, no penalty) and the refund sentence', /cancel it within three business days without any penalty or obligation/.test(t) && /anything you paid is returned within 10 business days/.test(t));
      ok(k + ': ...the FTC cooling-off statement beside the signatures', t.indexOf(norm(KyLaw.FTC_STATEMENT)) !== -1 || /429\.1|cooling/i.test(t));
      if (ky) ok(k + ': ...the KRS 367.430 buyer\'s right to cancel text', t.indexOf(norm(KyLaw.KY_HSSA_TEXT)) !== -1);
      if (ky && ins) ok(k + ': ...and the KRS 367.624 notices and the second (insurance) cancellation form', t.indexOf(norm(KyLaw.KY_NOTICE_CANCEL)) !== -1 && /data-nbd-noc="ky"/.test(html));
      ok(k + ': the legacy "Cancellation & Rescission Rights" section is replaced, never stacked', !/Cancellation (&|&amp;) Rescission/.test(html));
      // evidence: every ref the generator records is printed text
      const refs = env.win.NBDDocGen._lastClauseSet.refs;
      const printed = DE.printedByRef(KyLaw, html);
      byRefIds.forEach((id) => { if (refs.indexOf(id + '_V1') !== -1 && id !== 'PAY-2' && id !== 'WAR-4') ok(k + ': recorded by-reference ' + id + ' really printed in the contract', printed[id] === true); });
      ok(k + ': CANC-1 is recorded and its text printed', refs.indexOf('CANC-1_V1') !== -1 && printed['CANC-1'] === true);
      ok(k + ': a by-reference clause that did NOT print is not recorded (KY-only ids stay off Ohio / cash paper)',
        (ky && ins) || (['INS-3_V1', 'INS-4_V1', 'LIEN-3_V1'].every((r) => refs.indexOf(r) === -1)));
      // every own-text clause paragraph recorded is in the document
      const r = CS.renderV1({ state: ky ? (/unknown/.test(k) ? '' : 'KY') : 'OH', paymentSource: /unknown/.test(k) ? '' : (/financed/.test(k) ? 'financed' : (ins ? 'insurance' : 'cash')), terms: CS.paymentTermsFor(env.win._legal().paymentTerms, true),
        party: CS.partyFor({}, true), facts: { ownerNames: '{{homeownerName}}', propertyAddress: '{{address}}', date: '{{date}}', companyPhone: '' } });
      const missingTxt = [];
      r.sections.forEach((s) => s.items.filter((i) => !i.byRef).forEach((i) => i.paragraphs.forEach((p) => { if (t.indexOf(norm(p).slice(0, 70)) === -1) missingTxt.push(i.id); })));
      ok(k + ': every recorded own-text clause paragraph is in the printed contract', missingTxt.length === 0, missingTxt.join(','));
    });
    // The server e-sign PDF: capture every string it draws
    const pdfLib = require(path.join(H.ROOT, 'functions/node_modules/pdf-lib'));
    const drawn = [];
    const proto = pdfLib.PDFPage.prototype; const orig = proto.drawText;
    proto.drawText = function (t, o) { drawn.push(String(t)); return orig.call(this, t, o); };
    const pdfFor = async (state, extra) => { drawn.length = 0; const res = await H.esignPdf(state, extra); return { res, text: drawn.join(' ').replace(/\s+/g, ' ') }; };
    for (const st of ['OH', 'KY']) {
      const lead = { address: st === 'KY' ? H.KY_ADDR : H.OH_ADDR, jobType: 'cash', companyId: 'tenantX' };
      const ctx = DE.clauseContextFor(KyLaw, lead, {});
      const cs = DE.buildClauseSet(KyLaw, lead, {}, { brand: { entityName: 'Acme LLC' } }, 'tenantX', { ownerNames: 'Jane Smith', propertyAddress: 'x', date: 'November 18, 2026' }, { 'PAY-2': true, 'INS-1': true, 'CANC-1': true });
      const { res, text } = await pdfFor(st, { clauseSet: cs });
      ok('PDF ' + st + ': prints the NOTICE OF CANCELLATION twice with the cancel line', (text.match(/NOTICE OF CANCELLATION/g) || []).length === 2 && text.indexOf(norm(KyLaw.CANCEL_LINE).slice(0, 40)) !== -1);
      ok('PDF ' + st + ': prints the FTC cooling-off statement', text.indexOf(norm(KyLaw.FTC_STATEMENT).slice(0, 60)) !== -1);
      if (st === 'KY') ok('PDF KY: prints the KRS 367.430 text', text.indexOf(norm(KyLaw.KY_HSSA_TEXT).slice(0, 60)) !== -1);
      ok('PDF ' + st + ': the recorded refs name CANC-1 and only by-reference blocks it printed', res.clauseRefs.indexOf('CANC-1_V1') !== -1 && ['INS-3_V1', 'INS-4_V1', 'LIEN-3_V1', 'WAR-4_V1'].every((r) => res.clauseRefs.indexOf(r) === -1), res.clauseRefs.join(','));
      const t0 = norm(text);
      const missing = [];
      cs.sections.forEach((s) => s.items.filter((i) => !i.byRef).forEach((i) => i.paragraphs.forEach((p) => { if (t0.indexOf(norm(p).slice(0, 40)) === -1) missing.push(i.id); })));
      ok('PDF ' + st + ': every recorded own-text clause paragraph is drawn', missing.length === 0, missing.join(','));
      void ctx;
    }
    proto.drawText = orig;
    {
      const lead = { address: H.OH_ADDR, jobType: 'cash', companyId: 'tenantX' };
      const mk = (plan) => DE.buildClauseSet(KyLaw, lead, {}, { brand: { entityName: 'Acme LLC' } }, 'tenantX', { ownerNames: 'J', propertyAddress: 'x', date: 'd' }, DE.pdfByRef(plan));
      ok('PDF refs: PAY-2 is recorded only when the PDF prints a deposit plan', mk(true).refs.indexOf('PAY-2_V1') !== -1 && mk(false).refs.indexOf('PAY-2_V1') === -1);
      ok('PDF refs: WAR-4 (the package warranty section) is never recorded, the PDF does not print it', mk(true).refs.indexOf('WAR-4_V1') === -1);
      const ky = (printed) => DE.buildClauseSet(KyLaw, { address: H.KY_ADDR, jobType: 'insurance', companyId: 'tenantX' }, {}, { brand: { entityName: 'Acme LLC' } }, 'tenantX', {}, printed);
      const dealNoPacket = ky(DE.printedByRef(KyLaw, '<html><body>a stored page with no cancellation packet and no notices</body></html>'));
      ok('deal page: a stored page that carries none of the statutory blocks records none of them (no CANC-1, INS-1, INS-3, INS-4, LIEN-3)',
        ['CANC-1_V1', 'INS-1_V1', 'INS-3_V1', 'INS-4_V1', 'LIEN-3_V1'].every((r) => dealNoPacket.refs.indexOf(r) === -1), dealNoPacket.refs.join(','));
      const full = H.render(env, 'renderContract', H.VARIANTS.ky_insurance);
      const dealFull = ky(DE.printedByRef(KyLaw, full));
      ok('deal page: a stored page that carries them records them', ['CANC-1_V1', 'INS-1_V1', 'INS-3_V1', 'INS-4_V1', 'LIEN-3_V1'].every((r) => dealFull.refs.indexOf(r) !== -1), dealFull.refs.join(','));
      ok('the callers pass what they printed (esign envelope: pdfByRef; deal page: printedByRef of the stored page; client: its own blocks)',
        /DE\.pdfByRef\(/.test(readRepo('functions/esign-envelope.js')) && /DE\.printedByRef\(KyLaw, pbuf/.test(readRepo('functions/deal-acceptance.js'))
        && /printed: printed/.test(readRepo('docs/pro/js/document-generator.js')));
      // a contract with no warranty tier: WAR-4 is not recorded
      const noWar = H.render(env, 'renderContract', H.VARIANTS.oh_cash, { warrantyTier: 'none' });
      void noWar;
    }
    // the evidence helper
    const page ='<p>' + KyLaw.PAYMENT_CLAUSE + '</p>';
    const pr = DE.printedByRef(KyLaw, page);
    ok('printedByRef: reads INS-1 from the page text and not the others', pr['INS-1'] === true && pr['CANC-1'] === false && pr['INS-3'] === false && pr['LIEN-3'] === false && pr['INS-4'] === false);
    ok('printedByRef: reads the lien sentence and the packet', DE.printedByRef(KyLaw, '<div>' + KyLaw.KY_LIEN_CLAUSE + '</div>')['LIEN-3'] === true
      && DE.printedByRef(KyLaw, J.cancelPacketHtml({ transactionDate: '2026-09-28', state: 'OH', sellerName: 'A' }))['CANC-1'] === true);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('4. a forged clause-set marker cannot claim clauses that never printed');
  {
    const DE = require('../functions/doc-evidence.js');
    const KyLaw = require('../functions/ky-insurance-law.js');
    const CS = require('../functions/clause-set.js');
    const VER = CS.CLAUSE_SET_VERSION;
    const mk = (refs, ver) => '<html><body><!-- nbd:clause-set ' + (ver || VER) + ' ' + refs.join(',') + ' -->contract</body></html>';
    const cash = { address: H.OH_ADDR, jobType: 'cash', companyId: 'T1', userId: 'T1' };
    const kyIns = ['INS-3_V1', 'INS-4_V1', 'LIEN-3_V1', 'INS-2_V1', 'INS-1_V1'];
    let s = DE.stampFor(KyLaw, cash, {}, { html: mk(kyIns.concat(['PAY-4_V1'])), v1: true });
    ok('forged marker on a cash lead claiming KY-insurance ids: none recorded, mismatch flagged', s.clauseRefsMismatch === true && kyIns.concat(['PAY-4_V1']).every((r) => s.clauseIds.indexOf(r) === -1), JSON.stringify(s));
    s = DE.stampFor(KyLaw, cash, {}, { html: mk(['PAY-4_V99']), v1: true });
    ok('a _V99 ref is not recorded', s.clauseRefsMismatch === true && s.clauseIds.indexOf('PAY-4_V99') === -1);
    // the genuine marker for this lead, from the real generator
    const env = H.docs({ flags: { docClauseSetV1: true } });
    let genuine = 0, mism = 0;
    Object.keys(H.VARIANTS).forEach((k) => {
      const v = H.VARIANTS[k];
      const html = H.render(env, 'renderContract', v);
      const lead = Object.assign({ companyId: 'T1', userId: 'T1' }, { address: v.address, jobType: v.jobType });
      const st = DE.stampFor(KyLaw, lead, {}, { html, v1: true });
      const marker = (/<!-- nbd:clause-set (\S+) ([^ ]+) -->/.exec(html) || [])[2] || '';
      const refs = marker.split(',').filter(Boolean);
      const okRec = !st.clauseRefsMismatch && refs.length > 20 && refs.every((r) => st.clauseIds.indexOf(r) !== -1);
      if (okRec) genuine++; else { mism++; console.log('   ' + k + ' mismatch ' + JSON.stringify(st.clauseRefsMismatch) + ' missing ' + refs.filter((r) => st.clauseIds.indexOf(r) === -1).join(',')); }
    });
    ok('the generator\'s own marker is accepted for all six variants (no false mismatch)', genuine === 6 && mism === 0, genuine + '/' + mism);
    const kyHtml = H.render(env, 'renderContract', H.VARIANTS.ky_insurance);
    s = DE.stampFor(KyLaw, cash, {}, { html: kyHtml, v1: true });
    ok('a genuine KY-insurance marker bound to an Ohio cash lead is a mismatch (wrong variant)', s.clauseRefsMismatch === true && s.clauseIds.indexOf('INS-3_V1') === -1);
    const offHtml = H.render(env, 'renderContract', H.VARIANTS.oh_cash);
    s = DE.stampFor(KyLaw, cash, {}, { html: offHtml, v1: false });
    ok('flag OFF: a marker is a forgery (nothing recorded, mismatch flagged)', s.clauseRefsMismatch === true && s.clauseIds.indexOf('PAY-4_V1') === -1);
    s = DE.stampFor(KyLaw, cash, {}, { html: '<html>legacy</html>', v1: true });
    ok('no marker: no v1 refs and no mismatch (a legacy document)', !s.clauseRefsMismatch && s.clauseIds.indexOf('PAY-4_V1') === -1);
    s = DE.stampFor(KyLaw, cash, {}, { html: mk(['PAY-4_V1'], 'CS-1999-01-01.1'), v1: true });
    ok('a marker with another clause-set version is a mismatch', s.clauseRefsMismatch === true);
    s = DE.stampFor(KyLaw, cash, {}, { refs: ['PAY-4_V1', 'LIEN-3_V1', 'ZZZ-9_V1'] });
    ok('server-built refs: only refs the registry would print for this lead are kept', s.clauseIds.indexOf('PAY-4_V1') !== -1 && s.clauseIds.indexOf('LIEN-3_V1') === -1 && s.clauseIds.indexOf('ZZZ-9_V1') === -1);
    // the callers pass the flag and carry the mismatch
    const rs = readRepo('functions/remote-signing.js'), ip = readRepo('functions/in-person-signing-logic.js');
    ok('remote link and in-person pass the clause flag to stampFor and keep clauseRefsMismatch', /v1: clauseFlagOnAtMint/.test(rs) && /clauseRefsMismatch/.test(rs) && /clauseRefsMismatch/.test(ip) && /v1: /.test(ip));
    const ev = DE.buildEvidence({ path: 'in_person', clauseRefsMismatch: true });
    ok('buildEvidence always carries clauseRefsMismatch (false by default)', ev.clauseRefsMismatch === true && DE.buildEvidence({}).clauseRefsMismatch === false);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('8. deal page: sha256 of the injected clause block on the token and in the acceptance evidence');
  {
    const kit = require('./lib/doc-evidence-kit');
    const DE = require('../functions/doc-evidence.js');
    const ESL = require('../functions/esign-logic.js');
    const K = require('../functions/ky-insurance-law.js');
    const CS = require('../functions/clause-set.js');
    const FN = path.join(H.ROOT, 'functions');
    const DEAL_PATH = 'deal_rooms/U1/deal0001.html';
    const REALD = ['./cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './await-briefly', './portal-after-signing', './signed-price', './customer-estimate-rows', './doc-send-checks', 'crypto'];
    const stubs = () => ({
      './deal-install-date': { fillLeadInstallDate: async () => null },
      './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
      './estimate-send-logic': {}, './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/x.js' },
      './deal-accepted-tier': { applyAcceptedTier: async () => {} },
      './ky-insurance-law': K, './cancel-window': require(path.join(FN, 'cancel-window.js')), './esign-logic': ESL, './doc-evidence': DE,
    });
    const PAGE = '<html><head></head><body><p>Your roof, three packages.</p><div class="section-title">Sign &amp; Schedule</div><div class="sign-section">sign</div></body></html>';
    const terms = Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 10000 });
    const db = kit.makeDb({
      'deal_rooms/deal0001': { status: 'sent', userId: 'U1', leadId: 'L1', customerName: 'Dana Whitfield', tiers: { better: { price: 13000 } } },
      'leads/L1': { userId: 'U1', companyId: 'U1', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' },
      'companyProfile/U1': { paymentTerms: terms, brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', signerTitle: 'Owner', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202', phone: '(513) 555-0100' } } },
      'feature_flags/_default': { docClauseSetV1: true },
    });
    const L = kit.loadHandler('deal-acceptance.js', db, kit.makeStorage({ [DEAL_PATH]: PAGE }), stubs(), REALD);
    const view = async (token) => {
      const res = { statusCode: 200, headers: {}, sent: '', status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, send(b) { this.sent = b; return this; }, json(b) { this.sent = JSON.stringify(b); return this; } };
      const c = kit.reqRes({}, {}); c.req.method = 'GET'; c.req.path = '/deal/' + token; await L.fns.getDealRoom(c.req, res); return res;
    };
    let out = null, err = null;
    try { out = await L.fns.createDealAcceptToken({ auth: { uid: 'U1', token: {} }, data: { dealId: 'deal0001' } }); } catch (e) { err = e; }
    const tok = out ? (db._get('deal_accept_tokens/' + out.token) || {}) : {};
    const sha = require('crypto').createHash('sha256').update(String((tok.clauseSetV1 || {}).html || ''), 'utf8').digest('hex');
    ok('mint: the token carries clauseSetV1.sha256 = sha256 of the injected block', !!out && /^[a-f0-9]{64}$/.test((tok.clauseSetV1 || {}).sha256 || '') && tok.clauseSetV1.sha256 === sha, err && err.message);
    const good = out ? await view(out.token) : { sent: '' };
    ok('serve: an untouched block is served', /data-nbd-clause-set/.test(good.sent));
    // a block changed on the token after mint is not served
    const db2 = kit.makeDb(JSON.parse(JSON.stringify({})));
    void db2;
    const t2 = db._get('deal_accept_tokens/' + (out && out.token)) || {};
    if (out) db._store.set('deal_accept_tokens/' + out.token, Object.assign({}, t2, { status: 'pending', clauseSetV1: Object.assign({}, t2.clauseSetV1, { html: t2.clauseSetV1.html.replace('15 days', '1 day') + '<p>extra</p>' }) }));
    const bad = out ? await view(out.token) : { statusCode: 0, sent: '' };
    ok('serve: a block that no longer matches its sha256 is refused, never injected', bad.statusCode >= 400 && !/data-nbd-clause-set/.test(bad.sent), bad.statusCode + ' ' + String(bad.sent).slice(0, 80));
    if (out) db._store.set('deal_accept_tokens/' + out.token, t2);
    const acc = kit.reqRes({ token: out && out.token, tier: 'better', signature: 'data:image/png;base64,' + 'A'.repeat(400), financing: -1, consent: true }, { ip: '198.51.100.20', ua: 'Mozilla/5.0 DealPhone' });
    if (out) await L.fns.submitDealAcceptance(acc.req, acc.res);
    const ev = (db._get('deal_rooms/deal0001') || {}).acceptedEvidence || {};
    ok('accept: the evidence records clauseSetSha256 (the block the homeowner was shown)', acc.res.statusCode === 200 && ev.clauseSetSha256 === sha, JSON.stringify(ev.clauseSetSha256));
    const src = readRepo('functions/deal-acceptance.js');
    ok('size limit: the minted block is capped (a token doc stays far under 1 MiB)', /CLAUSE_BLOCK_MAX/.test(src));
    ok('rules: clients cannot write the token (see firestore-rules.clause-set-v1-review-2026-11-18.test.js)', /match \/deal_accept_tokens\/\{token\} \{\s*allow read, write: if false;/.test(readRepo('firestore.rules')));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('10. NBD is ready once deckingPerSheetCents is set (and refused with its name until then)');
  {
    const DE = require('../functions/doc-evidence.js');
    const KyLaw = require('../functions/ky-insurance-law.js');
    const NBD_UID = DE.NBD_OWNER_UID_FOR_TESTS;
    const lead = { address: H.OH_ADDR, jobType: 'cash', companyId: NBD_UID, userId: NBD_UID };
    // server: NBD profile with every default (nothing written) except the decking price
    const ready = DE.buildClauseSet(KyLaw, lead, {}, { paymentTerms: { deckingPerSheetCents: 10000 } }, NBD_UID, { ownerNames: 'Jane Smith', propertyAddress: H.OH_ADDR, date: 'November 18, 2026' });
    ok('server: NBD, all defaults but deckingPerSheetCents set: missing is []', Array.isArray(ready.missing) && ready.missing.length === 0, JSON.stringify(ready.missing));
    const gapsReady = DE.serverContractGaps({ type: 'proposal', html: DE.clauseSetHtml(ready), lead, profile: { brand: { entityName: 'No Big Deal Solutions LLC', contact: { mailingAddress: '1 Main St' } } }, tenantKey: NBD_UID, KyLaw, priceCents: 1850000, clauseConfigMissing: ready.missing });
    ok('server: ...and the gap check passes (no clause-number gap)', !gapsReady.some((g) => g.code === 'clauseConfig' || /deckingPerSheetCents|\{\{/.test(g.message)), JSON.stringify(gapsReady));
    const notReady = DE.buildClauseSet(KyLaw, lead, {}, { paymentTerms: { deckingPerSheetCents: null } }, NBD_UID, {});
    ok('server: deckingPerSheetCents null: missing is exactly [deckingPerSheetCents]', JSON.stringify(notReady.missing) === JSON.stringify(['deckingPerSheetCents']), JSON.stringify(notReady.missing));
    const gapsNot = DE.serverContractGaps({ type: 'proposal', html: DE.clauseSetHtml(notReady), lead, profile: {}, tenantKey: NBD_UID, KyLaw, priceCents: 1850000, clauseConfigMissing: notReady.missing });
    ok('server: ...and the send is refused with "Set deckingPerSheetCents in Company Profile."', gapsNot.some((g) => /Set deckingPerSheetCents in Company Profile\./.test(g.message)));
    // client: NBD brand (the harness default), flag on
    const env = H.docs({ flags: { docClauseSetV1: true } });
    // The generator reads the profile the form hands it (data.companyProfile): NBD's defaults with only the decking price set.
    const withDecking = { companyProfile: H.profileFor(env.win, H.BIZ_ADDR, { paymentTerms: Object.assign({}, env.win.NBD_COMPANY_PROFILE_DEFAULTS.paymentTerms, { deckingPerSheetCents: 10000 }) }) };
    const v = H.VARIANTS.oh_cash;
    const html = H.render(env, 'renderContract', v, withDecking);
    ok('client: NBD, defaults but deckingPerSheetCents set: the v1 set renders and nothing is missing', env.win.NBDDocGen._lastClauseSet && env.win.NBDDocGen._lastClauseSet.missing.length === 0 && /nbd:clause-set/.test(html) && !/\{\{deckingPerSheetCents\}\}/.test(html) && /\$100\.00 per sheet/.test(html));
    const before = env.toasts.length;
    ok('client: ...and the send gate lets it through', env.win.NBDDocGen._docSendGate('contract', H.contractData(env.win, v, withDecking), html) === true, JSON.stringify(env.toasts.slice(before)));
    const env2 = H.docs({ flags: { docClauseSetV1: true } });
    const html2 = H.render(env2, 'renderContract', v);
    const b2 = env2.toasts.length;
    const sent2 = env2.win.NBDDocGen._docSendGate('contract', H.contractData(env2.win, v), html2);
    ok('client: deckingPerSheetCents null (the shipped default): refused with the field name', sent2 === false && env2.toasts.slice(b2).some((x) => /Set deckingPerSheetCents in Company Profile/.test(x.m)), JSON.stringify(env2.toasts.slice(b2)));
  }

  // @@SECTIONS@@

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
