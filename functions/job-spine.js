/**
 * job-spine.js — real-world events move the job forward (2026-10-03).
 *
 *   recordJobEvent(db, { leadId, companyId, event, sourceId, actor, at, meta })
 *
 * One call per real-world event (contract signed remotely, invoice paid in
 * full, deposit paid, inspection booked…). The rules — which stage each
 * (event, jobType) reaches, forward-only, never a lost / closed / deleted /
 * custom-stage lead — live in job-spine-logic.js. This file does the I/O, in
 * ONE Firestore transaction:
 *
 *   reads   job_events/{marker}      the (leadId, event, sourceId) marker
 *           leads/{leadId}
 *           leads/{leadId}/tasks/{stage-entry task id}   (only on a move)
 *   writes  job_events/{marker}      always — created once, so a retried
 *                                    trigger / webhook redelivery is a no-op
 *           leads/{leadId}           on a move: exactly what the client's
 *                                    commitStageChange writes
 *           notes/spine-{marker}     timeline note (on a move, or meta.note)
 *           leads/{leadId}/tasks/…   stage-entry task, only if absent (never
 *                                    reopens one the rep already finished)
 *
 * Right after a contract_signed / deal_accepted event (first delivery or a
 * retry), deposit-draft.js makes the DRAFT deposit invoice — once per lead
 * + job, never sent (Jo, 2026-10-03). Its result rides back on
 * `depositDraft`.
 *
 * Never sends anything to a customer. Never throws: callers are webhooks and
 * triggers whose real work already succeeded, so a spine failure is logged
 * and returned as { error }.
 *
 * NOT a Cloud Function and must never become an index.js export (index.js
 * would deploy a plain object as a function group). Callers require it.
 */
'use strict';

const L = require('./job-spine-logic');

function _deps(deps) {
  deps = deps || {};
  let FieldValue = deps.FieldValue;
  if (!FieldValue) FieldValue = require('firebase-admin/firestore').FieldValue;
  let logger = deps.logger;
  if (!logger) {
    try { logger = require('firebase-functions/v2').logger; } catch (_) { logger = console; }
  }
  return { FieldValue, logger, now: deps.now || (() => Date.now()) };
}

function _iso(at, nowMs) {
  if (at instanceof Date && !isNaN(at.getTime())) return at.toISOString();
  if (at && typeof at.toDate === 'function') { try { return at.toDate().toISOString(); } catch (_) { /* fall through */ } }
  if (typeof at === 'number' && Number.isFinite(at)) return new Date(at).toISOString();
  if (typeof at === 'string' && !isNaN(Date.parse(at))) return new Date(at).toISOString();
  return new Date(nowMs).toISOString();
}

/**
 * @returns {Promise<{ moved: boolean, duplicate?: boolean, reason?: string,
 *   from?: string|null, to?: string, taskId?: string|null, markerId: string,
 *   error?: string }>}
 */
async function recordJobEvent(db, args, deps) {
  const out = await _recordJobEventCore(db, args, deps);
  const event = String((args && args.event) || '');
  // The draft deposit invoice. Also on a duplicate: a retry after a draft
  // failure gets another try, and the draft itself is idempotent (one
  // deterministic id per lead + job). Not on a refused event.
  const refused = ['bad_lead_id', 'unknown_event', 'tenant_mismatch', 'error'];
  if (DEPOSIT_DRAFT_EVENTS.indexOf(event) !== -1 && refused.indexOf(out.reason) === -1
      && !(deps && deps.depositDraft === false)) {
    const draft = (deps && deps.draftDepositAfterSign) || require('./deposit-draft').draftDepositAfterSign;
    try {
      out.depositDraft = await draft(db, {
        leadId: String(args.leadId || '').trim(), event,
        sourceId: args.sourceId != null ? String(args.sourceId) : '',
        meta: (args.meta && typeof args.meta === 'object') ? args.meta : {},
      }, deps);
    } catch (e) {
      out.depositDraft = { created: false, reason: 'error', error: String((e && e.message) || e) };
    }
  }
  return out;
}
const DEPOSIT_DRAFT_EVENTS = ['contract_signed', 'deal_accepted'];

async function _recordJobEventCore(db, args, deps) {
  const { FieldValue, logger, now } = _deps(deps);
  args = args || {};
  const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
  const event = String(args.event || '');
  const meta = (args.meta && typeof args.meta === 'object') ? args.meta : {};
  const sourceId = args.sourceId != null ? String(args.sourceId) : (meta.sourceId != null ? String(meta.sourceId) : '');
  const actor = String(args.actor || 'system').slice(0, 120);
  const nowMs = now();
  const atIso = _iso(args.at, nowMs);

  if (!db || !leadId || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) return { moved: false, reason: 'bad_lead_id', markerId: '' };
  if (L.EVENTS.indexOf(event) === -1) {
    logger.warn('[jobSpine] unknown event', { event, leadId });
    return { moved: false, reason: 'unknown_event', markerId: '' };
  }

  const mid = L.markerId(leadId, event, sourceId);

  try {
    const markerRef = db.collection('job_events').doc(mid);
    const leadRef = db.collection('leads').doc(leadId);
    const noteRef = db.collection('notes').doc('spine-' + mid);
    const out = await db.runTransaction(async (tx) => {
      const ms = await tx.get(markerRef);
      if (ms.exists) {
        const r = (ms.data() || {}).result || {};
        return { moved: false, duplicate: true, reason: 'duplicate', from: r.from || null, to: r.to || null, markerId: mid };
      }
      const ls = await tx.get(leadRef);
      const lead = ls.exists ? (ls.data() || {}) : null;

      let plan;
      if (lead && args.companyId && lead.companyId && String(lead.companyId) !== String(args.companyId)) {
        plan = { action: 'skip', reason: 'tenant_mismatch' };
      } else {
        plan = L.planJobEvent(lead, event);
      }

      // Stage-entry task: read BEFORE any write (transaction rule).
      let task = null; let taskRef = null;
      if (plan.action === 'move') {
        const t = L.stageEntryTask(plan.to, plan.jobType, L.todayYmdEt(nowMs));
        if (t) {
          taskRef = leadRef.collection('tasks').doc(t.id);
          const ts = await tx.get(taskRef);
          if (!ts.exists) task = t;
        }
      }

      const result = { action: plan.action, reason: plan.reason || null, from: plan.action === 'move' ? plan.from : (lead ? (lead.stage == null ? null : lead.stage) : null), to: plan.to || null };
      tx.create(markerRef, {
        leadId, companyId: args.companyId || (lead && lead.companyId) || null,
        event, sourceId: sourceId || null, actor, at: atIso,
        meta: L.cleanMeta(meta), result,
        createdAt: FieldValue.serverTimestamp(),
      });

      const noteBase = {
        leadId,
        // The lead owner, like a client-written note — the timeline reads by
        // leadId; userId keeps the note owned by the lead's owner for the
        // update/delete rule.
        userId: (lead && lead.userId) || null,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: 'system: ' + actor,
        source: 'job_spine',
        event,
      };

      if (plan.action === 'move') {
        const { payload } = L.movePayload(lead, plan, { actor, atIso, event }, FieldValue);
        tx.update(leadRef, payload);
        tx.set(noteRef, Object.assign({}, noteBase, {
          text: L.moveNoteText(plan.to, event, meta.detail),
          type: 'stage_change',
        }));
        if (task) tx.set(taskRef, Object.assign({}, task.doc, { createdAt: FieldValue.serverTimestamp(), createdBy: 'system: job spine' }));
        return { moved: true, from: plan.from, to: plan.to, taskId: task ? task.id : null, markerId: mid };
      }

      // No move — still leave the caller's note (e.g. "Inspection booked
      // via Cal.com…") on a live lead, once.
      if (lead && !L.isDeleted(lead) && typeof meta.note === 'string' && meta.note.trim()) {
        tx.set(noteRef, Object.assign({}, noteBase, { text: meta.note.trim().slice(0, 500), type: 'note' }));
      }
      return { moved: false, reason: plan.reason, from: result.from, to: plan.to || null, markerId: mid };
    });

    if (out.moved) {
      logger.info('[jobSpine] moved', { leadId, event, sourceId, from: out.from, to: out.to, taskId: out.taskId });
    } else if (out.reason === 'custom_stage') {
      // The rule says "do nothing and log" — a tenant stage the spine can't place.
      logger.info('[jobSpine] custom/unknown stage — left alone', { leadId, event, sourceId, stage: out.from });
    } else if (!out.duplicate) {
      logger.info('[jobSpine] no move', { leadId, event, sourceId, reason: out.reason, from: out.from });
    }
    return out;
  } catch (e) {
    // ALREADY_EXISTS on the marker = a concurrent delivery won the race.
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) {
      return { moved: false, duplicate: true, reason: 'duplicate', markerId: mid };
    }
    logger.warn('[jobSpine] recordJobEvent failed', { leadId, event, sourceId, err: e && e.message });
    return { moved: false, reason: 'error', error: String((e && e.message) || e), markerId: mid };
  }
}

// ── Caller adapters ──────────────────────────────────────────────────────
// One per wired caller, here (not in the caller's file) so each is testable
// with a fake db: index.js deploys every export of remote-signing.js /
// esign-envelope.js / deal-acceptance.js as a function, so those files can't
// export helpers. Each adapter never throws.

/**
 * Remote signing (remote-signing.js submitSignature), after the token burn.
 * A signed CONTRACT: stamp the lead's "Contract Filed" field exactly as an
 * in-person signing does (document-generator.js onPersistFinalized —
 * FILED_FIELD_BY_DOC_TYPE, an ISO string), then contract_signed. A signed
 * certificate of completion stamps cocFiledAt the same way, no stage event.
 * info = { leadId, docId, signerName }.
 */
async function spineAfterRemoteSign(db, info, deps) {
  const { logger } = _deps(deps);
  try {
    if (!info || !info.leadId || !info.docId) return { skipped: 'no_doc' };
    const ds = await db.doc('leads/' + info.leadId + '/documents/' + info.docId).get();
    const type = ds.exists ? String((ds.data() || {}).type || '') : '';
    const filedField = L.FILED_FIELD_BY_DOC_TYPE[type] || null;
    if (filedField) {
      await db.collection('leads').doc(String(info.leadId)).update({ [filedField]: new Date(_deps(deps).now()).toISOString() })
        .catch((e) => logger.warn('[jobSpine] filed stamp failed', { leadId: info.leadId, filedField, err: e && e.message }));
    }
    if (type !== 'contract') return { filedField, skipped: 'not_a_contract' };
    const r = await recordJobEvent(db, {
      leadId: String(info.leadId), event: 'contract_signed', sourceId: 'doc_' + info.docId,
      actor: 'remote signing', meta: { docId: String(info.docId), detail: (info.signerName ? info.signerName + ' signed' : 'signed') + ' remotely' },
    }, deps);
    return { filedField, spine: r };
  } catch (e) {
    logger.warn('[jobSpine] remote-sign adapter failed', { leadId: info && info.leadId, err: e && e.message });
    return { error: String((e && e.message) || e) };
  }
}

/**
 * E-sign envelope completed (esign-envelope.js submitEsignEnvelope). An
 * envelope is an uploaded PDF with only a title, so it counts as THE contract
 * only when its title says so (job-spine-logic envelopeIsContract). Then the
 * same as a remote contract: Contract Filed + contract_signed.
 */
async function spineAfterEsign(db, env, envelopeId, signerName, deps) {
  const { logger, now } = _deps(deps);
  try {
    if (!env || !env.leadId || !L.envelopeIsContract(env)) return { skipped: 'not_a_contract' };
    await db.collection('leads').doc(String(env.leadId)).update({ contractFiledAt: new Date(now()).toISOString() })
      .catch((e) => logger.warn('[jobSpine] filed stamp failed', { leadId: env.leadId, err: e && e.message }));
    const r = await recordJobEvent(db, {
      leadId: String(env.leadId), companyId: env.companyId || null, event: 'contract_signed',
      sourceId: 'env_' + envelopeId, actor: 'e-sign envelope',
      meta: { envelopeId: String(envelopeId), detail: ((signerName || env.signerName || 'homeowner') + ' signed "' + String(env.title || 'contract').slice(0, 80) + '"') },
    }, deps);
    return { filedField: 'contractFiledAt', spine: r };
  } catch (e) {
    logger.warn('[jobSpine] esign adapter failed', { envelopeId, err: e && e.message });
    return { error: String((e && e.message) || e) };
  }
}

/**
 * Deal room accepted (deal-acceptance.js submitDealAcceptance) — the
 * homeowner picked a package and signed. info = { dealId, leadId,
 * customerName, price }; tier = the accepted package.
 */
async function spineAfterDealAccept(db, info, tier, deps) {
  if (!info || !info.leadId) return { skipped: 'no_lead' };
  return recordJobEvent(db, {
    leadId: String(info.leadId), event: 'deal_accepted', sourceId: 'deal_' + info.dealId,
    actor: 'deal room acceptance',
    meta: { dealId: String(info.dealId || ''), tier: String(tier || ''), detail: String(tier || '').toUpperCase() + ' package accepted online' },
  }, deps);
}

/**
 * Cal.com booking created (integrations/calcom.js) → booked: New → Contacted,
 * plus a timeline note naming the appointment (written even when the lead is
 * already further along, so the booking is on the timeline either way).
 */
function _fmtEt(d) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  } catch (_) { return d.toISOString(); }
}
async function spineAfterBooking(db, { leadId, companyId, bookingId, startTime, title }, deps) {
  if (!leadId || !bookingId) return { skipped: 'no_lead' };
  const when = startTime instanceof Date && !isNaN(startTime.getTime()) ? _fmtEt(startTime) : '';
  const what = String(title || 'Appointment').slice(0, 80);
  const detail = 'Cal.com: ' + what + (when ? ', ' + when : '');
  return recordJobEvent(db, {
    leadId: String(leadId), companyId: companyId || null, event: 'booked', sourceId: 'calcom_' + bookingId,
    actor: 'Cal.com booking',
    meta: { bookingId: String(bookingId), detail, note: 'Booked via ' + detail + '.' },
  }, deps);
}

module.exports = { recordJobEvent, spineAfterRemoteSign, spineAfterEsign, spineAfterDealAccept, spineAfterBooking };
