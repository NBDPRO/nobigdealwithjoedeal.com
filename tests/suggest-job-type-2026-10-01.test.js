/**
 * tests/suggest-job-type-2026-10-01.test.js — suggestJobType (crm-stages.js),
 * the "Sort my customers" suggester for leads with no job type. Inputs are
 * shaped like the real untyped customers (Thumbtack request notes with
 * "Category:" and "Insurance claim coverage:" segments), invented content.
 *
 * Run: node tests/suggest-job-type-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'docs/pro/js/crm-stages.js')).href);
  const sj = M.suggestJobType;
  const t = (lead) => { const s = sj(lead); return s ? s.type + '/' + s.strength : 'none'; };
  const tt = (cat, extra) => 'Thumbtack request · Zip code: 45000 · Category: ' + cat + ' · Property type: Home' + (extra ? ' · ' + extra : '');
  const NO_INS = 'Insurance claim coverage: No, the project is not covered by an insurance claim';

  console.log('\n1. Hard facts on file win');
  ok('carrier → insurance (strong)', t({ insCarrier: 'Example Mutual' }) === 'insurance/strong');
  ok('claim number → insurance', t({ claimNumber: 'C-1' }) === 'insurance/strong');
  ok('"No Claim" status is NOT a claim (the form default)', t({ claimStatus: 'No Claim' }) === 'none');
  ok('Claim Filed status → insurance', t({ claimStatus: 'Claim Filed' }) === 'insurance/strong');
  ok('adjuster stage → insurance', t({ stage: 'adjuster_meeting_scheduled' }) === 'insurance/strong');
  ok('loanAmount 0 is not a loan (8 real leads carry 0)', t({ loanAmount: 0 }) === 'none');
  ok('real loan → finance', t({ loanAmount: 18000 }) === 'finance/strong');
  ok('warranty claim → warranty', t({ openWarrantyClaimId: 'w1' }) === 'warranty/strong');
  ok('service stage → service', t({ stage: 'service_quoted' }) === 'service/strong');
  ok('cash estimate stage → cash', t({ stage: 'estimate_sent_cash' }) === 'cash/strong');
  ok('carrier beats a repair request', t({ insCarrier: 'X', notes: tt('Roof Repair or Maintenance') }) === 'insurance/strong');

  console.log('\n2. The request text');
  ok('Roof Repair + "not covered" → service', t({ notes: tt('Roof Repair or Maintenance', NO_INS) }) === 'service/likely');
  ok('  and the reason says why', /Not an insurance claim · Roof Repair or Maintenance/.test(sj({ notes: tt('Roof Repair or Maintenance', NO_INS) }).reason));
  ok('Drywall repair → service', t({ notes: tt('Drywall Repair and Texturing') }) === 'service/likely');
  ok('Gutter Cleaning → service', t({ notes: tt('Gutter Cleaning and Maintenance') }) === 'service/likely');
  ok('Siding Installation → cash', t({ notes: tt('Siding Installation') }) === 'cash/likely');
  ok('Gutter Installation or Replacement → cash', t({ notes: tt('Gutter Installation or Replacement') }) === 'cash/likely');
  ok('"repair or replace" stays a repair', t({ notes: tt('Shingles repair or replacement') }) === 'service/likely');
  ok('damageType alone: Reroofing → cash', t({ damageType: 'Reroofing' }) === 'cash/likely');
  ok('damageType alone: Gutter Repair → service', t({ damageType: 'Gutter Repair' }) === 'service/likely');
  ok('the Category line beats words elsewhere in the notes', t({ notes: tt('Siding Repair', 'Anything else: we might replace windows later') }) === 'service/likely');
  ok('HTML-escaped apostrophes do not break parsing', t({ notes: tt('Roof Repair', 'Current roof age: I&#039;m not sure') }) === 'service/likely');

  console.log('\n3. Insurance from the words');
  ok('"will be an insurance claim" → insurance', t({ notes: 'Fascia replaced. This will be an insurance claim so I am getting estimates.' }) === 'insurance/likely');
  ok('wind damage → insurance', t({ damageType: 'Roof - Wind' }) === 'insurance/likely');
  ok('tree hit the roof → insurance', t({ notes: 'tree branch hit roof and car' }) === 'insurance/likely');
  ok('storm words but "not covered" → not insurance', t({ damageType: 'Roof - Wind', notes: tt('Roof Repair', NO_INS) }) === 'service/likely');
  ok('"Insurance claim: not covered" alone → cash', t({ notes: 'Insurance claim: not covered' }) === 'cash/likely');

  console.log('\n4. Price, then nothing');
  ok('$12,000 job, no other clue → cash', t({ jobValue: 12000 }) === 'cash/likely');
  ok('$400 job → service', t({ jobValue: 400 }) === 'service/likely');
  ok('$3,000 job alone → no guess', t({ jobValue: 3000 }) === 'none');
  ok('nothing at all → null (your call)', sj({ stage: 'new', notes: 'Called, left voicemail.' }) === null);
  ok('null lead → null', sj(null) === null);

  console.log('\n5. Shape');
  const s = sj({ notes: tt('Gutter Repair') });
  ok('returns {type, reason, strength}', s && typeof s.reason === 'string' && s.reason.length > 0 && ['strong', 'likely'].includes(s.strength));
  ok('every suggested type is a real job type', ['insurance', 'cash', 'finance', 'warranty', 'service'].every((k) => M.JOB_TYPE_META[k]));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
