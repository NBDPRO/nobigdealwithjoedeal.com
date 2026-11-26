/**
 * storm-tips-email.js — the storm-season tips email (2026-11-26). DARK.
 * ═══════════════════════════════════════════════════════════════
 *
 * Who gets it: homeowners who ticked "Also email me storm-season tips from Joe
 * now and then" on a guide page (guide_copy_requests.emailConsent === true,
 * wording version 'guide-storm-tips-2026-11-26'). Rules and copy live in
 * storm-tips-logic.js; this file only reads, gates and sends.
 *
 *   stormTipsAdmin (onCall, App Check, NBD owner only) — the /pro/storm-tips screen
 *     list                       → subscribers, issues, settings, recent storms, gates
 *     preview { issueId }        → { subject, html } (no footer; nothing sent)
 *     send { issueId, target: 'all' | 'storm' | 'keys', stormKey?, keys? }
 *                                → Joe pressing send. First contact is ALWAYS
 *                                  'first-hello'; at most MAX_PER_SEND people.
 *     setSettings { intervalDays }            (never under 14)
 *     setSubscriber { key, scheduleOn?, stopped? }
 *
 *   stormTipsSweep (daily 11:00 ET) — the optional schedule. Sends the next
 *     in-season issue to subscribers Joe put on the schedule, no more often
 *     than his interval (floor 14 days). Needs messaging_controls/automations
 *     stormTipsEmail === true as well as the flag below.
 *
 * DARK BY DEFAULT. Nothing sends unless ALL of these are true:
 *   - env STORM_TIPS_EMAIL_ENABLED === 'true' (both manual and scheduled);
 *   - MessagingControls: customer sends + email channel on (guardResend at the
 *     moment of sending; canary redirects to Joe and is NOT counted as sent);
 *   - for the sweep only: automations.stormTipsEmail === true.
 *
 * COMMERCIAL email: every send goes through email-suppression.js
 * gateCommercialEmail (an unsubscribed address is skipped and marked; the
 * footer carries the unsubscribe link + postal address; List-Unsubscribe +
 * one-click headers; no postal address = nothing sent at all). Registered in
 * SEND_PATHS as 'commercial'.
 *
 * ONE SEND PER PERSON PER 14 DAYS: the per-subscriber state doc
 * storm_tips_state/{sha256(email)[:40]} is claimed in a transaction BEFORE the
 * send (lastSentAtMs + sending), so two presses, or a press and the sweep,
 * cannot both mail one person. A send that definitely did not go (paused,
 * canary, suppressed, Resend refused) releases the claim; an unknown outcome
 * (network error) keeps it, so a doubt never becomes a second email.
 */
'use strict';

const crypto = require('crypto');
const T = require('./storm-tips-logic');
const SendWindow = require('./send-window');

const STATE = 'storm_tips_state';
const SETTINGS_DOC = 'storm_tips_settings/global';
const LOG = 'storm_tips_sends';
const AUTOMATION_KEY = 'stormTipsEmail';
const ENV_FLAG = 'STORM_TIPS_EMAIL_ENABLED';
const STORM_LOOKBACK_DAYS = 14;

function stateId(email) {
  return crypto.createHash('sha256').update(T.normEmail(email)).digest('hex').slice(0, 40);
}

function envOn(env) { return env ? env[ENV_FLAG] === 'true' : process.env.STORM_TIPS_EMAIL_ENABLED === 'true'; }

async function readSettings(db) {
  const s = await db.doc(SETTINGS_DOC).get();
  const d = s && s.exists ? (s.data() || {}) : {};
  return { intervalDays: T.cleanInterval(d.intervalDays) };
}

/** Every consenting subscriber, with their state doc. */
async function loadSubscribers(db) {
  const snap = await db.collection('guide_copy_requests').where('emailConsent', '==', true).get();
  const subs = T.subscribersFrom(snap.docs.map((d) => ({ id: d.id, data: d.data() || {} })));
  const out = [];
  for (const s of subs) {
    const id = stateId(s.email);
    const st = await db.collection(STATE).doc(id).get();
    out.push(Object.assign({}, s, { id, state: st.exists ? (st.data() || {}) : {} }));
  }
  return out;
}

/**
 * Claim the person's one send for this issue. Re-checks the verdict on the
 * FRESH state inside the transaction. → true when this caller owns the send.
 */
async function claim(db, sub, issueId, mode, nowMs, intervalDays) {
  const ref = db.collection(STATE).doc(sub.id);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const st = s.exists ? (s.data() || {}) : {};
    if (st.sending && st.sending.atMs && nowMs - st.sending.atMs < T.DAY_MS) return false;
    const v = mode === 'schedule'
      ? T.scheduledVerdict(st, nowMs, intervalDays)
      : T.manualVerdict(st, issueId, nowMs);
    if (!v.ok || (mode === 'schedule' && v.issue.id !== issueId)) return false;
    tx.set(ref, {
      emailMasked: T.maskEmail(sub.email),
      prevLastSentAtMs: T.toMs(st.lastSentAtMs) || null,
      lastSentAtMs: nowMs,
      sending: { issueId, atMs: nowMs, mode },
    }, { merge: true });
    return true;
  });
}

/** The send definitely did not go: put lastSentAtMs back. */
async function release(db, sub, extra) {
  const ref = db.collection(STATE).doc(sub.id);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const st = s.exists ? (s.data() || {}) : {};
    tx.set(ref, Object.assign({ lastSentAtMs: st.prevLastSentAtMs || null, sending: null }, extra || {}), { merge: true });
  }).catch(() => {});
}

/**
 * One person, one issue. Never throws.
 * deps: { db, resend, nowMs, Suppression, MC, FieldValue, logger, companyId, by }
 * → { sent, reason, stop? } — stop: true means the rest of the run must halt
 *   (messaging paused, no postal address).
 */
async function sendOne(deps, sub, issueId, mode, intervalDays) {
  const { db, resend, nowMs, Suppression, MC, FieldValue, logger } = deps;
  let owned = false;
  try { owned = await claim(db, sub, issueId, mode, nowMs, intervalDays); }
  catch (e) { logger.warn('stormTips: claim failed', { id: sub.id, err: e && e.message }); return { sent: false, reason: 'claim_failed' }; }
  if (!owned) return { sent: false, reason: 'not_due' };

  let gate;
  try {
    gate = await Suppression.gateCommercialEmail(db, { companyId: deps.companyId, email: sub.email, source: T.SOURCE });
  } catch (e) {
    await release(db, sub);
    return { sent: false, reason: 'suppression_unreadable', stop: true };
  }
  if (gate.suppressed) {
    await release(db, sub, { unsubscribed: true, scheduleOn: false });
    return { sent: false, reason: 'unsubscribed' };
  }
  if (gate.blocked) {
    await release(db, sub);
    return { sent: false, reason: gate.reason || 'blocked', stop: true };
  }

  const r = T.renderIssue(issueId);
  const body = Suppression.applyFooter(gate, r.html, r.text);
  const msg = {
    from: T.FROM, to: sub.email, reply_to: T.REPLY_TO, subject: r.subject,
    html: body.html, text: body.text, headers: gate.headers, tags: gate.tags,
  };

  // The kill switch + canary run at the moment of sending (guardResend): a
  // paused send resolves { error: { name: 'messaging_paused' } }, a canary
  // redirect to Joe resolves with canary: true.
  let resp;
  try {
    // Email category: COMMERCIAL — storm tips the homeowner opted into on a guide page; gated above (email-suppression.js SEND_PATHS).
    resp = await MC.guardResend(db, resend).emails.send(msg);
  } catch (e) {
    // Unknown outcome: keep the claim, so a doubt never becomes a second email.
    logger.error('stormTips: send threw', { id: sub.id, err: e && e.message });
    await db.collection(STATE).doc(sub.id).set({ sending: null, lastError: String((e && e.message) || 'send failed').slice(0, 200) }, { merge: true }).catch(() => {});
    return { sent: false, reason: 'send_error' };
  }
  if (resp && resp.error && resp.error.name === 'messaging_paused') {
    await release(db, sub);
    return { sent: false, reason: String(resp.error.message || '').replace(/^messaging_paused:/, '') || 'messaging_paused', stop: true };
  }
  if (!resp || resp.error) {
    await release(db, sub, { lastError: String((resp && resp.error && resp.error.message) || 'rejected').slice(0, 200) });
    return { sent: false, reason: 'rejected' };
  }
  if (resp.canary) {
    // Went to Joe, not the homeowner: not a send to this person.
    await release(db, sub);
    return { sent: false, reason: 'canary' };
  }
  const id = (resp.data && resp.data.id) || resp.id || null;
  await db.collection(STATE).doc(sub.id).set({
    sending: null, lastError: null, lastIssueId: issueId,
    issuesSent: FieldValue.arrayUnion(issueId), sendCount: FieldValue.increment(1),
  }, { merge: true }).catch((e) => logger.warn('stormTips: mark failed', { id: sub.id, err: e && e.message }));
  await db.collection(LOG).add({ stateId: sub.id, issueId, mode, by: deps.by || null, resendId: id, atMs: nowMs }).catch(() => {});
  return { sent: true, reason: null };
}

/** Run a list of { sub, issueId } in order; stop the run on a stop reason. */
async function runSends(deps, jobs, mode, intervalDays) {
  const tally = { sent: 0, skipped: {}, stoppedBy: null };
  for (const j of jobs) {
    const r = await sendOne(deps, j.sub, j.issueId, mode, intervalDays);
    if (r.sent) tally.sent++;
    else tally.skipped[r.reason] = (tally.skipped[r.reason] || 0) + 1;
    if (r.stop) { tally.stoppedBy = r.reason; break; }
  }
  return tally;
}

/**
 * Joe pressed send. → { ok, chosen, sent, skipped, stoppedBy, reason? }
 * target: 'all' (everyone the verdict allows), 'storm' (only ZIPs within
 * STORM_RADIUS_MI of storm_events/{stormKey}), 'keys' (the listed state ids).
 */
async function manualSend(deps, req) {
  const p = req || {};
  if (!envOn(deps.env)) return { ok: false, reason: 'env_flag_off' };
  if (!T.issueById(p.issueId)) return { ok: false, reason: 'unknown_issue' };
  const settings = await readSettings(deps.db);
  let subs = await loadSubscribers(deps.db);
  if (p.target === 'storm') {
    if (typeof p.stormKey !== 'string' || !p.stormKey) return { ok: false, reason: 'no_storm' };
    const ev = await deps.db.collection('storm_events').doc(p.stormKey).get();
    if (!ev.exists) return { ok: false, reason: 'no_storm' };
    const e = ev.data() || {};
    subs = subs.filter((s) => T.nearStorm(s, e, deps.zipCoords));
  } else if (p.target === 'keys') {
    const want = new Set(Array.isArray(p.keys) ? p.keys.filter((k) => typeof k === 'string') : []);
    subs = subs.filter((s) => want.has(s.id));
  } else if (p.target !== 'all') {
    return { ok: false, reason: 'bad_target' };
  }
  const due = subs.filter((s) => s.state.unsubscribed !== true && T.manualVerdict(s.state, p.issueId, deps.nowMs).ok)
    .slice(0, T.MAX_PER_SEND);
  const tally = await runSends(deps, due.map((sub) => ({ sub, issueId: p.issueId })), 'manual', settings.intervalDays);
  return Object.assign({ ok: true, chosen: due.length }, tally);
}

/** The daily schedule. → { ran, reason?, sent, skipped, stoppedBy } */
async function scheduledSweep(deps) {
  const auto = await deps.MC.automationStatus(deps.db, AUTOMATION_KEY, 'email', envOn(deps.env));
  if (!auto.enabled) return { ran: false, reason: auto.reason };
  const settings = await readSettings(deps.db);
  const cap = Math.min(T.MAX_PER_SWEEP, Number.isInteger(auto.maxPerRun) ? auto.maxPerRun : 0);
  const subs = await loadSubscribers(deps.db);
  const jobs = [];
  for (const s of subs) {
    if (jobs.length >= cap) break;
    if (s.state.unsubscribed === true) continue;
    // Customer send window (8:00-20:00 their time: the ZIP's zone, else Eastern).
    // Outside it the person simply waits for a later run.
    if (!SendWindow.check(deps.nowMs, s.zip ? { zip: s.zip } : {}, null).ok) continue;
    const v = T.scheduledVerdict(s.state, deps.nowMs, settings.intervalDays);
    if (v.ok) jobs.push({ sub: s, issueId: v.issue.id });
  }
  const tally = await runSends(deps, jobs, 'schedule', settings.intervalDays);
  return Object.assign({ ran: true, chosen: jobs.length }, tally);
}

/** What the /pro/storm-tips screen shows. */
async function listView(deps) {
  const settings = await readSettings(deps.db);
  const subs = await loadSubscribers(deps.db);
  const since = deps.nowMs - STORM_LOOKBACK_DAYS * T.DAY_MS;
  let storms = [];
  try {
    const snap = await deps.db.collection('storm_events').orderBy('processedAt', 'desc').limit(25).get();
    storms = snap.docs.map((d) => Object.assign({ key: d.id }, d.data() || {}))
      .filter((e) => T.toMs(e.processedAt) >= since)
      .map((e) => ({
        key: e.key, kind: e.kind || '', mag: e.mag == null ? null : e.mag, city: e.city || '', st: e.st || '',
        atMs: T.toMs(e.processedAt),
        near: subs.filter((s) => T.nearStorm(s, e, deps.zipCoords)).length,
      }));
  } catch (_) { storms = []; }
  const auto = await deps.MC.automationStatus(deps.db, AUTOMATION_KEY, 'email', envOn(deps.env));
  const channel = await deps.MC.channelStatus(deps.db, 'email');
  return {
    settings,
    gates: { envOn: envOn(deps.env), emailAllowed: !!channel.allowed, canary: !!channel.canary, schedule: auto.enabled, scheduleReason: auto.reason },
    issues: T.ISSUES.map((i) => ({ id: i.id, subject: i.subject, months: i.months })),
    storms,
    subscribers: subs.map((s) => ({
      key: s.id, email: s.email, zip: s.zip, consentAtMs: s.consentAtMs,
      issuesSent: T.sentIds(s.state), lastSentAtMs: T.toMs(s.state.lastSentAtMs) || null,
      scheduleOn: s.state.scheduleOn === true, stopped: s.state.stopped === true, unsubscribed: s.state.unsubscribed === true,
      nextScheduled: (T.scheduledVerdict(s.state, deps.nowMs, settings.intervalDays).issue || {}).id || null,
    })),
  };
}

async function setSettings(deps, p) {
  const intervalDays = T.cleanInterval(p && p.intervalDays);
  await deps.db.doc(SETTINGS_DOC).set({ intervalDays, updatedAtMs: deps.nowMs, updatedBy: deps.by || null }, { merge: true });
  return { ok: true, intervalDays };
}

async function setSubscriber(deps, p) {
  const q = p || {};
  if (typeof q.key !== 'string' || !/^[0-9a-f]{40}$/.test(q.key)) return { ok: false, reason: 'bad_key' };
  const subs = await loadSubscribers(deps.db);
  if (!subs.some((s) => s.id === q.key)) return { ok: false, reason: 'not_a_subscriber' };
  const patch = {};
  if (typeof q.scheduleOn === 'boolean') patch.scheduleOn = q.scheduleOn;
  if (typeof q.stopped === 'boolean') patch.stopped = q.stopped;
  if (!Object.keys(patch).length) return { ok: false, reason: 'nothing_to_change' };
  if (patch.stopped === true) patch.scheduleOn = false;
  await deps.db.collection(STATE).doc(q.key).set(Object.assign(patch, { updatedAtMs: deps.nowMs }), { merge: true });
  return { ok: true };
}

Object.assign(module.exports, {
  STATE, SETTINGS_DOC, LOG, AUTOMATION_KEY, ENV_FLAG,
  stateId, envOn, readSettings, loadSubscribers, claim, release, sendOne, runSends,
  manualSend, scheduledSweep, listView, setSettings, setSubscriber,
});

// ── Cloud Functions wiring (tests stub these modules at the loader) ──
// Top-level `exports.X = onCall(` / `onSchedule(` at column 0: the deploy
// workflow builds its --only list by grepping for exactly that shape.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('./integrations/heartbeat');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');
const Suppression = require('./email-suppression');
const MessagingControls = require('./messaging-controls');
const TextingGate = require('./sms-texting-gate');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

const zipCoords = (z) => require('./storm-watch')._test.zipCoords(z);

const depsFor = (by) => ({
  db: getFirestore(), nowMs: Date.now(), Suppression, MC: MessagingControls, FieldValue, logger,
  companyId: TextingGate.NBD_OWNER_UID, by, zipCoords, env: process.env,
  get resend() { return new Resend(RESEND_API_KEY.value()); },
});

exports.stormTipsAdmin = onCall(
  { region: 'us-central1', enforceAppCheck: true, secrets: [RESEND_API_KEY], timeoutSeconds: 300, memory: '256MiB', maxInstances: 2 },
  async (request) => {
    const auth = request.auth;
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
    if (auth.uid !== TextingGate.NBD_OWNER_UID) throw new HttpsError('permission-denied', 'Owner only');
    const p = request.data || {};
    const deps = depsFor(auth.uid);
    switch (p.action) {
      case 'list': return listView(deps);
      case 'preview': {
        if (!T.issueById(p.issueId)) throw new HttpsError('invalid-argument', 'Unknown issue');
        const r = T.renderIssue(p.issueId);
        return { subject: r.subject, html: r.html };
      }
      case 'send': {
        const resend = deps.resend;
        const out = await manualSend(Object.assign({}, deps, { resend }), p);
        logger.info('stormTipsAdmin: send', { issueId: p.issueId, target: p.target, out });
        return out;
      }
      case 'setSettings': return setSettings(deps, p);
      case 'setSubscriber': return setSubscriber(deps, p);
      default: throw new HttpsError('invalid-argument', 'Unknown action');
    }
  }
);

exports.stormTipsSweep = onSchedule(
  { schedule: '0 11 * * *', timeZone: 'America/New_York', region: 'us-central1', maxInstances: 1, secrets: [RESEND_API_KEY], timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const deps = depsFor('schedule');
    const out = await scheduledSweep(Object.assign({}, deps, { resend: deps.resend }));
    logger.info('stormTipsSweep', out);
  }
);
