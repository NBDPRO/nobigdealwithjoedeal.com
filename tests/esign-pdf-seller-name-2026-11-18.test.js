/**
 * esign-pdf-seller-name-2026-11-18.test.js — with docClauseSetV1 ON the server e-sign contract PDF names the
 * contracting party as the contract does (entity d/b/a dba), including as the seller in the KY Buyer's Right to
 * Cancel statement and both FTC Notices of Cancellation. Flag off stays byte-identical (golden fixture, untouched).
 * Run: node tests/esign-pdf-seller-name-2026-11-18.test.js   (needs functions/node_modules for pdf-lib)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./helpers/clause-v1-harness');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) passed++;
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
const count = (s, sub) => s.split(sub).length - 1;

(async () => {
  const DE = require('../functions/doc-evidence.js');
  const KyLaw = require('../functions/ky-insurance-law.js');
  const CS = require('../functions/clause-set.js');
  const pdfLib = require(path.join(H.ROOT, 'functions/node_modules/pdf-lib'));
  const drawn = [];
  const orig = pdfLib.PDFPage.prototype.drawText;
  pdfLib.PDFPage.prototype.drawText = function (t, o) { drawn.push(String(t)); return orig.call(this, t, o); };
  const FULL = 'No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions';
  const build = async (state, profile, tenantKey, companyName) => {
    drawn.length = 0;
    const addr = state === 'KY' ? H.KY_ADDR : H.OH_ADDR;
    const cs = DE.buildClauseSet(KyLaw, { address: addr, jobType: 'cash', userId: 'u1' }, {}, profile, tenantKey,
      { ownerNames: 'Jane Smith and Pat Smith', propertyAddress: addr, date: 'November 18, 2026' });
    await H.esignPdf(state, { clauseSet: cs, failClosed: true, companyName, entityName: DE.entityNameFor(profile, tenantKey) || companyName });
    return drawn.join(' ').replace(/\s+/g, ' ');
  };
  const nbdProfile = { paymentTerms: { deckingPerSheetCents: 10000 }, brand: { contact: { mailingAddress: H.BIZ_ADDR } } };
  const NBD = DE.NBD_OWNER_UID_FOR_TESTS;

  // NBD, flag on, KY: KY statement seller and both FTC notices name the full party.
  const ky = await build('KY', nbdProfile, NBD, 'No Big Deal Home Solutions');
  ok('KY flag on: the seller in the Buyer\'s Right to Cancel statement is the full party', ky.includes(KyLaw.KY_HSSA_TEXT + ' ' + FULL + ' ' + H.BIZ_ADDR));
  ok('KY flag on: both FTC Notices of Cancellation name the full party as the seller', count(ky, 'send a telegram, to ' + FULL + ', at ') === 2);
  ok('KY flag on: no bare short name as the seller', !/telegram, to No Big Deal Home Solutions/.test(ky));
  ok('KY flag on: the signature line is By: Joe Deal, Manager', /By: Joe Deal, Manager/.test(ky));
  ok('KY flag on: the statutory wording is unchanged', ky.includes(KyLaw.FTC_STATEMENT) && ky.includes(KyLaw.CANCEL_LINE) && KyLaw.FTC_FORM_PARAS.every((p) => ky.includes(p.replace(/\s+/g, ' '))));

  // OH, flag on.
  const oh = await build('OH', nbdProfile, NBD, 'No Big Deal Home Solutions');
  ok('OH flag on: both FTC Notices of Cancellation name the full party as the seller', count(oh, 'send a telegram, to ' + FULL + ', at ') === 2);
  ok('OH flag on: no Kentucky statement', !/BUYER'S RIGHT TO CANCEL/.test(oh));

  // Another tenant: its own entity (or legalName), never NBD's names.
  const oaks = { paymentTerms: Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 9000 }),
    brand: { entityName: 'Oaks Roofing LLC', dbaName: 'Oaks Roofing', signerTitle: 'Owner', legalName: 'Oaks Roofing', contact: { phone: '(513) 555-0100', mailingAddress: '1 B St' } } };
  const t = await build('OH', oaks, 'someOtherTenantUid', 'Oaks Roofing').catch((e) => 'ERR ' + e.message);
  ok('another tenant: its entity d/b/a dba is the seller on both notices', count(t, 'send a telegram, to Oaks Roofing LLC d/b/a Oaks Roofing, at ') === 2, String(t).slice(0, 200));
  ok('another tenant: no NBD name anywhere', !/NBD|No Big Deal|Joe Deal/.test(t));
  const noEntity = JSON.parse(JSON.stringify(oaks)); delete noEntity.brand.entityName; delete noEntity.brand.dbaName;
  const t2 = await build('KY', noEntity, 'someOtherTenantUid', 'Oaks Roofing').catch((e) => 'ERR ' + e.message);
  ok('a tenant with no entityName keeps its own legalName as seller (KY statement and both notices)',
    count(t2, 'send a telegram, to Oaks Roofing, at ') === 2 && t2.includes(KyLaw.KY_HSSA_TEXT + ' Oaks Roofing ' + H.BIZ_ADDR) && !/No Big Deal|NBD|Joe Deal/.test(t2), String(t2).slice(0, 200));

  pdfLib.PDFPage.prototype.drawText = orig;

  // Flag off (no clauseSet): the goldens, untouched.
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clause-set-v1-golden.json'), 'utf8'));
  const now = await H.goldens();
  const keys = Object.keys(golden).filter((k) => /^esignPdf/.test(k));
  ok('flag off: three PDF goldens are checked', keys.length === 3);
  keys.forEach((k) => ok('flag off: ' + k + ' is byte-identical', now[k] === golden[k]));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
