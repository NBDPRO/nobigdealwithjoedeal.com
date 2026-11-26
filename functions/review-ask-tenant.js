'use strict';
/**
 * review-ask-tenant.js — the automatic Google review ask for OTHER companies
 * on the CRM: EMAIL ONLY, DARK (2026-11-26). The rules and words are in
 * review-ask-tenant-logic.js; the plan is
 * documentation/projects/REVIEW-ASK-MULTITENANT-GUARDRAIL-PLAN-2026-11-26.md.
 *
 *   setReviewAskProfile    (callable) a company's owner / company_admin asks
 *                          for its name, Google review link and Reply-To. A
 *                          REQUEST only: nothing it sends reaches an email
 *                          until a platform admin approves it.
 *   manageReviewAskTenant  (callable) platform admin only (role 'admin'):
 *                          approve, enable / disable, pause / unpause, ramp.
 *   reviewAskTenantSweep   (daily 11:00 ET) one ask per paid-in-full,
 *                          completed job of an enabled company, by email from
 *                          "<approved name>" <reviews@mail.nobigdealwithjoedeal.com>,
 *                          Reply-To the company, footer with ITS postal
 *                          address and unsubscribe.
 *
 * Off unless ALL of: REVIEW_ASK_TENANTS_ENABLED === 'true', the
 * messaging_controls/automations `reviewAskTenantEmail` flag, the global
 * customer + email switches, no canary, and per company review_ask_tenants
 * { enabled: true, not paused, a valid approved copy }. NBD is never handled
 * here (review-ask-auto.js is NBD's). No texts: texting for other companies
 * waits for their own Twilio subaccounts (plan §2).
 *
 * Every attempt writes review_ask_sends (server-only; the reason codes never
 * reach a company). Every admin or company change writes review_ask_audit.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('./integrations/heartbeat');
const { defineSecret } = require('firebase-functions/params');
const { logger: fnLogger } = require('firebase-functions/v2');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const T = require('./review-ask-tenant-logic');
const RA = require('./review-ask-auto-logic');
const PIF = require('./paid-in-full');
const Suppression = require('./email-suppression');
const MessagingControls = require('./messaging-controls');
const SendWindow = require('./send-window');
const { resendRejected, resendErrorMessage } = require('./resend-guard');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

const C = Object.freeze({
  tenants: 'review_ask_tenants',
  profiles: 'review_ask_profile',
  sends: 'review_ask_sends',
  audit: 'review_ask_audit',
  emailWindow: 'review_ask_emails',
  recipient: 'review_ask_recipient',
  counters: 'review_ask_counters',
  jobs: 'review_ask_jobs',          // the once-per-job claim, server-only (a company can edit its lead, never this)
});
const SOURCE = 'auto-email-company';
const TEMPLATE_SET = 'company-email-v1';
const NBD = () => RA.NBD_OWNER_UID;

const cleanCompanyId = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 128 && s.indexOf('/') === -1 ? s : '';
};

async function audit(db, row, FV) {
  await db.collection(C.audit).add(Object.assign({ at: (FV || FieldValue).serverTimestamp() }, row)).catch((e) => fnLogger.warn('review_ask_audit_failed', { err: e && e.message }));
}

/** The company-visible status: one word, never a reason code or a count. */
function publicStatus(t, profile) {
  const x = t || {};
  if (profile && profile.pending === true) return 'pending_approval';
  if (x.paused === true) return 'paused';
  if (x.enabled === true && x.approved) return 'on';
  return 'off';
}

// ── setReviewAskProfile ─────────────────────────────────────────────────

async function handleSetProfile(request, deps) {
  const d = deps || {};
  const db = d.db || getFirestore();
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  const requireTeamAdmin = d.requireTeamAdmin || require('./handlers/_shared').requireTeamAdmin;
  // Owner, solo owner or company_admin of the caller's OWN company (never a body companyId).
  const caller = await requireTeamAdmin(request);
  const companyId = cleanCompanyId(caller.companyId);
  if (!companyId) throw new HttpsError('failed-precondition', 'No company on this account.');
  if (companyId === NBD()) throw new HttpsError('failed-precondition', 'NBD uses its own review ask.');
  const data = (request && request.data) || {};
  const ref = db.collection(C.profiles).doc(companyId);

  if (data.action === 'get') {
    const [p, t] = await Promise.all([ref.get(), db.collection(C.tenants).doc(companyId).get()]);
    const prof = p.exists ? (p.data() || {}) : {};
    return { requested: prof.requested || null, status: publicStatus(t.exists ? t.data() : null, prof) };
  }
  if (data.action !== 'set') throw new HttpsError('invalid-argument', 'Unknown action');

  const v = T.validateProfileRequest(data);
  if (!v.ok) throw new HttpsError('invalid-argument', 'Not saved: ' + v.reason + (v.field ? ' (' + v.field + ')' : ''), { reason: v.reason });
  const day = T.periodKeys(nowMs).day;
  const before = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const prev = s.exists ? (s.data() || {}) : {};
    const ch = prev.changes && prev.changes.day === day ? prev.changes : { day, count: 0 };
    if (ch.count >= T.PROFILE_CHANGES_PER_DAY) throw new HttpsError('resource-exhausted', 'Too many changes today. Try again tomorrow.');
    tx.set(ref, {
      companyId,
      requested: Object.assign({}, v.value, { atMs: nowMs, byUid: caller.uid }),
      pending: true,
      changes: { day, count: ch.count + 1 },
    });
    return prev.requested || null;
  });
  await audit(db, { companyId, by: caller.uid, action: 'profile_request', before, after: v.value }, FV);
  return { ok: true, status: 'pending_approval' };
}

// ── manageReviewAskTenant (platform admin only) ─────────────────────────

const ACTIONS = ['get', 'approve', 'enable', 'disable', 'pause', 'unpause', 'setRamp'];

async function handleManage(request, deps) {
  const d = deps || {};
  const db = d.db || getFirestore();
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  const auth = request && request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  if (!auth.token || auth.token.role !== 'admin') throw new HttpsError('permission-denied', 'Platform admin only.');
  // A suspended admin's token outlives the suspension by up to an hour: the Auth record decides.
  await (d.assertCallerAccountEnabled || require('./handlers/_shared').assertCallerAccountEnabled)(auth.uid);
  const data = (request && request.data) || {};
  const companyId = cleanCompanyId(data.companyId);
  if (!companyId) throw new HttpsError('invalid-argument', 'companyId required');
  if (companyId === NBD()) throw new HttpsError('failed-precondition', 'NBD uses its own review ask.');
  if (!ACTIONS.includes(data.action)) throw new HttpsError('invalid-argument', 'Unknown action');
  const tRef = db.collection(C.tenants).doc(companyId);
  const pRef = db.collection(C.profiles).doc(companyId);
  const [tSnap, pSnap] = await Promise.all([tRef.get(), pRef.get()]);
  const t = tSnap.exists ? (tSnap.data() || {}) : {};
  const prof = pSnap.exists ? (pSnap.data() || {}) : {};
  const readAddress = async () => {
    const cp = await db.doc('companyProfile/' + companyId).get();
    const b = cp.exists ? ((cp.data() || {}).brand || {}) : {};
    return T.validatePostalAddress(b.contact && b.contact.mailingAddress);
  };
  if (data.action === 'get') {
    // What an approve would freeze, so the admin reviews exactly that (and passes it back as `expect`).
    const pa = await readAddress();
    return { tenant: t, profile: prof, wouldFreeze: { postalAddress: pa.ok ? pa.value : null, postalReason: pa.ok ? null : pa.reason } };
  }

  let patch;
  if (data.action === 'approve') {
    if (data.confirmPlace !== true) throw new HttpsError('failed-precondition', 'Check that the Google listing is this company\'s, then approve with confirmPlace: true.');
    const req = prof.requested;
    const r = T.validateProfileRequest(req ? { displayName: req.displayName, googleReviewUrl: req.googleReviewUrl, replyTo: req.replyTo } : null);
    if (!r.ok) throw new HttpsError('failed-precondition', 'The request is not valid: ' + r.reason);
    const pa = await readAddress();
    if (!pa.ok) throw new HttpsError('failed-precondition', 'The company\'s mailing address is missing or not an address: ' + pa.reason);
    // The admin approves what they reviewed, not whatever the company saved a second ago.
    const x = data.expect && typeof data.expect === 'object' ? data.expect : {};
    const same = x.displayName === r.value.displayName && x.googleReviewUrl === r.value.googleReviewUrl && x.replyTo === r.value.replyTo
      && x.postalAddress === pa.value && (Number(x.requestedAtMs) || 0) === (Number(req.atMs) || 0);
    if (!same) throw new HttpsError('failed-precondition', 'The request or the mailing address changed since you looked. Get it again and re-check.');
    patch = { approved: { displayName: r.value.displayName, reviewUrl: r.value.googleReviewUrl, replyTo: r.value.replyTo, postalAddress: pa.value, approvedAtMs: nowMs, approvedBy: auth.uid } };
  } else if (data.action === 'enable') {
    if (!T.validateApproved(t.approved).ok) throw new HttpsError('failed-precondition', 'Approve the company\'s profile first.');
    patch = { enabled: true };
  } else if (data.action === 'disable') {
    patch = { enabled: false };
  } else if (data.action === 'pause') {
    const reason = String(data.reason || '').replace(/[^\w .,:'-]/g, '').slice(0, 120) || 'admin';
    // Any pause puts the company back on ramp stage 1.
    patch = { paused: true, pausedReason: reason, pausedAtMs: nowMs, pausedBy: auth.uid, rampStage: 1 };
  } else if (data.action === 'unpause') {
    patch = { paused: false, pausedReason: null, pausedAtMs: null, pausedBy: null };
  } else {
    const stage = Number(data.stage);
    if (!T.RAMP[stage]) throw new HttpsError('invalid-argument', 'stage must be 1, 2 or 3');
    patch = { rampStage: stage, rampStartMs: nowMs };
  }
  await tRef.set(Object.assign({ companyId, updatedAtMs: nowMs, updatedBy: auth.uid }, patch), { merge: true });
  if (data.action === 'approve') await pRef.set({ pending: false, approvedAtMs: nowMs }, { merge: true });
  await audit(db, { companyId, by: auth.uid, action: data.action, before: t, after: patch }, FV);
  return { ok: true, status: publicStatus(Object.assign({}, t, patch), data.action === 'approve' ? { pending: false } : prof) };
}

// ── The sweep ───────────────────────────────────────────────────────────

async function logAttempt(db, row, FV) {
  await db.collection(C.sends).add(Object.assign({ triggeredBy: T.TRIGGERED_BY, templateSet: TEMPLATE_SET, channel: 'email', at: (FV || FieldValue).serverTimestamp() }, row))
    .catch((e) => fnLogger.warn('review_ask_tenant_log_failed', { err: e && e.message }));
}

/**
 * The one transaction that owns this ask: the job's once-ever claim on the
 * lead, the company's day / month counters, the per-company 180-day window and
 * the cross-company recipient cap. Everything the company controls was checked
 * before it. → { ok: true, prev } | { ok: false, reason }
 */
async function claimAsk(db, { companyId, entry, to, caps, nowMs }) {
  const h = T.emailHash(to);
  const tRef = db.collection(C.tenants).doc(companyId);
  const jobRef = db.collection(C.jobs).doc(companyId + '_' + entry.id + '_' + RA.jobKey(entry.jobId));
  const pk = T.periodKeys(nowMs);
  const leadRef = db.collection('leads').doc(entry.id);
  const coRef = db.collection(C.emailWindow).doc(companyId + '_' + h);
  const glRef = db.collection(C.recipient).doc(h);
  const dayRef = db.collection(C.counters).doc(companyId + '_d' + pk.day);
  const monRef = db.collection(C.counters).doc(companyId + '_m' + pk.month);
  return db.runTransaction(async (tx) => {
    const [ts, js, ls, cs, gs, ds, ms] = await Promise.all([tx.get(tRef), tx.get(jobRef), tx.get(leadRef), tx.get(coRef), tx.get(glRef), tx.get(dayRef), tx.get(monRef)]);
    // A pause / disable / unapproval landing mid-run holds from the next ask on.
    const tr = T.tenantReady(ts.exists ? ts.data() : null, companyId, RA.NBD_OWNER_UID);
    if (!tr.ok) return { ok: false, reason: 'tenant_' + tr.reason };
    if (js.exists) return { ok: false, reason: 'claimed' };
    if (!ls.exists) return { ok: false, reason: 'lead_gone' };
    const l = ls.data() || {};
    if (l.deleted === true || l.reviewRequested === true || RA.attempted(l, entry.jobId)) return { ok: false, reason: 'claimed' };
    const companyDoc = cs.exists ? cs.data() : null;
    const globalDoc = gs.exists ? gs.data() : null;
    const dayCount = ds.exists ? Number((ds.data() || {}).count) || 0 : 0;
    const monthCount = ms.exists ? Number((ms.data() || {}).count) || 0 : 0;
    const dec = T.claimDecision({ companyId, companyDoc, globalDoc, dayCount, monthCount, caps: tr.caps || caps, nowMs });
    if (!dec.ok) return dec;
    tx.update(leadRef, { reviewAutoAsk: { jobKey: RA.jobKey(entry.jobId), jobId: entry.jobId || null, channel: 'email', status: 'sending', claimedAtMs: nowMs } });
    tx.set(jobRef, { companyId, leadId: entry.id, jobKey: RA.jobKey(entry.jobId), status: 'sending', atMs: nowMs });
    tx.set(coRef, { companyId, lastAskMs: nowMs });
    tx.set(glRef, { asks: dec.asks });
    tx.set(dayRef, { companyId, count: dayCount + 1 });
    tx.set(monRef, { companyId, count: monthCount + 1 });
    return { ok: true, prev: { companyDoc, globalDoc, dayCount, monthCount }, refs: { leadRef, jobRef, coRef, glRef, dayRef, monRef } };
  });
}

/** Nothing went out: give everything back (the job's ask, the counts, the windows). */
async function releaseAsk(db, claim, FV) {
  const { prev, refs } = claim;
  await db.runTransaction(async (tx) => {
    tx.update(refs.leadRef, { reviewAutoAsk: (FV || FieldValue).delete() });
    tx.delete(refs.jobRef);
    if (prev.companyDoc) tx.set(refs.coRef, prev.companyDoc); else tx.delete(refs.coRef);
    if (prev.globalDoc) tx.set(refs.glRef, prev.globalDoc); else tx.delete(refs.glRef);
    tx.set(refs.dayRef, { count: prev.dayCount }, { merge: true });
    tx.set(refs.monRef, { count: prev.monthCount }, { merge: true });
  }).catch((e) => fnLogger.warn('review_ask_tenant_release_failed', { err: e && e.message }));
}

/** Stamp "tried" on the job without a reason a company could read. */
async function settle(db, entry, nowMs) {
  await db.collection('leads').doc(entry.id).update({ reviewAutoAsk: { jobKey: RA.jobKey(entry.jobId), jobId: entry.jobId || null, channel: 'email', status: 'done', atMs: nowMs } }).catch(() => {});
}

async function recordSent(db, companyId, entry, nowMs, FV) {
  const leadRef = db.collection('leads').doc(entry.id);
  await leadRef.update({
    reviewRequested: true, reviewRequestedAt: FV.serverTimestamp(), reviewRequestSource: SOURCE, reviewNudgedAt: FV.serverTimestamp(),
    reviewAutoAsk: { jobKey: RA.jobKey(entry.jobId), jobId: entry.jobId || null, channel: 'email', status: 'sent', sentAtMs: nowMs },
  }).catch((e) => fnLogger.warn('review_ask_tenant_mark_failed', { leadId: entry.id, err: e && e.message }));
  if (entry.jobId) {
    await leadRef.collection('jobs').doc(entry.jobId).update({ reviewRequestedAt: FV.serverTimestamp(), reviewNudgedAt: FV.serverTimestamp(), reviewRequestSource: SOURCE }).catch(() => {});
  }
  const uid = String(entry.userId || companyId);
  const said = 'Review ask emailed automatically';
  await db.collection('review_requests').add({ leadId: entry.id, userId: uid, method: 'email', source: SOURCE, jobId: entry.jobId || null, sentAt: FV.serverTimestamp(), status: 'sent' }).catch(() => {});
  await leadRef.collection('activity').add({ userId: uid, type: 'review_request_sent', label: said, message: said + ' (paid in full, job complete).', source: SOURCE, createdAt: FV.serverTimestamp() }).catch(() => {});
  const name = ((entry.firstName || '') + ' ' + (entry.lastName || '')).trim() || 'Customer';
  const note = { userId: uid, leadId: entry.id, type: 'review_request', title: '⭐ ' + said, message: said + ' to ' + name + '.', source: SOURCE, read: false, dismissed: false, createdAt: FV.serverTimestamp() };
  if (entry.jobId) note.jobId = entry.jobId;
  await db.collection('notifications').add(note).catch(() => {});
}

/**
 * One job's ask for one company. Never throws. Every input is re-read here:
 * the lead (and its SERVER createTime), the job, the invoices.
 * → { sent: boolean, reason }
 */
async function askOneTenant(db, companyId, ready, entry, deps) {
  const d = deps || {};
  const log = d.logger || fnLogger;
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  const base = { companyId, leadId: entry.id, jobId: entry.jobId || null };
  const skip = async (reason, extra) => { await logAttempt(db, Object.assign({}, base, { outcome: 'skipped', reason }, extra || {}), FV); return { sent: false, reason }; };
  try {
    const ls = await db.collection('leads').doc(entry.id).get();
    if (!ls.exists) return skip('lead_gone');
    const lead = Object.assign({ id: entry.id }, ls.data() || {});
    const leadCreateMs = T.ms(ls.createTime);
    let job = null;
    if (entry.jobId) {
      const js = await db.collection('leads').doc(entry.id).collection('jobs').doc(entry.jobId).get();
      job = js.exists ? (js.data() || {}) : null;
    }
    const useJob = !!(entry.jobId && job && lead.activeJobId && entry.jobId !== lead.activeJobId);
    const rec = useJob ? Object.assign({}, job, { companyId: lead.companyId, userId: lead.userId }) : lead;
    const invoices = await PIF.loadLeadInvoices(db, entry.id, rec, entry.jobId || null);
    if (!PIF.paidInFull(rec, invoices)) return skip('not_paid');
    const recvMs = RA.receivedMs(invoices);
    if (d.maxAgeDays != null && !MessagingControls.withinAutomationAge(recvMs, nowMs, d.maxAgeDays)) return skip('too_old');
    const el = T.eligibility({ companyId, lead, job, jobId: entry.jobId || null, leadCreateMs, recvMs, invoices, nowMs });
    if (!el.ok) {
      // A reason that will not change: stamp the job done (no reason on the lead) so the rep nudge takes it back.
      if (T.FINAL_REASONS.has(el.reason)) await settle(db, entry, nowMs);
      return skip(el.reason);
    }
    const win = typeof d.sendWindow === 'function' ? d.sendWindow(lead, nowMs) : SendWindow.check(nowMs, lead, d.companyProfile || null);
    if (!win.ok) return skip('outside_send_window');

    // Read-only unsubscribe check BEFORE any claim, on the exact address AND the
    // mailbox behind it (+tag / Gmail dots), so a retyped address never dodges an opt-out.
    try {
      for (const e of new Set([el.to, el.base].filter(Boolean))) {
        const hit = await Suppression.isSuppressed(db, companyId, e, { timeoutMs: Suppression.READ_TIMEOUT_MS });
        if (hit && hit.suppressed) { await settle(db, entry, nowMs); return skip('unsubscribed'); }
      }
    } catch (e) { return skip('suppression_unverified'); }

    const claim = await claimAsk(db, { companyId, entry, to: el.to, caps: ready.caps, nowMs });
    if (!claim.ok) return skip(claim.reason);

    // The gate mints this send's unsubscribe token: only after the claim, so a capped job writes nothing.
    let gate;
    try {
      gate = await Suppression.gateCommercialEmail(db, { companyId, email: el.to, leadId: entry.id, source: 'review-ask-tenant' },
        { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FV.serverTimestamp, postalAddress: ready.approved.postalAddress });
    } catch (e) { await releaseAsk(db, claim, FV); return skip('suppression_unverified'); }
    if (gate.suppressed) { await releaseAsk(db, claim, FV); await settle(db, entry, nowMs); return skip('unsubscribed'); }
    if (gate.blocked) { await releaseAsk(db, claim, FV); return skip('no_postal_address'); }

    const c = T.emailContent(lead, ready.approved);
    const body = Suppression.applyFooter(gate, c.html, c.text);
    const msg = {
      from: T.fromHeader(ready.approved), to: el.to, reply_to: ready.approved.replyTo, subject: c.subject, html: body.html, text: body.text,
      headers: Object.assign({ 'X-NBD-Campaign': 'review-ask-company-v1' }, gate.headers), tags: gate.tags,
    };
    const gated = await MessagingControls.guardEmail(db, msg).catch(() => ({ send: false, reason: 'controls_unreadable' }));
    if (!gated.send || gated.canary) { await releaseAsk(db, claim, FV); return skip(gated.canary ? 'canary' : 'messaging_paused'); }
    // One key per job: a retry Resend already took is not sent twice.
    const idempotencyKey = 'review-ask-tenant/' + companyId + '/' + entry.id + '/' + RA.jobKey(entry.jobId);
    let r;
    try { r = await d.resend.emails.send(gated.msg, { idempotencyKey }); }
    catch (e) {
      // Unknown whether it went: keep every claim (never a second email), stamp the job done.
      log.warn('review_ask_tenant_send_error', { companyId, leadId: entry.id, err: e && e.message });
      await settle(db, entry, nowMs);
      return skip('send_error_unknown');
    }
    if (resendRejected(r)) {
      const error = String(resendErrorMessage(r) || '').slice(0, 200);
      if (T.resendDefinite(r)) {
        // Resend refused the request: nothing went out, so give the ask back for a later run.
        await releaseAsk(db, claim, FV);
        return skip('send_rejected', { error });
      }
      // 429 / 5xx / the SDK's own network error: it may have gone. Keep every claim.
      await settle(db, entry, nowMs);
      return skip('send_error_unknown', { error });
    }
    await claim.refs.jobRef.set({ status: 'sent', sentAtMs: nowMs }, { merge: true }).catch(() => {});
    await recordSent(db, companyId, entry, nowMs, FV);
    await logAttempt(db, Object.assign({}, base, { outcome: 'sent', toHash: T.emailHash(el.to), from: T.FROM_ADDRESS, resendId: (r && r.data && r.data.id) || null }), FV);
    return { sent: true, reason: 'sent' };
  } catch (e) {
    log.warn('review_ask_tenant_skipped', { companyId, leadId: entry && entry.id, err: e && e.message });
    return skip('error');
  }
}

/** Everyone whose book belongs to this company: its members (companyId claim mirror on users/) and the solo owner (uid = companyId). */
async function companyUids(db, companyId) {
  const out = new Set([companyId]);
  const snap = await db.collection('users').where('companyId', '==', companyId).limit(500).get();
  for (const u of snap.docs) if (!(u.data() || {}).e2eTestAccount) out.add(u.id);
  return [...out];
}

/** The whole run. deps: { env, nowMs, resend, findDue, logger, FieldValue }. → { asked, counts } */
async function runTenantSweep(db, deps) {
  const d = Object.assign({}, deps || {});
  const env = d.env || process.env;
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  if (!T.flagOn(env)) return { asked: 0, counts: { flag_off: 1 } };
  const st = await MessagingControls.automationStatus(db, T.AUTOMATION_KEY, 'email', true);
  if (!st.enabled) return { asked: 0, counts: { ['automation_' + (st.reason || 'off')]: 1 } };
  if (st.canary) return { asked: 0, counts: { canary: 1 } };   // no claim, no ask: the asks are still owed after the canary
  if (!d.resend) return { asked: 0, counts: { no_sender: 1 } };
  const findDue = d.findDue || require('./review-request-nudge')._test.findReviewDueLeads;
  const runCap = st.maxPerRun;
  let asked = 0;
  const tSnap = await db.collection(C.tenants).where('enabled', '==', true).limit(500).get();
  const readyList = [];
  for (const tDoc of tSnap.docs) {
    const companyId = cleanCompanyId(tDoc.id);
    const ready = T.tenantReady(tDoc.data(), companyId, NBD());
    if (!ready.ok) { bump('tenant_' + ready.reason); continue; }
    readyList.push({ companyId, ready });
  }
  // Each company gets a fair share of the run's cap, so the first companies never starve the rest.
  const share = readyList.length ? Math.max(1, Math.floor(runCap / readyList.length)) : 0;
  for (const { companyId, ready } of readyList) {
    if (asked >= runCap) { bump('per_run_cap'); break; }
    let mine = 0;
    let profile = null;
    try { profile = await SendWindow.readCompanyZone(db, companyId); } catch (_) { profile = null; }
    const seen = new Set();
    let uids;
    try { uids = await companyUids(db, companyId); } catch (e) { bump('members_unreadable'); continue; }
    for (const uid of uids) {
      if (asked >= runCap || mine >= share) break;
      let due;
      try { due = await findDue(db, uid, { mode: 'auto', env, nowMs: d.nowMs }); } catch (e) { bump('find_error'); continue; }
      for (const entry of due || []) {
        if (asked >= runCap || mine >= share) { bump('per_run_cap'); break; }
        if (T.tenantOf(entry) !== companyId) continue;          // another company's lead on this rep's list: never
        const key = entry.id + '|' + (entry.jobId || '_lead');
        if (seen.has(key)) continue;
        seen.add(key);
        const r = await askOneTenant(db, companyId, ready, entry, Object.assign({}, d, { companyProfile: profile, maxAgeDays: MessagingControls.MAX_AUTOMATION_AGE_DAYS }));
        bump(r.reason);
        if (r.sent) { asked++; mine++; }
      }
    }
  }
  return { asked, counts };
}

/**
 * The companies whose automatic review ask would run now (flag + automation +
 * switches + each company ready). The rep nudge leaves their jobs to the sweep.
 * Fails closed to an empty set: the nudge then behaves exactly as before.
 */
async function tenantAutoSet(db, env) {
  const out = new Set();
  if (!T.flagOn(env || process.env)) return out;
  const st = await MessagingControls.automationStatus(db, T.AUTOMATION_KEY, 'email', true);
  if (!st.enabled || st.canary) return out;
  const snap = await db.collection(C.tenants).where('enabled', '==', true).limit(500).get();
  for (const d of snap.docs) {
    const id = cleanCompanyId(d.id);
    if (T.tenantReady(d.data(), id, NBD()).ok) out.add(id);
  }
  return out;
}
exports.tenantAutoSet = tenantAutoSet;

const CALL_OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' };

exports.setReviewAskProfile = onCall(CALL_OPTS, (req) => handleSetProfile(req));
exports.manageReviewAskTenant = onCall(CALL_OPTS, (req) => handleManage(req));

exports.reviewAskTenantSweep = onSchedule(
  { schedule: '0 11 * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 540, memory: '512MiB', secrets: [RESEND_API_KEY] },
  async () => {
    const db = getFirestore();
    if (process.env.REVIEW_ASK_TENANTS_ENABLED !== 'true') { fnLogger.info('review_ask_tenant_disabled', { reason: 'flag_off' }); return; }
    const { Resend } = require('resend');
    const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    const out = await runTenantSweep(db, { env: process.env, resend, logger: fnLogger });
    fnLogger.info('review_ask_tenant_complete', out);
  }
);

exports._test = { handleSetProfile, handleManage, runTenantSweep, askOneTenant, claimAsk, releaseAsk, publicStatus, C, SOURCE, TEMPLATE_SET };
