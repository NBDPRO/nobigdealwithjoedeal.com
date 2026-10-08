/**
 * scripts/mark-migration-complete.js — stamp a one-shot migration as already
 * applied, WITHOUT running it.
 *
 * WHY THIS IS NEEDED
 * ──────────────────
 * The run-once guard (scripts/_migration-guard.js) refuses a second `--apply`
 * by reading a marker in `system/script_migrations`. But every one of these
 * backfills already ran in prod BEFORE the guard existed, so none of them left
 * a marker. Without this tool the guard protects only future migrations and
 * silently permits exactly the re-runs it was added to prevent.
 *
 * Use it to record history that already happened:
 *
 *   node scripts/mark-migration-complete.js --list
 *   node scripts/mark-migration-complete.js backfill-pins-to-knocks
 *   node scripts/mark-migration-complete.js backfill-pins-to-knocks --note "ran 2026-06 per BUG-LOG"
 *   node scripts/mark-migration-complete.js backfill-pins-to-knocks --undo
 *
 * ⚠ WRITES TO PROD FIRESTORE (one small doc under system/, admin-SDK only).
 *   Auth: application-default credentials, same as the other admin scripts.
 *
 * Only stamp a migration you have actually confirmed ran. A wrong marker is
 * worse than none: it blocks a migration that still needs to happen, and the
 * refusal message will cite a completion that never occurred.
 */
'use strict';

const os = require('os');
const { initAdmin, getFirestore, FieldValue } = require('./_admin');
const { DOC_PATH, getCompletion } = require('./_migration-guard');

// The one-shot migrations the guard protects. Kept here so --list is a real
// answer rather than a guess, and so a typo'd name is rejected instead of
// silently creating a marker nothing will ever read.
const KNOWN = [
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

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const name = argv.find((a) => !a.startsWith('--') && a !== valOf('--note'));

async function main() {
  initAdmin();

  if (flag('--list') || !name) {
    console.log('\nOne-shot migrations under guard:\n');
    for (const n of KNOWN) {
      const prior = await getCompletion(n);
      const when = prior
        ? (prior.completedAt && typeof prior.completedAt.toDate === 'function'
            ? prior.completedAt.toDate().toISOString() : String(prior.completedAt))
        : null;
      console.log('  ' + (prior ? 'RECORDED' : '  —     ') + '  ' + n.padEnd(32)
        + (prior ? when + (prior.note ? '  "' + prior.note + '"' : '') : '(no marker — a --apply would be permitted)'));
    }
    console.log('\nStamp one:  node scripts/mark-migration-complete.js <name> [--note "..."]');
    console.log('Remove one: node scripts/mark-migration-complete.js <name> --undo\n');
    return;
  }

  if (!KNOWN.includes(name)) {
    console.error(`✗ Unknown migration: ${name}`);
    console.error('  Known: ' + KNOWN.join(', '));
    console.error('  (--list shows current state)');
    process.exit(2);
  }

  const db = getFirestore();

  if (flag('--undo')) {
    const prior = await getCompletion(name);
    if (!prior) { console.log(`${name} has no marker — nothing to undo.`); return; }
    await db.doc(DOC_PATH).set({ [name]: FieldValue.delete() }, { merge: true });
    console.log(`✓ removed the completion marker for ${name} — a --apply is permitted again.`);
    return;
  }

  const prior = await getCompletion(name);
  if (prior) {
    console.log(`${name} is already marked complete — leaving it as-is.`);
    console.log('  (use --undo to clear it first if you need to restamp)');
    return;
  }

  await db.doc(DOC_PATH).set({
    [name]: {
      completedAt: FieldValue.serverTimestamp(),
      completedBy: process.env.USER || process.env.USERNAME || '(unknown)',
      host: os.hostname(),
      markedManually: true,     // distinguishes a stamp from a real recorded run
      note: valOf('--note') || 'stamped retroactively; ran before the guard existed',
    },
  }, { merge: true });

  console.log(`✓ ${name} marked complete. A future --apply will be refused (--force overrides).`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('✗ failed:', e && e.message ? e.message : e);
  process.exit(1);
});
