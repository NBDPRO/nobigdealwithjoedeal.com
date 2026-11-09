#!/usr/bin/env node
/**
 * scripts/match-job-photos.js
 *
 * Finds job-site photos in local photo folders (iCloud Photos for Windows,
 * Google Drive / Takeout, camera-roll exports) and matches them to NBD leads.
 * Plan: documentation/projects/CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md
 * section 1. Scoring lives in scripts/lib/photo-match.js (pinned by
 * tests/match-job-photos-2026-11-09.test.js).
 *
 * DRY RUN ONLY in this build. It reads photos and leads and writes a review
 * CSV plus a script-free HTML contact sheet to --out (default
 * Documents\nbd-photo-review, OUTSIDE the repo). It writes nothing to Firestore
 * or Storage. The --apply step (upload approved rows) is added only after Jo
 * has reviewed a dry run; it will need his OK for that run (CLAUDE.md rule f).
 *
 * Leads come from ONE of:
 *   --leads <file.json>   an export: [{ id, address, name?, lat?, lng?, stageDates:{stage:ISO} }]
 *   token mode            NBD_ACCESS_TOKEN env var (read-only collection-group read of leads);
 *                         add --company=<id>. The token is never printed or written.
 *
 * Usage:
 *   node scripts/match-job-photos.js --help
 *   node scripts/match-job-photos.js --photos "<dir>" [--photos "<dir2>"] --leads leads.json [--out <dir>] [--year 2026]
 *
 * Chat-safe output: counts only. Names and addresses stay in the local files.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const M = require('./lib/photo-match.js');

const HELP = `match-job-photos (dry run)
  --photos <dir>      photo folder, repeatable (required)
  --leads <file>      leads export JSON (or use NBD_ACCESS_TOKEN + --company=<id>)
  --out <dir>         output folder, default ~/Documents/nbd-photo-review (must be outside the repo)
  --year <yyyy>       only photos taken in this year, default 2026
  --project <id>      Firebase project for token mode, default nobigdeal-pro
Writes review.csv and review.html to --out. Writes nothing to Firestore or Storage.`;

const IMG = /\.(jpe?g|heic|heif|png)$/i;

function parseArgs(argv) {
  const o = { photos: [], year: 2026, project: process.env.NBD_PROJECT || 'nobigdeal-pro' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) throw new Error(a + ' needs a value'); return v; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--photos') o.photos.push(val());
    else if (a === '--leads') o.leads = val();
    else if (a === '--out') o.out = val();
    else if (a === '--year') o.year = Number(val());
    else if (a === '--project') o.project = val();
    else if (a.startsWith('--company=')) o.company = a.split('=')[1];
    else if (a === '--apply' || a === '--write') o.apply = true;
    else throw new Error('unknown argument: ' + a);
  }
  return o;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (IMG.test(e.name)) yield p;
  }
}

// stageHistory [{ to, timestamp, backfill?, completedOn? }] -> { stage: earliest ISO }
function stageDatesFromHistory(h) {
  const out = {};
  for (const x of Array.isArray(h) ? h : []) {
    if (!x || !x.to || typeof x.timestamp !== 'string') continue;
    const when = (x.backfill === true && /^\d{4}-\d{2}-\d{2}$/.test(x.completedOn || '')) ? x.completedOn + 'T12:00:00.000Z' : x.timestamp;
    if (!(x.to in out) || when < out[x.to]) out[x.to] = when;
  }
  return out;
}

async function loadLeads(o) {
  if (o.leads) return JSON.parse(fs.readFileSync(o.leads, 'utf8'));
  const token = process.env.NBD_ACCESS_TOKEN;
  if (!token) throw new Error('give --leads <file> or set NBD_ACCESS_TOKEN (token mode)');
  if (!o.company) throw new Error('token mode needs --company=<id>');
  const { restFirestore } = require('./_firestore-rest.js');
  const db = restFirestore({ projectId: o.project, token });
  const docs = [];
  let last = null;
  for (;;) {                                   // page by document name, 300 at a time
    let q = db.collectionGroup('leads').orderBy('__name__').limit(300);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    docs.push(...snap.docs);
    if (snap.docs.length < 300) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return docs.map(d => ({ id: d.id, data: d.data() }))
    .filter(d => d.data && d.data.companyId === o.company)
    .map(d => ({
      id: d.id,
      name: [d.data.firstName, d.data.lastName].filter(Boolean).join(' ') || d.data.name || '',
      address: d.data.address || d.data.propertyAddress || '',
      lat: Number(d.data.lat), lng: Number(d.data.lng),
      stageDates: stageDatesFromHistory(d.data.stageHistory)
    }));
}

async function loadExifr() {
  const file = path.join(__dirname, '..', 'docs', 'assets', 'vendor', 'exifr', 'exifr.esm.mjs');
  const mod = await import(pathToFileURL(file).href);
  return mod.default || mod;
}

async function scan(dirs, cachePath, year) {
  const exifr = await loadExifr();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) { /* first run */ }
  const photos = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const p of walk(dir)) {
      scanned++;
      const st = fs.statSync(p);
      const key = p + '|' + st.size + '|' + st.mtimeMs;
      if (!cache[key]) {
        let ex = null;
        try { ex = await exifr.parse(p, { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'] }); } catch (_) { /* unreadable: keep file date */ }
        const d = ex && (ex.DateTimeOriginal || ex.CreateDate);
        cache[key] = {
          takenAt: d instanceof Date ? d.toISOString() : null,
          lat: ex && Number.isFinite(ex.latitude) ? ex.latitude : null,
          lng: ex && Number.isFinite(ex.longitude) ? ex.longitude : null
        };
      }
      const c = cache[key];
      const takenAt = c.takenAt || null;
      if (takenAt && new Date(takenAt).getUTCFullYear() !== year) continue;
      photos.push({ path: p, takenAt, lat: c.lat, lng: c.lng });
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return { photos, scanned };
}

function repoRoot() { return path.resolve(__dirname, '..'); }

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !process.argv.slice(2).length) { console.log(HELP); return; }
  if (o.apply) { console.error('--apply is not in this build. Review a dry run with Jo first.'); process.exit(2); }
  if (!o.photos.length) throw new Error('--photos <dir> is required');
  const out = path.resolve(o.out || path.join(os.homedir(), 'Documents', 'nbd-photo-review'));
  if (out.toLowerCase().startsWith(repoRoot().toLowerCase())) throw new Error('--out must be outside the repo');
  fs.mkdirSync(out, { recursive: true });

  const leads = (await loadLeads(o)).filter(l => l && l.id);
  const { photos, scanned } = await scan(o.photos, path.join(out, 'exif-cache.json'), o.year);

  const rows = [];
  for (const ph of photos) {
    const m = M.bestMatch(ph, leads);
    if (!m) continue;
    const lead = leads.find(l => l.id === m.leadId);
    rows.push({
      file: ph.path, leadId: m.leadId, leadLabel: [lead.name, lead.address].filter(Boolean).join(' - '),
      confidence: m.confidence, phase: m.phase, distanceM: m.distanceM, takenAt: ph.takenAt,
      ambiguous: m.ambiguous, hasGps: ph.lat != null, thumb: /\.(jpe?g|png)$/i.test(ph.path) ? pathToFileURL(ph.path).href : ''
    });
  }
  const rank = { high: 3, medium: 2, low: 1 };
  rows.sort((a, b) => rank[b.confidence] - rank[a.confidence] || a.leadId.localeCompare(b.leadId));

  const cols = ['approve', 'file', 'lead_id', 'lead', 'confidence', 'phase', 'distance_m', 'taken_at', 'ambiguous'];
  const csv = [cols.join(',')].concat(rows.map(r => [
    '', r.file, r.leadId, r.leadLabel, r.confidence, r.phase || '', r.distanceM == null ? '' : r.distanceM, r.takenAt || '', r.ambiguous ? 'YES' : ''
  ].map(M.csvCell).join(','))).join('\r\n');
  fs.writeFileSync(path.join(out, 'review.csv'), csv + '\r\n');
  fs.writeFileSync(path.join(out, 'review.html'), M.contactSheetHtml(rows));

  const s = M.summarize(rows, scanned, leads.map(l => l.id), rows.map(r => r.leadId));
  s.scannedInYear = photos.length;
  s.scannedInYearWithGps = photos.filter(p => p.lat != null).length;
  s.ambiguous = rows.filter(r => r.ambiguous).length;
  console.log(JSON.stringify(s, null, 2));
  console.log('Review files written to the output folder (review.csv, review.html).');
}

if (require.main === module) main().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
module.exports = { parseArgs, stageDatesFromHistory };
