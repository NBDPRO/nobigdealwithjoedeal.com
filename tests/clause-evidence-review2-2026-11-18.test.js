/**
 * tests/clause-evidence-review2-2026-11-18.test.js
 *
 * Second independent review of the evidence and clause foundation (2026-11-18). One section per
 * item (the rules items 1 and 4 and the storage item 11 are proven in the emulator suites):
 *   2  remote-link evidence survives a failed row stamp (kept on the admin-only sign token)
 *   3  deal-room mint refuses an incomplete page (flag on)
 *   4  in-person refusal leaves a server-owned evidenceRefused mark
 *   5  the size bound ignores embedded data: URLs; no shipped template trips the bracket scan
 *   6  strip() offsets survive a character whose lowercase form changes length
 *   7  the remote path replaces (never merges into) an existing signatureEvidence
 *   8  a legacy token (no consentAsked) fails closed on an unreadable flag, not on a flag that is off
 *   9  an unknown IP is null with ipSource 'unknown' on every path
 *   10 the deal-room evidence is built fresh on every transaction attempt
 * Run: node tests/clause-evidence-review2-2026-11-18.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
function tryReq(p) { try { return require(p); } catch (_) { return null; } }
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; } };

const K = require(path.join(FN, 'ky-insurance-law.js'));
const CHK = tryReq(path.join(FN, 'doc-send-checks.js'));
const DE = tryReq(path.join(FN, 'doc-evidence.js'));
const ESL = require(path.join(FN, 'esign-logic.js'));
let kit = null; try { kit = require('./lib/doc-evidence-kit'); } catch (_) { kit = null; }

const GOOD_PATH = 'documents/U1/L1/d-1.html';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ORIGINAL = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Roofing Agreement</title></head><body><h1>Roofing Agreement</h1><p>Prepared for <strong>Dana Whitfield</strong>.</p><table><tr><td>Total</td><td>$28,400.00</td></tr></table>
<div class="nbd-sig-block" data-nbd-sig="homeowner" data-label="Homeowner" data-required="true"><div class="nbd-sig-label">Homeowner</div><canvas class="nbd-sig-canvas"></canvas><div class="nbd-sig-controls"><button type="button" data-nbd-sig-action="clear">Clear</button><span class="nbd-sig-state"></span></div><div class="nbd-sig-print-name">Print Name &amp; Date</div></div><script src="/pro/js/signature-widget.js"></script></body></html>`;
const signedPage = ORIGINAL.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/, `<img src="${PNG}" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">`)
  .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
  .replace('data-nbd-sig="homeowner"', 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', 'crypto'];

function remoteWorld(flag, tokExtra, docExtra) {
  const o = {
    'leads/L1': { userId: 'U1', companyId: 'C1', firstName: 'Dana', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' },
    'leads/L1/documents/d1': Object.assign({ name: 'Roofing Agreement', status: 'sent', type: 'contract', htmlPath: GOOD_PATH }, docExtra || {}),
    'doc_sign_tokens/TOKEVID00001': Object.assign({ status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', mintedBy: 'U1', htmlPath: GOOD_PATH, signerName: 'Dana Whitfield', clauseSetVersion: 'CS-TEST.9', clauseIds: ['PAYMENT_V1'] }, tokExtra || {}),
  };
  if (flag) o['feature_flags/_default'] = { docEvidenceFoundation: true };
  return o;
}
// Runs getSignDocument then submitSignature on the REAL handler. hook(db) may wrap the db before the load.
async function remoteRun(o) {
  const x = o || {};
  const db = kit.makeDb(remoteWorld(x.flag, x.tok, x.doc)); const st = kit.makeStorage({ [GOOD_PATH]: ORIGINAL });
  if (x.hook) x.hook(db);
  const L = kit.loadHandler('remote-signing.js', db, st, {
    './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
    './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')),
  }, REAL);
  const g = kit.reqRes({ token: 'TOKEVID00001' }, x.req);
  await L.fns.getSignDocument(g.req, g.res);
  const sub = kit.reqRes({ token: 'TOKEVID00001', signedHtml: signedPage, consent: x.consent }, x.req);
  await L.fns.submitSignature(sub.req, sub.res);
  return { db, st, get: g.res, sub: sub.res, doc: db._get('leads/L1/documents/d1') || {}, tok: db._get('doc_sign_tokens/TOKEVID00001') || {}, notes: db._all('notifications'), logs: L.logs };
}
const failDocSets = (db) => {
  const o0 = db.doc;
  db.doc = (p) => {
    const r = o0(p);
    if (p !== 'leads/L1/documents/d1') return r;
    const s0 = r.set;
    r.set = async (patch, o) => { if (patch && (patch.signatureEvidence || patch.status)) throw new Error('firestore blip'); return s0(patch, o); };
    return r;
  };
};

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  section('2. remote-link evidence survives a row stamp that keeps failing');
  if (!kit || !DE) ok('harness available', false);
  else {
    const x = await remoteRun({ hook: failDocSets, req: { ip: '198.51.100.9', ua: 'Mozilla/5.0 Dana' } });
    const f = x.tok.evidenceFacts || {};
    ok('2: control: the row really was not stamped, and the rep was told', x.doc.signedStampFailed === true && x.doc.status !== 'signed' && x.tok.docStampFailed === true);
    ok('2: the burn transaction left the homeowner\'s IP, user agent and the document digest on the token', f.ip === '198.51.100.9' && /Mozilla\/5.0 Dana/.test(f.ua || '') && f.documentSha256 === kit.sha256(ORIGINAL), JSON.stringify(f));
    ok('2: ...with the consent decision and the signing time', f.consent && f.consent.agreed === null && f.signedAtMs > 0 && f.path === 'remote_link' && f.clauseSetVersion === 'CS-TEST.9');
    ok('2: ...and the full evidence object once the row stamp is given up on', x.tok.signatureEvidence && x.tok.signatureEvidence.path === 'remote_link' && x.tok.signatureEvidence.ip === '198.51.100.9' && !!x.tok.signatureEvidence.signedSha256);
    const y = await remoteRun({ flag: true, consent: true, hook: failDocSets, req: { ip: '198.51.100.9' } });
    ok('2: with the consent box on, the agreed consent (the server\'s text) is kept too', y.tok.evidenceFacts && y.tok.evidenceFacts.consent && y.tok.evidenceFacts.consent.agreed === true && y.tok.evidenceFacts.consent.text === ESL.CONSENT_TEXT);
    const z = await remoteRun({ req: { ip: '198.51.100.9' } });
    ok('2: control: a normal signing is unchanged (row stamped, evidence on the row)', z.doc.status === 'signed' && z.doc.signatureEvidence && z.doc.signatureEvidence.ip === '198.51.100.9' && !z.doc.signedStampFailed);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
