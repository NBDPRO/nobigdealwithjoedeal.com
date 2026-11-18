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

  // ═══════════════════════════════════════════════════════
  section('2. a forged acknowledgment never counts: the stored HTML is compared to the server\'s own manifest');
  {
    const H = require('./helpers/clause-v1-harness');
    const envG = H.docs({ flags: { docAtticAckV1: true } });
    ['docs/pro/js/attic-ack-text.js', 'docs/pro/js/attic-ack.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => H.load(envG, f));
    const DG = envG.win.NBDDocGen;
    const base = { homeownerName: 'Jane Smith', address: '12 Oak St', contractDate: '2026-11-18', companyProfile: H.profileFor(envG.win, H.BIZ_ADDR), formDate: '2026-11-18',
      signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Rep', required: true }] };
    const render = (rec) => DG.renderAtticAcknowledgment(Object.assign({ atticCheck: rec }, base));
    const insp = { status: 'inspected', inspectedOn: '2026-11-17', accessPoint: 'hatch', conditions: { mold: true }, photos: [{ id: 'p1', kind: 'overview' }, { id: 'p2', kind: 'cond:mold' }], vent: { floorSqFt: 1200, rule: '1/300' }, recs: [] };
    const INSP = render(insp);
    const NI = render({ status: 'not_inspected', reason: 'declined' });
    // the homeowner's ticks: every checkbox, the Yes of every line
    const tick = (html) => html.replace(/<input\b[^>]*>/gi, (tag) => (/type="radio"/.test(tag) && !/:yes"/.test(tag) ? tag : tag.replace(/>$/, ' checked="">')));
    const V = (type, html) => AG.verifyManifest(type, html);
    ok('the real inspected form passes the manifest as attic_acknowledgment', V('attic_acknowledgment', INSP).ok, JSON.stringify(V('attic_acknowledgment', INSP).reasons));
    ok('the real not-inspected page passes as attic_not_inspected', V('attic_not_inspected', NI).ok, JSON.stringify(V('attic_not_inspected', NI).reasons));
    ok('a signed (ticked) copy of the real form still passes (ticks are not part of the manifest)', V('attic_acknowledgment', tick(INSP)).ok);
    ok('wrong doc type: the inspected form as attic_not_inspected is refused', !V('attic_not_inspected', INSP).ok);
    ok('wrong doc type: the not-inspected page as attic_acknowledgment is refused', !V('attic_acknowledgment', NI).ok);
    ok('a type that is not an attic form is refused', !V('contract', INSP).ok);
    ok('stripped required flags (every one) are refused', !V('attic_acknowledgment', INSP.replace(/ data-nbd-required="1"/g, '')).ok);
    ok('ONE stripped required flag is refused', !V('attic_acknowledgment', INSP.replace(' data-nbd-required="1"', '')).ok);
    ok('an extra required control is refused', !V('attic_acknowledgment', INSP.replace('</body>', '<input type="checkbox" data-nbd-ack="ack:evil" data-nbd-required="1"></body>')).ok);
    ok('an extra non-required control is refused', !V('attic_acknowledgment', INSP.replace('</body>', '<input type="checkbox" data-nbd-ack="ack:extra"></body>')).ok);
    ok('an extra radio with a made-up line id is refused', !V('attic_acknowledgment', INSP.replace('</body>', '<input type="radio" data-nbd-ack="rec:free_roof:yes"><input type="radio" data-nbd-ack="rec:free_roof:no"></body>')).ok);
    ok('a missing required control is refused', !V('attic_acknowledgment', INSP.replace(/<input[^>]*data-nbd-ack="ack:moisture"[^>]*>/, '')).ok);
    ok('a recommendation line made required is refused', !V('attic_acknowledgment', INSP.replace('data-nbd-ack="rec:third_party_1:yes"', 'data-nbd-ack="rec:third_party_1:yes" data-nbd-required="1"')).ok);
    ok('a Yes with no No (half a line) is refused', !V('attic_acknowledgment', INSP.replace(/<input[^>]*data-nbd-ack="rec:third_party_2:no"[^>]*>/, '')).ok);
    ok('a marker that says the other variant is refused', !V('attic_acknowledgment', INSP.replace('inspected -->', 'not_inspected -->')).ok);
    ok('no marker at all is refused', !V('attic_acknowledgment', INSP.replace(/<!-- nbd:attic-ack[^>]*-->/, '')).ok);
    const TXT = require(path.join(FN, 'attic-ack-text.js'));
    const flat = (s) => s.replace(/\*\*/g, '');
    ok('an acknowledgment paragraph reworded is refused', INSP.indexOf('Items I declined.') !== -1 && !V('attic_acknowledgment', INSP.replace('Items I declined.', 'Items I accepted.')).ok);
    ok('the savings sentence reworded is refused', INSP.indexOf('Nothing in this form limits') !== -1 && !V('attic_acknowledgment', INSP.replace('Nothing in this form limits', 'Something in this form limits')).ok);
    ok('the why-we-check paragraph deleted is refused', !V('attic_acknowledgment', INSP.replace(/<p class="aa-p"><strong>Why we check[\s\S]*?<\/p>/, '')).ok);
    const HAND = '<html><body><!-- nbd:attic-ack ATTIC_ACK_V1 inspected --><h1>Attic</h1><input type="checkbox" data-nbd-ack="ack:saw"><div data-nbd-sig="homeowner"></div></body></html>';
    ok('hand-written HTML with one non-required control is refused', !V('attic_acknowledgment', HAND).ok);
    ok('the OLD test fixture (six hand-written controls) is refused too', !V('attic_acknowledgment', '<html><body><input type="checkbox" data-nbd-ack="ack:saw" data-nbd-required="1"><input type="checkbox" data-nbd-ack="ack:existing" data-nbd-required="1"></body></html>').ok);
    ok('a hostile id with markup is refused', !V('attic_acknowledgment', INSP.replace('</body>', '<input type="checkbox" data-nbd-ack="ack:x&quot;"></body>')).ok);
    ok('the NBD name is accepted as "Contractor" for another tenant (words(), isNbd false)', V('attic_acknowledgment', INSP.replace(/\bNBD\b/g, 'Contractor')).ok);

    // resultFor: complete only for a manifest-clean, fully ticked copy
    const good = AG.resultFor('attic_acknowledgment', tick(INSP), 5);
    ok('resultFor: the real form fully ticked is complete', good.complete === true && good.manifestOk === true);
    const forged = AG.resultFor('attic_acknowledgment', HAND.replace('data-nbd-ack="ack:saw"', 'data-nbd-ack="ack:saw" checked=""'), 5);
    ok('resultFor: a hand-written form with its one control ticked is NOT complete', forged.complete === false && forged.manifestOk === false);
    ok('resultFor: the real form with the required boxes unticked is not complete', AG.resultFor('attic_acknowledgment', INSP, 5).complete === false);
    ok('applyAcks on a hand-written original is not complete', AG.applyAcks(HAND, HAND.replace('data-nbd-ack="ack:saw"', 'data-nbd-ack="ack:saw" checked=""')).complete === false);
    ok('applyAcks on the real original with the real ticks is complete', AG.applyAcks(INSP, tick(INSP)).complete === true);

    // in-person: the rep's own stored HTML
    const SP = 'documents/REP/L1/d-9.html';
    const mkIP = (docRow) => kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'companyProfile/CO': PROFILE,
      'leads/L1/documents/d1': Object.assign({ status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: SP, userId: 'REP' }, docRow) });
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const runIP = async (db, html) => { try { return { v: await Lg.handleInPersonSignature(db, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { on: true, readBytes: async () => Buffer.from(html, 'utf8') } }) }; } catch (e) { return { e }; } };
    let db = mkIP({ type: 'attic_acknowledgment' });
    let r = await runIP(db, tick(INSP));
    ok('in-person: the real form, fully ticked: the server result is written', !!r.v && (db._get('leads/L1/documents/d1') || {}).atticAckResult && db._get('leads/L1/documents/d1').atticAckResult.complete === true, r.e && r.e.message);
    db = mkIP({ type: 'attic_acknowledgment' });
    r = await runIP(db, HAND.replace('data-nbd-ack="ack:saw"', 'data-nbd-ack="ack:saw" checked=""'));
    ok('in-person: a rep\'s hand-written HTML with its one control ticked: refused, marked, NO atticAckResult', !!r.e && r.e.code === 'failed-precondition' && !(db._get('leads/L1/documents/d1') || {}).atticAckResult && !!(db._get('leads/L1/documents/d1') || {}).evidenceRefused);
    db = mkIP({ type: 'attic_not_inspected' });
    r = await runIP(db, tick(INSP));
    ok('in-person: the inspected form recorded under the not-inspected doc type: refused', !!r.e && !(db._get('leads/L1/documents/d1') || {}).atticAckResult);

    // remote: the rep-authored ORIGINAL is re-validated before the submission is accepted
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const GP = 'documents/REP/L1/d-1.html';
    const sign = (orig) => orig.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/g, '<img src="' + PNG + '" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">')
      .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/g, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
      .replace(/data-nbd-sig="(homeowner|rep)"/g, 'data-nbd-sig="$1" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
    const REMOTE = async (orig, signed, docType) => {
      const db2 = kit.makeDb({ 'leads/L1': lead(), 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: docType, htmlPath: GP },
        'doc_sign_tokens/TOKATTIC0001': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: GP, signerName: 'Dana Whitfield', docType, consentAsked: false } });
      const st = kit.makeStorage({ [GP]: orig });
      const Lr = kit.loadHandler('remote-signing.js', db2, st, stubs(), REAL);
      const sub = kit.reqRes({ token: 'TOKATTIC0001', signedHtml: signed });
      await Lr.fns.submitSignature(sub.req, sub.res);
      return { db: db2, res: sub.res, tok: db2._get('doc_sign_tokens/TOKATTIC0001'), doc: db2._get('leads/L1/documents/d1') };
    };
    const FORGED = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Attic</title></head><body><h1>Attic</h1><!-- nbd:attic-ack ATTIC_ACK_V1 inspected --><input type="checkbox" data-nbd-ack="ack:saw">'
      + '<div class="nbd-sig-block" data-nbd-sig="homeowner" data-label="Homeowner" data-required="true"><div class="nbd-sig-label">Homeowner</div><canvas class="nbd-sig-canvas"></canvas><div class="nbd-sig-controls"><button type="button" data-nbd-sig-action="clear">Clear</button><span class="nbd-sig-state"></span></div><div class="nbd-sig-print-name">Print Name &amp; Date</div></div><script src="/pro/js/signature-widget.js"></script></body></html>';
    let x = await REMOTE(FORGED, sign(FORGED).replace('data-nbd-ack="ack:saw"', 'data-nbd-ack="ack:saw" checked=""'), 'attic_acknowledgment');
    ok('remote: a rep-authored original with one non-required control is refused (422) and the link is NOT burned', x.res.statusCode === 422 && x.tok.status === 'pending' && !(x.doc && x.doc.atticAckResult), x.res.statusCode + ' ' + JSON.stringify(x.res.body));
    const ORIG_OK = INSP;
    x = await REMOTE(ORIG_OK, tick(sign(ORIG_OK)), 'attic_acknowledgment');
    ok('remote: the real form, ticked and signed, is accepted and the server result is written', x.res.statusCode === 200 && !!(x.doc && x.doc.atticAckResult && x.doc.atticAckResult.complete === true), x.res.statusCode + ' ' + JSON.stringify(x.res.body));
    x = await REMOTE(ORIG_OK, tick(sign(ORIG_OK)), 'attic_not_inspected');
    ok('remote: the inspected form sent as the not-inspected document type is refused', x.res.statusCode === 422 && x.tok.status === 'pending');
  }

  // ═══════════════════════════════════════════════════════
  section('4. the deal page: no resolvable lead falls back to the deal\'s own estimate, else refuses (fail closed)');
  {
    const CS = require(path.join(FN, 'clause-set.js'));
    const DEAL_PATH = 'deal_rooms/REP/deal0001.html';
    const REALD = ['./cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './await-briefly', './portal-after-signing', './signed-price', './customer-estimate-rows', './doc-send-checks', './attic-gate', './attic-ack', 'crypto'];
    const stubsD = () => ({
      './deal-install-date': { fillLeadInstallDate: async () => null },
      './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
      './estimate-send-logic': {}, './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/x.js' },
      './deal-accepted-tier': { applyAcceptedTier: async () => {}, dealTierPrices: (t) => t },
      './ky-insurance-law': K, './cancel-window': require(path.join(FN, 'cancel-window.js')), './esign-logic': ESL, './doc-evidence': DE,
    });
    const PAGE = '<html><head></head><body><p>Your roof.</p><div class="section-title">Sign &amp; Schedule</div><div class="sign-section">sign</div></body></html>';
    const mintDeal = async (flags, o) => {
      const x = o || {};
      const s = {
        'deal_rooms/deal0001': Object.assign({ status: 'sent', userId: 'REP', customerName: 'Dana Whitfield', tiers: { better: { price: 13000 } } }, x.deal),
        'companyProfile/CO': { paymentTerms: Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 10000 }) },
      };
      if (x.lead !== null) s['leads/L1'] = lead(Object.assign({ address: '12 Oak St, Covington, KY 41011', jobType: 'insurance' }, x.lead));
      if (x.est) s['estimates/E1'] = Object.assign({ userId: 'REP' }, x.est);
      Object.entries(flags || {}).forEach(([id, v]) => { s['feature_flags/' + id] = v; });
      if (x.signed) s['leads/L1/documents/a0'] = SIGNED;
      const db = kit.makeDb(s);
      const L = kit.loadHandler('deal-acceptance.js', db, kit.makeStorage({ [DEAL_PATH]: PAGE }), stubsD(), REALD);
      try { return { v: await L.fns.createDealAcceptToken({ auth: { uid: 'REP', token: { companyId: 'CO', role: 'sales_rep' } }, data: { dealId: 'deal0001' } }), db }; } catch (e) { return { e, db }; }
    };
    const deals = (db) => db._all('deal_accept_tokens').length;
    const NOTEAR = { grandTotal: 13000, rows: [{ code: 'GTR 5K' }] };
    let r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1' }, lead: { primaryEstimateId: 'E1' }, est: REROOF });
    ok('control: a re-roof deal linked to a lead with no attic form is refused under the OWNER\'s flag (rep flag off)', !!r.e && r.e.code === 'failed-precondition' && deals(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { estimateId: 'E1' }, lead: null, est: REROOF });
    ok('no lead, the deal\'s own estimate has a tear-off line: no link is minted', !!r.e && r.e.code === 'failed-precondition' && /Attic, Ventilation/.test(r.e.message) && deals(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: {}, lead: null });
    ok('no lead and no estimate: refused (fail closed), nothing minted', !!r.e && r.e.code === 'failed-precondition' && deals(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'GHOST' }, lead: null });
    ok('a deal pointing at a lead that does not exist, with no estimate: refused', !!r.e && deals(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { estimateId: 'E1' }, lead: null, est: NOTEAR });
    ok('no lead, the deal\'s own estimate has no tear-off line: minted', !!r.v && deals(r.db) === 1, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1', estimateId: 'E1' }, lead: { scope: 'repair' }, est: REROOF });
    ok('a lead set to repair but the deal\'s estimate has a tear-off line: refused', !!r.e && r.e.code === 'failed-precondition');
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1' }, lead: { primaryEstimateId: 'E1' }, est: REROOF, signed: true });
    ok('the signed form clears it', !!r.v, r.e && r.e.message);
    r = await mintDeal({ _default: {} }, { deal: {}, lead: null });
    ok('FLAG OFF: a deal with no lead and no estimate mints exactly as before', !!r.v && deals(r.db) === 1, r.e && r.e.message);
    ok('the source says a deal with no resolvable lead falls back to its own estimate and refuses when neither resolves', /no resolvable lead/i.test(src('functions/deal-acceptance.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
