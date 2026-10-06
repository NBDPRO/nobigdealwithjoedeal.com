/**
 * scripts/backfill-legacy-addresses.js
 *
 * ONE-TIME REPAIR — replaces pre-Wave-141 mangled `address` strings on
 * /leads with verified correct addresses.
 *
 * Background
 * ──────────
 * Before Wave 141 the address autocomplete stored
 * `display_name.split(',').slice(0,3)`, producing "1054, Klondyke Road,
 * Goshen" — comma after the house number, unabbreviated road, no state, no
 * ZIP, and a Nominatim hamlet/subdivision where the post town belongs.
 * dashboard-ui.js formatMailingAddress() fixed the write path; the rows
 * written before the cutover still hold the mangled strings and every
 * document generated off them is mis-addressed.
 *
 * Run `node scripts/audit-lead-addresses.js --list` first — it reports the
 * full damage and is the acceptance test for this script.
 *
 * WHY A HARDCODED MAP AND NOT RE-GEOCODING
 * ────────────────────────────────────────
 * Re-geocoding a mangled string returns whatever Nominatim thinks
 * "7003, Wrenfield Trace, O'Bannon Creek" means — which is how the row
 * broke in the first place. Every correction below is transcribed from a
 * finished NBD document (invoice, estimate, photo report) where Joe wrote
 * the address himself. Nothing here is inferred. A row with no verified
 * source is REPORTED, never guessed at.
 *
 * SAFETY
 *   • Dry-run by default; --apply requires --yes.
 *   • Verify-before-write: a row is only touched when its CURRENT value is
 *     byte-identical to `expectCurrent`. If someone has already corrected
 *     it by hand, the entry no-ops instead of overwriting their work.
 *   • Idempotent — re-running after a successful apply reports "already
 *     correct" and writes nothing.
 *   • Only ever writes `address`. No other field is touched — not even
 *     `updatedAt`: this is a data correction, not a customer interaction, and
 *     the analytics monthly-trend chart buckets won-lead revenue by updatedAt.
 *
 * SETUP (admin-script-runner pattern — prod nobigdeal-pro via ADC).
 * firebase-admin arrives through scripts/_admin.js, which resolves it out of
 * functions/node_modules — scripts/ and the repo root have none of their own.
 * Do NOT set NODE_PATH: _admin tries a bare require.resolve FIRST, so a
 * NODE_PATH install satisfies it and silently decides which firebase-admin
 * this script gets, which is the single-resolver guarantee _admin exists to
 * provide. Runs on v12 and v14 alike.
 *
 * (This docstring used to warn "v14 breaks Timestamps". That was inherited
 * boilerplate — it appeared verbatim in seven sibling scripts, the exact
 * copy-paste propagation _admin.js's own docstring describes. This script
 * reads only `address`, `firstName` and `lastName`, all strings, and orders by
 * the '__name__' string literal. It neither reads nor writes a Timestamp at
 * all. See documentation/audit/ADMIN-SCRIPTS-ADMIN-PORT-2026-09-01.md.)
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *   export NBD_PROJECT=nobigdeal-pro               # optional override
 *
 * RUN
 *   node scripts/backfill-legacy-addresses.js --data=<file>               # dry-run
 *   node scripts/backfill-legacy-addresses.js --data=<file> --apply --yes # write
 *   node scripts/audit-lead-addresses.js --list             # verify
 */

const { initAdmin, getFirestore } = require('./_admin');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const PAGE = 500;

/**
 * Verified corrections. `expectCurrent` is the mangled value as it stands in
 * Firestore today — the write only happens on an exact match.
 *
 * Two sources are accepted, and nothing else:
 *
 *  1. A DOCUMENT: something in Drive/NBD/CUSTOMERS/<customer>/ where the
 *     address is written out properly.
 *
 *  2. A RE-GEOCODE: the pre-Wave-141 strings put back through Nominatim and
 *     formatted by the
 *     shipped formatMailingAddress() — i.e. the fixed write path re-run over
 *     the old data. Every row there cleared three guards before being
 *     written down: the house number is unchanged, the first token of the
 *     street name is unchanged, and the result lands in OH/KY/IN. A row that
 *     failed any guard is NOT in the file (e.g. "123, Franklin Township,
 *     Franklin County" geocoded to Phillips, Maine — rejected, still
 *     reported by the audit).
 *
 * `expectCurrent` still gates every write, so a record edited by hand since
 * the audit is skipped rather than overwritten.
 *
 * WHERE THE CORRECTIONS LIVE (since 2026-10-06)
 * ─────────────────────────────────────────────
 * Each correction pairs a lead doc id with a customer's name and home
 * address, and this repo is public, so the list is NOT in the repo. It used to
 * be scripts/legacy-address-corrections.json plus one hand-listed entry here;
 * both now live together in Jo's private notes folder. Pass the file:
 *
 *   node scripts/backfill-legacy-addresses.js --data=<path>/legacy-address-corrections.json
 *   NBD_ADDRESS_CORRECTIONS_FILE=<path> node scripts/backfill-legacy-addresses.js
 *
 * Shape: an array of { id, who, expectCurrent, correct, source, note? }.
 * Missing file → exit 2 with a message, never a silent "0 corrections".
 */
const { loadPrivateJson } = require('./_private-data');

const CORRECTIONS = loadPrivateJson({
  envVar: 'NBD_ADDRESS_CORRECTIONS_FILE',
  what: 'the verified address-corrections list',
});
if (!Array.isArray(CORRECTIONS) || !CORRECTIONS.every((c) => c && c.id && 'expectCurrent' in c && c.correct)) {
  console.error('\n  The corrections file must be an array of { id, who, expectCurrent, correct, source }.\n');
  process.exit(2);
}

// Same signature the audit uses — a leading house number then a comma.
const LEGACY_MANGLED = /^\s*\d+[a-zA-Z]?\s*,/;

async function main() {
  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
  }

  // initAdmin's default credential IS applicationDefault(), and its
  // `if (!getApps().length)` guard replaces the old hand-rolled try/catch that
  // string-matched 'already exists' — that swallowed unrelated init errors too.
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Repair legacy mangled lead addresses');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)'));
  console.log('═══════════════════════════════════════════════════════════\n');

  let applied = 0, alreadyOk = 0, drifted = 0, missing = 0, failed = 0;

  for (const c of CORRECTIONS) {
    const ref = db.collection('leads').doc(c.id);
    const snap = await ref.get();
    if (!snap.exists) {
      missing++;
      console.log('  ? MISSING  ' + c.who + '  (doc ' + c.id + ' not found)');
      continue;
    }
    const current = String((snap.data() || {}).address || '').trim();

    if (current === c.correct) {
      alreadyOk++;
      console.log('  = ALREADY  ' + c.who);
      continue;
    }
    if (current !== c.expectCurrent) {
      drifted++;
      console.log('  ! SKIPPED  ' + c.who);
      console.log('             expected : ' + JSON.stringify(c.expectCurrent));
      console.log('             found    : ' + JSON.stringify(current));
      console.log('             Someone changed it. Review by hand — not overwriting.');
      continue;
    }

    console.log('  → FIX      ' + c.who);
    console.log('             from : ' + JSON.stringify(current));
    console.log('             to   : ' + JSON.stringify(c.correct));
    console.log('             src  : ' + c.source);
    if (c.note) console.log('             NOTE : ' + c.note);

    if (APPLY) {
      try {
        // `address` ONLY — deliberately no `updatedAt`. An address repair is a
        // data correction, not a customer interaction, and three consumers read
        // updatedAt as if it were one:
        //
        //   analytics-kpi.js monthlyTrend buckets won-lead revenue by
        //     updatedAt with NO stageStartedAt fallback, so stamping it would
        //     move a corrected lead's jobValue out of its real close month
        //     into the month this script ran. The sibling closedThisMonth KPI
        //     already carries that fallback (F3) — monthlyTrend never got it.
        //   ask-joe-proactive.js _lastTouch falls through to updatedAt, so a
        //     cold lead would look freshly contacted and its follow-up nudge
        //     would stop firing.
        //   crm-list-view.js _activity sorts on it.
        //
        // Writing one field also makes the SAFETY claim above strictly
        // stronger, which is the point.
        await ref.set({ address: c.correct }, { merge: true });
        applied++;
      } catch (e) {
        failed++;
        console.warn('             ! write failed — ' + e.message);
      }
    }
  }

  // Report every remaining mangled row that has no verified correction yet,
  // so the gap is visible rather than quietly carried.
  console.log('\n─── still mangled, no verified source ───');
  const known = new Set(CORRECTIONS.map(c => c.id));
  let unresolved = 0, last = null;
  while (true) {
    let q = db.collection('leads').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      if (known.has(doc.id)) continue;
      const d = doc.data() || {};
      // Skip soft-deleted rows, matching audit-lead-addresses.js:100. The app
      // soft-deletes rather than destroying, so merged duplicates and test
      // records still sit in the collection with their old mangled addresses.
      // Counting them here made this script's "unresolved mangled" total read
      // higher than the audit's — while this script's own docstring calls that
      // audit its acceptance test. The two numbers now mean the same thing.
      if (d.deleted === true) continue;
      const addr = String(d.address || '').trim();
      if (!LEGACY_MANGLED.test(addr)) continue;
      unresolved++;
      const name = [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || '(no name)';
      console.log('  ' + doc.id + '  ' + name.padEnd(26) + addr);
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }
  if (!unresolved) console.log('  (none)');

  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  corrections defined : ' + CORRECTIONS.length);
  console.log('  already correct     : ' + alreadyOk);
  console.log('  skipped (drifted)   : ' + drifted);
  console.log('  doc not found       : ' + missing);
  console.log('  ' + (APPLY ? 'written             : ' + applied : 'would write         : ' + (CORRECTIONS.length - alreadyOk - drifted - missing)));
  if (APPLY) console.log('  failures            : ' + failed);
  console.log('  unresolved mangled  : ' + unresolved + '  ← need a verified source before they can be fixed');
  if (!APPLY) console.log('\n  (dry-run — re-run with --apply --yes to write)');
  console.log('───────────────────────────────────────────────────────────');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
