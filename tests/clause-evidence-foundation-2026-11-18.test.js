/**
 * tests/clause-evidence-foundation-2026-11-18.test.js
 *
 * Phase 1 of the template/liability overhaul (Jo, 2026-11-18): the clause
 * registry, evidence parity on every signing path, fail-closed send checks
 * (flag docEvidenceFoundation, default OFF), and the legal-entity fields.
 * Adds NO new legal wording. Design + how to turn on:
 * documentation/projects/CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md
 *
 *   A  clause registry + byte-identical twins
 *   B  evidence on envelope / deal room / in-person / remote link
 *   C  fail-closed send checks (shared module, generator, server PDF, envelope)
 *   D  brand.entityName / dbaName / signerTitle (data only)
 *
 * Every section loads its subject defensively, so on code without this change
 * each assertion FAILS (rather than the file crashing).
 * Run: node tests/clause-evidence-foundation-2026-11-18.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const JS = path.join(ROOT, 'docs/pro/js');
module.paths.unshift(path.join(FN, 'node_modules'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
function tryReq(p) { try { return require(p); } catch (_) { return null; } }
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; } };
const lf = (txt) => (txt == null ? null : txt.replace(/\r\n/g, '\n'));

const K = require(path.join(FN, 'ky-insurance-law.js'));
const CS = tryReq(path.join(FN, 'clause-set.js'));
const CHK = tryReq(path.join(FN, 'doc-send-checks.js'));
const DE = tryReq(path.join(FN, 'doc-evidence.js'));
const ESL = require(path.join(FN, 'esign-logic.js'));
let kit = null; try { kit = require('./lib/doc-evidence-kit'); } catch (_) { kit = null; }

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  section('A. the clause registry');
  {
    ok('clause-set.js: server copy is the browser copy, byte for byte',
      lf(read('docs/pro/js/clause-set.js')) !== null && lf(read('docs/pro/js/clause-set.js')) === lf(read('functions/clause-set.js')));
    ok('doc-send-checks.js: server copy is the browser copy, byte for byte',
      lf(read('docs/pro/js/doc-send-checks.js')) !== null && lf(read('docs/pro/js/doc-send-checks.js')) === lf(read('functions/doc-send-checks.js')));
    ok('CLAUSE_SET_VERSION has the CS-YYYY-MM-DD.n shape', !!CS && /^CS-\d{4}-\d{2}-\d{2}\.\d+$/.test(CS.CLAUSE_SET_VERSION));
    const all = CS ? CS.all() : [];
    ok('six clauses are registered, each with id, integer version and ref', all.length === 6 && all.every((c) => c.id && Number.isInteger(c.version) && c.ref === c.id + '_V' + c.version));
    const byId = (id) => all.find((c) => c.id === id) || {};
    ok('PAYMENT is the shipped Payment clause, not a copy', byId('PAYMENT').text === K.PAYMENT_CLAUSE && K.PAYMENT_CLAUSE.length > 50);
    ok('FTC statement, KY home-solicitation text, KY notices and KY lien are the shipped constants',
      byId('FTC_COOLING_OFF').text === K.FTC_STATEMENT && byId('KY_HOME_SOLICITATION').text === K.KY_HSSA_TEXT
      && byId('KY_INS_NOTICE_CANCEL').text === K.KY_NOTICE_CANCEL && byId('KY_INS_NOTICE_NO_ASSIGNMENT').text === K.KY_NOTICE_NO_ASSIGNMENT
      && byId('KY_INS_LIEN').text === K.KY_LIEN_CLAUSE);
    const clauseSrc = read('functions/clause-set.js') || '';
    ok('the module retypes no sentence (no string literal over 40 characters)', clauseSrc.length > 0 && !/(['"])(?:(?!\1)[^\\\n]){41,}\1/.test(clauseSrc));
    const refs = (o) => (CS ? CS.describeFor(o).clauses.map((c) => c.ref).join(',') : 'none');
    ok('Ohio cash: payment + FTC only', refs({ state: 'OH', paymentSource: 'cash' }) === 'PAYMENT_V1,FTC_COOLING_OFF_V1');
    ok('Ohio financed: same', refs({ state: 'OH', paymentSource: 'financed' }) === 'PAYMENT_V1,FTC_COOLING_OFF_V1');
    ok('Ohio insurance: no Kentucky notices', refs({ state: 'OH', paymentSource: 'insurance' }) === 'PAYMENT_V1,FTC_COOLING_OFF_V1');
    ok('Kentucky cash adds the home-solicitation statement', refs({ state: 'KY', paymentSource: 'cash' }) === 'PAYMENT_V1,FTC_COOLING_OFF_V1,KY_HOME_SOLICITATION_V1');
    const kyIns = refs({ state: 'KY', paymentSource: 'insurance' });
    ok('Kentucky insurance carries all six', kyIns.split(',').length === 6 && /KY_INS_LIEN_V1/.test(kyIns));
    const unk = CS ? CS.describeFor({}) : {};
    ok('unknown state + unknown source = the strict Kentucky-insurance set, flagged failClosed', unk.failClosed === true && unk.clauses && unk.clauses.length === 6);
    ok('a state name works ("Kentucky"), garbage state is unknown', refs({ state: 'Kentucky', paymentSource: 'cash' }).includes('KY_HOME') && CS && CS.describeFor({ state: 'zz!', paymentSource: 'cash' }).failClosed === true);
    ok('describeFor carries the version', !!CS && CS.describeFor({ state: 'OH', paymentSource: 'cash' }).clauseSetVersion === CS.CLAUSE_SET_VERSION);
    // the browser global
    const win = { }; win.window = win;
    const sb = { window: win, console: { log() {} } }; vm.createContext(sb);
    try {
      vm.runInContext(fs.readFileSync(path.join(JS, 'ky-insurance-law.js'), 'utf8'), sb);
      vm.runInContext(fs.readFileSync(path.join(JS, 'clause-set.js'), 'utf8'), sb);
    } catch (_) { /* absent on old code */ }
    ok('browser: window.NBDClauseSet answers like the server copy',
      !!win.NBDClauseSet && JSON.stringify(win.NBDClauseSet.describeFor({ state: 'KY', paymentSource: 'insurance' })) === JSON.stringify(CS && CS.describeFor({ state: 'KY', paymentSource: 'insurance' })));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('C1. the shared fail-closed check');
  {
    const good = { type: 'contract', priceCents: 1200000, address: '1 A St', homeownerName: 'Jo', mailingAddress: '2 B St', needsMailingAddress: true, entityName: 'X LLC', startDate: 'x', estimatedCompletion: 'y', text: '<p>fine [ ] [x]</p>' };
    const gaps = (o) => (CHK ? CHK.contractGaps(Object.assign({}, good, o)).map((g) => g.code).join(',') : 'none');
    ok('a complete contract has no gaps', gaps({}) === '');
    ok('price blank / zero / negative / NaN', ['price'].every(() => gaps({ priceCents: null }) === 'price' && gaps({ priceCents: 0 }) === 'price' && gaps({ priceCents: -5 }) === 'price' && gaps({ priceCents: NaN }) === 'price'));
    ok('address blank (whitespace and NBSP too)', gaps({ address: '' }) === 'address' && gaps({ address: '    ' }) === 'address');
    ok('homeowner name blank', gaps({ homeownerName: null }) === 'homeownerName');
    ok('mailing address blank only matters when the document needs one', gaps({ mailingAddress: '' }) === 'mailingAddress' && gaps({ mailingAddress: '', needsMailingAddress: false }) === '');
    ok('legal entity name blank', gaps({ entityName: '' }) === 'entityName');
    ok('start and completion blank on a contract', gaps({ startDate: '' }) === 'startDate' && gaps({ estimatedCompletion: '' }) === 'estimatedCompletion');
    ok('a work authorization has no price or schedule check', gaps({ type: 'work_authorization', priceCents: null, startDate: '', estimatedCompletion: '' }) === '');
    ok('the e-sign estimate PDF is priced, with no schedule check', gaps({ type: 'estimate_esign', priceCents: 0, startDate: '' }) === 'price');
    ok('[Bracket Placeholder] is caught', gaps({ text: '<p>Owner: [Homeowner Name]</p>' }) === 'placeholder');
    ok('{{unresolved}} is caught, also inside tags and entities', gaps({ text: '<td>{{ totalPrice }}</td>' }) === 'placeholder');
    ok('a placeholder inside <script>/<style>/comments is not visible text', gaps({ text: '<style>a{}[Foo]</style><script>var a=[Bar];</script><!-- [Baz] -->ok' }) === '');
    ok('checkbox glyphs and lower-case brackets are not placeholders', gaps({ text: '[ ] [x] [see below] [1]' }) === '');
    ok('several problems are all listed, in plain words', !!CHK && /price is blank/.test(CHK.describeGaps(CHK.contractGaps({ type: 'contract' }))) && /address is blank/.test(CHK.describeGaps(CHK.contractGaps({ type: 'contract' }))));
    ok('isContractClass: contract, proposal, work authorization, e-sign estimate; not an invoice', !!CHK && ['contract', 'proposal', 'work_authorization', 'estimate_esign'].every(CHK.isContractClass) && !CHK.isContractClass('invoice') && !CHK.isContractClass('receipt'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('C2. NBDDocGen.generate refuses a contract with a hole (flag on) and is unchanged (flag off)');
  {
    function env(flagOn, brandX) {
      const brand = Object.assign({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: { mailingAddress: '4400 Test Pike, Cincinnati, OH 45202' } }, brandX || {});
      const toasts = []; const opened = [];
      const win = { _brand: () => brand, _companyProfileLoaded: true, NBDFlags: { enabled: (n) => flagOn && n === 'docEvidenceFoundation' },
        NBDDocViewer: { open: (o) => opened.push(o) } };
      win.showToast = (m, t) => toasts.push([t, m]);
      win.window = win;
      const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
      const sb = { window: win, showToast: win.showToast, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
        console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Intl, TextEncoder };
      vm.createContext(sb);
      for (const f of ['ky-insurance-law.js', 'doc-send-checks.js', 'deposit-rule.js', 'estimate-config.js', 'tenant-rules.js', 'document-generator.js', 'document-generator-templates.js', 'document-generator-library.js', 'doc-preflight.js']) {
        try { vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f }); } catch (_) { /* doc-send-checks.js absent on old code */ }
      }
      return { win, toasts, opened };
    }
    const signers = [{ role: 'homeowner', label: 'Homeowner', required: true }];
    const good = { homeownerName: 'Jane Smith', address: '12 Oak St, Cincinnati, OH 45202', totalPrice: '$12,000.00', contractPrice: '$12,000.00', startDate: '2026-12-01', estimatedCompletion: '5-7 business days', signers };
    const NBDX = { entityName: 'No Big Deal Solutions LLC' };
    async function run(flag, type, data, brandX) {
      const e = env(flag, brandX);
      await e.win.NBDDocGen.generate(type, Object.assign({}, data));
      return e;
    }
    let e = await run(false, 'contract', { signers });
    ok('flag OFF: a blank contract still opens (nothing changed)', e.opened.length === 1 && e.toasts.length === 0);
    e = await run(true, 'contract', { signers }, NBDX);
    ok('flag ON: a blank contract is refused, nothing opens', e.opened.length === 0);
    ok('...with one error listing price, address and name', e.toasts.length === 1 && e.toasts[0][0] === 'error' && /price/.test(e.toasts[0][1]) && /address/.test(e.toasts[0][1]) && /homeowner name/.test(e.toasts[0][1]));
    e = await run(true, 'contract', good, NBDX);
    ok('flag ON: a complete contract opens', e.opened.length === 1 && e.toasts.length === 0, JSON.stringify(e.toasts));
    e = await run(true, 'contract', good, {});
    ok('flag ON: no legal entity name = refused', e.opened.length === 0 && /legal entity name/.test((e.toasts[0] || [])[1] || ''));
    e = await run(true, 'contract', good, Object.assign({ contact: { mailingAddress: '' } }, NBDX));
    ok('flag ON: no company mailing address = refused', e.opened.length === 0 && /mailing address/.test((e.toasts[0] || [])[1] || ''));
    e = await run(true, 'contract', Object.assign({}, good, { totalPrice: '$0.00', contractPrice: '' }), NBDX);
    ok('flag ON: a $0.00 price = refused', e.opened.length === 0 && /price/.test((e.toasts[0] || [])[1] || ''));
    e = await run(true, 'contract', Object.assign({}, good, { startDate: '', estimatedCompletion: '' }), NBDX);
    ok('flag ON: blank start and completion = refused', e.opened.length === 0 && /start date/.test((e.toasts[0] || [])[1] || '') && /completion/.test((e.toasts[0] || [])[1] || ''));
    e = await run(true, 'contract', Object.assign({}, good, { projectDescription: 'Replace roof at [Property Address]' }), NBDX);
    ok('flag ON: a [Bracket] token left in the rendered text = refused', e.opened.length === 0 && /\[Property Address\]/.test((e.toasts[0] || [])[1] || ''));
    e = await run(true, 'work_authorization', Object.assign({}, good), NBDX);
    ok('flag ON: a work authorization with its fields filled opens', e.opened.length === 1, JSON.stringify(e.toasts));
    e = await run(true, 'work_authorization', { signers }, NBDX);
    ok('flag ON: a work authorization with [Homeowner Name] / [Property Address] is refused', e.opened.length === 0);
    e = await run(true, 'proposal', { homeownerName: 'Jane Smith', address: '12 Oak St, Cincinnati, OH 45202', totalPrice: '', signers }, NBDX);
    ok('flag ON: a proposal with no price is refused', e.opened.length === 0 && /price/.test((e.toasts[0] || [])[1] || ''));
    e = await run(true, 'contract', Object.assign({ _isBlankPreview: true }, { signers }), NBDX);
    ok('flag ON: a blank PREVIEW is still allowed (a look, not a send)', e.opened.length === 1);
    e = await run(true, 'receipt', { homeownerName: '', signers }, NBDX);
    ok('flag ON: a non-contract document (receipt) is untouched', e.toasts.every((t) => !/cannot be sent or signed/.test(t[1])));
    // pre-flight reuses the same gate
    ok('pre-flight asks the same gate before it persists or closes', /_docSendGate\(state\.type, mergedData[\s\S]*await applyDocEdits\(state\.customerId/.test(read('docs/pro/js/doc-preflight.js') || ''));
    ok('the docgen bundle loads doc-send-checks.js', /doc-send-checks\.js\?v=\d+/.test(read('docs/pro/js/script-loader.js') || ''));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('C3. server: the e-sign estimate PDF and sendEstimateEnvelope');
  {
    const PDF = tryReq(path.join(FN, 'estimate-esign-pdf.js'));
    const base = { companyName: 'Acme Roofing LLC', sellerAddress: '1 Main St, Cincinnati, OH 45202', title: 'Roofing Contract', estimateNumber: '1',
      customer: { name: 'Pat Smith', address: '5 Vine St, Cincinnati, OH 45202', phone: '', email: '' }, lines: [], totalCents: 1234567,
      depositPlan: null, signers: [{ id: 'signer', name: 'Pat Smith' }], state: 'OH', entityName: 'Acme Roofing LLC' };
    async function build(o) { try { return { r: await PDF.buildEstimateContractPdf(Object.assign({}, base, o)) }; } catch (e) { return { e }; } }
    let b = await build({ totalCents: 0 });
    ok('flag OFF behaviour is unchanged: a $0.00 contract still builds', !!b.r);
    b = await build({ totalCents: 0, failClosed: true });
    ok('failClosed: a $0.00 total is refused with the gap list', !!(b.e && b.e.gaps && b.e.gaps.some((g) => g.code === 'price')));
    b = await build({ customer: { name: 'Pat', address: '' }, failClosed: true });
    ok('failClosed: a blank property address is refused', !!(b.e && b.e.gaps && b.e.gaps.some((g) => g.code === 'address')));
    b = await build({ sellerAddress: '', failClosed: true });
    ok('failClosed: a blank mailing address (underscore blanks) is refused', !!(b.e && b.e.gaps && b.e.gaps.some((g) => g.code === 'mailingAddress')));
    b = await build({ entityName: '', failClosed: true });
    ok('failClosed: no legal entity name is refused', !!(b.e && b.e.gaps && b.e.gaps.some((g) => g.code === 'entityName')));
    b = await build({ failClosed: true });
    ok('failClosed: a complete contract builds', !!b.r && b.r.bytes && b.r.bytes.length > 1000);

    // the real handler
    if (!kit || !DE) { ok('envelope harness available', false, 'kit or doc-evidence missing'); }
    else {
      const UID = 'UID_OWNER';
      const NBD_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';
      const STUBS = () => ({
        './esign-stamp': require(path.join(FN, 'esign-stamp.js')), './esign-logic': ESL, './doc-evidence': DE,
        './estimate-esign-pdf': PDF, './ky-insurance-law': K, './customer-estimate-rows': require(path.join(FN, 'customer-estimate-rows.js')),
        './deposit-plan-view': require(path.join(FN, 'deposit-plan-view.js')), './cancel-window': require(path.join(FN, 'cancel-window.js')),
        './cancel-notice-pdf': require(path.join(FN, 'cancel-notice-pdf.js')), './integrations/heartbeat': { onSchedule: (o, h) => h },
      });
      function load(db, st) {
        const stubset = STUBS();
        const io = kit.loadHandler('esign-io.js', db, st, stubset, []).fns;
        const L = kit.loadHandler('esign-envelope.js', db, st, Object.assign({ './esign-io': io }, stubset), []);
        return L;
      }
      const lead = (uid) => ({ userId: uid, companyId: uid, firstName: 'Pat', lastName: 'Smith', address: '5 Vine St, Cincinnati, OH 45202', phone: '513-555-0101', email: 'pat@example.test', jobType: 'retail' });
      const est = (uid) => ({ userId: uid, leadId: 'LEAD1', mode: 'cash', grandTotal: 12345.67, total: 12345.67, number: 'E-1', addr: '5 Vine St, Cincinnati, OH 45202', tier: 'better',
        rows: [{ code: 'A', desc: 'Shingles', qty: '20 SQ', rate: '$450/SQ', total: 9000, retailTotal: 9000 }] });
      const seed = (uid, profile, flag) => {
        const o = { 'leads/LEAD1': lead(uid), 'estimates/EST1': est(uid), ['companyProfile/' + uid]: profile };
        if (flag) o['feature_flags/_default'] = { docEvidenceFoundation: true };
        return o;
      };
      const AUTH = (uid) => ({ auth: { uid, token: { role: 'owner' } }, data: { estimateId: 'EST1', signers: [{ name: 'Pat Smith', email: 'pat@example.test' }] } });
      const send = async (L, uid) => { try { return { v: await L.fns.sendEstimateEnvelope(AUTH(uid)) }; } catch (e) { return { e }; } };
      const FULL = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } }, timezone: 'America/New_York' };

      // flag off
      let db = kit.makeDb(seed(UID, { brand: { legalName: 'Acme Roofing LLC', contact: {} } }, false)); let st = kit.makeStorage();
      let r = await send(load(db, st), UID);
      ok('flag OFF: a contract with no mailing address / entity name still sends (unchanged)', !!r.v && !r.e, r.e && r.e.message);
      const env0 = r.v ? db._get('esign_envelopes/' + r.v.envelopeId) : {};
      ok('...and the envelope is stamped with the clause-set version and clause refs anyway (additive)',
        env0.clauseSetVersion === CS.CLAUSE_SET_VERSION && Array.isArray(env0.clauseIds) && env0.clauseIds.includes('PAYMENT_V1'));
      // flag on
      db = kit.makeDb(seed(UID, { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: {} } }, true)); st = kit.makeStorage();
      r = await send(load(db, st), UID);
      ok('flag ON: no mailing address = refused with a rep-facing message', !!r.e && r.e.code === 'failed-precondition' && /mailing address/.test(r.e.message), r.e && r.e.message);
      ok('...and nothing was stored or minted', st.files.size === 0 && db._all('esign_envelopes').length === 0);
      db = kit.makeDb(seed(UID, { brand: { legalName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } }, true)); st = kit.makeStorage();
      r = await send(load(db, st), UID);
      ok('flag ON: a tenant with no legal entity name = refused', !!r.e && /legal entity name/.test(r.e.message), r.e && r.e.message);
      db = kit.makeDb(seed(UID, FULL, true)); st = kit.makeStorage();
      let L = load(db, st);
      r = await send(L, UID);
      ok('flag ON: a complete contract sends', !!r.v && !r.e, r.e && r.e.message);
      db = kit.makeDb(seed(UID, FULL, true)); db._store.set('feature_flags/' + UID, { docEvidenceFoundation: false });
      r = await send(load(db, kit.makeStorage()), UID);
      ok('flag: the per-person doc overrides the default (off for this person)', !!r.v);
      db = kit.makeDb(seed(NBD_UID, { brand: { legalName: 'No Big Deal Home Solutions', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } }, true));
      r = await send(load(db, kit.makeStorage()), NBD_UID);
      ok('flag ON: the NBD tenant gets NBD\'s own entity name by default and sends', !!r.v && !r.e, r.e && r.e.message);

      // evidence at signing (path A)
      db = kit.makeDb(seed(UID, FULL, false)); st = kit.makeStorage(); L = load(db, st);
      r = await send(L, UID);
      const envId = r.v && r.v.envelopeId;
      const tok = db._all('esign_tokens').find((t) => t.envelopeId === envId && t.status === 'pending');
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const rr = kit.reqRes({ token: tok && tok._id, consent: true, signerName: 'Pat Smith', values: { sig_signer: { png: PNG }, date_signer: { text: '11/18/2026' } } }, { ip: '198.51.100.7', ua: 'Mozilla/5.0 (iPhone) PatPhone' });
      try { await L.fns.submitEsignEnvelope(rr.req, rr.res); } catch (e) { ok('the envelope signs', false, e.message); }
      const done = envId ? db._get('esign_envelopes/' + envId) : null;
      const s0 = done && done.signers && done.signers[0];
      ok('envelope path: the signing succeeds', rr.res.statusCode === 200 && rr.res.body && rr.res.body.ok === true, JSON.stringify(rr.res.body));
      ok('envelope path: signer evidence carries clauseSetVersion', !!s0 && s0.clauseSetVersion === CS.CLAUSE_SET_VERSION);
      ok('envelope path: ...the clause refs', !!s0 && Array.isArray(s0.clauseIds) && s0.clauseIds.includes('FTC_COOLING_OFF_V1'));
      ok('envelope path: ...and documentSha256 = the digest of the source PDF presented', !!s0 && !!done.sourceSha256 && s0.documentSha256 === done.sourceSha256 && s0.documentSha256 === kit.sha256(st.files.get(done.sourcePath)));
      ok('envelope path: consent text, signing time, IP and user agent recorded by the server',
        !!s0 && s0.consent && s0.consent.text === ESL.CONSENT_TEXT && s0.consent.agreed === true && s0.signedAt > 0 && s0.ip === '198.51.100.7' && /PatPhone/.test(s0.ua));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('B1. buildEvidence + buildSignerEvidence (one shape, every key present)');
  {
    const e = DE ? DE.buildEvidence({ path: 'in_person', ip: '1.2.3.4' }) : {};
    ok('buildEvidence: every key is present, unknowns are null', DE && ['path', 'clauseSetVersion', 'clauseIds', 'documentSha256', 'signedSha256', 'consent', 'signedAtMs', 'ip', 'ua', 'recordedByUid'].every((k) => k in e) && e.documentSha256 === null && e.consent.agreed === null && e.consent.text === null);
    ok('buildEvidence: a consent given is stamped with its text and time', DE && DE.buildEvidence({ consent: { agreed: true, text: 'I agree', at: 5 }, signedAtMs: 9 }).consent.at === 5);
    ok('buildEvidence: consent null never reads as agreed', DE && DE.buildEvidence({ consent: { agreed: null, text: 'x' } }).consent.at === null);
    const se = ESL.buildSignerEvidence({ clauseSetVersion: 'CS-X.1', clauseIds: ['A_V1'], documentSha256: 'abc', consent: true, ip: '1.1.1.1', ua: 'u' });
    ok('buildSignerEvidence carries clauseSetVersion, clauseIds and documentSha256', se.clauseSetVersion === 'CS-X.1' && se.clauseIds[0] === 'A_V1' && se.documentSha256 === 'abc');
    const se2 = ESL.buildSignerEvidence({});
    ok('...and they read null / [] when unknown (keys always present)', 'clauseSetVersion' in se2 && se2.clauseSetVersion === null && se2.documentSha256 === null && Array.isArray(se2.clauseIds));
    ok('flagOn: only the boolean true turns it on; person overrides default', DE && DE.flagOn({ docEvidenceFoundation: true }, {}) === true && DE.flagOn({ docEvidenceFoundation: 'true' }, {}) === false && DE.flagOn({ docEvidenceFoundation: true }, { docEvidenceFoundation: false }) === false && DE.flagOn({}, {}) === false);
    ok('flagForUid: an unreadable flag reads OFF', DE && (await DE.flagForUid({ doc: () => ({ get: async () => { throw new Error('down'); } }) }, 'u')) === false);
    ok('stampFor: an Ohio cash lead gets the 2-clause set, an unreadable lead the strict one',
      DE && DE.stampFor(K, { address: '1 A St, Cincinnati, OH 45202', jobType: 'cash' }, {}).clauseIds.length === 2 && DE.stampFor(K, {}, {}).clauseIds.length === 6);
    ok('requestFacts reads the request, never the body; no request = nulls', DE && DE.requestFacts(null).ip === null && DE.requestFacts({ get: () => 'UA/1' }).ua === 'UA/1');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('B2. remote HTML link (path D)');
  {
    if (!kit || !DE) ok('remote harness available', false);
    else {
      const GOOD_PATH = 'documents/U1/L1/d-1.html';
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const ORIGINAL = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Roofing Agreement</title></head><body><h1>Roofing Agreement</h1><p>Prepared for <strong>Dana Whitfield</strong>.</p><table><tr><td>Total</td><td>$28,400.00</td></tr></table>
<div class="nbd-sig-block" data-nbd-sig="homeowner" data-label="Homeowner" data-required="true"><div class="nbd-sig-label">Homeowner</div><canvas class="nbd-sig-canvas"></canvas><div class="nbd-sig-controls"><button type="button" data-nbd-sig-action="clear">Clear</button><span class="nbd-sig-state"></span></div><div class="nbd-sig-print-name">Print Name &amp; Date</div></div><script src="/pro/js/signature-widget.js"></script></body></html>`;
      const signedPage = ORIGINAL.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/, `<img src="${PNG}" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">`)
        .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
        .replace('data-nbd-sig="homeowner"', 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
      const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', 'crypto'];
      const world = (flag, extraTok) => {
        const o = {
          'leads/L1': { userId: 'U1', companyId: 'C1', firstName: 'Dana', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' },
          'leads/L1/documents/d1': { name: 'Roofing Agreement', status: 'sent', type: 'contract', htmlPath: GOOD_PATH },
          'doc_sign_tokens/TOKEVID00001': Object.assign({ status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', mintedBy: 'U1', htmlPath: GOOD_PATH, signerName: 'Dana Whitfield', clauseSetVersion: 'CS-TEST.9', clauseIds: ['PAYMENT_V1'] }, extraTok || {}),
        };
        if (flag) o['feature_flags/_default'] = { docEvidenceFoundation: true };
        return o;
      };
      async function go(flag, body, o) {
        const db = kit.makeDb(world(flag)); const st = kit.makeStorage({ [GOOD_PATH]: ORIGINAL });
        const L = kit.loadHandler('remote-signing.js', db, st, {
          './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
          './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')),
        }, REAL);
        const g = kit.reqRes({ token: 'TOKEVID00001' }, o);
        await L.fns.getSignDocument(g.req, g.res);
        const sub = kit.reqRes(Object.assign({ token: 'TOKEVID00001', signedHtml: signedPage }, body), o);
        await L.fns.submitSignature(sub.req, sub.res);
        return { db, st, get: g.res, sub: sub.res, doc: db._get('leads/L1/documents/d1') || {}, tok: db._get('doc_sign_tokens/TOKEVID00001') };
      }
      let x = await go(false, {}, { ip: '198.51.100.9', ua: 'Mozilla/5.0 Dana' });
      ok('flag OFF: getSignDocument asks for no consent and the signing works as before', x.get.statusCode === 200 && !x.get.body.consent && x.sub.statusCode === 200 && x.sub.body.ok === true, JSON.stringify(x.sub.body));
      let ev = x.doc.signatureEvidence || {};
      ok('remote path: signatureEvidence stamped (path, version, clause refs)', ev.path === 'remote_link' && ev.clauseSetVersion === 'CS-TEST.9' && ev.clauseIds && ev.clauseIds[0] === 'PAYMENT_V1', JSON.stringify(ev));
      ok('remote path: digest of the document presented and of the signed record', ev.documentSha256 === kit.sha256(ORIGINAL) && ev.documentSha256 === x.doc.originalSha256 && ev.signedSha256 === x.doc.signedSha256 && !!ev.signedSha256);
      ok('remote path: IP and user agent come from the request', ev.ip === '198.51.100.9' && /Mozilla\/5.0 Dana/.test(ev.ua));
      ok('remote path: signing time recorded; no consent step while the flag is off = not asked (null), never "agreed"', ev.signedAtMs > 0 && ev.consent && ev.consent.agreed === null && ev.consent.text === null);
      x = await go(false, { ip: '6.6.6.6', ua: 'forged', signatureEvidence: { ip: '6.6.6.6' }, clauseSetVersion: 'FORGED' }, { ip: '198.51.100.9', ua: 'Real UA' });
      ev = x.doc.signatureEvidence || {};
      ok('remote path: IP / UA / version sent in the body are ignored', ev.ip === '198.51.100.9' && ev.ua === 'Real UA' && ev.clauseSetVersion === 'CS-TEST.9');
      x = await go(true, {}, {});
      ok('flag ON: getSignDocument sends the e-sign consent sentence (the server\'s own copy)', x.get.body.consent && x.get.body.consent.required === true && x.get.body.consent.text === ESL.CONSENT_TEXT);
      ok('flag ON: submit without the tick = 422, and the link is NOT burned', x.sub.statusCode === 422 && x.sub.body.needsConsent === true && x.tok.status === 'pending');
      x = await go(true, { consent: 'yes' }, {});
      ok('flag ON: only the boolean true counts as consent', x.sub.statusCode === 422 && x.tok.status === 'pending');
      x = await go(true, { consent: true, consentText: 'I forged this text' }, { ip: '198.51.100.9', ua: 'Real UA' });
      ev = x.doc.signatureEvidence || {};
      ok('flag ON + consent: signs, stores the SERVER copy of the text (never the body\'s)', x.sub.statusCode === 200 && ev.consent && ev.consent.agreed === true && ev.consent.text === ESL.CONSENT_TEXT && ev.consent.at > 0);
      // finding 7b: the consent decision is snapshotted on the token, not re-read from the flag at POST
      async function go2(tokExtra, flagAtSubmit, breakFlagRead) {
        const db = kit.makeDb(world(flagAtSubmit, tokExtra)); const st = kit.makeStorage({ [GOOD_PATH]: ORIGINAL });
        const L = kit.loadHandler('remote-signing.js', db, st, {
          './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
          './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')),
        }, REAL);
        if (breakFlagRead) { const o0 = db.doc; db.doc = (p) => (/^feature_flags\//.test(p) ? { get: async () => { throw new Error('down'); } } : o0(p)); }
        const g = kit.reqRes({ token: 'TOKEVID00001' }, {});
        await L.fns.getSignDocument(g.req, g.res);
        const sub = kit.reqRes({ token: 'TOKEVID00001', signedHtml: signedPage }, {});
        await L.fns.submitSignature(sub.req, sub.res);
        return { get: g.res, sub: sub.res, doc: db._get('leads/L1/documents/d1') || {}, tok: db._get('doc_sign_tokens/TOKEVID00001') };
      }
      let y = await go2({ consentAsked: true }, false);
      ok('7b: a link minted with the consent box keeps asking for it after the flag is turned off (no re-read)', y.get.body.consent && y.get.body.consent.required === true && y.sub.statusCode === 422 && y.sub.body.needsConsent === true);
      y = await go2({ consentAsked: false }, true);
      ok('7b: a link minted without the box is not asked at POST just because the flag came on since', !y.get.body.consent && y.sub.statusCode === 200 && ((y.doc.signatureEvidence || {}).consent || {}).agreed === null);
      y = await go2({ consentAsked: true }, true, true);
      ok('7b: with the token\'s snapshot, a flag read that FAILS at POST cannot switch the consent requirement off', y.sub.statusCode === 422 && y.sub.body.needsConsent === true);
      y = await go2({}, true);
      ok('7b: a link minted before the snapshot existed falls back to the flag as it stands', y.sub.statusCode === 422 && y.sub.body.needsConsent === true);
      ok('7b: createSignRequest writes consentAsked on the token from the flag it just read', /consentAsked: flagOnAtMint/.test(read('functions/remote-signing.js') || ''));
      // finding 8: the document-row write after a saved signed copy is retried, and its loss is never silent
      async function go3(failFirst, failAlways) {
        const db = kit.makeDb(world(false)); const st = kit.makeStorage({ [GOOD_PATH]: ORIGINAL });
        let sets = 0;
        const o0 = db.doc;
        db.doc = (p) => {
          const r = o0(p);
          if (p !== 'leads/L1/documents/d1') return r;
          const s0 = r.set;
          r.set = async (patch, o) => {
            const isMain = patch && (patch.signatureEvidence || patch.status);
            if (isMain) { sets++; if (failAlways || sets <= failFirst) throw new Error('firestore blip'); }
            return s0(patch, o);
          };
          return r;
        };
        const L = kit.loadHandler('remote-signing.js', db, st, {
          './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
          './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')),
        }, REAL);
        const g = kit.reqRes({ token: 'TOKEVID00001' }, {});
        await L.fns.getSignDocument(g.req, g.res);
        const sub = kit.reqRes({ token: 'TOKEVID00001', signedHtml: signedPage }, {});
        await L.fns.submitSignature(sub.req, sub.res);
        return { sub: sub.res, sets, doc: db._get('leads/L1/documents/d1') || {}, tok: db._get('doc_sign_tokens/TOKEVID00001') || {}, notes: db._all('notifications'), logs: L.logs, db };
      }
      let w = await go3(0, false);
      ok('8: control: no failure, the row is stamped signed with its evidence on the first try', w.sets === 1 && w.doc.status === 'signed' && !!w.doc.signatureEvidence && !w.doc.signedStampFailed);
      w = await go3(2, false);
      ok('8: two transient failures of the row write are retried and the third lands (status signed + evidence kept)', w.sets === 3 && w.doc.status === 'signed' && w.doc.signatureEvidence && w.doc.signatureEvidence.path === 'remote_link' && !w.doc.signedStampFailed, 'sets=' + w.sets);
      w = await go3(0, true);
      ok('8: a row write that keeps failing is tried several times, not once', w.sets >= 3, 'sets=' + w.sets);
      ok('8: ...and then says so, visibly: flag on the document, on the token, and a bell for the rep', w.doc.signedStampFailed === true && w.tok.docStampFailed === true && w.notes.some((n) => /action needed/i.test(n.title || '') && n.userId === 'U1'));
      ok('8: ...the homeowner still gets ok (the signed copy is stored) and the link is burned', w.sub.statusCode === 200 && w.sub.body.ok === true && w.tok.status === 'signed');
      const sk = require('./lib/src-kit');
      const box = sk.parseTags(sk.read('docs/pro/sign.html')).$('#spConsent');
      ok('sign page: the consent label ships hidden', !!box && box.attrs.hidden !== undefined);
      ok('sign page: text set via textContent, required before Submit, sent as consent: true', /textContent = String\(r\.data\.consent\.text[\s\S]*consentNeeded && !\(consentBox && consentBox\.checked\)[\s\S]*consent: true/.test(read('docs/pro/js/sign-page.js') || ''));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('B3. deal room (path B)');
  {
    if (!kit || !DE) ok('deal harness available', false);
    else {
      const DEAL_PATH = 'deal_rooms/U1/d1.html';
      const REAL = ['./ky-insurance-law', './cancel-window', './cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './portal-after-signing', './signed-price', 'crypto'];
      const db = kit.makeDb({
        'deal_accept_tokens/TOKDEAL00001': { status: 'pending', dealId: 'd1', ownerUid: 'U1', leadId: 'L1', htmlPath: DEAL_PATH, tierPrices: { better: 13000 }, pageSha256: kit.sha256('<html><body><p>Deal page</p></body></html>') },
        'deal_rooms/d1': { status: 'sent', userId: 'U1' },
        'leads/L1': { userId: 'U1', address: '9 Elm St, Louisville, KY 40202', jobType: 'insurance' },
      });
      const page = '<html><body><p>Deal page</p></body></html>';
      const st = kit.makeStorage({ [DEAL_PATH]: page });
      const L = kit.loadHandler('deal-acceptance.js', db, st, {
        './deal-install-date': { fillLeadInstallDate: async () => null },
        './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
        './estimate-send-logic': {}, './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/x.js' },
        './deal-accepted-tier': { applyAcceptedTier: async () => {} },
        './ky-insurance-law': K, './cancel-window': require(path.join(FN, 'cancel-window.js')), './esign-logic': ESL, './doc-evidence': DE,
      }, REAL.filter((r) => ['./cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './await-briefly', './portal-after-signing', './signed-price'].includes(r)).concat(['crypto']));
      const dealCall = kit.reqRes({ token: 'TOKDEAL00001', tier: 'better', signature: 'data:image/png;base64,' + 'A'.repeat(400), financing: -1, consent: true }, { ip: '198.51.100.20', ua: 'Mozilla/5.0 DealPhone' });
      await L.fns.submitDealAcceptance(dealCall.req, dealCall.res);
      const ev = (db._get('deal_rooms/d1') || {}).acceptedEvidence || {};
      ok('deal path: the acceptance succeeds', dealCall.res.statusCode === 200, JSON.stringify(dealCall.res.body));
      ok('deal path: clauseSetVersion stamped in the acceptance transaction', !!CS && ev.clauseSetVersion === CS.CLAUSE_SET_VERSION);
      ok('deal path: clause refs for a Kentucky insurance job (all six)', Array.isArray(ev.clauseIds) && ev.clauseIds.length === 6, JSON.stringify(ev.clauseIds));
      ok('deal path: documentSha256 = digest of the page, read from the token (and still pageSha256)', ev.documentSha256 === kit.sha256(page) && ev.pageSha256 === ev.documentSha256);
      ok('deal path: consent text, IP, UA and time were already recorded (reused, not reinvented)', ev.consent === true && /electronically/.test(ev.consentText || '') && ev.ip === '198.51.100.20' && /DealPhone/.test(ev.ua) && ev.at > 0);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('B4. in-person signing (path C), written server-side');
  {
    const L = tryReq(path.join(FN, 'in-person-signing-logic.js'));
    if (!L || !DE || !kit) ok('in-person harness available', false);
    else {
      const HTML = '<html><body>SIGNED CONTRACT COPY</body></html>';
      const mk = (docExtra) => kit.makeDb({
        'leads/L1': { userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' },
        'estimates/E1': { grandTotal: 14500 },
        'companyProfile/U1': { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } },
        'leads/L1/documents/d1': Object.assign({ type: 'contract', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: 'documents/U1/L1/d-1.html' }, docExtra || {}),
      });
      const spine = [];
      const deps = (o) => ({ recordJobEvent: async (_d, a) => { spine.push(a.event); return { moved: true }; },
        evidence: Object.assign({ enabled: true, ip: '198.51.100.30', ua: 'Mozilla/5.0 RepPhone', readBytes: async () => Buffer.from(HTML) }, o || {}) });
      const call = (db, d, dp) => L.handleInPersonSignature(db, { uid: 'U1', token: {} }, Object.assign({ leadId: 'L1', docId: 'd1' }, d || {}), dp);
      let db = mk();
      const out = await call(db, { presentedSha256: 'a'.repeat(64) }, deps());
      let ev = (db._get('leads/L1/documents/d1') || {}).signatureEvidence || {};
      ok('in-person: the card still moves (unchanged)', out.ok === true && out.moved === true && spine.includes('contract_signed'));
      ok('in-person: evidence written by the server: path, clause-set version, refs', ev.path === 'in_person' && !!CS && ev.clauseSetVersion === CS.CLAUSE_SET_VERSION && ev.clauseIds.length === 2);
      ok('in-person: server digest of the signed copy as stored, labelled signedCopySha256 (documentSha256 is not claimed)', ev.signedCopySha256 === kit.sha256(HTML) && ev.signedSha256 === ev.signedCopySha256 && ev.documentSha256 === null);
      ok('in-person: IP and UA are the request\'s; who recorded it', ev.ip === '198.51.100.30' && /RepPhone/.test(ev.ua) && ev.recordedByUid === 'U1');
      ok('in-person: no consent step today = recorded as not asked (null), never agreed', ev.consent && ev.consent.agreed === null && ev.consent.text === null);
      ok('in-person: the client\'s pre-signing digest is kept but labelled client-reported', ev.presentedSha256ClientReported === 'a'.repeat(64));
      await call(db, { presentedSha256: 'b'.repeat(64) }, deps({ ip: '6.6.6.6' }));
      ev = (db._get('leads/L1/documents/d1') || {}).signatureEvidence || {};
      ok('in-person: write-once, a second call never rewrites the record', ev.ip === '198.51.100.30' && ev.presentedSha256ClientReported === 'a'.repeat(64));
      db = mk({ type: 'completion_cert' });
      const o2 = await call(db, {}, deps());
      ok('in-person: any signed document type gets evidence; a non-contract never moves the card', o2.skipped === 'not_a_contract' && !!(db._get('leads/L1/documents/d1') || {}).signatureEvidence);
      db = mk(); await call(db, {}, { recordJobEvent: deps().recordJobEvent });
      ok('flag OFF (no evidence dep): nothing is written, as before', !(db._get('leads/L1/documents/d1') || {}).signatureEvidence);
      db = mk({ signedRemotely: true, signatureEvidence: { path: 'remote_link', ip: '9.9.9.9' } }); await call(db, {}, deps());
      ok('a remotely signed document keeps the evidence that path wrote (none overwritten)', (db._get('leads/L1/documents/d1') || {}).signatureEvidence.path === 'remote_link' && db._get('leads/L1/documents/d1').signatureEvidence.ip === '9.9.9.9');
      db = mk({ type: 'work_report', htmlPath: 'documents/OTHER/L-OTHER/x.html' }); await call(db, {}, deps({ readBytes: async () => { throw new Error('must not read a foreign path'); } }));
      ev = (db._get('leads/L1/documents/d1') || {}).signatureEvidence || {};
      ok('a path outside this lead is never read (digest null, evidence still written)', ev.signedSha256 === null && ev.path === 'in_person');
      db = mk({ type: 'work_report' }); const o3 = await call(db, {}, deps({ readBytes: async () => { throw new Error('storage down'); }, onError: () => {} }));
      ok('a storage failure while digesting never blocks the card move (a document the gap check does not cover)', o3.ok === true);
      db = mk({ status: 'sent', signedAt: null });
      let refused = false; try { await call(db, {}, deps()); } catch (e) { refused = e.code === 'failed-precondition'; }
      ok('an unsigned document is refused and no evidence is written', refused && !(db._get('leads/L1/documents/d1') || {}).signatureEvidence);
      const wrap = read('functions/in-person-signing.js') || '';
      ok('the callable reads the flag per person and takes IP/UA from request.rawRequest', /flagForGate\(db, uid, HttpsError\)[\s\S]*requestFacts\(request\.rawRequest\)/.test(wrap));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('D. brand.entityName / dbaName / signerTitle');
  {
    function loadCP() {
      const store = {};
      const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
      const win = { addEventListener() {}, removeEventListener() {}, localStorage }; win.window = win;
      vm.runInNewContext(fs.readFileSync(path.join(JS, 'company-profile.js'), 'utf8'), { window: win, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON }, { filename: 'company-profile.js' });
      return win;
    }
    const win = loadCP();
    const b = win._brand();
    ok('NBD defaults: entityName "No Big Deal Solutions LLC"', b.entityName === 'No Big Deal Solutions LLC');
    ok('NBD defaults: dbaName "No Big Deal Home Solutions"', b.dbaName === 'No Big Deal Home Solutions');
    ok('NBD defaults: signerTitle "Manager"', b.signerTitle === 'Manager');
    ok('legalName is untouched (nothing prints the new fields yet)', b.legalName === 'No Big Deal Home Solutions');
    await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction' } });
    const ob = win._brand();
    ok('another tenant: entityName blanked, not NBD\'s', ob.entityName === '');
    ok('another tenant: dbaName and signerTitle blanked', ob.dbaName === '' && ob.signerTitle === '');
    await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction', entityName: 'Oaks Roofing LLC', signerTitle: 'Owner' } });
    const o2 = win._brand();
    ok('another tenant that sets its own keeps them', o2.entityName === 'Oaks Roofing LLC' && o2.signerTitle === 'Owner' && o2.dbaName === '');
    ok('no NBD entity string leaks into the other tenant\'s brand', !/No Big Deal Solutions LLC/.test(JSON.stringify(o2)));
    ok('server: NBD tenant gets the entity default, another tenant must set its own', !!DE && DE.entityNameFor({}, '1phDvAVXHSg82wDLegAbQFq14Ci1') === 'No Big Deal Solutions LLC' && DE.entityNameFor({}, 'someone-else') === '' && DE.entityNameFor({ brand: { entityName: 'Z LLC' } }, 'someone-else') === 'Z LLC');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('flag registry');
  {
    const REG = tryReq(path.join(FN, 'flags-registry.js'));
    const row = REG && (REG.FIRESTORE_FLAGS || []).find((f) => f.name === 'docEvidenceFoundation');
    ok('docEvidenceFoundation is registered, default false, ships dark', !!row && row.default === false && row.dark === true);
    ok('the code agrees: doc-evidence.js exports the same name and default', !!DE && DE.FLAG_NAME === 'docEvidenceFoundation' && DE.FLAG_DEFAULT === false);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('R. security review 2026-11-18 follow-ups');
  {
    // finding 11: the visible-text scan is linear, bounded, and a stray '<' cannot hide a placeholder.
    const slow = (fn) => { const t0 = Date.now(); const r = fn(); return { ms: Date.now() - t0, r }; };
    const a = CHK ? slow(() => CHK.placeholdersIn('<a '.repeat(150000) + ' [Homeowner Name] ')) : { ms: 1e9 };
    ok('11: 450 KB of unclosed "<a " scans in well under a second (was quadratic)', a.ms < 1500, a.ms + ' ms');
    const b = CHK ? slow(() => CHK.visibleText('<script>x'.repeat(100000) + '[Price]')) : { ms: 1e9 };
    ok('11: 900 KB of unclosed <script> openers scans in well under a second', b.ms < 1500, b.ms + ' ms');
    const c = CHK ? slow(() => CHK.visibleText('<!--'.repeat(150000))) : { ms: 1e9 };
    ok('11: 600 KB of unclosed comment openers scans in well under a second', c.ms < 1500, c.ms + ' ms');
    ok('11: a stray "<" before a placeholder does not hide it', !!CHK && CHK.placeholdersIn('<p>a < b</p> [Homeowner Name] <p>done</p>').indexOf('[Homeowner Name]') !== -1);
    ok('11: a stray "<" in text with a later tag does not hide a {{token}}', !!CHK && CHK.placeholdersIn('x <3 you {{price}} <b>ok</b>').indexOf('{{price}}') !== -1);
    ok('11: a placeholder inside an attribute is found by the raw scan', !!CHK && CHK.placeholdersIn('<input value="[Price]">').indexOf('[Price]') !== -1);
    ok('11: a placeholder inside <script> or a comment is not reported', !!CHK && CHK.placeholdersIn('<script>var a="[Price]"</script><!-- [Price] --><p>ok</p>').length === 0);
    const full = { type: 'contract', priceCents: 1200000, address: 'a', homeownerName: 'b', entityName: 'X LLC', startDate: 'x', estimatedCompletion: 'y' };
    const g = CHK ? CHK.contractGaps(Object.assign({}, full, { text: 'x'.repeat(2 * 1024 * 1024 + 1) })) : [];
    ok('11: a document over 2 MB is refused with a clear gap, not scanned', g.some((x) => x.code === 'tooLarge' && /too large/i.test(x.message)), JSON.stringify(g.map((x) => x.code)));
    ok('11: a document under 2 MB passes the size gate', !!CHK && !CHK.contractGaps(Object.assign({}, full, { text: 'x'.repeat(1024 * 1024) })).some((x) => x.code === 'tooLarge'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('R2. findings 2 and 7: the send gates run on the server and fail closed');
  {
    if (!kit || !DE) ok('R2 harness available', false);
    else {
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
      const rsStubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
        './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')) });
      const seedRS = (flag, o) => {
        const x = Object.assign({ lead: leadX, profile: PROFILE, est: { grandTotal: 14500 }, html: CONTRACT }, o || {});
        const s = { 'leads/L1': x.lead, 'leads/L1/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'U1' } };
        if (x.profile) s['companyProfile/U1'] = x.profile;
        if (x.est) s['estimates/E1'] = x.est;
        if (flag) s['feature_flags/_default'] = { docEvidenceFoundation: true };
        return { s, html: x.html };
      };
      async function mint(flag, o, dbMod) {
        const w = seedRS(flag, o);
        const db = kit.makeDb(w.s); const st = kit.makeStorage({ [P]: w.html });
        if (dbMod) dbMod(db);
        const L = kit.loadHandler('remote-signing.js', db, st, rsStubs(), REAL);
        try { return { v: await L.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana Whitfield' } }), db }; }
        catch (e) { return { e, db }; }
      }
      const tokens = (db) => db._all('doc_sign_tokens').length;
      const breakFlags = (db) => { const orig = db.doc; db.doc = (p) => (/^feature_flags\//.test(p) ? { get: async () => { throw new Error('firestore unavailable'); } } : orig(p)); };
      let r = await mint(true);
      ok('2 remote: flag ON, a complete contract is sent', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
      r = await mint(true, { est: null });
      ok('2 remote: flag ON, no price on the primary estimate is refused (server-side price check)', !!r.e && r.e.code === 'failed-precondition' && /price/.test(r.e.message) && tokens(r.db) === 0, r.e && r.e.message);
      r = await mint(true, { profile: { brand: { legalName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St' } } } });
      ok('2 remote: flag ON, a tenant with no legal entity name is refused', !!r.e && /legal entity name/.test(r.e.message) && tokens(r.db) === 0, r.e && r.e.message);
      r = await mint(true, { profile: { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: {} } } });
      ok('2 remote: flag ON, no company mailing address is refused', !!r.e && /mailing address/.test(r.e.message));
      r = await mint(true, { lead: Object.assign({}, leadX, { address: '', firstName: '', lastName: '' }) });
      ok('2 remote: flag ON, no property address is refused', !!r.e && /address/.test(r.e.message), r.e && r.e.message);
      r = await mint(true, { html: CONTRACT.replace('Roofing Contract</h1>', 'Roofing Contract for [Homeowner Name]</h1>') });
      ok('2 remote: flag ON, a [Placeholder] left in the stored contract is refused', !!r.e && /placeholder/i.test(r.e.message) && tokens(r.db) === 0);
      r = await mint(true, { html: CONTRACT + 'x'.repeat(2 * 1024 * 1024 + 5) });
      ok('11 remote: flag ON, a contract over 2 MB is refused with the size message', !!r.e && /too large/i.test(r.e.message) && tokens(r.db) === 0, r.e && r.e.message);
      r = await mint(true);
      ok('7b: the token records consentAsked true when the flag was on at mint', (r.db._all('doc_sign_tokens')[0] || {}).consentAsked === true);
      r = await mint(false, { est: null, profile: null });
      ok('7b: ...and false when it was off', (r.db._all('doc_sign_tokens')[0] || {}).consentAsked === false);
      ok('flag OFF: the same blank-price, no-profile contract still goes out (nothing changed)', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
      r = await mint(false, {}, breakFlags);
      ok('7 remote: a flag read that FAILS refuses the contract send (retryable "unavailable"), no link minted', !!r.e && r.e.code === 'unavailable' && tokens(r.db) === 0, r.e && (r.e.code + ' ' + r.e.message));
      ok('7 flagForUid keeps its best-effort contract for callers that only add (an unreadable flag reads OFF)', (await DE.flagForUid({ doc: () => ({ get: async () => { throw new Error('x'); } }) }, 'u')) === false);
      let thrown = null; try { await DE.flagForUid({ doc: () => ({ get: async () => { throw new Error('x'); } }) }, 'u', { strict: true }); } catch (er) { thrown = er; }
      ok('7 flagForUid({strict:true}) throws instead', !!thrown);

      // in-person path
      const L = tryReq(path.join(FN, 'in-person-signing-logic.js'));
      const mkIP = (o) => {
        const x = Object.assign({ est: { grandTotal: 14500 }, profile: PROFILE }, o || {});
        const s = { 'leads/L1': x.lead || leadX, 'leads/L1/documents/d1': Object.assign({ type: 'contract', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: P }, x.doc || {}) };
        if (x.est) s['estimates/E1'] = x.est;
        if (x.profile) s['companyProfile/U1'] = x.profile;
        return kit.makeDb(s);
      };
      const ipCall = (db, html, extra) => L.handleInPersonSignature(db, { uid: 'U1', token: {} }, { leadId: 'L1', docId: 'd1' },
        { recordJobEvent: async () => ({ moved: true }), evidence: Object.assign({ enabled: true, ip: '198.51.100.30', ua: 'Rep', readBytes: async () => Buffer.from(html) }, extra || {}) });
      const refusal = async (fn) => { try { await fn(); return null; } catch (er) { return er; } };
      let db = mkIP();
      let e = await refusal(() => ipCall(db, CONTRACT));
      ok('2 in-person: flag ON, a complete contract records and moves the card', e === null && !!(db._get('leads/L1/documents/d1') || {}).signatureEvidence, e && e.message);
      db = mkIP({ est: null });
      e = await refusal(() => ipCall(db, CONTRACT));
      ok('2 in-person: flag ON, no price is refused and no evidence is written', !!e && e.code === 'failed-precondition' && /price/.test(e.message) && !(db._get('leads/L1/documents/d1') || {}).signatureEvidence, e && e.message);
      db = mkIP();
      e = await refusal(() => ipCall(db, CONTRACT + '<p>[Property Address]</p>'));
      ok('2 in-person: flag ON, a [Placeholder] in the stored copy is refused', !!e && /placeholder/i.test(e.message));
      db = mkIP({ profile: { brand: { contact: { mailingAddress: '1 Main St' } } } });
      e = await refusal(() => ipCall(db, CONTRACT));
      ok('2 in-person: flag ON, no legal entity name is refused', !!e && /legal entity name/.test(e.message));
      db = mkIP();
      e = await refusal(() => ipCall(db, CONTRACT, { readBytes: async () => { throw new Error('storage down'); } }));
      ok('2 in-person: flag ON, an unreadable stored copy is a retryable refusal, not a pass', !!e && e.code === 'unavailable');
      db = mkIP({ est: null });
      e = await refusal(() => L.handleInPersonSignature(db, { uid: 'U1', token: {} }, { leadId: 'L1', docId: 'd1' }, { recordJobEvent: async () => ({ moved: true }) }));
      ok('2 in-person: flag OFF (no evidence dep), the same blank-price contract moves as before', e === null);
      const wrapSrc = read('functions/in-person-signing.js') || '';
      ok('7 in-person: the callable reads the flag as a gate and lets its retryable error through', /flagForGate\(db, uid, HttpsError\)/.test(wrapSrc) && /e instanceof HttpsError\) throw e/.test(wrapSrc));

      // createEsignEnvelope (uploaded PDF)
      const PDFLib = tryReq('pdf-lib');
      if (!PDFLib) ok('createEsignEnvelope harness (pdf-lib)', false);
      else {
        const pdfDoc = await PDFLib.PDFDocument.create(); pdfDoc.addPage([612, 792]);
        const pdfBytes = Buffer.from(await pdfDoc.save());
        const SRC = 'esign/U1/L1/ENVUP0001/source.pdf';
        const run = async (flag, lead, profile, brk) => {
          const s = { 'leads/L1': lead, 'companyProfile/U1': profile };
          if (flag) s['feature_flags/_default'] = { docEvidenceFoundation: true };
          const d2 = kit.makeDb(s); const st2 = kit.makeStorage({ [SRC]: pdfBytes });
          if (brk) brk(d2);
          const stubs = { './esign-stamp': require(path.join(FN, 'esign-stamp.js')), './esign-logic': ESL, './doc-evidence': DE, './ky-insurance-law': K,
            './estimate-esign-pdf': tryReq(path.join(FN, 'estimate-esign-pdf.js')), './customer-estimate-rows': require(path.join(FN, 'customer-estimate-rows.js')),
            './deposit-plan-view': require(path.join(FN, 'deposit-plan-view.js')), './cancel-window': require(path.join(FN, 'cancel-window.js')),
            './cancel-notice-pdf': require(path.join(FN, 'cancel-notice-pdf.js')), './integrations/heartbeat': { onSchedule: (o, h) => h } };
          stubs['./esign-io'] = kit.loadHandler('esign-io.js', d2, st2, stubs, []).fns;
          const H = kit.loadHandler('esign-envelope.js', d2, st2, stubs, []);
          try { return { v: await H.fns.createEsignEnvelope({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', envelopeId: 'ENVUP0001', sourcePath: SRC, title: 'Contract' } }), db: d2 }; }
          catch (er) { return { e: er, db: d2 }; }
        };
        let q = await run(true, leadX, PROFILE);
        ok('2 envelope: flag ON, an uploaded PDF for a lead with every party fact registers', !!q.v && !!q.db._get('esign_envelopes/ENVUP0001'), q.e && q.e.message);
        q = await run(true, Object.assign({}, leadX, { address: '' }), PROFILE);
        ok('2 envelope: flag ON, no property address is refused and nothing is stored', !!q.e && q.e.code === 'failed-precondition' && /address/.test(q.e.message) && !q.db._get('esign_envelopes/ENVUP0001'), q.e && q.e.message);
        q = await run(true, leadX, { brand: { legalName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St' } } });
        ok('2 envelope: flag ON, no legal entity name is refused', !!q.e && /legal entity name/.test(q.e.message));
        q = await run(false, Object.assign({}, leadX, { address: '' }), {});
        ok('2 envelope: flag OFF, unchanged: the same upload registers', !!q.v && !!q.db._get('esign_envelopes/ENVUP0001'), q.e && q.e.message);
        q = await run(false, leadX, PROFILE, breakFlags);
        ok('7 envelope: a flag read that FAILS refuses (retryable), nothing stored', !!q.e && q.e.code === 'unavailable' && !q.db._get('esign_envelopes/ENVUP0001'), q.e && q.e.message);
      }

      // browser gate: flag ON + module missing must BLOCK
      const dg = read('docs/pro/js/document-generator.js') || '';
      const gateSrc = (dg.match(/_docSendGate\(type, data, html\) \{[\s\S]*?\n  \},/) || [''])[0];
      ok('2 browser: with the flag ON and the checks module missing the gate BLOCKS (the module-missing branch returns false)', /if \(!C\)[\s\S]{0,900}return false/.test(gateSrc) && /reload/i.test(gateSrc), gateSrc.slice(0, 200));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('R3. findings 3 and 4: in-person evidence says what it proves, and is written once, transactionally');
  {
    const L = tryReq(path.join(FN, 'in-person-signing-logic.js'));
    if (!L || !DE || !kit) ok('R3 harness available', false);
    else {
      const HTML = '<html><body>SIGNED COPY</body></html>';
      const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
      const mk = (docExtra, serialize) => {
        const db = kit.makeDb({
          'leads/L1': { userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' },
          'estimates/E1': { grandTotal: 14500 }, 'companyProfile/U1': PROFILE,
          'leads/L1/documents/d1': Object.assign({ type: 'completion_cert', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: 'documents/U1/L1/d-1.html' }, docExtra || {}),
        });
        db.evidenceWrites = [];
        const origDoc = db.doc;
        db.doc = (p) => {
          const r = origDoc(p); const set0 = r.set;
          r.set = async (patch, o) => { if (patch && patch.signatureEvidence) db.evidenceWrites.push(patch.signatureEvidence); return set0(patch, o); };
          return r;
        };
        if (serialize) {
          // Firestore re-runs a transaction whose read changed under it; model that with one-at-a-time transactions.
          let chain = Promise.resolve();
          const origTx = db.runTransaction;
          db.runTransaction = (fn) => { const run = chain.then(() => origTx(fn)); chain = run.catch(() => {}); return run; };
        }
        return db;
      };
      const dp = (o) => ({ recordJobEvent: async () => ({ moved: true }), evidence: Object.assign({ enabled: true, ip: '198.51.100.30', ua: 'RepPhone', readBytes: async () => Buffer.from(HTML) }, o || {}) });
      const call = (db, d, o) => L.handleInPersonSignature(db, { uid: 'U1', token: {} }, Object.assign({ leadId: 'L1', docId: 'd1' }, d || {}), dp(o));

      // finding 3
      let db = mk(); const t0 = Date.now();
      await call(db, { presentedSha256: 'a'.repeat(64) });
      const t1 = Date.now();
      const ev = (db._get('leads/L1/documents/d1') || {}).signatureEvidence || {};
      ok('3: the digest of the stored signed copy is signedCopySha256', ev.signedCopySha256 === kit.sha256(HTML));
      ok('3: documentSha256 is NOT claimed on the in-person path (it was the signed copy, not the presented document)', ev.documentSha256 === null);
      ok('3: the client\'s presentedSha256 stays, labelled client-reported', ev.presentedSha256ClientReported === 'a'.repeat(64));
      ok('3: the evidence time is SERVER time, not the row\'s client-set signedAt', ev.signedAtMs >= t0 && ev.signedAtMs <= t1 && ev.signedAtMs !== 1766000000000, String(ev.signedAtMs));
      ok('3: the row\'s own signedAt is kept, but labelled client-reported', ev.signedAtClientReported === 1766000000000);
      ok('3: the record states what it attests', ev.attests === 'rep_device_and_time_only');

      // finding 4
      db = mk({}, true);
      const results = await Promise.all([call(db, {}, { ip: '1.1.1.1' }), call(db, {}, { ip: '2.2.2.2' })]);
      const fin = (db._get('leads/L1/documents/d1') || {}).signatureEvidence || {};
      ok('4: two concurrent calls write the evidence exactly once', db.evidenceWrites.length === 1, 'writes=' + db.evidenceWrites.length);
      ok('4: ...the winner\'s record stands (not a blend, not the loser\'s)', ['1.1.1.1', '2.2.2.2'].includes(fin.ip) && db.evidenceWrites[0] && db.evidenceWrites[0].ip === fin.ip);
      ok('4: ...and both calls still succeed (the card move is unaffected)', results.every((r) => r && r.ok === true));
      db = mk({ signedRemotely: true }, true);
      await call(db, {});
      ok('4: a client-set signedRemotely:true no longer skips the evidence (it is client-writable)', ((db._get('leads/L1/documents/d1') || {}).signatureEvidence || {}).path === 'in_person');
      db = mk({ signedRemotely: true, signatureEvidence: { path: 'remote_link', ip: '9.9.9.9' } }, true);
      await call(db, {});
      ok('4: evidence a signing path wrote is never replaced (the precondition is "absent", not a client flag)', db._get('leads/L1/documents/d1').signatureEvidence.ip === '9.9.9.9' && db.evidenceWrites.length === 0);
      const src = read('functions/in-person-signing-logic.js') || '';
      ok('4: recordEvidence uses a transaction that reads signatureEvidence before writing', /runTransaction/.test(src) && !/signedRemotely === true\) return null/.test(src));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('R4. findings 5 and 6: deal-room digest comes from the token, not from a live read after acceptance');
  {
    if (!kit || !DE) ok('R4 harness available', false);
    else {
      const DEAL_PATH = 'deal_rooms/U1/deal0001.html';
      const SIG = 'data:image/png;base64,' + 'A'.repeat(400);
      const PAGE1 = '<html><body><p>Deal page as minted</p></body></html>';
      const PAGE2 = '<html><body><p>Deal page, re-uploaded by the rep after minting</p></body></html>';
      const stubs = () => ({
        './deal-install-date': { fillLeadInstallDate: async () => null },
        './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
        './estimate-send-logic': {}, './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/x.js' },
        './deal-accepted-tier': { applyAcceptedTier: async () => {} },
        './ky-insurance-law': K, './cancel-window': require(path.join(FN, 'cancel-window.js')), './esign-logic': ESL, './doc-evidence': DE,
      });
      const REALD = ['./cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './await-briefly', './portal-after-signing', './signed-price', './customer-estimate-rows', 'crypto'];
      const world = () => kit.makeDb({
        'deal_rooms/deal0001': { status: 'sent', userId: 'U1', leadId: 'L1', tiers: { better: { price: 13000 } } },
        'leads/L1': { userId: 'U1', companyId: 'U1', address: '9 Elm St, Louisville, KY 40202', jobType: 'insurance' },
      });
      async function mintToken(db, st) {
        const L = kit.loadHandler('deal-acceptance.js', db, st, stubs(), REALD);
        const out = await L.fns.createDealAcceptToken({ auth: { uid: 'U1', token: {} }, data: { dealId: 'deal0001' } });
        return { L, out };
      }
      const tokIdOf = (out) => out.token;
      const accept = async (L, token, body) => { const c = kit.reqRes(Object.assign({ token, tier: 'better', signature: SIG, financing: -1, consent: true }, body || {}), { ip: '198.51.100.20', ua: 'Mozilla/5.0 DealPhone' }); await L.fns.submitDealAcceptance(c.req, c.res); return c.res; };
      const view = async (L, token) => { const c = kit.reqRes({}, {}); c.req.method = 'GET'; c.req.path = '/deal/' + token; await L.fns.getDealRoom(c.req, c.res); return c.res; };

      // (a) mint archives the page and records its digest
      let db = world(); let st = kit.makeStorage({ [DEAL_PATH]: PAGE1 });
      let m = await mintToken(db, st);
      let tok = db._get('deal_accept_tokens/' + tokIdOf(m.out)) || {};
      ok('5: the token carries the sha256 of the page as it was at mint time', tok.pageSha256 === kit.sha256(PAGE1), JSON.stringify(Object.keys(tok)));
      ok('5: the page is archived at mint time and the token names the archive', !!tok.pageArchivePath && st.files.has(tok.pageArchivePath) && st.files.get(tok.pageArchivePath).toString() === PAGE1);
      // (b) the rep re-uploads after mint, the homeowner views, accepts; storage then fails
      st.files.set(DEAL_PATH, Buffer.from(PAGE2));
      await view(m.L, tokIdOf(m.out));
      tok = db._get('deal_accept_tokens/' + tokIdOf(m.out)) || {};
      ok('5: serving the page records the digest of the page the homeowner was actually served', tok.servedPageSha256 === kit.sha256(PAGE2));
      const origDl = st.getStorage;
      const files = st.files;
      files.delete(DEAL_PATH); files.delete(tok.pageArchivePath);   // storage no longer has either, as after a clean-up or an outage
      const res = await accept(m.L, tokIdOf(m.out));
      let ev = (db._get('deal_rooms/deal0001') || {}).acceptedEvidence || {};
      ok('5: acceptance still succeeds with the page gone from storage (no read after acceptance)', res.statusCode === 200, JSON.stringify(res.body));
      ok('5: documentSha256 is the digest of what was served, taken from the token, inside the acceptance', ev.documentSha256 === kit.sha256(PAGE2) && ev.pageSha256 === ev.documentSha256 && ev.documentSha256Source === 'served_at_view');
      ok('5: the digest at mint is kept and a later re-upload is flagged', ev.mintedPageSha256 === kit.sha256(PAGE1) && ev.pageChangedSinceMint === true);
      // (c) never viewed: falls back to the mint digest, labelled
      db = world(); st = kit.makeStorage({ [DEAL_PATH]: PAGE1 }); m = await mintToken(db, st);
      await accept(m.L, tokIdOf(m.out));
      ev = (db._get('deal_rooms/deal0001') || {}).acceptedEvidence || {};
      ok('5: with no recorded view, the mint digest is used and says so', ev.documentSha256 === kit.sha256(PAGE1) && ev.documentSha256Source === 'minted' && ev.pageChangedSinceMint === false);
      // (d) no page at mint: null with a reason code, never a guess
      db = world(); st = kit.makeStorage({}); m = await mintToken(db, st);
      tok = db._get('deal_accept_tokens/' + tokIdOf(m.out)) || {};
      ok('5: a page that could not be read at mint is recorded as such on the token (reason code)', tok.pageSha256 === null && tok.pageArchiveReason === 'page_unreadable_at_mint');
      await accept(m.L, tokIdOf(m.out));
      ev = (db._get('deal_rooms/deal0001') || {}).acceptedEvidence || {};
      ok('5: ...and the evidence has documentSha256 null with documentSha256Reason, not a post-hoc live read', ev.documentSha256 === null && ev.documentSha256Reason === 'page_unreadable_at_mint' && ev.documentSha256Source === null);
      // (e) an older token with no digest fields at all
      db = kit.makeDb({ 'deal_accept_tokens/TOKOLD000001': { status: 'pending', dealId: 'd1', ownerUid: 'U1', leadId: 'L1', htmlPath: DEAL_PATH, tierPrices: { better: 13000 } }, 'deal_rooms/d1': { status: 'sent', userId: 'U1' }, 'leads/L1': { userId: 'U1', jobType: 'insurance', address: '9 Elm St, Louisville, KY 40202' } });
      st = kit.makeStorage({ [DEAL_PATH]: PAGE1 });
      const Lold = kit.loadHandler('deal-acceptance.js', db, st, stubs(), REALD);
      await accept(Lold, 'TOKOLD000001');
      ev = (db._get('deal_rooms/d1') || {}).acceptedEvidence || {};
      ok('5: a token minted before this change gets documentSha256 null and reason no_archive_at_mint (still no live read)', ev.documentSha256 === null && ev.documentSha256Reason === 'no_archive_at_mint');
      // finding 6
      ok('6: consent is labelled client_asserted (the server cannot see the tick)', ev.consentSource === 'client_asserted');
      ok('6: acceptance behaviour is unchanged: an unticked box is still recorded as false and still accepted', await (async () => {
        db = world(); st = kit.makeStorage({ [DEAL_PATH]: PAGE1 }); m = await mintToken(db, st);
        const r2 = await accept(m.L, tokIdOf(m.out), { consent: false });
        const e2 = (db._get('deal_rooms/deal0001') || {}).acceptedEvidence || {};
        return r2.statusCode === 200 && e2.consent === false && e2.consentText === null && e2.consentSource === 'client_asserted';
      })());
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('R6. finding 10: the evidence says how its IP was derived');
  {
    const RL = tryReq(path.join(FN, 'rate-limit.js'));
    ok('10: rate-limit exports clientIpInfo next to clientIp', !!RL && typeof RL.clientIpInfo === 'function');
    if (RL && typeof RL.clientIpInfo === 'function') {
      const a = RL.clientIpInfo({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 35.1.1.1' }, ip: '10.0.0.1' });
      ok('10: a 3-entry chain with the default one trusted hop reads the entry before the last, and says so', a.ip === '203.0.113.5' && /^xff:hops=\d+:chain=3$/.test(a.source), JSON.stringify(a));
      ok('10: clientIp is still the same value (no behaviour change for the rate limiters)', RL.clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 35.1.1.1' } }) === a.ip);
      const b = RL.clientIpInfo({ headers: {}, ip: '10.0.0.1' });
      ok('10: no usable chain falls back to the socket address and says so', b.ip === '10.0.0.1' && b.source === 'socket', JSON.stringify(b));
      const c = RL.clientIpInfo({ headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '10.0.0.1' });
      ok('10: a one-entry chain is not trusted as the client: socket, labelled', c.ip === '10.0.0.1' && c.source === 'socket');
    }
    const UP = tryReq(path.join(FN, 'integrations/upstash-ratelimit.js'));
    ok('10: the limiter module re-exports it', !!UP && typeof UP.clientIpInfo === 'function');
    const facts = DE ? DE.requestFacts({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 35.1.1.1' }, get: () => 'UA/1' }) : {};
    ok('10: requestFacts carries ipSource with the ip', facts.ip === '203.0.113.5' && /^xff:hops=\d+:chain=3$/.test(facts.ipSource || ''), JSON.stringify(facts));
    ok('10: buildEvidence always has an ipSource key (null when unknown)', !!DE && 'ipSource' in DE.buildEvidence({}) && DE.buildEvidence({}).ipSource === null && DE.buildEvidence({ ipSource: 'socket' }).ipSource === 'socket');
    ok('10: the signer evidence on the e-sign envelope carries it too', 'ipSource' in ESL.buildSignerEvidence({ ip: '1.1.1.1', ipSource: 'socket' }) && ESL.buildSignerEvidence({ ip: '1.1.1.1', ipSource: 'socket' }).ipSource === 'socket');
    ok('10: the deal-room evidence carries it', /ipSource/.test(read('functions/deal-acceptance.js') || ''));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
