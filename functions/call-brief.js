'use strict';

/**
 * functions/call-brief.js — Call to Close P0 (2026-11-09): the Call Brief.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2, §4.
 *
 * callBrief (onCall { callId, refresh? }) → { brief, generatedAtMs, cached,
 * refreshRefused?, decisions }. On TAP only, for a call a person filed on a
 * customer. Re-reads the stored transcript (never the notes pass's output),
 * asks Claude for strict JSON with a verbatim quote on every fact, and runs
 * the server's grounding (call-brief-logic.js) before anything is stored.
 *
 * Gates, in order: App Check + assertNotGhost; the AI and call-brief kill
 * switches; exactly callCenterAction's role test (not a viewer; admin, the
 * call's owner, or same-company company_admin / manager); the lead in the
 * call's tenant and the human-filed gate (attachedBy / movedBy, no
 * alternates, noted); the cache (a re-tap costs nothing); a verified email +
 * paid plan (lead-brief.js aiAllowed); the quota (20 fresh briefs per user
 * and 60 per company per ET day, one transaction).
 *
 * Write: leads/{leadId}/call_briefs/{callId}, server-only (rules: write if
 * false), keyed by BRIEF_VERSION + a transcript hash. A forced refresh inside
 * 10 minutes serves the stored brief.
 *
 * callBriefDecide (onCall { callId, item, decision, value?,
 * confirmedInsurance? }) records every Accept / Skip, append-only, in the
 * brief's decisions[] (item, AI value, final value, decidedBy, time). An
 * accepted lead FIELD is written here, with the Admin SDK, FILL-EMPTY ONLY,
 * one field per call: never an overwrite, never a bulk apply. Carrier,
 * claim # and an insurance job type need the person's acknowledgement that
 * this makes the job an insurance job (Kentucky notices apply); the adjuster
 * meeting needs a confirm that it goes on the calendar. An accepted
 * summary becomes one activity note. Promises, follow-ups and handled go
 * through their own writers (callCenterAction, NBDFollowUpDeck); this only
 * logs them. Nothing here moves a stage, prices, sends or signs anything.
 * A stage accept (P1) is logged with how it was moved ('one-tap' or
 * 'confirmed'); the move itself went through the CRM's stage writer.
 *
 * P2 walkthrough (design §6 #11): both callables also take { visitId,
 * visitUid } instead of callId: a visit recording (visit-capture.js) filed on
 * a customer gets the same brief, the same gates (kill switches, the role
 * test with the recorder as the owner, cache, plan, the same quota), stored
 * at leads/{leadId}/call_briefs/visit_<visitId>. Promises and "handled" are
 * refused there (a walkthrough's promises are already tasks).
 *
 * callBriefAuto (P1, Firestore trigger on phone_calls/{callId}): the opt-in
 * auto-brief. Off unless companies/{companyId}/settings/callBrief.autoBrief
 * is true; then a person filing a call drafts the brief they would get on
 * tap, as that person, through the same gates and caps (autoBriefHandler).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { secretValue } = require('./integrations/_shared');
const L = require('./call-brief-logic');
const MG = require('./call-merge-logic');
const AiSpend = require('./ai-spend');
const { ANTHROPIC_API_KEY, aiAllowed } = require('./lead-brief');

const CALLS = 'phone_calls';
const QUOTA = 'call_brief_quota';
const MAX_DECISIONS = 300;
// Quota day counters expire a week after the write (Firestore TTL on
// expireAt, firestore.indexes.json; Call to Close P2): only today's count is
// ever read, the week is for a support question.
const QUOTA_TTL_MS = 7 * 86400000;
// adjusterMeetingDate feeds the calendar feed and Google Calendar (google-calendar-logic WATCHED).
const CALENDAR_ACK = 'This puts the adjuster meeting on the calendar and on Google Calendar when it is connected. Confirm it first.';
const INSURANCE_ACK = 'This makes the job an insurance job: Kentucky notices and the cancellation form will apply. Confirm it first.';
const RETYPE_ACK = 'This was hard to hear on the recording. Listen to it and type the value yourself.';

/** Default model call: raw /v1/messages (the repo's server pattern). */
async function anthropicCall(req) {
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) throw new Error('anthropic-not-configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(50_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('anthropic ' + res.status);
  return data;
}

const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const ks = () => require('./integrations/killswitch');

async function switchedOff(withAi) {
  try {
    const k = ks();
    if (withAi && await k.isAiDisabled()) return true;
    if (typeof k.isCallBriefDisabled === 'function' && await k.isCallBriefDisabled()) return true;
  } catch (_) { /* fail open to the other gates, as the other kill switches do */ }
  return false;
}

/** The call, the lead and the tenant, after the role, tenant and human-filed gates. */
async function loadGated(db, auth, data) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const callId = String((data && data.callId) || '');
  if (!/^cube_[A-Za-z0-9_-]{5,120}$/.test(callId)) throw new HttpsError('invalid-argument', 'Bad call id.');
  const snap = await db.collection(CALLS).doc(callId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = Object.assign({}, snap.data(), { id: callId });
  if (String((auth.token || {}).role || '') === 'viewer') throw new HttpsError('permission-denied', 'Your role is view-only.');
  if (!L.canActOnCall(auth, call)) throw new HttpsError('permission-denied', 'Not your call.');
  // P2: a call merged into another is read through that one's brief.
  if (call.mergedInto) throw new HttpsError('failed-precondition', 'This call was merged with the call before it. Draft from that one.');
  const problem = L.humanFiledProblem(call);
  if (problem) throw new HttpsError('failed-precondition', problem);
  const leadId = String(call.leadId);
  if (leadId.includes('/')) throw new HttpsError('invalid-argument', 'Bad lead id.');
  const ls = await db.doc('leads/' + leadId).get();
  const lead = ls.exists ? ls.data() : null;
  if (!lead || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
  // leadInCallTenant (call-center.js): the lead must be in the call's tenant.
  if (!((lead.companyId && lead.companyId === call.companyId) || (lead.userId && lead.userId === call.userId))) {
    throw new HttpsError('permission-denied', 'That customer is not in your company.');
  }
  const companyId = String(call.companyId || lead.companyId || call.userId || '');
  return { callId, call, leadId, lead, companyId, briefRef: db.doc('leads/' + leadId + '/call_briefs/' + callId) };
}

/**
 * P2 walkthrough (design §6 #11): the visit, the lead and the tenant, after
 * the visit's own gates. data: { visitId, visitUid } (the activity row on the
 * customer names both). Role = canActOnVisit (callCenterAction's test with
 * the visit's recorder as the owner); the lead must be in the recorder's
 * tenant (visit-capture.js mayRecordOn). Returns loadGated's shape, with a
 * call-shaped `call` so generate() reads both the same way.
 */
async function loadGatedVisit(db, auth, data) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const visitId = String((data && data.visitId) || '');
  const visitUid = String((data && data.visitUid) || '');
  if (!L.VISIT_ID_RE.test(visitId)) throw new HttpsError('invalid-argument', 'Bad visit id.');
  if (!L.UID_RE.test(visitUid)) throw new HttpsError('invalid-argument', 'Bad visit owner.');
  if (String((auth.token || {}).role || '') === 'viewer') throw new HttpsError('permission-denied', 'Your role is view-only.');
  const us = await db.doc('users/' + visitUid).get();
  const ownerCompany = String((us.exists && (us.data() || {}).companyId) || visitUid);
  const snap = await db.doc('users/' + visitUid + '/visit_captures/' + visitId).get();
  // No existence oracle: a caller who may not act on this recorder's visits
  // hears the same refusal whether or not the visit is there.
  if (!snap.exists) {
    if (!L.canActOnVisit(auth, { ownerUid: visitUid, companyId: ownerCompany })) throw new HttpsError('permission-denied', 'Not your walkthrough.');
    throw new HttpsError('not-found', 'Walkthrough not found.');
  }
  const visit = snap.data() || {};
  const leadId = String(visit.attachedLeadId || '');
  let lead = null;
  if (L.UID_RE.test(leadId)) {
    const ls = await db.doc('leads/' + leadId).get();
    lead = ls.exists ? ls.data() : null;
  }
  const companyId = String((lead && (lead.companyId || lead.userId)) || ownerCompany);
  if (!L.canActOnVisit(auth, { ownerUid: visitUid, companyId })) throw new HttpsError('permission-denied', 'Not your walkthrough.');
  const problem = L.visitBriefProblem(visit, leadId);
  if (problem) throw new HttpsError('failed-precondition', problem);
  if (!lead || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
  if (!(lead.userId === visitUid || (lead.companyId && lead.companyId === ownerCompany))) {
    throw new HttpsError('permission-denied', 'That customer is not in your company.');
  }
  const callId = L.visitBriefId(visitId);
  return {
    kind: 'visit', callId, visitId, visitUid, visit, leadId, lead, companyId,
    call: { userId: visitUid, companyId, startedAtMs: Number(visit.startedAtMs) || null, transcript: String(visit.transcript || ''), segIndex: null },
    briefRef: db.doc('leads/' + leadId + '/call_briefs/' + callId),
  };
}
const gateFor = (data) => (data && data.visitId != null ? loadGatedVisit : loadGated);
// visit_<visitId> leaves out the recorder, and visit ids are client-chosen:
// a stored walkthrough brief is only ever this recorder's (visit-capture.js
// visit_id_conflict refuses the second recorder first; this is the second wall).
function assertOwnVisitBrief(g, stored) {
  if (g.kind === 'visit' && stored && stored.visitUid !== g.visitUid) throw new HttpsError('permission-denied', 'That brief is from another walkthrough.');
}

/** One transaction: false + which cap when over, else both counters +1. */
async function takeQuota(db, uid, companyId, nowMs) {
  const day = etYmd(nowMs);
  const uRef = db.collection(QUOTA).doc(day + '__u__' + uid);
  const cRef = db.collection(QUOTA).doc(day + '__c__' + companyId);
  return db.runTransaction(async (tx) => {
    const [u, c] = [await tx.get(uRef), await tx.get(cRef)];
    const un = (u.exists && Number(u.data().n)) || 0;
    const cn = (c.exists && Number(c.data().n)) || 0;
    if (un >= L.USER_DAY_CAP) return 'user';
    if (cn >= L.COMPANY_DAY_CAP) return 'company';
    const expireAt = new Date(Number(nowMs) + QUOTA_TTL_MS);
    tx.set(uRef, { n: un + 1, uid, day, updatedAt: FieldValue.serverTimestamp(), expireAt }, { merge: true });
    tx.set(cRef, { n: cn + 1, companyId, day, updatedAt: FieldValue.serverTimestamp(), expireAt }, { merge: true });
    return '';
  });
}

function tenantOf(profile) {
  const p = profile || {};
  const b = p.brand || {};
  return {
    name: L.str(b.name || p.companyName || p.name || b.legalName, 120),
    region: L.str(p.serviceArea || [p.city, p.state].filter(Boolean).join(', '), 120),
  };
}

/**
 * P2 (2026-11-09): what the brief reads. A call alone: its own transcript and
 * segIndex. A merged primary (callCenterAction merge): its transcript, the
 * separator, then the redial's (call-merge-logic joinTranscripts), so the hash
 * changes and the stored brief is redrafted. The other call counts only while
 * both marks agree, it is in the same tenant and not filed on another
 * customer; otherwise the brief reads this call alone.
 */
async function briefInput(db, g) {
  const own = { transcript: String(g.call.transcript || ''), segIndex: g.call.segIndex || null, mergedFrom: null };
  const sid = g.call.mergedFrom;
  if (!sid || !MG.isCallId(sid)) return own;
  const ss = await db.collection(CALLS).doc(String(sid)).get().catch(() => null);
  const sec = ss && ss.exists ? Object.assign({}, ss.data(), { id: String(sid) }) : null;
  if (!sec || !MG.mergedTogether(g.call, sec)) return own;
  if (sec.userId !== g.call.userId || (sec.companyId || null) !== (g.call.companyId || null)) return own;
  if (sec.leadId && sec.leadId !== g.leadId) return own;
  if (sec.status === 'personal' || sec.callType === 'personal' || sec.callType === 'spam') return own;
  // Trimmed to the model's cap here, so a long first call never cuts the redial off silently.
  const fit = MG.fitJoin(own.transcript, String(sec.transcript || ''), L.TRANSCRIPT_MAX);
  return { transcript: MG.joinTranscripts(fit.a, fit.b), segIndex: MG.joinSegIndex(own.segIndex, sec.segIndex || null, fit.a, fit.b), mergedFrom: sec.id };
}

const answer = (doc, extra) => Object.assign({
  brief: doc.brief, generatedAtMs: doc.generatedAtMs, cached: true, decisions: Array.isArray(doc.decisions) ? doc.decisions : [],
}, extra || {});

async function briefCallable({ db, auth, data, nowMs, callModel, log = logger }) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (await switchedOff(true)) throw new HttpsError('failed-precondition', 'Call briefs are switched off right now.');
  const g = await gateFor(data)(db, auth, data);
  const input = await briefInput(db, g);
  const transcript = input.transcript;
  const hash = L.transcriptHash(transcript);
  const force = !!(data && data.refresh);
  const cs = await g.briefRef.get().catch(() => null);
  const cached = cs && cs.exists ? cs.data() : null;
  assertOwnVisitBrief(g, cached);
  const state = L.cacheState(cached, hash, nowMs, force);
  if (state === 'use') return answer(cached);
  if (state === 'refresh-too-soon') return answer(cached, { refreshRefused: true });

  const t = auth.token || {};
  if (!(t.role === 'admin' || t.email_verified === true)) throw new HttpsError('permission-denied', 'Call briefs need a verified email.');
  if (!(await aiAllowed(db, auth))) throw new HttpsError('permission-denied', 'Call briefs need a verified email and a paid plan.');
  const over = await takeQuota(db, auth.uid, g.companyId, nowMs);
  if (over === 'user') throw new HttpsError('resource-exhausted', 'You have drafted ' + L.USER_DAY_CAP + ' call briefs today, the daily limit. Try again tomorrow.');
  if (over === 'company') throw new HttpsError('resource-exhausted', 'Your company has drafted ' + L.COMPANY_DAY_CAP + ' call briefs today, the daily limit. Try again tomorrow.');

  const doc = await generate({ db, g, auth, nowMs, callModel, log, transcript, hash, cached, input });
  return answer(doc, { cached: false });
}

/**
 * Ask the model, ground the answer and store the brief (the one writer of
 * leads/{leadId}/call_briefs/{callId}). The caller has already run every gate
 * and taken the quota. opts.auto marks a brief the P1 auto-brief drafted.
 */
async function generate({ db, g, auth, nowMs, callModel, log = logger, transcript, hash, cached, auto, input }) {
  const ps = await db.doc('companyProfile/' + g.companyId).get().catch(() => null);
  const profile = ps && ps.exists ? ps.data() : {};
  const stages = L.tenantStages(profile.pipelines);
  const callYmd = g.call.startedAtMs ? etYmd(Number(g.call.startedAtMs)) : etYmd(nowMs);
  const req = L.buildRequest({ tenant: tenantOf(profile), stages, transcript, callYmd, direction: g.call.direction, source: g.kind === 'visit' ? 'visit' : undefined });
  let resp;
  try {
    resp = await (callModel || anthropicCall)(req);
  } catch (e) {
    log.warn('call_brief_ai_failed', { callId: g.callId, err: e && e.message });
    throw new HttpsError('unavailable', 'The brief did not come back. Try again in a minute.');
  }
  await AiSpend.recordAiSpend(AiSpend.rowFromAnthropic('call-brief', req.model, resp), { db, nowMs, log });
  const raw = L.parseResponse(resp);
  if (!raw) throw new HttpsError('unavailable', 'The brief did not come back. Try again in a minute.');
  // segIndex (P1): Whisper's per-segment confidence; hard-to-hear quotes are marked unsure.
  const segIndex = input ? input.segIndex : (g.call.segIndex || null);
  const brief = L.sanitizeBrief(raw, { transcript, stages, stageKeys: stages.map((s) => s.key), callYmd, segIndex });
  // P2 walkthrough: the notes' scope_facts never reach the model; the ones
  // whose words ground in the transcript feed the scope (prefill, proposal list).
  if (g.kind === 'visit') L.mergeVisitScope(brief, L.groundScopeFacts(((g.visit || {}).notes || {}).scopeFacts, transcript).facts);
  const doc = {
    callId: g.callId, leadId: g.leadId, companyId: g.companyId, userId: g.call.userId || null,
    v: L.BRIEF_VERSION, transcriptHash: hash, model: req.model, generatedAtMs: nowMs, generatedBy: auth.uid,
    brief, decisions: cached && Array.isArray(cached.decisions) ? cached.decisions : [],
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (auto) doc.auto = true;
  // The rules read a walkthrough brief through these (firestore.rules call_briefs).
  if (g.kind === 'visit') Object.assign(doc, { source: 'visit', visitId: g.visitId, visitUid: g.visitUid });
  if (input && input.mergedFrom) doc.mergedFrom = input.mergedFrom;
  await g.briefRef.set(doc);
  return doc;
}

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
function aiValueOf(brief, item) {
  const b = brief || {};
  if (item === 'summary') return (b.summary && b.summary.text) || '';
  if (item.startsWith('field:')) { const f = (b.fields || {})[item.slice(6)]; return f ? String(f.value || '') : null; }
  if (item.startsWith('promise:')) { const p = (b.promises || [])[Number(item.slice(8))]; return p ? p.kind + ' ' + (p.dueYmd || '') + ' ' + p.text : null; }
  if (item === 'followUp') return b.followUp ? b.followUp.value : null;
  if (item === 'stage') return b.stage ? b.stage.targetKey : null;
  return '';
}

async function decideCallable({ db, auth, data, nowMs, log = logger }) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (await switchedOff(false)) throw new HttpsError('failed-precondition', 'Call briefs are switched off right now.');
  const item = data && data.item;
  if (typeof item !== 'string' || !/^(summary|stage|followUp|handled|draft:(proposal|estimate|followupText|followupEmail)|field:[A-Za-z]{2,40}|promise:[0-4])$/.test(item)) {
    throw new HttpsError('invalid-argument', 'Decide one item at a time.');
  }
  const decision = data.decision === 'accept' ? 'accept' : data.decision === 'skip' ? 'skip' : '';
  if (!decision) throw new HttpsError('invalid-argument', 'Accept or Skip.');
  const fieldKey = item.startsWith('field:') ? item.slice(6) : '';
  if (fieldKey && !Object.prototype.hasOwnProperty.call(L.LEAD_FIELD, fieldKey)) throw new HttpsError('invalid-argument', 'That field cannot be filled from a call.');
  const g = await gateFor(data)(db, auth, data);
  // A walkthrough's promises were already filed as tasks when it was attached
  // (visit-capture.js buildAttachment), and there is no call to mark handled.
  if (g.kind === 'visit' && (item === 'handled' || item.startsWith('promise:'))) {
    throw new HttpsError('failed-precondition', 'Promises from a walkthrough are already tasks on this customer.');
  }
  const bs = await g.briefRef.get();
  if (!bs.exists) throw new HttpsError('failed-precondition', 'Draft the brief from this call first.');
  const stored = bs.data() || {};
  assertOwnVisitBrief(g, stored);
  const aiValue = aiValueOf(stored.brief, item);
  if ((fieldKey || item.startsWith('promise:') || item === 'stage' || item === 'followUp') && aiValue === null) {
    throw new HttpsError('failed-precondition', 'The brief did not suggest that.');
  }
  // P1 one-tap stage moves: the client moved the stage through the CRM's own
  // writer (progressStage / moveCard); this logs it, and refuses a log that
  // says a never-one-tap stage (Inspected, install_complete, an appointment,
  // Lost) went in one tap, or a stage a call may not suggest at all.
  let mode = '';
  let fromStage = '';
  if (item === 'stage' && decision === 'accept') {
    const st = (stored.brief && stored.brief.stage) || {};
    if (data.value != null && String(data.value) !== String(st.targetKey)) throw new HttpsError('invalid-argument', 'Only the stage the call suggested.');
    mode = data.mode === 'one-tap' || data.mode === 'confirmed' ? data.mode : '';
    if (!mode) throw new HttpsError('invalid-argument', 'Say how the stage was moved.');
    if (!L.stageOfferable(st.targetKey, st.role)) throw new HttpsError('failed-precondition', 'A call never moves a customer to a signed contract, a job or a won stage.');
    // fromStage: where the lead was before the writer moved it (the lead reads
    // the target by now). The client's value is advisory: the lead's own
    // stageHistory (the CRM writer appends { from, to }) outranks it, and a
    // one-tap log that knows neither is refused, since a move back cannot be
    // ruled out (review 2026-11-09).
    fromStage = L.stageMovedFrom(g.lead, st.targetKey) || L.str(data.fromStage, 40);
    let orders = [];
    if (mode === 'one-tap') {
      const ps = await db.doc('companyProfile/' + g.companyId).get().catch(() => null);
      orders = L.tenantStageOrders(ps && ps.exists ? (ps.data() || {}).pipelines : null);
    }
    if (mode === 'one-tap' && !L.stageOneTapAllowed(st.targetKey, st.role, fromStage, orders)) throw new HttpsError('failed-precondition', 'That stage is never moved in one tap. Confirm it first.');
    if (mode === 'one-tap' && !fromStage) throw new HttpsError('failed-precondition', 'Say which stage it moved from.');
  }

  let finalValue = decision === 'skip' ? '' : (data.value == null ? String(aiValue || '') : L.str(data.value, item === 'summary' ? 600 : 200));
  let written = false;
  if (decision === 'accept' && fieldKey) {
    const leadField = L.LEAD_FIELD[fieldKey];
    finalValue = L.str(finalValue, fieldKey === 'claimNumber' ? 40 : 120);
    if (!finalValue) throw new HttpsError('invalid-argument', 'Nothing to fill in.');
    // P1: digits from a hard-to-hear quote are never one-tap; the person types them.
    const fact = ((stored.brief || {}).fields || {})[fieldKey];
    if (fact && fact.retype === true && !(data.retyped === true && data.value != null && L.str(data.value, 200))) throw new HttpsError('failed-precondition', RETYPE_ACK);
    if (L.DATE_FIELDS.includes(fieldKey) && !L.isYmd(finalValue)) throw new HttpsError('invalid-argument', 'Use a date (YYYY-MM-DD).');
    if (fieldKey === 'jobType' && !['insurance', 'cash'].includes(finalValue)) throw new HttpsError('invalid-argument', 'Job type is insurance or cash.');
    const insurance = fieldKey === 'insCarrier' || fieldKey === 'claimNumber' || (fieldKey === 'jobType' && finalValue === 'insurance');
    if (insurance && data.confirmedInsurance !== true) throw new HttpsError('failed-precondition', INSURANCE_ACK);
    if (fieldKey === 'adjusterMeetingYmd' && data.confirmedCalendar !== true) throw new HttpsError('failed-precondition', CALENDAR_ACK);
    const leadRef = db.doc('leads/' + g.leadId);
    written = await db.runTransaction(async (tx) => {
      const s = await tx.get(leadRef);
      // Filled under any name the CRM reads it by (insuranceCarrier, carrier, …) counts as filled.
      if (s.exists && !isBlank(L.leadFieldValue(s.data(), fieldKey))) return false;
      tx.set(leadRef, { [leadField]: finalValue, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!written) throw new HttpsError('failed-precondition', 'That field is already filled in on the customer. Change it on the customer card if it is wrong.');
  } else if (decision === 'accept' && item === 'summary') {
    if (!finalValue) throw new HttpsError('invalid-argument', 'Nothing to add.');
    const actRef = db.doc('leads/' + g.leadId + '/activity/callbrief-' + g.callId);
    try {
      await actRef.create({
        type: 'note', source: 'call-brief', text: finalValue, summary: finalValue,
        ...(g.kind === 'visit' ? { visitId: g.visitId } : { phoneCallId: g.callId }),
        userId: g.lead.userId || g.call.userId || null, companyId: g.lead.companyId || g.call.companyId || null,
        createdBy: auth.uid, createdAt: FieldValue.serverTimestamp(),
      });
      written = true;
    } catch (e) {
      if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e.message)))) {
        throw new HttpsError('failed-precondition', 'The summary from this call is already on the timeline.');
      }
      throw e;
    }
  }

  // gen: the brief this was decided on. Items are keyed by index, so after a
  // regenerate (a new transcript, or a refresh) the sheet reads only the
  // decisions made on the brief it shows.
  const entry = { item, decision, aiValue: aiValue == null ? '' : L.str(aiValue, 600), finalValue: L.str(finalValue, 600), written, decidedBy: auth.uid, atMs: nowMs, gen: Number(stored.generatedAtMs) || 0 };
  // The callCenterAction slot (1-5) a brief promise went to, so the sheet
  // never offers that slot again (slot 0 is the card's own Promise button).
  const slot = Number(data.slot);
  if (item.startsWith('promise:') && decision === 'accept' && Number.isInteger(slot) && slot >= 1 && slot <= 5) entry.slot = slot;
  if (mode) { entry.mode = mode; if (fromStage) entry.fromStage = fromStage; }
  // The writer's Undo after a stage move: a skip that says so (the accept before it stays, append-only).
  if (item === 'stage' && decision === 'skip' && data.undone === true) entry.undone = true;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(g.briefRef);
    const prev = s.exists && Array.isArray((s.data() || {}).decisions) ? s.data().decisions : [];
    tx.set(g.briefRef, { decisions: prev.concat([entry]).slice(-MAX_DECISIONS), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  log.info('call_brief_decided', { callId: g.callId, item, decision, written });
  return { ok: true, written, item, decision };
}

/**
 * P1 auto-brief (design §3.1; Jo's Q2: briefs on tap, an auto-brief flag is
 * opt-in, default OFF). When a PERSON files a call (L.autoBriefTransition)
 * and the company has turned on companies/{companyId}/settings/callBrief
 * .autoBrief, the server drafts the brief the filer would get on tap. It runs
 * as the filer and through exactly callBrief's gates: both kill switches, the
 * filer's role (callCenterAction's test: never a viewer, never a sales rep who
 * does not own the call), the human-filed and tenant gates, the cache, a
 * verified email + paid plan, and the same per-user / per-company day caps.
 * It only stores the brief: nothing is accepted, written to the lead, sent or
 * moved. Returns { state, why? }; never throws (a trigger must not retry-loop).
 */
async function autoBriefHandler({ db, callId, before, after, nowMs, callModel, getUser, log = logger }) {
  if (!L.autoBriefTransition(before, after)) return { state: 'not-filed-now' };
  if (await switchedOff(true)) return { state: 'switched-off' };
  const companyId = String(after.companyId || after.userId || '');
  if (!companyId || companyId.includes('/')) return { state: 'flag-off' };
  const fs = await db.doc('companies/' + companyId + '/settings/callBrief').get().catch(() => null);
  if (!(fs && fs.exists && (fs.data() || {}).autoBrief === true)) return { state: 'flag-off' };
  const filer = L.filerOf(after);
  if (!filer) return { state: 'gated', why: 'no filer' };
  let user;
  try { user = await (getUser || ((uid) => require('firebase-admin/auth').getAuth().getUser(uid)))(filer); } catch (e) { return { state: 'gated', why: 'filer not found' }; }
  if (!user || user.disabled === true) return { state: 'gated', why: 'filer disabled' };
  const auth = { uid: filer, token: Object.assign({}, user.customClaims || {}, { email_verified: user.emailVerified === true }) };
  // The callables run assertNotGhost; so does this, on the filer's claims now.
  if (await require('./tenant-guard').isGhost(filer, auth.token, db)) return { state: 'gated', why: require('./tenant-guard').GHOST_MESSAGE };
  let g;
  try { g = await loadGated(db, auth, { callId }); } catch (e) { return { state: 'gated', why: (e && e.message) || 'gated' }; }
  const input = await briefInput(db, g);
  const transcript = input.transcript;
  const hash = L.transcriptHash(transcript);
  const cs = await g.briefRef.get().catch(() => null);
  const cached = cs && cs.exists ? cs.data() : null;
  if (L.cacheState(cached, hash, nowMs, false) === 'use') return { state: 'cached' };
  const t = auth.token;
  if (!(t.role === 'admin' || t.email_verified === true) || !(await aiAllowed(db, auth))) return { state: 'plan' };
  const over = await takeQuota(db, auth.uid, g.companyId, nowMs);
  if (over) return { state: 'quota', why: over };
  try {
    await generate({ db, g, auth, nowMs, callModel, log, transcript, hash, cached, auto: true, input });
  } catch (e) {
    log.warn('call_brief_auto_failed', { callId, err: e && e.message });
    return { state: 'failed' };
  }
  log.info('call_brief_auto', { callId, leadId: g.leadId, by: filer });
  return { state: 'briefed' };
}

exports.callBrief = onCall(
  { region: 'us-central1', enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY], memory: '512MiB', timeoutSeconds: 60, maxInstances: 10 },
  async (request) => {
    await require('./tenant-guard').assertNotGhost(request);
    return briefCallable({ db: getFirestore(), auth: request.auth, data: request.data, nowMs: Date.now() });
  }
);

exports.callBriefDecide = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30, maxInstances: 10 },
  async (request) => {
    await require('./tenant-guard').assertNotGhost(request);
    return decideCallable({ db: getFirestore(), auth: request.auth, data: request.data, nowMs: Date.now() });
  }
);

// P1 auto-brief: a phone_calls update that is a person filing the call.
// P2 (2026-11-09): a field compare first (filingChanged: did a filing field
// change at all?), then the pure transition check, so the many other call
// writes cost one function start and nothing else: no read, no Firestore
// client. 256MiB: the work is one model call (a fetch) and the grounding
// pass over a transcript of at most 60,000 characters.
exports.callBriefAuto = onDocumentUpdated(
  { document: 'phone_calls/{callId}', region: 'us-central1', secrets: [ANTHROPIC_API_KEY], memory: '256MiB', timeoutSeconds: 120, maxInstances: 5 },
  async (event) => {
    try {
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
      if (!L.filingChanged(before, after)) return;
      if (!L.autoBriefTransition(before, after)) return;
      await autoBriefHandler({ db: getFirestore(), callId: event.params.callId, before, after, nowMs: Date.now() });
    } catch (e) {
      logger.warn('call_brief_auto_error', { callId: event.params && event.params.callId, err: e && e.message });
    }
  }
);

exports._test = { briefCallable, decideCallable, autoBriefHandler, generate, takeQuota, loadGated, loadGatedVisit, briefInput, tenantOf, INSURANCE_ACK };
