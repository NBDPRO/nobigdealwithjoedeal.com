/**
 * tests/sec-photo-path-confinement-2026-10-06.test.js
 *
 * Follow-up to review R3-2 / R3-3 (2026-10-06, nbd-content/review-r3-2026-10-06.md).
 *
 * A /photos doc is client-written, and until this change its storagePath /
 * thumbStoragePath / path could name ANY object in the bucket. Four servers
 * then read that object with the admin SDK, which ignores storage.rules:
 *
 *   reel-studio  resolveClips   downloads it into a reel the caller watches
 *   social-studio leadPhotos     downloads it and publishes it
 *   money-paper  plateFor        signs it for the invoice PDF's photo plate
 *   tenant-ops   buildCompanyExport  signs it for 24h in the export zip
 *
 * Each now requires the object to sit in the photo's OWN upload folder
 * (lead-artifact-paths isPhotoObjectOf): photos/{userId}/..., or
 * homeowner-uploads/{userId}/{leadId}/... for portal / web-form uploads.
 * deal-packet-logic checkPacketPhoto already confined to photos/{ownerUid}/;
 * it is pinned here as a control so it stays that way.
 *
 * The rules half (create + update) is firestore-rules.cross-tenant.test.js §D3.
 *
 * Pure Node with in-memory fakes, no emulator. Needs functions/ deps.
 * Run: node tests/sec-photo-path-confinement-2026-10-06.test.js
 */
'use strict';

const path = require('path');

// reel-studio's storage trigger needs a bucket name at definition time.
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-photo-paths', storageBucket: 'demo-photo-paths.appspot.com' });
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-photo-paths';

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const LAP = require(path.join(FN, 'lead-artifact-paths.js'));
const MPL = require(path.join(FN, 'money-paper-logic.js'));
const DPL = require(path.join(FN, 'deal-packet-logic.js'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  — ' + detail : '')); }
}

// Minimal Firestore fake: doc(path).get(), collection(c).where(f,'==',v).limit(n).get().
function fakeDb(data) {
  const store = new Map(Object.entries(data));
  const snapOf = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p) });
  function query(coll, filters) {
    return {
      where(f, op, v) { return query(coll, filters.concat([[f, v]])); },
      limit() { return this; },
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          const parts = k.split('/');
          if (parts.length !== 2 || parts[0] !== coll) continue;
          if (filters.every(([f, val]) => v[f] === val)) docs.push(snapOf(k));
        }
        return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  return {
    doc: (p) => ({ get: async () => snapOf(p) }),
    collection: (c) => query(c, []),
  };
}

const VICTIM_OBJ = 'pdf-renders/victimUid/1700000000000-contract.pdf';

// ─── isPhotoObjectOf ──────────────────────────────────────────────────────
console.log('isPhotoObjectOf');
{
  const f = LAP.isPhotoObjectOf;
  const ph = { userId: 'bob', leadId: 'leadB' };
  ok('own photos/ object', f('photos/bob/leadB/a.jpg', ph));
  ok('own flat photos/ object', f('photos/bob/a.jpg', ph));
  ok('own homeowner-uploads/{uid}/{lead}/ object', f('homeowner-uploads/bob/leadB/1.jpg', ph));
  ok('refuses another uid\'s photos/', !f('photos/alice/leadA/a.jpg', ph));
  ok('refuses a uid that is a prefix of another (photos/bo/...)', !f('photos/bobby/x.jpg', ph));
  ok('refuses contracts / renders / recordings', !f(VICTIM_OBJ, ph) && !f('calls/bob/x.mp3', ph) && !f('documents/bob/leadB/x.pdf', ph));
  ok('refuses homeowner-uploads of another lead', !f('homeowner-uploads/bob/leadOther/1.jpg', ph));
  ok('refuses homeowner-uploads of another owner', !f('homeowner-uploads/alice/leadB/1.jpg', ph));
  ok('refuses .. and // and \\', !f('photos/bob/../alice/a.jpg', ph) && !f('photos/bob//a.jpg', ph) && !f('photos/bob/a\\b.jpg', ph));
  ok('refuses a photo with no userId', !f('photos/bob/a.jpg', { leadId: 'leadB' }));
  ok('refuses empty / non-string', !f('', ph) && !f(null, ph) && !f(42, ph));
}

// ─── deal-packet (control: already confined) ──────────────────────────────
console.log('deal-packet checkPacketPhoto (control)');
{
  const ctx = { ownerUid: 'bob', leadId: 'leadB' };
  ok('own photo passes', DPL.checkPacketPhoto({ userId: 'bob', leadId: 'leadB', storagePath: 'photos/bob/leadB/a.jpg' }, ctx).ok === true);
  ok('foreign storagePath refused', DPL.checkPacketPhoto({ userId: 'bob', leadId: 'leadB', storagePath: VICTIM_OBJ }, ctx).ok === false);
}

// ─── money-paper plate ────────────────────────────────────────────────────
console.log('money-paper platePhotosForLead');
{
  const lead = { userId: 'bob', companyId: 'co-b' };
  const photos = [
    { id: 'own', userId: 'bob', companyId: 'co-b', leadId: 'L', storagePath: 'photos/bob/L/a.jpg', phase: 'After', createdAt: 1 },
    { id: 'planted', userId: 'bob', companyId: 'co-b', leadId: 'L', storagePath: VICTIM_OBJ, phase: 'After', createdAt: 9 },
    { id: 'planted-path', userId: 'bob', companyId: 'co-b', leadId: 'L', path: VICTIM_OBJ, phase: 'After', createdAt: 8 },
    { id: 'other-tenant', userId: 'eve', companyId: 'co-x', leadId: 'L', storagePath: 'photos/eve/L/b.jpg', phase: 'After', createdAt: 10 },
    { id: 'teammate', userId: 'dan', companyId: 'co-b', leadId: 'L', storagePath: 'photos/dan/L/c.jpg', phase: 'Before', createdAt: 2 },
    { id: 'ho', userId: 'bob', companyId: 'co-b', leadId: 'L', source: 'homeowner', path: 'homeowner-uploads/bob/L/1.jpg', phase: 'During', createdAt: 3 },
    { id: 'url-own', userId: 'bob', leadId: 'L', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/photos%2Fbob%2FL%2Fu.jpg?alt=media', phase: 'Before' },
    { id: 'url-foreign', userId: 'bob', leadId: 'L', url: 'https://evil.example/x.jpg', phase: 'Before' },
  ];
  const kept = MPL.platePhotosForLead(lead, photos).map((p) => p.id).sort();
  ok('keeps own, teammate (same company), homeowner, own-url photos', ['ho', 'own', 'teammate', 'url-own'].every((id) => kept.includes(id)), kept.join(','));
  ok('drops a planted storagePath and a planted path', !kept.includes('planted') && !kept.includes('planted-path'));
  ok('drops another tenant\'s photo on the lead', !kept.includes('other-tenant'));
  ok('drops a url that is not an own Storage object', !kept.includes('url-foreign'));
  const pick = MPL.pickPlatePhoto(lead, MPL.platePhotosForLead(lead, photos));
  ok('plate = newest own After photo, not the planted newer one', pick && pick.id === 'own', pick && pick.id);
  ok('cover photo pointing at a planted doc is ignored', MPL.pickPlatePhoto({ ...lead, coverPhotoId: 'planted' }, MPL.platePhotosForLead(lead, photos)).id === 'own');
}

// Source guard: plateFor filters BEFORE it picks and signs.
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(FN, 'money-paper.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const at = src.indexOf('async function plateFor(');
  const body = at === -1 ? '' : src.slice(at, src.indexOf('\n}', at));
  const iFilter = body.indexOf('P.platePhotosForLead(');
  const iPick = body.indexOf('P.pickPlatePhoto(');
  const iSign = body.indexOf('getSignedUrl(');
  ok('plateFor: picks from platePhotosForLead(...) and signs after', iFilter !== -1 && iPick !== -1 && iSign !== -1
    && /P\.pickPlatePhoto\(\s*lead\s*,\s*P\.platePhotosForLead\(/.test(body) && iSign > iFilter);
}

(async () => {
  let RS = null, SS = null, TO = null;
  try {
    RS = require(path.join(FN, 'reel-studio.js'))._test;
    SS = require(path.join(FN, 'social-studio.js'))._test;
    TO = require(path.join(FN, 'tenant-ops.js'))._test;
  } catch (e) {
    console.log('  FAIL functions deps missing: ' + e.message.split('\n')[0]);
    fail++;
  }

  if (RS) {
    console.log('reel-studio resolveClips');
    const lead = { userId: 'bob', companyId: 'co-b' };
    const db = fakeDb({
      'photos/good': { userId: 'bob', companyId: 'co-b', leadId: 'L', storagePath: 'photos/bob/L/a.jpg' },
      'photos/ho': { userId: 'bob', companyId: 'co-b', leadId: 'L', source: 'homeowner', path: 'homeowner-uploads/bob/L/1.jpg' },
      'photos/foreignPhotos': { userId: 'bob', companyId: 'co-b', leadId: 'L', storagePath: 'photos/victimUid/V/secret.jpg' },
      'photos/foreignHo': { userId: 'bob', companyId: 'co-b', leadId: 'L', path: 'homeowner-uploads/victimUid/V/1.jpg' },
    });
    const run = async (id) => {
      try { return await RS.resolveClips(db, 'co-b', 'bob', 'L', lead, [{ source: 'job_photo', photoId: id }]); }
      catch (e) { return e; }
    };
    const g = await run('good');
    ok('own photo resolves', Array.isArray(g) && g[0].storagePath === 'photos/bob/L/a.jpg', g && g.message);
    const h = await run('ho');
    ok('own homeowner upload resolves', Array.isArray(h) && h[0].storagePath === 'homeowner-uploads/bob/L/1.jpg', h && h.message);
    const f1 = await run('foreignPhotos');
    ok('photo naming another uid\'s photos/ object is refused', f1 instanceof Error && /not part of this job/.test(f1.message));
    const f2 = await run('foreignHo');
    ok('photo naming another owner\'s homeowner-uploads/ is refused', f2 instanceof Error && /not part of this job/.test(f2.message));
  }

  if (SS) {
    console.log('social-studio leadPhotos');
    const lead = { userId: 'bob', companyId: 'co-b' };
    const db = fakeDb({
      'photos/good': { userId: 'bob', companyId: 'co-b', leadId: 'L', storagePath: 'photos/bob/L/a.jpg' },
      'photos/web': { userId: 'bob', companyId: 'co-b', leadId: 'L', source: 'web_form', path: 'homeowner-uploads/bob/L/web-1.jpg' },
      'photos/planted': { userId: 'bob', companyId: 'co-b', leadId: 'L', storagePath: 'photos/victimUid/V/secret.jpg' },
    });
    const ids = (await SS.leadPhotos(db, 'L', lead, { companyId: 'co-b', uid: 'bob' })).map((p) => p.id).sort();
    ok('own + web-form photos listed', ids.includes('good') && ids.includes('web'), ids.join(','));
    ok('photo naming another uid\'s object is not listed', !ids.includes('planted'));
  }

  if (TO) {
    console.log('tenant-ops buildCompanyExport');
    const db = fakeDb({
      'companies/co-a': { name: 'Oaks Roofing', ownerId: 'oak' },
      'photos/own': { companyId: 'co-a', userId: 'oak', leadId: 'L', storagePath: 'photos/oak/L/1.jpg' },
      'photos/planted': { companyId: 'co-a', userId: 'oak', leadId: 'L', storagePath: VICTIM_OBJ },
    });
    const signedFor = [];
    const bucket = { file: (p) => ({ getSignedUrl: async () => { signedFor.push(p); return ['https://storage.googleapis.com/signed?X-Goog-Expires=86400']; } }) };
    let out = null;
    try { out = await TO.buildCompanyExport(db, bucket, 'co-a', { now: new Date('2026-10-06T00:00:00Z') }); }
    catch (e) { ok('buildCompanyExport runs', false, e.message); }
    if (out) {
      ok('own photo is signed', signedFor.includes('photos/oak/L/1.jpg'), signedFor.join(','));
      ok('planted foreign path is NOT signed', !signedFor.includes(VICTIM_OBJ), signedFor.join(','));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
