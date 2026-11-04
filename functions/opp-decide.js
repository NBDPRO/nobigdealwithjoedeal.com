'use strict';
/**
 * opp-decide.js — the Thumbtack Opportunities approval screen's two callables (2026-11-04, flag
 * thumbtackOpportunities, ships dark): oppDraftList (read the cards) and oppDraftDecide (approve,
 * edit, skip, snooze ONE draft). opp_drafts and opp_seen are Admin-SDK only (firestore.rules deny
 * every client), so the owner's browser reads and decides through these two.
 *
 * NOTHING IS SENT. Approving only sets the draft's status to `approved`. There is no sender in this
 * series, nothing here reads Thumbtack or contacts anyone, and the reserved flag `thumbtackOppSend`
 * is not read by this file.
 *
 * Who: OWNER ONLY (opp-access.js ownerOf), App Check enforced, dark behind the flag and the
 * opp_rules/_default kill switch (a read error is `unavailable`: fail closed).
 *
 * oppDraftDecide  { oppId, action: 'approve'|'edit'|'skip'|'snooze', text?, reason? }
 *   approve  needs `text` = exactly what is on the card. It must pass the PR 3 finished-text gate (phone
 *            shapes, links, Kentucky wording, banned claims) whether or not Jo changed it. Then, in ONE
 *            transaction: the draft must be `pending`, the daily (8) and weekly (25) caps must have room,
 *            and the draft becomes `approved` with `approvedText` frozen and the counter bumped. A second
 *            approve of the same draft answers `already_approved` and changes and counts nothing.
 *            Approval is allowed at any hour; outside the send hours the draft is labelled "will send 8am".
 *   edit     saves Jo's text on a still-pending draft (same gate), without approving it.
 *   skip     needs `reason` from the closed list (wrong_trade, too_far, too_small, too_crowded).
 *   snooze   hides a pending draft for one hour.
 *   Only a `pending` draft can be edited, skipped or snoozed; approved is final in this series.
 *   Another company's draft, or a missing one, answers the same generic `not_found`.
 *
 * oppDraftList  {} -> { cards, caps, nowMs, inSendHours, sendLabel }: the company's pending and
 *   approved drafts joined to their opp_seen record (a whitelist: opp-decide-logic.js cardOf).
 *
 * Caps count APPROVALS in the Eastern day and the Monday-start week, in opp_caps/{companyId}
 * (Admin-only). A rules override can only lower a cap. The count never goes down.
 * Logs the action and outcome only: no text, no id.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
const Access = require('./opp-access');
const OL = require('./opp-shortlist-logic');
const X = require('./opp-decide-logic');

const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];
const CALLS_PER_HOUR = 240;
const LIST_LIMIT = 40;
const db = () => getFirestore();

const MESSAGES = Object.freeze({
  feature_off: Access.MESSAGES.feature_off,
  kill_switch: Access.MESSAGES.kill_switch,
  approved: 'Approved. It is marked approved and nothing was sent: there is no sender yet.',
  already_approved: 'That draft was already approved. Nothing changed and it was not counted twice.',
  edited: 'Your edit is saved. The draft is still waiting for your approval.',
  skipped: 'Skipped. It will not come back.',
  already_skipped: 'That draft was already skipped.',
  snoozed: 'Snoozed for one hour.',
  not_found: 'That draft was not found.',
  not_pending: 'That draft is no longer waiting for a decision.',
  expired: 'That draft has expired.',
  text_refused: 'That message cannot be approved.',
  cap_reached: 'A send cap is reached.',
});

const notAllowed = (code, message) => ({ ok: true, status: 'not_allowed', code, message: message || MESSAGES[code] || MESSAGES.text_refused });

async function rateLimit(name, c) {
  try {
    await enforceRateLimit('callable:' + name + ':uid', c.uid, CALLS_PER_HOUR, 60 * 60000);
  } catch (e) {
    if (e && e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many calls this hour. Try again later.');
    throw e;
  }
}

async function oppDraftDecide(request) {
  const c = Access.ownerOf(request);
  const data = request.data || {};
  const oppId = OL.safeOppId(data.oppId);
  if (!oppId) throw new HttpsError('invalid-argument', 'oppId is required.');
  const action = data.action;
  if (X.ACTIONS.indexOf(action) === -1) throw new HttpsError('invalid-argument', 'action must be one of: ' + X.ACTIONS.join(', ') + '.');
  let text = null, reason = null;
  if (action === 'approve' || action === 'edit') {
    if (typeof data.text !== 'string' || data.text.length > X.TEXT_INPUT_MAX) throw new HttpsError('invalid-argument', 'text is required (at most ' + X.TEXT_INPUT_MAX + ' characters).');
    text = data.text.trim();
  }
  if (action === 'skip') {
    if (typeof data.reason !== 'string' || !Object.prototype.hasOwnProperty.call(X.SKIP_REASONS, data.reason)) {
      throw new HttpsError('invalid-argument', 'reason must be one of: ' + Object.keys(X.SKIP_REASONS).join(', ') + '.');
    }
    reason = data.reason;
  }

  const g = await Access.gate(db(), c);
  if (!g.ok) {
    logger.info('[oppDraftDecide] skipped', { why: g.code });
    return notAllowed(g.code, g.message);
  }
  await rateLimit('oppDraftDecide', c);

  // The finished-text gate runs on EVERY text that could be approved or saved, edited or not.
  if (text !== null) {
    const bad = X.textProblem(text);
    if (bad) { logger.info('[oppDraftDecide] refused', { action, why: 'text_refused' }); return notAllowed('text_refused', bad); }
  }

  const docId = OL.docIdFor(c.company, oppId);
  if (!docId) throw new HttpsError('invalid-argument', 'oppId is required.');
  const now = Date.now();
  const tz = g.rules.hours.tz;
  const dref = db().doc('opp_drafts/' + docId);
  const cref = db().doc('opp_caps/' + c.company);

  let out;
  try {
    out = await db().runTransaction(async (tx) => {
      // Every read before any write (a Firestore transaction rule).
      const ds = await tx.get(dref);
      const cs = action === 'approve' ? await tx.get(cref) : null;
      if (!ds.exists) return notAllowed('not_found');
      const d = ds.data() || {};
      if (d.companyId !== c.company) return notAllowed('not_found');

      if (action === 'approve' && d.status === 'approved') return { ok: true, status: 'already_approved', code: 'already_approved', message: MESSAGES.already_approved };
      if (action === 'skip' && d.status === 'skipped') return { ok: true, status: 'already_skipped', code: 'already_skipped', message: MESSAGES.already_skipped };
      if (d.status !== 'pending') return notAllowed('not_pending');
      const exp = X.toMs(d.expireAt);
      if (exp !== null && exp <= now) return notAllowed('expired');

      if (action === 'snooze') {
        tx.update(dref, { snoozedUntil: new Date(now + X.SNOOZE_MS), snoozedAt: FieldValue.serverTimestamp() });
        return { ok: true, status: 'snoozed', code: 'snoozed', message: MESSAGES.snoozed, snoozedUntilMs: now + X.SNOOZE_MS };
      }
      if (action === 'skip') {
        tx.update(dref, { status: 'skipped', skipReason: reason, skippedAt: FieldValue.serverTimestamp(), skippedBy: c.uid, snoozedUntil: null });
        return { ok: true, status: 'skipped', code: 'skipped', message: MESSAGES.skipped };
      }
      const changed = text !== d.draftText;
      if (action === 'edit') {
        tx.update(dref, { editedText: changed ? text : null, editedByJo: changed, editedAt: FieldValue.serverTimestamp() });
        return { ok: true, status: 'edited', code: 'edited', message: MESSAGES.edited, text, editedByJo: changed };
      }

      // approve: the caps, then freeze the text.
      const counts = X.capCounts(cs && cs.exists ? (cs.data() || {}) : null, now, tz);
      const cap = OL.capStatus(counts, g.rules);
      if (!cap.allowed) return notAllowed('cap_reached', cap.reason + ' Nothing was approved.');
      const label = X.sendLabel(now, g.rules);
      tx.update(dref, {
        status: 'approved', approvedAt: FieldValue.serverTimestamp(), approvedBy: c.uid, approvedText: text,
        editedByJo: changed, editedText: changed ? text : null,
        approvedInSendHours: label.inWindow, sendLabel: label.label, snoozedUntil: null,
      });
      const next = X.bumpCaps(cs && cs.exists ? (cs.data() || {}) : null, now, tz);
      tx.set(cref, Object.assign({ companyId: c.company, updatedAt: FieldValue.serverTimestamp() }, next), { merge: true });
      return {
        ok: true, status: 'approved', code: 'approved', message: MESSAGES.approved, sendLabel: label.label, inSendHours: label.inWindow, editedByJo: changed,
        caps: { approvedToday: next.dayCount, perDay: g.rules.caps.sendsPerDay, approvedThisWeek: next.weekCount, perWeek: g.rules.caps.sendsPerWeek },
      };
    });
  } catch (e) {
    logger.warn('[oppDraftDecide] transaction failed', { action, msg: e && e.message });
    throw new HttpsError('unavailable', 'Could not save that just now. Nothing was changed; try again in a moment.');
  }
  logger.info('[oppDraftDecide] done', { action, outcome: out.status, code: out.code });
  return out;
}

async function oppDraftList(request) {
  const c = Access.ownerOf(request);
  const g = await Access.gate(db(), c);
  if (!g.ok) {
    logger.info('[oppDraftList] skipped', { why: g.code });
    return notAllowed(g.code, g.message);
  }
  await rateLimit('oppDraftList', c);
  const now = Date.now();
  const tz = g.rules.hours.tz;

  let pending, approved, caps;
  try {
    const q = (st) => db().collection('opp_drafts').where('companyId', '==', c.company).where('status', '==', st).limit(LIST_LIMIT).get();
    [pending, approved] = await Promise.all([q('pending'), q('approved')]);
    const cs = await db().doc('opp_caps/' + c.company).get();
    caps = cs.exists ? (cs.data() || {}) : null;
  } catch (e) {
    logger.warn('[oppDraftList] read failed', { msg: e && e.message });
    throw new HttpsError('unavailable', 'Could not read the drafts just now. Try again in a moment.');
  }
  const rows = [];
  for (const snap of pending.docs.concat(approved.docs)) {
    const d = snap.data() || {};
    if (d.companyId !== c.company) continue;
    const oppId = OL.safeOppId(d.oppId);
    const docId = oppId && OL.docIdFor(c.company, oppId);
    if (!docId) continue;
    const seen = await Access.readDocOrThrow(db(), 'opp_seen/' + docId);
    rows.push(X.cardOf(oppId, d, seen, now, g.rules));
  }
  const byScore = (a, b) => (b.score || 0) - (a.score || 0) || (a.ageNowMin == null ? 1e9 : a.ageNowMin) - (b.ageNowMin == null ? 1e9 : b.ageNowMin);
  const cards = rows.filter((r) => r.status === 'pending').sort(byScore)
    .concat(rows.filter((r) => r.status === 'approved').sort((a, b) => (b.approvedAtMs || 0) - (a.approvedAtMs || 0)));
  const counts = X.capCounts(caps, now, tz);
  const label = X.sendLabel(now, g.rules);
  logger.info('[oppDraftList] done', { n: cards.length });
  return {
    ok: true, status: 'done', nowMs: now, cards,
    caps: { approvedToday: counts.sentToday, perDay: g.rules.caps.sendsPerDay, approvedThisWeek: counts.sentThisWeek, perWeek: g.rules.caps.sendsPerWeek },
    inSendHours: label.inWindow, sendLabel: label.label,
  };
}

const OPTS = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' };
exports.oppDraftDecide = onCall(OPTS, require('./tenant-guard').wrapCallable(oppDraftDecide));
exports.oppDraftList = onCall(OPTS, require('./tenant-guard').wrapCallable(oppDraftList));
exports._internal = { oppDraftDecide, oppDraftList, MESSAGES };
