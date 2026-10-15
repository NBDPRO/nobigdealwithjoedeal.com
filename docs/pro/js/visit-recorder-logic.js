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
  // The transcriber (Groq) refuses a file over 25 MB (functions/call-center-logic.js
  // GROQ_MAX_BYTES; visit-capture.js fails it 'too_large'). storage.rules would take
  // 200 MB, but a recording the server cannot read is not worth uploading as "done",
  // so the phone caps at 24 MB and STOPS the recording itself before it gets there
  // (2026-10-15; it was 190 MB). At 48 kbps 24 MB is about 70 minutes, so the 60
  // minute cap normally comes first; the size stop is for a phone that ignores the
  // bitrate.
  var MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
  var SIZE_WARN_BYTES = 21 * 1024 * 1024;  // "almost full" notice
  var SIZE_STOP_BYTES = 23 * 1024 * 1024;  // auto-stop + save; Record again starts part 2
  var AUDIO_BPS = 48000;                   // speech: 20 min is roughly 7 MB
  var CONFIG_MAX_AGE_MS = 10 * 60 * 1000;  // an older consent cache is re-read before a recording starts
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
  /** ok | warn | cap, by bytes captured so far (the upload limit, not the clock). */
  function sizeCapState(bytes) {
    var b = Number(bytes) || 0;
    if (b >= SIZE_STOP_BYTES) return 'cap';
    if (b >= SIZE_WARN_BYTES) return 'warn';
    return 'ok';
  }
  /**
   * How long a recording cut off by a killed app really recorded. The wall
   * clock from start to the last chunk counted the pauses (2026-10-15). The
   * session writes its total paused time (pausedMs) to the row on every resume;
   * a pause still running at the kill is after the last chunk (a paused
   * recorder sends none), so start -> last chunk minus pausedMs is the
   * recorded time. A row with no pausedMs (older code) falls back to the chunk
   * count x the 2 s timeslice, never more than the wall clock.
   */
  function recoveredDurationSec(row, chunkCount, lastChunkT) {
    var r = row || {};
    var start = Number(r.startedAtMs) || 0;
    var last = Math.max(start, Number(lastChunkT) || start);
    var wall = Math.max(1, Math.round((last - start) / 1000));
    if (typeof r.pausedMs === 'number' && r.pausedMs >= 0) {
      return Math.max(1, Math.min(wall, Math.round((last - start - r.pausedMs) / 1000)));
    }
    var byChunks = Math.round((Number(chunkCount) || 0) * TIMESLICE_MS / 1000);
    return Math.max(1, Math.min(wall, byChunks || wall));
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
      // A customer we cannot find in memory has no name and no do-not-record flag we
      // could check: only the one the recording was started from is offered blind
      // (and attach() re-checks it against the lead doc before filing anything).
      if (!lead && kind !== 'attached') return;
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
    // known:false = this company's setting was never read on this phone. Fail
    // CLOSED: a company that chose a two-party mode must not be skipped because a
    // cache was empty. One tap, and the visit records that it was shown.
    var unknown = cfg.known === false;
    var line = '';
    if (twoParty) line = 'Tell them you are recording this visit and get a yes before you start.';
    else if (reminder || unknown) line = 'Reminder: tell them you are recording this visit.';
    return { mode: mode, needsSheet: twoParty || reminder || unknown, line: line, needsAck: twoParty, unknown: unknown };
  }

  // ── start gate ────────────────────────────────────────────────────────
  /** Respects the per-customer do-not-record flag at start. */
  function startGate(o) {
    o = o || {};
    if (o.lead && isDoNotRecord(o.lead)) {
      return { ok: false, reason: 'dnr', message: (leadName(o.lead) || 'This customer') + ' is marked do not record. Nothing was started.' };
    }
    // The installed app is the same browser engine, so "open the installed app" did not help (2026-10-15).
    if (!o.hasMediaRecorder) return { ok: false, reason: 'unsupported', message: 'This browser cannot record audio. Update the phone, then open NBD Pro in Safari (iPhone) or Chrome (Android) and try again.' };
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
    // Not "Uploaded" until the server has the doc too (docSynced), or it would be a lie.
    if (s === 'uploaded' && row.docSynced === false) return { text: 'Saved on phone - confirming with the server', tone: 'busy' };
    if (s === 'uploaded') return { text: 'Uploaded', tone: 'ok' };
    if (s === 'uploading') {
      var p = row && typeof row.progress === 'number' ? ' ' + Math.round(row.progress) + '%' : '';
      return { text: 'Saved on phone - uploading' + p, tone: 'busy' };
    }
    if (s === 'failed' && row.tooLarge) return { text: 'Saved on phone - too big to upload (over 24 MB). It stays on this phone.', tone: 'warn' };
    if (s === 'failed') return { text: 'Saved on phone - upload failed, will retry', tone: 'warn' };
    if (online === false) return { text: 'Saved on phone - waiting for signal', tone: 'wait' };
    return { text: 'Saved on phone - upload queued', tone: 'busy' };
  }

  // ── failures, in plain words (the server has the same map) ─────────────
  // functions/visit-capture-logic.js FAIL_WORDS: a test keeps the two equal.
  var FAIL_WORDS = {
    bad_audio_path: 'the audio file was not where it should be',
    object_missing: 'the audio never finished uploading',
    audio_empty: 'the audio file was empty',
    too_large: 'the recording is too big for the transcriber (over 25 MB)',
    too_long: 'the recording is longer than the 60 minute limit',
    storage_read_failed: 'the audio could not be read back from storage',
    transcribe_failed: 'the transcriber could not read it',
    no_speech: 'no speech was heard on it',
    gave_up_after_14_days: 'it kept failing for two weeks',
    internal_error_gave_up: 'something went wrong on our side',
  };
  function failureWords(note) { return Object.prototype.hasOwnProperty.call(FAIL_WORDS, String(note || '')) ? FAIL_WORDS[note] : 'something went wrong'; }
  var RETRANSCRIBE_NOTES = ['transcribe_failed', 'storage_read_failed', 'no_speech', 'internal_error_gave_up'];
  /** Another transcription try can help (same rule the server enforces). */
  function canRetryTranscription(doc) {
    return !!doc && doc.pipelineStatus === 'failed' && doc.audioLive === true && RETRANSCRIBE_NOTES.indexOf(String(doc.pipelineNote || '')) !== -1;
  }
  // The server's attachNote when it took a customer back off a visit.
  var ATTACH_NOTE_WORDS = {
    lead_not_reachable: 'That customer is not one you can file under, so it was taken off.',
    attach_refused: 'The server could not file it on that customer, so it was taken off.',
    lead_id_invalid: 'That customer link was not valid, so it was taken off.',
    visit_id_conflict: 'Another recording already uses that spot on the customer, so it was taken off.',
  };
  function attachNoteWords(note) { return note ? (ATTACH_NOTE_WORDS[note] || 'The server took the customer off this visit.') + ' Pick the customer again.' : ''; }

  // ── the server's side of a visit (PR 2) ───────────────────────────────
  /**
   * What the server pipeline is doing with an uploaded visit, in words a person
   * can act on. `doc` is users/{uid}/visit_captures/{id} as the server wrote it.
   * An AI outage is never shown as a failure of the recording.
   */
  function pipelineBadge(doc) {
    var p = doc && doc.pipelineStatus;
    if (!doc || doc.status !== 'uploaded') return null;
    if (!p || p === 'queued') return { text: 'Uploaded - transcribing soon', tone: 'busy' };
    if (p === 'waiting_object') return { text: 'Uploaded - waiting for the audio to land', tone: 'busy' };
    if (p === 'transcribe_pending') return { text: 'Uploaded - transcription is waiting on the AI service, will retry', tone: 'wait' };
    if (p === 'consent_pending') return { text: 'Transcript saved - checking the consent line, will retry', tone: 'wait' };
    if (p === 'transcribed') return { text: 'Transcript saved - writing notes', tone: 'busy' };
    if (p === 'notes_pending') return { text: 'Transcript saved, notes pending (the AI service is unavailable; it retries by itself)', tone: 'wait' };
    if (p === 'notes_failed') return { text: 'Transcript saved - notes could not be written. Retry them.', tone: 'warn' };
    if (p === 'ready') return { text: 'Notes ready', tone: 'ok' };
    // Words, never the raw code (2026-10-15).
    if (p === 'failed') return { text: 'Could not be processed: ' + failureWords(doc.pipelineNote) + '.' + (doc.audioLive !== false ? ' The audio is kept.' : ''), tone: 'warn' };
    if (p === 'purge_pending') return { text: 'Not kept - deleting the audio, it finishes by itself', tone: 'off' };
    if (p === 'quarantined_consent') return { text: 'Not kept - the consent line was not confirmed', tone: 'off' };
    if (p === 'skipped') {
      var why = { do_not_record: 'this customer is marked do not record', do_not_record_match: 'a do-not-record customer was named', personal: 'it was personal', no_disclosure_ack: 'the disclosure was not acknowledged' }[doc.skipReason] || 'it was skipped';
      return { text: 'Not kept - ' + why + '. The audio was deleted.', tone: 'off' };
    }
    if (p === 'discarded') return { text: 'Discarded', tone: 'off' };
    return null;
  }

  /**
   * The chips for "Who was this?": the server's ranked suggestions (with the
   * evidence it computed) first, then the phone's own, one per customer, never a
   * customer the server was told "not these" about, never do-not-record.
   */
  function mergeChips(serverDoc, localChips, leads) {
    var out = [];
    var used = {};
    var rejected = {};
    ((serverDoc && serverDoc.rejectedLeadIds) || []).forEach(function (id) { rejected[String(id)] = true; });
    function push(c) {
      var id = String(c.leadId || '');
      if (!id || used[id] || rejected[id]) return;
      var lead = byId(leads, id);
      if (lead && isDoNotRecord(lead)) return;
      used[id] = true;
      out.push(c);
    }
    ((serverDoc && serverDoc.suggestions) || []).forEach(function (s) {
      if (!s || !s.leadId) return;
      push({ leadId: String(s.leadId), name: String(s.name || 'Customer'), kind: 'server', evidence: String(s.evidence || ''), address: String(s.address || ''), signals: s.signals || [] });
    });
    (localChips || []).forEach(push);
    return out.slice(0, MAX_CHIPS);
  }

  /** Soft-cap part numbering: a recording that hit the cap continues as part 2. */
  function partLabel(row) { return row && row.partOf ? 'Part 2' : ''; }

  // ── one meaning of "unfiled" (the Home count and the Today row) ────────
  var DEAD_PIPELINE = { discarded: 1, skipped: 1, quarantined_consent: 1, purge_pending: 1 };
  /** On no customer, not thrown away, not still being recorded. */
  function isUnfiled(r) {
    if (!r || !r.id || r.leadId) return false;
    if (r.status === 'discarded' || r.status === 'recording') return false;
    return !(r.pipelineStatus && DEAD_PIPELINE[r.pipelineStatus]);
  }

  // ── the phone's row + the server's doc for one visit ───────────────────
  // The server owns these; the phone's row never has them.
  var SERVER_KEYS = ['pipelineStatus', 'pipelineNote', 'pipelineNextAtMs', 'audioLive', 'notes', 'suggestions', 'rejectedLeadIds', 'skipReason', 'attachNote', 'attachedLeadId', 'transcript'];
  function mergeVisit(local, remote) {
    if (!local) return remote ? Object.assign({ remoteOnly: true }, remote) : null;
    var out = Object.assign({}, local);
    if (remote) SERVER_KEYS.forEach(function (k) { if (remote[k] !== undefined) out[k] = remote[k]; });
    return out;
  }
  /**
   * Every visit from the last `days` days (default 14), attached or not, newest
   * first: what "Recent visits" lists so a visit that failed on the server is
   * never invisible just because it is on a customer.
   */
  function recentVisits(local, remote, nowMs, days) {
    var since = (Number(nowMs) || 0) - (days || 14) * 86400000;
    var byId = {};
    (Array.isArray(remote) ? remote : []).forEach(function (r) { if (r && r.id) byId[r.id] = r; });
    var out = [];
    var seen = {};
    (Array.isArray(local) ? local : []).forEach(function (r) {
      if (!r || !r.id || seen[r.id]) return;
      seen[r.id] = true;
      out.push(mergeVisit(r, byId[r.id]));
    });
    Object.keys(byId).forEach(function (id) { if (!seen[id]) out.push(mergeVisit(null, byId[id])); });
    return out.filter(function (r) { return r && r.status !== 'discarded' && (Number(r.startedAtMs) || 0) >= since; })
      .sort(function (a, b) { return (Number(b.startedAtMs) || 0) - (Number(a.startedAtMs) || 0); });
  }
  /** The one status line for a (merged) visit: the server's words once it has the visit, else the phone's. */
  function visitStatus(row, online) {
    if (!row) return { text: '', tone: 'off' };
    if (row.status === 'uploaded' && row.docSynced !== false) {
      var pb = pipelineBadge(row);
      if (pb) return pb;
    }
    if (row.remoteOnly && row.status !== 'uploaded') return { text: 'Recorded on another device - not uploaded yet', tone: 'wait' };
    return badge(row, online);
  }
  /**
   * The phone's leadId after the server changed it (took a refused customer
   * off, or a teammate's device attached it). The phone is right while it has
   * an unsent change (docSynced false) or changed it after the server's copy
   * was read; otherwise the server is. null = nothing to change.
   */
  function reconcileLead(local, remote, fetchedAtMs) {
    if (!local || !remote || local.status !== 'uploaded' || local.docSynced === false) return null;
    if ((Number(local.leadChangedAtMs) || 0) >= (Number(fetchedAtMs) || 0) - 2000) return null;
    var want = remote.leadId ? String(remote.leadId) : null;
    var have = local.leadId ? String(local.leadId) : null;
    if (want === have) return null;
    return { leadId: want, note: !want && remote.attachNote ? String(remote.attachNote) : null };
  }
  /** The title of the visit sheet, from where the visit really is. */
  function sheetTitle(local, server) {
    if (local && (local.status !== 'uploaded' || local.docSynced === false)) return 'Saved on phone';
    var p = server && server.pipelineStatus;
    if (p === 'ready') return 'Notes ready';
    if (p === 'failed') return 'Could not be processed';
    if (p === 'transcribed' || p === 'notes_pending' || p === 'notes_failed' || p === 'consent_pending') return 'Transcript saved';
    if (p === 'skipped' || p === 'quarantined_consent' || p === 'purge_pending') return 'Not kept';
    if (local || server) return 'Uploaded';
    return 'Visit recording';
  }
  /** What the toast after an attach may truthfully say was filed. */
  function attachToast(name, res) {
    var who = String(name || 'the customer');
    var s = res && res.server;
    if (s && s.filed && s.failed) return 'Attached to ' + who + '. A "could not be processed" note is on their timeline.';
    if (s && s.filed) {
      var n = Number(s.tasksMade) || 0;
      return 'Attached to ' + who + '. Filed on their timeline' + (n ? ' with ' + n + (n === 1 ? ' task' : ' tasks') : '') + '.';
    }
    if (s) return 'Attached to ' + who + '. It goes on their timeline when the notes are written.';
    return 'Attached to ' + who + '. It goes on their timeline after it uploads and the notes are written.';
  }

  return {
    TIMESLICE_MS: TIMESLICE_MS, SOFT_CAP_SEC: SOFT_CAP_SEC, WARN_SEC: WARN_SEC,
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES, SIZE_WARN_BYTES: SIZE_WARN_BYTES, SIZE_STOP_BYTES: SIZE_STOP_BYTES, CONFIG_MAX_AGE_MS: CONFIG_MAX_AGE_MS,
    AUDIO_BPS: AUDIO_BPS, BACKOFF_MS: BACKOFF_MS.slice(),
    APPT_WINDOW_MS: APPT_WINDOW_MS, MAX_CHIPS: MAX_CHIPS,
    STATUSES: STATUSES.slice(), SOURCES: SOURCES.slice(), CONSENT_MODES: CONSENT_MODES.slice(), DOC_FIELDS: DOC_FIELDS.slice(),
    newVisitId: newVisitId, isValidVisitId: isValidVisitId,
    baseMime: baseMime, pickMime: pickMime, extFor: extFor, storagePath: storagePath,
    backoffMs: backoffMs, nextTryAt: nextTryAt,
    orderChunks: orderChunks,
    toMs: toMs, formatClock: formatClock, capState: capState, sizeCapState: sizeCapState, recoveredDurationSec: recoveredDurationSec,
    leadName: leadName, isDoNotRecord: isDoNotRecord,
    suggest: suggest, appointmentIdFor: appointmentIdFor,
    consentPlan: consentPlan, startGate: startGate, attachGate: attachGate,
    docFromRow: docFromRow, badge: badge, partLabel: partLabel,
    pipelineBadge: pipelineBadge, mergeChips: mergeChips,
    FAIL_WORDS: FAIL_WORDS, failureWords: failureWords, RETRANSCRIBE_NOTES: RETRANSCRIBE_NOTES.slice(), canRetryTranscription: canRetryTranscription,
    attachNoteWords: attachNoteWords,
    isUnfiled: isUnfiled, mergeVisit: mergeVisit, recentVisits: recentVisits, visitStatus: visitStatus,
    reconcileLead: reconcileLead, sheetTitle: sheetTitle, attachToast: attachToast,
  };
});
