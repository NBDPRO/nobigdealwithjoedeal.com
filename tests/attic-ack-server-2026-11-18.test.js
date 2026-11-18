/**
 * attic-ack-server-2026-11-18.test.js - phase 3, the server side (flag docAtticAckV1, default OFF):
 *   A. the template renders the packet wording, the tick controls and the priced lines only
 *   B. remote signing records the ticks; incomplete ticks are refused before the burn (static + unit)
 *   C. the gate on the remote link (createSignRequest), in-person recording and the e-sign envelope
 *   D. the owner/admin override (Q18) and who may record it
 *   E. in-person recording writes the server-owned result and the acknowledgments evidence
 *   F. flag OFF: every path unchanged
 * Run: node tests/attic-ack-server-2026-11-18.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));
const kit = require('./lib/doc-evidence-kit');
const AA = require(path.join(FN, 'attic-ack.js'));
const AG = require(path.join(FN, 'attic-gate.js'));
const DE = require(path.join(FN, 'doc-evidence.js'));
const K = require(path.join(FN, 'ky-insurance-law.js'));
const ESL = require(path.join(FN, 'esign-logic.js'));
const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const FORM = '<html><body><h1>Attic</h1>'
  + '<input type="checkbox" data-nbd-ack="ack:saw" data-nbd-required="1"><input type="checkbox" data-nbd-ack="ack:existing" data-nbd-required="1">'
  + '<input type="radio" name="r" data-nbd-ack="rec:decking:yes"><input type="radio" name="r" data-nbd-ack="rec:decking:no">'
  + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
const tickAll = (h, no) => h.replace(/data-nbd-ack="(ack:saw|ack:existing|rec:decking:(yes|no))"/g, (m, id) => (id.indexOf('rec:') === 0 && id !== (no ? 'rec:decking:no' : 'rec:decking:yes') ? m : m + ' checked=""'));

(async () => {
  // ═══════════════════════════════════════════════════════
  section('A. the template renders the packet wording, the tick controls and the priced lines only');
  {
    const H = require('./helpers/clause-v1-harness');
    const env = H.docs({ flags: { docAtticAckV1: true } });
    ['docs/pro/js/attic-ack-text.js', 'docs/pro/js/attic-ack.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => H.load(env, f));
    const DG = env.win.NBDDocGen;
    const has = DG.DOCUMENT_TYPES.attic_acknowledgment;
    ok('registered in DOCUMENT_TYPES with the homeowner and the rep as signers', !!has && has.defaultSigners.map((s) => s.role).join() === 'homeowner,rep');
    ok('the not-inspected page is registered too, same renderer', !!DG.DOCUMENT_TYPES.attic_not_inspected && DG.DOCUMENT_TYPES.attic_not_inspected.template === 'renderAtticAcknowledgment');
    const TXT = require(path.join(FN, 'attic-ack-text.js'));
    const base = { homeownerName: 'Jane Smith', address: '12 Oak St', contractDate: '2026-11-18', companyProfile: H.profileFor(env.win, H.BIZ_ADDR), formDate: '2026-11-18', signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Rep', required: true }] };
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#0*39;|&#x27;/g, "'").replace(/&quot;/g, '"');
    const plain = (h) => decode(h.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ');
    const flat = (s) => plain(s.replace(/\*\*/g, ''));
    const insp = { status: 'inspected', inspectedOn: '2026-11-17', accessPoint: 'hatch', conditions: { mold: true }, photos: [{ id: 'p1', kind: 'overview' }, { id: 'p2', kind: 'cond:mold' }],
      vent: { floorSqFt: 1200, rule: '1/300', manufacturer: 'GAF' }, recs: [{ id: 'decking', qty: 2 }, { id: 'ridge_vent', qty: 30 }] };
    const html = DG.renderAtticAcknowledgment(Object.assign({ atticCheck: insp }, base));
    const text = plain(html);
    ok('every packet paragraph prints verbatim (why we check, the six acknowledgments, the savings sentence)', TXT.WHY.concat(TXT.ACKS, TXT.SAVINGS).every((s) => text.indexOf(flat(s)) !== -1));
    ok('the form never says "waiver"', !/waiver/i.test(text));
    ok('the six acknowledgments are REQUIRED tick controls', (html.match(/data-nbd-ack="ack:[a-z_]+" data-nbd-required="1"/g) || []).length === 6);
    ok('no inline handler, and none of the form\'s own elements carries a style attribute', !/\son[a-z]+\s*=/i.test(html) && !/class="aa-[^"]*"[^>]*\sstyle=/.test(html));
    ok('the ticked condition prints with its photo reference and the numbers are filled', /\[x\] Dark staining/.test(text) && /Photo on file \(p2\)/.test(text) && /1200/.test(text) && /\[x\] 1\/300/.test(text) && /GAF/.test(text));
    ok('with no decking price set (the default) and no ridge-vent price, neither line prints', !/Replace decking/i.test(text) && !/Ridge vent, 30/.test(text));
    ok('the two third-party lines print with price none and a Yes and a No', /Have a qualified mold or indoor-air professional/.test(text) && (html.match(/data-nbd-ack="rec:third_party_\d:(yes|no)"/g) || []).length === 4);
    env.win.NBD_ESTIMATE_CONFIG = Object.assign({}, env.win.NBD_ESTIMATE_CONFIG, { atticRecommendationPrices: { ridge_vent: 450 } });
    const priced = DG.renderAtticAcknowledgment(Object.assign({ atticCheck: insp }, base, { companyProfile: Object.assign({}, base.companyProfile, { paymentTerms: { deckingPerSheetCents: 10000 } }) }));
    ok('once priced, the lines print with their price and a Yes and No control each',
      /Ridge vent, 30 ft/.test(plain(priced)) && /\$135\.00/.test(plain(priced)) && /rec:ridge_vent:yes/.test(priced) && /rec:ridge_vent:no/.test(priced) && /Replace decking/.test(plain(priced)) && /\$200\.00/.test(plain(priced)));
    ok('the version is stamped in the document', /ATTIC_ACK_V1/.test(html) && /<!-- nbd:attic-ack ATTIC_ACK_V1 inspected -->/.test(html));
    const ni = DG.renderAtticAcknowledgment(Object.assign({ atticCheck: { status: 'not_inspected', reason: 'scheduling_nbd', notes: 'Crew was double booked' } }, base));
    const nt = plain(ni);
    ok('not inspected: the reason line prints marked, with whose schedule', /\[x\] We could not schedule it/.test(nt) && /\[x\] NBD's/.test(nt) && /\[ \] yours/.test(nt));
    ok('not inspected: the four statements print as required ticks; the acknowledgments and the savings sentence still print',
      TXT.STATEMENTS.every((s) => nt.indexOf(flat(s)) !== -1) && (ni.match(/data-nbd-ack="ack:stmt_/g) || []).length === 4 && nt.indexOf(flat(TXT.SAVINGS)) !== -1 && (ni.match(/data-nbd-required="1"/g) || []).length === 10);
    ok('not inspected: says the condition is unknown to both of us, never that mold or rot exists', /unknown to NBD and to me/.test(nt) && !/mold (is|was) (present|found)/i.test(nt));
    ok('the free later check line is the packet\'s, with the number from config', /at least 3 days before the start date/.test(nt));
    const nine = DG.renderAtticAcknowledgment(Object.assign({ atticCheck: { status: 'not_inspected', reason: 'declined' } }, base, { companyProfile: Object.assign({}, base.companyProfile, { paymentTerms: { atticFreeCheckDays: 9 } }) }));
    ok('Company Profile paymentTerms.atticFreeCheckDays changes the printed number', /at least 9 days before the start date/.test(plain(nine)));
  }

  // ═══════════════════════════════════════════════════════
  section('B. remote signing: the ticks are read back from the ORIGINAL, incomplete is refused');
  {
    const r = AG.applyAcks(FORM, tickAll(FORM, true));
    ok('a complete set of ticks is applied to the original and is complete', r.complete && /data-nbd-ack="ack:saw"[^>]*checked=""/.test(r.html));
    ok('the controls are disabled in the record', (r.html.match(/disabled=""/g) || []).length === 4);
    ok('a control the submission added is ignored', AG.applyAcks(FORM, tickAll(FORM, true) + '<input type="checkbox" data-nbd-ack="ack:evil" checked="">').acks.length === 4);
    ok('an unticked required box is incomplete', !AG.applyAcks(FORM, FORM).complete);
    ok('a Yes AND a No on one line is incomplete', !AG.applyAcks(FORM, tickAll(FORM, true).replace('data-nbd-ack="rec:decking:yes"', 'data-nbd-ack="rec:decking:yes" checked=""')).complete);
    const res = AG.resultFor('attic_acknowledgment', r.html, 5);
    ok('the result records version, decline and every tick', res.version === 'ATTIC_ACK_V1' && res.declined === true && res.complete === true && res.acknowledgments.length === 4 && res.notInspected === false);
    ok('the not-inspected page is recorded as such', AG.resultFor('attic_not_inspected', r.html, 5).notInspected === true);
    const rs = src('functions/remote-signing.js');
    ok('submitSignature applies the ticks before the burn and refuses an incomplete set', /AG\.applyAcks\(rebuilt\.html, signedHtml\)/.test(rs) && /missingAcks: true/.test(rs) && rs.indexOf('AG.applyAcks') < rs.indexOf('ATOMIC single-use burn'));
    ok('the evidence carries acknowledgments and the row carries the server-owned atticAckResult', /signatureEvidence\.acknowledgments = atticResult\.acknowledgments/.test(rs) && /docPatch\.atticAckResult/.test(rs));
    const w = src('docs/pro/js/signature-widget.js');
    ok('the widget refuses to finalize with a missing tick and writes each state into the markup', /missingAcks: ackLeft/.test(w) && /setAttribute\('checked', ''\)/.test(w));
  }

  // ═══════════════════════════════════════════════════════
  section('C. the gate: createSignRequest (remote link)');
  const P = 'documents/U1/L1/d-1.html';
  const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
    + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
    + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
    + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
    + '</section><!--nbd-cancel-packet:end-->'
    + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
  const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
  const lead = (extra) => Object.assign({ userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' }, extra || {});
  const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
  const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
    './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
  const world = (flags, o) => {
    const x = o || {};
    const s = {
      'leads/L1': lead(x.lead), 'companyProfile/U1': PROFILE,
      'estimates/E1': x.est || { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] },
      'leads/L1/documents/d1': { type: x.type || 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'U1' },
    };
    if (flags) s['feature_flags/_default'] = flags;
    (x.docs || []).forEach((d, i) => { s['leads/L1/documents/a' + i] = d; });
    (x.overrides || []).forEach((o2, i) => { s['attic_overrides/o' + i] = o2; });
    return kit.makeDb(s);
  };
  const SIGNED = { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, declined: false } };
  const mint = async (db, mod) => {
    if (mod) mod(db);
    const L = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: CONTRACT }), stubs(), REAL);
    try { return { v: await L.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana Whitfield' } }), db }; }
    catch (e) { return { e, db }; }
  };
  const tokens = (db) => db._all('doc_sign_tokens').length;
  {
    let r = await mint(world({ docAtticAckV1: true }));
    ok('flag on, a re-roof with no attic form: the link is refused with the plain message', !!r.e && r.e.code === 'failed-precondition' && /Attic, Ventilation & Moisture Acknowledgment/.test(r.e.message) && tokens(r.db) === 0, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { docs: [SIGNED] }));
    ok('flag on, with the signed form (server result present): the link goes out', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { docs: [Object.assign({}, SIGNED, { type: 'attic_not_inspected' })] }));
    ok('flag on, with the signed not-inspected page: the link goes out', !!r.v, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { docs: [Object.assign({}, SIGNED, { atticAckResult: undefined })] }));
    ok('a row the rep marked signed WITHOUT the server result does not count', !!r.e && tokens(r.db) === 0);
    r = await mint(world({ docAtticAckV1: true }, { docs: [Object.assign({}, SIGNED, { status: 'sent' })] }));
    ok('a sent but unsigned form is notice, never signed: refused', !!r.e);
    r = await mint(world({ docAtticAckV1: true }, { overrides: [{ leadId: 'L1', byUid: 'U1', reason: 'homeowner would not sign the page' }] }));
    ok('flag on, with a recorded owner override: the link goes out', !!r.v, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { overrides: [{ leadId: 'OTHER', byUid: 'U1', reason: 'a different lead' }] }));
    ok('an override on another lead does not count', !!r.e);
    r = await mint(world({ docAtticAckV1: true }, { lead: { scope: 'repair' } }));
    ok('a repair: warn only, never blocked', !!r.v, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { lead: { scope: 'siding' }, est: { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] } }));
    ok('siding: no form needed, even if the estimate has a tear-off line', !!r.v, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { est: { grandTotal: 14500, rows: [{ code: 'GTR 5K' }] } }));
    ok('an estimate with no tear-off and no scope set: not a re-roof, not blocked', !!r.v, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: true }, { type: 'attic_acknowledgment' }));
    ok('the attic form itself is never gated by the attic gate', !!r.v, r.e && r.e.message);
    r = await mint(world(null));
    ok('FLAG OFF: the same re-roof contract goes out exactly as before', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
    r = await mint(world({ docAtticAckV1: false }));
    ok('flag explicitly false: unchanged', !!r.v);
    r = await mint(world({ docAtticAckV1: true }), (db) => { const o = db.doc; db.doc = (p) => (/^feature_flags\//.test(p) ? { get: async () => { throw new Error('down'); } } : o(p)); });
    ok('an unreadable flag is a retryable refusal, never "off"', !!r.e && r.e.code === 'unavailable' && tokens(r.db) === 0);
    r = await mint(world({ docAtticAckV1: true }), (db) => { const o = db.collection; db.collection = (c) => (/documents$/.test(c) ? { where: () => ({ get: async () => { throw new Error('down'); } }) } : o(c)); });
    ok('an unreadable document list refuses (fail closed), never lets the contract through', !!r.e && r.e.code === 'unavailable' && tokens(r.db) === 0, r.e && r.e.code);
  }
  ok('the e-sign envelope runs the same gate under the strict flag read', /atticFlagForGate/.test(src('functions/esign-envelope.js')) && /AG\.decide\(db, leadId, lead\)/.test(src('functions/esign-envelope.js')));

  // ═══════════════════════════════════════════════════════
  section('D. the owner/admin override (Q18)');
  {
    const mk = () => world({ docAtticAckV1: true }, { lead: { userId: 'REP', companyId: 'CO' } });
    const fail = (c, m) => Object.assign(new Error(m), { code: c });
    const call = async (db, auth, data) => { try { return { v: await AG.recordOverride(db, auth, data, fail) }; } catch (e) { return { e }; } };
    const REASON = 'Homeowner will not sign the page; Joe approved by phone.';
    let db = mk();
    let r = await call(db, { uid: 'REP', token: { companyId: 'CO', role: 'sales_rep' } }, { leadId: 'L1', reason: REASON });
    ok('a sales rep, even the lead owner, cannot record an override', !!r.e && r.e.code === 'permission-denied' && db._all('attic_overrides').length === 0);
    r = await call(db, { uid: 'MGR', token: { companyId: 'CO', role: 'manager' } }, { leadId: 'L1', reason: REASON });
    ok('a manager cannot either', !!r.e && r.e.code === 'permission-denied');
    r = await call(db, { uid: 'OTHER', token: { companyId: 'ZZ', role: 'company_admin' } }, { leadId: 'L1', reason: REASON });
    ok('another company\'s admin cannot', !!r.e && r.e.code === 'permission-denied');
    r = await call(db, { uid: 'CO', token: { companyId: 'CO', name: 'Joe Deal' } }, { leadId: 'L1', reason: 'short' });
    ok('a reason is required (at least 10 characters)', !!r.e && r.e.code === 'invalid-argument');
    r = await call(db, { uid: 'CO', token: { companyId: 'CO', name: 'Joe Deal' } }, { leadId: 'L1', reason: REASON });
    const ev = db._all('attic_overrides')[0] || {};
    ok('the company owner can: the event carries name, uid, time, reason', !!r.v && ev.byUid === 'CO' && ev.byName === 'Joe Deal' && ev.reason === REASON && typeof ev.at === 'number' && ev.leadId === 'L1' && ev.version === 'ATTIC_ACK_V1');
    db = mk();
    r = await call(db, { uid: 'ADM', token: { role: 'company_admin', companyId: 'CO' } }, { leadId: 'L1', reason: REASON });
    ok('the company_admin of the same company can', !!r.v);
    db = mk();
    r = await call(db, { uid: 'PLAT', token: { role: 'admin' } }, { leadId: 'L1', reason: REASON });
    ok('the platform admin can', !!r.v);
    db = world({ docAtticAckV1: true }, { lead: { userId: 'REP', companyId: 'CO', scope: 'siding' } });
    r = await call(db, { uid: 'CO', token: { companyId: 'CO' } }, { leadId: 'L1', reason: REASON });
    ok('no override on a job that does not need the form', !!r.e && r.e.code === 'failed-precondition');
    const m = await mint(world({ docAtticAckV1: true }, { overrides: [ev] }));
    ok('the recorded event clears the gate', !!m.v);
    const ao = src('functions/attic-override.js');
    ok('the callable is flag-gated (strict read), App Check enforced, viewers refused, rate limited', /atticFlagForGate/.test(ao) && /enforceAppCheck: true/.test(ao) && /assertNotViewer/.test(ao) && /callableRateLimit/.test(ao));
    ok('exported from index.js', /exports\.recordAtticOverride = require\('\.\/attic-override'\)/.test(src('functions/index.js')));
  }

  // ═══════════════════════════════════════════════════════
  section('E. in-person recording');
  {
    const SP = 'documents/U1/L1/d-9.html';
    const signedCopy = AG.applyAcks(FORM, tickAll(FORM, true)).html;
    const mkIP = (docRow, extra) => {
      const s = { 'leads/L1': lead(), 'leads/L1/documents/d1': Object.assign({ status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: SP, userId: 'U1' }, docRow),
        'estimates/E1': { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] }, 'companyProfile/U1': PROFILE };
      return kit.makeDb(Object.assign(s, extra || {}));
    };
    const attic = (html) => ({ on: true, readBytes: async () => Buffer.from(html, 'utf8') });
    const run = async (db, deps) => { try { return { v: await Lg.handleInPersonSignature(db, { uid: 'U1', token: {} }, { leadId: 'L1', docId: 'd1' }, deps) }; } catch (e) { return { e }; } };
    let db = mkIP({ type: 'attic_acknowledgment' });
    let r = await run(db, { attic: attic(signedCopy) });
    const row = db._get('leads/L1/documents/d1') || {};
    ok('a completed attic form: the server writes atticAckResult from the stored signed copy', !!r.v && row.atticAckResult && row.atticAckResult.complete === true && row.atticAckResult.declined === true && row.atticAckResult.acknowledgments.length === 4, r.e && r.e.message);
    db = mkIP({ type: 'attic_acknowledgment' });
    r = await run(db, { attic: attic(FORM) });
    ok('an attic form with unticked boxes is refused and marked, never counted as signed', !!r.e && r.e.code === 'failed-precondition' && !((db._get('leads/L1/documents/d1') || {}).atticAckResult) && !!(db._get('leads/L1/documents/d1') || {}).evidenceRefused);
    db = mkIP({ type: 'attic_acknowledgment' });
    r = await run(db, { attic: { on: true, readBytes: async () => { throw new Error('x'); } } });
    ok('an unreadable stored copy is a retryable refusal', !!r.e && r.e.code === 'unavailable');
    db = mkIP({ type: 'contract' });
    r = await run(db, { attic: attic('') });
    ok('in-person contract, re-roof, no attic form: refused and marked', !!r.e && /Attic, Ventilation/.test(r.e.message) && !!(db._get('leads/L1/documents/d1') || {}).evidenceRefused);
    db = mkIP({ type: 'contract' }, { 'leads/L1/documents/a0': SIGNED });
    r = await run(db, { attic: attic('') });
    ok('in-person contract with the signed form: recorded', !!r.v, r.e && r.e.message);
    db = mkIP({ type: 'contract' });
    r = await run(db, undefined);
    ok('FLAG OFF (no attic deps): the in-person contract records exactly as before', !!r.v, r.e && r.e.message);
    // the evidence record carries the acknowledgments (flag docEvidenceFoundation on as well)
    db = mkIP({ type: 'attic_acknowledgment' });
    r = await run(db, { attic: attic(signedCopy), evidence: { enabled: true, ip: '203.0.113.5', ua: 'x', ipSource: 'x', readBytes: async () => Buffer.from(signedCopy, 'utf8') } });
    const ev = ((db._get('leads/L1/documents/d1') || {}).signatureEvidence) || {};
    ok('the in-person evidence records acknowledgments: [{ id, checked }]', !!r.v && Array.isArray(ev.acknowledgments) && ev.acknowledgments.length === 4 && ev.acknowledgments.some((a) => a.id === 'rec:decking:no' && a.checked === true), r.e && r.e.message);
    const ip = src('functions/in-person-signing.js');
    ok('the callable reads the attic flag strictly and passes only when on', /atticFlagForGate/.test(ip) && /\(evidence \|\| attic\)/.test(ip));
  }

  // ═══════════════════════════════════════════════════════
  section('F. the firestore rules carry the new server-owned field and collection');
  {
    const rules = src('firestore.rules');
    ok('atticAckResult is server-owned on documents (create and update)', (rules.match(/'evidenceRefused', 'atticAckResult'\]/g) || []).length === 2);
    ok('attic_overrides is write:false', /match \/attic_overrides\/\{id\}[\s\S]{0,400}allow write: if false;/.test(rules));
  }

  // ═══════════════════════════════════════════════════════
  section('G. client: the panel, the client gate, the warranty line (flag off = nothing)');
  {
    const gen = src('docs/pro/js/document-generator.js');
    ok('generate() runs the client attic gate and the warranty line read', /await this\._atticGate\(type, data\)/.test(gen) && /_atticWarrantyLine\(data\)/.test(gen));
    ok('the client gate is flag-gated and lenient on unreadable data (the server decides)', /_atticOn\(\)/.test(gen) && /unreadable: the server gate decides/.test(gen));
    const tpl = src('docs/pro/js/document-generator-templates.js');
    ok('the warranty certificate prints ONLY d.atticExclusionLine, nothing when absent', /typeof d\.atticExclusionLine === 'string' && d\.atticExclusionLine/.test(tpl));
    const H = require('./helpers/clause-v1-harness');
    const env = H.docs({});
    const W = env.win.NBDDocGen;
    const cert = W.renderWarrantyCertificate({ homeownerName: 'Jane Smith', address: '1 Oak', warrantyTier: 'better', issueDate: '2026-11-18', leadId: 'L1' });
    const cert2 = W.renderWarrantyCertificate({ homeownerName: 'Jane Smith', address: '1 Oak', warrantyTier: 'better', issueDate: '2026-11-18', leadId: 'L1', atticExclusionLine: AA.warrantyLine('November 18, 2026') });
    ok('no line: the certificate has no attic text (flag off, identical)', !/Attic, Ventilation/.test(cert));
    ok('with the line: WAR-2 attic sentence and the form date print', /Attic, Ventilation &amp; Moisture Acknowledgment/.test(cert2) && /November 18, 2026/.test(cert2));
    const pn = src('docs/pro/js/attic-panel.js');
    ok('the panel is CSP-clean: no inline handler, no inline script, delegated listeners', !/\son(click|change|input)\s*=/i.test(pn) && /document\.addEventListener\('click'/.test(pn) && /document\.addEventListener\('change'/.test(pn));
    ok('photos go through the CRM photo upload; an unpriced line is shown as hidden', /PhotoEngine\.uploadFromFile/.test(pn) && /no price set: hidden/.test(pn));
    ok('the free later check is a rep task due by atticFreeCheckDays (else contract + 7 days)', /freeCheckDue\(\{ startMs: start/.test(pn) && /'tasks'/.test(pn));
    ok('the panel loads on the customer page only, and only does anything with the flag on', pn.indexOf('customer(?:') !== -1 && pn.indexOf('function on()') !== -1);
    ok('customer.html loads it with defer, script-loader carries the logic files', /<script defer src="js\/attic-panel\.js\?v=1"><\/script>/.test(src('docs/pro/customer.html')) && /attic-ack\.js\?v=1/.test(src('docs/pro/js/script-loader.js')));
  }

  // ═══════════════════════════════════════════════════════
  section('H. the deal page (the Kentucky insurance acceptance path, Q72): the mint is gated');
  {
    const CS = require(path.join(FN, 'clause-set.js'));
    const DEAL_PATH = 'deal_rooms/U1/deal0001.html';
    const REALD = ['./cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './await-briefly', './portal-after-signing', './signed-price', './customer-estimate-rows', './doc-send-checks', './attic-gate', './attic-ack', 'crypto'];
    const stubsD = () => ({
      './deal-install-date': { fillLeadInstallDate: async () => null },
      './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
      './estimate-send-logic': {}, './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/x.js' },
      './deal-accepted-tier': { applyAcceptedTier: async () => {} },
      './ky-insurance-law': K, './cancel-window': require(path.join(FN, 'cancel-window.js')), './esign-logic': ESL, './doc-evidence': DE,
    });
    const PAGE = '<html><head></head><body><p>Your roof.</p><div class="section-title">Sign &amp; Schedule</div><div class="sign-section">sign</div></body></html>';
    const mintDeal = async (flags, o) => {
      const x = o || {};
      const s = {
        'deal_rooms/deal0001': { status: 'sent', userId: 'U1', leadId: 'L1', customerName: 'Dana Whitfield', tiers: { better: { price: 13000 } } },
        'leads/L1': { userId: 'U1', companyId: 'U1', address: '12 Oak St, Covington, KY 41011', jobType: 'insurance', primaryEstimateId: 'E1' },
        'estimates/E1': { grandTotal: 13000, rows: [{ code: 'LAB TO1' }] },
        'companyProfile/U1': { paymentTerms: Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 10000 }) },
      };
      if (flags) s['feature_flags/_default'] = flags;
      if (x.signed) s['leads/L1/documents/a0'] = SIGNED;
      const db = kit.makeDb(s);
      const L = kit.loadHandler('deal-acceptance.js', db, kit.makeStorage({ [DEAL_PATH]: PAGE }), stubsD(), REALD);
      try { return { v: await L.fns.createDealAcceptToken({ auth: { uid: 'U1', token: {} }, data: { dealId: 'deal0001' } }), db }; } catch (e) { return { e, db }; }
    };
    let r = await mintDeal({ docAtticAckV1: true });
    ok('flag on, a re-roof deal with no attic form: no link is minted, plain message', !!r.e && r.e.code === 'failed-precondition' && /Attic, Ventilation/.test(r.e.message) && r.db._all('deal_accept_tokens').length === 0, r.e && r.e.message);
    r = await mintDeal({ docAtticAckV1: true }, { signed: true });
    ok('flag on, with the signed form: the link is minted', !!r.v && !!r.v.token, r.e && r.e.message);
    r = await mintDeal(null);
    ok('FLAG OFF: the deal link mints exactly as before', !!r.v && !!r.v.token, r.e && r.e.message);
    ok('the gate also covers a deal with no lead? No: reported, not gated', /A deal with no lead/.test(src('functions/deal-acceptance.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
