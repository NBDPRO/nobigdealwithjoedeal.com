/**
 * attic-ack-review4-2026-11-18.test.js - the fourth review of phase 3 (flag docAtticAckV1, default OFF):
 *   1. a rep-supplied page style block cannot hide wording with colour, size, opacity or position
 *   2. the scanner ends a raw element where a browser does (</name + white space, / or >)
 *   3. an entity-encoded class / style / hidden attribute is refused
 *   4. the form binds to the lead's highest-scope estimate; an estimate not on the lead is refused on all paths
 *   5. the tag count is capped (fails closed) and a stored copy is scanned once
 * Run: node tests/attic-ack-review4-2026-11-18.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));
const kit = require('./lib/doc-evidence-kit');
const H = require('./helpers/clause-v1-harness');
const AA = require(path.join(FN, 'attic-ack.js'));
const AG = require(path.join(FN, 'attic-gate.js'));
const DE = require(path.join(FN, 'doc-evidence.js'));
const K = require(path.join(FN, 'ky-insurance-law.js'));
const ESL = require(path.join(FN, 'esign-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sign = (orig) => orig.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/g, '<img src="' + PNG + '" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">')
  .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/g, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
  .replace(/data-nbd-sig="(homeowner|rep)"/g, 'data-nbd-sig="$1" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
const tick = (html) => html.replace(/<input\b[^>]*>/gi, (t) => (/type="radio"/.test(t) && !/:yes"/.test(t) ? t : t.replace(/>$/, ' checked="">')));

const generated = async (docType, profileExtra) => {
  const env = H.docs({ flags: { docAtticAckV1: true } });
  ['docs/pro/js/attic-ack-text.js', 'docs/pro/js/attic-ack.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => H.load(env, f));
  let cap = null;
  env.win.NBDDocViewer = { open: (o) => { cap = o; return {}; } };
  const cp = Object.assign({}, H.profileFor(env.win, H.BIZ_ADDR), { paymentTerms: { deckingPerSheetCents: 10000 } }, profileExtra || {});
  const ni = docType === 'attic_not_inspected';
  await env.win.NBDDocGen.generate(docType, { homeownerName: 'Jane Smith', address: '12 Oak St', contractDate: '2026-11-18', formDate: '2026-11-18', companyProfile: cp,
    signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Rep', required: true }],
    atticCheck: ni ? { status: 'not_inspected', reason: 'declined' }
      : { status: 'inspected', inspectedOn: '2026-11-17', accessPoint: 'hatch', conditions: { mold: true }, photos: [{ id: 'p1', kind: 'overview' }, { id: 'p2', kind: 'cond:mold' }], vent: { floorSqFt: 1200, rule: '1/300' }, recs: [{ id: 'decking', qty: 3 }] } });
  return cap && cap.html;
};

(async () => {
  const GEN = await generated('attic_acknowledgment');
  const GEN_NI = await generated('attic_not_inspected');
  const verify = (html, o) => AG.verifyManifest('attic_acknowledgment', html, o);
  const refused = (name, html, code, o) => { const r = verify(html, o); ok(name, r.ok === false && (!code || r.reasons.indexOf(code) !== -1), JSON.stringify(r.reasons)); };
  const pageBlock = (h) => /<style>([\s\S]*?)<\/style>/.exec(h)[1];
  const withPage = (h, fn) => { const b = pageBlock(h); return h.replace(b, fn(b)); };

  // ═══════════════════════════════════════════════════════
  section('1. a rep-supplied page style block cannot hide wording (colour, size, opacity, position)');
  {
    ok('control: the generated forms pass', verify(GEN).ok === true && AG.verifyManifest('attic_not_inspected', GEN_NI).ok === true, JSON.stringify(verify(GEN).reasons));
    const add = (css) => withPage(GEN, (b) => b + '\n' + css);
    refused('*{color:#fff;background:#fff} appended to the page block', add('*{color:#fff;background:#fff}'), 'style_block');
    refused('font-size:1px on every element', add('*{font-size:1px}'), 'style_block');
    refused('opacity:.01 on the form paragraphs', add('.aa-p{opacity:.01}'), 'style_block');
    refused('left:-99vw (position moves the wording off the page)', add('.aa-p{position:absolute;left:-99vw}'), 'style_block');
    refused('top:99999px', add('.aa-p{position:relative;top:99999px}'), 'style_block');
    refused('color:rgba(0,0,0,0)', add('.aa-p{color:rgba(0,0,0,0)}'), 'style_block');
    refused('width:1px;height:1px on the form paragraphs', add('.aa-p{width:1px;height:1px}'), 'style_block');
    refused('a new rule on a wording class', add('.aa-note{color:#fff}'), 'style_block');
    // an existing rule edited: the text colour set to the page colour
    refused('body text colour changed to white (the page is white)', withPage(GEN, (b) => b.replace('color:#14181F; line-height', 'color:#fff; line-height')), 'style_block');
    refused('body background made as dark as the text', withPage(GEN, (b) => b.replace('background:#fff; }', 'background:#14181F; }')), 'style_block');
    refused('the heading colour set to white', withPage(GEN, (b) => b.replace(/(h1,h2,h3,h4 \{[^}]*?)color:#1A3057/, '$1color:#ffffff')), 'style_block');
    refused('the footer wording colour set to the footer colour', withPage(GEN, (b) => b.replace('letter-spacing:.1em; color:#fff; font-size:11px;', 'letter-spacing:.1em; color:#12223D; font-size:11px;')), 'style_block');
    refused('a hex colour with an alpha channel', withPage(GEN, (b) => b.replace('color:#14181F; line-height', 'color:#14181F00; line-height')), 'style_block');
    // a tenant's brand: other colours and other fonts, same structure - accepted
    const brand = withPage(GEN, (b) => b.replace(/#1A3057/g, '#0B5D1E').replace(/#12223D/g, '#083D14').replace(/#BD5728/g, '#C2410C').replace(/'Montserrat'/g, "'Poppins'").replace(/'Lato'/g, "'Open Sans'"));
    ok('a tenant\'s own brand colours and fonts on the same page block are accepted', verify(brand).ok === true, JSON.stringify(verify(brand).reasons));
    const sg = tick(sign(brand));
    ok('...also when signed', verify(sg, { signed: true }).ok === true, JSON.stringify(verify(sg, { signed: true }).reasons));
  }

  // ═══════════════════════════════════════════════════════
  section('2. the scanner ends a raw element where a browser does');
  {
    const tail = (h, close) => h.replace('</body>', close + '</body>');
    refused('<title>x</titlez> ... </title>: the wording between is inside the title for a browser', tail(GEN.replace('</head>', '<title>x</titlez></head>'), '</title>'), null);
    refused('<title>x</title9>', tail(GEN.replace('</head>', '<title>x</title9></head>'), '</title>'), null);
    refused('the widget script closed with </scriptx>', tail(GEN.replace(/(<script src="[^"]*signature-widget\.js" defer>)<\/script>/, '$1</scriptx>'), '</script>'), null);
    refused('the widget script closed with </script-x>', tail(GEN.replace(/(<script src="[^"]*signature-widget\.js" defer>)<\/script>/, '$1</script-x>'), '</script>'), null);
    refused('a style block closed with </stylez>', tail(GEN.replace('</head>', '<style id="nbd-sig-styles">x</stylez></head>'), '</style>'), null);
    ok('control: </title > (white space before >) still closes the title and the form passes', verify(GEN.replace('</title>', '</title >')).ok === true, JSON.stringify(verify(GEN.replace('</title>', '</title >')).reasons));
    ok('control: </script\\n> closes the widget script', verify(GEN.replace(/(<script src="[^"]*signature-widget\.js" defer>)<\/script>/, '$1</script\n>')).ok === true);
    ok('control: </title/> closes the title', verify(GEN.replace('</title>', '</title/>')).ok === true);
  }

  // ═══════════════════════════════════════════════════════
  section('3. an entity-encoded class, style or hidden attribute is refused');
  {
    const wrap = (cls) => GEN.replace('<div class="section">', '<div class="' + cls + '">');
    ok('control: the generated form has a plain section div to wrap', GEN.indexOf('<div class="section">') !== -1);
    refused('class="&#110;o-print" (decodes to no-print: hidden in print)', wrap('&#110;o-print'), 'entity_attr');
    refused('class="no&#45;print"', wrap('no&#45;print'), 'entity_attr');
    refused('class="&#x6e;o-print section"', wrap('&#x6e;o-print section'), 'entity_attr');
    refused('class="nbd-sig-&#99;ontrols"', wrap('nbd-sig-&#99;ontrols'), 'entity_attr');
    refused('a style attribute with an entity (&#100;isplay:none)', GEN.replace('<div class="section">', '<div class="section" style="&#100;isplay:none">'), 'entity_attr');
    refused('an id with an entity', GEN.replace('<div class="section">', '<div class="section" id="a&amp;b">'), 'entity_attr');
    ok('control: a plain class on the same div is accepted', verify(wrap('section')).ok === true);
  }

  // ═══════════════════════════════════════════════════════
  section('4. the form binds to the lead\'s highest-scope estimate; an estimate not on the lead is refused on every path');
  {
    const E1 = { userId: 'REP', leadId: 'L1', grandTotal: 14500, rows: [{ code: 'LAB TO1' }] };
    const TRIV = { userId: 'REP', leadId: 'L1', grandTotal: 120, rows: [{ code: 'GTR 5K' }] };
    const EX = { userId: 'REP', leadId: 'OTHER', grandTotal: 9000, rows: [{ code: 'LAB TO1' }] };
    const leadRow = { userId: 'REP', companyId: 'CO', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' };
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const SP = 'documents/REP/L1/d-9.html';
    const world = (rowEstimateId, type, extra) => kit.makeDb(Object.assign({ 'leads/L1': leadRow, 'estimates/E1': E1, 'estimates/TRIV': TRIV, 'estimates/EX': EX, 'companyProfile/CO': {},
      'feature_flags/CO': { docAtticAckV1: true },
      'leads/L1/documents/d1': Object.assign({ name: 'Doc', type: type || 'attic_acknowledgment', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: SP, userId: 'REP' }, rowEstimateId ? { estimateId: rowEstimateId } : {}) }, extra || {}));
    const lead0 = () => leadRow;
    const resOf = (db) => (db._get('leads/L1/documents/d1') || {}).atticAckResult || {};

    // decide / formBasis
    let db = world('TRIV');
    let b = await AG.formBasis(db, 'L1', lead0(), { estimateId: 'TRIV' });
    ok('formBasis: a trivial estimate on the lead cannot be the basis while the lead has a re-roof estimate (basis is E1)', b.id === 'E1' && b.stamp === AG.estimateStamp(E1), JSON.stringify(b));
    let d = await AG.decide(db, 'L1', lead0(), { estimateId: 'TRIV' });
    ok('decide: sending the trivial estimate is gated on E1 (the lead is a re-roof, the basis is E1)', d.required === true && d.basis.id === 'E1', JSON.stringify(d.basis));
    db._store.set('leads/L1/documents/d1', Object.assign({}, db._get('leads/L1/documents/d1'), { atticAckResult: { version: AA.VERSION, complete: true, estimateId: 'TRIV', estimateStamp: AG.estimateStamp(TRIV) } }));
    d = await AG.decide(db, 'L1', lead0(), { estimateId: 'TRIV' });
    ok('a form recorded against the trivial estimate does not satisfy the gate', d.satisfied === false);
    let threw = null; try { await AG.formBasis(db, 'L1', lead0(), { estimateId: 'EX' }); } catch (e) { threw = e; }
    ok('formBasis: an estimate of another lead throws estimate_not_on_lead', !!threw && threw.code === 'estimate_not_on_lead', threw && threw.message);
    threw = null; try { await AG.formBasis(db, 'L1', lead0(), { estimateId: 'GHOST' }); } catch (e) { threw = e; }
    ok('formBasis: an estimate that does not exist throws too', !!threw && threw.code === 'estimate_not_on_lead');
    d = await AG.decide(db, 'L1', lead0(), { estimateId: 'EX', estimate: EX });
    ok('decide (the deal path\'s call): an estimate of another lead is refused, not read as the basis', d.satisfied === false && d.required === true && /not one of this customer/i.test(d.message), JSON.stringify(d).slice(0, 200));
    ok('...and the gate stays closed when it is the only re-roof estimate in play', d.basis.id !== 'EX');

    // in-person: the form row
    const signIP = async (db2) => { try { await Lg.handleInPersonSignature(db2, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { on: true, readBytes: async () => Buffer.from(tick(GEN), 'utf8') }, recordJobEvent: async () => ({}) }); return null; } catch (e) { return e; } };
    db = world('TRIV');
    let e = await signIP(db);
    ok('in-person: a form whose row names the trivial estimate is recorded against E1', !e && resOf(db).estimateId === 'E1' && resOf(db).estimateStamp === AG.estimateStamp(E1), e && e.message);
    db = world('EX');
    e = await signIP(db);
    ok('in-person: a row naming another lead\'s estimate is refused and nothing is recorded', !!e && e.code === 'failed-precondition' && !resOf(db).complete, e && e.code + ' ' + e.message);
    db = world('EX', 'contract');
    e = await signIP(db);
    ok('in-person: a contract row naming another lead\'s estimate is refused', !!e && e.code === 'failed-precondition', e && e.code);

    // remote: submitSignature and createSignRequest
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
    const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
    const submit = async (rowEst, tok) => {
      const dbr = kit.makeDb({ 'leads/L1': leadRow, 'estimates/E1': E1, 'estimates/TRIV': TRIV, 'estimates/EX': EX, 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: 'attic_acknowledgment', htmlPath: SP, estimateId: rowEst },
        ['doc_sign_tokens/' + tok]: { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: SP, signerName: 'Dana Whitfield', docType: 'attic_acknowledgment', consentAsked: false } });
      const Lr = kit.loadHandler('remote-signing.js', dbr, kit.makeStorage({ [SP]: GEN }), stubs(), REAL);
      const sub = kit.reqRes({ token: tok, signedHtml: tick(sign(GEN)) });
      await Lr.fns.submitSignature(sub.req, sub.res);
      return { res: sub.res, dbr, tok: dbr._get('doc_sign_tokens/' + tok) };
    };
    let r = await submit('TRIV', 'TOKTRIV00001');
    const rr = (r.dbr._get('leads/L1/documents/d1') || {}).atticAckResult || {};
    ok('remote submit: a row naming the trivial estimate is recorded against E1', r.res.statusCode === 200 && rr.estimateId === 'E1', r.res.statusCode + ' ' + JSON.stringify(rr));
    r = await submit('EX', 'TOKTRIV00002');
    ok('remote submit: a row naming another lead\'s estimate is refused and the link is not burned', r.res.statusCode >= 400 && r.tok.status === 'pending', r.res.statusCode + ' ' + JSON.stringify(r.res.body));

    const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
      + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
      + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
      + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
      + '</section><!--nbd-cancel-packet:end-->'
      + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
    const CP = 'documents/U1/L1/d-1.html';
    const mint = async (rowEst) => {
      const dbm = kit.makeDb({ 'leads/L1': Object.assign({}, leadRow, { userId: 'U1', companyId: 'U1' }), 'estimates/E1': E1, 'estimates/TRIV': TRIV, 'estimates/EX': EX,
        'companyProfile/U1': { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } },
        'feature_flags/_default': { docAtticAckV1: true },
        'leads/L1/documents/sf': { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: AA.VERSION, complete: true, declined: false, estimateId: rowEst, estimateStamp: AG.estimateStamp({ EX, TRIV }[rowEst]) } },
        'leads/L1/documents/d1': { type: 'contract', typeName: 'Roofing Contract', htmlPath: CP, userId: 'U1', estimateId: rowEst } });
      const Lm = kit.loadHandler('remote-signing.js', dbm, kit.makeStorage({ [CP]: CONTRACT }), stubs(), REAL);
      try { return { v: await Lm.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test', signerName: 'Dana Whitfield' } }), dbm }; } catch (e2) { return { e: e2, dbm }; }
    };
    r = await mint('EX');
    ok('remote createSignRequest: a contract row naming another lead\'s estimate is refused, no link', !!r.e && r.e.code === 'failed-precondition' && r.dbm._all('doc_sign_tokens').length === 0, r.e && r.e.code + ' ' + r.e.message);
    r = await mint('TRIV');
    ok('remote createSignRequest: a contract row naming the trivial estimate is still gated on E1 (no form: refused)', !!r.e && r.e.code === 'failed-precondition' && r.dbm._all('doc_sign_tokens').length === 0, r.e && r.e.code + ' ' + r.e.message);
  }

  // ═══════════════════════════════════════════════════════
  section('5. the tag count is capped (fails closed) and a stored copy is scanned once');
  {
    const flood = (n) => GEN.replace('</body>', '<br>'.repeat(n) + '</body>');
    const big = flood(30000);
    let r = verify(big);
    ok('30,000 extra tags: refused as too_many_tags', r.ok === false && r.reasons.indexOf('too_many_tags') !== -1, JSON.stringify(r.reasons));
    const t0 = Date.now();
    const huge = flood(450000);   // about 1.8 MB, under the byte cap
    r = verify(huge);
    ok('the largest copy the byte cap allows is refused as too_many_tags, quickly', huge.length < AG.MAX_HTML && r.reasons.indexOf('too_many_tags') !== -1 && Date.now() - t0 < 3000, (Date.now() - t0) + ' ms ' + JSON.stringify(r.reasons));
    const ap = AG.applyAcks(big, tick(sign(big)), 'attic_acknowledgment');
    ok('applyAcks of an over-cap original is not complete', ap.complete === false && ap.manifestOk === false);
    ok('resultFor an over-cap signed copy is not complete', AG.resultFor('attic_acknowledgment', tick(sign(big)), null).complete === false);
    ok('control: the real signed form is far under the cap', verify(tick(sign(GEN)), { signed: true }).ok === true);
    ok('the scan counter is exported', typeof AG._scanCalls === 'function');
    if (typeof AG._scanCalls === 'function') {
      const c0 = AG._scanCalls();
      verify(GEN + ' '); verify(GEN + ' ');
      ok('the same copy verified twice is scanned once', AG._scanCalls() - c0 === 1, String(AG._scanCalls() - c0));
    }
  }

  // ═══════════════════════════════════════════════════════
  section('6. PR re-review: inline margins, fonts, container classes, contrast floor, the estimate list');
  {
    for (const [type, form] of [['attic_acknowledgment', GEN], ['attic_not_inspected', GEN_NI]]) {
      const v = (h, o) => AG.verifyManifest(type, h, o);
      const bad = (name, h, code) => { const r = v(h); ok(type + ': ' + name, r.ok === false && r.reasons.indexOf(code) !== -1, JSON.stringify(r.reasons)); };
      ok(type + ': control: the generated form passes', v(form).ok === true, JSON.stringify(v(form).reasons));
      bad('margin-left:99999px on a wording paragraph', form.replace('<p class="aa-p">', '<p class="aa-p" style="margin-left:99999px">'), 'inline_style');
      bad('margin-top:-5000px', form.replace('<p class="aa-p">', '<p class="aa-p" style="margin-top:-5000px">'), 'inline_style');
      bad('margin-left:101px', form.replace('<p class="aa-p">', '<p class="aa-p" style="margin-left:101px">'), 'inline_style');
      bad('margin-left:50em', form.replace('<p class="aa-p">', '<p class="aa-p" style="margin-left:50em">'), 'inline_style');
      bad('margin-left:40px (round 4: only the generator\'s own margin-top:36px is accepted)', form.replace('<p class="aa-p">', '<p class="aa-p" style="margin-left:40px">'), 'inline_style');
      const font = (val) => withPage(form, (b) => b.replace(/(body \{ font-family:)[^;]*;/, '$1' + val + ';'));
      bad('body font-family:Wingdings', font('Wingdings'), 'style_block');
      bad('a symbol font in a full-looking stack', font("'Wingdings','Segoe UI',Helvetica,Arial,sans-serif"), 'style_block');
      bad('Webdings', font("'Webdings','Segoe UI',Helvetica,Arial,sans-serif"), 'style_block');
      bad('a stack with no generic fallback', font("'Lato','Segoe UI'"), 'style_block');
      bad('a stack that is not the tenant shape', font("'Lato',Wingdings,Arial,sans-serif"), 'style_block');
      ok(type + ': control: a tenant face with the standard fallback stack is accepted', v(font("'Open Sans','Segoe UI',Helvetica,Arial,sans-serif")).ok === true);
      bad('an unknown class on a div', form.replace('<div class="section">', '<div class="zz-hide">'), 'bad_class');
      bad('an unknown class on a table', form.replace('</body>', '<table class="zz"><tr><td>x</td></tr></table></body>'), 'bad_class');
      bad('an unknown class on a td', form.replace('</body>', '<table><tr><td class="zz">x</td></tr></table></body>'), 'bad_class');
      bad('an unknown class on a ul', form.replace('</body>', '<ul class="zz"><li>x</li></ul></body>'), 'bad_class');
      bad('body text at 4.2:1 (#7a7a7a) on white', withPage(form, (b) => b.replace('color:#14181F; line-height', 'color:#7a7a7a; line-height')), 'style_block');
      ok(type + ': control: body text at #595959 is accepted', v(withPage(form, (b) => b.replace('color:#14181F; line-height', 'color:#595959; line-height'))).ok === true);
    }
    // the estimate list: more than 20 on the lead is a closed gate, never "the first 20"
    const mk = (n) => { const s = { 'leads/L1': { userId: 'REP', companyId: 'CO', primaryEstimateId: 'E0', jobType: 'cash' } };
      for (let i = 0; i < n; i++) s['estimates/E' + i] = { userId: 'REP', leadId: 'L1', grandTotal: 100 + i, rows: [{ code: i === 25 ? 'LAB TO1' : 'GTR 5K' }] };
      return kit.makeDb(s); };
    let d = await AG.decide(mk(30), 'L1', { userId: 'REP', companyId: 'CO', primaryEstimateId: 'E0' }, {});
    ok('a lead with more than 20 estimates: the gate is closed with a plain message', d.satisfied === false && d.required === true && /more than 20/i.test(d.message), JSON.stringify(d).slice(0, 160));
    let threw = null; try { await AG.formBasis(mk(30), 'L1', { userId: 'REP', companyId: 'CO', primaryEstimateId: 'E0' }, {}); } catch (e) { threw = e; }
    ok('...and formBasis throws too_many_estimates', !!threw && threw.code === 'too_many_estimates');
    d = await AG.decide(mk(20), 'L1', { userId: 'REP', companyId: 'CO', primaryEstimateId: 'E0' }, {});
    ok('control: exactly 20 estimates is read as before (not a re-roof, no form needed)', d.required === false, JSON.stringify(d).slice(0, 160));
  }

  // ═══════════════════════════════════════════════════════
  section('7. round 4: wording on a dark surface, nested margins, font allowlist, class positions, soft-deleted estimates, override with a capped list');
  {
    for (const [type, form] of [['attic_acknowledgment', GEN], ['attic_not_inspected', GEN_NI]]) {
      const v = (h) => AG.verifyManifest(type, h);
      const bad = (name, h) => { const r = v(h); ok(type + ': ' + name, r.ok === false, JSON.stringify(r.reasons)); };
      const P = '<p class="aa-p">';
      const wrap = (cls, inner) => form.replace(P, '<div class="' + cls + '">' + P).replace(/(<p class="aa-p">[\s\S]*?<\/p>)/, '$1' + (inner || '</div>'));
      bad('wording inside div.letterhead (white on a gradient that vanishes in print)', wrap('letterhead'));
      bad('wording inside div.footer', wrap('footer'));
      bad('wording inside div.letterhead-contact', wrap('letterhead-contact'));
      bad('wording inside div.letterhead-tagline', wrap('letterhead-tagline'));
      bad('wording inside div.print-btn', wrap('print-btn'));
      bad('a letterhead-contact class with no letterhead around it', form.replace('<div class="section">', '<div class="letterhead-contact">'));
      bad('a paragraph class on a div (aa-p on a div)', form.replace('<div class="section">', '<div class="aa-p">'));
      bad('an affiliate card class outside the affiliates row', form.replace('<div class="section">', '<div class="affiliate">'));
      const nest = (n) => form.replace('<div class="section">', '<div class="section" style="margin-top:36px;">'.repeat(n) + '<div class="section">') ;
      bad('nested margin-left:100px divs', form.replace('<div class="section">', '<div style="margin-left:100px"><div style="margin-left:100px"><div style="margin-left:100px"><div class="section">'));
      bad('margin-left:100px on one div', form.replace('<div class="section">', '<div class="section" style="margin-left:100px">'));
      bad('the generator\'s margin-top:36px repeated on many wrappers', nest(8));
      ok(type + ': control: the generated form (its own margin-top:36px) still passes', v(form).ok === true, JSON.stringify(v(form).reasons));
      const font = (val) => withPage(form, (b) => b.replace(/(body \{ font-family:)[^;]*;/, '$1' + val + ';'));
      ['MS Reference Specialty', 'MT Extra', 'Segoe MDL2 Assets', 'Monotype Sorts', 'Not A Registered Face'].forEach((f) => bad('font ' + f + ' (not a registered brand face)', font("'" + f + "','Segoe UI',Helvetica,Arial,sans-serif")));
      ['Open Sans', 'Poppins', 'Montserrat', 'Lato'].forEach((f) => ok(type + ': control: registered face ' + f + ' is accepted', v(font("'" + f + "','Segoe UI',Helvetica,Arial,sans-serif")).ok === true));
      bad('a pale tenant page background (#e6e6e6) under the fixed grey captions', withPage(form, (b) => b.replace('background:#fff; }', 'background:#e6e6e6; }')));
    }
    // the estimate list, against a db whose .limit() is real
    const mk = (live, dead, extra) => { const s = { 'leads/L1': { userId: 'REP', companyId: 'CO', primaryEstimateId: 'E0', jobType: 'cash' } };
      for (let i = 0; i < live; i++) s['estimates/E' + i] = { userId: 'REP', leadId: 'L1', grandTotal: 100 + i, rows: [{ code: i === 3 ? 'LAB TO1' : 'GTR 5K' }] };
      for (let i = 0; i < dead; i++) s['estimates/D' + i] = { userId: 'REP', leadId: 'L1', deleted: true, grandTotal: 1, rows: [{ code: 'GTR 5K' }] };
      Object.assign(s, extra || {}); return kit.makeDb(s); };
    const probe = await mk(30, 0).collection('estimates').where('leadId', '==', 'L1').limit(5).get();
    ok('proof: the kit db honours .limit(5) over 30 matching estimates (returns 5)', probe.docs.length === 5, String(probe.docs.length));
    const probe21 = await mk(30, 0).collection('estimates').where('leadId', '==', 'L1').limit(21).get();
    ok('proof: .limit(21) over 30 returns exactly 21, so a 21-doc read means "more than 20"', probe21.docs.length === 21, String(probe21.docs.length));
    const L0 = { userId: 'REP', companyId: 'CO', primaryEstimateId: 'E0' };
    let d = await AG.decide(mk(5, 40), 'L1', L0, {});
    ok('5 live estimates plus 40 soft-deleted ones: NOT capped (deleted ones are not counted); the re-roof estimate is seen', d.required === true && d.scope === 'reroof' && !/more than 20/.test(d.message || ''), JSON.stringify(d).slice(0, 200));
    d = await AG.decide(mk(25, 0), 'L1', L0, {});
    ok('25 live estimates: capped, a re-roof is assumed and the gate is closed', d.required === true && d.satisfied === false && /more than 20/i.test(d.message), JSON.stringify(d).slice(0, 200));
    const ovr = { leadId: 'L1', byUid: 'CO', kind: 'proceed', reason: 'homeowner would not sign the page', at: Date.now(), expiresAt: Date.now() + 86400000, version: AA.VERSION, estimateId: 'E3', estimateStamp: AG.estimateStamp({ userId: 'REP', leadId: 'L1', grandTotal: 103, rows: [{ code: 'LAB TO1' }] }) };
    d = await AG.decide(mk(25, 0, { 'attic_overrides/o1': ovr }), 'L1', L0, {});
    ok('25 live estimates with a recorded owner override on the basis: the override is honoured (the owner can proceed)', d.satisfied === true, JSON.stringify(d).slice(0, 200));
    const signedRow = { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 }, atticAckResult: { version: AA.VERSION, complete: true, estimateId: 'E3', estimateStamp: ovr.estimateStamp } };
    d = await AG.decide(mk(25, 0, { 'leads/L1/documents/sf': signedRow }), 'L1', L0, {});
    ok('25 live estimates: a signed form alone does not satisfy (a re-roof estimate may be out of sight)', d.satisfied === false, JSON.stringify(d).slice(0, 160));
    d = await AG.decide(mk(20, 0), 'L1', L0, {});
    ok('control: exactly 20 live estimates is read in full', !/more than 20/.test(d.message || ''));
  }

  console.log('\n' + (failed ? 'FAILED ' + failed + ': ' + fails.join(' | ') : 'all ok') + ' (' + passed + ' passed)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
