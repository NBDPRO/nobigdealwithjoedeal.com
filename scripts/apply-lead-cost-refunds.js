/**
 * scripts/apply-lead-cost-refunds.js
 *
 * Zeroes `leadCost` on the leads Thumbtack refunded, and records that it was a
 * refund rather than a free lead.
 *
 * WHY THIS IS A SEPARATE SCRIPT
 * ─────────────────────────────
 * backfill-lead-cost.js stamps the GROSS charge, because that is what the
 * notes blob carries — Thumbtack refunds a lead after the fact and never
 * rewrites the message. It prints the refunds as a checklist and refuses to
 * apply them, on the reasoning that matching a refund to a doc by customer
 * name is the kind of fuzzy join that silently zeroes the wrong record.
 *
 * That reasoning is right about the danger and wrong about the conclusion: a
 * fuzzy join is unsafe, but a join that REFUSES TO GUESS is not. This applies
 * the same list under three conditions, and skips loudly if any of them fails:
 *
 *   1. Exactly ONE lead in this company matches the name. Zero or two → skip.
 *   2. That lead's stored leadCost equals the refunded amount to the cent.
 *      A mismatch means the name matched the wrong record, or the gross was
 *      never stamped — either way, do not touch it.
 *   3. The doc carries the `thumbtack_leads__` ingest prefix. A refund only
 *      exists for a lead Thumbtack actually billed.
 *
 * Skipping is the safe outcome and is always reported. Nothing is inferred.
 *
 * WHY IT MATTERS
 * ──────────────
 * The eight refunds total more than the whole $1,010.96 the backfill stamped.
 * Leaving the gross in place does not make cost-per-lead slightly wrong — it
 * makes it wrong by more than 100%, which is worse than having no number,
 * because a wrong number gets trusted.
 *
 * `leadCost: 0` alone would be a lie of a different kind — it reads identical
 * to a genuinely free lead, and the backfill is careful to keep those
 * distinct. So this also writes `leadCostRefunded: true` and the original
 * gross in `leadCostGross`, and marks `leadCostSource:'refund-applied'`.
 * Nothing is destroyed; the refund is recorded as an event, not an erasure.
 *
 * SAFETY
 *   • Dry-run by default. --apply requires --yes as well.
 *   • --company is REQUIRED. /leads is multi-tenant — see
 *     scripts/normalize-lead-source.js for what an unscoped write nearly did.
 *   • Idempotent — a doc already carrying leadCostRefunded is skipped.
 *
 * RUN  (NBD's own companyId is 1phDvAVXHSg82wDLegAbQFq14Ci1)
 *   node scripts/apply-lead-cost-refunds.js --company=<id> --data=<lead-cost-refunds.json>
 *   node scripts/apply-lead-cost-refunds.js --company=<id> --data=<file> --apply --yes
 */
'use strict';

const { initAdmin, getFirestore } = require('./_admin');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const PREFIX = 'thumbtack_leads__';

// Verified against the Thumbtack payment ledger 2026-09-06: eight [name, amount]
// pairs. They are customer names, and this repo is public, so since 2026-10-06
// the list lives in Jo's private notes folder (lead-cost-refunds.json, the same
// file backfill-lead-cost.js reads). Pass --data=<file> or NBD_REFUNDS_FILE.
const { loadPrivateJson } = require('./_private-data');
const KNOWN_REFUNDS = loadPrivateJson({ envVar: 'NBD_REFUNDS_FILE', what: 'the Thumbtack refund list' }).knownRefunds;

if (APPLY && !YES) {
  console.error('--apply also requires --yes. Refusing to write.');
  process.exit(2);
}
const COMPANY = (args.find((a) => a.startsWith('--company=')) || '').split('=')[1] || '';
if (!COMPANY) {
  console.error('\n  --company=<companyId> is REQUIRED. /leads is multi-tenant.\n');
  process.exit(2);
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const cents = (n) => Math.round(Number(n) * 100);

(async () => {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  console.log('');
  console.log('═'.repeat(64));
  console.log('Apply Thumbtack refunds to leads.leadCost');
  console.log(`  project : ${PROJECT}`);
  console.log(`  mode    : ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)'}`);
  console.log(`  company : ${COMPANY}`);
  console.log('═'.repeat(64));
  console.log('');

  const snap = await db.collection('leads').where('companyId', '==', COMPANY).get();

  // Index by normalized full name so a duplicate is visible, not silently
  // resolved to whichever doc happened to come back first.
  const byName = new Map();
  snap.forEach((d) => {
    const x = d.data() || {};
    const name = norm([x.firstName, x.lastName].filter(Boolean).join(' ') || x.name);
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ ref: d.ref, id: d.id, data: x });
  });

  const todo = [];
  const skipped = [];

  KNOWN_REFUNDS.forEach(([name, amount]) => {
    const hits = byName.get(norm(name)) || [];
    if (hits.length === 0) return skipped.push([name, amount, 'no lead with that name']);
    if (hits.length > 1)  return skipped.push([name, amount, `${hits.length} leads share that name — ambiguous`]);

    const hit = hits[0];
    if (!hit.id.startsWith(PREFIX)) {
      return skipped.push([name, amount, 'not a Thumbtack-ingested doc']);
    }
    if (hit.data.leadCostRefunded === true) {
      return skipped.push([name, amount, 'already applied']);
    }
    const stored = hit.data.leadCost;
    if (stored == null) {
      return skipped.push([name, amount, 'no leadCost stamped — run the backfill first']);
    }
    if (cents(stored) !== cents(amount)) {
      return skipped.push([name, amount, `stored leadCost is $${stored}, not $${amount} — WRONG RECORD?`]);
    }
    todo.push({ ref: hit.ref, id: hit.id, name, amount });
  });

  console.log('=== would zero ===');
  todo.forEach((t) => console.log(`  ${t.name.padEnd(22)} $${t.amount.toFixed(2).padStart(7)}   ${t.id}`));
  if (!todo.length) console.log('  (none)');

  if (skipped.length) {
    console.log('');
    console.log('=== SKIPPED — untouched, needs a human ===');
    skipped.forEach(([n, a, why]) => console.log(`  ${n.padEnd(22)} $${a.toFixed(2).padStart(7)}   ${why}`));
  }

  const total = todo.reduce((s, t) => s + t.amount, 0);
  console.log('');
  console.log(`  ${todo.length} of ${KNOWN_REFUNDS.length} refunds matched, $${total.toFixed(2)} to be netted out.`);

  if (!todo.length) { console.log(''); process.exit(0); }

  if (APPLY) {
    const batch = db.batch();
    todo.forEach((t) => batch.update(t.ref, {
      leadCost: 0,
      leadCostGross: t.amount,      // keep the original — nothing is destroyed
      leadCostRefunded: true,       // a refund, NOT a free lead
      leadCostSource: 'refund-applied',
    }));
    await batch.commit();
    console.log('');
    console.log(`  WROTE ${todo.length} docs.`);
  } else {
    console.log('  Nothing was written. Re-run with --apply --yes.');
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
