/**
 * Firestore rules — anonymous "layout used today" counter (2026-10-16).
 *
 *   companies/{companyId}/layoutUsage/{YYYY-MM-DD} = { <layoutId>: n }
 *   docs/pro/js/layout-usage.js (one +1 per device, per layout, per day)
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-lusage-test \
 *     'node firestore-rules.layout-usage.test.js'
 *
 * Every shape deny is paired with an allow of the same write minus the one
 * defect (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-lusage-test';
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
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    // emulators:exec exports FIRESTORE_EMULATOR_HOST; 127.0.0.1:8080 is the repo default
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[0], port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});                                            // solo owner: uid == companyId
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc, increment } = require('firebase/firestore');
  const DAY = '2026-10-16';
  const ref = (db, d, co) => doc(db, 'companies/' + (co || 'co-a') + '/layoutUsage/' + (d || DAY));

  // -- writes: who (each is +1 on one layout, the shape the client writes)
  await check('a sales rep counts the layout on their screen (+1)', 'allow', setDoc(ref(alice), { field: increment(1) }, { merge: true }));
  await check('a manager counts one (+1 on another layout)', 'allow', setDoc(ref(eve), { classic: increment(1) }, { merge: true }));
  await check('the solo owner counts one', 'allow', setDoc(ref(owner), { field: increment(1) }, { merge: true }));
  await check('a company_admin counts one', 'allow', setDoc(ref(carol), { mission: increment(1) }, { merge: true }));
  await check('a viewer CANNOT write', 'deny', setDoc(ref(vic), { field: increment(1) }, { merge: true }));
  await check('another tenant CANNOT write into co-a', 'deny', setDoc(ref(bobCA), { field: increment(1) }, { merge: true }));
  await check('anonymous CANNOT write', 'deny', setDoc(ref(anon), { field: increment(1) }, { merge: true }));
  await check('another tenant writes its own day (control)', 'allow', setDoc(ref(bobCA, DAY, 'co-b'), { focus: increment(1) }, { merge: true }));

  // -- shape
  await check('control: +1 on a known layout', 'allow', setDoc(ref(alice), { inbox: increment(1) }, { merge: true }));
  await check('+2 in one write is denied', 'deny', setDoc(ref(alice), { field: increment(2) }, { merge: true }));
  await check('lowering a count is denied', 'deny', setDoc(ref(alice), { field: increment(-1) }, { merge: true }));
  await check('setting a count outright is denied', 'deny', setDoc(ref(alice), { field: 99 }, { merge: true }));
  await check('two layouts in one write are denied', 'deny', setDoc(ref(alice), { field: increment(1), focus: increment(1) }, { merge: true }));
  await check('an unknown layout id is denied', 'deny', setDoc(ref(alice), { pixel: increment(1) }, { merge: true }));
  await check('a smuggled field (a uid) is denied', 'deny', setDoc(ref(alice), { field: increment(1), uid: 'alice' }, { merge: true }));
  await check('a non-number count is denied', 'deny', setDoc(ref(alice, '2026-10-17'), { field: 'one' }));
  await check('control: a new day starts at 1', 'allow', setDoc(ref(alice, '2026-10-17'), { crew: 1 }));
  await check('a new day cannot start above 1', 'deny', setDoc(ref(alice, '2026-10-18'), { crew: 5 }));
  await check('the doc id must be a date', 'deny', setDoc(ref(alice, 'today'), { field: 1 }));
  await check('replacing the day (dropping other counts) is denied', 'deny', setDoc(ref(alice), { field: increment(1) }));
  await check('nobody deletes a day, not even the owner', 'deny', deleteDoc(ref(owner)));

  // -- reads
  await check('the solo owner reads the counts', 'allow', getDoc(ref(owner)));
  await check('a company_admin reads', 'allow', getDoc(ref(carol)));
  await check('a platform admin reads', 'allow', getDoc(ref(joe)));
  await check('a sales rep does NOT read', 'deny', getDoc(ref(alice)));
  await check('a manager does NOT read', 'deny', getDoc(ref(eve)));
  await check('another tenant does NOT read', 'deny', getDoc(ref(bobCA)));
  await check('anonymous does NOT read', 'deny', getDoc(ref(anon)));

  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), 'companies/co-a/layoutUsage/' + DAY));
    const d = s.data() || {};
    results.push({ label: 'the stored day holds only counts (field 2, classic 1, mission 1, inbox 1)', ok: d.field === 2 && d.classic === 1 && d.mission === 1 && d.inbox === 1 && Object.keys(d).length === 4, note: JSON.stringify(d) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nlayoutUsage rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
