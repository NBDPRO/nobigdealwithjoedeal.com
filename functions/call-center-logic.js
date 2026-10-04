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
 * Dependency-light (phone-utils, schedule-window, stage-roles) so the tests
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
  // A number on 3+ leads is a proxy (proxyNumbers): it identifies nobody.
  for (const [d, ls] of idx) if (ls.length >= PROXY_MIN_LEADS) idx.delete(d);
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

// How far back call history goes (Jo, 2026-10-02): "I only want call history
// to go back as far as the beginning of 2026 … I don't want to bloat the CRM
// or confuse myself with unnecessary info." A fixed date, not "N days before
// the first run". It replaced the 90-day backlog, which only reached July 3.
const HISTORY_FROM = '2026-01-01';

/**
 * The oldest day folder the ingest may read. A config override can only
 * move it LATER; nothing before HISTORY_FROM is ever read.
 */
function historyFloor(cfgFrom) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(cfgFrom || '')) ? String(cfgFrom) : HISTORY_FROM;
  return f < HISTORY_FROM ? HISTORY_FROM : f;
}

/**
 * Where this run's scan starts. Normally the saved cursor. When the floor
 * differs from the one the cursor was built under (floorApplied), the cursor
 * restarts at the new floor once, so the days between it and the old
 * backlog get read. Already-filed calls are skipped by doc id, so the rescan
 * costs only Drive listings.
 */
function scanCursor(cfg, floor) {
  const c = cfg || {};
  return c.floorApplied === floor ? (c.cursorYmd || null) : null;
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
// 7.5 h (Jo, 2026-10-01: "raise it to 7.5 hours"), half an hour under Groq's
// 8 h free-tier ceiling so dictation and Voice Intelligence still have room.
const DAY_AUDIO_SEC_CAP = 7.5 * 3600;
// The cap is a setting (Jo, 2026-10-03: "catch up asap"): when the Groq
// account moves to a paid tier, integrations/callCenter.dayAudioCapHours
// lifts it without a deploy. Anything missing or invalid falls back to the
// free-tier 7.5 h; the setting is bounded to 1–48 h. Groq's own rate limit
// still stops a run cleanly if the account can't take more.
const DAY_AUDIO_CAP_MAX_HOURS = 48;
function dayAudioCapSec(cfgHours) {
  const h = Number(cfgHours);
  if (cfgHours == null || cfgHours === '' || !Number.isFinite(h) || h <= 0) return DAY_AUDIO_SEC_CAP;
  return Math.round(Math.max(1, Math.min(DAY_AUDIO_CAP_MAX_HOURS, h)) * 3600);
}
// Cube ACR's m4a runs ~4 KB/s; good enough to budget before Groq says.
function estimateAudioSec(sizeBytes) {
  return Math.max(1, Math.round((Number(sizeBytes) || 0) / 4000));
}

// Groq's free tier also caps audio per HOUR, and rejects with 429 "Rate
// limit reached for model …". That is about the account, not the call.
// Takes an Error (status 429) or the stored transcribeError string.
function isRateLimited(err) {
  if (!err) return false;
  if (typeof err === 'object' && Number(err.status) === 429) return true;
  const msg = typeof err === 'string' ? err : String(err.message || '');
  return /rate limit|too many requests|\b429\b/i.test(msg);
}

/**
 * Which stored calls to transcribe this run. An allow-list (Jo's one-call
 * test) works with the gate OFF and ignores everything else; with the gate
 * ON, newest first, within the per-run count and the day's audio budget.
 */
function pickToTranscribe(calls, { live, allowIds, maxCount, secLeft }) {
  const allow = Array.isArray(allowIds) ? allowIds.filter(Boolean) : [];
  // Three strikes and a call is skipped, but a strike means the CALL failed.
  // Groq's free-tier rate limit says nothing about the call, so a call whose
  // last error was a rate limit stays eligible (2026-10-02: six calls, 117
  // min of audio, had been dropped for good by a busy hour).
  const ready = (calls || []).filter((c) => c && c.status === 'stored' && c.storagePath
    && ((Number(c.transcribeAttempts) || 0) < 3 || isRateLimited(c.transcribeError)));
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

// Who / where the call is about (2026-10-03): 757 of 829 calls sat on no
// lead, mostly Thumbtack customers whose lead carries Thumbtack's masked
// number. These four optional facts let suggestLeadForCall match by name +
// town / street instead. Untrusted model output: sanitizeCallerFacts.
const SERVICES = ['roof', 'siding', 'gutters', 'repair', 'insurance'];
const CALLER_FACT_RULES = [
  'Also, about the customer (NOT Jo, NOT an insurance adjuster, supplier or sub). Each is null unless CLEARLY said on the call — never guess, never infer from the phone contact name:',
  ' "caller_name": the customer\'s name as they give it for themselves, or as Jo addresses them (e.g. "Dana Rivers", "Dana"), or null',
  ' "street": the street of the job / their home, house number only if spoken (e.g. "412 Oak Hill Dr", "Oak Hill Drive"), or null',
  ' "town": the town / city of the job (e.g. "Florence"), or a 5-digit ZIP if only that was said, or null',
  ' "service": one of ' + JSON.stringify(SERVICES) + ' — what the call is about — or null',
].join('\n');
const FACTS_SYSTEM = [
  'You read a transcript of a phone call taken or made by Jo, who runs No Big Deal Home Solutions, a small roofing / gutters / siding contractor in the Cincinnati / Northern Kentucky area.',
  'Return ONE JSON object and nothing else: {"caller_name": ..., "street": ..., "town": ..., "service": ...}',
  CALLER_FACT_RULES,
].join('\n');
function buildFactsPrompt({ transcript }) {
  return 'Transcript:\n' + String(transcript || '').slice(0, 30000);
}
// Bump when the fact rules change: calls extracted under an older version
// are re-read (bounded) by call-center.js reextractFacts.
const FACTS_VERSION = 1;

const NOT_SAID_RE = /^(null|none|n\/?a|unknown|not (said|given|stated|mentioned)|unclear|caller|customer|homeowner|jo|the caller|unspecified|-+)$/i;
function factText(v, max) {
  if (typeof v !== 'string') return null;
  // Letters, digits, spaces and the punctuation a name / address uses; the
  // rest (markup, quotes, control characters) goes.
  const t = v.normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N} .,'#-]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[.,'#-]+|[.,'#-]+$/g, '').trim();
  if (!t || t.length > max || NOT_SAID_RE.test(t) || !/\p{L}|\d/u.test(t)) return null;
  return t;
}
/** The model's caller facts → { name, street, town, service }, each null unless clean. */
function sanitizeCallerFacts(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const name = factText(r.caller_name, 60);
  const street = factText(r.street, 80);
  let town = factText(r.town, 40);
  if (town && /\d/.test(town) && !/^\d{5}$/.test(town)) town = null; // a town has no digits; a ZIP is exactly five
  const svc = typeof r.service === 'string' ? r.service.trim().toLowerCase() : '';
  return {
    name: name && /\p{L}{2}/u.test(name) && !/\d/.test(name) ? name : null,
    street: street && /\p{L}{2}/u.test(street) ? street : null,
    town,
    service: SERVICES.includes(svc) ? svc : null,
  };
}

const NOTES_SYSTEM = [
  'You read transcripts of phone calls made or taken by Jo, who runs No Big Deal Home Solutions, a small roofing / gutters / siding contractor in the Cincinnati area.',
  'Return ONE JSON object and nothing else:',
  '{"call_type": one of ' + JSON.stringify(CALL_TYPES) + ',',
  ' "summary": "2-3 plain sentences: who, what about, what was decided",',
  ' "promises": [{"who": "jo" | "them", "text": "a concrete thing someone said they would do, imperative, under 120 chars", "due": "YYYY-MM-DD" or null}],',
  ' "follow_up_date": "YYYY-MM-DD" or null (when Jo should next reach out, if the call implies one),',
  ' "urgent": true | false (an active leak, safety issue, or a hard deadline within 48 hours),',
  ' "caller_name": ..., "street": ..., "town": ..., "service": ... (see below)}',
  'Rules: only promises actually made on the call, at most 6. Resolve relative dates ("Thursday", "next week") against the call date given. ',
  'A call about family, friends or anything not business is "personal": then summary is "Personal call." and promises is [].',
  'Never invent prices, names or dates that were not said.',
].join('\n') + '\n' + CALLER_FACT_RULES;

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
    // Optional; a reply without them (older prompt, drift) → all null.
    callerFacts: personal ? sanitizeCallerFacts(null) : sanitizeCallerFacts(r),
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
    // When the call happened — the customer timeline sorts by it
    // (docs/pro/js/call-timeline.js); createdAt is only when it was filed.
    startedAtMs: Number(call.startedAtMs) || null,
    phoneCallId: call.id,
  };
}

/**
 * leads/{id}/activity/sms-{dayId} — a day of texts on the customer timeline.
 * One shape for the text-notes pass (text-inbox.js) and for re-filing a day
 * when its number joins a lead (call-center.js refileNumber).
 * day: { id, contactName, messageCount }.
 */
function buildTextDayActivity({ day, notes, ownerUid }) {
  return {
    userId: ownerUid, companyId: ownerUid, type: 'text', source: 'sms-backup',
    label: 'Texts' + (day.contactName ? ' · ' + day.contactName : '') + ' (' + (Number(day.messageCount) || 0) + ')',
    summary: notes.summary, promises: notes.promises, followUpDate: notes.followUpDate,
    phoneTextDayId: day.id,
    // When the texts happened — the customer timeline sorts by it.
    startedAtMs: Number(day.startedAtMs) || null,
  };
}

/** leads/{id}/tasks/sms-{dayId} — the call task shape, sourced to the texts. */
function buildTextDayTask({ day, notes, leadId, ownerUid, todayYmd, nowMs }) {
  const task = buildFollowUpTask({ call: { id: day.id, contactName: day.contactName, startedAtMs: day.startedAtMs }, notes, leadId, ownerUid, todayYmd, nowMs });
  if (!task) return null;
  Object.assign(task, { source: 'sms-backup', phoneTextDayId: day.id, createdBy: 'Text Inbox (AI notes)' });
  delete task.phoneCallId;
  return task;
}

/**
 * leads/{id}/tasks/cube-{docId} — ONE follow-up task per call, only when
 * Jo promised something or a follow-up date came out of it. Shape matches
 * Thursday's (docs/pro/js/tasks.js readers).
 */
// Only a RECENT call makes a task (Jo, 2026-10-01): the 90-day backlog would
// otherwise flood the task list with long-past "overdue" promises. Older
// calls still get their notes + timeline entry. The first test call (Jul 9)
// made one such stale task; this is why.
const TASK_WINDOW_MS = 14 * 24 * 3600 * 1000;

function buildFollowUpTask({ call, notes, leadId, ownerUid, todayYmd, nowMs }) {
  if (Number.isFinite(nowMs) && (Number(call.startedAtMs) || 0) < nowMs - TASK_WINDOW_MS) return null;
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
// Twice a day (07:15 and 15:15 ET) one email to Jo listing what Jo's calls
// say is still owed. Sources: noted phone_calls from the last 30 days and
// the one follow-up task each may have (leads/{id}/tasks/cube-{callId}).
//   due      — a task Jo hasn't ticked, due today or earlier
//   no file  — a call with no CRM customer where Jo promised something or a
//              follow-up date has come (insurance lines, new numbers)
//   urgent   — an urgent call in the last 36 h whose task isn't done
// A call Jo marked handled (handledAtMs) never shows. Nothing open → no email.

const SWEEP_LOOKBACK_MS = 30 * 24 * 3600 * 1000;
const URGENT_WINDOW_MS = 36 * 3600 * 1000;
// The list itself is UNCAPPED (2026-10-03): it used to stop at 30, and on
// 10-03 there were 57 open — 27 silently missing from the email. The page
// (Call Center → "Said you'd do", one at a time) shows every item; the
// email shows the first SWEEP_EMAIL_SHOW and says how many more there are.
const SWEEP_EMAIL_SHOW = 15;
const APP = 'https://nobigdealwithjoedeal.com/pro/';
const DECK_URL = APP + 'dashboard.html?open=promises#calls';
const deckItemUrl = (callId) => APP + 'dashboard.html?open=promises&item=' + encodeURIComponent(callId) + '#calls';

function collectSweepItems({ calls, tasksByCallId, nowMs, todayYmd }) {
  const tasks = tasksByCallId instanceof Map ? tasksByCallId : new Map(Object.entries(tasksByCallId || {}));
  const out = [];
  for (const c of calls || []) {
    if (!c || c.status !== 'noted' || c.handledAtMs) continue;
    if ((Number(c.startedAtMs) || 0) < nowMs - SWEEP_LOOKBACK_MS) continue;
    // Snoozed from the deck: a call with no task to move carries the date.
    if (c.snoozeUntilYmd && String(c.snoozeUntilYmd) > todayYmd) continue;
    const mine = (Array.isArray(c.promises) ? c.promises : []).filter((p) => p && p.who === 'jo');
    const task = c.leadId ? tasks.get(c.id) : null;
    const who = c.contactName || (c.phoneDigits ? '(' + c.phoneDigits.slice(0, 3) + ') ' + c.phoneDigits.slice(3, 6) + '-' + c.phoneDigits.slice(6) : 'Unknown number');
    const base = { callId: c.id, channel: c.channel === 'text' ? 'text' : 'call', leadId: c.leadId || null, who, startedAtMs: c.startedAtMs, summary: c.summary || '', promises: mine.map((p) => p.text), phoneDigits: c.phoneDigits || '', hasTask: !!task, contactName: c.contactName || '', callType: c.callType || '' };
    if (task) {
      if (task.done === true) continue;
      const urgentNow = c.urgent && (Number(c.startedAtMs) || 0) >= nowMs - URGENT_WINDOW_MS;
      if (urgentNow) out.push(Object.assign(base, { kind: 'urgent', due: task.dueDate || todayYmd }));
      else if (task.dueDate && task.dueDate <= todayYmd) out.push(Object.assign(base, { kind: 'due', due: task.dueDate }));
      continue;
    }
    // No customer on file: only recent calls (same window as tasks).
    if (!c.leadId && (Number(c.startedAtMs) || 0) >= nowMs - TASK_WINDOW_MS) {
      const dues = mine.map((p) => p.due).filter(Boolean).concat(c.followUpDate ? [c.followUpDate] : []).sort();
      const due = dues[0] || null;
      const urgentNow = c.urgent && (Number(c.startedAtMs) || 0) >= nowMs - URGENT_WINDOW_MS;
      if (urgentNow) out.push(Object.assign(base, { kind: 'urgent', due: due || todayYmd }));
      else if (mine.length && (!due || due <= todayYmd)) out.push(Object.assign(base, { kind: 'nofile', due: due || todayYmd }));
      else if (!mine.length && due && due <= todayYmd) out.push(Object.assign(base, { kind: 'nofile', due }));
    }
  }
  const rank = { urgent: 0, due: 1, nofile: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || String(a.due).localeCompare(String(b.due)) || (a.startedAtMs || 0) - (b.startedAtMs || 0));
}

/**
 * Which existing customer a "no customer on file" call is probably about
 * (2026-10-03: 7 of the 45 open that day matched one). Returns
 * { leadId, name, why } only when EXACTLY ONE lead matches — never a guess
 * between two. Rules, strongest first:
 *   the phone's contact name contains the lead's full name;
 *   the lead's full name is said on the call (summary / transcript);
 *   the lead's numbered street address is said on the call.
 * leads: [{ id, firstName, lastName, address, deleted }].
 */
const normMatch = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const isThumbtackLead = (l) => /thumb\s*tack/i.test(String((l && l.source) || ''));
const THUMBTACK_SAID_RE = /\bthumb\s*tack\b/i;
// Bump when the rules change: calls checked under an older version are
// re-checked by the backfill (call-center.js backfillSuggestions).
const SUGGEST_RULES_VERSION = 3; // 3: caller facts (name + town / street), 2026-10-03
const leadLabel = (l) => ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'Customer';
function suggestLeadForCall(call, leads) {
  if (!call || call.leadId) return null;
  const live = (leads || []).filter((l) => l && l.id && l.deleted !== true);
  // The facts tier runs only when the rules above find no single lead.
  return suggestByContactOrSaid(call, live) || suggestByFacts(call.callerFacts, live);
}
function suggestByContactOrSaid(call, live) {
  const contact = ' ' + normMatch(call.contactName) + ' ';
  const said = ' ' + normMatch([call.summary, call.transcript].join(' ')) + ' ';
  const name = leadLabel;
  const hits = new Map();
  for (const l of live) {
    const first = normMatch(l.firstName), last = normMatch(l.lastName);
    const full = (first + ' ' + last).trim();
    const street = normMatch(String(l.address || '').split(',')[0]);
    let why = '';
    if (first.length > 1 && last.length > 2 && full.length > 4 && contact.includes(' ' + full + ' ')) why = 'their name in your phone';
    else if (first.length > 2 && last.length > 3 && said.includes(' ' + full + ' ')) why = 'their name said on the call';
    else if (street.length > 8 && /^\d+ [a-z]/.test(street) && said.includes(' ' + street + ' ')) why = 'their address said on the call';
    if (why) hits.set(l.id, { leadId: l.id, name: name(l), why });
  }
  if (hits.size) return hits.size === 1 ? [...hits.values()][0] : null;
  // Thumbtack leads (2026-10-03 prod audit: 98 of 102 carry a number from
  // Thumbtack's masked pool, so the customer's own number never matches; the
  // webhook sends no other number). Weaker evidence, tried only when nothing
  // above matched, and still only a UNIQUE Thumbtack lead:
  //   the phone contact reads "<first> <last initial>" (Thumbtack's display);
  //   the call mentions Thumbtack and says the lead's first name.
  const tt = live.filter(isThumbtackLead);
  const tier = (test, why) => {
    const m = tt.filter(test);
    return m.length === 1 ? { leadId: m[0].id, name: name(m[0]), why } : (m.length > 1 ? false : null);
  };
  const byContact = tier((l) => {
    const first = normMatch(l.firstName), initial = normMatch(l.lastName).slice(0, 1);
    return first.length > 2 && !!initial && new RegExp(' ' + first + ' ' + initial).test(contact);
  }, 'Thumbtack lead — their first name and initial in your phone');
  if (byContact !== null) return byContact || null;
  if (!THUMBTACK_SAID_RE.test(said)) return null;
  return tier((l) => { const first = normMatch(l.firstName); return first.length > 2 && said.includes(' ' + first + ' '); },
    'Thumbtack lead — the call mentions Thumbtack and their first name') || null;
}

// ── Caller facts → one open lead (2026-10-03) ─────────────────────────────
// The AI notes' caller_name / street / town (sanitizeCallerFacts) scored
// against the tenant's OPEN leads. A lead qualifies only on strong evidence:
//   name (first + last; first + last initial on a Thumbtack lead) + town/ZIP
//   name + street name
//   house number + street name
// and anything that CONTRADICTS (a different last name, house number or
// town) rules the lead out. Suggested only when exactly one lead qualifies
// and no other same-named lead lacks the address to tell them apart.
// why reads like "name + Florence" for the "Looks like X" chip.
const SR = require('./stage-roles');
const STREET_SUFFIX = { street: 'st', st: 'st', drive: 'dr', dr: 'dr', road: 'rd', rd: 'rd', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct',
  avenue: 'ave', ave: 'ave', av: 'ave', boulevard: 'blvd', blvd: 'blvd', place: 'pl', pl: 'pl', circle: 'cir', cir: 'cir', way: 'way',
  trail: 'trl', trl: 'trl', parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', terrace: 'ter', ter: 'ter', pike: 'pike', pk: 'pike' };
const DIRS = { north: 'n', south: 's', east: 'e', west: 'w', n: 'n', s: 's', e: 'e', w: 'w' };
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'mister']);
function parseStreet(s) {
  let t = normMatch(s).replace(/\b(apt|unit|suite|ste|lot)\b.*$/, '').split(' ').filter(Boolean);
  const num = /^\d+[a-z]?$/.test(t[0] || '') ? t.shift() : '';
  t = t.map((w) => DIRS[w] || w);
  while (t.length > 1 && STREET_SUFFIX[t[t.length - 1]]) t.pop();
  if (t.length > 1 && DIRS[t[0]] && t[0].length === 1) t.shift();
  const core = t.join(' ');
  return { num, core: core.length >= 3 && /[a-z]/.test(core) ? core : '' };
}
function nameLevel(factName, l) {
  const toks = normMatch(factName).split(' ').filter((w) => w && !TITLES.has(w));
  const lp = normMatch((l.firstName || '') + ' ' + (l.lastName || '')).split(' ').filter(Boolean);
  if (!toks.length || lp.length < 2 || lp[0].length < 2) return toks.length ? 'none' : '';
  const lf = lp[0], ll = lp[lp.length - 1];
  if (toks[0] !== lf) return 'none';
  if (toks.length < 2) return 'first';
  const last = toks[toks.length - 1];
  if (last === ll && ll.length > 1) return 'full';
  if (isThumbtackLead(l) && (ll.length === 1 ? last[0] === ll : last.length === 1 && ll[0] === last)) return 'full';
  return 'conflict';
}
// "412 Oak Hill Dr, Florence, KY" → street + rest; "Burlington, KY 41005"
// (a Thumbtack lead often has no street) → no street, all of it is the town.
function splitAddress(addr) {
  const segs = String(addr || '').split(',').map((x) => x.trim()).filter(Boolean);
  const first = segs[0] || '';
  const toks = normMatch(first).split(' ');
  const looksStreet = /^\d/.test(first) || (toks.length > 1 && !!STREET_SUFFIX[toks[toks.length - 1]]);
  if (!looksStreet) return { street: '', rest: segs.join(' ') };
  return { street: first, rest: segs.slice(1).join(' ') };
}
function townLevel(factTown, l) {
  const t = normMatch(factTown);
  if (!t) return '';
  const rest = splitAddress(l.address).rest;
  const hay = ' ' + normMatch([rest, l.city, l.zip, l.zipCode].join(' ')) + ' ';
  if (!hay.trim()) return '';                      // no town on the lead: unknown, not a contradiction
  if (t.length >= 3 && hay.includes(' ' + t + ' ')) return 'match';
  return 'conflict';
}
function streetLevel(factStreet, l) {
  const f = parseStreet(factStreet);
  const lead = parseStreet(splitAddress(l.address).street);
  if (!f.core || !lead.core) return '';
  if (f.core !== lead.core) return 'other';
  if (f.num && lead.num) return f.num === lead.num ? 'full' : 'conflict';
  return 'name';
}
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
function suggestByFacts(facts, live) {
  const f = facts && typeof facts === 'object' ? sanitizeCallerFacts({ caller_name: facts.name, street: facts.street, town: facts.town }) : null;
  if (!f || (!f.name && !f.street)) return null;
  const open = live.filter((l) => !SR.isDecided(l));
  const strong = [], sameNameNoAddress = [];
  for (const l of open) {
    const n = f.name ? nameLevel(f.name, l) : '';
    const t = f.town ? townLevel(f.town, l) : '';
    const s = f.street ? streetLevel(f.street, l) : '';
    // A different street rules a lead out too (a second property is Jo's call, not a guess).
    if (n === 'conflict' || t === 'conflict' || s === 'conflict' || s === 'other') continue;
    const street = splitAddress(l.address).street;
    let why = '';
    if (s === 'full') why = street;
    else if (n === 'full' && s === 'name') why = 'name + ' + street;
    else if (n === 'full' && t === 'match') why = 'name + ' + titleCase(f.town);
    if (why) strong.push({ leadId: l.id, name: leadLabel(l), why: clip(why, 80) });
    else if (n === 'full' && !String(l.address || '').trim()) sameNameNoAddress.push(l.id);
  }
  if (strong.length !== 1) return null;
  return sameNameNoAddress.some((id) => id !== strong[0].leadId) ? null : strong[0];
}

/**
 * Numbers on 3 or more of a tenant's leads are proxies (a shared office
 * line, a lead service's relay), not a person: they never match a call by
 * themselves and a number-wide re-file never runs on them.
 */
const PROXY_MIN_LEADS = 3;
function proxyNumbers(leads) {
  const count = new Map();
  for (const l of leads || []) {
    if (!l || l.deleted === true) continue;
    const seen = new Set([l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].map(phoneDigits10).filter((d) => d.length === 10));
    seen.forEach((d) => count.set(d, (count.get(d) || 0) + 1));
  }
  return new Set([...count].filter(([, n]) => n >= PROXY_MIN_LEADS).map(([d]) => d));
}

/**
 * Calls to and from a phone contact Jo tagged "NBD Customer" that sit on no
 * lead (2026-10-03: 328 of 477 calls landed in the contact bucket). One row
 * per number (or per contact name when there's no number), newest call
 * first. A row MATCHES when exactly one lead carries the number, or — with
 * no number match — exactly one lead's full name is in the contact name
 * (suggestLeadForCall's first rule). Everything else is "not in the CRM yet".
 * Pure: the callable previews this and writes only what Jo confirms.
 * calls: phone_calls rows; leads: [{ id, firstName, lastName, address, phone…, deleted }].
 */
function taggedContactPlan({ calls, leads }) {
  const live = (leads || []).filter((l) => l && l.id && l.deleted !== true);
  const index = buildPhoneIndex(live);
  const groups = new Map();
  for (const c of calls || []) {
    if (!c || c.leadId || c.status === 'personal' || !(Array.isArray(c.tags) && c.tags.includes('customer'))) continue;
    const d = phoneDigits10(c.phoneDigits);
    const key = d.length === 10 ? 'num:' + d : 'name:' + normMatch(c.contactName);
    if (key === 'name:') continue;
    if (!groups.has(key)) groups.set(key, { key, phoneDigits: d.length === 10 ? d : '', contactName: c.contactName || '', calls: [] });
    groups.get(key).calls.push(c);
  }
  const name = (l) => ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'Customer';
  const matches = [], notInCrm = [];
  for (const g of groups.values()) {
    g.calls.sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));
    const row = { key: g.key, phoneDigits: g.phoneDigits, contactName: g.contactName, callIds: g.calls.map((c) => c.id), latestAtMs: g.calls[0].startedAtMs || 0 };
    const hits = g.phoneDigits && index.has(g.phoneDigits) ? index.get(g.phoneDigits) : [];
    let lead = null, why = '';
    if (hits.length === 1) { lead = hits[0]; why = 'their number is on the customer'; }
    else if (!hits.length) {
      const s = suggestLeadForCall({ contactName: g.contactName }, live);
      if (s) { lead = live.find((l) => l.id === s.leadId); why = s.why; }
    }
    if (lead) matches.push(Object.assign(row, { leadId: lead.id, leadName: name(lead), why }));
    else notInCrm.push(Object.assign(row, { ambiguous: hits.length > 1 }));
  }
  const newest = (a, b) => b.latestAtMs - a.latestAtMs;
  return { matches: matches.sort(newest), notInCrm: notInCrm.sort(newest) };
}

/** "Snooze N days" lands on this date (America/New_York calendar days). */
function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + Number(days)));
  return t.toISOString().slice(0, 10);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The sweep email. Internal (Jo only); every value escaped. */
function buildSweepEmail({ items, todayYmd, slot }) {
  const n = items.length;
  const shown = items.slice(0, SWEEP_EMAIL_SHOW);
  const more = n - shown.length;
  const subject = (items.some((i) => i.kind === 'urgent') ? '🚨 ' : '') + 'Calls: ' + n + ' thing' + (n === 1 ? '' : 's') + ' you said you\'d do' + (slot === 'pm' ? ' (afternoon check)' : '');
  const label = { urgent: 'Urgent', due: 'Due', nofile: 'No customer on file' };
  const count = (k) => items.filter((i) => i.kind === k).length;
  const isNewLead = (i) => i.kind === 'nofile' && i.callType === 'lead' && !i.suggest;
  const newLeads = items.filter(isNewLead).length;
  const breakdown = [['urgent', 'urgent'], ['due', 'due'], ['nofile', 'no customer on file']]
    .filter(([k]) => count(k)).map(([k, t]) => count(k) + ' ' + t).join(' · ') +
    (newLeads ? ' (' + newLeads + ' sound like new leads not in the CRM yet)' : '');
  const hint = (i) => i.suggest ? 'Looks like ' + i.suggest.name + ' — ' + i.suggest.why + '. File it on them in one tap.'
    : isNewLead(i) ? '🆕 Sounds like a new lead — not in the CRM yet. Make it a lead in one tap.' : '';
  // A name opens that person: the customer page, else their call's card in
  // the Call Center (call-center-view.js ?call=, 2026-10-03).
  const link = (i) => i.leadId ? APP + 'customer.html?id=' + encodeURIComponent(i.leadId) : APP + 'dashboard.html?call=' + encodeURIComponent(i.callId) + '#calls';
  const when = (ms) => ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const btn = '<a href="' + escHtml(DECK_URL) + '" style="display:inline-block;background:#BD5728;color:#fff;font-weight:700;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:15px">Work through all ' + n + ', one at a time →</a>';
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;color:#111">' +
    '<h2 style="margin:0 0 6px">' + escHtml(subject) + '</h2>' +
    '<p style="margin:0 0 10px;color:#555;font-size:13px">From your recorded calls, ' + escHtml(todayYmd) + (breakdown ? ': ' + escHtml(breakdown) : '') + '. Swipe each one done, later or snooze — it drops off.</p>' +
    '<p style="margin:0 0 16px">' + btn + '</p>' +
    shown.map((i) => '<div style="border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:0 0 10px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:' + (i.kind === 'urgent' ? '#b91c1c' : '#c2410c') + '">' + escHtml(label[i.kind]) + (i.due ? ' · ' + escHtml(i.due) : '') + '</div>' +
      '<div style="font-weight:700;margin:2px 0"><a href="' + escHtml(link(i)) + '" style="color:#111">' + escHtml(i.who) + '</a> <span style="font-weight:400;color:#666;font-size:12px">' + escHtml((i.channel === 'text' ? 'texts · ' : '') + when(i.startedAtMs)) + '</span></div>' +
      (i.promises.length ? '<ul style="margin:4px 0 4px 18px;padding:0;font-size:14px">' + i.promises.map((p) => '<li>' + escHtml(p) + '</li>').join('') + '</ul>' : '') +
      (i.summary ? '<div style="font-size:13px;color:#444">' + escHtml(i.summary) + '</div>' : '') +
      (hint(i) ? '<div style="font-size:13px;color:#1d4ed8;margin-top:4px">' + escHtml(hint(i)) + '</div>' : '') +
      '<div style="margin-top:6px;font-size:13px"><a href="' + escHtml(deckItemUrl(i.callId)) + '" style="color:#BD5728;font-weight:700">Do it →</a></div>' +
      '</div>').join('') +
    (more > 0 ? '<p style="margin:4px 0 0;font-size:14px"><a href="' + escHtml(DECK_URL) + '" style="color:#BD5728;font-weight:700">+ ' + more + ' more — open the list →</a></p>' : '') +
    '</div>';
  const text = subject + (breakdown ? '\n' + breakdown : '') + '\n\nWork through them one at a time: ' + DECK_URL + '\n\n' +
    shown.map((i) => '- [' + label[i.kind] + (i.due ? ' ' + i.due : '') + '] ' + i.who + ': ' +
      (i.promises.length ? i.promises.join('; ') : i.summary) + '\n  ' + deckItemUrl(i.callId)).join('\n') +
    (more > 0 ? '\n\n+ ' + more + ' more: ' + DECK_URL : '');
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

/**
 * "The CRM knows I called" (2026-10-03). A noted call on a matched customer
 * updates the lead itself, not only its timeline:
 *   lastContactedAt / lastContactType 'call' — only when this call is newer
 *     than what the lead already has (a backlog call never rolls it back).
 *     Same fields the customer page's Call / Text / Email buttons write; Ask
 *     Joe's "gone quiet" check and the inbound-SMS router read them.
 *   followUp ('YYYY-MM-DD', the edit modal's <input type="date"> value — the
 *     kanban Due chip, the follow-up banner and Ask Joe read it) — from the
 *     AI follow-up date, ONLY when the lead has none or its date has passed,
 *     and only for a recent call (TASK_WINDOW_MS, as tasks). A date Jo set
 *     that is still ahead is never touched.
 * Returns { lastContactedAtMs?, lastContactType?, followUp? } or null; the
 * caller turns lastContactedAtMs into a Firestore Timestamp.
 */
function leadContactPatch({ lead, call, notes, todayYmd, nowMs }) {
  if (!lead || !call) return null;
  const out = {};
  const at = Number(call.startedAtMs) || 0;
  if (at > 0 && at > tsMs(lead.lastContactedAt)) {
    out.lastContactedAtMs = at;
    out.lastContactType = 'call';
  }
  const fu = notes && ymdOrNull(notes.followUpDate);
  const recent = !Number.isFinite(nowMs) || at >= nowMs - TASK_WINDOW_MS;
  const have = ymdOrNull(lead.followUp);
  const haveIsOpen = have && have >= todayYmd;
  const haveRaw = String(lead.followUp == null ? '' : lead.followUp).trim();
  // An unparseable non-empty followUp is something Jo typed: leave it.
  if (fu && recent && !haveIsOpen && (have || !haveRaw) && fu !== have) out.followUp = fu;
  return Object.keys(out).length ? out : null;
}

/** The immediate push for an urgent call: { title, body } (plain text, Jo only). */
function urgentPushText({ call, notes, leadName }) {
  const d = String((call && call.phoneDigits) || '');
  const who = (call && call.contactName) || leadName || (d.length >= 10 ? '(' + d.slice(-10, -7) + ') ' + d.slice(-7, -4) + '-' + d.slice(-4) : 'Unknown caller');
  return { title: 'Urgent call — ' + clip(who, 60), body: clip((notes && notes.summary) || 'Marked urgent from the call notes.', 180) };
}

module.exports = {
  leadContactPatch,
  urgentPushText,
  TASK_WINDOW_MS,
  SHORT_CALL_SEC,
  sidecarNameFor,
  parseSidecar,
  phonePatchForLead,
  collectSweepItems,
  buildSweepEmail,
  addDaysYmd,
  suggestLeadForCall,
  suggestByFacts,
  sanitizeCallerFacts,
  FACTS_SYSTEM,
  buildFactsPrompt,
  FACTS_VERSION,
  SERVICES,
  SUGGEST_RULES_VERSION,
  isThumbtackLead,
  proxyNumbers,
  PROXY_MIN_LEADS,
  taggedContactPlan,
  buildTextDayActivity,
  buildTextDayTask,
  SWEEP_EMAIL_SHOW,
  DECK_URL,
  GROQ_MAX_BYTES,
  DAY_AUDIO_SEC_CAP,
  DAY_AUDIO_CAP_MAX_HOURS,
  dayAudioCapSec,
  estimateAudioSec,
  pickToTranscribe,
  isRateLimited,
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
  HISTORY_FROM,
  historyFloor,
  scanCursor,
  buildCallDoc,
  CARRIER_RE,
};
