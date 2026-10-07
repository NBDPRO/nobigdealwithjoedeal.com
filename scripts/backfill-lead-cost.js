/**
 * scripts/backfill-lead-cost.js
 *
 * ONE-TIME BACKFILL — stamps `leadCost` (dollars) on every /leads doc whose
 * `notes` already contain the acquisition fee as free text.
 *
 * Background
 * ──────────
 * The Thumbtack ingest has been writing the fee into the notes blob since the
 * integration went in:
 *
 *     Thumbtack — Roof Repair or Maintenance
 *     I need this wooden part replaced. The grade of the roof …
 *     Lead cost: $51.96
 *     · Travel Preferences: The roofer travels to me
 *
 * So the number every ROI question needs has been in Firestore all along — as
 * a line of prose, which nothing can sum, chart, or subtract from a job. The
 * September 2026 lead audit had to be rebuilt by hand from the Thumbtack
 * payment ledger for exactly this reason.
 *
 * This backfill parses that line into a real numeric field so
 * lead-source-roi.js can divide by it.
 *
 * WHAT IT DOES NOT DO
 * ───────────────────
 * Refunds are NOT in the notes — Thumbtack refunds a lead after the fact and
 * never rewrites the message. So this stamps the GROSS charge. Eight leads in
 * the Jul 31 – Sep 6 2026 window were refunded and need leadCost set to 0 by
 * hand afterwards; the script prints them as a checklist when it finishes.
 * Deliberately manual: matching a refund to a doc by customer name is exactly
 * the kind of fuzzy join that silently zeroes the wrong record.
 *
 * SAFETY
 *   • Dry-run by default — prints what WOULD change, writes nothing.
 *   • --apply requires --yes as well.
 *   • Idempotent — skips any doc that already carries a numeric leadCost > 0.
 *     Only ever FILLS a gap; a hand-entered value is authoritative and is
 *     never overwritten. Safe to re-run.
 *   • A doc with no parseable "Lead cost:" line is left completely alone —
 *     null and 0 mean different things here (10 of 85 leads in the audit
 *     window were genuinely free), so this never writes a speculative zero.
 *   • Also stamps leadCostSource:'notes-backfill' so a parsed value stays
 *     distinguishable from one a human typed into the Lead Cost field.
 *
 * SETUP (per the admin-script-runner pattern — prod nobigdeal-pro via ADC).
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *   export NBD_PROJECT=nobigdeal-pro               # optional override
 *
 * RUN
 *   node scripts/backfill-lead-cost.js               # dry-run
 *   node scripts/backfill-lead-cost.js --apply --yes # actually write
 */

const { initAdmin, getFirestore } = require('./_admin');
const { assertNotCompleted, recordCompletion } = require('./_migration-guard');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const FORCE = args.includes('--force');
const MIGRATION = 'backfill-lead-cost';
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

const PAGE = 500;   // read page size
const BATCH = 400;  // Firestore batch write cap is 500; stay under it

// Refunded in the Jul 31 – Sep 6 2026 window, verified against the Thumbtack
// payment ledger on 2026-09-06. Printed as a checklist, never auto-applied.
//
// FIVE OF THESE CANNOT MATCH A LEAD, AND THAT IS CORRECT — do not "fix" it.
// /thumbtack_leads (the raw ingest) starts 2026-08-16, but this window opens
// 2026-07-31, so the five `missingTargets` in the refund file were billed
// before the integration existed and were never going to be in Firestore.
// They were worked manually and have Drive folders. Investigated and closed
// 2026-09-06; scripts/audit-refund-provenance.js reproduces the finding.
//
// One of the five is the one to be careful with: their surname matches a
// DIFFERENT customer's in the CRM. A surname join zeroes the wrong record.
//
// scripts/apply-lead-cost-refunds.js applies this list under a unique-name AND
// exact-amount AND ingest-prefix guard, and skips loudly rather than guessing.
//
// The list is eight [customer name, amount] pairs, so since 2026-10-06 it lives
// in Jo's private notes folder (lead-cost-refunds.json), not in this public
// repo. Loaded only when the checklist is printed (--data=<file> or
// NBD_REFUNDS_FILE); without it the backfill itself still runs.
const { loadPrivateJson, resolvePrivatePath } = require('./_private-data');
const KNOWN_REFUNDS = resolvePrivatePath({ envVar: 'NBD_REFUNDS_FILE' })
  ? loadPrivateJson({ envVar: 'NBD_REFUNDS_FILE', what: 'the Thumbtack refund list' }).knownRefunds
  : null;

// "Lead cost: $51.96" / "lead cost:51.96" / "Lead Cost: $1,234". Anchored on the
// label so a dollar figure elsewhere in a long notes blob can never match.
const LEAD_COST_RE = /lead\s*cost\s*:\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i;

function parseLeadCost(notes) {
  if (typeof notes !== 'string' || !notes) return null;
  const m = notes.match(LEAD_COST_RE);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  // A negative or absurd figure means the regex caught something that is not a
  // lead fee — leave the doc alone rather than write a number nobody can trust.
  if (!isFinite(n) || n < 0 || n > 5000) return null;
  return Math.round(n * 100) / 100;
}

async function main() {
  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
  }

  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  await assertNotCompleted(MIGRATION, { apply: APPLY, force: FORCE });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Backfill leads.leadCost  (parsed from notes)');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)'));
  console.log('═══════════════════════════════════════════════════════════\n');

  let scanned = 0, alreadyOk = 0, noMatch = 0, toFix = 0, written = 0, failures = 0;
  let totalDollars = 0;

  let batch = db.batch();
  let batchCount = 0;
  async function flush() {
    if (batchCount === 0) return;
    if (APPLY) {
      try {
        await batch.commit();
        written += batchCount;
      } catch (e) {
        failures += batchCount;
        console.warn('! batch commit failed — ' + e.message);
      }
    }
    batch = db.batch();
    batchCount = 0;
  }

  let last = null;
  while (true) {
    let q = db.collection('leads').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() || {};

      // Idempotent: a real value already on the doc wins, whoever put it there.
      const existing = parseFloat(data.leadCost);
      if (isFinite(existing) && existing > 0) { alreadyOk++; continue; }

      const cost = parseLeadCost(data.notes);
      if (cost === null) { noMatch++; continue; }

      toFix++;
      totalDollars += cost;
      if (!APPLY) {
        if (toFix <= 25) {
          const who = [data.firstName, data.lastName].filter(Boolean).join(' ') || doc.id;
          console.log('  would set ' + doc.id + '.leadCost → $' + cost.toFixed(2) + '  (' + who + ')');
        }
        continue;
      }

      batch.set(doc.ref, { leadCost: cost, leadCostSource: 'notes-backfill' }, { merge: true });
      batchCount++;
      if (batchCount >= BATCH) await flush();
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }
  await flush();

  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  scanned            : ' + scanned);
  console.log('  already had a cost : ' + alreadyOk);
  console.log('  no cost line found : ' + noMatch + '  (left untouched — free leads are real)');
  console.log('  parsed             : ' + toFix + '  totalling $' + totalDollars.toFixed(2));
  if (APPLY) {
    console.log('  written            : ' + written);
    if (failures) console.log('  FAILED             : ' + failures);
  }

  console.log('\n  Refunded leads — set leadCost to 0 by hand (gross was stamped):');
  if (KNOWN_REFUNDS) {
    KNOWN_REFUNDS.forEach(function (r) {
      console.log('    [ ] ' + r[0] + '  ($' + r[1].toFixed(2) + ')');
    });
  } else {
    console.log('    (refund list not loaded — pass --data=<lead-cost-refunds.json> or NBD_REFUNDS_FILE)');
  }
  console.log('───────────────────────────────────────────────────────────');

  if (APPLY && !failures) await recordCompletion(MIGRATION);
}

main().catch(function (e) {
  console.error('FATAL — ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
