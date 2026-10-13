'use strict';
/**
 * visit-capture-logic.js - the pure half of the in-person visit pipeline
 * (functions/visit-capture.js does the I/O). No Firestore, no Storage, no
 * network, no clock: callers pass nowMs / todayYmd.
 *
 *   documentation/projects/VISIT-CAPTURE-PR2-2026-10-13.md
 *   documentation/projects/VISIT-RECORDER-PR1-2026-10-13.md   (the client half)
 *
 * What lives here:
 *   - classifyProviderError   an AI provider OUTAGE is never a strike
 *   - nextStep                the state machine, from the doc alone
 *   - buildVocabularyPrompt / correctTranscript   Whisper hint + keyword fixes
 *   - notes prompt + sanitizeVisitNotes
 *   - rankSuggestions         appointment / spoken name / GPS, WITH EVIDENCE
 *   - buildAttachment         timeline row + promise tasks + follow-ups
 *
 * Nothing here files a recording under a customer on a guess. rankSuggestions
 * returns chips; autoAttach is always false. The one automatic attach is a
 * capture the CLIENT already pre-attached (started from a customer page).
 */

const L = require('./call-center-logic');
const PR = require('./promise-logic');

// ── limits ──────────────────────────────────────────────────────────────
const MAX_DURATION_SEC = 60 * 60 + 120;   // the client caps at 60:00; two minutes of slack
const OBJECT_WAIT_MS = 24 * 3600 * 1000;  // a doc whose object never appears for a day is failed
const MAX_TRANSCRIBE_STRIKES = 3;
const MAX_NOTES_STRIKES = 3;
const LEASE_MS = 9 * 60 * 1000;           // the trigger's timeout is 540 s
const APPT_WINDOW_MS = 60 * 60 * 1000;    // +-60 min, the same window the phone uses
const GPS_MIN_RADIUS_M = 40;
const GPS_MAX_RADIUS_M = 200;
const GPS_MAX_ACCURACY_M = 150;           // a worse fix cannot separate houses
const MAX_CHIPS = 3;
const SUGGEST_RULES_VERSION = 1;
const VOCAB_MAX_CHARS = 560;              // Whisper's prompt cap is ~224 tokens; 2.5 chars/token is the worst case
const NOTES_MAX_TRANSCRIPT_CHARS = 60000;
const RETENTION_DEFAULT_DAYS = 90;        // same default as recordingRetentionCron

const AUDIO_PATH_RE = (uid, id) => new RegExp('^audio/' + String(uid).replace(/[^A-Za-z0-9_-]/g, '') + '/_inbox/' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '\\.(webm|m4a|ogg|mp3|wav)$');

// Server-owned pipeline states (the doc's `pipelineStatus`; the client's own
// `status` stays the upload lifecycle, so a stale client write can never knock
// the pipeline back or forth).
const PIPELINE = Object.freeze({
  QUEUED: 'queued',
  WAITING_OBJECT: 'waiting_object',
  TRANSCRIBE_PENDING: 'transcribe_pending',
  CONSENT_PENDING: 'consent_pending',
  TRANSCRIBED: 'transcribed',
  NOTES_PENDING: 'notes_pending',
  READY: 'ready',
  NOTES_FAILED: 'notes_failed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  QUARANTINED: 'quarantined_consent',
  DISCARDED: 'discarded',
});
// The sweep re-visits exactly these.
const RETRY_STATES = [PIPELINE.WAITING_OBJECT, PIPELINE.TRANSCRIBE_PENDING, PIPELINE.CONSENT_PENDING, PIPELINE.TRANSCRIBED, PIPELINE.NOTES_PENDING];

const str = (v) => String(v == null ? '' : v);
const clip = (s, n) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const ymdOrNull = (v) => {
  const s = str(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return PR.isYmd(s) ? s : null;
};
function etToday(nowMs) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  } catch (_) { return new Date(nowMs).toISOString().slice(0, 10); }
}
function etWeekday(nowMs) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date(nowMs)); } catch (_) { return ''; }
}

// ── provider outage ─────────────────────────────────────────────────────
/**
 * An AI provider OUTAGE: out of credit, key missing/revoked, rate limit, 5xx.
 * It says nothing about the recording, so it is never a strike. Same contract
 * and same answers as classifyProviderError in functions/call-center-logic.js
 * on fix/call-line-ai-credit-failures (PR #2437): ONE rule for the call line
 * and the visit line. When #2437 merges, this becomes a re-export and the
 * parity assertions in tests/visit-capture-pipeline-2026-10-13.test.js (they
 * run both when both exist) keep the two from drifting.
 * Returns null for anything that is the RECORDING's fault, else
 *   { provider, kind: credit|auth|rate_limit|overloaded, reason, needsAction }
 */
function classifyProviderError(err) {
  if (typeof L.classifyProviderError === 'function') return L.classifyProviderError(err);
  if (!err) return null;
  const isObj = typeof err === 'object';
  const msg = isObj ? str(err.message) : str(err);
  if (!msg && !(isObj && err.status)) return null;
  const status = isObj ? Number(err.status) || 0 : 0;
  let provider = isObj && err.provider ? str(err.provider) : '';
  if (!provider) provider = /^\s*anthropic\b|anthropic-not-configured/i.test(msg) ? 'anthropic' : (/groq/i.test(msg) ? 'groq' : 'ai');
  const m = /^\s*anthropic (\d{3})\b/i.exec(msg) || /^\s*groq rejected: HTTP (\d{3})\b/i.exec(msg);
  const code = status || (m ? Number(m[1]) : 0);
  const rate = /rate limit|too many requests|\b429\b/i.test(msg);
  let kind = null;
  if (/credit balance is too low|insufficient[_ ]?(credit|funds|quota)|exceeded your (current )?quota|plans?\s*(&|and)\s*billing|payment required/i.test(msg) || code === 402) kind = 'credit';
  else if (/invalid[ _-]?(x-)?api[ _-]?key|authentication[_ ]error|permission[_ ]error|unauthori[sz]ed|(anthropic|groq)-not-configured|not-configured|api key (is )?(missing|unset|revoked)/i.test(msg) || code === 401 || code === 403) kind = 'auth';
  else if (rate || code === 429 || /rate[_ ]limit[_ ]error/i.test(msg)) kind = 'rate_limit';
  else if (/overloaded/i.test(msg) || code === 529 || (code >= 500 && code <= 599)) kind = 'overloaded';
  if (!kind) return null;
  const who = provider === 'anthropic' ? 'Anthropic' : (provider === 'groq' ? 'Groq' : 'The AI provider');
  const reason = {
    credit: who + ' account is out of credit',
    auth: who + ' rejected the API key (missing, invalid or revoked)',
    rate_limit: who + ' rate limit reached (clears by itself)',
    overloaded: who + ' is overloaded or down (clears by itself)',
  }[kind];
  return { provider, kind, reason, needsAction: kind === 'credit' || kind === 'auth' };
}

/** Minutes to wait before the sweep tries again after an outage of this kind. */
function outageRetryMs(kind) {
  if (kind === 'credit' || kind === 'auth') return 60 * 60 * 1000;   // only Jo can fix it; do not hammer
  if (kind === 'rate_limit') return 10 * 60 * 1000;
  return 5 * 60 * 1000;
}

// ── retention ───────────────────────────────────────────────────────────
function retentionDays(company) {
  const d = Number(company && company.recordingRetentionDays);
  return Number.isFinite(d) && d >= 7 && d <= 3650 ? Math.round(d) : RETENTION_DEFAULT_DAYS;
}

// ── the state machine ───────────────────────────────────────────────────
/**
 * What should the pipeline do for this doc RIGHT NOW? Decided from the doc
 * alone (no reads), so the trigger's own writes re-fire it for free and every
 * answer for a finished doc is 'none'.
 *
 *   discard   the client discarded it (or deleted it): audio must go
 *   process   verify the object, then transcribe / notes as the state says
 *   finalize  notes are in (or are pending) and a customer is chosen: write
 *             the timeline row, tasks, facts - idempotent
 *   none
 */
/** The idempotency key of the last finalize: which customer, and whether notes were in. */
function finalizeKey(d) { return d && d.leadId ? String(d.leadId) + ':' + (d.notes ? 'n' : 't') : ''; }

function nextStep(doc, nowMs) {
  const d = doc && typeof doc === 'object' ? doc : null;
  if (!d) return { step: 'none', why: 'no doc' };
  if (d.status === 'discarded') {
    return d.pipelineStatus === PIPELINE.DISCARDED && d.audioLive !== true ? { step: 'none', why: 'discard done' } : { step: 'discard' };
  }
  if (d.status !== 'uploaded') return { step: 'none', why: 'not uploaded' };
  const p = d.pipelineStatus || '';
  const due = Number(d.pipelineNextAtMs) || 0;
  if (Number(d.pipelineLeaseUntilMs) > nowMs) return { step: 'none', why: 'leased' };
  // A skip that could not delete its audio yet: finish the delete.
  if ((p === PIPELINE.SKIPPED || p === PIPELINE.QUARANTINED) && d.audioLive === true) return due <= nowMs ? { step: 'purge' } : { step: 'none', why: 'purge backoff' };
  const wantsFinalize = !!d.leadId && d.finalizedKey !== finalizeKey(d)
    && (p === PIPELINE.READY || p === PIPELINE.NOTES_PENDING || p === PIPELINE.NOTES_FAILED || p === PIPELINE.TRANSCRIBED);
  if (!p || p === PIPELINE.QUEUED) return due <= nowMs ? { step: 'process', stage: 'start' } : { step: 'none', why: 'backoff' };
  if (p === PIPELINE.WAITING_OBJECT || p === PIPELINE.TRANSCRIBE_PENDING || p === PIPELINE.CONSENT_PENDING) {
    return due <= nowMs ? { step: 'process', stage: p } : { step: 'none', why: 'backoff' };
  }
  if (p === PIPELINE.TRANSCRIBED || p === PIPELINE.NOTES_PENDING) {
    // Transcript is saved. Notes retry on their schedule; a finalize may still be wanted now.
    if (due <= nowMs) return { step: 'process', stage: 'notes' };
    return wantsFinalize ? { step: 'finalize' } : { step: 'none', why: 'backoff' };
  }
  if (p === PIPELINE.READY || p === PIPELINE.NOTES_FAILED) return wantsFinalize ? { step: 'finalize' } : { step: 'none', why: 'settled' };
  return { step: 'none', why: 'terminal ' + p };
}

// ── vocabulary hint + keyword corrections ───────────────────────────────
const FIXED_TERMS = ['GAF', 'TAMKO', 'IKO', 'Owens Corning', 'CertainTeed', 'Timberline HDZ', 'drip edge', 'ridge vent', 'ice and water shield', 'ACV', 'RCV', 'deductible', 'adjuster'];

/**
 * A Whisper `prompt`: the customers likely in the room, their streets, then
 * the fixed roofing words. Capped by characters (the model keeps ~224 tokens;
 * names tokenise badly, so 560 chars is the safe side). `priorityNames` (the
 * pre-attached customer, today's appointment customers) come first.
 */
function buildVocabularyPrompt({ priorityNames, names, streets, towns } = {}) {
  const seen = new Set();
  const take = (list, max) => {
    const out = [];
    for (const raw of list || []) {
      const t = clip(String(raw || '').replace(/[^\p{L}\p{N} .'#&-]/gu, ' '), 40);
      const k = t.toLowerCase();
      if (!t || t.length < 3 || seen.has(k)) continue;
      seen.add(k); out.push(t);
      if (out.length >= max) break;
    }
    return out;
  };
  const head = 'Roofing visit, Cincinnati and Northern Kentucky.';
  const fixed = 'Terms: ' + FIXED_TERMS.join(', ') + '.';
  const budget = VOCAB_MAX_CHARS - head.length - fixed.length - 40;
  const parts = [];
  let used = 0;
  const addList = (label, items) => {
    if (!items.length) return;
    const kept = [];
    let line = label + ': ';
    for (const it of items) {
      const add = (kept.length ? ', ' : '') + it;
      if (used + line.length + add.length + 1 > budget) break;
      kept.push(it); line += add;
    }
    if (!kept.length) return;
    line += '.';
    used += line.length + 1;
    parts.push(line);
  };
  addList('Customers', take([].concat(priorityNames || [], names || []), 14));
  addList('Streets', take(streets || [], 8));
  addList('Towns', take(towns || [], 5));
  const out = [head].concat(parts, [fixed]).join(' ');
  return out.length > VOCAB_MAX_CHARS ? out.slice(0, VOCAB_MAX_CHARS) : out;
}

// Phrase-level fixes for words Whisper reliably mangles in this trade. Each is
// a whole-word, case-insensitive swap with no way to hit an ordinary word.
const KEYWORD_FIXES = [
  [/\bg\.?\s?a\.?\s?f\.?\b|\bgaff\b|\bgaf's\b/gi, 'GAF', 'GAF'],
  [/\btam\s?-?\s?co\b|\btamco\b|\btam\s?key\b|\btamkow\b|\btam\s?k\.?o\.?\b/gi, 'TAMKO', 'TAMKO'],
  [/\bi\.?\s?k\.?\s?o\.?(?=\s+(?:shingle|shingles|roof|roofs|roofing|brand|product|dynasty|cambridge|nordic))/gi, 'IKO', 'IKO'],
  [/\bowens?['’]?s?\s+corning\b/gi, 'Owens Corning', 'Owens Corning'],
  [/\bcertain\s?-?\s?teed\b/gi, 'CertainTeed', 'CertainTeed'],
  [/\btimber\s?-?\s?line\b/gi, 'Timberline', 'Timberline'],
  [/\bh\.?\s?d\.?\s?z\.?\b/gi, 'HDZ', 'HDZ'],
  [/\ba\.?\s?c\.?\s?v\.?\b/gi, 'ACV', 'ACV'],
  [/\br\.?\s?c\.?\s?v\.?\b/gi, 'RCV', 'RCV'],
  [/\bdrip\s+edging?\b/gi, 'drip edge', 'drip edge'],
];

function editDistanceLE1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la === lb) {
      // substitution, or an adjacent transposition
      if (i + 1 < la && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; } else { i++; j++; }
    } else if (la > lb) i++; else j++;
  }
  return diff + (la - i) + (lb - j) <= 1;
}

/**
 * Keyword corrections on a raw transcript. Returns { text, corrections }. The
 * RAW transcript is always kept on the doc beside the corrected one. Name
 * fixes only touch a CAPITALISED word that is one edit away from a surname or
 * street word of a customer this tenant actually has, so "Smyth" becomes
 * "Smith" but "mother" never becomes "Mather" (not capitalised, not a lead).
 */
function correctTranscript(raw, { names, streets } = {}) {
  let text = str(raw);
  const corrections = [];
  for (const [re, to, label] of KEYWORD_FIXES) {
    let n = 0;
    text = text.replace(re, (m) => { if (m === to) return m; n++; return to; });
    if (n) corrections.push({ from: label + ' (variant)', to, n });
  }
  const vocab = new Map();
  for (const full of names || []) {
    for (const w of str(full).split(/\s+/)) {
      const k = w.replace(/[^\p{L}'-]/gu, '');
      if (k.length >= 5) vocab.set(k.toLowerCase(), k);
    }
  }
  for (const s of streets || []) {
    const street = str(s).split(',')[0];
    for (const w of street.split(/\s+/)) {
      const k = w.replace(/[^\p{L}'-]/gu, '');
      if (k.length >= 5 && /^[A-Za-z'-]+$/.test(k) && !/^(street|avenue|drive|road|court|circle|lane|place|boulevard|parkway|highway|terrace|north|south|east|west)$/i.test(k)) vocab.set(k.toLowerCase(), k);
    }
  }
  if (vocab.size) {
    const counts = new Map();
    text = text.replace(/\b[A-Z][a-z]{4,}\b/g, (w) => {
      const lw = w.toLowerCase();
      if (vocab.has(lw)) return vocab.get(lw) === w ? w : (counts.set(w + '>' + vocab.get(lw), (counts.get(w + '>' + vocab.get(lw)) || 0) + 1), vocab.get(lw));
      for (const [k, v] of vocab) {
        if (k[0] === lw[0] && editDistanceLE1(lw, k)) {
          const key = w + '>' + v;
          counts.set(key, (counts.get(key) || 0) + 1);
          return v;
        }
      }
      return w;
    });
    counts.forEach((n, key) => { const [from, to] = key.split('>'); corrections.push({ from, to, n }); });
  }
  return { text, corrections: corrections.slice(0, 40) };
}

// ── notes (Claude) ──────────────────────────────────────────────────────
const VISIT_TYPES = ['inspection', 'estimate', 'sales', 'job_site', 'insurance', 'follow_up', 'other', 'personal'];
const ROLES = ['rep', 'homeowner', 'adjuster', 'spouse', 'other'];

const VISIT_NOTES_SYSTEM = [
  'You read the transcript of an IN-PERSON visit recorded by Jo, who runs No Big Deal Home Solutions, a small roofing / gutters / siding contractor in the Cincinnati area.',
  'Speech-to-text has no speaker labels; infer who said what from the content, best effort.',
  'Return ONE JSON object and nothing else:',
  '{"visit_type": one of ' + JSON.stringify(VISIT_TYPES) + ',',
  ' "summary": "2-4 plain sentences: who, what was looked at, what was decided",',
  ' "promises": [{"who": "jo" | "them", "text": "a concrete thing someone said they would do, imperative, under 120 chars", "due": "YYYY-MM-DD" or null}],',
  ' "follow_ups": [{"text": "something Jo should do next that nobody promised aloud, under 120 chars", "due": "YYYY-MM-DD" or null}],',
  ' "scope_facts": ["a measurement or scope fact that was SAID (e.g. two layers, about 28 squares, 6/12 pitch), under 120 chars each, at most 8"],',
  ' "insurance": {"carrier": ..., "claim_number": ..., "adjuster": ..., "deductible": ..., "notes": ...} (all strings or null; only what was said),',
  ' "speakers": [{"label": "Speaker 1", "role": one of ' + JSON.stringify(ROLES) + '}] (at most 4),',
  ' "urgent": true | false (an active leak, a safety issue, or a hard deadline within 48 hours),',
  ' "caller_name": "the customer\'s full name if said, else null", "street": "their street address if said (number + street name), else null", "town": "their town if said, else null"}',
  'Rules: only things actually said, at most 6 promises. Resolve relative dates ("Thursday", "next week") against the visit date given. ',
  'A recording about family, friends or anything not business is "personal": then summary is "Personal." and the lists are empty.',
  'Never invent prices, measurements, names or dates that were not said. Scope facts are what people SAID, not measured.',
].join('\n');

function buildVisitNotesPrompt({ capture, transcript, leadName, nowMs }) {
  const c = capture || {};
  const when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'unknown';
  const day = c.startedAtMs ? etToday(c.startedAtMs) : etToday(nowMs || Date.now());
  const wd = c.startedAtMs ? etWeekday(c.startedAtMs) : '';
  return [
    'Visit date (Eastern): ' + when + (wd ? ' (' + wd + ', ' + day + ')' : ' (' + day + ')'),
    'Length: ' + Math.round((Number(c.durationSec) || 0) / 60) + ' minutes',
    leadName ? 'CRM customer chosen for this visit: ' + leadName : 'Not attached to a customer yet.',
    '',
    'Transcript:',
    str(transcript).slice(0, NOTES_MAX_TRANSCRIPT_CHARS),
  ].join('\n');
}

/** The model's JSON -> the stored shape. Anything malformed is dropped, never trusted. */
function sanitizeVisitNotes(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const visitType = VISIT_TYPES.indexOf(r.visit_type) !== -1 ? r.visit_type : 'other';
  const personal = visitType === 'personal';
  const list = (v) => (Array.isArray(v) ? v : []);
  const promises = personal ? [] : list(r.promises)
    .filter((p) => p && typeof p.text === 'string' && p.text.trim())
    .slice(0, 6)
    .map((p) => ({ who: p.who === 'jo' ? 'jo' : 'them', text: clip(p.text, 160), due: ymdOrNull(p.due) }));
  const followUps = personal ? [] : list(r.follow_ups)
    .filter((p) => p && typeof p.text === 'string' && p.text.trim())
    .slice(0, 5)
    .map((p) => ({ text: clip(p.text, 160), due: ymdOrNull(p.due) }));
  const scopeFacts = personal ? [] : list(r.scope_facts).filter((s) => typeof s === 'string' && s.trim()).slice(0, 8).map((s) => clip(s, 160));
  const ins = r.insurance && typeof r.insurance === 'object' ? r.insurance : {};
  const one = (v, n) => { const t = clip(v, n); return t || null; };
  const insurance = personal ? null : {
    carrier: one(ins.carrier, 80), claimNumber: one(ins.claim_number, 60), adjuster: one(ins.adjuster, 80),
    deductible: one(ins.deductible, 40), notes: one(ins.notes, 240),
  };
  const hasIns = insurance && Object.keys(insurance).some((k) => insurance[k]);
  const speakers = list(r.speakers).slice(0, 4)
    .map((s) => ({ label: clip(s && s.label, 30), role: ROLES.indexOf(s && s.role) !== -1 ? s.role : 'other' }))
    .filter((s) => s.label);
  return {
    visitType,
    summary: personal ? 'Personal.' : clip(r.summary || '', 900),
    promises,
    followUps,
    scopeFacts,
    insurance: hasIns ? insurance : null,
    speakers,
    urgent: !personal && r.urgent === true,
    callerFacts: personal ? L.sanitizeCallerFacts(null) : L.sanitizeCallerFacts({ caller_name: r.caller_name, street: r.street, town: r.town }),
  };
}

// ── suggestions ─────────────────────────────────────────────────────────
const leadLabel = (l) => (str(l.name || l.customerName) || (str(l.firstName) + ' ' + str(l.lastName)).trim() || str(l.address) || 'Customer').trim();
const isDnr = (l) => !!(l && l.doNotRecord === true);
const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function clockOf(ms) {
  try { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (_) { return ''; }
}

/**
 * The GPS candidate: EXACTLY ONE lead that has coordinates and sits inside
 * max(40 m, 2 x the fix's accuracy). Half of the leads have no lat/lng, so this
 * can only ever be "the one mapped customer here", never "nobody else is here":
 * it is the weakest signal and its evidence says so.
 */
function gpsCandidate(fix, leads) {
  const lat = numOrNull(fix && fix.lat), lng = numOrNull(fix && fix.lng);
  if (lat == null || lng == null) return null;
  const acc = numOrNull(fix.accuracyM);
  if (acc != null && acc > GPS_MAX_ACCURACY_M) return null;
  const radius = Math.min(GPS_MAX_RADIUS_M, Math.max(GPS_MIN_RADIUS_M, 2 * (acc || 0)));
  const inside = [];
  for (const l of leads || []) {
    const a = numOrNull(l.lat), b = numOrNull(l.lng);
    if (a == null || b == null) continue;
    const d = haversineM(lat, lng, a, b);
    if (d <= radius) inside.push({ lead: l, d });
  }
  if (inside.length !== 1) return null;
  return { lead: inside[0].lead, distanceM: Math.round(inside[0].d), radiusM: Math.round(radius), accuracyM: acc };
}

/**
 * Ranked chips WITH EVIDENCE. Pure; a person confirms. Signals, strongest first:
 *   appointment  an appointment within +-60 min of when recording started (90;
 *                70 when more than one lead is on the calendar then)
 *   said         the transcript / the notes' caller facts name exactly one
 *                customer, via the call matcher (85; 95 when it disagrees with
 *                the calendar: what was said out loud beats a booking)
 *   gps          exactly one mapped customer inside the fix's radius (70)
 *   recent       breaks a tie between customers already found (touched in the last 14 days)
 * Ambiguity is a refusal: two customers matching a name gives NO said-chip.
 * A do-not-record customer is never offered (the caller purges on a unique
 * match instead; see `dnrMatch`).
 *
 * @returns {{ suggestions: object[], dnrMatch: object|null, autoAttach: false }}
 */
function rankSuggestions({ capture, transcript, callerFacts, leads, appointments, nowMs }) {
  const cap = capture || {};
  const live = (Array.isArray(leads) ? leads : []).filter((l) => l && l.id && l.deleted !== true);
  const byId = new Map(live.map((l) => [String(l.id), l]));
  const cand = new Map();
  const add = (lead, signal, score, evidence) => {
    const id = String(lead.id);
    const cur = cand.get(id) || { leadId: id, name: leadLabel(lead), address: str(lead.address), signals: [], evidence: [], score: 0 };
    if (cur.signals.indexOf(signal) === -1) { cur.signals.push(signal); cur.evidence.push(evidence); }
    cur.score = Math.max(cur.score, score) + (cur.signals.length > 1 ? 5 : 0);
    cand.set(id, cur);
  };

  // 1. the calendar
  const started = Number(cap.startedAtMs) || 0;
  const near = [];
  (Array.isArray(appointments) ? appointments : []).forEach((a) => {
    if (!a || a.status === 'cancelled') return;
    const ms = toMs(a.startTime != null ? a.startTime : a.startMs);
    if (ms == null || !started) return;
    const d = ms - started;
    const pinned = cap.appointmentId && String(a.id) === String(cap.appointmentId);
    if (!pinned && Math.abs(d) > APPT_WINDOW_MS) return;
    let lead = a.leadId ? byId.get(String(a.leadId)) : null;
    let how = '';
    if (!lead) {
      const nm = str(a.attendeeName || a.title).trim().toLowerCase();
      const hits = nm ? live.filter((l) => leadLabel(l).toLowerCase() === nm) : [];
      if (hits.length === 1) { lead = hits[0]; how = ' (matched by name)'; }
    }
    if (!lead) return;
    near.push({ lead, d: Math.abs(d), ms, how, pinned });
  });
  near.sort((x, y) => x.d - y.d);
  const apptLeads = new Set(near.map((n) => String(n.lead.id)));
  const apptScore = apptLeads.size > 1 ? 70 : 90;
  near.forEach((n) => {
    const mins = Math.round(n.d / 60000);
    const rel = mins <= 1 ? 'right when you started' : mins + ' min ' + (n.ms >= started ? 'after' : 'before') + ' you started';
    // closer to the moment you started is slightly stronger (0..4 points, one decimal)
    const closeness = Math.round((1 - Math.min(n.d, APPT_WINDOW_MS) / APPT_WINDOW_MS) * 40) / 10;
    add(n.lead, 'appointment', n.pinned ? 95 : apptScore + closeness, 'On your calendar at ' + clockOf(n.ms) + ', ' + rel + n.how + (apptLeads.size > 1 ? ' (one of ' + apptLeads.size + ' that hour)' : '') + '.');
  });

  // 2. who was named: the call matcher, unchanged, over EVERY customer so a
  // do-not-record name still counts as "named" (and is then purged, not offered).
  let dnrMatch = null;
  let said = null;
  try {
    said = L.suggestLeadForCall({ leadId: null, contactName: '', summary: '', transcript: str(transcript), callerFacts: callerFacts || null }, live);
  } catch (_) { said = null; }
  if (said && said.leadId && byId.has(String(said.leadId))) {
    const lead = byId.get(String(said.leadId));
    if (isDnr(lead)) dnrMatch = { leadId: String(lead.id), name: leadLabel(lead), why: said.why };
    else {
      const disagrees = apptLeads.size > 0 && !apptLeads.has(String(lead.id));
      const why = str(said.why).replace(/said on the call/i, 'said in the recording');
      add(lead, 'said', disagrees ? 95 : 85, 'Matched by what was said: ' + why + '.');
    }
  }

  // 3. GPS: one mapped customer here (never the only evidence offered as certain)
  const g = gpsCandidate({ lat: cap.lat, lng: cap.lng, accuracyM: cap.accuracyM }, live);
  if (g) {
    if (isDnr(g.lead)) dnrMatch = dnrMatch || { leadId: String(g.lead.id), name: leadLabel(g.lead), why: 'GPS' };
    else {
      add(g.lead, 'gps', 70, 'About ' + g.distanceM + ' m from ' + (str(g.lead.address).split(',')[0] || leadLabel(g.lead)) +
        (g.accuracyM != null ? ' (GPS accuracy ' + Math.round(g.accuracyM) + ' m)' : '') + '. Only customers with a map pin were checked.');
    }
  }

  // 4. recency only breaks ties between customers already on the list (never
  // creates a chip, never outranks a stronger signal)
  cand.forEach((c) => {
    const l = byId.get(c.leadId);
    const t = toMs(l && (l.lastContactedAt != null ? l.lastContactedAt : l.updatedAt));
    c.recent = !!(t && nowMs && nowMs - t >= 0 && nowMs - t < 14 * 86400000);
  });

  const suggestions = Array.from(cand.values())
    .filter((c) => !isDnr(byId.get(c.leadId)))
    .sort((a, b) => b.score - a.score || b.signals.length - a.signals.length || (b.recent ? 1 : 0) - (a.recent ? 1 : 0))
    .slice(0, MAX_CHIPS)
    .map((c) => ({ leadId: c.leadId, name: c.name, address: c.address, signals: c.signals, evidence: c.evidence.join(' '), score: c.score }));
  return { suggestions, dnrMatch, autoAttach: false };
}

// ── attach: timeline row, promise tasks, follow-ups ─────────────────────
function guessPromiseKind(text) {
  const t = str(text).toLowerCase();
  if (/\b(estimate|quote|proposal|bid|price)\b/.test(t)) return 'estimate';
  if (/\b(order|materials?|shingles?\s+delivered)\b/.test(t)) return 'order';
  if (/\bpermit\b/.test(t)) return 'permit';
  if (/\b(text|message)\b/.test(t)) return 'text';
  return 'callback';
}
function waitingOnFor(text) {
  const t = str(text).toLowerCase();
  if (/\badjuster\b|\binsurance\b|\bcarrier\b/.test(t)) return 'adjuster';
  if (/\bsupplier\b|\bdistributor\b|\bbeacon\b|\bsrs\b/.test(t)) return 'supplier';
  return 'customer';
}
function addDays(ymd, n) { return PR.addDaysYmd(ymd, n); }

/**
 * Everything attach writes, as plain objects (no timestamps; the caller adds
 * FieldValue stamps). All ids are keyed by visitId so a second attach, a
 * retry or a re-processed notes step writes the SAME docs:
 *   leads/{id}/activity/visit-{visitId}              the timeline row
 *   leads/{id}/tasks/visit-{visitId}-p{n}            promise tasks (kind:'promise')
 *   leads/{id}/tasks/visit-{visitId}-f{n}            follow-up tasks
 * Tasks are created only when ABSENT, so a tick or an edit is never undone.
 */
function buildAttachment({ capture, notes, visitId, leadId, lead, uid, todayYmd, nowMs, audioKeptDays }) {
  const cap = capture || {};
  const n = notes || null;
  const ownerUid = (lead && lead.userId) || uid;
  const companyId = (lead && lead.companyId) || null;
  const tasks = [];
  const skipped = [];
  if (n && n.visitType !== 'personal') {
    n.promises.forEach((p, i) => {
      const mine = p.who === 'jo';
      const kind = mine ? guessPromiseKind(p.text) : 'waiting';
      // A stated date wins. A promise with no date is due tomorrow rather
      // than "today" (it was made in a visit that may have ended minutes ago).
      let due = p.due && p.due >= todayYmd ? p.due : '';
      if (due && PR.daysBetween(todayYmd, due) > PR.MAX_AHEAD_DAYS) due = '';
      const dueStated = !!due;
      if (!due && !(kind === 'waiting')) due = kind === 'callback' ? addDays(todayYmd, 1) : '';
      const built = PR.buildTask({
        kind, dueYmd: due || '', why: p.text, todayYmd, uid, source: 'visit', sourceCallId: visitId,
        waitingOn: mine ? undefined : waitingOnFor(p.text),
      });
      if (built.error) { skipped.push({ text: p.text, error: built.error }); return; }
      const doc = Object.assign({}, built, {
        leadId, userId: ownerUid, title: built.text, createdBy: 'Visit capture',
        visitId, visitUid: uid, source: 'visit', dueStated, who: p.who,
      });
      if (companyId) doc.companyId = companyId;
      tasks.push({ id: 'visit-' + visitId + '-p' + i, doc, type: 'promise' });
    });
    n.followUps.forEach((f, i) => {
      const due = f.due && f.due >= todayYmd ? f.due : addDays(todayYmd, 1);
      const doc = {
        text: f.text, title: f.text, done: false, dueDate: due, dueInferred: !(f.due && f.due >= todayYmd),
        leadId, userId: ownerUid, source: 'visit', createdBy: 'Visit capture', visitId, visitUid: uid,
      };
      if (companyId) doc.companyId = companyId;
      tasks.push({ id: 'visit-' + visitId + '-f' + i, doc, type: 'followup' });
    });
  }
  // The timeline row. Summary + facts; the audio is NEVER a URL here (a signed
  // URL expires, a tokenised one is public): audioVisitId lets the app ask the
  // attachVisitCapture callable for a ten-minute link.
  const dur = Math.round(Number(cap.durationSec) || 0);
  const parts = [];
  if (n && n.summary) parts.push(n.summary);
  else parts.push('Recorded. Notes are pending; the transcript is saved.');
  if (n && n.promises.length) {
    const mine = n.promises.filter((p) => p.who === 'jo').map((p) => p.text);
    const theirs = n.promises.filter((p) => p.who !== 'jo').map((p) => p.text);
    if (mine.length) parts.push('You said you would: ' + mine.join('; '));
    if (theirs.length) parts.push('They said they would: ' + theirs.join('; '));
  }
  if (n && n.scopeFacts.length) parts.push('Said (not measured): ' + n.scopeFacts.join('; '));
  if (n && n.insurance) {
    const i = n.insurance;
    const bits = [i.carrier && 'carrier ' + i.carrier, i.claimNumber && 'claim ' + i.claimNumber, i.adjuster && 'adjuster ' + i.adjuster, i.deductible && 'deductible ' + i.deductible, i.notes].filter(Boolean);
    if (bits.length) parts.push('Insurance (as said): ' + bits.join(', '));
  }
  const activity = {
    userId: ownerUid, type: 'visit', source: 'visit-capture', label: 'Visit recording',
    summary: clip(parts.join(' - '), 1500),
    visitId, visitUid: uid, durationSec: dur,
    startedAtMs: Number(cap.startedAtMs) || null,
    visitType: n ? n.visitType : null,
    urgent: !!(n && n.urgent),
    audioVisitId: cap.audioPath ? visitId : null,
    audioKeptUntilMs: cap.audioPath && audioKeptDays ? (Number(cap.uploadedAtMs) || nowMs) + audioKeptDays * 86400000 : null,
    notesPending: !n,
  };
  if (companyId) activity.companyId = companyId;
  return { activityId: 'visit-' + visitId, activity, tasks, skipped };
}

module.exports = {
  MAX_DURATION_SEC, OBJECT_WAIT_MS, MAX_TRANSCRIBE_STRIKES, MAX_NOTES_STRIKES, LEASE_MS, APPT_WINDOW_MS,
  GPS_MIN_RADIUS_M, GPS_MAX_RADIUS_M, GPS_MAX_ACCURACY_M, MAX_CHIPS, SUGGEST_RULES_VERSION, VOCAB_MAX_CHARS,
  RETENTION_DEFAULT_DAYS, PIPELINE, RETRY_STATES, VISIT_TYPES, FIXED_TERMS, VISIT_NOTES_SYSTEM,
  AUDIO_PATH_RE, classifyProviderError, outageRetryMs, retentionDays, nextStep, finalizeKey,
  buildVocabularyPrompt, correctTranscript, editDistanceLE1,
  buildVisitNotesPrompt, sanitizeVisitNotes,
  haversineM, gpsCandidate, rankSuggestions, guessPromiseKind, buildAttachment, etToday,
};
