/**
 * tests/upload-job-photos-2026-11-10.test.js
 *
 * Guards scripts/lib/photo-upload.js, the pure core of scripts/upload-job-photos.js
 * (files approved job-site photos into the CRM as /photos docs). Plan:
 * documentation/projects/CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md section 1.
 *
 * What is pinned:
 *   - the doc id is stable (a rerun never makes a second gallery entry);
 *   - the doc has the shape docs/pro/js/photo-engine.js writes, plus source 'photo-match';
 *   - a lead in another company, a missing lead, or a missing file is skipped, never guessed;
 *   - an id that already exists is skipped (never overwritten, so rep edits survive).
 *
 * Pure-Node. Run: node tests/upload-job-photos-2026-11-10.test.js
 */
'use strict';
const assert = require('assert');
const U = require('../scripts/lib/photo-upload.js');

let n = 0;
function t(name, fn) { fn(); n++; }

t('photoId is stable and differs per file', () => {
  const a = U.photoIdFor('L1', 'IMG_0001.heic');
  assert.strictEqual(a, U.photoIdFor('L1', 'IMG_0001.heic'));
  assert.notStrictEqual(a, U.photoIdFor('L1', 'IMG_0002.heic'));
  assert.notStrictEqual(a, U.photoIdFor('L2', 'IMG_0001.heic'));
  assert.ok(/^pm_[a-f0-9]{20}$/.test(a));
});

t('paths live under photos/{uid}/{leadId}/ like the app', () => {
  const p = U.buildPaths('U1', 'L1', 'pm_abc');
  assert.strictEqual(p.photoPath, 'photos/U1/L1/pm_abc_standard.jpg');
  assert.strictEqual(p.thumbPath, 'photos/U1/L1/thumbs/pm_abc_thumb.jpg');
});

t('doc carries the engine shape plus source photo-match', () => {
  const d = U.buildPhotoDoc({
    id: 'pm_abc', leadId: 'L1', uid: 'U1', companyId: 'C1',
    url: 'https://x/p', thumbUrl: 'https://x/t', phase: 'during',
    takenAt: '2026-05-06T16:30:43.000Z', lat: 39.1, lng: -84.3, fileSize: 1234,
    lead: { lat: 39.1, lng: -84.3 }
  });
  assert.strictEqual(d.source, 'photo-match');
  assert.strictEqual(d.leadId, 'L1');
  assert.strictEqual(d.userId, 'U1');
  assert.strictEqual(d.companyId, 'C1');
  assert.strictEqual(d.phase, 'during');
  assert.strictEqual(d.phaseSource, 'stage');
  assert.strictEqual(d.capturedAt, Date.parse('2026-05-06T16:30:43.000Z'));
  assert.strictEqual(d.capturedAtSource, 'exif');
  assert.deepStrictEqual(d.tags, []);
  assert.deepStrictEqual(d.reportSections, []);
  assert.strictEqual(d.storagePath, 'photos/U1/L1/pm_abc_standard.jpg');
  assert.strictEqual(d.thumbStoragePath, 'photos/U1/L1/thumbs/pm_abc_thumb.jpg');
  assert.strictEqual(d.geoLocation.source, 'exif');
  assert.strictEqual(d.onSite, true);
  assert.ok(!('createdAt' in d), 'timestamps are added by the caller with the server clock');
});

t('phase outside before/during/after becomes null, never a guess', () => {
  const d = U.buildPhotoDoc({ id: 'i', leadId: 'L', uid: 'U', url: 'u', thumbUrl: 't', phase: 'weird', takenAt: '2026-01-01T00:00:00Z' });
  assert.strictEqual(d.phase, null);
  assert.strictEqual(d.phaseSource, null);
});

t('no companyId means the field is absent, not null', () => {
  const d = U.buildPhotoDoc({ id: 'i', leadId: 'L', uid: 'U', url: 'u', thumbUrl: 't', phase: 'before', takenAt: '2026-01-01T00:00:00Z' });
  assert.ok(!('companyId' in d));
});

t('no GPS means geoLocation null and onSite null', () => {
  const d = U.buildPhotoDoc({ id: 'i', leadId: 'L', uid: 'U', url: 'u', thumbUrl: 't', phase: 'before', takenAt: '2026-01-01T00:00:00Z' });
  assert.strictEqual(d.geoLocation, null);
  assert.strictEqual(d.onSite, null);
});

const rows = [
  { lead_id: 'L1', source: 'a.heic', jpeg: 'a.jpg', thumb: 'a_t.jpg', phase: 'during', taken_at: '2026-05-06T00:00:00Z', bytes: 100 },
  { lead_id: 'L1', source: 'b.heic', jpeg: 'b.jpg', thumb: 'b_t.jpg', phase: 'during', taken_at: '2026-05-06T00:00:00Z', bytes: 100 },
  { lead_id: 'LX', source: 'c.heic', jpeg: 'c.jpg', thumb: 'c_t.jpg', phase: 'during', taken_at: '2026-05-06T00:00:00Z', bytes: 100 },
  { lead_id: 'L2', source: 'd.heic', jpeg: 'd.jpg', thumb: 'd_t.jpg', phase: 'during', taken_at: '2026-05-06T00:00:00Z', bytes: 100 },
  { lead_id: 'L1', source: 'e.heic', jpeg: 'MISSING.jpg', thumb: 'e_t.jpg', phase: 'during', taken_at: '2026-05-06T00:00:00Z', bytes: 100 }
];
const leads = { L1: { uid: 'U1', companyId: 'C1' }, L2: { uid: 'U2', companyId: 'OTHER' } };
const exists = (p) => p !== 'MISSING.jpg';

t('plan skips unknown lead, other company, missing file; counts the rest', () => {
  const p = U.planUpload(rows, { leads, company: 'C1', fileExists: exists, existingIds: new Set() });
  assert.strictEqual(p.toUpload.length, 2);
  assert.strictEqual(p.skipped.noLead, 1);
  assert.strictEqual(p.skipped.otherCompany, 1);
  assert.strictEqual(p.skipped.missingFile, 1);
  assert.strictEqual(p.toUpload[0].id, U.photoIdFor('L1', 'a.heic'));
});

t('plan skips an id that already exists (rerun is safe, nothing overwritten)', () => {
  const have = new Set([U.photoIdFor('L1', 'a.heic')]);
  const p = U.planUpload(rows, { leads, company: 'C1', fileExists: exists, existingIds: have });
  assert.strictEqual(p.toUpload.length, 1);
  assert.strictEqual(p.skipped.alreadyThere, 1);
});

t('plan refuses to run without a company', () => {
  assert.throws(() => U.planUpload(rows, { leads, company: '', fileExists: exists, existingIds: new Set() }), /company/);
});

t('summary is counts only (no ids, names or paths)', () => {
  const p = U.planUpload(rows, { leads, company: 'C1', fileExists: exists, existingIds: new Set() });
  const s = U.summarizePlan(p);
  assert.deepStrictEqual(Object.keys(s).sort(), ['bytes', 'jobs', 'skipped', 'toUpload']);
  assert.strictEqual(s.toUpload, 2);
  assert.strictEqual(s.jobs, 1);
});

console.log('upload-job-photos: ' + n + ' checks passed');
