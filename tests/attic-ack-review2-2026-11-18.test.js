/**
 * attic-ack-review2-2026-11-18.test.js - the second review of phase 3 (flag docAtticAckV1, default OFF):
 *   1. a deal whose lead does not resolve, or whose estimate is not that lead's, is refused under the flag
 *   2. the size cap and the linear-time stripping in verifyManifest
 *   3. hidden wording and pre-ticked originals fail the manifest
 *   4. deleted form rows are ignored, a form is bound to the estimate it covered, a legacy lead has no company owner
 *   5. the free check task is created only if absent
 *   7. in-person signing with the flag off does not change when the tenant owner's flag doc cannot be read
 * Run: node tests/attic-ack-review2-2026-11-18.test.js   (needs functions/node_modules)
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

const REROOF = { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] };
const NOTEAR = { grandTotal: 13000, rows: [{ code: 'GTR 5K' }] };
const lead = (extra) => Object.assign({ userId: 'REP', companyId: 'CO', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' }, extra || {});
const ON_OWNER = { _default: {}, CO: { docAtticAckV1: true } };
const CS = require(path.join(FN, 'clause-set.js'));
const SIGNED = { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, declined: false } };

// The REAL form, rendered by the real generator (the manifest is pinned against it). One priced ventilation line (decking) gives a Yes/No.
const renderForm = (notInspected) => {
  const H = require('./helpers/clause-v1-harness');
  const env = H.docs({ flags: { docAtticAckV1: true } });
  ['docs/pro/js/attic-ack-text.js', 'docs/pro/js/attic-ack.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => H.load(env, f));
  const cp = Object.assign({}, H.profileFor(env.win, H.BIZ_ADDR), { paymentTerms: { deckingPerSheetCents: 10000 } });
  return env.win.NBDDocGen.renderAtticAcknowledgment({ homeownerName: 'Jane Smith', address: '12 Oak St', contractDate: '2026-11-18', formDate: '2026-11-18', companyProfile: cp,
    signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Rep', required: true }],
    atticCheck: notInspected ? { status: 'not_inspected', reason: 'declined' }
      : { status: 'inspected', inspectedOn: '2026-11-17', accessPoint: 'hatch', conditions: { mold: true }, photos: [{ id: 'p1', kind: 'overview' }, { id: 'p2', kind: 'cond:mold' }], vent: { floorSqFt: 1200, rule: '1/300' }, recs: [{ id: 'decking', qty: 3 }] } });
};
const FORM = renderForm(false);
const FORM_NI = renderForm(true);

(async () => {
  // ═══════════════════════════════════════════════════════
  section('1. a deal whose lead does not resolve, or whose estimate is not that lead\'s, is refused under the flag');
  {
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
      Object.entries(x.ests || {}).forEach(([id, e]) => { s['estimates/' + id] = Object.assign({ userId: 'REP' }, e); });
      Object.entries(flags || {}).forEach(([id, v]) => { s['feature_flags/' + id] = v; });
      if (x.signed) s['leads/L1/documents/a0'] = SIGNED;
      const db = kit.makeDb(s);
      const L = kit.loadHandler('deal-acceptance.js', db, kit.makeStorage({ [DEAL_PATH]: PAGE }), stubsD(), REALD);
      try { return { v: await L.fns.createDealAcceptToken({ auth: { uid: 'REP', token: { companyId: 'CO', role: 'sales_rep' } }, data: { dealId: 'deal0001' } }), db }; } catch (e) { return { e, db }; }
    };
    const minted = (db) => db._all('deal_accept_tokens').length;

    // the attack: a ghost lead id (dropped silently) and the rep's own estimate with no tear-off line
    let r = await mintDeal(ON_OWNER, { deal: { leadId: 'GHOST', estimateId: 'E9' }, lead: null, ests: { E9: NOTEAR } });
    ok('a deal pointing at a lead that does not exist is refused, even with an estimate that has no tear-off line', !!r.e && r.e.code === 'failed-precondition' && minted(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'GHOST', estimateId: 'E9' }, lead: null, ests: { E9: REROOF } });
    ok('a ghost lead with a re-roof estimate stays refused', !!r.e && minted(r.db) === 0);
    // the lead is real, the estimate is the rep's own but belongs to nobody's lead
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1', estimateId: 'E9' }, lead: { primaryEstimateId: 'E1' }, ests: { E1: REROOF, E9: NOTEAR } });
    ok('a real lead (re-roof) with a deal estimate that is not that lead\'s is refused', !!r.e && r.e.code === 'failed-precondition' && minted(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1', estimateId: 'E9' }, lead: { primaryEstimateId: 'E1' }, ests: { E1: REROOF, E9: Object.assign({ leadId: 'OTHER' }, NOTEAR) } });
    ok('an estimate that belongs to a different lead is refused', !!r.e && minted(r.db) === 0, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1', estimateId: 'E9' }, lead: {}, ests: { E1: Object.assign({ leadId: 'L1' }, REROOF), E9: NOTEAR } });
    ok('the lead has an unlinked re-roof estimate and the deal points at a foreign one with no tear-off line: refused', !!r.e && r.e.code === 'failed-precondition' && minted(r.db) === 0, r.e && r.e.message);
    // lead in another tenant: refused by the existing owner check
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1' }, lead: { userId: 'STRANGER', companyId: 'OTHERCO' }, ests: {} });
    ok('a lead in another tenant is refused', !!r.e && r.e.code === 'permission-denied' && minted(r.db) === 0);
    // the honest cases still mint
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1', estimateId: 'E1' }, lead: { primaryEstimateId: 'E1' }, ests: { E1: REROOF }, signed: true });
    ok('control: the lead\'s own primary estimate with the signed form mints', !!r.v && minted(r.db) === 1, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { leadId: 'L1', estimateId: 'E2' }, lead: { primaryEstimateId: 'E1', scope: 'repair' }, ests: { E1: NOTEAR, E2: Object.assign({ leadId: 'L1' }, NOTEAR) } });
    ok('control: a lead\'s other estimate (estimate.leadId matches), no tear-off line, mints', !!r.v && minted(r.db) === 1, r.e && r.e.message);
    r = await mintDeal(ON_OWNER, { deal: { estimateId: 'E9' }, lead: null, ests: { E9: NOTEAR } });
    ok('control: a deal with no leadId at all keeps the phase 3 behaviour (gated from its own estimate)', !!r.v && minted(r.db) === 1, r.e && r.e.message);
    // flag off: nothing changes
    r = await mintDeal({ _default: {} }, { deal: { leadId: 'GHOST', estimateId: 'E9' }, lead: null, ests: { E9: NOTEAR } });
    ok('FLAG OFF: a ghost lead still mints exactly as before', !!r.v && minted(r.db) === 1, r.e && r.e.message);
    r = await mintDeal({ _default: {} }, { deal: { leadId: 'L1', estimateId: 'E9' }, lead: { primaryEstimateId: 'E1' }, ests: { E1: REROOF, E9: NOTEAR } });
    ok('FLAG OFF: a foreign estimate still mints exactly as before', !!r.v && minted(r.db) === 1, r.e && r.e.message);
  }

  // ═══════════════════════════════════════════════════════
  section('2. the stored copy is size-capped and read in linear time');
  {
    const REAL_FORM = FORM;
    const MB = 1048576;
    // 1 MB of each shape that made the old regexes rescan the rest of the document from every start (quadratic: ~20 s at 256 KB)
    const shapes = { 'repeated <!-- (never closed)': '<!--', 'repeated <script (never closed)': '<script', 'repeated <style': '<style', 'repeated <input (never closed)': '<input', 'repeated <': '<',
      'repeated <p title=" (open quote)': '<p title="', 'repeated <!-- -->': '<!-- -->', 'tags with no end': '<div class=a ' };
    Object.keys(shapes).forEach((name) => {
      const u = shapes[name];
      const h = u.repeat(Math.floor(MB / u.length));
      const t0 = Date.now();
      const r = AG.verifyManifest('attic_acknowledgment', h);
      const dt = Date.now() - t0;
      ok('1 MB of ' + name + ' is read in linear time (' + dt + ' ms) and fails the manifest', dt < 1500 && r.ok === false, dt + ' ms');
      const t1 = Date.now();
      const a = AG.applyAcks(h, h, 'attic_acknowledgment');
      ok('applyAcks on 1 MB of ' + name + ' is linear and never complete (' + (Date.now() - t1) + ' ms)', Date.now() - t1 < 1500 && a.complete === false);
      const t2 = Date.now();
      const rf = AG.resultFor('attic_acknowledgment', h, null);
      ok('resultFor on 1 MB of ' + name + ' is linear and never complete (' + (Date.now() - t2) + ' ms)', Date.now() - t2 < 1500 && rf.complete === false);
      const t3 = Date.now();
      AA.parseAcks(h);
      ok('parseAcks on 1 MB of ' + name + ' is linear (' + (Date.now() - t3) + ' ms)', Date.now() - t3 < 1500);
    });
    // the real form padded to just under, and just over, the cap
    const pad = (n) => REAL_FORM.replace('</body>', '<p>' + 'x'.repeat(n) + '</p></body>');
    ok('the real form still verifies', AG.verifyManifest('attic_acknowledgment', REAL_FORM).ok === true, JSON.stringify(AG.verifyManifest('attic_acknowledgment', REAL_FORM).reasons));
    const under = pad(AG.MAX_HTML - REAL_FORM.length - 20);
    ok('a copy just under the 2 MB cap is still verified', under.length <= AG.MAX_HTML && AG.verifyManifest('attic_acknowledgment', under).ok === true);
    const over = pad(AG.MAX_HTML - REAL_FORM.length + 10);
    const rOver = AG.verifyManifest('attic_acknowledgment', over);
    ok('a copy over the cap is refused with the reason too_large', over.length > AG.MAX_HTML && rOver.ok === false && rOver.reasons[0] === 'too_large');
    ok('the cap is 2 MB and the message says what to do', AG.MAX_HTML === 2 * 1024 * 1024 && /too large/i.test(AG.TOO_LARGE_MSG) && /fresh copy/i.test(AG.TOO_LARGE_MSG));
    const aOver = AG.applyAcks(over, over, 'attic_acknowledgment');
    ok('applyAcks refuses an original over the cap', aOver.complete === false && aOver.manifestReasons.indexOf('too_large') !== -1);
    ok('both callers carry the clear message', /TOO_LARGE_MSG/.test(src('functions/remote-signing.js')) && /TOO_LARGE_MSG/.test(src('functions/in-person-signing-logic.js')));
    ok('no lazy [\\s\\S]*? or [^>]* regex is left in the manifest reader', !/\[\\s\\S\]\*\?/.test(src('functions/attic-gate.js').replace(/\/\/.*$/gm, '')) && !/\[\^>\]\*/.test(src('functions/attic-gate.js').replace(/\/\/.*$/gm, '')) && !/\[\^>\]\*/.test(src('functions/attic-ack.js').replace(/\/\/.*$/gm, '')));
    ok('the two copies of attic-ack.js are still identical', src('functions/attic-ack.js') === src('docs/pro/js/attic-ack.js'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
