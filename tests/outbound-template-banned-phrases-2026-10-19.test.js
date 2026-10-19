/**
 * tests/outbound-template-banned-phrases-2026-10-19.test.js
 *
 * No NEW outbound template can carry banned wording. Phrases (Kentucky
 * insurance-job law, independent-subcontractor crews, "fully insured" not
 * "licensed"): "we handle ...", "documents damage free before you call
 * insurance", "exactly what homeowners insurance is meant to cover", "handle
 * everything from the first inspection", "in-house", "W-2", "licensed".
 *
 * This test never edits legal wording. The wording that ALREADY exists is
 * pinned in KNOWN_PENDING_REVIEW below (file + phrase + exact count) for Jo /
 * counsel to decide (documentation/audit/MESSAGING-TEMPLATE-REVIEW-2026-10-19.md).
 * A RATCHET: an extra occurrence fails; so does a pinned entry that no longer
 * exists (remove it from the list in the same change that fixes the wording).
 *
 *   node tests/outbound-template-banned-phrases-2026-10-19.test.js          run
 *   node tests/outbound-template-banned-phrases-2026-10-19.test.js --table  print the review table (markdown)
 */
'use strict';
const S = require('./lib/outbound-template-scan');

// file -> phrase id -> exact count currently present, awaiting a decision.
const KNOWN_PENDING_REVIEW = {
  'functions/storm-watch.js': { damage_free_before_insurance: 1 },        // also the carrier-REGISTERED storm sample #2: change both together
  'functions/storm-report-email.js': { insurance_meant_to_cover: 1 },
  'docs/pro/js/document-generator-templates.js': { we_handle: 2, handle_everything: 1 },
  'docs/pro/js/document-generator-library.js': { licensed: 1 },           // "a licensed public adjuster" (names who CAN do it): likely fine, counsel to confirm
};

if (process.argv.includes('--table')) {
  const rows = ['| File | Line | Phrase | Why flagged | Text |', '|---|---|---|---|---|'];
  for (const f of S.TEMPLATE_FILES) {
    for (const h of S.scanFile(f)) {
      const p = S.PHRASES.find((x) => x.id === h.id);
      rows.push('| `' + f + '` | ' + h.line + ' | ' + h.id + ' | ' + p.why + ' | ' + h.text.replace(/\|/g, '\\|') + ' |');
    }
  }
  console.log(rows.join('\n'));
  process.exit(0);
}

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Positive controls: the scanner CAN see each phrase, and ignores comments.
const SAMPLES = {
  we_handle: 'const t = "Relax, we handle the paperwork";',
  damage_free_before_insurance: "const t = 'Joe documents damage free before you call insurance';",
  insurance_meant_to_cover: 'const t = `exactly what homeowners insurance is meant to cover`;',
  handle_everything: 'const t = "We handle everything from the first inspection to the final nail";',
  in_house: 'const t = "our in-house crew";',
  w2: 'const t = "all W-2 employees";',
  licensed: 'const t = "fully licensed and insured";',
};
for (const p of S.PHRASES) {
  const hits = S.scanSource(SAMPLES[p.id]);
  ok('scanner sees "' + p.id + '"', hits.some((h) => h.id === p.id), JSON.stringify(hits));
}
ok('scanner ignores a phrase that only appears in a // comment', S.scanSource('// never say we handle the claim\nconst a = 1;').length === 0);
ok('scanner ignores a phrase that only appears in a /* */ comment', S.scanSource('/* in-house, W-2, licensed */ const a = 1;').length === 0);
ok('"we\'ll handle" is caught', S.scanSource("const t = \"We'll handle it\";").some((h) => h.id === 'we_handle'));
ok('a safe sentence is clean', S.scanSource('const t = "We are fully insured and use independent crews.";').length === 0);

// The real templates.
for (const f of S.TEMPLATE_FILES) {
  let hits;
  try { hits = S.scanFile(f); } catch (e) { ok(f + ' is readable', false, e.message); continue; }
  const counts = {};
  hits.forEach((h) => { counts[h.id] = (counts[h.id] || 0) + 1; });
  const pinned = KNOWN_PENDING_REVIEW[f] || {};
  for (const p of S.PHRASES) {
    const have = counts[p.id] || 0;
    const allowed = pinned[p.id] || 0;
    if (have > allowed) {
      ok(f + ': "' + p.id + '" x' + have + ' (allowed ' + allowed + ')', false,
        hits.filter((h) => h.id === p.id).map((h) => 'line ' + h.line + ': ' + h.text).join(' || '));
    } else if (have < allowed) {
      ok(f + ': pinned "' + p.id + '" no longer present (' + have + ' < ' + allowed + ') — remove it from KNOWN_PENDING_REVIEW', false);
    }
  }
}
for (const f of Object.keys(KNOWN_PENDING_REVIEW)) {
  ok('pinned file is a scanned template file: ' + f, S.TEMPLATE_FILES.indexOf(f) !== -1);
}
ok('no banned wording beyond the pinned review list', failed === 0);

// No sender can ship unclassified.
const unclassified = S.discoverSenders().filter((x) => !x.known && S.INTERNAL_SENDERS.indexOf(x.rel) === -1).map((x) => x.rel);
ok('every functions/ file that sends mail/texts is a scanned template or a listed internal sender', unclassified.length === 0, unclassified.join(', '));
ok('internal-sender list has no stale entries', S.INTERNAL_SENDERS.every((rel) => S.discoverSenders().some((x) => x.rel === rel)),
  S.INTERNAL_SENDERS.filter((rel) => !S.discoverSenders().some((x) => x.rel === rel)).join(', '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
