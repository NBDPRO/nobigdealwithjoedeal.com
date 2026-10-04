/**
 * estimate-view-alert.js — ONE "they opened it" alert for Jo (2026-10-03).
 *
 * Before this, only the deal room told Jo anything (deal-acceptance.js
 * notifyDealView). A homeowner opening the portal only stamped
 * lead.lastPortalOpenAt (portal.js), opening a remote-signing link only stamped
 * doc_sign_tokens/{t}.viewedAt (remote-signing.js), and opening a "Send for
 * review" PDF link only bumped report_share_tokens/{t}.viewCount — three
 * separate signals, two of them silent, none of them on the lead in one field.
 *
 *   recordEstimateView(db, { leadId, ownerUid, source, customerName, what,
 *                            title, body }, deps)
 *
 * Called fire-and-forget from every path a homeowner opens what Jo sent. In
 * ONE transaction on leads/{leadId}:
 *   - always stamps lastViewedAt + lastViewedVia (the follow-up rows read it:
 *     "Opened 3h ago");
 *   - claims the alert when the last one for this lead is 6h+ old
 *     (lastViewAlertAt) — a homeowner who opens the portal, then the PDF, then
 *     the deal room in one sitting is ONE alert, not three.
 * Then, only when claimed: one notifications/{auto} row type 'estimate_viewed'
 * for the lead's owner + a push through push-functions.sendCustomNotification.
 *
 * Internal only — nothing here reaches the homeowner. Never throws: every
 * caller is serving the homeowner a page and must not fail on this.
 *
 * NOT a Cloud Function and never an index.js export (index.js would deploy a
 * plain object). Callers require it.
 */
'use strict';

const THROTTLE_MS = 6 * 3600 * 1000;
const SOURCES = ['portal', 'review_link', 'deal_room', 'remote_sign'];

function _ms(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
}

/** True when this lead has had no view alert in the last 6 hours. */
function shouldAlert(lead, nowMs) {
  const last = _ms((lead || {}).lastViewAlertAt);
  return !last || (nowMs - last) >= THROTTLE_MS;
}

function leadName(lead) {
  const l = lead || {};
  const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
  return n || String(l.name || l.customerName || '').trim();
}

/** The bell + push text. Internal copy for Jo; never sent to a customer. */
function viewAlertMessage(name, source, what) {
  const who = String(name || '').trim() || 'Your customer';
  const thing = String(what || '').trim();
  if (source === 'remote_sign') {
    return { title: 'Opened to sign 👀', body: who + ' opened ' + (thing || 'the document') + ' to sign.' };
  }
  if (source === 'deal_room') {
    return { title: 'Proposal opened 👀', body: who + ' just opened their proposal.' };
  }
  if (source === 'review_link') {
    return { title: 'Estimate opened 👀', body: who + ' opened ' + (thing ? '"' + thing + '"' : 'the estimate you sent') + '.' };
  }
  return { title: 'Portal opened 👀', body: who + ' opened their project page.' };
}

function _deps(deps) {
  const d = deps || {};
  let FieldValue = d.FieldValue;
  if (!FieldValue) FieldValue = require('firebase-admin/firestore').FieldValue;
  let logger = d.logger;
  if (!logger) {
    try { logger = require('firebase-functions/v2').logger; } catch (_) { logger = console; }
  }
  return { FieldValue, logger, now: d.now || (() => Date.now()), push: d.push || null };
}

/**
 * @returns {Promise<{ stamped: boolean, alerted: boolean, reason?: string }>}
 */
async function recordEstimateView(db, args, deps) {
  const { FieldValue, logger, now, push } = _deps(deps);
  const a = args || {};
  const leadId = typeof a.leadId === 'string' ? a.leadId : '';
  const source = SOURCES.includes(a.source) ? a.source : 'portal';
  if (!db || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) return { stamped: false, alerted: false, reason: 'bad_lead_id' };
  const nowMs = now();
  try {
    const leadRef = db.collection('leads').doc(leadId);
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(leadRef);
      if (!snap.exists) return { stamped: false, reason: 'no_lead' };
      const lead = snap.data() || {};
      if (lead.deleted === true || lead.isDeleted === true) return { stamped: false, reason: 'deleted' };
      // A caller that names the owner (from its token) must agree with the
      // lead — a re-created lead id under another tenant is not alerted.
      if (a.ownerUid && lead.userId && a.ownerUid !== lead.userId) return { stamped: false, reason: 'owner_mismatch' };
      const patch = { lastViewedAt: FieldValue.serverTimestamp(), lastViewedVia: source };
      const alert = shouldAlert(lead, nowMs) && (a.alert !== false);
      if (alert) patch.lastViewAlertAt = FieldValue.serverTimestamp();
      tx.update(leadRef, patch);
      return { stamped: true, alert, lead };
    });
    if (!claim.stamped) return { stamped: false, alerted: false, reason: claim.reason };
    if (!claim.alert) return { stamped: true, alerted: false, reason: 'throttled' };

    const ownerUid = claim.lead.userId || a.ownerUid;
    if (!ownerUid) return { stamped: true, alerted: false, reason: 'no_owner' };
    const msg = (a.title && a.body) ? { title: String(a.title), body: String(a.body) }
      : viewAlertMessage(a.customerName || leadName(claim.lead), source, a.what);
    await db.collection('notifications').add({
      userId: ownerUid,
      type: 'estimate_viewed',
      leadId,
      source,
      title: msg.title,
      message: msg.body,
      priority: 'normal',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    try {
      const p = push || require('./push-functions');
      await p.sendCustomNotification(ownerUid, msg.title, msg.body, { type: 'estimate_viewed', leadId });
    } catch (e) { logger.warn('[estimateView] push failed', { leadId, msg: e && e.message }); }
    return { stamped: true, alerted: true };
  } catch (e) {
    logger.warn('[estimateView] record failed', { leadId, source, err: e && e.message });
    return { stamped: false, alerted: false, reason: 'error' };
  }
}

module.exports = { THROTTLE_MS, SOURCES, shouldAlert, viewAlertMessage, leadName, recordEstimateView };
