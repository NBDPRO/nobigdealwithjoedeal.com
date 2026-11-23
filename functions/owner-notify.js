'use strict';
/**
 * owner-notify.js — the one "tell Joe" send for the internal watchers
 * (2026-11-22). Moved out of lead-alert-watchdog.js, unchanged, so
 * pipeline-deadman (via leadAlertWatchdog) and cron-deadman share it and a
 * later change of channel (audit step 13: one notify script) swaps one module.
 *
 * Bell entry (notifications) + push to the owner's devices. Internal only:
 * never a customer, never a text or email.
 */
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const LA = require('./lead-alert')._internal;

/**
 * opts: { type, clickUrl, idPrefix } — defaults are the call-pipeline values
 * leadAlertWatchdog has always sent. Resolves { pushed } (the bell row write
 * rejects; a push failure does not).
 */
async function notifyOwner(db, title, body, opts) {
  const o = opts || {};
  const type = o.type || 'call_watch';
  const clickUrl = o.clickUrl || '/pro/dashboard.html#/calls';
  await db.collection('notifications').add({
    userId: LA.NBD_OWNER_UID, type, title, message: body, priority: 'high',
    clickUrl, read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
  });
  // The bell row is written either way; the caller learns whether a device
  // got the push (no token, FCM down) so it can fail its own run.
  try {
    const r = await require('./push-functions').sendCustomNotification(LA.NBD_OWNER_UID, title, String(body).slice(0, 180), { type, clickUrl, notificationId: (o.idPrefix || 'pipeline-deadman-') + Date.now() });
    return { pushed: !!(r && r.sent > 0) };
  } catch (e) {
    logger.warn('[ownerNotify] push failed', { err: e && e.message });
    return { pushed: false };
  }
}

module.exports = { notifyOwner };
