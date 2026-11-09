/**
 * Firestore rules - /photos create with the EXIF capture fields (2026-11-09).
 *
 * Every upload path now writes capturedAt (epoch ms), capturedAtSource,
 * deviceCapturedAt and geoLocation ({lat, lng, accuracy: null, at, source:
 * 'exif'}) from the photo's own EXIF (docs/pro/js/photo-exif.js). The /photos
 * create rule has no field allowlist, so no rule change: this suite proves the
 * three real doc shapes (PhotoEngine setDoc, customer-page addDoc, dashboard
 * modal addDoc) still create for the writers who could create them before,
 * and that the rule's own checks still bite with the new fields present
 * (viewer, another uid, a foreign object path, a lead in another tenant).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-photoexif-test \
 *     'node firestore-rules.photo-exif-fields.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-photoexif-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
  }
}

const results = [];
async function check(label, expect, promise) {
  try {
    if (expect === 'deny') await assertFails(promise); else await assertSucceeds(promise);
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 160) });
  }
}

async function run() {
  const hostPort = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: hostPort.split(':')[0], port: Number(hostPort.split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const solo = ctx('co-a', {});
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const rep = ctx('rep1', { role: 'sales_rep', companyId: 'co-a' });
  const vera = ctx('vera', { role: 'viewer', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });
  const { setDoc, addDoc, collection, doc, serverTimestamp } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'leads/L1'), { companyId: 'co-a', userId: 'co-a', stage: 'install_complete' });
    await setDoc(doc(f, 'leads/LR'), { companyId: 'co-a', userId: 'rep1', stage: 'install_complete' });
  });

  const TAKEN = Date.UTC(2026, 4, 13, 13, 24, 30);
  const exif = { capturedAt: TAKEN, capturedAtSource: 'exif', deviceCapturedAt: TAKEN + 86400000,
    geoLocation: { lat: 39.1, lng: -84.5, accuracy: null, at: TAKEN, source: 'exif' } };
  // PhotoEngine.uploadPhotoToFirebase's setDoc (doc id = uploadId).
  const engineDoc = (uid, leadId, extra) => Object.assign({
    id: 'P', leadId, userId: uid, companyId: 'co-a', url: 'https://dl.example/x',
    storagePath: 'photos/' + uid + '/' + leadId + '/u_standard.jpg', thumbStoragePath: 'photos/' + uid + '/' + leadId + '/thumbs/u_thumb.jpg',
    thumbUrl: 'https://dl.example/t', tags: [], phase: 'After', phaseSource: 'stage', description: '', location: '', quality: 'standard',
    width: 'auto', height: 'auto', fileSize: 10, createdAt: serverTimestamp(), uploadedAt: serverTimestamp(), reportSections: [], onSite: true,
  }, exif, extra || {});
  // customer-bootstrap.module.js uploadSinglePhoto's addDoc.
  const customerDoc = (uid, leadId) => Object.assign({
    leadId, userId: uid, companyId: 'co-a', url: 'https://dl.example/x', storagePath: 'photos/' + uid + '/' + leadId + '_1_x.jpg',
    filename: 'IMG.JPG', size: 10, type: 'image/jpeg', createdAt: serverTimestamp(), date: serverTimestamp(), uploadedAt: serverTimestamp(),
    phase: null, category: 'Property', damageType: '', severity: '', location: '',
  }, exif);
  // dashboard-bootstrap.module.js _uploadPhoto's addDoc.
  const dashDoc = (uid, leadId) => Object.assign({
    leadId, url: 'https://dl.example/x', name: 'IMG.JPG', userId: uid, createdAt: serverTimestamp(),
    storagePath: 'photos/' + uid + '/' + leadId + '/1_IMG.JPG', companyId: 'co-a',
  }, exif);

  await check('PhotoEngine doc with the EXIF fields: solo owner CAN create', 'allow', setDoc(doc(solo, 'photos/P1'), engineDoc('co-a', 'L1')));
  await check('customer-page doc with the EXIF fields: solo owner CAN create', 'allow', addDoc(collection(solo, 'photos'), customerDoc('co-a', 'L1')));
  await check('dashboard-modal doc with the EXIF fields: solo owner CAN create', 'allow', addDoc(collection(solo, 'photos'), dashDoc('co-a', 'L1')));
  await check('device-clock answer (no EXIF): manager CAN create on a tenant lead', 'allow',
    setDoc(doc(mike, 'photos/P2'), engineDoc('mike', 'L1', { capturedAt: TAKEN, capturedAtSource: 'device', deviceCapturedAt: null, geoLocation: null })));
  await check('rep CAN create on their own lead', 'allow', addDoc(collection(rep, 'photos'), customerDoc('rep1', 'LR')));

  await check('viewer still CANNOT create', 'deny', addDoc(collection(vera, 'photos'), customerDoc('vera', 'L1')));
  await check('a doc claiming another uid still CANNOT be created', 'deny', addDoc(collection(rep, 'photos'), dashDoc('co-a', 'LR')));
  await check('a foreign object path still CANNOT be named', 'deny',
    setDoc(doc(solo, 'photos/P3'), engineDoc('co-a', 'L1', { storagePath: 'photos/someone-else/L1/x.jpg' })));
  await check("another tenant's admin still CANNOT attach to this tenant's lead", 'deny', addDoc(collection(eve, 'photos'), Object.assign(customerDoc('eve', 'L1'), { companyId: 'co-b' })));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nphoto EXIF fields rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
