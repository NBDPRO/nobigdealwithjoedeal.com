/**
 * tests/signature-document-integrity.test.js
 *
 * submitSignature receives a whole HTML document from the browser and makes it
 * the executed record of a contract. Before 2026-08-02 it wrote those bytes
 * straight over the original in Storage with only a type/length check, so the
 * counterparty could submit a price-altered contract as the signed document —
 * and the same write destroyed the original, leaving nothing to compare to.
 *
 * The gate cannot simply reject HTML: the signing widget legitimately converts
 * each <canvas> to an <img> and reserialises documentElement. So it compares
 * the VISIBLE TEXT of the document with the signature blocks removed.
 *
 * THE TWO WAYS THIS GATE COULD BE WRONG, and both are tested here:
 *   - too loose  → a tampered price sails through (the vulnerability)
 *   - too strict → an ordinary browser round-trip is rejected and NOBODY CAN
 *                  SIGN ANYTHING. For a contract flow that is the worse
 *                  failure, so the round-trip cases below are not padding.
 *
 * Extracts the real helpers from functions/remote-signing.js via vm rather
 * than reimplementing them, so a change to the shipping code is what gets
 * tested. Zero deps. Run: node tests/signature-document-integrity.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'remote-signing.js'), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

// ── extract the helpers ───────────────────────────────────────────────────
function extractFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  if (at < 0) {
    console.error(`FATAL: function ${name}() not found in functions/remote-signing.js.`);
    console.error('If it was renamed, update this extractor — do NOT delete the test.');
    process.exit(2);
  }
  const open = SRC.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.error(`FATAL: could not brace-match ${name}()`); process.exit(2); }
  return SRC.slice(at, end);
}

// 2026-10-04: the gate leaves the server-authored Notice of Right to Cancel
// packet out of the compare (it is re-dated on serve and re-rendered on
// submit) — it needs the server's copy of ky-insurance-law.js.
const KyLaw = require(path.join(ROOT, 'functions', 'ky-insurance-law.js'));
const sandbox = { console, KyLaw };
vm.createContext(sandbox);
vm.runInContext(
  [extractFn('endOfDivAt'), extractFn('stripSignatureBlocks'), extractFn('visibleText'), extractFn('signedDocMatchesOriginal'), extractFn('signedDocHasSignature')].join('\n\n'),
  sandbox
);
const matches = (a, b) => sandbox.signedDocMatchesOriginal(a, b).ok;

console.log('SIGNED-DOCUMENT INTEGRITY GATE');
ok('extracted the real helpers from remote-signing.js',
  typeof sandbox.signedDocMatchesOriginal === 'function' && typeof sandbox.visibleText === 'function');

// ── a realistic served document ───────────────────────────────────────────
const ORIGINAL = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Roofing Agreement</title>
<style>.doc{font-family:serif} .nbd-sig-canvas{border:1px solid #ccc}</style></head>
<body>
  <h1>Roofing Agreement</h1>
  <p>Prepared for <strong>Dana Whitfield</strong> at 118 Maple Ridge Ct.</p>
  <table><tr><td>Tear-off &amp; full replacement</td><td>$28,400.00</td></tr>
         <tr><td>Total due on completion</td><td>$28,400.00</td></tr></table>
  <p>Scope: remove existing layers, install GAF Timberline HDZ, replace all pipe boots.</p>
  <div data-nbd-sig="Homeowner" data-required="true" data-label="Homeowner">
    <canvas class="nbd-sig-canvas" width="600" height="180"></canvas>
    <div class="nbd-sig-controls"><button data-nbd-sig-action="clear">Clear</button></div>
  </div>
  <script src="/pro/js/signature-widget.js"></script>
</body></html>`;

/** What the widget actually produces: canvas -> img, controls -> date stamp. */
function legitimatelySigned(html, pngDataUrl) {
  return html
    .replace(
      /<canvas class="nbd-sig-canvas"[^>]*><\/canvas>/,
      `<img src="${pngDataUrl}" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">`
    )
    .replace(
      /<div class="nbd-sig-controls">[\s\S]*?<\/div>/,
      '<div class="nbd-sig-date">Signed August 2, 2026</div>'
    )
    .replace('<div data-nbd-sig="Homeowner"', '<div data-nbd-sig="Homeowner" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-08-02T18:00:00.000Z"');
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── 1. The legitimate path MUST work ──────────────────────────────────────
ok('a normally-signed document is accepted', matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG)));

// ── 2. Browser round-trip noise MUST NOT be read as tampering ─────────────
// Each of these is something a real serializer does. A false positive here
// means a homeowner cannot sign at all.
ok('attribute reordering is not tampering',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('<div data-nbd-sig="Homeowner" data-required="true" data-label="Homeowner"', '<div data-label="Homeowner" data-required="true" data-nbd-sig="Homeowner"')));
ok('single->double quote normalisation is not tampering',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('class="nbd-sig-img"', "class='nbd-sig-img'")));
ok('entity re-encoding (&amp; vs &) is not tampering',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('Tear-off &amp; full replacement', 'Tear-off & full replacement')));
ok('whitespace/indentation churn is not tampering',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace(/\n\s+/g, '\n ')));
ok('an injected <style> block is not tampering',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('</head>', '<style>.x{color:red}</style></head>')));
ok('a stripped <script> tag is not tampering',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace(/<script[\s\S]*?<\/script>/, '')));

// ── 3. THE VULNERABILITY: content edits MUST be rejected ──────────────────
ok('altering the contract price is REJECTED',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace(/\$28,400\.00/g, '$2,840.00')));
ok('altering only ONE of two price occurrences is REJECTED',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('<td>$28,400.00</td></tr>\n         <tr>', '<td>$2,840.00</td></tr>\n         <tr>')));
ok('removing a scope line is REJECTED',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('replace all pipe boots.', '')));
ok('adding a new clause is REJECTED',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('</body>', '<p>Contractor waives all warranty obligations.</p></body>')));
ok('changing the signer name is REJECTED',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('Dana Whitfield', 'Someone Else')));
ok('swapping in a completely different document is REJECTED',
  !matches(ORIGINAL, '<!DOCTYPE html><html><body><h1>Nothing</h1></body></html>'));
ok('hiding an edit inside a comment does not help',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('$28,400.00</td></tr>\n         <tr><td>Total', '$1.00</td></tr><!-- x --><tr><td>Total')));

// ── 4. Signature blocks are the ONLY mutable region ───────────────────────
ok('a second signature image inside the sig block is allowed',
  matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('</div>\n  <script', `<img src="${PNG}" class="nbd-sig-img"></div>\n  <script`)));
ok('text smuggled OUTSIDE the sig block is still rejected',
  !matches(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('<div data-nbd-sig=', '<p>Price is now $1.</p><div data-nbd-sig=')));

// ── 5. stripSignatureBlocks must handle nesting ───────────────────────────
// Sig blocks contain their own <div>s; a non-greedy match would stop at the
// first </div> and leave block content in the comparison, which would then
// reject every legitimate signature.
{
  const nested = '<p>keep</p><div data-nbd-sig="A"><div class="inner"><div>deep</div></div></div><p>tail</p>';
  const stripped = sandbox.stripSignatureBlocks(nested);
  ok('nested divs inside a signature block are fully removed',
    !stripped.includes('deep') && !stripped.includes('inner')
    && stripped.includes('keep') && stripped.includes('tail'));
}

// ── 6. Non-vacuity — the comparison must be able to see content at all ────
ok('visibleText actually extracts document text',
  sandbox.visibleText(ORIGINAL).includes('Roofing Agreement')
  && sandbox.visibleText(ORIGINAL).includes('28,400'));
ok('visibleText drops script and style bodies',
  !sandbox.visibleText(ORIGINAL).includes('font-family')
  && !sandbox.visibleText(ORIGINAL).includes('signature-widget.js'));
ok('the failure reason never echoes document content',
  (() => {
    const v = sandbox.signedDocMatchesOriginal(ORIGINAL, legitimatelySigned(ORIGINAL, PNG).replace('$28,400.00', '$1.00'));
    return !v.ok && !/28,400|Dana|Maple/.test(v.reason || '');
  })());

// ── 4. IS THERE ACTUALLY A SIGNATURE IN THE EXECUTED RECORD? ─────────────
// The gate above proves the document SAYS the same thing. It says nothing
// about whether anyone signed it — and that was the bigger hole. The
// widget's finalize() reported success over an empty pad list, so a
// document carrying no signature field submitted cleanly, burned the
// single-use token, stamped the document signedRemotely:true and notified
// the rep "Document signed". Only 1 of the 27 generated document types
// emitted a signature canvas, so every other type did exactly that.
console.log('\n4. the executed record actually contains a signature');

const NO_FIELDS = ORIGINAL.replace(/<div data-nbd-sig[\s\S]*?<\/div>\s*<\/div>/, '<p>No signature field here.</p>');

ok('a document we served with NO signature field is refused',
  (() => {
    const v = sandbox.signedDocHasSignature(NO_FIELDS, NO_FIELDS);
    return !v.ok && v.reason === 'noFields';
  })());

ok('noFields is reported apart from unsigned (the signer cannot fix our bug)',
  sandbox.signedDocHasSignature(NO_FIELDS, NO_FIELDS).reason === 'noFields'
  && sandbox.signedDocHasSignature(ORIGINAL, ORIGINAL).reason === 'unsigned');

ok('a signable document returned UNSIGNED is refused',
  (() => {
    const v = sandbox.signedDocHasSignature(ORIGINAL, ORIGINAL);
    return !v.ok && v.reason === 'unsigned';
  })());

ok('a genuinely signed document passes',
  sandbox.signedDocHasSignature(ORIGINAL, legitimatelySigned(ORIGINAL, PNG)).ok);

ok('the finalized marker is matched regardless of quote style',
  sandbox.signedDocHasSignature(
    ORIGINAL,
    legitimatelySigned(ORIGINAL, PNG).replace('data-nbd-sig-finalized="1"', "data-nbd-sig-finalized='1'")
  ).ok);

ok('stripping the finalized marker out of a signed doc is refused',
  !sandbox.signedDocHasSignature(
    ORIGINAL,
    legitimatelySigned(ORIGINAL, PNG).replace(/data-nbd-sig-finalized\s*=\s*["']1["']/, '')
  ).ok);

// ── 4. the cancellation packet (2026-10-04) ──────────────────────────────
console.log('\n4. the Notice of Right to Cancel packet');
{
  const PACKET_OPTS = { timeZone: 'America/New_York', sellerName: 'No Big Deal Home Solutions', sellerAddress: '4400 Test Pike, Cincinnati, OH 45202',
    homeownerName: 'Pat Doe', propertyAddress: '12 Elm St, Cincinnati, OH 45230', state: 'OH', kyInsurance: false };
  const withPacket = ORIGINAL.replace('</body>', KyLaw.cancelPacketHtml(Object.assign({ transactionDate: '2026-10-05' }, PACKET_OPTS)) + '</body>');
  const servedLater = KyLaw.restampCancelPacket(withPacket, '2026-10-07');
  ok('a packet re-dated on serve (Oct 5 → Oct 7) still matches the original',
    servedLater !== withPacket && matches(withPacket, legitimatelySigned(servedLater, PNG)));
  ok('…but a tamper OUTSIDE the packet is still refused',
    !matches(withPacket, legitimatelySigned(servedLater, PNG).replace('$28,400.00', '$1.00')));
}

console.log('\n' + '─'.repeat(50));
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of fails) console.log('  - ' + f);
  console.log(`
A failure in section 3 means a counterparty can alter an executed contract.
A failure in section 2 means nobody can sign anything — check before shipping.`);
  process.exit(1);
}
process.exit(0);
