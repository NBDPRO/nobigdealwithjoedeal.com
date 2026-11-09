/**
 * Firestore rules — NBD OS company home (2026-11-09, NBD OS P1 "Company home";
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.5).
 *
 *   companies/{companyId}/settings/layout
 *     defaultWidgets['os-phone'], defaultWidgets['os-desk']   lists of <= 24 { id, s, cfg? }
 *     homeLocked                                             bool (OFF unless set)
 *
 * Written by the same people who may already write the layout default: the
 * solo owner (uid == companyId) or that company's company_admin. Not a
 * manager, rep or viewer, not another tenant. The client writes it through
 * LayoutEngine.saveCompany, a full replace of the doc.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-oshome-test \
 *     'node firestore-rules.os-company-home.test.js'
 *
 * Every deny is paired with an allow of the same write minus the one defect
 * (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-oshome-test';
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
  const host = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: host.split(':')[0], port: Number(host.split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const solo = ctx('co-a', {});                                             // solo owner: uid == companyId
  const admin = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const rep = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const mgr = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const otherAdmin = ctx('bob', { role: 'company_admin', companyId: 'co-b' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, getDoc, doc } = require('firebase/firestore');
  const ref = (db, co) => doc(db, 'companies/' + (co || 'co-a') + '/settings/layout');

  const PHONE = [{ id: 'glance', s: 'm' }, { id: 'daily', s: 'm', cfg: { show: 'business' } }, { id: 'shortcuts', s: 's' }];
  const DESK = [{ id: 'upnext', s: 'l' }, { id: 'coach', s: 'm', cfg: { show: 'business' } }];
  const BENTO = [{ widgetId: 'revenue', x: 0, y: 0, w: 1, h: 1 }];
  // the shape saveCompany writes (layout-system.js): a full replace
  const base = (extra) => Object.assign({ locked: false, defaultByDevice: {}, defaultLayout: 'os', updatedAt: '2026-11-09T12:00:00.000Z' }, extra || {});
  const pub = (uid, extra) => base(Object.assign({ updatedBy: uid, defaultWidgets: { 'os-phone': PHONE, 'os-desk': DESK, bento: BENTO } }, extra || {}));
  const full = (n) => new Array(n).fill({ id: 'glance', s: 's' });

  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'companies/co-a/settings/layout'), { defaultLayout: 'os', locked: false, defaultWidgets: { bento: BENTO } });
  });

  // -- who may publish
  await check('company_admin publishes both homes and locks them', 'allow', setDoc(ref(admin), pub('carol', { homeLocked: true })));
  await check('the solo owner publishes both homes', 'allow', setDoc(ref(solo), pub('co-a')));
  await check('the solo owner locks team homes', 'allow', setDoc(ref(solo), pub('co-a', { homeLocked: true })));
  await check('the solo owner lifts the lock (homeLocked: false)', 'allow', setDoc(ref(solo), pub('co-a', { homeLocked: false })));
  await check('lifting the lock by leaving homeLocked out (what saveCompany writes when off)', 'allow', setDoc(ref(solo), pub('co-a')));
  await check('a rep CANNOT publish a team home', 'deny', setDoc(ref(rep), pub('alice')));
  await check('a rep CANNOT lock team homes', 'deny', setDoc(ref(rep), pub('alice', { homeLocked: true })));
  await check('a rep CANNOT lift the lock with an update', 'deny', updateDoc(ref(rep), { homeLocked: false }));
  await check('a manager CANNOT publish', 'deny', setDoc(ref(mgr), pub('eve')));
  await check('a viewer CANNOT publish', 'deny', setDoc(ref(vic), pub('vic')));
  await check('another company\'s admin CANNOT publish into co-a', 'deny', setDoc(ref(otherAdmin), pub('bob')));
  await check('another company\'s admin publishes its own (control)', 'allow', setDoc(ref(otherAdmin, 'co-b'), pub('bob', { homeLocked: true })));
  await check('signed-out CANNOT publish', 'deny', setDoc(ref(anon), pub('x')));

  // -- members read it (the engine resolves the home at boot)
  await check('a rep reads the company home and the lock', 'allow', getDoc(ref(rep)));
  await check('a viewer reads it', 'allow', getDoc(ref(vic)));
  await check('another company cannot read it', 'deny', getDoc(ref(otherAdmin)));

  // -- shape and size
  await check('control: a 24-item phone home (the cap)', 'allow', setDoc(ref(admin), pub('carol', { defaultWidgets: { 'os-phone': full(24) } })));
  await check('a 25-item phone home is refused', 'deny', setDoc(ref(admin), pub('carol', { defaultWidgets: { 'os-phone': full(25) } })));
  await check('control: a 24-item desk home (the cap)', 'allow', setDoc(ref(admin), pub('carol', { defaultWidgets: { 'os-desk': full(24) } })));
  await check('a 25-item desk home is refused', 'deny', setDoc(ref(admin), pub('carol', { defaultWidgets: { 'os-desk': full(25) } })));
  await check('a phone home that is a map, not a list, is refused', 'deny', setDoc(ref(admin), pub('carol', { defaultWidgets: { 'os-phone': { 0: { id: 'glance', s: 'm' } } } })));
  await check('a desk home that is a string is refused', 'deny', setDoc(ref(admin), pub('carol', { defaultWidgets: { 'os-desk': 'glance,upnext' } })));
  await check('homeLocked must be a boolean', 'deny', setDoc(ref(admin), pub('carol', { homeLocked: 'yes' })));
  await check('control: homeLocked true', 'allow', setDoc(ref(admin), pub('carol', { homeLocked: true })));
  await check('a smuggled top-level key next to the home is refused', 'deny', setDoc(ref(admin), pub('carol', { homeOwners: ['carol'] })));
  await check('updatedBy must still be the writer', 'deny', setDoc(ref(admin), pub('someone-else')));
  await check('defaultWidgets still caps at 8 layouts with the two homes in it', 'deny', setDoc(ref(admin), pub('carol', {
    defaultWidgets: { 'os-phone': [], 'os-desk': [], bento: [], a: [], b: [], c: [], d: [], e: [], f: [] } })));
  await check('control: 8 layouts with the two homes', 'allow', setDoc(ref(admin), pub('carol', {
    defaultWidgets: { 'os-phone': [], 'os-desk': [], bento: [], a: [], b: [], c: [], d: [], e: [] } })));

  // -- the writes that were allowed before still are
  await check('existing: a layout default with no home keys at all', 'allow', setDoc(ref(admin), base({ updatedBy: 'carol' })));
  await check('existing: the layout lock alone', 'allow', setDoc(ref(solo), base({ locked: true, updatedBy: 'co-a' })));
  await check('existing: a Bento default board alone', 'allow', setDoc(ref(admin), base({ updatedBy: 'carol', defaultWidgets: { bento: BENTO } })));
  await check('existing: a 25-tile Bento board is still refused', 'deny', setDoc(ref(admin), base({ updatedBy: 'carol', defaultWidgets: { bento: new Array(25).fill(BENTO[0]) } })));
  await check('existing: a rep still cannot write the layout default', 'deny', setDoc(ref(rep), base({ updatedBy: 'alice' })));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
