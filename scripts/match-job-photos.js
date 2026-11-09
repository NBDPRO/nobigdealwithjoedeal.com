#!/usr/bin/env node
/**
 * scripts/match-job-photos.js — files job photos from a folder on Jo's own
 * computer onto the right 2026 leads (CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09
 * §1 steps 1-2). Jo runs it himself, over his iCloud Photos / Google Photos
 * sync folder or an export. Nothing reads iCloud or Google Photos directly.
 *
 * STEP 1, THE DRY RUN (the default; reads only)
 *   node scripts/match-job-photos.js --photos <folder> --company <companyId> [--out <folder>]
 *     leads in token mode: NBD_ACCESS_TOKEN=$(gcloud auth print-access-token),
 *     read through scripts/_firestore-rest.js (read only), or
 *   node scripts/match-job-photos.js --photos <folder> --leads <export.json> --company <companyId>
 *     for an offline run over a local leads export (an array of lead objects with `id`).
 *
 *   Every .jpg/.jpeg/.heic/.heif/.png under --photos (recursive; hidden
 *   folders skipped) has its EXIF date and GPS read with the CRM's own
 *   docs/pro/js/photo-exif.js and the vendored exifr (HEIC included). Each
 *   photo is scored against each lead of --company with any date in --year
 *   (default 2026):
 *     street  the lead's street key (addrKey from
 *             scripts/audit-imported-docs-placement.js) in the photo's folder
 *             or file name: same house number AND same first street word;
 *     date    the EXIF date inside the install window (+/- a day) or the
 *             wider job window (lead created - 14 d .. last stage move + 30 d);
 *     gps     the EXIF GPS within 75 m (on site, photo-engine.js's radius) or
 *             250 m of the lead's lat/lng. More than 1 km away disqualifies.
 *   A photo matches a lead only with TWO different kinds of evidence. A street
 *   key alone never files a photo (street names repeat across towns, and a
 *   personal photo can sit in a folder named for a street); neither does GPS
 *   alone. The best lead wins; a tie is flagged "ambiguous".
 *
 *   The phase comes from the date against the lead's stage dates: before the
 *   install day → Before; from the install day to the install-complete moment
 *   → During; after it → After. Start: the first move onto an install-in-progress
 *   stage. End: installCompletedAt, else the first move onto an after stage,
 *   else completedAt, else (lead standing on an after stage) stageStartedAt,
 *   else updatedAt — the order functions/social-studio.js uses.
 *
 *   Output, in --out (default ~/nbd-photo-match/<date>; never under docs/):
 *     photo-match-review.csv  one row per matched photo, `approve` blank
 *     contact-sheet.html      thumbnails by local file path, grouped by lead;
 *                             no script, nothing loaded over the network
 *   Both hold customer names and addresses: they stay on Jo's computer.
 *   stdout carries counts only — never a name, an address or a file name.
 *
 * STEP 2, APPLY (writes prod: Jo's OK for each run, CLAUDE.md rule f)
 *   node scripts/match-job-photos.js --apply <reviewed.csv> --company <id> --uid <uid>          # plan only
 *   node scripts/match-job-photos.js --apply <reviewed.csv> --company <id> --uid <uid> --yes    # writes
 *   Rows with approve = y/yes/x/1/true are filed. Jo may edit `phase` (Before /
 *   During / After) and `leadId` before approving. Each row is checked again:
 *   the lead exists in --company (read live; a local --leads file is refused),
 *   the file is still there with the reviewed sha256, and it is a JPEG or PNG
 *   (HEIC does not display in most browsers: export those as JPEG and run the
 *   dry run again). Then, create-only:
 *     Storage  photos/{uid}/{leadId}/{photoId}_original.{jpg|png}, with
 *              ifGenerationMatch=0 and a download token in its metadata;
 *              functions/image-pipeline.js makes the variants as for any upload.
 *     /photos/{photoId}  the docs/pro/js/photo-engine.js row shape with
 *              source 'photo-match', capturedAt from EXIF, phase from the
 *              review, through Firestore create() (precondition exists:false).
 *   photoId is derived from company + lead + file hash, so a rerun finds its own
 *   rows ("already filed") and overwrites nothing; an object left by a run that
 *   stopped before its row is reused with its existing token.
 *
 * Token mode only (NBD_ACCESS_TOKEN): the token is sent in a header, never logged.
 * NBD_PROJECT (default nobigdeal-pro) and NBD_BUCKET pick the project.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { addrKey, addrKeysInFilename } = require('./audit-imported-docs-placement.js');
const R = require('./_firestore-rest.js');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png']);
const UPLOAD_TYPE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const DAY = 86400000;
const ON_SITE_M = 75;      // photo-engine.js ON_SITE_RADIUS_M
const NEAR_M = 250;
const FAR_M = 1000;

// The stage → phase lists of docs/pro/js/photo-engine.js (_PHASE_DURING /
// _PHASE_AFTER); tests/match-job-photos-2026-11-09.test.js pins them equal.
const PHASE_DURING = ['install_in_progress', 'in_progress'];
const PHASE_AFTER = ['install_complete', 'final_photos', 'deductible_collected', 'final_payment', 'collections', 'closed', 'warranty_claim', 'warranty_repaired', 'complete', 'closed_won'];

const CSV_COLUMNS = ['approve', 'phase', 'leadId', 'confidence', 'score', 'reasons', 'takenAt', 'distanceM',
  'leadName', 'leadAddress', 'file', 'sha256', 'gpsLat', 'gpsLng', 'runnerUpLeadId', 'runnerUpScore', 'ambiguous'];

// ── small pure helpers ─────────────────────────────────────────────────────

/** Epoch ms of a Timestamp / {seconds} / {_seconds} / Date / ISO string / number, else 0. */
function ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (v instanceof Date) { const t = v.getTime(); return isFinite(t) ? t : 0; }
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}
const stageKey = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[\s-]+/g, '_');
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = (t) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };

function haversineM(a, b) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function latLng(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (lat == null || lng == null || lat === '' || lng === '' || !isFinite(a) || !isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return { lat: a, lng: b };
}

/** "1004 larkspur dr" → { num: '1004', word: 'larkspur' } */
function streetParts(key) {
  const m = String(key || '').match(/^(\d+)\s+([a-z]+)/);
  return m ? { num: m[1], word: m[2] } : null;
}

// ── lead windows and phase ─────────────────────────────────────────────────

/**
 * The lead's dates: { start, end, first, last } in epoch ms (0 = unknown).
 * start: first move onto a During stage; end: see the header (social-studio.js order).
 */
function leadWindows(lead) {
  const l = lead || {};
  const hist = (Array.isArray(l.stageHistory) ? l.stageHistory : [])
    .map((h) => ({ to: stageKey(h && h.to), at: ms(h && (h.timestamp || h.at)) }))
    .filter((h) => h.at)
    .sort((a, b) => a.at - b.at);
  const firstTo = (list) => { const h = hist.find((x) => list.includes(x.to)); return h ? h.at : 0; };
  let start = firstTo(PHASE_DURING);
  const standsAfter = PHASE_AFTER.includes(stageKey(l.stage));
  const end = ms(l.installCompletedAt) || firstTo(PHASE_AFTER) || ms(l.completedAt)
    || (standsAfter ? (ms(l.stageStartedAt) || ms(l.updatedAt)) : 0);
  if (start && end && start > end) start = 0;      // a reopened job: the install day is the end day
  const firsts = [ms(l.createdAt), hist.length ? hist[0].at : 0, start, end].filter(Boolean);
  const lasts = [end, hist.length ? hist[hist.length - 1].at : 0, start].filter(Boolean);
  return {
    start, end,
    first: firsts.length ? Math.min(...firsts) : 0,
    last: lasts.length ? Math.max(...lasts) : 0,
  };
}

/** 'Before' | 'During' | 'After' | null for a photo taken at takenMs. */
function phaseFor(takenMs, win) {
  const t = ms(takenMs);
  if (!t || !win || (!win.start && !win.end)) return null;
  const dayStart = startOfDay(win.start || win.end);
  if (t < dayStart) return 'Before';
  if (win.end && t > win.end) return 'After';
  return 'During';
}

/** Does any of the lead's dates fall in `year`? */
function inYear(lead, year) {
  const l = lead || {};
  const dates = [l.createdAt, l.installCompletedAt, l.completedAt, l.stageStartedAt, l.closedAt]
    .concat((Array.isArray(l.stageHistory) ? l.stageHistory : []).map((h) => h && (h.timestamp || h.at)));
  return dates.some((d) => { const t = ms(d); return t && new Date(t).getFullYear() === Number(year); });
}

// functions/social-studio.js leadInCompany
function leadInCompany(lead, companyId, uid) {
  if (!lead) return false;
  if (lead.companyId) return String(lead.companyId) === String(companyId);
  return lead.userId === uid || lead.userId === companyId;
}
const isDeleted = (l) => !!(l && (l.deleted === true || l.isDeleted === true || l.deletedAt));

// ── scoring ────────────────────────────────────────────────────────────────

/**
 * Score one photo against one lead.
 * photo: { relPath, takenMs|null, gps:{lat,lng}|null }
 * → { match, disqualified, score, kinds[], reasons[], distanceM, phase, confidence }
 */
function scorePhotoLead(photo, lead, win) {
  const kinds = [], reasons = [];
  let score = 0, disqualified = false, distanceM = null, gpsStrong = false, dateInstall = false;

  const lk = streetParts(addrKey(lead && lead.address));
  if (lk) {
    const hit = addrKeysInFilename(photo.relPath || '').map(streetParts).some((k) => k && k.num === lk.num && k.word === lk.word);
    if (hit) { kinds.push('street'); reasons.push('street in folder/file name'); score += 2; }
  }

  const lg = latLng(lead && lead.lat, lead && lead.lng);
  const pg = photo.gps && latLng(photo.gps.lat, photo.gps.lng);
  if (lg && pg) {
    distanceM = Math.round(haversineM(pg, lg));
    if (distanceM <= ON_SITE_M) { kinds.push('gps'); reasons.push('GPS on site'); score += 3; gpsStrong = true; }
    else if (distanceM <= NEAR_M) { kinds.push('gps'); reasons.push('GPS within 250 m'); score += 1; }
    else if (distanceM > FAR_M) { disqualified = true; reasons.push('GPS over 1 km away'); }
  }

  const t = ms(photo.takenMs);
  if (t && win) {
    const iStart = win.start || win.end, iEnd = win.end || win.start;
    if (iStart && t >= startOfDay(iStart) - DAY && t <= endOfDay(iEnd) + DAY) {
      kinds.push('date'); reasons.push('date in install window'); score += 2; dateInstall = true;
    } else if (win.first && t >= win.first - 14 * DAY && t <= (win.last || win.first) + 30 * DAY) {
      kinds.push('date'); reasons.push('date in job window'); score += 1;
    }
  }

  const match = !disqualified && kinds.length >= 2;
  const confidence = !match ? '' : (kinds.length === 3 || (gpsStrong && dateInstall)) ? 'high' : 'medium';
  return { match, disqualified, score, kinds, reasons, distanceM, phase: phaseFor(t, win), confidence };
}

/** The best lead for a photo among [{lead, win}], or null. */
function bestMatch(photo, leadsWithWin) {
  const hits = [];
  for (const lw of leadsWithWin) {
    const s = scorePhotoLead(photo, lw.lead, lw.win);
    if (s.match) hits.push(Object.assign({ lead: lw.lead, win: lw.win }, s));
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score || b.kinds.length - a.kinds.length);
  const best = hits[0], runnerUp = hits[1] || null;
  best.runnerUp = runnerUp;
  best.ambiguous = !!(runnerUp && runnerUp.score === best.score && runnerUp.kinds.length === best.kinds.length);
  return best;
}

// ── CSV ────────────────────────────────────────────────────────────────────

// A cell Excel would run as a formula gets a leading apostrophe; a plain
// number (a negative longitude) is left alone. parseCsv takes it off again.
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;
function guardCell(v) {
  const s = v == null ? '' : String(v);
  return FORMULA.test(s) && !NUMBER.test(s) ? '\'' + s : s;
}
function unguardCell(s) {
  return s.length > 1 && s[0] === '\'' && FORMULA.test(s.slice(1)) && !NUMBER.test(s.slice(1)) ? s.slice(1) : s;
}
function csvCell(v) {
  const s = guardCell(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, columns) {
  const cols = columns || CSV_COLUMNS;
  return [cols.join(',')].concat((rows || []).map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n') + '\r\n';
}
function parseCsv(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const records = [];
  let row = [], cell = '', i = 0, quoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
      i += (ch === '\r' && s[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') records.push(row); }
  if (!records.length) return [];
  const head = records[0].map((h) => h.trim());
  return records.slice(1).map((r) => {
    const o = {};
    head.forEach((h, j) => { o[h] = unguardCell(r[j] == null ? '' : r[j]); });
    return o;
  });
}
const isApproved = (v) => /^(y|yes|x|1|true)$/i.test(String(v == null ? '' : v).trim());

// ── files and EXIF ─────────────────────────────────────────────────────────

/** Every photo file under dir, recursive, hidden entries skipped, sorted. */
function listPhotoFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && PHOTO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

let _exifTools = null;
/** photo-exif.js + the vendored exifr, the modules the CRM itself uses. */
async function exifTools() {
  if (!_exifTools) {
    const PX = await import(pathToFileURL(path.join(ROOT, 'docs', 'pro', 'js', 'photo-exif.js')).href);
    const EXIFR = await import(pathToFileURL(path.join(ROOT, 'docs', 'assets', 'vendor', 'exifr', 'exifr.esm.mjs')).href);
    _exifTools = { PX, loadExifr: async () => EXIFR };
  }
  return _exifTools;
}
/** photo-exif.js's /photos fields for a file, with `nowMs` as the device clock. */
async function exifFieldsFor(absPath, nowMs) {
  const T = await exifTools();
  let raw = null;
  try {
    const blob = typeof fs.openAsBlob === 'function' ? await fs.openAsBlob(absPath) : new Blob([fs.readFileSync(absPath)]);
    raw = await T.PX.readPhotoExif(blob, { loadExifr: T.loadExifr });
  } catch (_) { raw = null; }
  return T.PX.exifToPhotoFields(raw, nowMs);
}

// ── output ─────────────────────────────────────────────────────────────────

function isUnder(child, parent) {
  const c = path.resolve(child), p = path.resolve(parent);
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(norm(p), norm(c));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A local, script-free contact sheet: thumbnails by file URL, grouped by lead. */
function contactSheetHtml(rows, meta) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.leadId)) groups.set(r.leadId, []);
    groups.get(r.leadId).push(r);
  }
  const card = (r) => '<figure class="c' + (r.ambiguous === 'yes' ? ' amb' : '') + '">'
    + '<img loading="lazy" src="' + esc(pathToFileURL(r.file).href) + '" alt="">'
    + '<figcaption><b>' + esc(r.phase || 'no phase') + '</b> · ' + esc(r.confidence) + ' · score ' + esc(r.score)
    + '<br>' + esc(r.takenAt || 'no date') + (r.distanceM !== '' ? ' · ' + esc(r.distanceM) + ' m' : '')
    + '<br>' + esc(r.reasons) + (r.ambiguous === 'yes' ? '<br><b>ambiguous</b> (also ' + esc(r.runnerUpLeadId) + ')' : '')
    + '<br><span class="f">' + esc(path.basename(r.file)) + '</span></figcaption></figure>';
  const sections = Array.from(groups.entries()).map(([leadId, rs]) => '<section><h2>' + esc(rs[0].leadName || leadId)
    + ' <small>' + esc(rs[0].leadAddress) + ' · ' + esc(leadId) + ' · ' + rs.length + ' photo' + (rs.length === 1 ? '' : 's') + '</small></h2>'
    + '<div class="g">' + rs.map(card).join('') + '</div></section>').join('\n');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Photo match review</title><style>'
    + 'body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#14181F;background:#fff}'
    + 'h1{color:#1A3057}h2{color:#1A3057;border-bottom:1px solid #DFE2E7;padding-bottom:4px}h2 small{color:#4C4C4D;font-weight:400}'
    + '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}'
    + '.c{margin:0;border:1px solid #DFE2E7;border-radius:6px;overflow:hidden;background:#F6F7F8}.c.amb{border:2px solid #BD5728}'
    + '.c img{width:100%;height:160px;object-fit:cover;display:block;background:#DFE2E7}'
    + 'figcaption{padding:6px 8px;font-size:12px}.f{color:#4C4C4D;word-break:break-all}'
    + '</style></head><body><h1>Photo match review</h1>'
    + '<p>' + esc(meta.matched) + ' matched photos on ' + esc(meta.leads) + ' leads, from ' + esc(meta.photos) + ' scanned. '
    + 'Approve rows in photo-match-review.csv (approve = y). HEIC thumbnails show in Safari only. '
    + 'This file names customers: keep it on this computer.</p>\n'
    + sections + '\n</body></html>\n';
}

// ── leads ──────────────────────────────────────────────────────────────────

async function loadLeads(opts, deps) {
  if (opts.leads) {
    const j = JSON.parse(fs.readFileSync(opts.leads, 'utf8'));
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.leads) ? j.leads : []);
    return list.filter((l) => l && l.id);
  }
  const db = await dbFor(opts, deps);
  // A collection-group page by name (the shape _firestore-rest.js supports),
  // top-level leads/{id} only; filtered to --company below.
  const out = [];
  let q = db.collectionGroup('leads').orderBy('__name__').limit(300);
  for (let guardN = 0; guardN < 1000; guardN++) {
    const snap = await q.get();
    for (const d of snap.docs) {
      if (String(d.ref.path).split('/').length !== 2) continue;
      out.push(Object.assign({}, d.data(), { id: d.id }));
    }
    if (snap.size < 300) break;
    q = db.collectionGroup('leads').orderBy('__name__').limit(300).startAfter(snap.docs[snap.docs.length - 1]);
  }
  return out;
}

async function dbFor(opts, deps) {
  if (deps.db) return deps.db;
  const token = (deps.env || {}).NBD_ACCESS_TOKEN;
  if (!token) throw usage('Token mode needs NBD_ACCESS_TOKEN (NBD_ACCESS_TOKEN=$(gcloud auth print-access-token)), or pass --leads <export.json> for a dry run.');
  return R.restFirestore({ projectId: opts.project, token, fetchImpl: deps.fetchImpl });
}

function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

// ── Storage (REST, create-only) ────────────────────────────────────────────

/**
 * A minimal Cloud Storage client over the JSON API for token mode.
 * create(): uploadType=multipart with ifGenerationMatch=0, so an existing
 * object is never replaced (HTTP 412 → code 'already-exists').
 */
function makeRestStorage({ bucket, token, fetchImpl }) {
  const t = String(token || '').trim();
  if (!bucket) throw new Error('bucket is required');
  if (!t) throw new Error('NBD_ACCESS_TOKEN is empty');
  const f = fetchImpl || globalThis.fetch;
  return {
    async create({ path: name, bytes, contentType, token: dlToken }) {
      const boundary = 'nbd' + crypto.randomBytes(12).toString('hex');
      const meta = JSON.stringify({ name, contentType, metadata: { firebaseStorageDownloadTokens: dlToken } });
      const body = Buffer.concat([
        Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: ' + contentType + '\r\n\r\n', 'utf8'),
        Buffer.from(bytes),
        Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'),
      ]);
      const url = 'https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(bucket) + '/o?uploadType=multipart&ifGenerationMatch=0';
      const r = await f(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
      if (r.status === 412) { const e = new Error('Storage object exists'); e.code = 'already-exists'; throw e; }
      if (r.status < 200 || r.status > 299) throw new Error('Storage upload failed: HTTP ' + r.status);
    },
    async getToken(name) {
      const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' + encodeURIComponent(name);
      const r = await f(url, { method: 'GET', headers: { Authorization: 'Bearer ' + t } });
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error('Storage metadata read failed: HTTP ' + r.status);
      let j = null; try { j = JSON.parse(await r.text()); } catch (_) { j = null; }
      const v = j && j.metadata && j.metadata.firebaseStorageDownloadTokens;
      return v ? String(v).split(',')[0].trim() || null : null;
    },
  };
}

// ── args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    photos: null, leads: null, company: '', uid: '', out: null, year: 2026, apply: null, yes: false,
    project: process.env.NBD_PROJECT || 'nobigdeal-pro',
    bucket: process.env.NBD_BUCKET || 'nobigdeal-pro.firebasestorage.app',
  };
  const takes = { '--photos': 'photos', '--leads': 'leads', '--company': 'company', '--uid': 'uid', '--out': 'out', '--year': 'year', '--apply': 'apply', '--project': 'project', '--bucket': 'bucket' };
  const a = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < a.length; i++) {
    const arg = a[i];
    if (arg === '--yes') { o.yes = true; continue; }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!takes[flag]) throw usage('Unknown argument: ' + flag);
    const val = eq > 0 ? arg.slice(eq + 1) : a[++i];
    if (val == null || val === '' || (eq < 0 && String(val).startsWith('--'))) throw usage(flag + ' needs a value');
    o[takes[flag]] = val;
  }
  o.year = Number(o.year);
  return o;
}

// ── dry run ────────────────────────────────────────────────────────────────

async function runMatch(opts, deps) {
  const log = deps.log;
  if (!opts.photos || !fs.existsSync(opts.photos) || !fs.statSync(opts.photos).isDirectory()) throw usage('--photos <folder> is required and must be a folder.');
  if (!opts.company) throw usage('--company <companyId> is required (/leads is multi-tenant).');
  const now = deps.now ? deps.now() : Date.now();
  const out = path.resolve(opts.out || path.join(os.homedir(), 'nbd-photo-match', new Date(now).toISOString().slice(0, 10)));
  if (isUnder(out, DOCS_DIR)) throw usage('--out must not be under docs/ (that folder is the public website).');

  const all = await loadLeads(opts, deps);
  const leads = all.filter((l) => !isDeleted(l) && leadInCompany(l, opts.company, opts.uid || opts.company) && inYear(l, opts.year));
  const lw = leads.map((lead) => ({ lead, win: leadWindows(lead) }));

  const files = listPhotoFiles(opts.photos);
  const rows = [];
  let withDate = 0, withGps = 0, ambiguous = 0, high = 0;
  for (const abs of files) {
    const ex = await exifFieldsFor(abs, now);
    const takenMs = ex.capturedAtSource === 'exif' ? ex.capturedAt : null;
    const gps = ex.geoLocation ? { lat: ex.geoLocation.lat, lng: ex.geoLocation.lng } : null;
    if (takenMs) withDate++;
    if (gps) withGps++;
    const best = bestMatch({ relPath: path.relative(opts.photos, abs), takenMs, gps }, lw);
    if (!best) continue;
    if (best.ambiguous) ambiguous++;
    if (best.confidence === 'high') high++;
    const l = best.lead;
    rows.push({
      approve: '', phase: best.phase || '', leadId: l.id, confidence: best.confidence, score: best.score,
      reasons: best.reasons.join('; '), takenAt: takenMs ? new Date(takenMs).toISOString() : '',
      distanceM: best.distanceM == null ? '' : best.distanceM,
      leadName: String(l.name || [l.firstName, l.lastName].filter(Boolean).join(' ') || ''),
      leadAddress: String(l.address || ''), file: abs, sha256: sha256File(abs),
      gpsLat: gps ? gps.lat : '', gpsLng: gps ? gps.lng : '',
      runnerUpLeadId: best.runnerUp ? best.runnerUp.lead.id : '', runnerUpScore: best.runnerUp ? best.runnerUp.score : '',
      ambiguous: best.ambiguous ? 'yes' : '',
    });
  }
  rows.sort((a, b) => (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0) || (a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : 0));

  fs.mkdirSync(out, { recursive: true });
  const csvPath = path.join(out, 'photo-match-review.csv');
  const htmlPath = path.join(out, 'contact-sheet.html');
  const summary = { photos: files.length, withDate, withGps, leads: leads.length, matched: rows.length, high, medium: rows.length - high, ambiguous, unmatched: files.length - rows.length, leadsWithPhotos: new Set(rows.map((r) => r.leadId)).size };
  fs.writeFileSync(csvPath, toCsv(rows));
  fs.writeFileSync(htmlPath, contactSheetHtml(rows, summary));

  log('');
  log('  match-job-photos — DRY RUN (reads only; nothing was written to the CRM)');
  log('  photos     : ' + summary.photos + '   (EXIF date ' + withDate + ', GPS ' + withGps + ')');
  log('  leads      : ' + summary.leads + '   (company, ' + opts.year + ')');
  log('  matched    : ' + summary.matched + '   (high ' + high + ', medium ' + summary.medium + ', ambiguous ' + ambiguous + ') on ' + summary.leadsWithPhotos + ' leads');
  log('  unmatched  : ' + summary.unmatched);
  log('  review     : ' + csvPath);
  log('  contact    : ' + htmlPath);
  log('  These two files name customers: keep them on this computer. Set approve = y on');
  log('  the rows to file, then run with --apply <csv> (needs Jo\'s OK for that run).');
  return { code: 0, summary, csvPath, htmlPath };
}

// ── apply ──────────────────────────────────────────────────────────────────

const WARNING = [
  '',
  '  ############################################################################',
  '  #  WARNING: --apply WRITES PRODUCTION (Cloud Storage + Firestore /photos).  #',
  '  #  Only with Jo\'s OK for THIS run (CLAUDE.md rule f). Agents: never add    #',
  '  #  --yes unless Jo approved this specific run in chat.                      #',
  '  ############################################################################',
  '',
];

/**
 * Plan (and with write: true, perform) the filing of approved rows.
 * deps: { storage, db, readFile(abs) → Buffer|null, exifFields(abs, nowMs), now(), bucket }
 */
async function applyRows(rows, ctx, deps) {
  const leadsById = new Map(ctx.leads.map((l) => [l.id, l]));
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  let approved = 0, planned = 0, uploaded = 0, reused = 0, created = 0;
  const now = deps.now ? deps.now() : Date.now();

  for (const row of rows) {
    if (!isApproved(row.approve)) continue;
    approved++;
    const lead = leadsById.get(String(row.leadId || '').trim());
    if (!lead || isDeleted(lead)) { skip('lead not found'); continue; }
    if (!leadInCompany(lead, ctx.company, ctx.uid)) { skip('lead in another company'); continue; }
    const abs = String(row.file || '');
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.heic' || ext === '.heif') { skip('heic: export as JPEG first'); continue; }
    const contentType = UPLOAD_TYPE[ext];
    if (!contentType) { skip('not a jpg or png'); continue; }
    const bytes = deps.readFile(abs);
    if (!bytes) { skip('file missing'); continue; }
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== String(row.sha256 || '').trim().toLowerCase()) { skip('file changed since review'); continue; }

    const ex = await deps.exifFields(abs, now);
    const win = leadWindows(lead);
    const reviewed = ['Before', 'During', 'After'].find((p) => p.toLowerCase() === String(row.phase || '').trim().toLowerCase());
    const phase = reviewed || phaseFor(ex.capturedAtSource === 'exif' ? ex.capturedAt : null, win) || null;
    const photoId = 'pm_' + crypto.createHash('sha256').update(ctx.company + '|' + lead.id + '|' + sha).digest('hex').slice(0, 24);
    const storagePath = 'photos/' + ctx.uid + '/' + lead.id + '/' + photoId + '_original' + (ext === '.png' ? '.png' : '.jpg');
    planned++;
    if (!ctx.write) continue;

    const docRef = deps.db.doc('photos/' + photoId);
    const existing = await docRef.get();
    if (existing && existing.exists) { skip('already filed'); continue; }

    let dlToken = crypto.randomUUID();
    try {
      await deps.storage.create({ path: storagePath, bytes, contentType, token: dlToken });
      uploaded++;
    } catch (e) {
      if (e && e.code === 'already-exists') {
        dlToken = await deps.storage.getToken(storagePath);
        if (!dlToken) { skip('storage object exists without a token'); continue; }
        reused++;
      } else { skip('upload failed'); continue; }
    }
    const url = 'https://firebasestorage.googleapis.com/v0/b/' + ctx.bucket + '/o/' + encodeURIComponent(storagePath) + '?alt=media&token=' + dlToken;
    const lg = latLng(lead.lat, lead.lng);
    const g = ex.geoLocation || null;
    // The docs/pro/js/photo-engine.js uploadPhotoToFirebase row, with the
    // photo's own EXIF fields (photo-exif.js) and source 'photo-match'.
    const data = Object.assign({
      id: photoId,
      leadId: lead.id,
      userId: ctx.uid,
      companyId: lead.companyId || ctx.company,
      url,
      storagePath,
      thumbUrl: url,            // functions/image-pipeline.js stamps urls.{thumb,med,full}
      tags: [],
      phase,
      phaseSource: phase ? 'photo-match' : null,
      description: '',
      location: '',
      quality: 'original',
      width: 'auto',
      height: 'auto',
      fileSize: bytes.length,
      createdAt: R.serverTimestamp(),
    }, ex, {
      uploadedAt: R.serverTimestamp(),
      reportSections: [],
      geoLocation: g,
      onSite: g && lg ? haversineM(g, lg) <= ON_SITE_M : null,
      source: 'photo-match',
    });
    try {
      await docRef.create(data);
      created++;
    } catch (e) {
      if (e && e.code === 'already-exists') skip('already filed');
      else skip('row write failed');
    }
  }
  return { approved, planned, uploaded, reused, created, skipped };
}

async function runApply(opts, deps) {
  const log = deps.log;
  WARNING.forEach((l) => log(l));
  if (opts.leads) throw usage('--apply reads the live leads: drop --leads and use token mode (NBD_ACCESS_TOKEN).');
  if (!opts.company) throw usage('--company <companyId> is required.');
  if (!opts.uid) throw usage('--uid <uid> is required: the photos are stored under photos/{uid}/.');
  if (!fs.existsSync(opts.apply)) throw usage('The reviewed CSV was not found.');
  const rows = parseCsv(fs.readFileSync(opts.apply, 'utf8'));
  if (rows.length && !('approve' in rows[0] && 'sha256' in rows[0] && 'file' in rows[0] && 'leadId' in rows[0])) throw usage('That CSV is not a photo-match review sheet.');

  const db = await dbFor(opts, deps);
  const leads = await loadLeads(opts, Object.assign({}, deps, { db }));
  const storage = !opts.yes ? null : (deps.storage || makeRestStorage({ bucket: opts.bucket, token: (deps.env || {}).NBD_ACCESS_TOKEN, fetchImpl: deps.fetchImpl }));
  const res = await applyRows(rows, { leads, company: opts.company, uid: opts.uid, bucket: opts.bucket, write: !!opts.yes }, {
    db, storage,
    now: deps.now,
    readFile: (p) => { try { return fs.readFileSync(p); } catch (_) { return null; } },
    exifFields: deps.exifFields || exifFieldsFor,
  });

  log('  rows in sheet : ' + rows.length + '   approved: ' + res.approved + '   fileable: ' + res.planned);
  Object.keys(res.skipped).sort().forEach((k) => log('  skipped       : ' + res.skipped[k] + '  ' + k));
  if (!opts.yes) {
    log('');
    log('  PLAN ONLY — nothing was written. Add --yes to file ' + res.planned + ' photo(s), with Jo\'s OK for this run.');
  } else {
    log('  uploaded      : ' + res.uploaded + (res.reused ? '   (reused ' + res.reused + ' existing objects)' : ''));
    log('  /photos rows  : ' + res.created + ' created');
  }
  return { code: 0, summary: res };
}

// ── entry ──────────────────────────────────────────────────────────────────

async function run(argv, deps) {
  const d = Object.assign({ log: console.log, err: console.error, env: process.env }, deps || {});
  try {
    const opts = parseArgs(argv);
    return opts.apply ? await runApply(opts, d) : await runMatch(opts, d);
  } catch (e) {
    // Messages here never carry customer data: usage text, or an HTTP status.
    d.err('  ' + (e && e.usage ? e.message : 'match-job-photos failed: ' + String(e && e.message || e).slice(0, 300)));
    return { code: e && e.usage ? 2 : 1 };
  }
}

module.exports = {
  addrKey, addrKeysInFilename, ms, leadWindows, phaseFor, inYear, scorePhotoLead, bestMatch,
  toCsv, parseCsv, isApproved, listPhotoFiles, contactSheetHtml, makeRestStorage, applyRows,
  parseArgs, run, PHASE_DURING, PHASE_AFTER, CSV_COLUMNS,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((r) => process.exit(r.code));
}
