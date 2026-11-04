/**
 * tests/lien-clock-2026-11-04.test.js — the internal lien clock (planning aid,
 * not legal advice; dates are verified with counsel before use).
 * Expected dates are written out by hand, never computed by the module.
 */
'use strict';
const assert = require('assert');
const L = require('../docs/pro/js/lien-clock.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ok  ' + name); }
const byKey = (r, k) => r.steps.find(s => s.key === k);

t('Ohio: affidavit due 60 days after last work, work-by one day earlier', () => {
  const r = L.compute({ state: 'OH', lastWorkDate: '2026-03-01', today: '2026-03-02' });
  const s = byKey(r, 'oh-affidavit');
  assert.strictEqual(s.deadline, '2026-04-30');
  assert.strictEqual(s.workBy, '2026-04-29');
  assert.strictEqual(r.steps.length, 1);
  assert.deepStrictEqual(s.reminders.map(x => x.on), ['2026-04-08', '2026-04-22']);
});

t('Ohio: once filed, serve in 30 days and lien life is 6 years; affidavit step is gone', () => {
  const r = L.compute({ state: 'OH', lastWorkDate: '2026-03-01', filedDate: '2026-04-10', today: '2026-04-11' });
  assert.strictEqual(byKey(r, 'oh-affidavit'), undefined);
  assert.strictEqual(byKey(r, 'oh-serve').deadline, '2026-05-10');
  assert.strictEqual(byKey(r, 'oh-lien-life').deadline, '2032-04-10');
});

t('Kentucky: statement 6 months from last work, clamped to month end', () => {
  const r = L.compute({ state: 'KY', lastWorkDate: '2026-08-31', today: '2026-09-01' });
  assert.strictEqual(byKey(r, 'ky-statement').deadline, '2027-02-28');
  const leap = L.compute({ state: 'KY', lastWorkDate: '2027-08-31', today: '2027-09-01' });
  assert.strictEqual(byKey(leap, 'ky-statement').deadline, '2028-02-29');
});

t('Kentucky: filed, mail in 7 days and sue within 12 months', () => {
  const r = L.compute({ state: 'KY', lastWorkDate: '2026-03-01', filedDate: '2026-05-20', today: '2026-05-21' });
  assert.strictEqual(byKey(r, 'ky-mail').deadline, '2026-05-27');
  assert.strictEqual(byKey(r, 'ky-sue').deadline, '2027-05-20');
});

t('Kentucky insurance job: suppressed, no steps at all (KRS 367.628(2)(g))', () => {
  const r = L.compute({ state: 'KY', isInsurance: true, lastWorkDate: '2026-03-01', today: '2026-03-02' });
  assert.strictEqual(r.suppressed, true);
  assert.strictEqual(r.steps.length, 0);
  assert.ok(/367\.628\(2\)\(g\)/.test(r.reason));
});

t('Ohio insurance job is NOT suppressed (the rule is Kentucky\'s)', () => {
  const r = L.compute({ state: 'OH', isInsurance: true, lastWorkDate: '2026-03-01', today: '2026-03-02' });
  assert.strictEqual(r.suppressed, false);
  assert.strictEqual(r.steps.length, 1);
});

t('status: passed, urgent (7 days or less), upcoming', () => {
  const base = { state: 'OH', lastWorkDate: '2026-03-01' }; // deadline 2026-04-30
  assert.strictEqual(byKey(L.compute({ ...base, today: '2026-05-01' }), 'oh-affidavit').status, 'passed');
  assert.strictEqual(byKey(L.compute({ ...base, today: '2026-04-23' }), 'oh-affidavit').status, 'urgent');
  assert.strictEqual(byKey(L.compute({ ...base, today: '2026-04-22' }), 'oh-affidavit').status, 'upcoming');
  assert.strictEqual(byKey(L.compute({ ...base, today: '2026-04-30' }), 'oh-affidavit').status, 'urgent');
});

t('bad input never invents a date', () => {
  assert.strictEqual(L.compute({ state: 'OH' }).steps.length, 0);
  assert.strictEqual(L.compute({ state: 'OH', lastWorkDate: '2026-02-30' }).steps.length, 0);
  assert.strictEqual(L.compute({ state: 'OH', lastWorkDate: 'soon' }).steps.length, 0);
  assert.strictEqual(L.compute({ state: 'IN', lastWorkDate: '2026-03-01' }).supported, false);
  assert.strictEqual(L.compute().steps.length, 0);
  assert.ok(L.compute({ state: 'OH' }).reason.length > 0);
});

t('every result carries the verify-with-counsel disclaimer', () => {
  assert.ok(/counsel/i.test(L.compute({ state: 'OH', lastWorkDate: '2026-03-01' }).disclaimer));
  assert.ok(/counsel/i.test(L.compute({ state: 'IN' }).disclaimer));
});

console.log('lien-clock: ' + n + ' passed');
