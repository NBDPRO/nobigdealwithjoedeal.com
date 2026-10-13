/**
 * visit-recorder-logic.js - the pure half of the in-person visit recorder
 * (window.NBDVisitRecorderLogic). No DOM, no IndexedDB, no Firebase: every
 * function here is a decision the recorder, the launcher and the tests all
 * share, so the tests exercise the SAME code the phone runs.
 *
 *   documentation/projects/VISIT-RECORDER-PR1-2026-10-13.md
 *   documentation/projects/IN-PERSON-CAPTURE-RECON-AND-DESIGN-2026-10-13.md
 *
 * Nothing here ever files a recording under a customer. suggest() returns
 * chips WITH THEIR EVIDENCE; a person taps one (suggest-and-confirm).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NBDVisitRecorderLogic = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ── limits ────────────────────────────────────────────────────────────
  var TIMESLICE_MS = 2000;                 // 1-5 s: a chunk reaches IndexedDB every 2 s
  var SOFT_CAP_SEC = 60 * 60;              // auto-stop + save; "Record" again starts part 2
  var WARN_SEC = 50 * 60;                  // warning ten minutes out
  var MAX_UPLOAD_BYTES = 190 * 1024 * 1024; // storage.rules refuses >= 200 MB
  var AUDIO_BPS = 48000;                   // speech: 20 min is roughly 7 MB
  var BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
  var APPT_WINDOW_MS = 60 * 60 * 1000;     // +-60 min around the moment you hit record
  var MAX_CHIPS = 3;

  // The statuses a visit_captures doc may carry (mirrors firestore.rules).
  var STATUSES = ['recording', 'stored', 'uploading', 'uploaded', 'failed', 'discarded'];
  var SOURCES = ['fab', 'appointment', 'customer', 'deeplink'];
  var CONSENT_MODES = ['one_party', 'two_party_attested', 'two_party_verbal'];

  // Every key the client may write on users/{uid}/visit_captures/{visitId}.
  // firestore.rules hasOnly()s exactly this list; a test parses the rules
  // file and fails if the two drift.
  var DOC_FIELDS = [
    'startedAtMs', 'endedAtMs', 'durationSec', 'lat', 'lng', 'accuracyM',
    'mime', 'sizeBytes', 'status', 'leadId', 'source', 'consentMode',
    'appointmentId', 'audioPath', 'uploadedAtMs', 'chunkCount',
    'backgroundSec', 'partOf', 'disclosureAckedAtMs', 'recoveredAtMs',
    'attachedAtMs', 'discardedAtMs', 'createdAtMs',
  ];

  // ── ids / mime / paths ────────────────────────────────────────────────
  function newVisitId(nowMs, rnd) {
    var r = typeof rnd === 'function' ? rnd : Math.random;
    var s = '';
    for (var i = 0; i < 8; i++) s += Math.floor(r() * 36).toString(36);
    return 'v' + Number(nowMs || 0).toString(36) + s;
  }
  function isValidVisitId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id); }

  function baseMime(mime) { return String(mime || '').split(';')[0].trim().toLowerCase(); }
  /**
   * First type the browser can record. iPhone Safari is recorded as audio/mp4
   * (AAC, the long-standing path); everywhere else Opus in WebM. Both are on
   * storage.rules' allowlist and Groq accepts both.
   */
  function pickMime(isSupported, isIOS) {
    var webm = ['audio/webm;codecs=opus', 'audio/webm'];
    var mp4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac'];
    var order = isIOS ? mp4.concat(webm, ['audio/ogg;codecs=opus']) : webm.concat(mp4, ['audio/ogg;codecs=opus']);
    for (var i = 0; i < order.length; i++) {
      try { if (typeof isSupported === 'function' && isSupported(order[i])) return order[i]; } catch (_) {}
    }
    return '';   // let the browser choose; blob.type tells us afterwards
  }
  function extFor(mime) {
    var m = baseMime(mime);
    if (/mp4|m4a|aac/.test(m)) return 'm4a';
    if (/ogg/.test(m)) return 'ogg';
    if (/mpeg|mp3/.test(m)) return 'mp3';
    if (/wav/.test(m)) return 'wav';
    return 'webm';
  }
  /** audio/{uid}/_inbox/{visitId}.{ext}: the leading `_` makes the Voice Intel trigger ignore it. */
  function storagePath(uid, visitId, mime) {
    return 'audio/' + uid + '/_inbox/' + visitId + '.' + extFor(mime);
  }

  // ── retry ─────────────────────────────────────────────────────────────
  /** attempt 0 -> 30 s, 1 -> 2 min, 2+ -> 10 min. */
  function backoffMs(attempt) {
    var n = Math.max(0, Math.floor(Number(attempt) || 0));
    return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
  }
  function nextTryAt(nowMs, attempts) { return nowMs + backoffMs(attempts); }

  // ── chunks ────────────────────────────────────────────────────────────
  /**
   * Rows from IndexedDB come back in key order, which is NOT a promise we
   * lean on: sort by seq, report holes. Chunks are not independently
   * playable (only the first carries the container header), so the upload is
   * always the in-order concatenation, first chunk first.
   */
  function orderChunks(rows) {
    var list = (Array.isArray(rows) ? rows : []).filter(function (r) { return r && typeof r.seq === 'number'; })
      .slice().sort(function (a, b) { return a.seq - b.seq; });
    var missing = [];
    var seen = {};
    var dup = 0;
    var ordered = [];
    list.forEach(function (r) {
      if (seen[r.seq]) { dup++; return; }
      seen[r.seq] = true; ordered.push(r);
    });
    var max = ordered.length ? ordered[ordered.length - 1].seq : -1;
    for (var i = 0; i <= max; i++) if (!seen[i]) missing.push(i);
    return { ordered: ordered, missing: missing, duplicates: dup, hasHeader: !!(ordered.length && ordered[0].seq === 0) };
  }

  // ── time ──────────────────────────────────────────────────────────────
  function toMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? null : t; }
    return null;
  }
  function formatClock(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' + two(m) : m) + ':' + two(r);
  }
  function clockOf(ms) {
    try { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  /** ok | warn | cap, by ACTIVE recorded seconds. */
  function capState(sec) {
    if (sec >= SOFT_CAP_SEC) return 'cap';
    if (sec >= WARN_SEC) return 'warn';
    return 'ok';
  }

  // ── customers ─────────────────────────────────────────────────────────
  function leadName(l) {
    if (!l) return '';
    var n = l.name || l.customerName || ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
    return String(n || l.address || '').trim();
  }
  function isDoNotRecord(lead) { return !!(lead && lead.doNotRecord === true); }
  function byId(leads, id) {
    var list = Array.isArray(leads) ? leads : [];
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === String(id)) return list[i];
    return null;
  }

  /**
   * 0-3 chips, best evidence first, one per customer:
   *   1. the customer the recording was started from (pre-attached)
   *   2. an appointment within +-60 min of when recording STARTED
   *   3. the most recently opened customers
   * Nothing here is a decision: each chip says why it is offered and a person
   * taps it. A customer marked do-not-record is never offered.
   *
   * @param {object} o { startedAtMs, preLeadId, appointments[], recentIds[], leads[] }
   */
  function suggest(o) {
    o = o || {};
    var leads = Array.isArray(o.leads) ? o.leads : [];
    var started = Number(o.startedAtMs) || 0;
    var out = [];
    var used = {};
    function push(lead, leadId, kind, evidence) {
      var id = String(leadId || '');
      if (!id || used[id]) return;
      if (lead && isDoNotRecord(lead)) return;
      used[id] = true;
      out.push({ leadId: id, name: leadName(lead) || 'Customer', kind: kind, evidence: evidence, address: lead && lead.address ? String(lead.address) : '' });
    }
    if (o.preLeadId) {
      push(byId(leads, o.preLeadId), o.preLeadId, 'attached', 'You started this from their page.');
    }
    var appts = (Array.isArray(o.appointments) ? o.appointments : []).map(function (a) {
      if (!a || a.status === 'cancelled') return null;
      var ms = toMs(a.startTime != null ? a.startTime : a.startMs);
      if (ms == null || !started) return null;
      var d = ms - started;
      if (Math.abs(d) > APPT_WINDOW_MS) return null;
      var lead = a.leadId ? byId(leads, a.leadId) : null;
      var how = '';
      if (!lead) {
        var nm = String(a.attendeeName || a.title || '').trim().toLowerCase();
        var hits = nm ? leads.filter(function (l) { return leadName(l).toLowerCase() === nm; }) : [];
        if (hits.length === 1) { lead = hits[0]; how = ' (matched by name)'; }
      }
      if (!lead) return null;
      return { lead: lead, d: Math.abs(d), ms: ms, how: how, id: a.id };
    }).filter(Boolean).sort(function (a, b) { return a.d - b.d; });
    appts.forEach(function (a) {
      var mins = Math.round(a.d / 60000);
      var rel = mins <= 1 ? 'right when you started' : mins + ' min ' + (a.ms >= started ? 'after' : 'before') + ' you started';
      push(a.lead, a.lead.id, 'appointment', 'On your calendar at ' + clockOf(a.ms) + ', ' + rel + a.how + '.');
    });
    (Array.isArray(o.recentIds) ? o.recentIds : []).forEach(function (rid, i) {
      push(byId(leads, rid), rid, 'recent', i === 0 ? 'The customer you opened most recently.' : 'Opened recently.');
    });
    return out.slice(0, MAX_CHIPS);
  }
  /** The appointment id behind an appointment chip, so attach can keep it. */
  function appointmentIdFor(appointments, leadId, leads) {
    var list = Array.isArray(appointments) ? appointments : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && a.leadId && String(a.leadId) === String(leadId)) return a.id || a.bookingId || null;
    }
    return null;
  }

  // ── consent ───────────────────────────────────────────────────────────
  /**
   * Ohio ORC 2933.52 and Kentucky KRS 526 are one-party states, so the
   * default is no disclosure at all; an owner can switch on a one-line
   * reminder, and a company set to a two-party mode gets the line every time.
   * Not legal advice (documentation/projects/IN-PERSON-CAPTURE-...md s.7).
   */
  function consentPlan(cfg) {
    cfg = cfg || {};
    var mode = CONSENT_MODES.indexOf(cfg.consentMode) >= 0 ? cfg.consentMode : 'one_party';
    var reminder = cfg.reminder === true;
    var twoParty = mode !== 'one_party';
    var line = '';
    if (twoParty) line = 'Tell them you are recording this visit and get a yes before you start.';
    else if (reminder) line = 'Reminder: tell them you are recording this visit.';
    return { mode: mode, needsSheet: twoParty || reminder, line: line, needsAck: twoParty };
  }

  // ── start gate ────────────────────────────────────────────────────────
  /** Respects the per-customer do-not-record flag at start. */
  function startGate(o) {
    o = o || {};
    if (o.lead && isDoNotRecord(o.lead)) {
      return { ok: false, reason: 'dnr', message: (leadName(o.lead) || 'This customer') + ' is marked do not record. Nothing was started.' };
    }
    if (!o.hasMediaRecorder) return { ok: false, reason: 'unsupported', message: 'This browser cannot record audio. Open the installed NBD app and try again.' };
    return { ok: true };
  }
  function attachGate(lead) {
    if (lead && isDoNotRecord(lead)) {
      return { ok: false, message: (leadName(lead) || 'This customer') + ' is marked do not record. Discard this recording instead.' };
    }
    return { ok: true };
  }

  // ── the Firestore doc ─────────────────────────────────────────────────
  /** Local row -> the exact doc the rules allow. undefined keys never leave. */
  function docFromRow(row) {
    var out = {};
    DOC_FIELDS.forEach(function (k) {
      var v = row ? row[k] : undefined;
      if (v !== undefined) out[k] = v;
    });
    if (out.leadId === undefined) out.leadId = null;
    if (SOURCES.indexOf(out.source) < 0) out.source = 'fab';
    if (CONSENT_MODES.indexOf(out.consentMode) < 0) out.consentMode = 'one_party';
    if (STATUSES.indexOf(out.status) < 0) out.status = 'stored';
    return out;
  }

  // ── the badge ─────────────────────────────────────────────────────────
  /** What the person sees for one visit. The words "Saved on phone" come first. */
  function badge(row, online) {
    var s = row && row.status;
    if (s === 'recording') return { text: 'Recording', tone: 'live' };
    if (s === 'discarded') return { text: 'Discarded', tone: 'off' };
    if (s === 'uploaded') return { text: 'Uploaded', tone: 'ok' };
    if (s === 'uploading') {
      var p = row && typeof row.progress === 'number' ? ' ' + Math.round(row.progress) + '%' : '';
      return { text: 'Saved on phone - uploading' + p, tone: 'busy' };
    }
    if (s === 'failed') return { text: 'Saved on phone - upload failed, will retry', tone: 'warn' };
    if (online === false) return { text: 'Saved on phone - waiting for signal', tone: 'wait' };
    return { text: 'Saved on phone - upload queued', tone: 'busy' };
  }

  /** Soft-cap part numbering: a recording that hit the cap continues as part 2. */
  function partLabel(row) { return row && row.partOf ? 'Part 2' : ''; }

  return {
    TIMESLICE_MS: TIMESLICE_MS, SOFT_CAP_SEC: SOFT_CAP_SEC, WARN_SEC: WARN_SEC,
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES, AUDIO_BPS: AUDIO_BPS, BACKOFF_MS: BACKOFF_MS.slice(),
    APPT_WINDOW_MS: APPT_WINDOW_MS, MAX_CHIPS: MAX_CHIPS,
    STATUSES: STATUSES.slice(), SOURCES: SOURCES.slice(), CONSENT_MODES: CONSENT_MODES.slice(), DOC_FIELDS: DOC_FIELDS.slice(),
    newVisitId: newVisitId, isValidVisitId: isValidVisitId,
    baseMime: baseMime, pickMime: pickMime, extFor: extFor, storagePath: storagePath,
    backoffMs: backoffMs, nextTryAt: nextTryAt,
    orderChunks: orderChunks,
    toMs: toMs, formatClock: formatClock, capState: capState,
    leadName: leadName, isDoNotRecord: isDoNotRecord,
    suggest: suggest, appointmentIdFor: appointmentIdFor,
    consentPlan: consentPlan, startGate: startGate, attachGate: attachGate,
    docFromRow: docFromRow, badge: badge, partLabel: partLabel,
  };
});
