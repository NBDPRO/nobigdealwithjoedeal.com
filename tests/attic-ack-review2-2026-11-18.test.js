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
const SIGNED = { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, declined: false, estimateId: 'E1', estimateStamp: AG.estimateStamp(REROOF) } };

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
  }

  // ═══════════════════════════════════════════════════════
  section('3. wording that is in the markup but not on the page, and pre-ticked boxes, fail the manifest');
  {
    const V = (html, t) => AG.verifyManifest(t || 'attic_acknowledgment', html);
    const bad = (name, html, code, t) => { const r = V(html, t); ok(name, r.ok === false && (!code || r.reasons.some((x) => x === code || x.indexOf(code) === 0)), JSON.stringify(r.reasons)); };
    const P = '<p class="aa-p">';
    const first = FORM.indexOf(P);
    ok('control: the real inspected form passes', V(FORM).ok === true, JSON.stringify(V(FORM).reasons));
    ok('control: the real not-inspected page passes', V(FORM_NI, 'attic_not_inspected').ok === true, JSON.stringify(V(FORM_NI, 'attic_not_inspected').reasons));
    ok('control: the same form with its own print-button CSS rule and margin style is what passes (one inline style, margin only)', /style="margin-top:36px;"/.test(FORM) && /\.no-print \{ display:none!important; \}/.test(FORM));
    const hideP = (attrs) => FORM.slice(0, first) + '<p class="aa-p" ' + attrs + '>' + FORM.slice(first + P.length);
    bad('a required paragraph with style="display:none" fails', hideP('style="display:none"'), 'inline_style');
    bad('...with style="display: none !important" fails', hideP('style="display: none !important"'), 'inline_style');
    bad('...with style="visibility:hidden" fails', hideP('style="visibility:hidden"'), 'inline_style');
    bad('...with style="font-size:0" fails', hideP('style="font-size:0"'), 'inline_style');
    bad('...with style="font-size:0px;line-height:0" fails', hideP('style="font-size:0px;line-height:0"'), 'inline_style');
    bad('...with style="color:#fff" fails (any inline style that is not a margin)', hideP('style="color:#fff"'), 'inline_style');
    bad('...with style="opacity:0" fails', hideP('style="opacity:0"'), 'inline_style');
    bad('...with a single-quoted style fails', hideP("style='display:none'"), 'inline_style');
    bad('...with an unquoted style fails', hideP('style=display:none'), 'inline_style');
    bad('...with the style attribute in capitals fails', hideP('STYLE="DISPLAY:NONE"'), 'inline_style');
    bad('...with the hidden attribute fails', hideP('hidden'), 'hidden_attr');
    bad('...with hidden="until-found" fails', hideP('hidden="until-found"'), 'hidden_attr');
    bad('...with the HIDDEN attribute in capitals fails', hideP('HIDDEN'), 'hidden_attr');
    bad('...with the no-print class (hidden in the printed copy) fails', FORM.slice(0, first) + '<p class="aa-p no-print">' + FORM.slice(first + P.length), 'no_print_wording');
    const paraEnd = FORM.indexOf('</p>', first) + 4;
    const para = FORM.slice(first, paraEnd);
    bad('the paragraph inside a <template> fails', FORM.slice(0, first) + '<template>' + para + '</template>' + FORM.slice(paraEnd), 'template');
    bad('the paragraph inside a <TEMPLATE> in capitals fails', FORM.slice(0, first) + '<TEMPLATE>' + para + '</TEMPLATE>' + FORM.slice(paraEnd), 'template');
    bad('the paragraph only in a comment fails (wording missing)', FORM.slice(0, first) + '<!--' + para + '-->' + FORM.slice(paraEnd), 'wording');
    bad('the paragraph only in an attribute fails (wording missing)', FORM.slice(0, first) + '<span title="' + para.replace(/"/g, '&quot;') + '"></span>' + FORM.slice(paraEnd), 'wording');
    bad('the paragraph only in the page <title> fails (wording missing)', FORM.slice(0, first) + FORM.slice(paraEnd).replace('</title>', '</title>') + '', 'wording');
    bad('the paragraph only inside a <noscript> fails (wording missing)', FORM.slice(0, first) + '<noscript>' + para + '</noscript>' + FORM.slice(paraEnd), 'wording');
    bad('the paragraph only inside a <canvas> fallback fails (wording missing)', FORM.slice(0, first) + '<canvas>' + para + '</canvas>' + FORM.slice(paraEnd), 'wording');
    // the paragraph is real on the page but a quoted attribute swallows it for a reader that stops at the first >
    bad('a quoted > in an attribute does not let wording slip through (the tag is read as a browser does)', FORM.slice(0, first) + '<span title=">">' + '</span>' + FORM.slice(paraEnd), 'wording');
    // CSS
    const css = (rule) => FORM.replace('</head>', '<style>' + rule + '</style></head>');
    bad('a <style> rule .aa-p{display:none} fails', css('.aa-p{display:none}'), 'css_hidden');
    bad('...visibility:hidden in a style block fails', css('.aa-row{visibility:hidden}'), 'css_hidden');
    bad('...font-size:0 in a style block fails', css('.aa-p{font-size:0}'), 'css_hidden');
    bad('...font-size:0px in a style block fails', css('.aa-p{ font-size : 0px }'), 'css_hidden');
    bad('...in a print-only rule fails (the PDF is printed)', css('@media print{.aa-p{display:none!important}}'), 'css_hidden');
    bad('...opacity:0 in a style block fails', css('.aa-p{opacity:0}'), 'css_hidden');
    bad('...color:transparent in a style block fails', css('.aa-p{color:transparent}'), 'css_hidden');
    bad('...text-indent:-9999px in a style block fails', css('.aa-p{text-indent:-9999px}'), 'css_hidden');
    bad('...height:0 in a style block fails', css('.aa-p{height:0;overflow:hidden}'), 'css_hidden');
    bad('...a comment inside the rule does not hide it from the check', css('.aa-p{display:/**/none}'), 'css_hidden');
    bad('...an @import fails', css('@import url(x.css);'), 'css_hidden');
    bad('...an external stylesheet link fails', FORM.replace('</head>', '<link rel="stylesheet" href="https://x.example/h.css"></head>'), 'css_hidden');
    // controls
    const ctl = FORM.indexOf('<input type="checkbox"');
    const ctlEnd = FORM.indexOf('>', ctl);
    const tag = FORM.slice(ctl, ctlEnd + 1);
    bad('a control with style="opacity:0" fails', FORM.replace(tag, tag.replace('<input ', '<input style="opacity:0" ')), 'inline_style');
    bad('a control with the hidden attribute fails', FORM.replace(tag, tag.replace('<input ', '<input hidden ')), 'hidden_attr');
    bad('a control that is type="hidden" fails', FORM.replace(tag, tag.replace('type="checkbox"', 'type="hidden"')), 'control_type');
    bad('a control that is not an input fails', FORM.replace(tag, tag.replace('<input ', '<button ')), 'control_type');
    // pre-ticked: the stored ORIGINAL carries no checked on any control
    bad('a pre-ticked checkbox in the original fails', FORM.replace(tag, tag.replace(/>$/, ' checked="">')), 'preticked');
    bad('a pre-ticked checkbox written as bare `checked` fails', FORM.replace(tag, tag.replace(/>$/, ' checked>')), 'preticked');
    bad('a pre-ticked checkbox written as CHECKED fails', FORM.replace(tag, tag.replace(/>$/, ' CHECKED>')), 'preticked');
    const rad = FORM.slice(FORM.indexOf('<input type="radio"'));
    const radTag = rad.slice(0, rad.indexOf('>') + 1);
    bad('a pre-ticked radio in the original fails', FORM.replace(radTag, radTag.replace(/>$/, ' checked="">')), 'preticked');
    bad('every box pre-ticked in the original fails', FORM.replace(/<input\b[^>]*>/gi, (t) => t.replace(/>$/, ' checked="">')), 'preticked');
    // applyAcks: a pre-ticked original is never complete, even when the signer ticks nothing else
    const pre = FORM.replace(/<input\b[^>]*>/gi, (t) => (/type="radio"/.test(t) && !/:yes"/.test(t) ? t : t.replace(/>$/, ' checked="">')));
    const aPre = AG.applyAcks(pre, pre, 'attic_acknowledgment');
    ok('applyAcks: a fully pre-ticked original is not complete', aPre.complete === false && aPre.manifestOk === false && aPre.manifestReasons.indexOf('preticked') !== -1, JSON.stringify(aPre.manifestReasons));
    const one = FORM.replace(tag, tag.replace(/>$/, ' checked="">'));
    const submitted = FORM.replace(/<input\b[^>]*>/gi, (t) => (/type="radio"/.test(t) && !/:yes"/.test(t) ? t : t.replace(/>$/, ' checked="">')));
    ok('applyAcks: ONE pre-ticked box in the original is refused even though the submission ticks everything', AG.applyAcks(one, submitted, 'attic_acknowledgment').complete === false);
    ok('applyAcks: the clean original with the same submission is complete (control)', AG.applyAcks(FORM, submitted, 'attic_acknowledgment').complete === true);
    // a signed copy keeps its ticks and its signature image
    const signedCopy = AG.applyAcks(FORM, submitted, 'attic_acknowledgment').html;
    ok('a signed copy (ticks, disabled) passes as signed', AG.verifyManifest('attic_acknowledgment', signedCopy, { signed: true }).ok === true);
    ok('...and is not accepted as an original (it is ticked)', AG.verifyManifest('attic_acknowledgment', signedCopy).ok === false);
    const sigImg = '<img src="data:image/png;base64,AAAA" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">';
    ok('the signature image\'s own inline style is allowed in a signed copy', AG.verifyManifest('attic_acknowledgment', signedCopy.replace('</body>', sigImg + '</body>'), { signed: true }).ok === true);
    ok('...but not on any other element', AG.verifyManifest('attic_acknowledgment', signedCopy.replace('</body>', sigImg.replace('<img ', '<img hidden ').replace('class="nbd-sig-img"', 'class="x"') + '</body>'), { signed: true }).ok === false);
    ok('resultFor on the pre-ticked original is never complete', AG.resultFor('attic_acknowledgment', pre.replace('<input', '<input style="display:none"'), null).complete === false);
    // hiding on a signed copy is refused as well
    bad('a signed copy with a hidden required paragraph fails too', signedCopy.replace(P, '<p class="aa-p" style="display:none">'), 'inline_style');
    ok('a signed copy with a hidden required paragraph is not complete in resultFor', AG.resultFor('attic_acknowledgment', signedCopy.replace(P, '<p class="aa-p" hidden>'), null).complete === false);
    // an unterminated comment, tag or style swallows the rest as a browser does
    bad('an unterminated comment before the wording fails', FORM.slice(0, first) + '<!-- ' + FORM.slice(first), 'unterminated');
    bad('an unterminated <style> before the wording fails', FORM.slice(0, first) + '<style>.x{} ' + FORM.slice(first), 'unterminated');
    bad('an unterminated tag at the end of the document fails', FORM + '<p title="x ', 'unterminated');
  }

  // ═══════════════════════════════════════════════════════
  section('4. deleted rows are ignored, a form is bound to the estimate it covered, a legacy lead has no company owner');
  {
    const STAMP1 = AG.estimateStamp(REROOF);
    const formRow = (extra) => Object.assign({ type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, declined: false, estimateId: 'E1', estimateStamp: STAMP1 } }, extra || {});
    const decideWith = async (rows, o) => {
      const x = o || {};
      const s = { 'leads/L1': lead(Object.assign({ primaryEstimateId: 'E1' }, x.lead)), 'estimates/E1': x.est || REROOF, 'companyProfile/CO': {} };
      Object.entries(x.extra || {}).forEach(([k, v]) => { s[k] = v; });
      rows.forEach((r, i) => { s['leads/L1/documents/a' + i] = r; });
      const db = kit.makeDb(s);
      return AG.decide(db, 'L1', s['leads/L1'], x.opts || {});
    };
    let d = await decideWith([formRow()]);
    ok('control: a signed form bound to the estimate being sent satisfies the gate', d.required === true && d.satisfied === true && d.how === 'form', JSON.stringify(d));
    // deleted rows
    d = await decideWith([formRow({ deleted: true })]);
    ok('a signed form row marked deleted: true does not satisfy the gate', d.satisfied === false, JSON.stringify(d));
    d = await decideWith([formRow({ status: 'deleted' })]);
    ok('a form row with status "deleted" does not satisfy the gate', d.satisfied === false);
    d = await decideWith([formRow({ deleted: true }), formRow()]);
    ok('a deleted row beside a live signed form: the live one still counts', d.satisfied === true);
    // binding
    d = await decideWith([formRow({ atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, estimateId: 'E1', estimateStamp: 'deadbeefdeadbeef' } })]);
    ok('a form signed against a different stamp (the estimate was re-priced or re-scoped since) does not satisfy it', d.satisfied === false);
    d = await decideWith([formRow({ atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, estimateId: 'E0', estimateStamp: STAMP1 } })]);
    ok('a form signed against another estimate id (an older estimate) does not satisfy a newer one', d.satisfied === false);
    d = await decideWith([formRow({ atticAckResult: { version: 'ATTIC_ACK_V1', complete: true } })]);
    ok('a form row with no binding at all does not satisfy the gate', d.satisfied === false);
    const E2 = { grandTotal: 16100, rows: [{ code: 'LAB TO1' }, { code: 'DECK' }] };
    d = await decideWith([formRow()], { lead: { primaryEstimateId: 'E2' }, extra: { 'estimates/E2': E2 } });
    ok('the lead\'s primary estimate moved on to a newer re-roof estimate: the old form does not cover it', d.satisfied === false && d.basis.id === 'E2');
    d = await decideWith([formRow({ atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, estimateId: 'E2', estimateStamp: AG.estimateStamp(E2) } })], { lead: { primaryEstimateId: 'E2' }, extra: { 'estimates/E2': E2 } });
    ok('a form signed against the newer estimate does', d.satisfied === true);
    d = await decideWith([formRow()], { est: Object.assign({}, REROOF, { grandTotal: 15000 }) });
    ok('the same estimate id re-priced after the form was signed: refused', d.satisfied === false);
    // the writers record the binding
    const fb = await AG.formBasis(kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF }), 'L1', lead({ primaryEstimateId: 'E1' }));
    ok('formBasis is the lead\'s primary estimate id and stamp', fb.id === 'E1' && fb.stamp === STAMP1);
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const tick = (html) => html.replace(/<input\b[^>]*>/gi, (t) => (/type="radio"/.test(t) && !/:yes"/.test(t) ? t : t.replace(/>$/, ' checked="">')));
    const SP = 'documents/REP/L1/d-9.html';
    const ipDb = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'companyProfile/CO': {},
      'leads/L1/documents/d1': { type: 'attic_acknowledgment', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: SP, userId: 'REP' } });
    let ipr; try { ipr = await Lg.handleInPersonSignature(ipDb, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { on: true, readBytes: async () => Buffer.from(tick(FORM), 'utf8') } }); } catch (e) { ipr = { e }; }
    const ipRes = ((ipDb._get('leads/L1/documents/d1') || {}).atticAckResult) || {};
    ok('in-person: the recorded result carries the estimate id and stamp it covers', !ipr.e && ipRes.complete === true && ipRes.estimateId === 'E1' && ipRes.estimateStamp === STAMP1, ipr.e && ipr.e.message);
    ok('...so the gate reads that very row as satisfied for the same estimate', (await AG.decide(ipDb, 'L1', ipDb._get('leads/L1'), {})).satisfied === true);
    ok('...and not once the estimate changes', (await AG.decide(Object.assign(ipDb, {}), 'L1', ipDb._get('leads/L1'), { estimate: Object.assign({}, REROOF, { grandTotal: 99999 }), estimateId: 'E1' })).satisfied === false);
    // the remote link: the real form, signed through submitSignature, carries the same binding
    {
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const GP = 'documents/REP/L1/d-1.html';
      const sign = (orig) => orig.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/g, '<img src="' + PNG + '" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">')
        .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/g, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
        .replace(/data-nbd-sig="(homeowner|rep)"/g, 'data-nbd-sig="$1" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
      const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
      const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
        './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
      const db2 = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: 'attic_acknowledgment', htmlPath: GP },
        'doc_sign_tokens/TOKATTIC0002': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: GP, signerName: 'Dana Whitfield', docType: 'attic_acknowledgment', consentAsked: false } });
      const Lr = kit.loadHandler('remote-signing.js', db2, kit.makeStorage({ [GP]: FORM }), stubs(), REAL);
      const sub = kit.reqRes({ token: 'TOKATTIC0002', signedHtml: tick(sign(FORM)) });
      await Lr.fns.submitSignature(sub.req, sub.res);
      const rr = (db2._get('leads/L1/documents/d1') || {}).atticAckResult || {};
      ok('remote: the signed form carries the estimate id and stamp it covers', sub.res.statusCode === 200 && rr.complete === true && rr.estimateId === 'E1' && rr.estimateStamp === STAMP1, sub.res.statusCode + ' ' + JSON.stringify(sub.res.body));
      // an unreadable estimate before the burn: the link is not used up
      const db3 = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: 'attic_acknowledgment', htmlPath: GP },
        'doc_sign_tokens/TOKATTIC0003': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: GP, signerName: 'Dana Whitfield', docType: 'attic_acknowledgment', consentAsked: false } });
      const realDoc = db3.doc;
      db3.doc = (p) => (p === 'estimates/E1' ? { get: async () => { throw new Error('unavailable'); } } : realDoc(p));
      const Lr3 = kit.loadHandler('remote-signing.js', db3, kit.makeStorage({ [GP]: FORM }), stubs(), REAL);
      const sub3 = kit.reqRes({ token: 'TOKATTIC0003', signedHtml: tick(sign(FORM)) });
      await Lr3.fns.submitSignature(sub3.req, sub3.res);
      ok('remote: an estimate that cannot be read refuses (503) before the burn, the link stays pending', sub3.res.statusCode === 503 && (db3._get('doc_sign_tokens/TOKATTIC0003') || {}).status === 'pending', sub3.res.statusCode);
    }
    // in-person: a stored copy over the cap is refused with the plain message
    {
      const big = FORM.replace('</body>', '<p>' + 'x'.repeat(AG.MAX_HTML) + '</p></body>');
      const db4 = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'companyProfile/CO': {},
        'leads/L1/documents/d1': { type: 'attic_acknowledgment', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: SP, userId: 'REP' } });
      let e4; try { await Lg.handleInPersonSignature(db4, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { on: true, readBytes: async () => Buffer.from(tick(big), 'utf8') } }); } catch (e) { e4 = e; }
      ok('in-person: a stored copy over the 2 MB cap is refused with the plain too-large message and marked', !!e4 && e4.message === AG.TOO_LARGE_MSG && !!(db4._get('leads/L1/documents/d1') || {}).evidenceRefused && !((db4._get('leads/L1/documents/d1') || {}).atticAckResult), e4 && e4.message);
    }
    // override authority on a legacy lead
    const fail = (c, m) => Object.assign(new Error(m), { code: c });
    const REASON = 'Homeowner will not sign the page; Joe approved by phone.';
    const call = async (db, auth, data) => { try { return { v: await AG.recordOverride(db, auth, data, fail, { flagOn: async () => true }) }; } catch (e) { return { e }; } };
    const legacy = () => kit.makeDb({ 'leads/L1': { userId: 'REP', firstName: 'Dana', primaryEstimateId: 'E1' }, 'estimates/E1': Object.assign({ userId: 'REP' }, REROOF) });
    let r = await call(legacy(), { uid: 'REP', token: {} }, { leadId: 'L1', reason: REASON });
    ok('a legacy lead (no companyId): the rep who created it is NOT the owner and cannot approve', !!r.e && r.e.code === 'permission-denied', r.e && r.e.message);
    r = await call(legacy(), { uid: 'REP', token: { companyId: 'REP' } }, { leadId: 'L1', reason: REASON });
    ok('...even with a token companyId equal to their own uid', !!r.e && r.e.code === 'permission-denied');
    r = await call(legacy(), { uid: 'BOSS', token: { role: 'company_admin', companyId: 'CO' } }, { leadId: 'L1', reason: REASON });
    ok('...a company_admin of some company cannot either (the lead belongs to none)', !!r.e && r.e.code === 'permission-denied');
    r = await call(legacy(), { uid: 'ADM', token: { role: 'admin' } }, { leadId: 'L1', reason: REASON });
    ok('...a platform admin can', !!r.v && r.v.ok === true, r.e && r.e.message);
    r = await call(legacy(), { uid: 'REP', token: {} }, { leadId: 'L1', revoke: true });
    ok('...and the rep cannot revoke on it either', !!r.e && r.e.code === 'permission-denied');
    const withCo = () => kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': Object.assign({ userId: 'REP' }, REROOF) });
    r = await call(withCo(), { uid: 'CO', token: { companyId: 'CO' } }, { leadId: 'L1', reason: REASON });
    ok('control: the owner of a lead that has a companyId still can', !!r.v && r.v.ok === true, r.e && r.e.message);
    r = await call(withCo(), { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', reason: REASON });
    ok('control: the creating rep of a lead that has a companyId still cannot', !!r.e && r.e.code === 'permission-denied');
  }

  // ═══════════════════════════════════════════════════════
  section('5. the free check task is created only if absent (a lost freeCheckTaskCreated flag cannot reopen a completed task)');
  {
    const panelJs = fs.readFileSync(path.join(ROOT, 'docs/pro/js/attic-panel.js'), 'utf8').replace(/\r\n/g, '\n');
    const mkPanel = (o) => {
      const x = o || {};
      const store = new Map(Object.entries(x.seed || {}));
      const writes = [];
      const win = { location: { pathname: '/pro/customer.html' }, _user: { uid: 'REP', email: 'rep@example.test' }, db: {}, serverTimestamp: () => 'TS',
        doc: (db, ...p) => ({ path: p.join('/') }), collection: (db, ...p) => ({ path: p.join('/') }),
        getDoc: x.noGetDoc ? undefined : async (ref) => { if (x.readFails) throw new Error('offline'); const d = store.get(ref.path); return { exists: () => d !== undefined, data: () => d }; },
        setDoc: async (ref, data) => { writes.push(['setDoc', ref.path, data]); store.set(ref.path, Object.assign({}, store.get(ref.path) || {}, data)); },
        addDoc: async (ref, data) => { writes.push(['addDoc', ref.path, data]); },
        updateDoc: async (ref, data) => { writes.push(['updateDoc', ref.path, data]); },
        addEventListener() {}, NBDFlags: { enabled: () => true, onReady() {} }, _leadDoc: { id: 'L1', scheduledDate: '' }, _customerId: 'L1' };
      win.NBDAtticAck = AA; win.NBDAtticAckText = require(path.join(FN, 'attic-ack-text.js'));
      const doc0 = { addEventListener() {}, getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {} }), body: { appendChild() {} } };
      new Function('window', 'document', 'console', panelJs)(win, doc0, console);
      return { T: win.NBDAtticPanel._freeCheckTask, store, writes };
    };
    const rec = { status: 'not_inspected', reason: 'declined' };
    const day = 86400000;
    const args = () => ['L1', rec, { days: 3, startMs: Date.now() + 30 * day, nowMs: Date.now() }];
    let p = mkPanel();
    ok('no task yet: the task is written once, at the deterministic id', (await p.T(...args())) === true && p.writes.filter((x) => x[0] === 'setDoc' && x[1] === 'leads/L1/tasks/attic-check-L1').length === 1);
    const before = p.writes.length;
    ok('a second call (the flag was lost) finds it and writes nothing', (await p.T(...args())) === true && p.writes.length === before);
    p = mkPanel({ seed: { 'leads/L1/tasks/attic-check-L1': { title: 'Offer the free attic check before the start date', done: true, completedAt: '2026-11-19', dueDate: '2026-12-01', notes: 'rep note' } } });
    const r5 = await p.T(...args());
    const t5 = p.store.get('leads/L1/tasks/attic-check-L1');
    ok('a COMPLETED task is not reopened, re-dated or rewritten', p.writes.length === 0 && t5.done === true && t5.completedAt === '2026-11-19' && t5.dueDate === '2026-12-01' && t5.notes === 'rep note', JSON.stringify(p.writes.map((x) => x.slice(0, 2))));
    ok('...and the call still reports the task as present (so the lead flag is set)', r5 === true);
    p = mkPanel({ readFails: true });
    ok('a task that cannot be read is not overwritten blind: nothing written, not reported as created', (await p.T(...args())) === false && p.writes.length === 0);
    p = mkPanel({ noGetDoc: true });
    ok('no read available on the page: nothing written', (await p.T(...args())) === false && p.writes.length === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
