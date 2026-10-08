/**
 * tests/firestore-index-coverage-2026-10-04.test.js
 *
 * The Firestore emulator never enforces indexes, so a query that needs a
 * composite index is green in every suite we run and FAILED_PRECONDITION in
 * production (callWatch, 2026-10-02 — caught by Jo, not by CI). This gate runs
 * scripts/check-firestore-indexes.js over functions/ and docs/pro/js and fails
 * on any compound query firestore.indexes.json cannot serve, except reviewed
 * entries in ALLOWLIST (each with a dated reason).
 *
 * The scanner is exercised on synthetic sources first (positive AND negative
 * controls), so a scanner that silently stops recognising queries cannot pass
 * — and the live scan must still find a floor of queries.
 *
 * Run: node tests/firestore-index-coverage-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scan = require(path.join(ROOT, 'scripts', 'check-firestore-indexes.js'));

/**
 * Reviewed false positives: "<file>|<collection> where(...) orderBy(...)" → reason.
 * Keep each entry specific; a stale entry (no longer reported) fails the test.
 */
const ALLOWLIST = {
  'functions/sms-functions.js|sms_log where(toDigits ==) orderBy(date desc)':
    '2026-10-04: conditional chain — q = q.where(companyId|uid) is applied before orderBy, the scanner sees only the first where. Real shapes (toDigits, companyId|uid, date desc) are both indexed.',
};
const FLOOR_QUERIES = 240; // 249 literal (267 incl. dynamic) on 2026-10-04 — lower only with a reason

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const keyOf = (f) => f.file + '|' + f.key;

console.log('\nSCANNER — synthetic controls');
{
  const idx = {
    indexes: [
      { collectionGroup: 'leads', queryScope: 'COLLECTION', fields: [{ fieldPath: 'userId', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }] },
      { collectionGroup: 'tasks', queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: 'userId', order: 'ASCENDING' }, { fieldPath: 'dueAt', order: 'ASCENDING' }] },
    ],
    fieldOverrides: [{ collectionGroup: 'jobs', fieldPath: 'companyId', indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' }] }],
  };
  const run = (src) => scan.check(scan.scanSource(src, 'x.js'), idx);
  ok('admin: eq + orderBy with a matching index → clean', run("db.collection('leads').where('userId','==',u).orderBy('createdAt','desc').get()").length === 0);
  ok('admin: eq + orderBy, wrong direction → flagged', run("db.collection('leads').where('userId','==',u).orderBy('createdAt','asc').get()").length === 1);
  ok('admin: eq + orderBy on an unindexed field → flagged', run("db.collection('leads').where('userId','==',u).orderBy('updatedAt','desc').get()").length === 1);
  ok('admin: equality-only on two fields → clean (index merging)', run("db.collection('leads').where('userId','==',u).where('stage','==','new').get()").length === 0);
  ok('admin: eq + inequality on another field → flagged', run("db.collection('leads').where('userId','==',u).where('value','>',5).get()").length === 1);
  ok('admin: inequality + orderBy on the SAME field → clean', run("db.collection('leads').where('createdAt','>',t).orderBy('createdAt').get()").length === 0);
  ok('modular: query(collection(db,…), where, orderBy) → clean when indexed', run("getDocs(query(collection(db,'leads'), where('userId','==',u), orderBy('createdAt','desc')))").length === 0);
  ok('modular: namespaced w.query/w.where, unindexed → flagged', run("w.getDocs(w.query(w.collection(w.db,'leads'), w.where('companyId','==',c), w.orderBy('createdAt','desc')))").length === 1);
  ok('modular: subcollection path uses the LAST segment', run("query(collection(db,'leads',id,'notes'), where('type','==','x'), orderBy('createdAt','desc'))").some((f) => /^notes /.test(f.key)));
  ok('modular: const col = collection(...) then query(col, …) is resolved', run("const col = collection(db,'leads'); getDocs(query(col, where('companyId','==',c), orderBy('createdAt','desc')))").length === 1);
  ok('admin ref: const col = db.collection(x).where(a); col.orderBy(b) combines both', run("const col = db.collection('leads').where('companyId','==',c);\nawait col.orderBy('createdAt','desc').get();").length === 1);
  ok('scope: a COLLECTION_GROUP index does NOT serve a collection query', run("db.collection('tasks').where('userId','==',u).orderBy('dueAt').get()").length === 1);
  ok('scope: …and does serve the collectionGroup query', run("db.collectionGroup('tasks').where('userId','==',u).orderBy('dueAt').get()").length === 0);
  ok('collectionGroup equality needs a CG single-field override (present → clean)', run("db.collectionGroup('jobs').where('companyId','==',c).get()").length === 0);
  ok('collectionGroup equality without the override → flagged', run("db.collectionGroup('jobs').where('userId','==',u).get()").some((f) => f.kind === 'group-field'));
  ok('dynamic field names are skipped, never guessed', run("db.collection('leads').where(field,'==',u).orderBy('x').get()").length === 0);
  ok('array-contains + another field → flagged', run("db.collection('leads').where('tags','array-contains','a').where('userId','==',u).get()").length === 1);
}

console.log('\nLIVE SCAN — functions/ + docs/pro/js vs firestore.indexes.json');
{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  const { files, queries } = scan.scanRepo(ROOT);
  const recognised = queries.filter((q) => !q.dynamic).length;
  ok('scanned ' + files + ' files, ' + recognised + ' literal queries (floor ' + FLOOR_QUERIES + ')', recognised >= FLOOR_QUERIES);
  const findings = scan.check(queries, idx);
  const unexpected = findings.filter((f) => !ALLOWLIST[keyOf(f)]);
  ok('every compound query has its index (or a reviewed allowlist entry)', unexpected.length === 0,
    unexpected.map((f) => '\n      ' + f.file + ':' + f.line + '  ' + f.key + (f.missing ? '  [CG single-field: ' + f.missing.join(',') + ']' : '')).join(''));
  const seen = new Set(findings.map(keyOf));
  const stale = Object.keys(ALLOWLIST).filter((k) => !seen.has(k));
  ok('no stale allowlist entries', stale.length === 0, stale.join(' | '));
  const undated = Object.entries(ALLOWLIST).filter(([, why]) => !/^20\d\d-\d\d-\d\d:/.test(why));
  ok('every allowlist entry starts with a date', undated.length === 0);
  // The fix this gate landed with: the Voice Intel tab's per-lead recordings listener.
  ok('recordings has a COLLECTION-scope (userId, recordedAt desc) index (Voice Intel tab)',
    idx.indexes.some((i) => i.collectionGroup === 'recordings' && i.queryScope === 'COLLECTION'
      && i.fields.map((f) => f.fieldPath + ':' + f.order).join(',') === 'userId:ASCENDING,recordedAt:DESCENDING'));
}

console.log('\nALERT — the production backstop file');
{
  const p = path.join(ROOT, 'monitoring', 'alert-firestore-missing-index.json');
  let j = null; try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { j = null; }
  ok('monitoring/alert-firestore-missing-index.json parses', !!j);
  const filt = j && j.conditions && j.conditions[0] && j.conditions[0].conditionMatchedLog && j.conditions[0].conditionMatchedLog.filter;
  ok('it is a conditionMatchedLog on Cloud Run for FAILED_PRECONDITION + "requires an index"',
    !!filt && /cloud_run_revision/.test(filt) && /FAILED_PRECONDITION/.test(filt) && /requires an index/.test(filt));
  ok('rate-limited (notificationRateLimit set — matched-log policies require it)', !!(j && j.alertStrategy && j.alertStrategy.notificationRateLimit));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
