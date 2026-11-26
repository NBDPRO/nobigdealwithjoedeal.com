'use strict';

/**
 * functions/call-retention.js — the call retention sweep (Call to Close P2,
 * Q7, 2026-11-09). Daily 03:20 ET.
 *
 * Jo's Q7 answer (CALL-TO-CLOSE-DESIGN-2026-11-09.md §11): briefs and
 * transcripts 24 months, the CRM's audio copies 12 months, Drive originals
 * untouched. Three phases, in this order:
 *
 *   audio       phone_calls older than 12 months that still have a CRM audio
 *               copy: the Storage object calls/{owner}/... is deleted, the
 *               call gets storagePath null, audioRemoved 'retention'.
 *   transcript  phone_calls older than 24 months: the transcript and the AI
 *               notes made from it (call-retention-logic TRANSCRIPT_FIELDS)
 *               are set to null / [], and the call's brief under its lead is
 *               deleted. The phone_calls doc itself is NEVER deleted: its
 *               date, number, customer and duration stay, marked
 *               retention.transcriptStrippedAtMs.
 *   brief       any leads/{leadId}/call_briefs/{callId} generated more than
 *               24 months ago is deleted.
 *
 * Never touched: the Drive original (this file never loads a Drive client;
 * driveFileId stays on the call), a call or lead on legal hold or with an
 * open insurance claim (call-retention-logic holdReason), the timeline
 * entries on the lead (business records, not the transcript).
 *
 * Bounded: pages of 100, at most 1000 records a phase a run, and a deadline
 * one minute inside the timeout. Each phase keeps a cursor (the ordered date
 * plus the doc id / path) in system/callRetention, so the next run carries on
 * where this one stopped; a full pass restarts every 30 days so a lifted hold
 * is looked at again. A record that fails goes on that phase's retry list in
 * the same doc (at most RETRY_MAX) and is tried first on the next run, so the
 * cursor moving past it never leaves it for the 30-day rescan.
 *
 * Audit: every deletion writes one call_retention_log row (ids and dates
 * only, never what was said). Transcript and brief rows go in the same batch
 * as the change. An audio row cannot (Storage is not in a Firestore batch),
 * so it is written FIRST with state 'pending' under a fixed id (kind, call,
 * path), then the object is deleted, then the call patch and state 'done'
 * commit together. A failed delete marks the row 'failed'; a failed patch
 * leaves it 'pending', and the retry finishes the patch even if a hold
 * landed in between (the audio is already gone). So a deleted object always
 * has a row. The collection is server-only (firestore.rules catch-all deny).
 *
 * DRY RUN unless CALL_RETENTION_ENABLED === 'true': it reads, counts and logs
 * what it would do, and writes nothing at all (no Storage delete, no
 * Firestore write, not even its cursor).
 *
 * Thursday (roadmap step 17C, 2026-11-25): two more phases, after the three
 * above, give thursday_calls (the Bland receptionist's calls) the SAME rules:
 *   thursdayAudio       older than 12 months with a recordingPath: the
 *                       Storage object calls/{owner}/<callId>.<ext> is
 *                       deleted, recordingPath and call.recordingUrl null,
 *                       audioRemoved 'retention'. A reprocess never copies it
 *                       back (call-retention-logic thursdayKeep).
 *   thursdayTranscript  older than 24 months: call.transcript / transcripts /
 *                       summary, issue, callNotes, extraction and raw are
 *                       stripped (call-retention-logic THURSDAY_TRANSCRIPT_
 *                       FIELDS); the doc, its date, number and lead stay.
 * Same holds, cursors, caps, retries and audit rows (kind thursday_audio /
 * thursday_transcript). Their own second switch: they act only when BOTH
 * CALL_RETENTION_ENABLED and CALL_RETENTION_THURSDAY_ENABLED are 'true';
 * otherwise they run DRY (even inside a live run): every record they would
 * strip or delete is logged (call_retention_would_delete: ids and paths, never
 * what was said) and nothing of theirs is written, not even their cursor. A
 * Thursday call's phone_calls projection (thursday_<id>) is a phone_calls doc
 * and goes through the three phases above (its callNotes stripped with its
 * transcript); once stripped, a re-projection keeps it empty
 * (thursday-projection.js).
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const R = require('./call-retention-logic');
const { matchDocPath } = require('./collection-group-paths');

const STATE_DOC = 'system/callRetention';
const LOG = 'call_retention_log';
const BATCH = 100;
const MAX_PER_PHASE = 1000;
const RETRY_MAX = 100;
const TIMEOUT_S = 540;
const DEADLINE_MS = (TIMEOUT_S - 60) * 1000;

const enabled = () => process.env.CALL_RETENTION_ENABLED === 'true';
const thursdayEnabled = () => process.env.CALL_RETENTION_THURSDAY_ENABLED === 'true';
const WOULD_DELETE_MAX = 50; // the dry-run sample a run returns (every one is logged)

const PHASES = [
  { key: 'audio', months: R.POLICY.audioMonths, source: 'calls' },
  { key: 'transcript', months: R.POLICY.transcriptMonths, source: 'calls' },
  { key: 'brief', months: R.POLICY.briefMonths, source: 'briefs' },
  { key: 'thursdayAudio', months: R.POLICY.audioMonths, source: 'thursday' },
  { key: 'thursdayTranscript', months: R.POLICY.transcriptMonths, source: 'thursday' },
];

const safeId = (v) => typeof v === 'string' && !!v && !v.includes('/');

// Cost note: this pages EVERY record before the cutoff, including ones already
// stripped or without audio, and they count toward MAX_PER_PHASE. With the
// 30-day rescan, a phase with more than about 30 x MAX_PER_PHASE (30k)
// pre-cutoff records can no longer reach newly aged ones before the rescan
// resets its cursor. Fine at today's volume; past that, filter on retention.*
// or keep a separate done marker.
function baseQuery(db, ph, cutoff, docIdField) {
  // thursday_calls has no ms field: createdAt is a Timestamp (the webhook and
  // the backfill both stamp it), compared as a Date.
  if (ph.source === 'thursday') return db.collection('thursday_calls').where('createdAt', '<', new Date(cutoff)).orderBy('createdAt').orderBy(docIdField);
  return ph.source === 'calls'
    ? db.collection('phone_calls').where('createdAtMs', '<', cutoff).orderBy('createdAtMs').orderBy(docIdField)
    : db.collectionGroup('call_briefs').where('generatedAtMs', '<', cutoff).orderBy('generatedAtMs').orderBy(docIdField);
}
function pageQuery(db, ph, cutoff, cursor, n, docIdField) {
  let q = baseQuery(db, ph, cutoff, docIdField);
  if (cursor) q = q.startAfter(ph.source === 'thursday' ? new Date(cursor.ms) : cursor.ms, cursor.key);
  return q.limit(n);
}
const docKeyed = (ph) => ph.source === 'calls' || ph.source === 'thursday';
const collOf = (ph) => (ph.source === 'thursday' ? 'thursday_calls' : 'phone_calls');

/**
 * One run.
 * deps: { db, bucket, nowMs, live, thursdayLive?, clock?, deadlineMs?, batchSize?, maxPerPhase?, log?, docIdField?, serverTs? }
 * thursdayLive: the Thursday phases' own switch (they act only when live too).
 * @returns {{ mode, runId, rescan, cutoffs, phases }}
 */
async function runRetention({
  db, bucket, nowMs, live, thursdayLive = false, clock = Date.now, deadlineMs, batchSize = BATCH, maxPerPhase = MAX_PER_PHASE,
  log = logger, docIdField, serverTs,
}) {
  const idField = docIdField || FieldPath.documentId();
  const ts = serverTs || (() => FieldValue.serverTimestamp());
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : clock() + DEADLINE_MS;
  const runId = 'r' + nowMs;
  const stateSnap = await db.doc(STATE_DOC).get();
  const state = (stateSnap && stateSnap.exists && stateSnap.data()) || {};
  const rescan = R.shouldRescan(state, nowMs);
  const cursors = rescan ? {} : Object.assign({}, state.cursors || {});
  const oldRetry = state.retry || {};
  const retry = {};

  const leads = new Map();
  async function getLead(id) {
    if (!safeId(id)) return null;
    if (!leads.has(id)) {
      const s = await db.doc('leads/' + id).get();
      leads.set(id, s && s.exists ? (s.data() || {}) : null);
    }
    return leads.get(id);
  }

  // P2 integration: a merged pair is held together (call-retention-logic
  // mergedPartnerId), and a walkthrough brief (leads/{id}/call_briefs/
  // visit_<visitId>, call-brief.js) also honours its visit's legalHold.
  async function holdOf(call, lead, callId) {
    const why = R.holdReason({ call, lead });
    if (why) return why;
    const pid = R.mergedPartnerId(call);
    if (!pid || pid === callId) return null;
    const ps = await db.doc('phone_calls/' + pid).get();
    const partner = ps && ps.exists ? (ps.data() || {}) : null;
    if (!partner || !R.mergedBack(partner, callId)) return null;
    const pLead = partner.leadId ? await getLead(partner.leadId) : null;
    return R.holdReason({ call: partner, lead: pLead }) ? 'merged_partner_hold' : null;
  }
  async function visitHold(brief) {
    const b = brief || {};
    if (b.source !== 'visit' || !safeId(b.visitUid) || !safeId(b.visitId)) return null;
    const vs = await db.doc('users/' + b.visitUid + '/visit_captures/' + b.visitId).get();
    return vs && vs.exists && (vs.data() || {}).legalHold === true ? 'visit_legal_hold' : null;
  }

  const runLive = live;
  const out = { mode: live ? 'live' : 'dry-run', runId, rescan, cutoffs: {}, phases: {} };

  async function commitWith(fn) {
    const b = db.batch();
    fn(b);
    await b.commit();
  }
  // The one Storage call, for both audio phases: a path isCrmAudioPath approved.
  const deleteObject = (p) => bucket.file(p).delete({ ignoreNotFound: true });
  const audit = (b, row) => b.set(db.collection(LOG).doc(), Object.assign(row, { createdAt: ts() }));

  for (const ph of PHASES) {
    // Shadows the run's switch inside the phase: a Thursday phase acts only
    // when both switches are on.
    const live = ph.source === 'thursday' ? runLive && thursdayLive === true : runLive;
    const cutoff = R.cutoffMs(nowMs, ph.months);
    out.cutoffs[ph.key] = { months: ph.months, cutoffMs: cutoff, cutoffYmd: R.etYmd(cutoff) };
    const st = { scanned: 0, eligible: 0, done: 0, held: {}, skipped: 0, badPath: 0, failed: 0, retried: 0, stoppedBy: null };
    out.phases[ph.key] = st;
    let cursor = cursors[ph.key] || null;
    if (!live) {
      // A dry run never saves its cursor, so its eligible counts cover only the
      // first maxPerPhase records. One aggregate count gives Jo the whole
      // backlog past this cutoff (already-done records included; null on error).
      try {
        const c = await baseQuery(db, ph, cutoff, idField).count().get();
        st.pastCutoff = Number((c.data() || {}).count);
      } catch (e) { st.pastCutoff = null; }
    }
    const failedKeys = [];
    const keyOf = (d) => (docKeyed(ph) ? d.id : d.ref.path);
    // A Thursday phase running dry says what it would do, record by record.
    const wouldDelete = (row) => {
      log.info('call_retention_would_delete', Object.assign({ phase: ph.key }, row));
      if (!st.wouldDelete) st.wouldDelete = [];
      if (st.wouldDelete.length < WOULD_DELETE_MAX) st.wouldDelete.push(row);
    };

    const handle = async (d, isRetry) => {
      const data = d.data() || {};
      if (ph.source === 'thursday') {
        const tc = data;
        const age = R.thursdayAgeMs(tc);
        if (!R.isPast(age, cutoff)) { st.skipped++; return; }
        const lead = tc.leadId ? await getLead(tc.leadId) : null;
        const docPath = 'thursday_calls/' + d.id;
        const owner = { userId: tc.userId || tc.companyId || null, companyId: tc.companyId || null };
        if (ph.key === 'thursdayAudio') {
          const p = tc.recordingPath;
          if (!p) { st.skipped++; return; }
          if (!R.isCrmAudioPath(p, owner)) { st.badPath++; log.warn('call_retention_bad_path', { thursdayDoc: d.id }); return; }
          const logRef = db.collection(LOG).doc(R.auditId('thursday_audio', d.id, p));
          // Same retry rule as the Cube audio phase: a row still 'pending'
          // means the object is gone; finish the patch whatever the hold says.
          let finishing = false;
          if (isRetry && live) {
            const ls = await logRef.get();
            finishing = !!(ls && ls.exists && (ls.data() || {}).state === 'pending');
          }
          if (!finishing) {
            const why = R.holdReason({ call: tc, lead });
            if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
          }
          st.eligible++;
          if (!live) { wouldDelete({ docPath, storagePath: p, fields: ['recordingPath'] }); return; }
          if (!finishing) {
            await logRef.set(Object.assign(R.auditEntry({ kind: 'thursday_audio', callId: d.id, leadId: tc.leadId, call: owner, docPath, storagePath: p, fields: ['recordingPath'], ageMs: age, cutoff, months: ph.months, runId, nowMs }), { state: 'pending', createdAt: ts() }));
            try { await deleteObject(p); } catch (e) {
              try { await logRef.set({ state: 'failed', failedAtMs: nowMs, error: String((e && e.message) || e).slice(0, 200) }, { merge: true }); } catch (_) { /* the retry rewrites it */ }
              throw e;
            }
          }
          await commitWith((b) => {
            b.set(d.ref, R.thursdayAudioPatch(nowMs), { merge: true });
            b.set(logRef, { state: 'done', doneAtMs: nowMs }, { merge: true });
          });
          st.done++;
          return;
        }
        // thursdayTranscript
        const tp = R.thursdayTranscriptPatch(tc, nowMs);
        if (!tp) { st.skipped++; return; }
        const why = R.holdReason({ call: tc, lead });
        if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
        st.eligible++;
        if (!live) { wouldDelete({ docPath, fields: tp.fields }); return; }
        await commitWith((b) => {
          b.set(d.ref, tp.patch, { merge: true });
          audit(b, R.auditEntry({ kind: 'thursday_transcript', callId: d.id, leadId: tc.leadId, call: owner, docPath, fields: tp.fields, ageMs: age, cutoff, months: ph.months, runId, nowMs }));
        });
        st.done++;
        return;
      }
      if (ph.source === 'calls') {
        const call = data;
        const age = R.callAgeMs(call);
        if (!R.isPast(age, cutoff)) { st.skipped++; return; }
        const lead = call.leadId ? await getLead(call.leadId) : null;
        if (ph.key === 'audio') {
          const p = call.storagePath;
          if (!p) { st.skipped++; return; }
          if (!R.isCrmAudioPath(p, call)) { st.badPath++; log.warn('call_retention_bad_path', { callId: d.id }); return; }
          const logRef = db.collection(LOG).doc(R.auditId('audio', d.id, p));
          // A retry of a call whose object is already gone (row still 'pending'):
          // finish the patch whatever the hold says now; the audio cannot come back.
          let finishing = false;
          if (isRetry && live) {
            const ls = await logRef.get();
            finishing = !!(ls && ls.exists && (ls.data() || {}).state === 'pending');
          }
          if (!finishing) {
            const why = await holdOf(call, lead, d.id);
            if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
          }
          st.eligible++;
          if (!live) return;
          if (!finishing) {
            // Row first (pending), then the delete: a deleted object always has a row.
            await logRef.set(Object.assign(R.auditEntry({ kind: 'audio', callId: d.id, leadId: call.leadId, call, docPath: 'phone_calls/' + d.id, storagePath: p, fields: ['storagePath'], ageMs: age, cutoff, months: ph.months, runId, nowMs }), { state: 'pending', createdAt: ts() }));
            try { await deleteObject(p); } catch (e) {
              try { await logRef.set({ state: 'failed', failedAtMs: nowMs, error: String((e && e.message) || e).slice(0, 200) }, { merge: true }); } catch (_) { /* the retry rewrites it */ }
              throw e;
            }
          }
          await commitWith((b) => {
            b.set(d.ref, R.audioPatch(nowMs, call), { merge: true });
            b.set(logRef, { state: 'done', doneAtMs: nowMs }, { merge: true });
          });
          st.done++;
          return;
        }
        // transcript
        const tp = R.transcriptPatch(call, nowMs);
        const briefRef = safeId(call.leadId) ? db.doc('leads/' + call.leadId + '/call_briefs/' + d.id) : null;
        const briefSnap = briefRef ? await briefRef.get() : null;
        const hasBrief = !!(briefSnap && briefSnap.exists);
        if (!tp && !hasBrief) { st.skipped++; return; }
        const why = await holdOf(call, lead, d.id);
        if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
        st.eligible++;
        if (!live) return;
        await commitWith((b) => {
          if (tp) {
            b.set(d.ref, tp.patch, { merge: true });
            audit(b, R.auditEntry({ kind: 'transcript', callId: d.id, leadId: call.leadId, call, docPath: 'phone_calls/' + d.id, fields: tp.fields, ageMs: age, cutoff, months: ph.months, runId, nowMs }));
          }
          if (hasBrief) {
            b.delete(briefRef);
            audit(b, R.auditEntry({ kind: 'brief', callId: d.id, leadId: call.leadId, call, docPath: briefRef.path, fields: [], ageMs: age, cutoff, months: ph.months, runId, nowMs }));
          }
        });
        st.done++;
        return;
      }
      // brief phase: only leads/{leadId}/call_briefs/{callId}, nothing else of that name
      const m = matchDocPath(R.BRIEF_PATH, d.ref.path);
      if (!m) { st.badPath++; return; }
      const age = R.briefAgeMs(data);
      if (!R.isPast(age, cutoff)) { st.skipped++; return; }
      const callSnap = await db.doc('phone_calls/' + m.callId).get();
      const call = callSnap && callSnap.exists ? (callSnap.data() || {}) : null;
      const lead = await getLead(m.leadId);
      const why = (call ? await holdOf(call, lead, m.callId) : R.holdReason({ call, lead })) || await visitHold(data);
      if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
      st.eligible++;
      if (!live) return;
      await commitWith((b) => {
        b.delete(d.ref);
        audit(b, R.auditEntry({ kind: 'brief', callId: m.callId, leadId: m.leadId, call, docPath: d.ref.path, fields: [], ageMs: age, cutoff, months: ph.months, runId, nowMs }));
      });
      st.done++;
    };

    // Last run's failures first. A key is a phone_calls id or a brief path.
    for (const key of (Array.isArray(oldRetry[ph.key]) ? oldRetry[ph.key] : []).slice(0, RETRY_MAX)) {
      if (clock() >= deadline) { failedKeys.push(key); continue; }
      const p = docKeyed(ph) ? (safeId(key) ? collOf(ph) + '/' + key : null) : (typeof key === 'string' && matchDocPath(R.BRIEF_PATH, key) ? key : null);
      if (!p) continue;
      try {
        const ref = db.doc(p);
        const snap = await ref.get();
        if (!snap || !snap.exists) continue;
        st.retried++;
        await handle({ id: ref.id, ref, data: () => snap.data() }, true);
      } catch (e) {
        st.failed++; failedKeys.push(key);
        log.warn('call_retention_failed', { phase: ph.key, path: p, retry: true, err: e && e.message });
      }
    }

    outer: for (;;) {
      if (clock() >= deadline) { st.stoppedBy = 'deadline'; break; }
      if (st.scanned >= maxPerPhase) { st.stoppedBy = 'cap'; break; }
      const n = Math.min(batchSize, maxPerPhase - st.scanned);
      let snap;
      try { snap = await pageQuery(db, ph, cutoff, cursor, n, idField).get(); } catch (e) {
        // e.g. the call_briefs index not built yet: this phase stops, the others and the cursor save still run.
        st.stoppedBy = 'error'; st.error = String((e && e.message) || e).slice(0, 200);
        log.warn('call_retention_query_failed', { phase: ph.key, err: st.error });
        break;
      }
      const docs = (snap && snap.docs) || [];
      for (const d of docs) {
        if (clock() >= deadline) { st.stoppedBy = 'deadline'; break outer; }
        st.scanned++;
        try { await handle(d, false); } catch (e) {
          st.failed++;
          if (!failedKeys.includes(keyOf(d))) failedKeys.push(keyOf(d));
          log.warn('call_retention_failed', { phase: ph.key, path: d.ref && d.ref.path, err: e && e.message });
        }
        const v = d.data() || {};
        const ms = ph.source === 'thursday' ? R.thursdayAgeMs({ createdAt: v.createdAt }) : Number(ph.source === 'calls' ? v.createdAtMs : v.generatedAtMs);
        cursor = { ms, key: docKeyed(ph) ? d.id : d.ref.path };
      }
      if (docs.length < n) { st.stoppedBy = 'end'; break; }
    }
    // A phase that ran dry inside a live run keeps its saved place untouched.
    if (live || !runLive) {
      cursors[ph.key] = cursor;
      retry[ph.key] = failedKeys.slice(0, RETRY_MAX);
    } else {
      cursors[ph.key] = (state.cursors || {})[ph.key] || null;
      retry[ph.key] = Array.isArray(oldRetry[ph.key]) ? oldRetry[ph.key] : [];
    }
  }

  if (live) {
    await db.doc(STATE_DOC).set({
      cursors, retry,
      passStartedAtMs: rescan ? nowMs : (Number(state.passStartedAtMs) || nowMs),
      lastRunAtMs: nowMs, lastRunId: runId,
      lastRun: Object.fromEntries(Object.entries(out.phases).map(([k, s]) => [k, { scanned: s.scanned, done: s.done, held: s.held, failed: s.failed, retried: s.retried, stoppedBy: s.stoppedBy }])),
    }, { merge: false });
  }
  return out;
}

exports.callRetention = onSchedule(
  { schedule: '20 3 * * *', timeZone: 'America/New_York', timeoutSeconds: TIMEOUT_S, memory: '512MiB', maxInstances: 1 },
  async () => {
    const live = enabled();
    const r = await runRetention({ db: getFirestore(), bucket: getStorage().bucket(), nowMs: Date.now(), live, thursdayLive: thursdayEnabled() });
    logger.info('[callRetention]', r);
  }
);

exports._test = { runRetention, PHASES, STATE_DOC, LOG, BATCH, MAX_PER_PHASE, RETRY_MAX, DEADLINE_MS };
