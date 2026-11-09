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
 * or a failed record is looked at again.
 *
 * Audit: every deletion writes one call_retention_log row (ids and dates
 * only, never what was said), in the same batch as the change. The
 * collection is server-only (firestore.rules catch-all deny).
 *
 * DRY RUN unless CALL_RETENTION_ENABLED === 'true': it reads, counts and logs
 * what it would do, and writes nothing at all (no Storage delete, no
 * Firestore write, not even its cursor).
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
const TIMEOUT_S = 540;
const DEADLINE_MS = (TIMEOUT_S - 60) * 1000;

const enabled = () => process.env.CALL_RETENTION_ENABLED === 'true';

const PHASES = [
  { key: 'audio', months: R.POLICY.audioMonths, source: 'calls' },
  { key: 'transcript', months: R.POLICY.transcriptMonths, source: 'calls' },
  { key: 'brief', months: R.POLICY.briefMonths, source: 'briefs' },
];

const safeId = (v) => typeof v === 'string' && !!v && !v.includes('/');

function pageQuery(db, ph, cutoff, cursor, n, docIdField) {
  let q = ph.source === 'calls'
    ? db.collection('phone_calls').where('createdAtMs', '<', cutoff).orderBy('createdAtMs').orderBy(docIdField)
    : db.collectionGroup('call_briefs').where('generatedAtMs', '<', cutoff).orderBy('generatedAtMs').orderBy(docIdField);
  if (cursor) q = q.startAfter(cursor.ms, cursor.key);
  return q.limit(n);
}

/**
 * One run.
 * deps: { db, bucket, nowMs, live, clock?, deadlineMs?, batchSize?, maxPerPhase?, log?, docIdField?, serverTs? }
 * @returns {{ mode, runId, rescan, cutoffs, phases }}
 */
async function runRetention({
  db, bucket, nowMs, live, clock = Date.now, deadlineMs, batchSize = BATCH, maxPerPhase = MAX_PER_PHASE,
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

  const leads = new Map();
  async function getLead(id) {
    if (!safeId(id)) return null;
    if (!leads.has(id)) {
      const s = await db.doc('leads/' + id).get();
      leads.set(id, s && s.exists ? (s.data() || {}) : null);
    }
    return leads.get(id);
  }

  const out = { mode: live ? 'live' : 'dry-run', runId, rescan, cutoffs: {}, phases: {} };

  async function commitWith(fn) {
    const b = db.batch();
    fn(b);
    await b.commit();
  }
  const audit = (b, row) => b.set(db.collection(LOG).doc(), Object.assign(row, { createdAt: ts() }));

  for (const ph of PHASES) {
    const cutoff = R.cutoffMs(nowMs, ph.months);
    out.cutoffs[ph.key] = { months: ph.months, cutoffMs: cutoff, cutoffYmd: R.etYmd(cutoff) };
    const st = { scanned: 0, eligible: 0, done: 0, held: {}, skipped: 0, badPath: 0, failed: 0, stoppedBy: null };
    out.phases[ph.key] = st;
    let cursor = cursors[ph.key] || null;

    const handle = async (d) => {
      const data = d.data() || {};
      if (ph.source === 'calls') {
        const call = data;
        const age = R.callAgeMs(call);
        if (!R.isPast(age, cutoff)) { st.skipped++; return; }
        const lead = call.leadId ? await getLead(call.leadId) : null;
        if (ph.key === 'audio') {
          const p = call.storagePath;
          if (!p) { st.skipped++; return; }
          if (!R.isCrmAudioPath(p, call)) { st.badPath++; log.warn('call_retention_bad_path', { callId: d.id }); return; }
          const why = R.holdReason({ call, lead });
          if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
          st.eligible++;
          if (!live) return;
          // Storage first: if the batch below fails, the next run finds the
          // path still set and deletes again (ignoreNotFound), then logs.
          await bucket.file(p).delete({ ignoreNotFound: true });
          await commitWith((b) => {
            b.set(d.ref, R.audioPatch(nowMs), { merge: true });
            audit(b, R.auditEntry({ kind: 'audio', callId: d.id, leadId: call.leadId, call, docPath: 'phone_calls/' + d.id, storagePath: p, fields: ['storagePath'], ageMs: age, cutoff, months: ph.months, runId, nowMs }));
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
        const why = R.holdReason({ call, lead });
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
      const why = R.holdReason({ call, lead });
      if (why) { st.held[why] = (st.held[why] || 0) + 1; return; }
      st.eligible++;
      if (!live) return;
      await commitWith((b) => {
        b.delete(d.ref);
        audit(b, R.auditEntry({ kind: 'brief', callId: m.callId, leadId: m.leadId, call, docPath: d.ref.path, fields: [], ageMs: age, cutoff, months: ph.months, runId, nowMs }));
      });
      st.done++;
    };

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
        try { await handle(d); } catch (e) {
          st.failed++;
          log.warn('call_retention_failed', { phase: ph.key, path: d.ref && d.ref.path, err: e && e.message });
        }
        const v = d.data() || {};
        cursor = { ms: Number(ph.source === 'calls' ? v.createdAtMs : v.generatedAtMs), key: ph.source === 'calls' ? d.id : d.ref.path };
      }
      if (docs.length < n) { st.stoppedBy = 'end'; break; }
    }
    cursors[ph.key] = cursor;
  }

  if (live) {
    await db.doc(STATE_DOC).set({
      cursors,
      passStartedAtMs: rescan ? nowMs : (Number(state.passStartedAtMs) || nowMs),
      lastRunAtMs: nowMs, lastRunId: runId,
      lastRun: Object.fromEntries(Object.entries(out.phases).map(([k, s]) => [k, { scanned: s.scanned, done: s.done, held: s.held, failed: s.failed, stoppedBy: s.stoppedBy }])),
    }, { merge: false });
  }
  return out;
}

exports.callRetention = onSchedule(
  { schedule: '20 3 * * *', timeZone: 'America/New_York', timeoutSeconds: TIMEOUT_S, memory: '512MiB', maxInstances: 1 },
  async () => {
    const live = enabled();
    const r = await runRetention({ db: getFirestore(), bucket: getStorage().bucket(), nowMs: Date.now(), live });
    logger.info('[callRetention]', r);
  }
);

exports._test = { runRetention, PHASES, STATE_DOC, LOG, BATCH, MAX_PER_PHASE, DEADLINE_MS };
