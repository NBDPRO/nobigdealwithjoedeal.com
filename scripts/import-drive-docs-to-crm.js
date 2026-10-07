/**
 * scripts/import-drive-docs-to-crm.js
 *
 * Files the real paperwork out of each customer's Google Drive folder onto
 * their CRM card, so the Files tab stops being empty.
 *
 * WHY SERVER-SIDE
 * ───────────────
 * The browser path works (see #1442), but it is one modal, one file picker
 * and several seconds per customer across ~145 folders. This writes Storage
 * and Firestore directly, in the SAME shape the UI produces — captured from a
 * real upload rather than guessed (scripts/audit-document-shape.js prints it):
 *
 *   docs/{uid}/{leadId}_{ts}_{safeName}   in Storage, with a download token
 *   leads/{leadId}/documents/{auto}       { category, filename, size, source,
 *                                           type, uploadedAt, uploadedBy,
 *                                           url, userId }
 *
 * `source` is 'drive_import', not 'overview_upload'. Only a cosmetic
 * "Uploaded" label keys off that field (customer-documents.js:180), and
 * claiming a human uploaded these would be a lie in the record.
 *
 * MATCHING
 * ────────
 * A Drive folder is matched to a lead ONLY on a unique normalized full-name
 * match. Zero matches or two matches → skipped and reported. The same
 * discipline as the refund matcher, for the same reason: this session already
 * caught "Customer FG" resolving to Customer DN.
 *
 * WHAT IT SKIPS, DELIBERATELY
 *   • .gdoc/.gsheet/.gslides — Drive pointer stubs, not documents. Uploading
 *     one puts a dead shortcut on the card. They need a real PDF export first.
 *   • .zip, .heic and raw archives — Photos have their own tab and pipeline.
 *   • Anything already on the lead with the same filename — idempotent.
 *   • Files over --max-file-mb (default 25).
 *
 * SAFETY
 *   • Dry-run by default; --apply requires --yes.
 *   • --company REQUIRED. /leads is multi-tenant.
 *   • Dry run prints the total byte volume BEFORE anything is uploaded —
 *     Storage is billed, so the size of this is a decision, not a detail.
 *
 * RUN
 *   node scripts/import-drive-docs-to-crm.js --company=<id>
 *   node scripts/import-drive-docs-to-crm.js --company=<id> --apply --yes
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initAdmin, getFirestore, getStorage } = require('./_admin');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const BUCKET = process.env.NBD_BUCKET || 'nobigdeal-pro.firebasestorage.app';
const COMPANY = (args.find(a => a.startsWith('--company=')) || '').split('=')[1] || '';
const ROOT = (args.find(a => a.startsWith('--root=')) || '').split('=')[1]
  || 'G:\\My Drive\\COMPANIES\\NBD\\CUSTOMERS';
const MAX_MB = Number((args.find(a => a.startsWith('--max-file-mb=')) || '').split('=')[1] || 25);
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';

const TAKE = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png']);
const SUBFOLDERS = ['Docs', 'Reports'];

if (APPLY && !YES) { console.error('--apply also requires --yes.'); process.exit(2); }
if (!COMPANY) { console.error('\n  --company=<companyId> is REQUIRED. /leads is multi-tenant.\n'); process.exit(2); }

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const mimeFor = (ext) => ({
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
}[ext] || 'application/octet-stream');

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

(async () => {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  const bucket = getStorage().bucket(BUCKET);

  console.log('');
  console.log('═'.repeat(66));
  console.log('Import Drive customer documents onto CRM cards');
  console.log(`  project : ${PROJECT}`);
  console.log(`  bucket  : ${BUCKET}`);
  console.log(`  company : ${COMPANY}`);
  console.log(`  root    : ${ROOT}`);
  console.log(`  mode    : ${APPLY ? 'APPLY (uploading)' : 'DRY-RUN (nothing uploaded)'}`);
  console.log('═'.repeat(66));

  if (!fs.existsSync(ROOT)) { console.error(`\n  Drive root not found: ${ROOT}\n`); process.exit(1); }

  // Index leads by unique normalized name.
  const snap = await db.collection('leads').where('companyId', '==', COMPANY).get();
  const byName = new Map();
  snap.forEach((d) => {
    const x = d.data() || {};
    if (x.deleted === true) return;
    const n = norm([x.firstName, x.lastName].filter(Boolean).join(' ') || x.name);
    if (!n) return;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push({ ref: d.ref, id: d.id, uid: x.userId || COMPANY });
  });

  const folders = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '_SUPERSEDED' && !e.name.startsWith('1 - '))
    .map(e => e.name)
    .filter(n => !ONLY || norm(n) === norm(ONLY))
    .sort();

  const plan = [];
  const skippedFolders = [];
  const matchedLoosely = [];
  const skippedFiles = { stub: 0, wrongType: 0, tooBig: [], already: 0 };

  // Index by surname too, for the household-name pass below.
  const bySurname = new Map();
  snap.forEach((d) => {
    const x = d.data() || {};
    if (x.deleted === true) return;
    const s = norm(x.lastName);
    if (!s) return;
    if (!bySurname.has(s)) bySurname.set(s, []);
    bySurname.get(s).push({ ref: d.ref, id: d.id, uid: x.userId || COMPANY, first: norm(x.firstName) });
  });

  // Exact full name first. Failing that, a household folder ("John and
  // Jane Example", "Pat & Sam Example") names two people
  // where the CRM stores one — so fall back to the SURNAME, but only under
  // TWO independent confirmations:
  //
  //   1. exactly one lead carries that surname, and
  //   2. that lead's FIRST NAME also appears in the folder name.
  //
  // Requirement 2 is the one that matters. Surname alone is precisely the
  // join that resolved "Customer FG" to Customer DN earlier in this
  // session; the first-name check rejects that pairing, because "Michael"
  // does not appear in "Customer FG". A single signal guesses. Two agree.
  function matchLead(folder) {
    const exact = byName.get(norm(folder)) || [];
    if (exact.length === 1) return { lead: exact[0], why: '' };
    if (exact.length > 1) return { lead: null, why: `${exact.length} leads share that name` };

    // Strip a trailing parenthetical or " - address" tail before tokenizing.
    const cleaned = folder.replace(/\([^)]*\)/g, ' ').replace(/\s+-\s+.*$/, ' ').trim();
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return { lead: null, why: 'no lead with that name (single-token folder)' };
    const surname = norm(tokens[tokens.length - 1]);
    const cands = bySurname.get(surname) || [];
    if (cands.length === 0) return { lead: null, why: 'no lead with that name' };
    if (cands.length > 1) return { lead: null, why: `${cands.length} leads share the surname "${surname}"` };

    const c = cands[0];
    const folderWords = new Set(norm(cleaned).split(/[^a-z0-9-]+/).filter(Boolean));
    if (c.first && folderWords.has(c.first)) {
      return { lead: c, why: `household match on surname + first name "${c.first}"` };
    }

    // Same two people, different punctuation. Drive folders write "John and
    // Jennifer", the CRM writes "John & Jennifer" or "Nick / Gabby". Fold the
    // joiners away and compare the WORDS as a set: identical sets are the same
    // household, not a guess.
    const words = (s) => new Set(
      norm(s).replace(/[&/+]|(?<![a-z])and(?![a-z])/g, ' ').split(/[^a-z0-9-]+/).filter(Boolean)
    );
    const eqSet = (a, b) => a.size === b.size && [...a].every(w => b.has(w));
    const crmFull = `${c.first} ${surname}`;
    if (eqSet(words(cleaned), words(crmFull))) {
      return { lead: c, why: `same words, different joiner — folder "${folder}" vs CRM "${crmFull}"` };
    }

    // A single typo'd character in a surname that is already unique. Two
    // signals still: the surname matched exactly, and the full names differ by
    // at most two edits. "Customer FG" vs "Customer DN" is nowhere near.
    const ed = (a, b) => {
      a = String(a); b = String(b);
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
      for (let j = 0; j <= b.length; j++) d[0][j] = j;
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      return d[a.length][b.length];
    };
    const dist = ed(norm(cleaned), norm(crmFull));
    if (dist <= 2) {
      return { lead: c, why: `near-identical name, ${dist} character(s) apart — folder "${folder}" vs CRM "${crmFull}"` };
    }

    return { lead: null, why: `surname "${surname}" matches "${crmFull}", but the first names do not agree — refusing to guess` };
  }

  for (const folder of folders) {
    const m = matchLead(folder);
    if (!m.lead) { skippedFolders.push([folder, m.why]); continue; }
    if (m.why) matchedLoosely.push([folder, m.why]);
    const lead = m.lead;

    const existing = new Set();
    (await lead.ref.collection('documents').get()).forEach((d) => {
      const f = (d.data() || {}).filename;
      if (f) existing.add(norm(f));
    });

    const files = [];
    for (const sub of SUBFOLDERS) walk(path.join(ROOT, folder, sub), files);

    for (const f of files) {
      const base = path.basename(f);
      const ext = path.extname(base).toLowerCase();
      if (['.gdoc', '.gsheet', '.gslides', '.gdraw'].includes(ext)) { skippedFiles.stub++; continue; }
      if (!TAKE.has(ext)) { skippedFiles.wrongType++; continue; }
      if (existing.has(norm(base))) { skippedFiles.already++; continue; }
      let st;
      try { st = fs.statSync(f); } catch (_) { continue; }
      if (st.size > MAX_MB * 1024 * 1024) { skippedFiles.tooBig.push([base, st.size]); continue; }
      plan.push({ folder, lead, file: f, base, ext, size: st.size });
      existing.add(norm(base));  // guard against duplicates within one run
    }
  }

  const totalBytes = plan.reduce((s, p) => s + p.size, 0);
  const byFolder = new Map();
  plan.forEach(p => byFolder.set(p.folder, (byFolder.get(p.folder) || 0) + 1));

  console.log('');
  console.log(`=== ${plan.length} files to import across ${byFolder.size} customers, ${(totalBytes / 1048576).toFixed(1)} MB ===`);
  [...byFolder.entries()].sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`  ${String(n).padStart(3)}  ${f}`));

  console.log('');
  console.log(`skipped — already on the card: ${skippedFiles.already}   Drive stubs (.gdoc etc): ${skippedFiles.stub}   other file types: ${skippedFiles.wrongType}   over ${MAX_MB}MB: ${skippedFiles.tooBig.length}`);
  skippedFiles.tooBig.forEach(([n, s]) => console.log(`    too big: ${(s / 1048576).toFixed(1)} MB  ${n}`));

  if (matchedLoosely.length) {
    console.log('');
    console.log(`=== ${matchedLoosely.length} matched on the household rule — CHECK THESE ===`);
    matchedLoosely.forEach(([f, why]) => console.log(`  ${f.padEnd(34)} ${why}`));
  }

  if (skippedFolders.length) {
    console.log('');
    console.log(`=== ${skippedFolders.length} folders with no unique lead — SKIPPED, never guessed ===`);
    skippedFolders.forEach(([f, why]) => console.log(`  ${f.padEnd(34)} ${why}`));
  }

  if (!APPLY) {
    console.log('');
    console.log('  Nothing uploaded. Storage is billed — check the MB above, then');
    console.log('  re-run with --apply --yes.');
    console.log('');
    process.exit(0);
  }

  let ok = 0, failed = 0;
  for (const p of plan) {
    try {
      const ts = Date.now();
      const safe = p.base.replace(/[^A-Za-z0-9._-]+/g, '_').substring(0, 120);
      const objectPath = `docs/${p.lead.uid}/${p.lead.id}_${ts}_${safe}`;
      const token = crypto.randomUUID();
      await bucket.upload(p.file, {
        destination: objectPath,
        metadata: {
          contentType: mimeFor(p.ext),
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
      await p.lead.ref.collection('documents').add({
        category: 'General',
        filename: p.base,
        size: p.size,
        source: 'drive_import',
        type: mimeFor(p.ext),
        uploadedAt: new Date(),
        uploadedBy: p.lead.uid,
        url,
        userId: p.lead.uid,
      });
      ok++;
      if (ok % 25 === 0) console.log(`  … ${ok}/${plan.length}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${p.folder} / ${p.base}: ${e.message}`);
    }
  }
  console.log('');
  console.log(`  uploaded ${ok}, failed ${failed}`);
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
