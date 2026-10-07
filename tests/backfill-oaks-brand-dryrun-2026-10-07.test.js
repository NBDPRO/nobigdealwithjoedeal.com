/**
 * tests/backfill-oaks-brand-dryrun-2026-10-07.test.js — the Oaks brand backfill
 * must not write prod unless it is told to, twice.
 *
 * Before 2026-10-07, `node scripts/backfill-oaks-brand.js` with no flags called
 * `.set(OAKS_BRAND, { merge: true })` on live `companyProfile/oaks` the moment
 * it ran. Every other prod backfill is dry-run by default and needs
 * `--apply --yes` (plus the one-shot guard, scripts/_migration-guard.js). This
 * pins the same contract on this one.
 *
 * It drives the REAL script in a child process. A preload (-r) swaps every
 * `firebase-admin*` module for an in-memory fake that records writes to stdout,
 * so no credentials, network or functions/ install are involved. Belt and
 * braces against the stub ever missing: the child also gets an unreachable
 * FIRESTORE_EMULATOR_HOST, a demo- project and no GOOGLE_APPLICATION_CREDENTIALS,
 * so a real firebase-admin could not reach prod either.
 *
 * The --apply --yes case proves the recorder CAN see a write; without it, "no
 * write recorded" in the dry-run case would prove nothing.
 *
 * Run: node tests/backfill-oaks-brand-dryrun-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill-oaks-brand.js');

// The fake firebase-admin. One object serves the default export and every
// subpath (app / firestore / auth / storage). Writes go to stdout as one
// `__WRITE__ <json>` line each so the parent can count them.
const STUB_SRC = `
'use strict';
const Module = require('module');
const marker = process.env.OAKS_TEST_MARKER === '1'
  ? { 'backfill-oaks-brand': { completedAt: '2026-06-01T00:00:00Z', completedBy: 'test' } }
  : null;
function ref(p) {
  return {
    path: p,
    get: async () => {
      if (p === 'system/script_migrations') return { exists: !!marker, data: () => marker || undefined };
      return { exists: false, data: () => undefined };
    },
    set: async (data, opts) => { process.stdout.write('__WRITE__ ' + JSON.stringify({ path: p, opts: opts || null, data }) + '\\n'); },
    update: async (data) => { process.stdout.write('__WRITE__ ' + JSON.stringify({ path: p, op: 'update', data }) + '\\n'); },
    delete: async () => { process.stdout.write('__WRITE__ ' + JSON.stringify({ path: p, op: 'delete' }) + '\\n'); },
  };
}
const db = {
  collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
  doc: (p) => ref(p),
  batch: () => { throw new Error('stub: batch not expected'); },
  terminate: async () => {},
};
let apps = [];
const fake = {
  initializeApp: (o) => { apps = [{ options: o || {} }]; return apps[0]; },
  applicationDefault: () => ({ stub: true }),
  getApps: () => apps,
  getApp: () => apps[0],
  getFirestore: () => db,
  firestore: () => db,
  FieldValue: { serverTimestamp: () => '__TS__' },
  FieldPath: {}, Timestamp: {},
  getAuth: () => ({}), getStorage: () => ({}),
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin' || String(request).indexOf('firebase-admin/') === 0) return fake;
  return realLoad.apply(this, arguments);
};
`;

const stubPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oaks-dryrun-')), 'fake-admin.js');
fs.writeFileSync(stubPath, STUB_SRC);

function run(args, extraEnv) {
  const env = Object.assign({}, process.env, {
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:1',
    GOOGLE_CLOUD_PROJECT: 'demo-oaks-dryrun-test',
    GCLOUD_PROJECT: 'demo-oaks-dryrun-test',
    NBD_PROJECT: 'demo-oaks-dryrun-test',
  }, extraEnv || {});
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  const r = spawnSync(process.execPath, ['-r', stubPath, SCRIPT].concat(args), { env, encoding: 'utf8', timeout: 30000 });
  const lines = (r.stdout || '').split(/\r?\n/);
  const writes = lines.filter((l) => l.startsWith('__WRITE__ ')).map((l) => JSON.parse(l.slice(10)));
  // What the operator sees — the recorder's own lines excluded, so "prints the
  // payload" cannot pass just because a write echoed it.
  const out = lines.filter((l) => !l.startsWith('__WRITE__ ')).join('\n') + (r.stderr || '');
  return { code: r.status, out, writes };
}

const brandWrites = (w) => w.filter((x) => x.path === 'companyProfile/oaks');

console.log('\nBare run (no flags) — must be a dry run');
{
  const r = run([]);
  ok('exits 0', r.code === 0);
  ok('performs NO write of any kind', r.writes.length === 0);
  ok('says it is a dry run', /DRY[- ]RUN/i.test(r.out));
  ok('prints the target doc', /companyProfile\/oaks/.test(r.out));
  ok('prints the exact payload it would write (displayName + accent)',
    /Oaks Roofing & Construction/.test(r.out) && /#C2410C/.test(r.out));
  ok('tells the operator how to apply', /--apply --yes/.test(r.out));
}

console.log('\n--apply without --yes — refused, nothing written');
{
  const r = run(['--apply']);
  ok('exits 2', r.code === 2);
  ok('performs NO write', r.writes.length === 0);
}

console.log('\n--yes alone is still a dry run');
{
  const r = run(['--yes']);
  ok('performs NO write', r.writes.length === 0);
}

console.log('\n--apply --yes — the recorder CAN see a write (proves the checks above can fail)');
{
  const r = run(['--apply', '--yes']);
  const b = brandWrites(r.writes);
  ok('exits 0', r.code === 0);
  ok('exactly one write to companyProfile/oaks', b.length === 1);
  ok('…as a merge, never a replace', !!b[0] && !!b[0].opts && b[0].opts.merge === true);
  ok('…carrying the brand block', !!b[0] && !!b[0].data.brand && b[0].data.brand.displayName === 'Oaks Roofing & Construction');
  ok('records the one-shot marker', r.writes.some((x) => x.path === 'system/script_migrations'));
}

console.log('\n--apply --yes after a recorded run — the one-shot guard refuses');
{
  const r = run(['--apply', '--yes'], { OAKS_TEST_MARKER: '1' });
  ok('exits 3 (EXIT_ALREADY_COMPLETED)', r.code === 3);
  ok('performs NO write', r.writes.length === 0);
  const f = run(['--apply', '--yes', '--force'], { OAKS_TEST_MARKER: '1' });
  ok('--force overrides and writes', brandWrites(f.writes).length === 1);
}

try { fs.rmSync(path.dirname(stubPath), { recursive: true, force: true }); } catch (_) {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
