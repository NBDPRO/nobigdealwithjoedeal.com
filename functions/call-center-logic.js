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

// Cube ACR writes a ~160-byte sidecar next to each recording, same name,
// .json: {"duration":"21504","loc":"<lat;lng>","callee":"+1…","addr":"<street
// address>","direction":"Incoming"}. ONLY the duration is read. "loc" and
// "addr" are where Jo's phone was during the call — never stored.
const SHORT_CALL_SEC = 15;

function sidecarNameFor(recordingName) {
  return String(recordingName || '').replace(/\.[A-Za-z0-9]+$/, '.json');
}

/** Sidecar JSON text → { durationSec } or null. Nothing else is kept. */
function parseSidecar(text) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  const ms = Number(j.duration);
  if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 3600 * 1000) return null;
  return { durationSec: Math.round(ms / 1000) };
}

/** The Firestore doc for one call (before transcription). */
function buildCallDoc({ ownerUid, file, parsed, match, bucket, storedPath, nowMs, durationSec }) {
  const dur = Number.isFinite(durationSec) ? durationSec : null;
  const short = dur != null && dur < SHORT_CALL_SEC;
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
    durationSec: dur,
    // A missed call / hang-up: audio kept, never transcribed.
    status: !storedPath ? 'listed' : (short ? 'short' : 'stored'),
    transcript: null,
    summary: null,
    actionItems: [],
    createdAtMs: nowMs,
  };
}

// ── Stage 2: transcript → notes (2026-10-01) ─────────────────────────────

// Groq's free tier: 8 h of audio a day, 25 MB a file. The ingest pass
// keeps well inside both.
const GROQ_MAX_BYTES = 25 * 1024 * 1024;
const DAY_AUDIO_SEC_CAP = 6 * 3600;
// Cube ACR's m4a runs ~4 KB/s; good enough to budget before Groq says.
function estimateAudioSec(sizeBytes) {
  return Math.max(1, Math.round((Number(sizeBytes) || 0) / 4000));
}

/**
 * Which stored calls to transcribe this run. An allow-list (Jo's one-call
 * test) works with the gate OFF and ignores everything else; with the gate
 * ON, newest first, within the per-run count and the day's audio budget.
 */
function pickToTranscribe(calls, { live, allowIds, maxCount, secLeft }) {
  const allow = Array.isArray(allowIds) ? allowIds.filter(Boolean) : [];
  const ready = (calls || []).filter((c) => c && c.status === 'stored' && c.storagePath && (Number(c.transcribeAttempts) || 0) < 3);
  if (allow.length) return ready.filter((c) => allow.includes(c.id)).slice(0, maxCount);
  if (!live) return [];
  const out = [];
  let left = Number(secLeft) || 0;
  for (const c of ready.slice().sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0))) {
    if (out.length >= maxCount) break;
    const est = estimateAudioSec(c.sizeBytes);
    if (est > left) continue;
    left -= est;
    out.push(c);
  }
  return out;
}

const CALL_TYPES = ['customer', 'insurance', 'supplier', 'sub', 'lead', 'personal', 'spam', 'other'];

const NOTES_SYSTEM = [
  'You read transcripts of phone calls made or taken by Jo, who runs No Big Deal Home Solutions, a small roofing / gutters / siding contractor in the Cincinnati area.',
  'Return ONE JSON object and nothing else:',
  '{"call_type": one of ' + JSON.stringify(CALL_TYPES) + ',',
  ' "summary": "2-3 plain sentences: who, what about, what was decided",',
  ' "promises": [{"who": "jo" | "them", "text": "a concrete thing someone said they would do, imperative, under 120 chars", "due": "YYYY-MM-DD" or null}],',
  ' "follow_up_date": "YYYY-MM-DD" or null (when Jo should next reach out, if the call implies one),',
  ' "urgent": true | false (an active leak, safety issue, or a hard deadline within 48 hours)}',
  'Rules: only promises actually made on the call, at most 6. Resolve relative dates ("Thursday", "next week") against the call date given. ',
  'A call about family, friends or anything not business is "personal": then summary is "Personal call." and promises is [].',
  'Never invent prices, names or dates that were not said.',
].join('\n');

function buildNotesPrompt({ call, transcript, leadName }) {
  const when = call.startedAtMs ? new Date(call.startedAtMs).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'unknown';
  return [
    'Call date (Eastern): ' + when,
    'Direction: ' + (call.direction === 'outbound' ? 'Jo called them' : call.direction === 'inbound' ? 'They called Jo' : 'unknown'),
    'Other party (from Jo\'s phone contacts): ' + (call.contactName || 'not a saved contact'),
    leadName ? 'CRM customer this number belongs to: ' + leadName : 'Not matched to a CRM customer.',
    '',
    'Transcript:',
    String(transcript || '').slice(0, 60000),
  ].join('\n');
}

function ymdOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T12:00:00Z');
  return Number.isFinite(t) ? s : null;
}
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** The model's JSON → the stored shape. Anything malformed is dropped, never trusted. */
function sanitizeNotes(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const callType = CALL_TYPES.includes(r.call_type) ? r.call_type : 'other';
  const personal = callType === 'personal';
  const promises = personal ? [] : (Array.isArray(r.promises) ? r.promises : [])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim())
    .slice(0, 6)
    .map((p) => ({ who: p.who === 'jo' ? 'jo' : 'them', text: clip(p.text, 160), due: ymdOrNull(p.due) }));
  return {
    callType,
    summary: personal ? 'Personal call.' : clip(r.summary || '', 700),
    promises,
    followUpDate: personal ? null : ymdOrNull(r.follow_up_date),
    urgent: !personal && r.urgent === true,
  };
}

/** leads/{id}/activity/cube-{docId} — the customer timeline entry. */
function buildCallActivity({ call, notes, ownerUid }) {
  return {
    userId: ownerUid,
    companyId: ownerUid,
    type: 'call',
    direction: call.direction || null,
    source: 'cube-acr',
    label: (call.direction === 'outbound' ? 'You called' : call.direction === 'inbound' ? 'They called' : 'Phone call') +
      (call.contactName ? ' · ' + call.contactName : ''),
    summary: notes.summary,
    promises: notes.promises,
    followUpDate: notes.followUpDate,
    durationSec: Number(call.durationSec) || 0,
    phoneCallId: call.id,
  };
}

/**
 * leads/{id}/tasks/cube-{docId} — ONE follow-up task per call, only when
 * Jo promised something or a follow-up date came out of it. Shape matches
 * Thursday's (docs/pro/js/tasks.js readers).
 */
function buildFollowUpTask({ call, notes, leadId, ownerUid, todayYmd }) {
  const mine = notes.promises.filter((p) => p.who === 'jo');
  if (!mine.length && !notes.followUpDate) return null;
  const who = call.contactName || 'customer';
  const first = mine[0];
  const title = clip(first ? first.text + ' (' + who + ')' : 'Follow up with ' + who, 200);
  const dues = mine.map((p) => p.due).filter(Boolean).concat(notes.followUpDate ? [notes.followUpDate] : []).sort();
  return {
    leadId,
    userId: ownerUid,
    title,
    text: title,
    notes: [
      notes.summary ? 'Call: ' + notes.summary : '',
      mine.length ? 'You said you would:\n' + mine.map((p) => '• ' + p.text + (p.due ? ' (by ' + p.due + ')' : '')).join('\n') : '',
    ].filter(Boolean).join('\n\n'),
    dueDate: dues[0] || todayYmd,
    priority: notes.urgent ? 'high' : 'normal',
    done: false,
    source: 'cube-acr',
    phoneCallId: call.id,
    createdBy: 'Call Center (AI notes)',
  };
}

// ── Stage 3: the "you said you'd…" sweep (2026-10-01) ────────────────────
//
// Twice a day (07:15 and 15:15 ET) one email to Jo listing what his calls
// say is still owed. Sources: noted phone_calls from the last 30 days and
// the one follow-up task each may have (leads/{id}/tasks/cube-{callId}).
//   due      — a task Jo hasn't ticked, due today or earlier
//   no file  — a call with no CRM customer where Jo promised something or a
//              follow-up date has come (insurance lines, new numbers)
//   urgent   — an urgent call in the last 36 h whose task isn't done
// A call Jo marked handled (handledAtMs) never shows. Nothing open → no email.

const SWEEP_LOOKBACK_MS = 30 * 24 * 3600 * 1000;
const URGENT_WINDOW_MS = 36 * 3600 * 1000;
const SWEEP_MAX_ITEMS = 30;

function collectSweepItems({ calls, tasksByCallId, nowMs, todayYmd }) {
  const tasks = tasksByCallId instanceof Map ? tasksByCallId : new Map(Object.entries(tasksByCallId || {}));
  const out = [];
  for (const c of calls || []) {
    if (!c || c.status !== 'noted' || c.handledAtMs) continue;
    if ((Number(c.startedAtMs) || 0) < nowMs - SWEEP_LOOKBACK_MS) continue;
    const mine = (Array.isArray(c.promises) ? c.promises : []).filter((p) => p && p.who === 'jo');
    const task = c.leadId ? tasks.get(c.id) : null;
    const who = c.contactName || (c.phoneDigits ? '(' + c.phoneDigits.slice(0, 3) + ') ' + c.phoneDigits.slice(3, 6) + '-' + c.phoneDigits.slice(6) : 'Unknown number');
    const base = { callId: c.id, leadId: c.leadId || null, who, startedAtMs: c.startedAtMs, summary: c.summary || '', promises: mine.map((p) => p.text) };
    if (task) {
      if (task.done === true) continue;
      const urgentNow = c.urgent && (Number(c.startedAtMs) || 0) >= nowMs - URGENT_WINDOW_MS;
      if (urgentNow) out.push(Object.assign(base, { kind: 'urgent', due: task.dueDate || todayYmd }));
      else if (task.dueDate && task.dueDate <= todayYmd) out.push(Object.assign(base, { kind: 'due', due: task.dueDate }));
      continue;
    }
    if (!c.leadId) {
      const dues = mine.map((p) => p.due).filter(Boolean).concat(c.followUpDate ? [c.followUpDate] : []).sort();
      const due = dues[0] || null;
      const urgentNow = c.urgent && (Number(c.startedAtMs) || 0) >= nowMs - URGENT_WINDOW_MS;
      if (urgentNow) out.push(Object.assign(base, { kind: 'urgent', due: due || todayYmd }));
      else if (mine.length && (!due || due <= todayYmd)) out.push(Object.assign(base, { kind: 'nofile', due: due || todayYmd }));
      else if (!mine.length && due && due <= todayYmd) out.push(Object.assign(base, { kind: 'nofile', due }));
    }
  }
  const rank = { urgent: 0, due: 1, nofile: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || String(a.due).localeCompare(String(b.due)) || (a.startedAtMs || 0) - (b.startedAtMs || 0))
    .slice(0, SWEEP_MAX_ITEMS);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The sweep email. Internal (Jo only); every value escaped. */
function buildSweepEmail({ items, todayYmd, slot }) {
  const n = items.length;
  const subject = (items.some((i) => i.kind === 'urgent') ? '🚨 ' : '') + 'Calls: ' + n + ' thing' + (n === 1 ? '' : 's') + ' you said you\'d do' + (slot === 'pm' ? ' (afternoon check)' : '');
  const label = { urgent: 'Urgent', due: 'Due', nofile: 'No customer on file' };
  const link = (i) => i.leadId ? 'https://nobigdealwithjoedeal.com/pro/customer.html?id=' + encodeURIComponent(i.leadId) : 'https://nobigdealwithjoedeal.com/pro/dashboard.html#calls';
  const when = (ms) => ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;color:#111">' +
    '<h2 style="margin:0 0 6px">' + escHtml(subject) + '</h2>' +
    '<p style="margin:0 0 14px;color:#555;font-size:13px">From your recorded calls, ' + escHtml(todayYmd) + '. Tick the task (or mark the call handled) and it drops off.</p>' +
    items.map((i) => '<div style="border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:0 0 10px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:' + (i.kind === 'urgent' ? '#b91c1c' : '#c2410c') + '">' + escHtml(label[i.kind]) + (i.due ? ' · ' + escHtml(i.due) : '') + '</div>' +
      '<div style="font-weight:700;margin:2px 0"><a href="' + escHtml(link(i)) + '" style="color:#111">' + escHtml(i.who) + '</a> <span style="font-weight:400;color:#666;font-size:12px">' + escHtml(when(i.startedAtMs)) + '</span></div>' +
      (i.promises.length ? '<ul style="margin:4px 0 4px 18px;padding:0;font-size:14px">' + i.promises.map((p) => '<li>' + escHtml(p) + '</li>').join('') + '</ul>' : '') +
      (i.summary ? '<div style="font-size:13px;color:#444">' + escHtml(i.summary) + '</div>' : '') +
      '</div>').join('') + '</div>';
  const text = subject + '\n\n' + items.map((i) => '- [' + label[i.kind] + (i.due ? ' ' + i.due : '') + '] ' + i.who + ': ' +
    (i.promises.length ? i.promises.join('; ') : i.summary) + '\n  ' + link(i)).join('\n');
  return { subject, html, text };
}

/**
 * Attaching a call to a customer: put the caller's number on the lead so
 * the NEXT call from it matches by itself. Fill blanks only — never
 * overwrite a number Jo typed (Thumbtack proxy numbers stay). Returns the
 * patch, or null when the number is already there / there's no room.
 */
function phonePatchForLead(lead, phoneDigits) {
  const d = phoneDigits10(phoneDigits);
  if (d.length !== 10 || !lead) return null;
  const have = [lead.phoneDigits, lead.phone, lead.phone2, lead.altPhone, lead.mobilePhone, lead.secondaryPhone].map(phoneDigits10);
  if (have.includes(d)) return null;
  const pretty = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  if (!phoneDigits10(lead.phone)) return { phone: pretty, phoneDigits: d };
  if (!phoneDigits10(lead.altPhone)) return { altPhone: pretty };
  return null;
}

module.exports = {
  SHORT_CALL_SEC,
  sidecarNameFor,
  parseSidecar,
  phonePatchForLead,
  collectSweepItems,
  buildSweepEmail,
  SWEEP_MAX_ITEMS,
  GROQ_MAX_BYTES,
  DAY_AUDIO_SEC_CAP,
  estimateAudioSec,
  pickToTranscribe,
  NOTES_SYSTEM,
  buildNotesPrompt,
  sanitizeNotes,
  buildCallActivity,
  buildFollowUpTask,
  CALL_TYPES,
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
