/**
 * Storage rules — sub-papers/{companyId}/{subId}/{file} (2026-10-19, flag subPaperwork).
 *
 * A W-9 carries a Social Security or employer ID number. This is the suite that
 * proves nobody else can read one:
 *   - the solo owner and the company's company_admin read, create and delete;
 *   - a manager, sales_rep, viewer, ANOTHER company's admin, another company's solo
 *     owner, the platform admin and anonymous read NOTHING (and write nothing);
 *   - POSITIVE CONTROL: the very same object IS readable by the owner, so a rule
 *     that denies everything cannot pass this file;
 *   - a paper is an image or a PDF under 25MB; no update (immutable); no deeper path;
 *   - an offboarded member (offboardLock) gets nothing.
 *
 * RUN:
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only storage --project nbd-subpapers-test \
 *     'node storage-rules.sub-papers.test.js'
 * RULES_PATH points the suite at a mutated copy of storage.rules (the mutation check).
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-subpapers-test';
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
const buf = (n) => Buffer.alloc(n, 1);

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../storage.rules'), 'utf8'), host: String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':')[0], port: Number(String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':')[1]) || 9199 },
  });
  const st = (uid, claims) => env.authenticatedContext(uid, claims).storage();
  const owner = st('co-a', {});                                             // solo owner: uid == companyId
  const carol = st('carol', { role: 'company_admin', companyId: 'co-a' });
  const mike = st('mike', { role: 'manager', companyId: 'co-a' });
  const alice = st('alice', { role: 'sales_rep', companyId: 'co-a' });
  const vic = st('vic', { role: 'viewer', companyId: 'co-a' });
  const viewerOwner = st('co-a', { role: 'viewer' });                        // a viewer whose uid IS the company id
  const bobCA = st('bobca', { role: 'company_admin', companyId: 'co-b' });
  const bobOwner = st('co-b', {});
  const joe = st('joe', { role: 'admin' });
  const gone = st('gone', { role: 'company_admin', companyId: 'co-a', offboardLock: true });
  const anon = env.unauthenticatedContext().storage();
  const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');
  const P = (file, co, sub) => 'sub-papers/' + (co || 'co-a') + '/' + (sub || 's1') + '/' + file;
  const PDF = { contentType: 'application/pdf' };
  const JPG = { contentType: 'image/jpeg' };

  // -- writes: who
  await check('the solo owner uploads a W-9 PDF', 'allow', uploadBytes(ref(owner, P('w9.pdf')), buf(2048), PDF));
  await check('a company_admin uploads a certificate photo', 'allow', uploadBytes(ref(carol, P('coi.jpg')), buf(2048), JPG));
  await check('a manager CANNOT upload', 'deny', uploadBytes(ref(mike, P('m.pdf')), buf(10), PDF));
  await check('a sales rep CANNOT upload', 'deny', uploadBytes(ref(alice, P('a.pdf')), buf(10), PDF));
  await check('a viewer CANNOT upload', 'deny', uploadBytes(ref(vic, P('v.pdf')), buf(10), PDF));
  await check('a viewer whose uid IS the company id CANNOT upload', 'deny', uploadBytes(ref(viewerOwner, P('vo.pdf')), buf(10), PDF));
  await check("another company's admin CANNOT upload into co-a", 'deny', uploadBytes(ref(bobCA, P('x.pdf')), buf(10), PDF));
  await check("another company's solo owner CANNOT upload into co-a", 'deny', uploadBytes(ref(bobOwner, P('x2.pdf')), buf(10), PDF));
  await check('a platform admin CANNOT upload', 'deny', uploadBytes(ref(joe, P('j.pdf')), buf(10), PDF));
  await check('anonymous CANNOT upload', 'deny', uploadBytes(ref(anon, P('an.pdf')), buf(10), PDF));
  await check('an offboarded member (offboardLock) CANNOT upload', 'deny', uploadBytes(ref(gone, P('g.pdf')), buf(10), PDF));
  await check("the owner of co-b CAN upload into co-b (control: the folder is theirs)", 'allow', uploadBytes(ref(bobOwner, P('b.pdf', 'co-b')), buf(10), PDF));

  // -- content rules
  await check('control: a PNG is accepted', 'allow', uploadBytes(ref(owner, P('p.png')), buf(10), { contentType: 'image/png' }));
  await check('an executable is refused', 'deny', uploadBytes(ref(owner, P('x.exe')), buf(10), { contentType: 'application/octet-stream' }));
  await check('a Word document is refused (image or PDF only)', 'deny', uploadBytes(ref(owner, P('d.docx')), buf(10), { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  await check('an SVG is refused (it can carry script)', 'deny', uploadBytes(ref(owner, P('s.svg')), buf(10), { contentType: 'image/svg+xml' }));
  await check('text/html is refused', 'deny', uploadBytes(ref(owner, P('h.html')), buf(10), { contentType: 'text/html' }));
  await check('control: just under 25MB is accepted', 'allow', uploadBytes(ref(owner, P('big-ok.pdf')), buf(25 * 1024 * 1024 - 1024), PDF));
  await check('25MB or more is refused', 'deny', uploadBytes(ref(owner, P('big.pdf')), buf(25 * 1024 * 1024 + 1024), PDF));
  await check('a path one level deeper is refused (default deny)', 'deny', uploadBytes(ref(owner, 'sub-papers/co-a/s1/deeper/a.pdf'), buf(10), PDF));
  await check('a path with no sub folder is refused', 'deny', uploadBytes(ref(owner, 'sub-papers/co-a/a.pdf'), buf(10), PDF));
  await check('a paper cannot be overwritten (immutable)', 'deny', uploadBytes(ref(owner, P('w9.pdf')), buf(4096), PDF));

  // -- reads: the positive control FIRST, then every other identity on the SAME object
  await check('POSITIVE CONTROL: the solo owner reads the W-9', 'allow', getBytes(ref(owner, P('w9.pdf'))));
  await check('a company_admin of the company reads it', 'allow', getBytes(ref(carol, P('w9.pdf'))));
  await check('a manager of the same company CANNOT read it', 'deny', getBytes(ref(mike, P('w9.pdf'))));
  await check('a sales rep of the same company CANNOT read it', 'deny', getBytes(ref(alice, P('w9.pdf'))));
  await check('a viewer of the same company CANNOT read it', 'deny', getBytes(ref(vic, P('w9.pdf'))));
  await check('a viewer whose uid IS the company id CANNOT read it', 'deny', getBytes(ref(viewerOwner, P('w9.pdf'))));
  await check("ANOTHER company's admin CANNOT read it", 'deny', getBytes(ref(bobCA, P('w9.pdf'))));
  await check("ANOTHER company's solo owner CANNOT read it", 'deny', getBytes(ref(bobOwner, P('w9.pdf'))));
  await check('a platform admin CANNOT read it', 'deny', getBytes(ref(joe, P('w9.pdf'))));
  await check('anonymous CANNOT read it', 'deny', getBytes(ref(anon, P('w9.pdf'))));
  await check('an offboarded member CANNOT read it', 'deny', getBytes(ref(gone, P('w9.pdf'))));
  await check('a token that names co-a but belongs to a sales rep still reads nothing', 'deny', getBytes(ref(st('rep2', { role: 'sales_rep', companyId: 'co-a' }), P('coi.jpg'))));

  // -- delete
  await check('a viewer CANNOT delete', 'deny', deleteObject(ref(vic, P('w9.pdf'))));
  await check("another company's admin CANNOT delete", 'deny', deleteObject(ref(bobCA, P('w9.pdf'))));
  await check('a manager CANNOT delete', 'deny', deleteObject(ref(mike, P('w9.pdf'))));
  await check('anonymous CANNOT delete', 'deny', deleteObject(ref(anon, P('w9.pdf'))));
  await check('control: the W-9 is still there after every denied delete', 'allow', getBytes(ref(owner, P('w9.pdf'))));
  await check('a company_admin deletes a paper', 'allow', deleteObject(ref(carol, P('coi.jpg'))));
  await check('the solo owner deletes a paper', 'allow', deleteObject(ref(owner, P('w9.pdf'))));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nsub-papers storage rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
