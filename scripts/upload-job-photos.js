#!/usr/bin/env node
/**
 * scripts/upload-job-photos.js
 *
 * Files approved job-site photos into the CRM: Storage at
 * photos/{uid}/{leadId}/{id}_standard.jpg (+ thumbs/), and a /photos/{id} doc in
 * the shape docs/pro/js/photo-engine.js writes, with source 'photo-match'.
 * Pure logic lives in scripts/lib/photo-upload.js (pinned by
 * tests/upload-job-photos-2026-11-10.test.js). Plan:
 * documentation/projects/CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md section 1.
 *
 * INPUT  --manifest <csv> with columns:
 *   lead_id, source, jpeg, thumb, phase, taken_at, lat, lng, bytes
 * (built outside the repo from review.csv; it holds customer ids, never commit it).
 *
 * SAFETY (CLAUDE.md rule f)
 *   - Dry run by default: reads only the local manifest and files, prints counts.
 *     It touches no network and no Firestore.
 *   - --apply needs --yes AND --company=<id>. Run it yourself, in your own terminal,
 *     with your own Google credentials (gcloud application-default login).
 *   - Never overwrites: an existing /photos/{id} is skipped, so rep edits survive a rerun.
 *   - A lead in another company, or not found, is skipped and counted, never guessed.
 *   - Output is counts only.
 *
 * RUN
 *   node scripts/upload-job-photos.js --manifest <csv> --company=<id>            # dry run
 *   node scripts/upload-job-photos.js --manifest <csv> --company=<id> --apply --yes
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const U = require('./lib/photo-upload.js');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const a = args.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : (args.includes(n) ? args[args.indexOf(n) + 1] : ''); };
const APPLY = flag('--apply');
const YES = flag('--yes');
const COMPANY = val('--company');
const MANIFEST = val('--manifest');
const LIMIT = Number(val('--limit')) || 0;   // --limit=N uploads only the first N (a small first run)
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const BUCKET = process.env.NBD_BUCKET || 'nobigdeal-pro.firebasestorage.app';

function parseCsv(s) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f.replace(/\r$/, '')); rows.push(r); r = []; f = ''; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}

function readManifest(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const h = rows.shift();
  return rows.filter((x) => x.length >= h.length).map((x) => { const o = {}; h.forEach((k, i) => { o[k] = x[i]; }); return o; });
}

async function main() {
  if (flag('--help') || !MANIFEST) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[/ *]+/gm, '')); return; }
  if (!COMPANY) throw new Error('--company=<id> is required (/leads is multi-tenant)');
  if (APPLY && !YES) throw new Error('--apply needs --yes');
  const rows = readManifest(MANIFEST);

  if (!APPLY) {
    // Local-only dry run: no leads known yet, so every lead is treated as in this company.
    const leads = {}; rows.forEach((r) => { leads[r.lead_id] = { uid: 'DRYRUN', companyId: COMPANY }; });
    const plan = U.planUpload(rows, { leads, company: COMPANY, fileExists: fs.existsSync, existingIds: new Set() });
    const s = U.summarizePlan(plan);
    s.mode = 'dry-run (local only; no lead lookup, no upload)';
    s.mb = Math.round(s.bytes / 1e6);
    console.log(JSON.stringify(s, null, 2));
    console.log('Nothing uploaded. Run with --apply --yes in your own terminal to file these.');
    return;
  }

  const { initAdmin, getFirestore, getStorage } = require('./_admin');
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  const bucket = getStorage().bucket(BUCKET);

  // Resolve leads and existing photo ids from the live CRM.
  // The CRM export's "Customer ID" is a display id (NBD-0367) stored in the lead's customerId
  // field. Exactly one match, inside this company, or the lead is skipped (never guessed).
  const leads = {};
  for (const id of new Set(rows.map((r) => r.lead_id))) {
    const s = await db.collection('leads').where('customerId', '==', id).where('companyId', '==', COMPANY).get();
    if (s.size !== 1) continue;
    const d = s.docs[0];
    const x = d.data() || {};
    if (x.deleted === true || !x.userId) continue;
    leads[id] = { docId: d.id, uid: x.userId, companyId: x.companyId, lat: Number(x.lat), lng: Number(x.lng) };
  }
  const existingIds = new Set();
  for (const r of rows) {
    if (!leads[r.lead_id]) continue;
    const id = U.photoIdFor(leads[r.lead_id].docId, r.source);
    if ((await db.collection('photos').doc(id).get()).exists) existingIds.add(id);
  }
  let plan = U.planUpload(rows, { leads, company: COMPANY, fileExists: fs.existsSync, existingIds });
  if (LIMIT > 0) plan = { toUpload: plan.toUpload.slice(0, LIMIT), skipped: plan.skipped };
  console.log(JSON.stringify(Object.assign(U.summarizePlan(plan), { mode: 'apply' }), null, 2));

  let ok = 0, failed = 0;
  for (const p of plan.toUpload) {
    try {
      const { photoPath, thumbPath } = U.buildPaths(p.uid, p.leadId, p.id);
      const tok1 = crypto.randomUUID(), tok2 = crypto.randomUUID();
      await bucket.upload(p.row.jpeg, { destination: photoPath, metadata: { contentType: 'image/jpeg', metadata: { firebaseStorageDownloadTokens: tok1 } } });
      await bucket.upload(p.row.thumb, { destination: thumbPath, metadata: { contentType: 'image/jpeg', metadata: { firebaseStorageDownloadTokens: tok2 } } });
      const dl = (path, tok) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${tok}`;
      const doc = U.buildPhotoDoc({
        id: p.id, leadId: p.leadId, uid: p.uid, companyId: p.companyId,
        url: dl(photoPath, tok1), thumbUrl: dl(thumbPath, tok2),
        phase: p.row.phase, takenAt: p.row.taken_at,
        lat: p.row.lat === '' ? null : Number(p.row.lat), lng: p.row.lng === '' ? null : Number(p.row.lng),
        fileSize: fs.statSync(p.row.jpeg).size, lead: leads[p.leadId]
      });
      const now = new Date();
      // create() fails if the doc appeared meanwhile: nothing is overwritten.
      await db.collection('photos').doc(p.id).create(Object.assign(doc, { createdAt: now, uploadedAt: now }));
      ok++;
      if (ok % 25 === 0) console.log('  ... ' + ok + '/' + plan.toUpload.length);
    } catch (e) {
      failed++;
      console.error('  FAILED one photo: ' + String(e && e.message || e).slice(0, 120));
    }
  }
  console.log(JSON.stringify({ uploaded: ok, failed }));
}

if (require.main === module) main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
module.exports = { readManifest, parseCsv };
