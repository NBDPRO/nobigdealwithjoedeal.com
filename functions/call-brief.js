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
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { secretValue } = require('./integrations/_shared');
const L = require('./call-brief-logic');
const AiSpend = require('./ai-spend');
const { ANTHROPIC_API_KEY, aiAllowed } = require('./lead-brief');

const CALLS = 'phone_calls';
const QUOTA = 'call_brief_quota';
const MAX_DECISIONS = 300;
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
    tx.set(uRef, { n: un + 1, uid, day, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(cRef, { n: cn + 1, companyId, day, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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

const answer = (doc, extra) => Object.assign({
  brief: doc.brief, generatedAtMs: doc.generatedAtMs, cached: true, decisions: Array.isArray(doc.decisions) ? doc.decisions : [],
}, extra || {});

async function briefCallable({ db, auth, data, nowMs, callModel, log = logger }) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (await switchedOff(true)) throw new HttpsError('failed-precondition', 'Call briefs are switched off right now.');
  const g = await loadGated(db, auth, data);
  const transcript = String(g.call.transcript || '');
  const hash = L.transcriptHash(transcript);
  const force = !!(data && data.refresh);
  const cs = await g.briefRef.get().catch(() => null);
  const cached = cs && cs.exists ? cs.data() : null;
  const state = L.cacheState(cached, hash, nowMs, force);
  if (state === 'use') return answer(cached);
  if (state === 'refresh-too-soon') return answer(cached, { refreshRefused: true });

  const t = auth.token || {};
  if (!(t.role === 'admin' || t.email_verified === true)) throw new HttpsError('permission-denied', 'Call briefs need a verified email.');
  if (!(await aiAllowed(db, auth))) throw new HttpsError('permission-denied', 'Call briefs need a verified email and a paid plan.');
  const over = await takeQuota(db, auth.uid, g.companyId, nowMs);
  if (over === 'user') throw new HttpsError('resource-exhausted', 'You have drafted ' + L.USER_DAY_CAP + ' call briefs today, the daily limit. Try again tomorrow.');
  if (over === 'company') throw new HttpsError('resource-exhausted', 'Your company has drafted ' + L.COMPANY_DAY_CAP + ' call briefs today, the daily limit. Try again tomorrow.');

  const ps = await db.doc('companyProfile/' + g.companyId).get().catch(() => null);
  const profile = ps && ps.exists ? ps.data() : {};
  const stages = L.tenantStages(profile.pipelines);
  const callYmd = g.call.startedAtMs ? etYmd(Number(g.call.startedAtMs)) : etYmd(nowMs);
  const req = L.buildRequest({ tenant: tenantOf(profile), stages, transcript, callYmd, direction: g.call.direction });
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
  const brief = L.sanitizeBrief(raw, { transcript, stages, stageKeys: stages.map((s) => s.key), callYmd, segIndex: g.call.segIndex || null });
  const doc = {
    callId: g.callId, leadId: g.leadId, companyId: g.companyId, userId: g.call.userId || null,
    v: L.BRIEF_VERSION, transcriptHash: hash, model: req.model, generatedAtMs: nowMs, generatedBy: auth.uid,
    brief, decisions: cached && Array.isArray(cached.decisions) ? cached.decisions : [],
    updatedAt: FieldValue.serverTimestamp(),
  };
  await g.briefRef.set(doc);
  return answer(doc, { cached: false });
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
  if (typeof item !== 'string' || !/^(summary|stage|followUp|handled|draft:proposal|draft:estimate|field:[A-Za-z]{2,40}|promise:[0-4])$/.test(item)) {
    throw new HttpsError('invalid-argument', 'Decide one item at a time.');
  }
  const decision = data.decision === 'accept' ? 'accept' : data.decision === 'skip' ? 'skip' : '';
  if (!decision) throw new HttpsError('invalid-argument', 'Accept or Skip.');
  const fieldKey = item.startsWith('field:') ? item.slice(6) : '';
  if (fieldKey && !Object.prototype.hasOwnProperty.call(L.LEAD_FIELD, fieldKey)) throw new HttpsError('invalid-argument', 'That field cannot be filled from a call.');
  const g = await loadGated(db, auth, data);
  const bs = await g.briefRef.get();
  if (!bs.exists) throw new HttpsError('failed-precondition', 'Draft the brief from this call first.');
  const stored = bs.data() || {};
  const aiValue = aiValueOf(stored.brief, item);
  if ((fieldKey || item.startsWith('promise:') || item === 'stage' || item === 'followUp') && aiValue === null) {
    throw new HttpsError('failed-precondition', 'The brief did not suggest that.');
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
        type: 'note', source: 'call-brief', text: finalValue, summary: finalValue, phoneCallId: g.callId,
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
  await db.runTransaction(async (tx) => {
    const s = await tx.get(g.briefRef);
    const prev = s.exists && Array.isArray((s.data() || {}).decisions) ? s.data().decisions : [];
    tx.set(g.briefRef, { decisions: prev.concat([entry]).slice(-MAX_DECISIONS), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  log.info('call_brief_decided', { callId: g.callId, item, decision, written });
  return { ok: true, written, item, decision };
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

exports._test = { briefCallable, decideCallable, takeQuota, loadGated, tenantOf, INSURANCE_ACK };
