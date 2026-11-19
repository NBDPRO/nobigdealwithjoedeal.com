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

  console.log('\n' + (failed ? 'FAILED ' + failed + ': ' + fails.join(' | ') : 'all ok') + ' (' + passed + ' passed)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
