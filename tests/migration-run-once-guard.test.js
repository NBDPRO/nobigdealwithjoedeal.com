/**
 * tests/migration-run-once-guard.test.js — one-shot backfills must refuse a
 * second --apply.
 *
 * The backfills under scripts/ each ran once against a specific historical data
 * state. Their existing rails — dry-run default, --apply needing --yes,
 * per-document idempotency — all guard a CARELESS run; none notice a second
 * DELIBERATE one. purge-legacy-storage-portals deletes customer-facing Storage
 * objects, so "was this the one that already ran?" must not be answered from a
 * comment header.
 *
 * Two halves:
 *   1. decide() — the pure verdict, tested directly.
 *   2. the wiring contract — every guarded script declares what it references,
 *      awaits the guard, and keys the marker by its own filename. A drifted
 *      MIGRATION name would write a marker nothing ever reads, which looks
 *      exactly like a working guard until the day it matters.
 *
 * Pure string/vm — no emulator, no firebase-admin. Run:
 *   node tests/migration-run-once-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const GUARD_SRC = fs.readFileSync(path.join(SCRIPTS, '_migration-guard.js'), 'utf8');

// ── 1. decide(): extract the pure function, no firebase-admin needed ──
const decideSrc = GUARD_SRC.match(/function decide\s*\([\s\S]*?\n\}/);
ok('decide() exists in _migration-guard.js', !!decideSrc);
if (!decideSrc) { console.log('\n  FATAL: decide() not found\n'); process.exit(1); }

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(decideSrc[0] + '\nthis.decide = decide;', sandbox);
const decide = sandbox.decide;

const PRIOR = { completedAt: '2026-06-01T00:00:00Z', completedBy: 'jo' };

console.log('\nNo marker — nothing has run yet');
ok('no marker + dry run  → proceed', decide(null, { apply: false, force: false }) === 'proceed');
ok('no marker + apply    → proceed', decide(null, { apply: true, force: false }) === 'proceed');
ok('undefined opts       → proceed', decide(null, undefined) === 'proceed');

console.log('\nMarker present — the whole point');
ok('marker + apply, no force → REFUSE', decide(PRIOR, { apply: true, force: false }) === 'refuse');
ok('marker + apply, force    → warn (deliberate re-run)', decide(PRIOR, { apply: true, force: true }) === 'warn');
ok('marker + dry run         → note (read-only, still useful)', decide(PRIOR, { apply: false, force: false }) === 'note');
ok('marker + dry run + force → note (force must not matter when not applying)',
  decide(PRIOR, { apply: false, force: true }) === 'note');

console.log('\nRefusal is the default for a truthy marker of any shape');
ok('empty-object marker still refuses', decide({}, { apply: true }) === 'refuse');
ok('marker without completedAt still refuses', decide({ completedBy: 'x' }, { apply: true }) === 'refuse');

console.log('\nGuard module contract');
ok('refuses with a dedicated exit code (not a generic 1)',
  /EXIT_ALREADY_COMPLETED\s*=\s*3/.test(GUARD_SRC) && /process\.exit\(EXIT_ALREADY_COMPLETED\)/.test(GUARD_SRC));
// The marker must live under system/, which firestore.rules already denies to
// every client — and must NOT collide with the versioned runner's own state.
ok("marker doc is under system/ (rules already deny clients)",
  /DOC_PATH\s*=\s*'system\/script_migrations'/.test(GUARD_SRC));
ok('marker doc is NOT the versioned runner state (system/migrations)',
  !/DOC_PATH\s*=\s*'system\/migrations'/.test(GUARD_SRC));
ok('recordCompletion merges rather than overwriting sibling markers',
  /\.set\(\{[\s\S]{0,400}?\}, \{ merge: true \}\)/.test(GUARD_SRC));

const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
ok('firestore.rules denies clients the whole system/ namespace',
  /match \/system\/\{docId\} \{\s*allow read, write: if false;/.test(rules));

// ── 2. wiring contract across every guarded script ──
const GUARDED = [
  'backfill-lead-stageRole',
  'backfill-lead-updatedAt',
  'backfill-leads-phoneDigits',
  'backfill-oaks-brand',
  'backfill-photos-createdAt',
  'backfill-photos-variants',
  'backfill-pins-companyId',
  'backfill-pins-to-knocks',
  'purge-legacy-storage-portals',
];

console.log('\nEvery one-shot is wired to the guard');
for (const name of GUARDED) {
  const src = fs.readFileSync(path.join(SCRIPTS, name + '.js'), 'utf8');
  const m = src.match(/const\s+MIGRATION\s*=\s*['"]([^'"]+)['"]/);

  ok(name + ': declares MIGRATION', !!m);
  // A drifted key writes a marker nothing reads — a guard that looks armed
  // and is not.
  ok(name + ': MIGRATION key matches its filename', !!m && m[1] === name);
  ok(name + ': declares FORCE (the --force escape hatch)', /const\s+FORCE\s*=/.test(src));
  ok(name + ': requires ./_migration-guard', /require\(\s*['"]\.\/_migration-guard['"]\s*\)/.test(src));
  // Not awaiting means the process races past a refusal and does the work.
  ok(name + ': awaits assertNotCompleted', /await\s+assertNotCompleted\(/.test(src));
  ok(name + ': awaits recordCompletion', /await\s+recordCompletion\(/.test(src));
  // Recording a failed run as "done" would permanently block the retry.
  ok(name + ': records only on an applying run',
    /if\s*\(\s*APPLY[^)]*\)\s*(\{[\s\S]{0,120}?)?await\s+recordCompletion\(/.test(src));
}

console.log('\nThe retroactive-stamp tool exists (the guard cannot see pre-guard runs)');
const markSrc = fs.readFileSync(path.join(SCRIPTS, 'mark-migration-complete.js'), 'utf8');
ok('mark-migration-complete.js lists every guarded migration',
  GUARDED.every((n) => markSrc.includes("'" + n + "'")));
ok('it rejects an unknown migration name rather than writing a dead marker',
  /KNOWN\.includes\(name\)/.test(markSrc));
ok('it can undo a stamp', /--undo/.test(markSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
