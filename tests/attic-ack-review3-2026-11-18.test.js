/**
 * attic-ack-review3-2026-11-18.test.js - the third review of phase 3 (flag docAtticAckV1, default OFF):
 *   1. the form the REAL generate() produces passes verifyManifest (style blocks are an allowlist, not a denylist with one exemption)
 *   2. the stored-copy checks are linear (a hostile signed copy cannot hang the public submitSignature endpoint)
 *   3. the wording sections are an allowlist of tags, attributes and classes; controls in comments, textarea and noscript do not count
 *   4. flag OFF: the deal mint does not read the lead for attic purposes
 *   5. in-person: an unreadable attic flag is recorded (atticGateUnverified) for audit
 *   6. the form binds to the estimate it was generated for
 *   7. remote: a signed copy over the cap says "too large", not "tick every box"
 * Run: node tests/attic-ack-review3-2026-11-18.test.js   (needs functions/node_modules)
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
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const REROOF = { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] };
const ON_OWNER = { _default: {}, CO: { docAtticAckV1: true } };
const lead = (extra) => Object.assign({ userId: 'REP', companyId: 'CO', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.test', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' }, extra || {});
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// A signature the way signing writes it: the canvas becomes the image, the controls become the date line, the block is marked finalized.
const sign = (orig) => orig.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/g, '<img src="' + PNG + '" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">')
  .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/g, '<div class="nbd-sig-date">Signed November 18, 2026</div>')
  .replace(/data-nbd-sig="(homeowner|rep)"/g, 'data-nbd-sig="$1" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-11-18T15:00:00.000Z"');
const tick = (html) => html.replace(/<input\b[^>]*>/gi, (t) => (/type="radio"/.test(t) && !/:yes"/.test(t) ? t : t.replace(/>$/, ' checked="">')));

// The form exactly as generate() produces it (the viewer receives this HTML): the page's style block, the form's block, generate()'s
// nbd-sig-styles block and the widget script, around the renderer's output. One priced ventilation line gives a Yes/No pair.
const generated = async (docType, extraData) => {
  const env = H.docs({ flags: { docAtticAckV1: true } });
  ['docs/pro/js/attic-ack-text.js', 'docs/pro/js/attic-ack.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => H.load(env, f));
  let cap = null;
  env.win.NBDDocViewer = { open: (o) => { cap = o; return {}; } };
  const cp = Object.assign({}, H.profileFor(env.win, H.BIZ_ADDR), { paymentTerms: { deckingPerSheetCents: 10000 } });
  const ni = docType === 'attic_not_inspected';
  await env.win.NBDDocGen.generate(docType, Object.assign({ homeownerName: 'Jane Smith', address: '12 Oak St', contractDate: '2026-11-18', formDate: '2026-11-18', companyProfile: cp,
    signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Rep', required: true }],
    atticCheck: ni ? { status: 'not_inspected', reason: 'declined' }
      : { status: 'inspected', inspectedOn: '2026-11-17', accessPoint: 'hatch', conditions: { mold: true }, photos: [{ id: 'p1', kind: 'overview' }, { id: 'p2', kind: 'cond:mold' }], vent: { floorSqFt: 1200, rule: '1/300' }, recs: [{ id: 'decking', qty: 3 }] } }, extraData || {}));
  return cap && cap.html;
};

(async () => {
  const GEN = await generated('attic_acknowledgment');
  const GEN_NI = await generated('attic_not_inspected');

  // ═══════════════════════════════════════════════════════
  section('1. the form the REAL generate() produces is accepted (the style blocks are an allowlist)');
  {
    ok('generate() ran for both types and gave HTML', typeof GEN === 'string' && GEN.length > 5000 && typeof GEN_NI === 'string' && GEN_NI.length > 5000);
    const blocks = (h) => [...h.matchAll(/<style([^>]*)>/g)].length;
    ok('the generated form carries the three style blocks (page, form, nbd-sig-styles) and the widget script', blocks(GEN) === 3 && /id="nbd-sig-styles"/.test(GEN) && /<script src="[^"]*\/pro\/js\/signature-widget\.js" defer><\/script>/.test(GEN));
    let v = AG.verifyManifest('attic_acknowledgment', GEN);
    ok('generate(attic_acknowledgment): verifyManifest accepts it', v.ok === true, JSON.stringify(v.reasons));
    v = AG.verifyManifest('attic_not_inspected', GEN_NI);
    ok('generate(attic_not_inspected): verifyManifest accepts it', v.ok === true, JSON.stringify(v.reasons));
    // signed the way signing writes it (remote: finalizeBlock output; in-person: the widget's image), with the ticks
    const sg = tick(sign(GEN)); const sgNi = tick(sign(GEN_NI));
    v = AG.verifyManifest('attic_acknowledgment', sg, { signed: true });
    ok('...and the SIGNED, ticked copy of the inspected form', v.ok === true, JSON.stringify(v.reasons));
    v = AG.verifyManifest('attic_not_inspected', sgNi, { signed: true });
    ok('...and the SIGNED, ticked copy of the not-inspected form', v.ok === true, JSON.stringify(v.reasons));
    ok('resultFor reads the signed generated copy as complete', AG.resultFor('attic_acknowledgment', sg, null).complete === true && AG.resultFor('attic_not_inspected', sgNi, null).complete === true);
    ok('applyAcks accepts the generated original (manifestOk) and the submission completes it', (() => { const a = AG.applyAcks(GEN, sg, 'attic_acknowledgment'); return a.manifestOk === true && a.complete === true; })());

    // end to end: the remote link, through the real submitSignature, on the generated form
    const GP = 'documents/REP/L1/d-1.html';
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
    const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
    for (const [docType, html, tok] of [['attic_acknowledgment', GEN, 'TOKREAL00001'], ['attic_not_inspected', GEN_NI, 'TOKREAL00002']]) {
      const db = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: docType, htmlPath: GP },
        ['doc_sign_tokens/' + tok]: { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: GP, signerName: 'Dana Whitfield', docType, consentAsked: false } });
      const Lr = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [GP]: html }), stubs(), REAL);
      const sub = kit.reqRes({ token: tok, signedHtml: tick(sign(html)) });
      await Lr.fns.submitSignature(sub.req, sub.res);
      const rr = (db._get('leads/L1/documents/d1') || {}).atticAckResult || {};
      ok('remote submitSignature on the generated ' + docType + ' form: accepted, complete, manifest ok', sub.res.statusCode === 200 && rr.complete === true && rr.manifestOk === true, sub.res.statusCode + ' ' + JSON.stringify(sub.res.body));
    }

    // the allowlist: nothing but the server's own blocks
    const bad = (name, html, code) => { const r = AG.verifyManifest('attic_acknowledgment', html); ok(name, r.ok === false && r.reasons.indexOf(code) !== -1, JSON.stringify(r.reasons)); };
    const addBlock = (css, attrs) => GEN.replace('</head>', '<style' + (attrs || '') + '>' + css + '</style></head>');
    bad('an extra benign <style> block is refused (an allowlist, not only a denylist)', addBlock('.x{color:red}'), 'style_block');
    bad('an extra block that hides wording is refused as style_block and css_hidden', addBlock('.aa-p{display:none}'), 'css_hidden');
    bad('...with the style block in capitals', GEN.replace('</head>', '<STYLE>.aa-p{display:none}</STYLE></head>'), 'style_block');
    bad('a <style media="print"> block is refused', addBlock('.x{color:red}', ' media="print"'), 'style_block');
    bad('the nbd-sig-styles block with a hiding rule added to it is refused', GEN.replace('.nbd-sig-print-name{margin-top:8px;font-size:10px;color:#666;}', '.nbd-sig-print-name{margin-top:8px;font-size:10px;color:#666;}.aa-p{display:none}'), 'style_block');
    bad('...and a second nbd-sig-styles block is refused', GEN.replace('</head>', '<style id="nbd-sig-styles">' + AA.SIG_STYLES_CSS + '</style></head>'), 'style_block');
    bad('the form\'s own block with a rule added is refused', GEN.replace('.aa-opt input{width:18px;height:18px;}', '.aa-opt input{width:18px;height:18px;}.aa-p{display:none}'), 'style_block');
    bad('the page block with a print-only hiding rule added is refused', GEN.replace('* { box-sizing:border-box; }', '@media print{.aa-p{display:none!important}} * { box-sizing:border-box; }'), 'style_block');
    bad('the page block with a property that is not on the allowlist (transform) is refused', GEN.replace('* { box-sizing:border-box; }', '* { box-sizing:border-box; } .aa-p { transform:scale(0); }'), 'style_block');
    bad('the page block with a hiding value (font-size:0) is refused', GEN.replace('* { box-sizing:border-box; }', '* { box-sizing:border-box; } .aa-p { font-size:0; }'), 'css_hidden');
    bad('the page block with an @import is refused', GEN.replace('* { box-sizing:border-box; }', '@import url(x.css); * { box-sizing:border-box; }'), 'style_block');
    bad('a page block that does not open with the print rule is refused', GEN.replace(AA.PRINT_RULE_CSS, '@media print { body { margin:0; } }'), 'style_block');

    // the constants the generator reads are the ones the server compares to
    ok('the generated nbd-sig-styles block IS AA.SIG_STYLES_CSS', GEN.indexOf('<style id="nbd-sig-styles">' + AA.SIG_STYLES_CSS + '</style>') !== -1);
    ok('the generated page block opens with AA.PRINT_RULE_CSS', /<style>\s*@media print \{ \.no-print \{ display:none!important; \} body \{ margin:0; \} @page \{ margin:0\.5in; \} \}/.test(GEN));
    ok('the generated form block IS AA.ATTIC_FORM_CSS', GEN.indexOf('<style>' + AA.ATTIC_FORM_CSS + '</style>') !== -1);
    // a page that loads the generator without attic-ack.js gets the same bytes (flag-off pages are unchanged)
    const bare = H.docs({});
    const injected = bare.win.NBDDocGen._injectSignatureAssets('<html><head></head><body></body></html>');
    ok('without attic-ack.js the generator\'s own literal is the same text as the constant', injected.indexOf('<style id="nbd-sig-styles">' + AA.SIG_STYLES_CSS + '</style>') !== -1);
    ok('...and the page\'s print rule literal is the same text as the constant', H.render(bare, 'renderWorkAuthorization', H.VARIANTS.oh_cash).indexOf(AA.PRINT_RULE_CSS) !== -1);
    ok('document-generator.js, -templates.js and -library.js read the constants from window.NBDAtticAck', /NBDAtticAck/.test(src('docs/pro/js/document-generator.js')) && /PRINT_RULE_CSS/.test(src('docs/pro/js/document-generator-templates.js')) && /ATTIC_FORM_CSS/.test(src('docs/pro/js/document-generator-library.js')));
  }

  // ═══════════════════════════════════════════════════════
  section('2. the stored-copy checks are linear (the remote submitSignature endpoint is public)');
  {
    const timed = (fn) => { const t0 = Date.now(); let r; try { r = fn(); } catch (e) { r = { threw: e.message }; } return { ms: Date.now() - t0, r }; };
    const LIMIT = 1500;
    // 200k repeated 'transform:' inside one <style>
    let t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</head>', '<style>' + 'transform:'.repeat(200000) + '</style></head>')));
    ok('200k repeated transform: inside one <style>: refused in under ' + LIMIT + ' ms (' + t.ms + ' ms)', t.ms < LIMIT && t.r.ok === false && t.r.reasons.indexOf('style_block') !== -1);
    t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</head>', '<style>' + 'transform:scale(1);'.repeat(100000) + '</style></head>')));
    ok('100k transform:scale(1) declarations: under ' + LIMIT + ' ms (' + t.ms + ' ms)', t.ms < LIMIT && t.r.ok === false);
    t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</head>', '<style>.a{transform:scale(0)}</style></head>')));
    ok('transform:scale(0) in a style block is still named css_hidden', t.r.reasons.indexOf('css_hidden') !== -1);
    t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</head>', '<style>.a{transform: rotate(3deg) scale( 0 )}</style></head>')));
    ok('...scale( 0 ) with spaces too', t.r.reasons.indexOf('css_hidden') !== -1);
    // 1 MB of white space inside one <input> tag of the stored original
    const ws = ' '.repeat(1000000);
    const bigTag = GEN.replace('<input type="checkbox"', '<input type="checkbox"' + ws);
    ok('the 1 MB-whitespace original is under the cap', bigTag.length < AG.MAX_HTML, String(bigTag.length));
    t = timed(() => AG.verifyManifest('attic_acknowledgment', bigTag));
    ok('verifyManifest on 1 MB of white space inside an <input> tag: under ' + LIMIT + ' ms (' + t.ms + ' ms)', t.ms < LIMIT);
    t = timed(() => AG.applyAcks(bigTag, tick(sign(GEN)), 'attic_acknowledgment'));
    ok('applyAcks with 1 MB of white space inside an <input> tag of the original: under ' + LIMIT + ' ms (' + t.ms + ' ms)', t.ms < LIMIT, String(t.ms));
    t = timed(() => AG.applyAcks(GEN, tick(sign(bigTag)), 'attic_acknowledgment'));
    ok('...and inside the submitted copy: under ' + LIMIT + ' ms (' + t.ms + ' ms)', t.ms < LIMIT, String(t.ms));
    t = timed(() => AG.resultFor('attic_acknowledgment', tick(sign(bigTag)), null));
    ok('resultFor on the 1 MB-whitespace signed copy: under ' + LIMIT + ' ms (' + t.ms + ' ms)', t.ms < LIMIT, String(t.ms));
    // the rewrite still does what it did on an ordinary tag
    const a = AG.applyAcks(GEN, tick(sign(GEN)), 'attic_acknowledgment');
    ok('applyAcks still ticks and disables each control', a.complete === true && AA.parseAcks(a.html).length > 0 && (a.html.match(/<input\b[^>]*data-nbd-ack[^>]*>/g) || []).every((x) => / disabled=""/.test(x)));
    const SC = GEN.replace('<input type="checkbox"', '<input type="checkbox" ').replace(/(<input type="checkbox" [^>]*data-nbd-ack="ack:saw"[^>]*?)>/, '$1  />');
    const a2 = AG.applyAcks(SC, tick(sign(SC)), 'attic_acknowledgment');
    ok('a self-closing control keeps its slash and is ticked and disabled', /<input[^>]*data-nbd-ack="ack:saw"[^>]* checked="" disabled="" \/>/.test(a2.html), (/<input[^>]*data-nbd-ack="ack:saw"[^>]*>/.exec(a2.html) || [''])[0].slice(-80));
  }

  // ═══════════════════════════════════════════════════════
  section('3. tags, attributes and classes of the form are an allowlist; a control that is not a live tag does not count');
  {
    const bad = (name, html, code, type) => { const r = AG.verifyManifest(type || 'attic_acknowledgment', html); ok(name, r.ok === false && r.reasons.indexOf(code) !== -1, JSON.stringify(r.reasons)); };
    const first = GEN.indexOf('<p class="aa-p">'); const paraEnd = GEN.indexOf('</p>', first) + 4;
    const para = GEN.slice(first, paraEnd);
    const wrap = (open, close) => GEN.slice(0, first) + open + para + close + GEN.slice(paraEnd);
    bad('required wording inside <details> fails', wrap('<details>', '</details>'), 'bad_tag:details');
    bad('...inside <dialog> fails', wrap('<dialog>', '</dialog>'), 'bad_tag:dialog');
    bad('...inside <select> fails', wrap('<select>', '</select>'), 'bad_tag:select');
    bad('...inside <font> fails', wrap('<font color="white">', '</font>'), 'bad_tag:font');
    bad('...inside <DETAILS> in capitals fails', wrap('<DETAILS>', '</DETAILS>'), 'bad_tag:details');
    bad('...inside a <div class="no-print"> (hidden in the printed copy) fails', wrap('<div class="no-print">', '</div>'), 'no_print_wording');
    bad('...inside a <div class="print-btn no-print"> that is a SECOND print button fails', wrap('<div class="print-btn no-print">', '</div>'), 'no_print_wording');
    bad('...inside a div with the signing controls class (hidden in print) fails', wrap('<div class="nbd-sig-controls">', '</div>'), 'wording:0');
    bad('...inside a <span class="nbd-sig-state"> fails', wrap('<span class="nbd-sig-state">', '</span>'), 'wording:0');
    bad('the nbd-sig-controls class on a paragraph fails', GEN.replace('<p class="aa-p">', '<p class="aa-p nbd-sig-controls">'), 'hidden_class');
    bad('an unknown class on a required paragraph fails', GEN.replace('<p class="aa-p">', '<p class="aa-p evil">'), 'bad_class');
    bad('an attribute the render does not write (title) fails', GEN.replace('<p class="aa-p">', '<p class="aa-p" title="x">'), 'bad_attr:title');
    bad('an event handler attribute fails', GEN.replace('<p class="aa-p">', '<p class="aa-p" onclick="x()">'), 'bad_attr:onclick');
    bad('a data- attribute that is not the server\'s fails', GEN.replace('<p class="aa-p">', '<p class="aa-p" data-x="1">'), 'bad_attr:data-x');
    bad('an <iframe> fails', GEN.replace('</body>', '<iframe src="https://x.example/"></iframe></body>'), 'bad_tag:iframe');
    bad('an <a> link fails', GEN.replace('</body>', '<a href="https://x.example/">x</a></body>'), 'bad_tag:a');
    bad('an inline <script> fails', GEN.replace('</body>', '<script>document.title="x"</script></body>'), 'script');
    bad('a <script> from another site fails', GEN.replace('</body>', '<script src="https://evil.example/pro/js/signature-widget.js" defer></script></body>'), 'script');
    bad('a <script src> with a body fails', GEN.replace('</body>', '<script src="/pro/js/signature-widget.js">x()</script></body>'), 'script');
    ok('the widget script on this site\'s own path (relative, or the site origin, or localhost) is accepted', ['/pro/js/signature-widget.js', 'https://nobigdealwithjoedeal.com/pro/js/signature-widget.js', 'http://localhost:5000/pro/js/signature-widget.js'].every((u) => AG.verifyManifest('attic_acknowledgment', GEN.replace(/<script src="[^"]*"/, '<script src="' + u + '"')).ok === true));
    bad('a self-closing <title/> swallows the rest of the page and fails', GEN.replace('<h1 class="lib-h1">', '<title/><h1 class="lib-h1">'), 'unterminated');
    bad('a self-closing <style/> swallows the rest of the page and fails', GEN.replace('<h1 class="lib-h1">', '<style/><h1 class="lib-h1">'), 'unterminated');
    bad('a self-closing <script/> swallows the rest of the page and fails', GEN.replace('<h1 class="lib-h1">', '<script/><h1 class="lib-h1">'), 'script');
    bad('a <textarea> around required wording leaves the wording out of the page and fails', wrap('<textarea>', '</textarea>'), 'wording:0');
    bad('...a <noscript> does too', wrap('<noscript>', '</noscript>'), 'wording:0');
    // controls that are not live tags
    const ctl = (id) => new RegExp('<input\\b[^>]*data-nbd-ack="' + id + '"[^>]*>').exec(GEN)[0];
    const saw = ctl('ack:saw');
    bad('a required control only inside an HTML comment does not count', GEN.replace(saw, '<!-- ' + saw + ' -->'), 'control_count');
    bad('...inside a <textarea> does not count', GEN.replace(saw, '<textarea>' + saw + '</textarea>'), 'control_count');
    bad('...inside a <noscript> does not count', GEN.replace(saw, '<noscript>' + saw + '</noscript>'), 'control_count');
    bad('...inside a <template> does not count', GEN.replace(saw, '<template>' + saw + '</template>'), 'control_count');
    bad('...a decoy copy in a comment beside the live control is not accepted either', GEN.replace(saw, saw + '<!-- ' + saw + ' -->'), 'control_count');
    const sawNi = new RegExp('<input\\b[^>]*data-nbd-ack="ack:saw"[^>]*>').exec(GEN_NI)[0];
    bad('...and for the not-inspected form', GEN_NI.replace(sawNi, '<!-- ' + sawNi + ' -->'), 'control_count', 'attic_not_inspected');
    // depth and stray closes are bounded
    const timed = (fn) => { const t0 = Date.now(); const r = fn(); return { ms: Date.now() - t0, r }; };
    let t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</body>', '<div>'.repeat(5000) + '</body>')));
    ok('5000 nested <div> is refused as too_deep in ' + t.ms + ' ms', t.r.ok === false && t.r.reasons.indexOf('too_deep') !== -1 && t.ms < 1500);
    t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</body>', '</div>'.repeat(200000) + '</body>')));
    ok('200k stray </div> in ' + t.ms + ' ms (linear)', t.ms < 1500);
    t = timed(() => AG.verifyManifest('attic_acknowledgment', GEN.replace('</body>', '<p>'.repeat(300) + '</p>'.repeat(200000) + '</body>')));
    ok('300 open <p> and 200k </p> in ' + t.ms + ' ms (linear)', t.ms < 1500);
    // the real forms, signed and ticked, with the extra fixtures any real render may have: photo thumbnails, an affiliate row
    const withPhotos = await generated('attic_acknowledgment', { atticPhotoUrls: { p1: 'https://firebasestorage.example/o/p1.jpg', p2: 'https://firebasestorage.example/o/p2.jpg' } });
    ok('a generated form with photo thumbnails is accepted', AG.verifyManifest('attic_acknowledgment', withPhotos).ok === true, JSON.stringify(AG.verifyManifest('attic_acknowledgment', withPhotos).reasons));
    const sgPh = tick(sign(withPhotos));
    ok('...and its signed copy', AG.verifyManifest('attic_acknowledgment', sgPh, { signed: true }).ok === true);
    // a blank signer left unsigned keeps the controls and the widget's own button (in-person, one of two signed)
    const half = tick(GEN.replace(/<canvas class="nbd-sig-canvas"><\/canvas>/, '<img src="' + PNG + '" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">').replace('<span class="nbd-sig-state">', '<button type="button" data-nbd-sig-action="use-saved">Use saved</button><span class="nbd-sig-state">'));
    ok('a copy with one signer still blank (controls and the Use saved button kept) is accepted', AG.verifyManifest('attic_acknowledgment', half, { signed: true }).ok === true, JSON.stringify(AG.verifyManifest('attic_acknowledgment', half, { signed: true }).reasons));
  }

  // ═══════════════════════════════════════════════════════
  section('4. flag OFF: the deal mint reads no lead for attic purposes (and still refuses on a failed read when the flag is on)');
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
        'deal_rooms/deal0001': { status: 'sent', userId: 'REP', customerName: 'Dana Whitfield', tiers: { better: { price: 13000 } }, leadId: 'L1', estimateId: 'E1' },
        'companyProfile/CO': { paymentTerms: Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 10000 }) },
        'leads/L1': lead({ address: '12 Oak St, Covington, KY 41011', jobType: 'insurance', primaryEstimateId: 'E1' }), 'estimates/E1': Object.assign({ userId: 'REP' }, REROOF),
      };
      Object.entries(flags || {}).forEach(([id, v]) => { s['feature_flags/' + id] = v; });
      const db = kit.makeDb(s);
      let leadReads = 0;
      const realDoc = db.doc;
      db.doc = (p) => {
        const ref = realDoc(p);
        if (p !== 'leads/L1') return ref;
        return Object.assign({}, ref, { get: async () => { leadReads++; if (x.failLeadReadAfter != null && leadReads > x.failLeadReadAfter) throw new Error('unavailable'); return ref.get(); } });
      };
      const L = kit.loadHandler('deal-acceptance.js', db, kit.makeStorage({ [DEAL_PATH]: PAGE }), stubsD(), REALD);
      try { return { v: await L.fns.createDealAcceptToken({ auth: { uid: 'REP', token: { companyId: 'CO', role: 'sales_rep' } }, data: { dealId: 'deal0001' } }), db, reads: () => leadReads }; } catch (e) { return { e, db, reads: () => leadReads }; }
    };
    const minted = (db) => db._all('deal_accept_tokens').length;
    let r = await mintDeal({ _default: {} }, { failLeadReadAfter: 1 });
    ok('FLAG OFF: a lead that cannot be read a second time does not stop the mint (it is read once, as on main)', !!r.v && minted(r.db) === 1 && r.reads() === 1, (r.e && r.e.message) + ' reads=' + r.reads());
    r = await mintDeal({ _default: {} });
    ok('FLAG OFF: the lead is read exactly once', !!r.v && r.reads() === 1, 'reads=' + r.reads());
    r = await mintDeal(ON_OWNER, { failLeadReadAfter: 1 });
    ok('FLAG ON: the gate reads no lead of its own either (one read; the mint is then refused only for the missing signed form)', r.reads() === 1 && !!r.e && r.e.code === 'failed-precondition' && minted(r.db) === 0, (r.e && r.e.code) + ' reads=' + r.reads());
    // a failed read inside the gate still refuses, with the retryable message (never passes)
    {
      const dbx = kit.makeDb({ 'deal_rooms/deal0001': { status: 'sent', userId: 'REP', customerName: 'Dana Whitfield', tiers: { better: { price: 13000 } }, leadId: 'L1', estimateId: 'E1' },
        'companyProfile/CO': { paymentTerms: Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 10000 }) },
        'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': Object.assign({ userId: 'REP' }, REROOF), 'feature_flags/CO': { docAtticAckV1: true } });
      const realCol = dbx.collection;
      dbx.collection = (c) => (c === 'attic_overrides' ? { where: () => ({ get: async () => { throw new Error('unavailable'); } }) } : realCol(c));
      const L = kit.loadHandler('deal-acceptance.js', dbx, kit.makeStorage({ [DEAL_PATH]: PAGE }), stubsD(), REALD);
      let e; try { await L.fns.createDealAcceptToken({ auth: { uid: 'REP', token: { companyId: 'CO', role: 'sales_rep' } }, data: { dealId: 'deal0001' } }); } catch (x2) { e = x2; }
      ok('FLAG ON: the overrides the gate cannot read fail closed (unavailable) and no link is minted', !!e && e.code === 'unavailable' && dbx._all('deal_accept_tokens').length === 0, e && e.code);
    }
  }

  // ═══════════════════════════════════════════════════════
  section('5. in-person: an attic flag that cannot be read is recorded (atticGateUnverified), the signing itself is unchanged');
  {
    const REALI = ['./in-person-signing-logic', './doc-evidence', './ky-insurance-law', './attic-gate', './attic-ack', './await-briefly', 'crypto'];
    const mk = (type, unreadable, flags) => {
      const s = { 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF,
        'leads/L1/documents/d1': { type, status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: 'documents/REP/L1/d-9.html', userId: 'REP' } };
      Object.entries(flags || {}).forEach(([id, v]) => { s['feature_flags/' + id] = v; });
      const db = kit.makeDb(s);
      const realDoc = db.doc;
      db.doc = (p) => (unreadable.indexOf(p) !== -1 ? { get: async () => { throw new Error('unavailable ' + p); } } : realDoc(p));
      return db;
    };
    const call = async (db) => {
      const L = kit.loadHandler('in-person-signing.js', db, kit.makeStorage({}), { './job-spine': { recordJobEvent: async () => ({ moved: false }) } }, REALI);
      try { return { v: await L.fns.recordInPersonSignature({ auth: { uid: 'REP', token: { companyId: 'CO' } }, data: { leadId: 'L1', docId: 'd1' }, rawRequest: { headers: {}, ip: '203.0.113.9' } }) }; } catch (e) { return { e }; }
    };
    const row = (db) => db._get('leads/L1/documents/d1') || {};
    const acts = (db) => db._all('leads/L1/activity').map((x) => (x.data ? x.data() : x)).filter((x) => x && x.type === 'attic_gate_unverified');
    let db = mk('contract', ['feature_flags/CO']);
    let r = await call(db);
    ok('contract, the owner\'s attic flag unreadable: the signing is still recorded (flag-off behaviour unchanged)', !!r.v && r.v.ok === true, r.e && r.e.code + ' ' + r.e.message);
    ok('...and the row carries a server-written atticGateUnverified', !!row(db).atticGateUnverified && row(db).atticGateUnverified.reason === 'attic_flag_unreadable' && typeof row(db).atticGateUnverified.at === 'number', JSON.stringify(row(db).atticGateUnverified));
    ok('...and the owner gets one activity note', acts(db).length === 1 && acts(db)[0].docId === 'd1' && acts(db)[0].userId === 'REP', JSON.stringify(acts(db)));
    db = mk('contract', []);
    r = await call(db);
    ok('control: the flag readable and off: no mark and no note', !!r.v && !row(db).atticGateUnverified && acts(db).length === 0);
    db = mk('contract', [], { _default: {}, CO: { docAtticAckV1: true } });
    r = await call(db);
    ok('control: the flag readable and ON: the gate still refuses a re-roof contract with no attic form, and nothing is marked unverified', !!r.e && r.e.code === 'failed-precondition' && !row(db).atticGateUnverified && acts(db).length === 0, r.e && r.e.code);
    db = mk('photo_report', ['feature_flags/CO']);
    r = await call(db);
    ok('a document the gate does not apply to is not marked', !!r.v && !row(db).atticGateUnverified && acts(db).length === 0);
    db = mk('attic_acknowledgment', ['feature_flags/CO']);
    r = await call(db);
    ok('an attic form signed in person with the flag unreadable is marked too (nothing could be read back)', !!row(db).atticGateUnverified && acts(db).length === 1, JSON.stringify(row(db)).slice(0, 120));
    // the logic contract: a plain true/false from flagOn still works (older callers)
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    db = mk('contract', []);
    let e; try { await Lg.handleInPersonSignature(db, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { flagOn: async () => false }, recordJobEvent: async () => ({}) }); } catch (x) { e = x; }
    ok('flagOn returning plain false: unchanged, no mark', !e && !row(db).atticGateUnverified);
    db = mk('contract', []);
    try { await Lg.handleInPersonSignature(db, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { flagOn: async () => ({ on: false, unverified: true }) }, recordJobEvent: async () => ({}) }); } catch (x) { e = x; }
    ok('flagOn returning { on: false, unverified: true }: marked', !!row(db).atticGateUnverified);
    ok('firestore.rules lists atticGateUnverified as server-owned on create and on update', (src('firestore.rules').match(/'evidenceRefused', 'atticAckResult', 'atticGateUnverified'\]/g) || []).length === 2);
  }

  // ═══════════════════════════════════════════════════════
  section('6. the form binds to the estimate it was generated for (a non-primary estimate can satisfy the gate)');
  {
    const E1 = { userId: 'REP', grandTotal: 14500, rows: [{ code: 'LAB TO1' }] };
    const E2 = { userId: 'REP', leadId: 'L1', grandTotal: 17250, rows: [{ code: 'LAB TO1' }, { code: 'DECK' }] };
    const EX = { userId: 'REP', leadId: 'OTHER', grandTotal: 9000, rows: [{ code: 'LAB TO1' }] };
    const Lg = require(path.join(FN, 'in-person-signing-logic.js'));
    const SP = 'documents/REP/L1/d-9.html';
    const world = (rowEstimateId) => kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': E1, 'estimates/E2': E2, 'estimates/EX': EX, 'companyProfile/CO': {},
      'leads/L1/documents/d1': Object.assign({ type: 'attic_acknowledgment', status: 'signed', signedAt: { toMillis: () => 1766000000000 }, signers: [{ role: 'homeowner', required: true }], signedSigners: [{ role: 'homeowner' }], htmlPath: SP, userId: 'REP' }, rowEstimateId ? { estimateId: rowEstimateId } : {}) });
    const signIP = async (db) => { try { await Lg.handleInPersonSignature(db, { uid: 'REP', token: { companyId: 'CO' } }, { leadId: 'L1', docId: 'd1' }, { attic: { on: true, readBytes: async () => Buffer.from(tick(GEN), 'utf8') } }); return null; } catch (e) { return e; } };
    const resOf = (db) => (db._get('leads/L1/documents/d1') || {}).atticAckResult || {};
    let db = world('E2');
    let e = await signIP(db);
    ok('a form generated for the lead\'s NON-primary estimate E2: the recorded result carries E2 and its stamp', !e && resOf(db).estimateId === 'E2' && resOf(db).estimateStamp === AG.estimateStamp(E2), e && e.message);
    let d = await AG.decide(db, 'L1', db._get('leads/L1'), { estimateId: 'E2' });
    ok('...and sending E2 is satisfied by it', d.satisfied === true, JSON.stringify(d.basis));
    d = await AG.decide(db, 'L1', db._get('leads/L1'), { estimateId: 'E1' });
    ok('...but sending the primary estimate E1 (also a re-roof) is not', d.satisfied === false && d.basis.id === 'E1');
    db = world(null);
    e = await signIP(db);
    ok('a form with no estimate on its row binds to the primary estimate, as before', !e && resOf(db).estimateId === 'E1');
    d = await AG.decide(db, 'L1', db._get('leads/L1'), { estimateId: 'E2' });
    ok('...and does not satisfy the non-primary estimate E2', d.satisfied === false);
    db = world('EX');
    e = await signIP(db);
    ok('a row naming an estimate that belongs to another lead is ignored: the form binds to the primary', !e && resOf(db).estimateId === 'E1');
    db = world('GHOST');
    e = await signIP(db);
    ok('...and one that does not exist too', !e && resOf(db).estimateId === 'E1');
    // an empty binding never equals a real basis
    db = world('E2');
    db._store.set('leads/L1/documents/d1', Object.assign({}, db._get('leads/L1/documents/d1'), { atticAckResult: { version: 'ATTIC_ACK_V1', complete: true, estimateId: '', estimateStamp: '' } }));
    d = await AG.decide(db, 'L1', db._get('leads/L1'), { estimateId: 'E2' });
    ok('a result with an empty id and stamp does not satisfy a real basis', d.satisfied === false);
    // the remote path reads the same row field
    const GP = SP;
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
    const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
    const dbr = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': E1, 'estimates/E2': E2, 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: 'attic_acknowledgment', htmlPath: GP, estimateId: 'E2' },
      'doc_sign_tokens/TOKBIND00001': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: GP, signerName: 'Dana Whitfield', docType: 'attic_acknowledgment', consentAsked: false } });
    const Lr = kit.loadHandler('remote-signing.js', dbr, kit.makeStorage({ [GP]: GEN }), stubs(), REAL);
    const sub = kit.reqRes({ token: 'TOKBIND00001', signedHtml: tick(sign(GEN)) });
    await Lr.fns.submitSignature(sub.req, sub.res);
    const rr = (dbr._get('leads/L1/documents/d1') || {}).atticAckResult || {};
    ok('remote: the signed form carries the estimate its row names (E2)', sub.res.statusCode === 200 && rr.estimateId === 'E2' && rr.estimateStamp === AG.estimateStamp(E2), sub.res.statusCode + ' ' + JSON.stringify(rr));
    ok('the generator writes estimateId on an attic form row and the panel passes the estimate', /type === 'attic_acknowledgment' \|\| type === 'attic_not_inspected'\) && typeof data\.estimateId/.test(src('docs/pro/js/document-generator.js')) && /estimateId: L\.primaryEstimateId/.test(src('docs/pro/js/attic-panel.js')));
  }

  // ═══════════════════════════════════════════════════════
  section('7. remote: a signed copy over the cap says too large, not "tick every box"');
  {
    const GP = 'documents/REP/L1/d-1.html';
    const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
    const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
      './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
    const run = async (signedHtml, tok) => {
      const db = kit.makeDb({ 'leads/L1': lead({ primaryEstimateId: 'E1' }), 'estimates/E1': REROOF, 'leads/L1/documents/d1': { name: 'Attic', status: 'sent', type: 'attic_acknowledgment', htmlPath: GP },
        ['doc_sign_tokens/' + tok]: { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'REP', mintedBy: 'REP', htmlPath: GP, signerName: 'Dana Whitfield', docType: 'attic_acknowledgment', consentAsked: false } });
      const Lr = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [GP]: GEN }), stubs(), REAL);
      const sub = kit.reqRes({ token: tok, signedHtml });
      await Lr.fns.submitSignature(sub.req, sub.res);
      return { res: sub.res, tok: db._get('doc_sign_tokens/' + tok) };
    };
    const big = tick(sign(GEN)).replace('</body>', '<!--' + 'x'.repeat(AG.MAX_HTML) + '--></body>');
    let r = await run(big, 'TOKBIG000001');
    ok('a signed copy over 2 MB: 422 with the too-large message, link not burned', r.res.statusCode === 422 && r.res.body && r.res.body.error === AG.TOO_LARGE_MSG && !r.res.body.missingAcks && r.tok.status === 'pending', r.res.statusCode + ' ' + JSON.stringify(r.res.body).slice(0, 120));
    r = await run(sign(GEN), 'TOKBIG000002');
    ok('control: an ordinary copy with boxes unticked still says tick every box', r.res.statusCode === 422 && r.res.body.missingAcks === true && /tick every box/.test(r.res.body.error));
    r = await run(tick(sign(GEN)), 'TOKBIG000003');
    ok('control: the ordinary ticked copy is accepted', r.res.statusCode === 200);
  }

  console.log('\n' + (failed ? 'FAILED ' + failed + ': ' + fails.join(' | ') : 'all ok') + ' (' + passed + ' passed)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
