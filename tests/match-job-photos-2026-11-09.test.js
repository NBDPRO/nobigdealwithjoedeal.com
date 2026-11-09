/**
 * tests/match-job-photos-2026-11-09.test.js
 *
 * Guards scripts/lib/photo-match.js, the pure scoring core of
 * scripts/match-job-photos.js (plan: documentation/projects/
 * CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md section 1).
 *
 * The rule worth pinning: a photo is NEVER matched on a street name alone.
 * Street names repeat across towns and personal photos can sit on a customer's
 * street, so a street hit needs a date in the job window or GPS near the lead.
 *
 * Pure-Node. Run: node tests/match-job-photos-2026-11-09.test.js
 */
'use strict';
const assert = require('assert');
const M = require('../scripts/lib/photo-match.js');

let n = 0;
function t(name, fn) { fn(); n++; }

const lead = {
  id: 'L1', address: '1004 Larkspur Dr, Maineville, OH 45039', lat: 39.3, lng: -84.25,
  stageDates: { contract_signed: '2026-03-01', install_in_progress: '2026-03-10', install_complete: '2026-03-12' }
};

t('addrKey keeps number plus first street word(s)', () => {
  assert.strictEqual(M.addrKey('1004 Larkspur Dr, Maineville, OH 45039'), '1004 larkspur dr');
  assert.strictEqual(M.addrKey('Maineville, OH 45039'), '');
  assert.strictEqual(M.addrKey('Address unknown'), '');
});

t('haversine is ~0 for the same point and ~111km per degree of latitude', () => {
  assert.ok(M.distanceM(39, -84, 39, -84) < 0.01);
  const d = M.distanceM(39, -84, 40, -84);
  assert.ok(d > 110000 && d < 112000);
});

t('phase: before / during / after the install window', () => {
  const w = M.jobWindow(lead.stageDates);
  assert.strictEqual(M.phaseFor('2026-03-01T10:00:00Z', w), 'before');
  assert.strictEqual(M.phaseFor('2026-03-11T10:00:00Z', w), 'during');
  assert.strictEqual(M.phaseFor('2026-03-13T10:00:00Z', w), 'after');
  assert.strictEqual(M.phaseFor('2026-09-01T10:00:00Z', w), null, 'far outside the window is no phase');
  assert.strictEqual(M.phaseFor('2025-12-01T10:00:00Z', w), null);
});

t('a lead with no usable dates has no window, so nothing is date-matched', () => {
  assert.strictEqual(M.jobWindow({}), null);
  assert.strictEqual(M.phaseFor('2026-03-11T10:00:00Z', null), null);
});

t('street key alone never matches (no date, no GPS)', () => {
  const photo = { path: 'D:/IMG/1004 Larkspur Dr roof.jpg', takenAt: null, lat: null, lng: null };
  assert.strictEqual(M.scorePhoto(photo, lead), null);
});

t('street key plus a date far outside the window never matches', () => {
  const photo = { path: 'D:/IMG/1004 Larkspur Dr roof.jpg', takenAt: '2026-09-01T10:00:00Z', lat: null, lng: null };
  assert.strictEqual(M.scorePhoto(photo, lead), null);
});

t('date inside the window alone never matches (no street, no GPS)', () => {
  const photo = { path: 'D:/IMG/IMG_0001.jpg', takenAt: '2026-03-11T10:00:00Z', lat: null, lng: null };
  assert.strictEqual(M.scorePhoto(photo, lead), null);
});

t('street key plus date in window is medium', () => {
  const photo = { path: 'D:/IMG/1004 Larkspur Dr roof.jpg', takenAt: '2026-03-11T10:00:00Z', lat: null, lng: null };
  const r = M.scorePhoto(photo, lead);
  assert.strictEqual(r.confidence, 'medium');
  assert.strictEqual(r.phase, 'during');
});

t('GPS within 75m plus date in window is high', () => {
  const photo = { path: 'IMG_1.heic', takenAt: '2026-03-11T10:00:00Z', lat: 39.30010, lng: -84.25010 };
  const r = M.scorePhoto(photo, lead);
  assert.strictEqual(r.confidence, 'high');
  assert.ok(r.distanceM < 75);
});

t('GPS near but date outside the window is low, with no phase', () => {
  const photo = { path: 'IMG_1.heic', takenAt: '2025-01-01T10:00:00Z', lat: 39.30010, lng: -84.25010 };
  const r = M.scorePhoto(photo, lead);
  assert.strictEqual(r.confidence, 'low');
  assert.strictEqual(r.phase, null);
});

t('GPS 150m to 300m away does not match; same street name in another town does not match', () => {
  const far = { path: 'IMG.heic', takenAt: '2026-03-11T10:00:00Z', lat: 39.3030, lng: -84.25 };
  assert.strictEqual(M.scorePhoto(far, lead), null);
  const otherTown = { path: '1004 Larkspur Dr.jpg', takenAt: '2026-03-11T10:00:00Z', lat: 40.1, lng: -83.0 };
  assert.strictEqual(M.scorePhoto(otherTown, lead), null, 'GPS says it was shot elsewhere');
});

t('bestMatches returns the single best lead per photo and flags a tie', () => {
  const lead2 = { id: 'L2', address: '1006 Larkspur Dr, Maineville, OH', lat: 39.30012, lng: -84.25012, stageDates: lead.stageDates };
  const photo = { path: 'IMG.heic', takenAt: '2026-03-11T10:00:00Z', lat: 39.30011, lng: -84.25011 };
  const r = M.bestMatch(photo, [lead, lead2]);
  assert.strictEqual(r.ambiguous, true, 'two leads within range must be flagged for Jo');
  const one = M.bestMatch(photo, [lead]);
  assert.strictEqual(one.ambiguous, false);
  assert.strictEqual(one.leadId, 'L1');
  assert.strictEqual(M.bestMatch({ path: 'x.jpg' }, [lead]), null);
});

t('csv cells are quoted and spreadsheet formulas are neutralised', () => {
  assert.strictEqual(M.csvCell('a,b'), '"a,b"');
  assert.strictEqual(M.csvCell('say "hi"'), '"say ""hi"""');
  assert.ok(M.csvCell('=HYPERLINK("x")').startsWith('"\''), 'leading = is defused');
});

t('contact sheet is script-free and escapes every field', () => {
  const html = M.contactSheetHtml([{ file: '<img src=x onerror=alert(1)>.jpg', confidence: 'high', leadLabel: '<b>x</b>', phase: 'during', thumb: '' }]);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/\son\w+=/i.test(html.replace(/&lt;[^]*?&gt;/g, '')), 'no live event handlers');
  assert.ok(html.includes('&lt;img'));
});

t('summary counts carry no names or addresses', () => {
  const s = M.summarize([{ confidence: 'high', hasGps: true }, { confidence: 'low', hasGps: false }], 5, ['L1', 'L2'], ['L1']);
  assert.deepStrictEqual(s, { scanned: 5, withGps: 1, matched: 2, byConfidence: { high: 1, medium: 0, low: 1 }, jobsWithoutPhotos: 1 });
});

console.log(`match-job-photos: ${n} checks passed`);
