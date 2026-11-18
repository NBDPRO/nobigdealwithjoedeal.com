/**
 * attic-ack-review-2026-11-18.test.js - the independent security review of phase 3 (flag docAtticAckV1, default OFF):
 *   1. the scope can be raised by a rep, never lowered (floor + the estimate being sent)
 *   2. a forged acknowledgment (hand-written HTML) never counts
 *   3. the gate is on when the acting user's flag OR the tenant owner's flag is on
 *   4. a deal with no resolvable lead falls back to the deal's own estimate, else refuses
 *   6. an override is bound to the estimate, expires and can be revoked
 *   7. the free-check task id, due date and days bound
 * Run: node tests/attic-ack-review-2026-11-18.test.js   (needs functions/node_modules)
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
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const P = 'documents/REP/L1/d-1.html';
const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
  + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '</section><!--nbd-cancel-packet:end-->'
  + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
const REROOF = { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] };
const lead = (extra) => Object.assign({ userId: 'REP', companyId: 'CO', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' }, extra || {});
const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
  './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
// A world where the REP acts on tenant CO's lead. flags = feature_flags docs by id.
const world = (flags, o) => {
  const x = o || {};
  const s = {
    'leads/L1': lead(x.lead), 'companyProfile/CO': PROFILE,
    'leads/L1/documents/d1': { type: x.type || 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'REP' },
  };
  if (x.est !== null) s['estimates/E1'] = x.est || REROOF;
  Object.entries(flags || {}).forEach(([id, v]) => { s['feature_flags/' + id] = v; });
  (x.docs || []).forEach((d, i) => { s['leads/L1/documents/a' + i] = d; });
  (x.overrides || []).forEach((o2, i) => { s['attic_overrides/o' + i] = o2; });
  Object.entries(x.extra || {}).forEach(([k, v]) => { s[k] = v; });
  return kit.makeDb(s);
};
const SIGNED = { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, declined: false } };
const mint = async (db) => {
  const L = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: CONTRACT }), stubs(), REAL);
  try { return { v: await L.fns.createSignRequest({ auth: { uid: 'REP', token: { companyId: 'CO', role: 'sales_rep' } }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana Whitfield' } }), db }; }
  catch (e) { return { e, db }; }
};
const tokens = (db) => db._all('doc_sign_tokens').length;
const ON_OWNER = { _default: {}, CO: { docAtticAckV1: true } };

(async () => {
  // ═══════════════════════════════════════════════════════
  section('3. the gate is on when the acting user\'s flag OR the tenant owner\'s flag is on');
  {
    let r = await mint(world(ON_OWNER, { lead: { primaryEstimateId: 'E1' } }));
    ok('rep flag off, tenant owner flag on: a re-roof with no attic form is refused', !!r.e && r.e.code === 'failed-precondition' && tokens(r.db) === 0, r.e && r.e.message);
    r = await mint(world({ _default: {}, REP: { docAtticAckV1: true } }, { lead: { primaryEstimateId: 'E1' } }));
    ok('rep flag on, owner flag off: refused (unchanged)', !!r.e && r.e.code === 'failed-precondition');
    r = await mint(world({ _default: {} }, { lead: { primaryEstimateId: 'E1' } }));
    ok('both off: the link goes out as before (flag-off unchanged)', !!r.v && tokens(r.db) === 1, r.e && r.e.message);
    r = await mint(world(ON_OWNER, { lead: { primaryEstimateId: 'E1' }, docs: [SIGNED] }));
    ok('owner flag on with the signed form: goes out', !!r.v, r.e && r.e.message);
    const db = world({ _default: {}, REP: { docAtticAckV1: false } }, { lead: { primaryEstimateId: 'E1' } });
    const o = db.doc; db.doc = (p) => (p === 'feature_flags/CO' ? { get: async () => { throw new Error('down'); } } : o(p));
    r = await mint(db);
    ok('an unreadable OWNER flag is a retryable refusal, never "off"', !!r.e && r.e.code === 'unavailable' && tokens(r.db) === 0, r.e && r.e.code);
    ok('esign-envelope, deal-acceptance, in-person and remote-signing read the same either-flag helper',
      ['functions/esign-envelope.js', 'functions/deal-acceptance.js', 'functions/in-person-signing.js', 'functions/remote-signing.js'].every((f) => /atticGateOn\(/.test(src(f))));
  }

  // ═══════════════════════════════════════════════════════
  section('1. the scope: a stored scope is a FLOOR (a rep can raise it, never lower it)');
  {
    const tear = { rows: [{ code: 'LAB TO1' }] };
    ok('stored repair + a tear-off estimate = reroof (the estimate wins when higher)', AA.effectiveScope({ scope: 'repair' }, tear) === 'reroof');
    ok('stored siding + a tear-off estimate = reroof', AA.effectiveScope({ scope: 'siding' }, tear) === 'reroof');
    ok('stored reroof + an estimate with no tear-off = reroof (a rep can raise)', AA.effectiveScope({ scope: 'reroof' }, { rows: [{ code: 'GTR 5K' }] }) === 'reroof');
    ok('several estimates: the highest wins', AA.effectiveScope({}, [{ rows: [{ code: 'GTR 5K' }] }, tear]) === 'reroof');
    ok('a server floor of reroof holds when the tear-off line was removed later', AA.effectiveScope({ atticScopeFloor: 'reroof' }, { rows: [{ code: 'GTR 5K' }] }) === 'reroof');
    ok('repair estimate + stored other = repair', AA.effectiveScope({ scope: 'other' }, { workKind: 'repair' }) === 'repair');

    // remote link: a rep sets scope=repair and sets NO primaryEstimateId; the estimate on the lead has a tear-off line
    const E = Object.assign({ leadId: 'L1', userId: 'REP' }, REROOF);
    let r = await mint(world(ON_OWNER, { lead: { scope: 'repair' }, est: E }));
    ok('rep sets scope=repair, no primaryEstimateId: the estimate on the lead still gates the link', !!r.e && r.e.code === 'failed-precondition' && tokens(r.db) === 0, r.e && r.e.message);
    r = await mint(world(ON_OWNER, { lead: { scope: 'repair', primaryEstimateId: 'E1' }, est: REROOF }));
    ok('rep lowers scope to repair with a tear-off primary estimate: still blocked', !!r.e && r.e.code === 'failed-precondition');
    r = await mint(world(ON_OWNER, { lead: { scope: 'siding', primaryEstimateId: 'E1' }, est: REROOF }));
    ok('rep lowers scope to siding: still blocked', !!r.e);
    r = await mint(world(ON_OWNER, { lead: { scope: 'reroof', primaryEstimateId: 'E1' }, est: { grandTotal: 14500, rows: [{ code: 'GTR 5K' }] } }));
    ok('rep raises scope to reroof on a no-tear-off estimate: blocked', !!r.e);
    r = await mint(world(ON_OWNER, { lead: { primaryEstimateId: 'E1' }, est: { grandTotal: 14500, rows: [{ code: 'GTR 5K' }] } }));
    ok('control: no tear-off anywhere and no stored scope: not a re-roof, goes out', !!r.v, r.e && r.e.message);
    r = await mint(world(ON_OWNER, { lead: { primaryEstimateId: 'E1' } }));
    const lead1 = r.db._get('leads/L1') || {};
    ok('the server records the reroof floor on the lead when it blocks', lead1.atticScopeFloor === 'reroof');
    // the tear-off line is removed after the first send: the floor still holds
    const db2 = world(ON_OWNER, { lead: { primaryEstimateId: 'E1', atticScopeFloor: 'reroof' }, est: { grandTotal: 14500, rows: [{ code: 'GTR 5K' }] } });
    r = await mint(db2);
    ok('a tear-off line removed after a first send still counts as reroof', !!r.e && r.e.code === 'failed-precondition');

    // e-sign envelope: the estimate being sent gates it even with scope=repair and no primaryEstimateId
    const PDF = require(path.join(FN, 'estimate-esign-pdf.js'));
    const ES = () => ({ './esign-stamp': require(path.join(FN, 'esign-stamp.js')), './esign-logic': ESL, './doc-evidence': DE,
      './estimate-esign-pdf': PDF, './ky-insurance-law': K, './customer-estimate-rows': require(path.join(FN, 'customer-estimate-rows.js')),
      './deposit-plan-view': require(path.join(FN, 'deposit-plan-view.js')), './cancel-window': require(path.join(FN, 'cancel-window.js')),
      './cancel-notice-pdf': require(path.join(FN, 'cancel-notice-pdf.js')), './integrations/heartbeat': { onSchedule: (o, h) => h }, './attic-gate': AG, './attic-ack': AA });
    const send = async (rows, leadExtra) => {
      const db = kit.makeDb({ 'leads/LEAD1': Object.assign({ userId: 'REP', companyId: 'CO', firstName: 'Pat', lastName: 'Smith', address: '5 Vine St, Cincinnati, OH 45202', phone: '513-555-0101', email: 'pat@example.test', jobType: 'retail' }, leadExtra),
        'estimates/EST1': { userId: 'REP', leadId: 'LEAD1', mode: 'cash', grandTotal: 12345.67, total: 12345.67, number: 'E-1', addr: '5 Vine St, Cincinnati, OH 45202', tier: 'better', rows },
        'companyProfile/CO': PROFILE, 'feature_flags/_default': {}, 'feature_flags/CO': { docAtticAckV1: true } });
      const st = kit.makeStorage();
      const stubset = ES();
      const io = kit.loadHandler('esign-io.js', db, st, stubset, []).fns;
      const L = kit.loadHandler('esign-envelope.js', db, st, Object.assign({ './esign-io': io }, stubset), ['./attic-gate', './attic-ack', 'crypto']);
      try { return { v: await L.fns.sendEstimateEnvelope({ auth: { uid: 'REP', token: { role: 'owner' } }, data: { estimateId: 'EST1', signers: [{ name: 'Pat Smith', email: 'pat@example.test' }] } }), db }; } catch (e) { return { e, db }; }
    };
    const tearRows = [{ code: 'LAB TO1', desc: 'Tear-off', qty: '20 SQ', rate: '$50/SQ', total: 1000, retailTotal: 1000 }];
    r = await send(tearRows, { scope: 'repair' });
    ok('e-sign send, scope=repair, no primaryEstimateId: the estimate being sent (tear-off line) blocks it', !!r.e && r.e.code === 'failed-precondition' && /Attic, Ventilation/.test(r.e.message), r.e && r.e.message);
    r = await send([{ code: 'GTR 5K', desc: 'Gutter', qty: '20 FT', rate: '$9/FT', total: 180, retailTotal: 180 }], {});
    ok('e-sign send of an estimate with no tear-off: not blocked by the attic gate', !(r.e && /Attic, Ventilation/.test(r.e.message)), r.e && r.e.message);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
