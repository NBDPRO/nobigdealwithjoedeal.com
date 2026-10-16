/**
 * Kentucky home solicitation sale: the "BUYER'S RIGHT TO CANCEL" statement
 * (KRS 367.430) on every contract for a Kentucky property (legal cross-check,
 * 2026-10-16).
 *
 * Primary source: KRS 367.430, apps.legislature.ky.gov/law/statutes/statute.aspx?id=34960
 *   (1) "In a home solicitation sale, unless the buyer requests the seller to
 *   provide goods or services in an emergency, the seller must present to the
 *   buyer and obtain his signature to a written agreement or offer to
 *   purchase which designates as the date of the transaction the date on
 *   which the buyer actually signs and contains a statement of the buyer's
 *   rights which complies with subsection (2)."
 *   (2) "The statement must: (a) Appear under the conspicuous caption:
 *   "BUYER'S RIGHT TO CANCEL," and (b) Read as follows: ..." (TEXT below)
 *   (3) "Until the seller has complied with this section the buyer may cancel
 *   the home solicitation by notifying the seller in any manner and by any
 *   means of his intention to cancel."
 *
 * Before this change every surface printed only the FTC 16 CFR 429.1(a)
 * statement, which KRS 367.430 does not accept in place of its own words.
 * This suite fails if the statement is reworded or drops off any surface.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const J = require(path.join(ROOT, 'docs/pro/js/ky-insurance-law.js'));
const JF = require(path.join(ROOT, 'functions/ky-insurance-law.js'));

// The statute's words, typed here independently of the module.
const CAPTION = "BUYER'S RIGHT TO CANCEL";
const TEXT = 'If this agreement was solicited to your residence and you do not want the goods or services, you may ' +
  'cancel this agreement by mailing a notice to the seller. The notice must say that you do not want the goods or ' +
  'services and must be mailed before midnight of the third business day after you sign this agreement. The notice ' +
  'must be mailed to:';
const SELLER = 'No Big Deal Solutions LLC';
const ADDR = '4813 KY-715, Campton, KY 41301';
const unesc = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

console.log('\n1. The words are the statute\'s, in both module copies');
for (const [name, M] of [['docs copy', J], ['functions copy', JF]]) {
  ok(name + ': caption verbatim', M.KY_HSSA_CAPTION === CAPTION, M.KY_HSSA_CAPTION);
  ok(name + ': statement verbatim', M.KY_HSSA_TEXT === TEXT, M.KY_HSSA_TEXT);
  ok(name + ': applies to KY and to an unreadable state (fail closed), not to OH / IN',
    M.kyHomeSolicitationApplies('KY') && M.kyHomeSolicitationApplies('') && !M.kyHomeSolicitationApplies('OH') && !M.kyHomeSolicitationApplies('IN'));
}
ok('the two module copies stay byte-identical (after EOL normalisation)',
  read('docs/pro/js/ky-insurance-law.js').replace(/\r\n/g, '\n') === read('functions/ky-insurance-law.js').replace(/\r\n/g, '\n'));

console.log('\n2. The Notice of Right to Cancel packet (every contract signed in the app, the deal page, remote signing)');
const pk = (state) => J.cancelPacketHtml({ transactionDate: '2026-10-16', sellerName: SELLER, sellerAddress: ADDR, state, homeownerName: 'Jane', propertyAddress: '1 Main St' });
const kyPk = unesc(pk('KY'));
ok('KY packet: statement block present', /data-nbd-statutory="ky-367-430"/.test(kyPk));
ok('KY packet: caption + statement verbatim', kyPk.includes(CAPTION) && kyPk.includes(TEXT));
ok('KY packet: seller name and mailing address filled in', kyPk.includes(SELLER) && kyPk.includes(ADDR));
ok('KY packet: still carries the FTC statement and the two FTC forms', kyPk.includes(J.FTC_STATEMENT) && J.hasCancelPacket(pk('KY')));
ok('unknown-state packet: statement present (fail closed)', /ky-367-430/.test(pk('')));
ok('OH packet: no Kentucky statement', !/ky-367-430/.test(pk('OH')) && !pk('OH').includes('BUYER&#39;S RIGHT TO CANCEL'));
ok('re-dating a KY packet keeps the statement', /ky-367-430/.test(J.restampCancelPacket(pk('KY'), '2026-10-20')));

console.log('\n3. Server contract (render-pdf.js + contract.hbs)');
const RENDER = require(path.join(ROOT, 'functions/render-pdf.js'));
const base = { rightToCancel: 'You may cancel ... See the attached Notice of Cancellation form for an explanation of this right.', jurisdiction: {} };
const kyS = RENDER._buildContractStatutory(Object.assign({}, base, { preparedFor: { address: '12 Oak St, Covington, KY 41011' } }), { address: ADDR }, { footerName: SELLER });
const ohS = RENDER._buildContractStatutory(Object.assign({}, base, { preparedFor: { address: '902 Ridge Rd, Cincinnati, OH 45230' } }), { address: ADDR }, { footerName: SELLER });
ok('KY server contract: kyHssaHtml carries the caption, statement, seller and address',
  unesc(kyS.kyHssaHtml).includes(CAPTION) && unesc(kyS.kyHssaHtml).includes(TEXT) && unesc(kyS.kyHssaHtml).includes(SELLER) && unesc(kyS.kyHssaHtml).includes(ADDR));
ok('OH server contract: no kyHssaHtml', ohS.kyHssaHtml === '');
const hbs = read('functions/print/templates/contract.hbs');
const sigAt = hbs.indexOf('<div class="sig-grid">');
ok('contract.hbs prints {{{statutory.kyHssaHtml}}} in the signature block, before the signatures',
  hbs.indexOf('{{{statutory.kyHssaHtml}}}') > hbs.indexOf('{{{statutory.ftcStatementHtml}}}') && hbs.indexOf('{{{statutory.kyHssaHtml}}}') < sigAt);

console.log('\n4. PDFs: the e-sign envelope notice pages and the estimate contract');
function pdfText(bytes) {
  const s = Buffer.from(bytes);
  const L = s.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(L))) {
    const st = m.index + m[0].length;
    const en = L.indexOf('endstream', st);
    try { out += zlib.inflateSync(s.subarray(st, en)).toString('latin1'); } catch (_) { /* not a flate stream */ }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (a, h) => Buffer.from(h, 'hex').toString('latin1'));
}
(async () => {
  const { PDFDocument } = require(path.join(ROOT, 'functions/node_modules/pdf-lib'));
  const blank = await (async () => { const d = await PDFDocument.create(); d.addPage(); return d.save(); })();
  const { appendCancelNotice } = require(path.join(ROOT, 'functions/cancel-notice-pdf.js'));
  const kyN = pdfText((await appendCancelNotice(blank, { state: 'KY', sellerName: SELLER, sellerAddress: ADDR })).bytes);
  const ohN = pdfText((await appendCancelNotice(blank, { state: 'OH', sellerName: SELLER, sellerAddress: ADDR })).bytes);
  ok('envelope notice (KY): caption printed', kyN.includes(CAPTION));
  ok('envelope notice (KY): "The notice must be mailed to:" and the address printed', /mailed to:/.test(kyN) && kyN.includes('Campton'));
  ok('envelope notice (OH): no Kentucky caption', !ohN.includes(CAPTION));

  const E = require(path.join(ROOT, 'functions/estimate-esign-pdf.js'));
  const est = (state) => E.buildEstimateContractPdf({
    companyName: SELLER, sellerAddress: ADDR, state, title: 'Roofing Contract', estimateNumber: 'T1', preparedDate: 'October 16, 2026',
    customer: { name: 'Jane Smith', address: '12 Oak St' }, lines: [{ label: 'Roof replacement', amountCents: 1500000 }],
    totalCents: 1500000, depositPlan: null, signers: [{ id: 's1', name: 'Jane Smith' }],
  });
  const kyE = pdfText((await est('KY')).bytes);
  const ohE = pdfText((await est('OH')).bytes);
  ok('estimate contract (KY): caption printed', kyE.includes(CAPTION));
  ok('estimate contract (OH): no Kentucky caption', !ohE.includes(CAPTION));
  ok('esign-envelope passes the property state to the estimate contract', /buildEstimateContractPdf\(\{[\s\S]{0,400}state: \(j && j\.state\) \|\| ''/.test(read('functions/esign-envelope.js')));

  console.log('\n5. The template library\'s Notice of Right to Cancel');
  const lib = read('docs/pro/js/document-generator-library.js');
  ok('renderRightToCancel prints the statement for a KY / unreadable-state property',
    /j\.kyHomeSolicitationApplies\(st\)\) \? j\.kyHomeSolicitationHtml\(\{ sellerName: co, sellerAddress: addr \}\)/.test(lib));

  console.log('\n' + (fail ? 'FAILED' : 'OK') + ' -- ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
