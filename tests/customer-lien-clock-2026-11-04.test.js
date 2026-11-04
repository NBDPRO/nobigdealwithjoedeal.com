/**
 * tests/customer-lien-clock-2026-11-04.test.js — the dark internal lien card.
 * Flag absent = nothing renders; KY insurance = suppression line, no inputs;
 * the page script is loaded exactly once and nothing inline is added.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LC = require('../docs/pro/js/lien-clock.js');
const C = require('../docs/pro/js/customer-lien-clock.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok  ' + name); }
const NOW = new Date(2026, 3, 20); // 2026-04-20 local
const opts = (o) => Object.assign({ flagOn: true, LienClock: LC, now: NOW }, o);

t('flag off (absent) renders nothing', () => {
  assert.strictEqual(C.buildModel({ address: '1 A St, Mason, OH 45040', lienLastWorkDate: '2026-03-01' }, opts({ flagOn: false })), null);
  assert.strictEqual(C.buildModel(null, opts()), null);
});

t('state comes from lead.state, then the address; anything else is unsupported', () => {
  assert.strictEqual(C.stateOf({ state: 'ky' }), 'KY');
  assert.strictEqual(C.stateOf({ address: '5 B Rd, Florence, KY 41042' }), 'KY');
  assert.strictEqual(C.stateOf({ address: '5 B Rd, Cincinnati, Ohio 45202' }), 'OH');
  assert.strictEqual(C.stateOf({ address: 'somewhere' }), '');
  const m = C.buildModel({ address: 'somewhere' }, opts());
  assert.strictEqual(m.clock.supported, false);
});

t('Ohio lead with a last-work date shows the affidavit step with exact dates', () => {
  const m = C.buildModel({ address: '1 A St, Mason, OH 45040', lienLastWorkDate: '2026-03-01' }, opts());
  assert.strictEqual(m.clock.steps[0].deadline, '2026-04-30');
  const h = C.html(m);
  assert.ok(h.includes('2026-04-29') && h.includes('2026-04-30') && /verify with counsel/i.test(h));
  assert.ok(h.includes('id="nlcSave"') && h.includes('type="date"'));
});

t('Kentucky insurance job: suppression line, no date inputs, no countdown', () => {
  const m = C.buildModel({ state: 'KY', jobType: 'insurance', lienLastWorkDate: '2026-03-01' }, opts());
  assert.strictEqual(m.clock.suppressed, true);
  const h = C.html(m);
  assert.ok(/367\.628\(2\)\(g\)/.test(h));
  assert.ok(!h.includes('nlcSave') && !h.includes('type="date"'));
});

t('insurance detection matches the customer page (claim number, carrier, claim status)', () => {
  assert.strictEqual(C.isInsuranceJob({ claimNumber: 'X1' }), true);
  assert.strictEqual(C.isInsuranceJob({ insCarrier: 'Acme' }), true);
  assert.strictEqual(C.isInsuranceJob({ claimStatus: 'Filed' }), true);
  assert.strictEqual(C.isInsuranceJob({ claimStatus: 'No Claim' }), false);
  assert.strictEqual(C.isInsuranceJob({}), false);
});

t('bad stored dates are ignored, never rendered into a value', () => {
  const m = C.buildModel({ state: 'OH', lienLastWorkDate: '<img onerror=x>' }, opts());
  assert.strictEqual(m.last, '');
  assert.ok(!C.html(m).includes('<img'));
});

t('wired once into customer.html, deferred, no inline script', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/customer.html'), 'utf8');
  const tags = page.match(/<script[^>]*customer-lien-clock\.js[^>]*>/g) || [];
  assert.strictEqual(tags.length, 1);
  assert.ok(/defer/.test(tags[0]));
  const lc = page.match(/<script[^>]*js\/lien-clock\.js[^>]*>/g) || [];
  assert.strictEqual(lc.length, 1);
  assert.ok(page.indexOf('js/lien-clock.js') < page.indexOf('js/customer-lien-clock.js'));
});

console.log('customer-lien-clock: ' + n + ' passed');
