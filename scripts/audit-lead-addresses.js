/**
 * scripts/audit-lead-addresses.js
 *
 * READ-ONLY AUDIT — classifies the `address` field on every /leads doc and
 * reports what is unusable for addressing a customer document.
 *
 * Background
 * ──────────
 * Before Wave 141, the address autocomplete stored
 * `display_name.split(',').slice(0,3)` — which produced strings like
 * "1054, Klondyke Road, Goshen": a comma after the house number, the full
 * road name instead of the USPS suffix, no ZIP, no 2-letter state, and a
 * Nominatim locality (hamlet / subdivision / township) where the post town
 * belongs. dashboard-ui.js formatMailingAddress() fixed the WRITE path, but
 * the rows written before that cutover still hold the mangled strings.
 *
 * A 2026-08-18 sweep of all 81 pipeline records found 56 addresses that
 * cannot reliably address a document. This script makes that number
 * measurable and re-checkable instead of a one-off finding.
 *
 * CATEGORIES
 *   legacyMangled  Pre-Wave-141 residue: leading number followed by a comma
 *                  ("7003, Greenstone Trace, O'Bannon Creek"). Always wrong.
 *   blank          No address at all.
 *   noStreet       City/ZIP only, no house number — the shape Thumbtack
 *                  hands over before the customer shares their street.
 *                  Not corrupt, but not addressable either.
 *   noZip          Has a street but no 5-digit ZIP.
 *   noState        Has a street but no 2-letter state token.
 *   ok             House number + street + state + ZIP.
 *
 * EXIT CODE
 *   Non-zero when any `legacyMangled` or `blank` address remains, so this
 *   can gate CI and the corruption cannot silently return. `noStreet` does
 *   NOT fail the run — that data is missing, not broken, and only the
 *   customer can supply it.
 *
 * SETUP (admin-script-runner pattern — prod nobigdeal-pro via ADC).
 * firebase-admin comes through scripts/_admin.js, resolving out of
 * functions/node_modules — the same `cd functions && npm ci` install the
 * daily workflow uses. Set no NODE_PATH: it would silently override that
 * single resolver (the v12 pin it once carried is gone; no Timestamps here).
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *   export NBD_PROJECT=nobigdeal-pro               # optional override
 *
 * RUN
 *   node scripts/audit-lead-addresses.js            # summary
 *   node scripts/audit-lead-addresses.js --list     # every offender
 *   node scripts/audit-lead-addresses.js --csv      # machine-readable
 */

const { initAdmin, getFirestore } = require('./_admin');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const CSV = args.includes('--csv');
// This repo is PUBLIC, and so are its Actions logs and job summaries. From
// 2026-08-20 to 2026-09-28 the daily run printed customers' names, street
// addresses and job values into them. On a runner (GITHUB_ACTIONS=true) the
// list is forced down to category + Firestore doc id — enough to open the
// record in NBD Pro — and --csv is refused. There is no flag to undo this in
// CI on purpose. Locally, --redact gives the same output.
const REDACT = process.env.GITHUB_ACTIONS === 'true' || args.includes('--redact');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const PAGE = 500;

// A leading house number immediately followed by a comma. No human types
// this and no correct formatter emits it — it is the pre-Wave-141 signature.
const LEGACY_MANGLED = /^\s*\d+[a-zA-Z]?\s*,/;
// Leading house number (what a real street address starts with).
const HAS_HOUSE_NUMBER = /^\s*\d+[a-zA-Z]?\s+\S/;
const HAS_ZIP = /\b\d{5}(-\d{4})?\b/;
const HAS_STATE = /\b(OH|KY|IN)\b/i;

function classify(addr) {
  const s = String(addr == null ? '' : addr).trim();
  if (!s) return 'blank';
  if (LEGACY_MANGLED.test(s)) return 'legacyMangled';
  if (!HAS_HOUSE_NUMBER.test(s)) return 'noStreet';
  if (!HAS_STATE.test(s)) return 'noState';
  if (!HAS_ZIP.test(s)) return 'noZip';
  return 'ok';
}

async function main() {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  const buckets = { legacyMangled: [], blank: [], notProvided: [], noStreet: [], noState: [], noZip: [], ok: [] };
  let scanned = 0;
  let skipped = 0;   // soft-deleted (deleted === true) — retired, not broken
  let last = null;

  while (true) {
    let q = db.collection('leads').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      // Retired records are not the CRM's working set. The app soft-deletes
      // (deleted: true) rather than destroying rows, so merged duplicates,
      // test records and anything the user removed still sit in the
      // collection. Counting them means this audit can never go green — and a
      // gate that is permanently red is a gate nobody reads. Skipped here, and
      // reported as a separate line so the skip is visible rather than silent.
      if (d.deleted === true) { skipped++; continue; }
      scanned++;
      const name = [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || '(no name)';
      let cls = classify(d.address);
      // A website lead (contact form, booking, marketplace) whose sender gave
      // no address was never corrupted — the form doesn't require one. That is
      // missing data, like noStreet, not the blanking this gate exists to
      // catch; failing on it kept the job red daily from 2026-09-04.
      if (cls === 'blank' && d.webLead === true) cls = 'notProvided';
      buckets[cls].push({
        id: doc.id,
        name,
        address: String(d.address == null ? '' : d.address).trim(),
        jobValue: Number(String(d.jobValue == null ? 0 : d.jobValue).replace(/[^0-9.\-]/g, '')) || 0,
      });
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  if (CSV) {
    if (REDACT) { console.error('--csv prints customer data; refused when redacting (CI or --redact).'); process.exit(2); }
    console.log('category,id,name,jobValue,address');
    for (const k of Object.keys(buckets)) {
      for (const r of buckets[k]) {
        console.log([k, r.id, JSON.stringify(r.name), r.jobValue, JSON.stringify(r.address)].join(','));
      }
    }
    process.exit(0);
  }

  const money = (rows) => rows.reduce((t, r) => t + r.jobValue, 0);
  const pct = (n) => scanned ? ((n / scanned) * 100).toFixed(0) + '%' : '—';

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Lead address audit — project ' + PROJECT);
  console.log('═══════════════════════════════════════════════════════════\n');

  const order = ['legacyMangled', 'blank', 'notProvided', 'noStreet', 'noState', 'noZip', 'ok'];
  const label = {
    legacyMangled: 'BROKEN  pre-Wave-141 mangled',
    blank:         'BROKEN  no address at all',
    notProvided:   'THIN    web lead, none given',
    noStreet:      'THIN    city/ZIP only, no street',
    noState:       'THIN    no state',
    noZip:         'THIN    no ZIP',
    ok:            'OK      complete',
  };
  for (const k of order) {
    const rows = buckets[k];
    console.log(
      '  ' + label[k].padEnd(36) +
      String(rows.length).padStart(4) + '  ' + pct(rows.length).padStart(5) +
      (REDACT ? '' : '   $' + money(rows).toLocaleString())
    );
  }
  console.log('\n  scanned: ' + scanned +
    (skipped ? '   (plus ' + skipped + ' retired/soft-deleted, not counted)' : ''));

  if (LIST) {
    for (const k of order) {
      if (k === 'ok' || !buckets[k].length) continue;
      console.log('\n─── ' + label[k] + ' ───');
      for (const r of buckets[k].sort((a, b) => b.jobValue - a.jobValue)) {
        if (REDACT) { console.log('  ' + r.id); continue; }
        console.log('  ' + r.id + '  ' + r.name.padEnd(28) +
          ('$' + r.jobValue.toLocaleString()).padStart(12) + '   ' +
          (r.address || '(blank)'));
      }
    }
  } else {
    console.log('  (re-run with --list to see every offender, --csv to export)');
  }

  const hardFails = buckets.legacyMangled.length + buckets.blank.length;
  console.log('\n───────────────────────────────────────────────────────────');
  if (hardFails) {
    console.log('  FAIL — ' + hardFails + ' address(es) are broken, not merely thin.');
  } else {
    console.log('  PASS — no mangled or blank addresses remain.');
  }
  console.log('───────────────────────────────────────────────────────────');

  process.exit(hardFails > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
