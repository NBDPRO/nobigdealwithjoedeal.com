/**
 * sign-link-panel-2026-11-18.test.js - signing-ease lane (Jo's Q48, Q59, Q60), flag docSignPanelV1 (default OFF, per person):
 *   A. server: createSignRequest mints a link WITHOUT an email (sendEmail:false), flag on only; every gate still runs;
 *      14-day expiry only with the flag; a new link retires the old one; flag off is unchanged
 *   B. the registry / flag plumbing (FIRESTORE_FLAGS row, strict gate read, same flag name on server and client)
 *   C. the panel module (docs/pro/js/sign-link-panel.js) in a small fake DOM: QR, Text link, Copy link, Email it, Make a new link
 *   D. the viewer wiring: flag on shows the panel and never calls window.prompt; flag off keeps the old prompt; lazy load, versions
 * Run: node tests/sign-link-panel-2026-11-18.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));
const kit = require('./lib/doc-evidence-kit');
const DE = require(path.join(FN, 'doc-evidence.js'));
const K = require(path.join(FN, 'ky-insurance-law.js'));
const ESL = require(path.join(FN, 'esign-logic.js'));
const AG = require(path.join(FN, 'attic-gate.js'));
const AA = require(path.join(FN, 'attic-ack.js'));
const NBDQr = require(path.join(ROOT, 'docs/pro/js/qr-code.js'));
const rx = (re, text) => re.exec(text) !== null; // a plain wording probe for the few checks that have no behaviour to run
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const FLAG = 'docSignPanelV1';
const P = 'documents/U1/L1/d-1.html';
const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
  + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '</section><!--nbd-cancel-packet:end-->'
  + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
// NO email on the lead's record: the case Q48 is about.
const lead = (extra) => Object.assign({ userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' }, extra || {});
const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
const RL = []; // the rate limits a mint drew: [name, max]
const stubs = () => ({ './shared': { callableRateLimit: async (_r, name, max) => { RL.push([name, max]); }, assertNotViewer: () => {} }, './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
  './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
const world = (flags, o) => {
  const x = o || {};
  const s = {
    'leads/L1': lead(x.lead), 'companyProfile/U1': PROFILE,
    'estimates/E1': x.est || { grandTotal: 14500, rows: [{ code: 'GTR 5K' }] },
    'leads/L1/documents/d1': { type: x.type || 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'U1' },
  };
  if (flags) s['feature_flags/_default'] = flags;
  return kit.makeDb(s);
};
const mint = async (db, data, mod) => {
  if (mod) mod(db);
  RL.length = 0;
  const L = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: CONTRACT }), stubs(), REAL);
  const t0 = Date.now();
  try { return { v: await L.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: Object.assign({ leadId: 'L1', docId: 'd1', signerName: 'Dana Whitfield' }, data || {}) }), db, t0 }; }
  catch (e) { return { e, db, t0 }; }
};
const tokens = (db) => db._all('doc_sign_tokens');
const DAY = 86400000;

(async () => {
  // ═══════════════════════════════════════════════════════
  section('A. createSignRequest: a link without an email (flag docSignPanelV1)');
  {
    let r = await mint(world({ [FLAG]: true }), { sendEmail: false });
    ok('flag on, sendEmail:false, no email anywhere: a link is minted', !!r.v && !!r.v.signLink && r.v.signLink.indexOf(r.v.token) !== -1, r.e && r.e.message);
    ok('nothing was emailed, and the token is stored with no signer email', !!r.v && r.v.emailed === false && tokens(r.db).length === 1 && (tokens(r.db)[0] || {}).signerEmail === '');
    ok('the token is pending and single-use as always (status pending, no burn fields)', (tokens(r.db)[0] || {}).status === 'pending');
    ok('4: a link-only mint does NOT mark the document "sent" (nothing was delivered); it records linkMintedAt', (r.db._get('leads/L1/documents/d1') || {}).status !== 'sent' && !!(r.db._get('leads/L1/documents/d1') || {}).linkMintedAt);
    {
      const e1 = await mint(world({ [FLAG]: true }, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
      ok('4: an emailed mint still marks the document "sent"', (e1.db._get('leads/L1/documents/d1') || {}).status === 'sent' && !(e1.db._get('leads/L1/documents/d1') || {}).linkMintedAt);
      ok('4: the email path draws the email daily counter at its old cap and not the link-only one', RL.length === 2 && RL.some((x) => x[0] === 'signLinkEmailDaily' && x[1] === ESL.SIGN_EMAIL_DAILY_CAP) && !RL.some((x) => x[0] === 'signLinkOnlyDaily'), JSON.stringify(RL));
      await mint(world({ [FLAG]: true }), { sendEmail: false });
      ok('4: a link-only mint draws its OWN generous counter (signLinkOnlyDaily, 200) and never the email counter', RL.some((x) => x[0] === 'signLinkOnlyDaily' && x[1] === 200 && x[1] === ESL.SIGN_LINK_ONLY_DAILY_CAP) && !RL.some((x) => x[0] === 'signLinkEmailDaily') && ESL.SIGN_LINK_ONLY_DAILY_CAP > ESL.SIGN_EMAIL_DAILY_CAP, JSON.stringify(RL));
      const e2 = await mint(world(null, { lead: { email: 'dana@example.test' } }), { sendEmail: false, signerEmail: 'dana@example.test' });
      ok('4: FLAG OFF, sendEmail:false with a real address on the record: it EMAILS and draws the email counter (the param cannot dodge the email cap)', !!e2.v && e2.v.emailed === true && RL.some((x) => x[0] === 'signLinkEmailDaily') && !RL.some((x) => x[0] === 'signLinkOnlyDaily'), JSON.stringify(RL));
    }
    r = await mint(world({ [FLAG]: true }), { sendEmail: false, signerEmail: 'not-an-email' });
    ok('flag on, sendEmail:false: a junk address typed alongside is ignored, never emailed', !!r.v && r.v.emailed === false && (tokens(r.db)[0] || {}).signerEmail === '', r.e && r.e.message);
    r = await mint(world({ [FLAG]: true }), {});
    ok('flag on, but sendEmail NOT false and no email: the old refusal stands', !!r.e && r.e.code === 'invalid-argument' && /valid signer email/.test(r.e.message) && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: true }), { sendEmail: true });
    ok('flag on, sendEmail:true and no email: refused too', !!r.e && r.e.code === 'invalid-argument');
    r = await mint(world({ [FLAG]: true }), { signerEmail: 'stranger@example.test' });
    ok('flag on, an email send to an address NOT on the record is still refused', !!r.e && r.e.code === 'failed-precondition' && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: true }, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('flag on, the email path (address on the record) still emails and mints', !!r.v && r.v.emailed === true && (tokens(r.db)[0] || {}).signerEmail === 'dana@example.test', r.e && r.e.message);

    // flag OFF: byte-identical
    r = await mint(world(null), { sendEmail: false });
    ok('FLAG OFF: sendEmail:false with no email is the existing refusal, nothing minted', !!r.e && r.e.code === 'invalid-argument' && r.e.message === 'A valid signer email is required' && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: false }), { sendEmail: false });
    ok('flag explicitly false: same refusal', !!r.e && r.e.code === 'invalid-argument');
    r = await mint(world(null), { sendEmail: false, signerEmail: 'stranger@example.test' });
    ok('FLAG OFF: an address not on the record is still refused (sendEmail:false never relaxes it)', !!r.e && r.e.code === 'failed-precondition' && r.e.message === ESL.SIGN_EMAIL_NOT_ON_RECORD && tokens(r.db).length === 0);
    r = await mint(world(null), { signerEmail: 'dana@example.test' }, null);
    ok('FLAG OFF, no email on the record: refused as before', !!r.e && r.e.code === 'failed-precondition');
    r = await mint(world(null, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('FLAG OFF: the email path emails and mints exactly as before, 7-day link', !!r.v && r.v.emailed === true && Math.abs(r.v.expiresAt - (r.t0 + 7 * DAY)) < 60000, r.e && r.e.message);

    // expiry
    r = await mint(world({ [FLAG]: true }), { sendEmail: false });
    ok('flag on: the link lasts 14 days', !!r.v && Math.abs(r.v.expiresAt - (r.t0 + 14 * DAY)) < 60000 && Math.abs((tokens(r.db)[0] || {}).expiresAt.toMillis() - (r.t0 + 14 * DAY)) < 60000);
    r = await mint(world({ [FLAG]: true }, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('flag on, emailed: also 14 days', !!r.v && Math.abs(r.v.expiresAt - (r.t0 + 14 * DAY)) < 60000);
    r = await mint(world({ docClauseSetV1: true, docEvidenceFoundation: true, docAtticAckV1: true }), { signerEmail: 'x@y.test' });
    ok('other flags on, this one off: still 7 days (the expiry follows this flag only)', !(r.v && r.v.expiresAt > r.t0 + 8 * DAY));
  }

  // ─── every gate still runs
  {
    let r = await mint(world({ [FLAG]: true, docEvidenceFoundation: true }, { lead: { address: '' } }), { sendEmail: false });
    ok('gate: an incomplete contract (no property address) is refused even with sendEmail:false', !!r.e && r.e.code === 'failed-precondition' && tokens(r.db).length === 0, r.e && r.e.message);
    r = await mint(world({ [FLAG]: true, docClauseSetV1: true }, { lead: { address: '' } }), { sendEmail: false });
    ok('gate: the clause-set (docClauseSetV1) check runs on a link-only mint', !!r.e && tokens(r.db).length === 0, r.e && r.e.message);
    r = await mint(world({ [FLAG]: true, docAtticAckV1: true }, { est: { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] } }), { sendEmail: false });
    ok('gate: the attic gate refuses a re-roof contract with no attic form, link-only or not', !!r.e && r.e.code === 'failed-precondition' && /Attic, Ventilation & Moisture Acknowledgment/.test(r.e.message) && tokens(r.db).length === 0, r.e && r.e.message);
    r = await mint(world({ [FLAG]: true }), { sendEmail: false }, (db) => { const o = db.doc; db.doc = (p) => (/^feature_flags\//.test(p) ? { get: async () => { throw new Error('down'); } } : o(p)); });
    ok('gate: an unreadable flag is a retryable refusal, never "off" and never a link', !!r.e && r.e.code === 'unavailable' && tokens(r.db).length === 0, r.e && r.e.code);
    r = await mint(world({ [FLAG]: true }), { sendEmail: false }, (db) => { const o = db.doc; db.doc = (p) => (/^feature_flags\/U1$/.test(p) ? { get: async () => { throw new Error('down'); } } : o(p)); });
    ok('gate: an unreadable per-person flag doc fails closed too', !!r.e && r.e.code === 'unavailable' && tokens(r.db).length === 0);
    // Security review 2026-11-18, item 1: only the link-only request reads the flag strictly; every other caller reads it loosely (a failed read = off).
    const failFirstDefault = (db) => { const o = db.doc; let n = 0; db.doc = (p) => (p === 'feature_flags/_default' && ++n === 1 ? { get: async () => { throw new Error('blip'); } } : o(p)); };
    r = await mint(world(null, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' }, failFirstDefault);
    ok('FLAG OFF, normal email mint, the sign-panel flag read fails once: proceeds exactly as on main (emailed, 7 days), no new refusal', !!r.v && r.v.emailed === true && Math.abs(r.v.expiresAt - (r.t0 + 7 * DAY)) < 60000 && r.v.supersededOld === undefined, r.e && r.e.code);
    r = await mint(world({ [FLAG]: true }), { sendEmail: false }, failFirstDefault);
    ok('link-only request with the same failed flag read: retryable unavailable, nothing minted (strict stays for sendEmail:false)', !!r.e && r.e.code === 'unavailable' && tokens(r.db).length === 0, r.e && r.e.code);
    r = await mint(world({ [FLAG]: true }, { lead: { userId: 'OTHER' } }), { sendEmail: false });
    ok('owner check: a lead that is not yours still refuses a link-only mint', !!r.e && r.e.code === 'permission-denied' && tokens(r.db).length === 0);
    const rs = src('functions/remote-signing.js');
    const at = (s) => rs.indexOf(s);
    ok('the rate limits (per-minute and daily) run before the flag branch and are unchanged', at("callableRateLimit(request, 'createSignRequest', 20, 60_000)") !== -1 && at("callableRateLimit(request, 'signLinkEmailDaily'") !== -1
      && at("callableRateLimit(request, 'signLinkEmailDaily'") < at('const emailShapeOk'));
    ok('the email block is skipped by a flag, not removed (the email path is the old code)', rx(/if \(!noEmailMint\)/, rs) && rx(/Resend\(RESEND_API_KEY\.value\(\)\)/, rs));
    ok('the email copy states the real expiry (7 stays 7)', rx(/expires in \$\{ttlDays\} days/, rs) && !rx(/expires in 7 days/, rs));
  }

  // ─── security review 2026-11-18, item 3: a bearer link records HOW it was delivered
  {
    let r = await mint(world({ [FLAG]: true }), { sendEmail: false });
    ok('3: a link-only mint stamps deliveryChannel link_only and who minted it on the token', !!r.v && (tokens(r.db)[0] || {}).deliveryChannel === 'link_only' && (tokens(r.db)[0] || {}).mintedBy === 'U1', r.e && r.e.message);
    r = await mint(world({ [FLAG]: true }, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('3: an emailed mint (flag on) stamps deliveryChannel email', !!r.v && (tokens(r.db)[0] || {}).deliveryChannel === 'email');
    r = await mint(world(null, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('3: FLAG OFF: the token has no deliveryChannel field at all (stored token unchanged)', !!r.v && !('deliveryChannel' in (tokens(r.db)[0] || {})));
    // the evidence the signing writes: the real getSignDocument + submitSignature on a token that carries the stamp
    const ORIG = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Roofing Agreement</title></head><body><h1>Roofing Agreement</h1><p>Prepared for <strong>Dana Whitfield</strong>.</p>'
      + '<div class="nbd-sig-block" data-nbd-sig="homeowner" data-label="Homeowner" data-required="true"><div class="nbd-sig-label">Homeowner</div><canvas class="nbd-sig-canvas"></canvas><div class="nbd-sig-controls"><button type="button" data-nbd-sig-action="clear">Clear</button><span class="nbd-sig-state"></span></div><div class="nbd-sig-print-name">Print Name &amp; Date</div></div><script src="/pro/js/signature-widget.js"></script></body></html>';
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const SIGNED = ORIG.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/, '<img src="' + PNG + '" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">')
      .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
      .replace('data-nbd-sig="homeowner"', 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
    const sign = async (tokExtra) => {
      const db = kit.makeDb({
        'leads/L1': { userId: 'U1', companyId: 'C1', firstName: 'Dana', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' },
        'leads/L1/documents/d1': { name: 'Roofing Agreement', status: 'sent', type: 'contract', htmlPath: P },
        'doc_sign_tokens/TOKSLP000001': Object.assign({ status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', mintedBy: 'U1', htmlPath: P, signerName: 'Dana Whitfield' }, tokExtra || {}),
      });
      const L = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: ORIG }), stubs(), REAL);
      const g = kit.reqRes({ token: 'TOKSLP000001' }); await L.fns.getSignDocument(g.req, g.res);
      const s = kit.reqRes({ token: 'TOKSLP000001', signedHtml: SIGNED }); await L.fns.submitSignature(s.req, s.res);
      return { doc: db._get('leads/L1/documents/d1') || {}, tok: db._get('doc_sign_tokens/TOKSLP000001') || {}, res: s.res };
    };
    let x = await sign({ deliveryChannel: 'link_only' });
    ok('3: signing a link-only link: the server-written signatureEvidence carries deliveryChannel link_only and who minted it', x.doc.status === 'signed' && !!x.doc.signatureEvidence && x.doc.signatureEvidence.deliveryChannel === 'link_only' && x.doc.signatureEvidence.mintedBy === 'U1', JSON.stringify(x.doc.signatureEvidence) + ' ' + x.res.statusCode);
    ok('3: ...and the token keeps it in evidenceFacts too', (x.tok.evidenceFacts || {}).deliveryChannel === 'link_only');
    x = await sign({ deliveryChannel: 'email' });
    ok('3: signing an emailed link records deliveryChannel email', !!x.doc.signatureEvidence && x.doc.signatureEvidence.deliveryChannel === 'email');
    x = await sign({});
    ok('3: FLAG OFF / a link minted before this field: evidence has NO deliveryChannel or mintedBy key (the phase 1/2 shape is untouched)', !!x.doc.signatureEvidence && !('deliveryChannel' in x.doc.signatureEvidence) && !('mintedBy' in x.doc.signatureEvidence) && !('deliveryChannel' in (x.tok.evidenceFacts || {})));
    x = await sign({ deliveryChannel: '<script>' });
    ok('3: an unknown channel value is never copied into the evidence', !!x.doc.signatureEvidence && !('deliveryChannel' in x.doc.signatureEvidence));
  }

  // ─── a new link retires the old one
  {
    let db = world({ [FLAG]: true });
    let a = await mint(db, { sendEmail: false });
    let b = await mint(db, { sendEmail: false });
    const ts = tokens(db);
    const old = ts.find((t) => t.status === 'superseded');
    ok('contract, flag on: the second link retires the first, one pending token is left', !!a.v && !!b.v && ts.length === 2 && ts.filter((t) => t.status === 'pending').length === 1 && !!old && old.supersededBy === b.v.token, JSON.stringify(ts.map((t) => t.status)));
    db = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
    a = await mint(db, { sendEmail: false });
    b = await mint(db, { sendEmail: false });
    const ts2 = tokens(db);
    ok('any document type, flag on: making a new link retires the old link of the SAME document', ts2.length === 2 && ts2.filter((t) => t.status === 'pending').length === 1 && ts2.some((t) => t.status === 'superseded'), JSON.stringify(ts2.map((t) => t.status)));
    ok('the answer says the old link was retired (the panel tells the rep so)', !!b.v && b.v.supersededOld === true);
    // review: a tampered or missing row counter can never keep an old link alive (max of the live links' linkSeq and the row, plus 1)
    for (const bad of [0, 'x', NaN, -3, 1e308, 2.5, null, undefined]) {
      const tdb = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
      await tdb.doc('doc_sign_tokens/OLDLIVE').set({ leadId: 'L1', docId: 'd1', ownerUid: 'U1', status: 'pending', linkSeq: 5 });
      await tdb.doc('leads/L1/documents/d1').set({ linkSeq: bad }, { merge: true });
      const tr = await mint(tdb, { sendEmail: false });
      const nt = tokens(tdb).find((t) => t._id === (tr.v || {}).token) || {};
      ok('5: row linkSeq tampered to ' + String(bad) + ': the new link still outranks the live one (seq ' + nt.linkSeq + ') and retires it', !!tr.v && Number.isInteger(nt.linkSeq) && nt.linkSeq > 5 && (tdb._get('doc_sign_tokens/OLDLIVE') || {}).status === 'superseded' && tr.v.supersededOld === true, JSON.stringify(nt.linkSeq));
    }
    // security review 2026-11-18, item 5: the clock is frozen, so the order can only come from the sequence number
    {
      const realNow = Date.now; Date.now = () => 1800000000000;
      try {
        const fdb = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
        let prev = null, allOk = true;
        for (let k = 0; k < 6; k++) {
          const m1 = await mint(fdb, { sendEmail: false });
          const livek = tokens(fdb).filter((t) => t.status === 'pending');
          if (!m1.v || livek.length !== 1 || livek[0]._id !== m1.v.token || (k > 0 && m1.v.supersededOld !== true)) allOk = false;
          prev = m1;
        }
        ok('5: with the clock frozen, each new link retires the previous one every time (the sequence number, not ms or token id, decides)', allOk && !!prev && tokens(fdb).length === 6);
      } finally { Date.now = realNow; }
    }
    db = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
    const [c1, c2] = await Promise.all([mint(db, { sendEmail: false }), mint(db, { sendEmail: false })]);
    const cts = tokens(db), live = cts.filter((t) => t.status === 'pending');
        ok('5: two concurrent mints leave exactly ONE live link, and it is a link that was returned to a caller', !!c1.v && !!c2.v && cts.length === 2 && live.length === 1 && [c1.v.token, c2.v.token].some((t) => !!t) && cts.filter((t) => t.status === 'superseded').length === 1, JSON.stringify(cts.map((t) => t.status)));
    ok('5: the survivor is the NEWEST mint (the retired one is older, never the other way round)', live.length === 1 && cts.every((t) => typeof t.linkSeq === 'number') && cts.filter((t) => t.status === 'superseded').every((t) => (t.linkSeq < live[0].linkSeq) || (t.linkSeq === live[0].linkSeq && live[0].supersededBy === undefined)), JSON.stringify(cts.map((t) => [t.status, t.linkSeq])));
    db = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
    await db.doc('doc_sign_tokens/NEWERTOK').set({ leadId: 'L1', docId: 'd1', ownerUid: 'U1', status: 'pending', linkSeq: 1000000 });
    a = await mint(db, { sendEmail: false });
    {
      const cdb = world({ [FLAG]: true });
      const [k1, k2] = await Promise.all([mint(cdb, { sendEmail: false }), mint(cdb, { sendEmail: false })]);
      const cs = tokens(cdb);
      ok('5: two concurrent CONTRACT mints (flag on) also leave exactly one live link', !!k1.v && !!k2.v && cs.length === 2 && cs.filter((t) => t.status === 'pending').length === 1, JSON.stringify(cs.map((t) => t.status)));
    }
    ok('5: a link already live when this mint began is ALWAYS retired, whatever its number (a new link outranks every earlier one)', !!a.v && (db._get('doc_sign_tokens/NEWERTOK') || {}).status === 'superseded' && a.v.supersededOld === true);
    await db.doc('doc_sign_tokens/OLDERTOK').set({ leadId: 'L1', docId: 'd1', ownerUid: 'U1', status: 'pending', linkSeq: 0 });
    b = await mint(db, { sendEmail: false });
    ok('5: ...while an older pending link of the same document is still retired', !!b.v && (db._get('doc_sign_tokens/OLDERTOK') || {}).status === 'superseded' && b.v.supersededOld === true);
    db = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
    const oc = db.collection;
    db.collection = (n) => { if (n === 'doc_sign_tokens') return { where: () => ({ where: () => ({ get: async () => { throw new Error('index missing'); } }) }) }; return oc(n); };
    a = await mint(db, { sendEmail: false });
    ok('5: the retire query fails: the link is still minted, but the answer says supersededOld null + supersedeError (never "false")', !!a.v && !!a.v.signLink && a.v.supersededOld === null && a.v.supersedeError === true, JSON.stringify(a.v) + (a.e && a.e.message));
    db = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
    a = await mint(db, { sendEmail: false });
    ok('5: a clean retire carries no supersedeError field', !!a.v && a.v.supersededOld === false && !('supersedeError' in a.v));
    db = world(null, { type: 'attic_acknowledgment', lead: { email: 'dana@example.test' } });
    a = await mint(db, { signerEmail: 'dana@example.test' });
    b = await mint(db, { signerEmail: 'dana@example.test' });
    ok('FLAG OFF, a non-contract: two links stay pending, exactly as before (no retire, no new field)', tokens(db).filter((t) => t.status === 'pending').length === 2 && b.v && b.v.supersededOld === undefined);
  }

  // ═══════════════════════════════════════════════════════
  section('B. flag plumbing');
  {
    const REG = require(path.join(FN, 'flags-registry.js'));
    const row = REG.FIRESTORE_FLAGS.find((f) => f.name === FLAG);
    ok('registered in FIRESTORE_FLAGS: default off, dark, read by doc-evidence.js, doc exists', !!row && row.default === false && row.dark === true && row.file === 'doc-evidence.js' && fs.existsSync(path.join(ROOT, row.doc)), row && row.doc);
    ok('doc-evidence.js exports the strict gate read for it', typeof DE.signPanelFlagForGate === 'function' && rx(/docSignPanelV1/, src('functions/doc-evidence.js')));
    ok('a read that fails is an "unavailable" refusal, a clean read is true/false', await (async () => {
      const mkE = (m) => Object.assign(new Error(m), { code: m });
      const H = function (c, m) { return mkE(c + ':' + m); };
      const dbOn = world({ [FLAG]: true }); const dbOff = world({});
      let bad = null;
      try { await DE.signPanelFlagForGate({ doc: () => ({ get: async () => { throw new Error('x'); } }) }, 'U1', H); } catch (e) { bad = e; }
      return (await DE.signPanelFlagForGate(dbOn, 'U1', H)) === true && (await DE.signPanelFlagForGate(dbOff, 'U1', H)) === false && !!bad && /unavailable/.test(bad.message);
    })());
    ok('the client reads the same flag name the same way the other doc flags are read (NBDFlags.enabled)', rx(/NBDFlags\.enabled\('docSignPanelV1'\)/, src('docs/pro/js/nbd-doc-viewer.js')));
  }

  // ═══════════════════════════════════════════════════════
  section('C. the panel module in a fake DOM');
  const PANEL_SRC = fs.existsSync(path.join(ROOT, 'docs/pro/js/sign-link-panel.js')) ? src('docs/pro/js/sign-link-panel.js') : '';
  ok('docs/pro/js/sign-link-panel.js exists', PANEL_SRC.length > 0);
  function mkEl(tag) {
    const e = { tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, _l: {}, parentNode: null, style: {}, dataset: {}, className: '', _text: '', innerHTML: '', value: '', hidden: false, disabled: false };
    Object.defineProperty(e, 'textContent', { get() { return e._text + e.children.map((c) => c.textContent).join(''); }, set(v) { e._text = String(v); e.children = []; } });
    e.classList = { add(c) { e.className = (e.className + ' ' + c).trim(); }, remove(c) { e.className = e.className.split(/\s+/).filter((x) => x && x !== c).join(' '); }, contains(c) { return e.className.split(/\s+/).indexOf(c) !== -1; }, toggle(c, on) { if (on === undefined ? !e.classList.contains(c) : on) e.classList.add(c); else e.classList.remove(c); } };
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); if (k === 'class') e.className = String(v); if (k === 'hidden') e.hidden = true; };
    e.getAttribute = (k) => (k in e.attrs ? e.attrs[k] : null);
    e.removeAttribute = (k) => { delete e.attrs[k]; if (k === 'hidden') e.hidden = false; };
    e.hasAttribute = (k) => k in e.attrs;
    e.appendChild = (c) => { c.parentNode = e; e.children.push(c); return c; };
    e.remove = () => { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((x) => x !== e); e.parentNode = null; };
    e.addEventListener = (t, f) => { (e._l[t] = e._l[t] || []).push(f); };
    e.removeEventListener = () => {};
    e.closest = (sel) => { const m = /^\[([a-z-]+)\]$/.exec(sel); let n = e; while (n) { if (m && n.attrs[m[1]] !== undefined) return n; n = n.parentNode; } return null; };
    e.focus = () => { e._focused = true; }; e.select = () => {}; e.setSelectionRange = () => {};
    return e;
  }
  const walk = (e, fn) => { fn(e); e.children.forEach((c) => walk(c, fn)); };
  const byAction = (root, a) => { let f = null; walk(root, (n) => { if (!f && n.attrs['data-sl-action'] === a) f = n; }); return f; };
  function env(o) {
    const x = o || {};
    const head = mkEl('head'), body = mkEl('body');
    const win = { document: { head, body, createElement: mkEl, getElementById: () => null, execCommand: (c) => { win._exec.push(c); return true; } }, NBDQr, _exec: [], _toasts: [], _opened: [] };
    win.window = win;
    win._navs = []; win._checks = []; win._logged = [];
    { let h = 'https://crm.test/pro/customer.html'; win.location = { get href() { return h; }, set href(v) { h = v; win._navs.push(v); } }; }
    win.showToast = (m, k) => win._toasts.push({ m, k });
    win.prompt = () => { win._prompted = true; return null; };
    win.navigator = { clipboard: x.noClipboard ? undefined : { writeText: async (t) => { win._copied = t; } } };
    win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
    if (x.checkText !== null) win.NBDPhoneShare = { checkText: async (a) => { win._checks.push(a); return x.checkText ? x.checkText(a) : { ok: true }; }, logSent: (a, b) => { win._logged.push([a, b]); }, digits: (p) => String(p || '').replace(/\D/g, '') };
    const ctx = vm.createContext(Object.assign({ console }, win, { window: win }));
    // run the module with window === the same object it reads
    vm.runInContext(PANEL_SRC, Object.assign(ctx, { window: win }));
    return win;
  }
  const fire = (root, type, target, extra) => { const ev = Object.assign({ type, target, prevented: false, preventDefault() { ev.prevented = true; }, stopPropagation() {} }, extra || {}); (root._l[type] || []).forEach((f) => f(ev)); return ev; };
  const mkMint = () => { const calls = []; const f = async (o) => { calls.push(o); const n = calls.length; if (f.fail) throw new Error(f.fail); return { signLink: 'https://app.test/sign.html?t=TOKEN' + n, expiresAt: Date.now() + 14 * DAY, emailed: !!(o && o.email), supersededOld: n > 1 }; }; f.calls = calls; return f; };

  if (PANEL_SRC) {
    const win = env();
    const Panel = win.NBDSignLinkPanel;
    ok('the module registers window.NBDSignLinkPanel.open', !!Panel && typeof Panel.open === 'function');
    const m = mkMint();
    const host = mkEl('div');
    const p = Panel.open({ host, mint: m, phone: '(859) 555-0142', leadId: 'L1', firstName: 'Dana', docLabel: 'Roofing Contract', brand: 'Acme Roofing', emailDefault: '' });
    await p.ready;
    const el = p.el;
    ok('it mints a link-only link on open: mint({sendEmail:false}) once, no email', m.calls.length === 1 && m.calls[0].sendEmail === false && !m.calls[0].email);
    ok('the panel is attached to the host and is a labelled dialog', host.children.indexOf(el) !== -1 && el.attrs.role === 'dialog' && /sign/i.test(el.attrs['aria-label'] || ''));
    const qrHtml = () => { let h = ''; walk(el, (n) => { if (/<svg/.test(n.innerHTML)) h += n.innerHTML; }); return h; };
    ok('the QR is the real NBDQr.svg of exactly the link (nothing else, no name, no address)', qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN1', { label: 'QR code for the signing link' }) || qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN1'), qrHtml().slice(0, 80));
    ok('the QR carries no homeowner PII', !/Dana|Whitfield|Oak|859|555|@/.test(qrHtml()));
    const text = el.textContent;
    ok('labels: Text link, Copy link, Email it, Make a new link', ['Text link', 'Copy link', 'Email it', 'Make a new link'].every((l) => text.indexOf(l) !== -1), text);
    ok('the bearer-token note is shown verbatim', text.indexOf('Anyone with this link can sign: only show it to the homeowner.') !== -1);
    ok('every action is a real button or link with an accessible name, no inline handler or style attribute', (() => {
      let good = true;
      walk(el, (n) => {
        if (n.attrs['data-sl-action'] !== undefined) { if (!(n.textContent || n.attrs['aria-label'])) good = false; if (n.tagName !== 'BUTTON' && n.tagName !== 'A') good = false; if (n.tagName === 'BUTTON' && n.attrs.type !== 'button') good = false; }
        Object.keys(n.attrs).forEach((k) => { if (/^on/i.test(k) || k === 'style') good = false; });
      });
      return good;
    })());
    ok('Text link is a plain button with NO href, so no path (long-press, middle-click, Open) can reach Messages without the check', (() => {
      const a = byAction(el, 'text');
      let anyHref = false; walk(el, (n) => { if (n.attrs.href !== undefined) anyHref = true; });
      return !!a && a.tagName === 'BUTTON' && a.attrs.type === 'button' && a.attrs.href === undefined && !anyHref && win._navs.length === 0;
    })());
    ok('the panel itself has no window.prompt in its source', !rx(/\bprompt\s*\(/, PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

    // text: allowed
    let ev = fire(el, 'click', byAction(el, 'text'));
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('Text link: asked of checkText with this lead and the sign_link source, then Messages opens ONCE with the link written in', win._checks.length >= 1 && win._checks[win._checks.length - 1].leadId === 'L1' && win._checks[win._checks.length - 1].source === 'sign_link'
      && win._navs.length === 1 && /^sms:8595550142\?&body=/.test(win._navs[0]) && decodeURIComponent(win._navs[0]).indexOf('https://app.test/sign.html?t=TOKEN1') !== -1);
    ok('Text link: the send is logged to the Comm Log once, as sign_link, WITHOUT the bearer link in the stored body', win._logged.length === 1 && win._logged[0][0].leadId === 'L1' && win._logged[0][0].source === 'sign_link' && win._logged[0][1].indexOf('TOKEN') === -1 && /Roofing Contract/.test(win._logged[0][1]));

    // text: blocked fails closed
    const w2 = env({ checkText: async () => ({ ok: false, reason: 'This customer replied STOP.' }) });
    const m2 = mkMint(); const p2 = w2.NBDSignLinkPanel.open({ host: mkEl('div'), mint: m2, phone: '8595550142', leadId: 'L1', firstName: 'Dana' }); await p2.ready;
    fire(p2.el, 'click', byAction(p2.el, 'text')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('texting blocked: nothing opens, nothing is logged, the panel says why and "Use Email or Copy link instead."', w2.location.href === 'https://crm.test/pro/customer.html' && w2._navs.length === 0 && w2._logged.length === 0 && /STOP/.test(p2.el.textContent) && p2.el.textContent.indexOf('Use Email or Copy link instead.') !== -1);
    const w3 = env({ checkText: null });
    const p3 = w3.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '8595550142', leadId: 'L1' }); await p3.ready;
    fire(p3.el, 'click', byAction(p3.el, 'text')); await new Promise((r) => setTimeout(r, 0));
    ok('no NBDPhoneShare at all (the check cannot run): fails closed with the same line', w3.location.href === 'https://crm.test/pro/customer.html' && p3.el.textContent.indexOf('Use Email or Copy link instead.') !== -1);
    const w4 = env({ checkText: async () => { throw new Error('boom'); } });
    const p4 = w4.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '8595550142', leadId: 'L1' }); await p4.ready;
    fire(p4.el, 'click', byAction(p4.el, 'text')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('a check that throws fails closed', w4.location.href === 'https://crm.test/pro/customer.html' && p4.el.textContent.indexOf('Use Email or Copy link instead.') !== -1);
    const w5 = env();
    const p5 = w5.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '', leadId: 'L1' }); await p5.ready;
    fire(p5.el, 'click', byAction(p5.el, 'text')); await new Promise((r) => setTimeout(r, 0));
    ok('no phone number on file: nothing opens, says so and points at Email / Copy link', w5.location.href === 'https://crm.test/pro/customer.html' && p5.el.textContent.indexOf('Use Email or Copy link instead.') !== -1 && /phone/i.test(p5.el.textContent));

    // copy
    fire(el, 'click', byAction(el, 'copy')); await new Promise((r) => setTimeout(r, 0));
    ok('Copy link puts exactly the link on the clipboard', win._copied === 'https://app.test/sign.html?t=TOKEN1');
    const w6 = env({ noClipboard: true });
    const p6 = w6.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '', leadId: 'L1' }); await p6.ready;
    fire(p6.el, 'click', byAction(p6.el, 'copy')); await new Promise((r) => setTimeout(r, 0));
    ok('no clipboard API: falls back to selecting the link box and execCommand("copy") - never window.prompt', w6._exec.indexOf('copy') !== -1 && !w6._prompted);

    // email inside the panel
    const mailRow = () => byAction(el, 'email-send');
    ok('Email it asks for the address INSIDE the panel (an input), not window.prompt', (() => { fire(el, 'click', byAction(el, 'email')); let input = null; walk(el, (n) => { if (n.tagName === 'INPUT' && n.attrs.type === 'email') input = n; }); return !!input && !win._prompted && !!(input.attrs['aria-label'] || input.attrs.id); })());
    let input = null; walk(el, (n) => { if (n.tagName === 'INPUT' && n.attrs.type === 'email') input = n; });
    input.value = 'not an email';
    fire(el, 'click', mailRow()); await new Promise((r) => setTimeout(r, 0));
    ok('a bad address is refused in the panel and nothing is sent', m.calls.length === 1 && /valid email/i.test(el.textContent));
    input.value = 'dana@example.test';
    fire(el, 'click', mailRow()); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('a good address calls mint with the email (the existing email path) and redraws the QR for the new link', m.calls.length === 2 && m.calls[1].email === 'dana@example.test' && qrHtml().indexOf('<svg') !== -1 && qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN2', { label: 'QR code for the signing link' }) || qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN2'));
    ok('it says the email went out', /Emailed/.test(el.textContent));

    // new link
    fire(el, 'click', byAction(el, 'new')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    {
      const mS = mkMint(); const orig = mS; const wr = env(); const pr = wr.NBDSignLinkPanel.open({ host: mkEl('div'), mint: async (o2) => { const v = await orig(o2); return Object.assign({}, v, { supersededOld: null, supersedeError: true }); }, phone: '', leadId: 'L1' }); await pr.ready;
      fire(pr.el, 'click', byAction(pr.el, 'new')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
      ok('5: when the server could not confirm the old link was retired, the panel does NOT say it no longer works', !/old link no longer works/i.test(pr.el.textContent) && /could not confirm/i.test(pr.el.textContent));
    }
    ok('Make a new link: one tap mints another link-only link, the QR is redrawn, the old link is said to be retired', m.calls.length === 3 && m.calls[2].sendEmail === false && qrHtml().indexOf('<svg') !== -1 && /old link no longer works/i.test(el.textContent));
    fire(el, 'click', byAction(el, 'copy')); await new Promise((r) => setTimeout(r, 0));
    ok('after a new link, Copy and Text use the NEW link', win._copied === 'https://app.test/sign.html?t=TOKEN3' && byAction(el, 'text').attrs.href === undefined);
    fire(el, 'click', byAction(el, 'text')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('and the Text tap after a new link texts the NEW link', win._navs.length === 2 && decodeURIComponent(win._navs[1]).indexOf('TOKEN3') !== -1);

    // a refusal from the server (gate) is shown, no QR is left for a dead link
    const m7 = mkMint(); m7.fail = 'This contract is missing the property address.';
    const p7 = Panel.open({ host: mkEl('div'), mint: m7, phone: '', leadId: 'L1' }); await p7.ready;
    ok('a server refusal (a gate) is shown in plain words and no QR is drawn', p7.el.textContent.indexOf('This contract is missing the property address.') !== -1 && !/<svg/.test((() => { let h = ''; walk(p7.el, (n) => { h += n.innerHTML; }); return h; })()));
    m7.fail = null; fire(p7.el, 'click', byAction(p7.el, 'new')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('and Make a new link retries from there', /<svg/.test((() => { let h = ''; walk(p7.el, (n) => { h += n.innerHTML; }); return h; })()));
    // close
    fire(el, 'click', byAction(el, 'close'));
    ok('Close removes the panel and drops the link from the screen', host.children.indexOf(el) === -1);
    ok('only one panel at a time: opening again replaces the first', (() => { const h = mkEl('div'); const a = Panel.open({ host: h, mint: mkMint(), phone: '' }); const b = Panel.open({ host: h, mint: mkMint(), phone: '' }); return h.children.length === 1 && h.children[0] === b.el && a.el !== b.el; })());
  }
  {
    const code = PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    ok('CSP: no inline handlers, no inline script text, no eval / document.write in the module', !rx(/\son[a-z]+\s*=/, code) && !rx(/eval\(|new Function|document\.write/, code));
    ok('DESIGN.md: 44px tap targets, theme tokens (var(--...)), no old oranges, no hard-coded transition: all', rx(/^(?=[\s\S]*min-height:\s*44px)(?=[\s\S]*var\(--)(?![\s\S]*(?:#E8720C|#F08030|transition:\s*all))/i, code));
    ok('the QR is built with the in-page NBDQr.svg only (no network image, no third-party QR service)', rx(/root\.NBDQr[\s\S]*\.svg\(link/, code) && !rx(/https?:\/\/(?!www\.w3\.org)/, code.replace(/'https:\/\/[^']*'/g, '')));
  }

  // ═══════════════════════════════════════════════════════
  section('D. the viewer wiring and the lazy load');
  {
    const v = src('docs/pro/js/nbd-doc-viewer.js');
    const fnOf = (name) => { const a = v.indexOf('async function ' + name + '()'); const b = v.indexOf('\n  }\n', a); return a === -1 || b === -1 ? '' : '(' + v.slice(a, b + 4).replace('async function ' + name + '()', 'async function ()') + ')'; };
    ok('found handleSendForSignature and openSignPanel in nbd-doc-viewer.js', !!fnOf('handleSendForSignature') && !!fnOf('openSignPanel'));
    const send = async (flags) => {
      const calls = { prompt: 0, panel: 0, mint: 0 };
      const sb = { window: { prompt() { calls.prompt++; return 'pat@example.test'; }, showToast() {}, NBDFlags: flags }, flashStatus() {}, openSignPanel: async () => { calls.panel++; },
        currentContext: { signerEmailDefault: '', onSendForSignature: async () => { calls.mint++; return { emailed: true, signLink: 'x' }; } } };
      await vm.runInNewContext(fnOf('handleSendForSignature'), sb)();
      return calls;
    };
    let c = await send({ enabled: (n) => n === 'docSignPanelV1' });
    ok('flag ON: Send for Signature opens the panel and never calls window.prompt or mints by itself', c.panel === 1 && c.prompt === 0 && c.mint === 0, JSON.stringify(c));
    c = await send({ enabled: () => false });
    ok('flag OFF: the old prompt and the old email send, no panel', c.panel === 0 && c.prompt === 1 && c.mint === 1, JSON.stringify(c));
    c = await send(undefined);
    ok('no flag registry on the page: the old prompt', c.panel === 0 && c.prompt === 1 && c.mint === 1, JSON.stringify(c));
    c = await send({ enabled: (n) => n === 'docClauseSetV1' });
    ok('another doc flag on, this one off: the old prompt', c.panel === 0 && c.prompt === 1);
    const openP = async (loadWorks) => {
      const log = { loaded: [], opened: null, status: [] };
      const ctx = { id: 'ctx' }, overlay = { id: 'ov' };
      const win = { ScriptLoader: { load: async (p) => { log.loaded.push(p); if (loadWorks) win.NBDSignLinkPanel = { openFor: async (cx, host) => { log.opened = [cx, host]; } }; } } };
      const sb = { window: win, currentContext: ctx, currentOverlay: overlay, flashStatus: (m) => log.status.push(m), prompt() { log.prompted = true; } };
      await vm.runInNewContext(fnOf('openSignPanel'), sb)();
      return Object.assign(log, { ctx, overlay });
    };
    let o = await openP(true);
    ok('the panel file is fetched on the first click (lazy, with a version) and opened for this document inside the viewer overlay', o.loaded.length === 1 && rx(/^js\/sign-link-panel\.js\?v=\d+$/, o.loaded[0]) && !!o.opened && o.opened[0] === o.ctx && o.opened[1] === o.overlay);
    o = await openP(false);
    ok('a panel file that does not load says so and never falls back to window.prompt', o.opened === null && o.status.length === 1 && !o.prompted);
    // openFor: loads the QR encoder and the text check on first use, mints through the generator closure
    {
      const winP = env({ checkText: null });
      const loaded = []; let minted = [];
      delete winP.NBDQr; delete winP.NBDPhoneShare;
      winP.ScriptLoader = { load: async (p) => { loaded.push(p); if (/qr-code/.test(p)) winP.NBDQr = NBDQr; if (/phone-share/.test(p)) winP.NBDPhoneShare = { checkText: async () => ({ ok: true }) }; } };
      const ctx = { leadId: 'L1', signerEmailDefault: 'd@e.test', onSendForSignature: async (email, o2) => { minted.push([email, o2]); return { signLink: 'https://app.test/s?t=T' + minted.length, emailed: !!email }; }, signPanelOpts: { signerPhoneDefault: '8595550142', signerNameDefault: 'Dana Whitfield', docLabel: 'Roofing Contract' } };
      const host = mkEl('div');
      const pnl = await winP.NBDSignLinkPanel.openFor(ctx, host); await pnl.ready;
      ok('openFor loads the QR encoder and the text check lazily, then draws the QR', loaded.length === 2 && /<svg/.test((() => { let h = ''; walk(pnl.el, (n) => { h += n.innerHTML; }); return h; })()));
      ok('openFor mints a link with sendEmail:false and no address; the Email it path sends the typed address', minted.length === 1 && minted[0][0] === '' && minted[0][1] && minted[0][1].sendEmail === false);
      fire(pnl.el, 'click', byAction(pnl.el, 'text')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
      ok('the text carries the first name, the document and the link', (() => { const b = decodeURIComponent(winP._navs[0] || ''); return /Hi Dana, here is your Roofing Contract/.test(b) && b.indexOf('T1') !== -1; })());
    }
    // the few wording pins that have no behaviour to run here
    const g = src('docs/pro/js/document-generator.js');
    ok('the generator adds sendEmail:false to the createSignRequest payload ONLY when the panel asks, and passes phone, name, type and lead to the viewer',
      rx(/if \(sendOpts && sendOpts\.sendEmail === false\) payload\.sendEmail = false/, g) && rx(/signerPhoneDefault[\s\S]*signerNameDefault[\s\S]*docLabel: typeName[\s\S]*leadId: _leadIdEarly/, g));
    const ver = (re, text) => { const m = re.exec(text); return m ? +m[1] : 0; };
    ok('asset versions bumped well above main (viewer 6 -> 12, docgen generator 34 -> 40, script-loader 249 -> 255)',
      ver(/nbd-doc-viewer\.js\?v=(\d+)/, src('docs/pro/customer.html')) >= 12 && ver(/nbd-doc-viewer\.js\?v=(\d+)/, src('docs/pro/dashboard.html')) >= 12
      && ver(/document-generator\.js\?v=(\d+)/, src('docs/pro/js/script-loader.js')) >= 40 && ver(/script-loader\.js\?v=(\d+)/, src('docs/pro/dashboard.html')) >= 255);
    ok('the panel is NOT in the eager boot path (no tag in customer.html or dashboard.html, not in script-loader.js)',
      !rx(/sign-link-panel/, src('docs/pro/customer.html') + src('docs/pro/dashboard.html') + src('docs/pro/js/script-loader.js')));
  }

  console.log('\n' + (failed ? 'FAILED ' + failed + ' of ' + (passed + failed) + ':\n  - ' + fails.join('\n  - ') : 'sign-link-panel: ' + passed + ' checks passed'));
  if (failed) process.exit(1);
  console.log('passed ' + passed + ', failed ' + failed);
})().catch((e) => { console.error(e); process.exit(1); });
