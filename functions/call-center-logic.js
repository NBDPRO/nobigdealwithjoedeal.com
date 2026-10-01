/**
 * functions/call-center-logic.js — pure decisions for the Call Center ingest
 * (Jo, 2026-10-01: "an automation timer that uploads all calls … AI sorts
 * them … half or more customers are contacts in my phone plus random numbers
 * that gets hard to filter").
 *
 * Cube ACR (the call recorder on Jo's phone) saves every call to Drive under
 * Documents › Cube ACR › <YYYY-MM-DD> › <file>.m4a, with the call's facts in
 * the file name. Three shapes seen in the wild:
 *
 *   2026-09-30 17-06-55 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.m4a
 *   2026-09-30 15-47-26 (phone) Example Property Claims (1 877-555-9386) ↗.m4a
 *   2026-09-30 17-12-33 (phone) +1 800-555-1370 ↙.m4a
 *
 * ↗ = outgoing, ↙ = incoming. The timestamp is the phone's local time
 * (America/New_York). A saved contact carries a label before the number;
 * Jo's own tags ("NBD Customer", "NBD Referral") ride at the end of it.
 *
 * Nothing is filtered OUT — every call is kept and sorted into a bucket:
 *   customer  — the number is on a lead
 *   insurance — the contact label names a carrier / claims line
 *   contact   — a saved phone contact the CRM doesn't know yet
 *   unknown   — a bare number
 *
 * Dependency-light (phone-utils + schedule-window only) so the tests
 * require() it directly and the function shares the exact code path.
 */
'use strict';

const { phoneDigits10 } = require('./phone-utils');
const SW = require('./schedule-window');

const DIRECTION = { '↗': 'outbound', '↙': 'inbound' };

// "<date> <time> (<source>) <label?> <number> <arrow?>.<ext>"
// The number is either "(+1 812-…)" / "(1 877-…)" after a label, or a bare
// "+1 800-…" when the caller isn't a saved contact.
const NAME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2}) \(([^)]*)\)\s*(.*?)\s*([↗↙])?\.(m4a|mp3|amr|ogg|wav|aac|3gp|opus)$/i;
const TRAILING_NUMBER_RE = /^(.*?)\s*\(\s*(\+?[\d][\d\s\-().]{6,})\)$/;
const BARE_NUMBER_RE = /^\+?[\d][\d\s\-().]{6,}$/;

// Jo's own contact-name tags. Kept as tags, stripped from the display name.
const TAGS = [
  { re: /\bNBD\s+Customer\b/i, tag: 'customer' },
  { re: /\bNBD\s+Referral\b/i, tag: 'referral' },
  { re: /\bNBD\s+Sub\b/i, tag: 'sub' },
  { re: /\bNBD\s+Vendor\b/i, tag: 'vendor' },
];

// A contact label that is a carrier or a claims line is an insurance call
// even when no lead carries the number (claims lines never do).
const CARRIER_RE = /\b(allstate|state\s*farm|progressive|liberty\s*mutual|nationwide|farmers|usaa|travelers|erie|auto[- ]?owners|american\s*family|amfam|safeco|geico|cincinnati\s*insurance|grange|westfield|shelter|hanover|chubb|kentucky\s*farm\s*bureau|farm\s*bureau|metlife|homesite|hippo|lemonade|citizens|the\s*hartford|hartford|encompass|kemper|mercury|country\s*financial|auto[- ]?club|aaa)\b|\b(claims?|adjuster|insurance)\b/i;

/** Parse a Cube ACR file name. Returns null for anything that isn't one. */
function parseCubeAcrName(name) {
  const m = NAME_RE.exec(String(name || '').trim());
  if (!m) return null;
  const [, ymd, hh, mi, ss, source, rest, arrow, ext] = m;
  if (+hh > 23 || +mi > 59 || +ss > 59) return null;

  let label = '';
  let rawNumber = '';
  const withNumber = TRAILING_NUMBER_RE.exec(rest);
  if (withNumber) {
    label = withNumber[1].trim();
    rawNumber = withNumber[2];
  } else if (BARE_NUMBER_RE.test(rest.trim())) {
    rawNumber = rest.trim();
  } else {
    label = rest.trim(); // a contact with no number on file (private / VoIP)
  }

  const digits = phoneDigits10(rawNumber);
  const tags = [];
  let displayName = label;
  for (const t of TAGS) {
    if (t.re.test(displayName)) {
      tags.push(t.tag);
      displayName = displayName.replace(t.re, ' ');
    }
  }
  displayName = displayName.replace(/\s{2,}/g, ' ').trim();

  let startedAtMs = null;
  try {
    startedAtMs = SW.localToUtcMs(ymd, hh + ':' + mi, 'America/New_York') + (+ss) * 1000;
  } catch (_) { startedAtMs = null; }
  if (!Number.isFinite(startedAtMs)) return null;

  return {
    ymd,
    startedAtMs,
    source: source.trim().toLowerCase() || 'phone',
    direction: DIRECTION[arrow] || null,
    phoneDigits: digits.length === 10 ? digits : '',
    contactLabel: label,
    contactName: displayName,
    savedContact: label !== '',
    tags,
    ext: ext.toLowerCase(),
  };
}

/** A Drive day folder name ("2026-09-30") → that date, else null. */
function dayFolderDate(name) {
  const s = String(name || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Index leads by their 10-digit phone (phoneDigits, then phone, then the
 * alternate phone fields). Deleted leads are skipped. A number shared by
 * several leads keeps them all — matchLead picks.
 */
function buildPhoneIndex(leads) {
  const idx = new Map();
  for (const l of leads || []) {
    if (!l || l.deleted === true) continue;
    const seen = new Set();
    for (const raw of [l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone]) {
      const d = phoneDigits10(raw);
      if (d.length !== 10 || seen.has(d)) continue;
      seen.add(d);
      if (!idx.has(d)) idx.set(d, []);
      idx.get(d).push(l);
    }
  }
  return idx;
}

function tsMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The lead a call belongs to. One tenant only (the caller passes the owner's
 * leads), so with several leads on one number the most recently touched wins
 * and the rest ride along as alternates for the UI to offer.
 */
function matchLead(phoneDigits, index) {
  if (!phoneDigits || !index || !index.has(phoneDigits)) return { leadId: null, alternates: [] };
  const recent = (l) => Math.max(tsMs(l.updatedAt), tsMs(l.lastContactedAt), tsMs(l.createdAt));
  const ranked = index.get(phoneDigits).slice().sort((a, b) => recent(b) - recent(a));
  return { leadId: ranked[0].id, alternates: ranked.slice(1).map((l) => l.id) };
}

/** The Call Center bucket. Nothing is dropped; this only sorts. */
function classifyCall(parsed, match) {
  if (match && match.leadId) return 'customer';
  const label = (parsed && parsed.contactLabel) || '';
  if (label && CARRIER_RE.test(label)) return 'insurance';
  if (parsed && parsed.savedContact) return 'contact';
  return 'unknown';
}

/** Deterministic doc id: one call doc per Drive file, so re-runs are no-ops. */
function callDocId(driveFileId) {
  return 'cube_' + String(driveFileId || '').replace(/[^A-Za-z0-9_-]/g, '');
}

/** Private Storage path (server-only, like Thursday's calls/{uid}/…). */
function storagePath(ownerUid, ymd, driveFileId, ext) {
  return 'calls/' + ownerUid + '/cube-acr/' + ymd + '/' + callDocId(driveFileId) + '.' + (ext || 'm4a');
}

/**
 * Which day folders to scan this run: every folder dated on/after the cursor
 * day (the cursor's own day is re-listed, since Cube ACR keeps adding to
 * today's folder), never older than the backfill floor.
 */
function foldersToScan(folders, cursorYmd, floorYmd) {
  const from = [cursorYmd, floorYmd].filter(Boolean).sort().pop() || '';
  return (folders || [])
    .map((f) => Object.assign({}, f, { ymd: dayFolderDate(f.name) }))
    .filter((f) => f.ymd && f.ymd >= from)
    .sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));
}

/** "YYYY-MM-DD" n days before ymd (calendar math, no timezone). */
function daysBefore(ymd, n) {
  return SW.addDays(ymd, -n);
}

/** The Firestore doc for one call (before transcription). */
function buildCallDoc({ ownerUid, file, parsed, match, bucket, storedPath, nowMs }) {
  return {
    userId: ownerUid,
    companyId: ownerUid,
    source: 'cube-acr',
    driveFileId: file.id,
    fileName: file.name,
    sizeBytes: Number(file.size) || 0,
    mimeType: file.mimeType || '',
    startedAtMs: parsed.startedAtMs,
    ymd: parsed.ymd,
    direction: parsed.direction,
    phoneDigits: parsed.phoneDigits,
    contactName: parsed.contactName,
    savedContact: parsed.savedContact,
    tags: parsed.tags,
    bucket,
    leadId: (match && match.leadId) || null,
    alternateLeadIds: (match && match.alternates) || [],
    storagePath: storedPath || null,
    status: storedPath ? 'stored' : 'listed',
    transcript: null,
    summary: null,
    actionItems: [],
    createdAtMs: nowMs,
  };
}

module.exports = {
  parseCubeAcrName,
  dayFolderDate,
  buildPhoneIndex,
  matchLead,
  classifyCall,
  callDocId,
  storagePath,
  foldersToScan,
  daysBefore,
  buildCallDoc,
  CARRIER_RE,
};
