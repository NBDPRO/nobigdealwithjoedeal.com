/**
 * Firebase Cloud Functions — Push Notification System
 * =====================================================
 * Sends push notifications via FCM for various events:
 * - New leads assigned
 * - Appointment reminders (15-min before)
 * - Follow-up due reminders (daily)
 * - Claim stage changes
 *
 * SETUP:
 *   1. In functions/index.js, import and spread this:
 *      const pushFunctions = require('./push-functions');
 *      module.exports = { ...pushFunctions, ...otherFunctions };
 *
 * FIRESTORE SCHEMA EXPECTATIONS:
 *   - users/{uid}/notificationPrefs { newLead, appointmentReminder, followUpDue, claimUpdate, teamActivity, d2dStreak }
 *   - users/{uid}/fcmTokens/{tokenHash} { token, device, createdAt, lastActive }
 *   - leads/{leadId} { assignedTo, claim_stage, createdAt, ... }
 *   - knocks/{knockId} { userId, repId, companyId, address, homeowner,
 *                        disposition, followUpDate, ... }   ← top-level
 *   - appointments/{apptId} { startTime, repUid|userId, status, ... } ← top-level
 *
 * CORRECTED 2026-09-05. This block used to claim two nested shapes that
 * nothing has ever written: `leads.d2dKnocks[]` and
 * `leads/{leadId}/appointments/{apptId}`. Both onFollowUpDue and
 * onAppointmentReminder were coded straight from these lines and so queried
 * data that does not exist — each sent ZERO notifications until repaired
 * (appointments earlier, follow-ups on 2026-09-05). Knocks are written by
 * docs/pro/js/d2d-tracker-core-2026b.js via addDoc(collection(db,'knocks'));
 * appointments by the cal.com webhook in integrations/calcom.js. If you add a
 * reader here, verify the shape against a writer before trusting this block.
 */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { FieldValue } = require('firebase-admin/firestore');

const db = getFirestore();
const messaging = getMessaging();

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Check if user has enabled this notification category
 */
async function isNotificationEnabled(uid, category) {
  try {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) return true; // Default to enabled
    
    const prefs = userDoc.data().notificationPrefs || {};
    return prefs[category] !== false;
  } catch (err) {
    logger.error('[Push] Error checking notification preference:', err);
    return true; // Default to enabled on error
  }
}

/**
 * Get all FCM tokens for a user from Firestore
 */
async function getUserFCMTokens(uid) {
  try {
    const tokensRef = db.collection('users').doc(uid).collection('fcmTokens');
    const tokensSnap = await tokensRef.get();
    
    const tokens = [];
    const invalidTokens = [];
    
    tokensSnap.forEach(doc => {
      const tokenData = doc.data();
      if (tokenData.token) {
        tokens.push({
          token: tokenData.token,
          docId: doc.id,
          lastActive: tokenData.lastActive
        });
      }
    });
    
    return { tokens, invalidTokens };
  } catch (err) {
    logger.error('[Push] Error getting FCM tokens:', err);
    return { tokens: [], invalidTokens: [] };
  }
}

/**
 * Action buttons offered on a push, by notification type.
 *
 * MUST stay identical to getNotificationActions() in
 * docs/pro/firebase-messaging-sw.js. The worker draws the notification for
 * data-only messages; the browser draws it from this payload otherwise. If the
 * two lists drift, the same push shows different buttons depending on which
 * one rendered it. tests/push-notification-actions.test.js compares them.
 */
function notificationActionsFor(type) {
  switch (type) {
    case 'newLead':
      return [
        { action: 'call', title: 'Call' },
        { action: 'view', title: 'Open' },
        { action: 'snooze', title: 'Snooze 1h' },
      ];
    case 'appointmentReminder':
    case 'followUpDue':
      return [
        { action: 'view', title: 'View' },
        { action: 'snooze', title: 'Snooze 1h' },
        { action: 'dismiss', title: 'Dismiss' },
      ];
    default:
      return [{ action: 'view', title: 'View' }];
  }
}

/**
 * Send push notification to a user via all their FCM tokens
 * Handles token cleanup for invalid tokens
 */
async function sendPushNotification(uid, title, body, data = {}) {
  if (!uid || !title || !body) {
    logger.warn('[Push] Missing required parameters');
    return { sent: 0, failed: 0, errors: [] };
  }
  
  try {
    const { tokens } = await getUserFCMTokens(uid);
    
    if (tokens.length === 0) {
      logger.info('[Push] No FCM tokens for user:', uid);
      return { sent: 0, failed: 0, errors: [] };
    }
    
    // FCM rejects the ENTIRE send when any data value is not a string, and
    // several call sites pass through fields that can be undefined (a lead
    // with no name, an address that was never filled in). One unnamed lead
    // would otherwise mean no push at all, with the failure buried in a
    // callable's logs. Coerce here, once, for every caller.
    const stringData = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (v === undefined || v === null) continue;
      stringData[k] = String(v);
    }

    // Build multicast message
    const message = {
      notification: {
        title: title,
        body: body
      },
      data: {
        ...stringData,
        sentAt: new Date().toISOString(),
        uid: uid
      },
      webpush: {
        notification: {
          title: title,
          body: body,
          // /pro/images/* does NOT exist — real icons live under /pro/img/.
          // The companion SW (firebase-messaging-sw.js) already corrected this
          // exact 404; the function payload was never updated to match, so a
          // background push rendered with a blank/generic OS bell. No badge-72
          // asset exists, so reuse the 192 icon (same as the SW).
          icon: 'https://nobigdealwithjoedeal.com/pro/img/nbd-icon-192.png',
          badge: 'https://nobigdealwithjoedeal.com/pro/img/nbd-icon-192.png',
          tag: data.notificationId || 'nbd-notification',
          requireInteraction: data.requireInteraction === 'true',
          // Action buttons. These must be on the SERVER payload, not only in
          // the service worker: when a push carries a `notification` block the
          // browser may render it itself without calling onBackgroundMessage,
          // and a notification drawn that way shows only what is declared
          // here. The list is kept identical to the worker's copy in
          // docs/pro/firebase-messaging-sw.js (a test compares the two).
          actions: notificationActionsFor(data.type)
        },
        data: {
          ...stringData,
          clickUrl: data.clickUrl || '/pro/dashboard.html'
        }
      }
    };
    
    // Send to all tokens
    const tokensList = tokens.map(t => t.token);
    const response = await messaging.sendEachForMulticast({
      tokens: tokensList,
      ...message
    });
    
    // Log results
    logger.info('[Push] Sent:', response.successCount, 'Failed:', response.failureCount);

    // Handle failures and clean up invalid tokens
    const failureErrors = [];
    const pruneDeletes = [];
    const userRef = db.collection('users').doc(uid);
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        failureErrors.push(resp.error.message);

        // Remove invalid tokens. AWAIT these (collected below) — they were
        // fire-and-forget, so a delete could be cut off when the function
        // froze post-return, leaving dead tokens to fail every cycle.
        const token = tokens[idx];
        if (resp.error.code === 'messaging/invalid-registration-token' ||
            resp.error.code === 'messaging/registration-token-not-registered') {
          pruneDeletes.push(
            userRef.collection('fcmTokens').doc(token.docId).delete()
              .catch(err => logger.error('push_delete_token_failed', { err: err.message }))
          );
        }
      }
    });
    if (pruneDeletes.length) await Promise.allSettled(pruneDeletes);

    // Surface delivery failures at WARN so they show up in alerting — an
    // all-fail send (e.g. every token dead/unregistered) used to look
    // identical to a healthy send in the logs.
    if (response.failureCount > 0) {
      logger.warn('[Push] delivery failures', {
        uid,
        sent: response.successCount,
        failed: response.failureCount,
        pruned: pruneDeletes.length,
        sampleErrors: failureErrors.slice(0, 3),
      });
    }

    return {
      sent: response.successCount,
      failed: response.failureCount,
      errors: failureErrors
    };
  } catch (err) {
    logger.error('[Push] Error sending notification:', err);
    return { sent: 0, failed: 0, errors: [err.message] };
  }
}

/**
 * Log notification sent for analytics
 */
async function logNotificationSent(uid, notificationType, details = {}) {
  try {
    const logsRef = db.collection('users').doc(uid).collection('notificationLogs');
    await logsRef.add({
      type: notificationType,
      sentAt: FieldValue.serverTimestamp(),
      details: details,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('[Push] Error logging notification:', err);
  }
}

// ══════════════════════════════════════════════════════════════
// CLOUD FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * TRIGGER: New lead created
 * ACTION: Send notification to assigned rep
 */
exports.onNewLead = onDocumentCreated('leads/{leadId}', async (event) => {
  const leadData = event.data.data();
  const leadId = event.params.leadId;
  
  if (!leadData || !leadData.assignedTo) {
    logger.info('[Push] No assigned rep for lead:', leadId);
    return;
  }
  
  const uid = leadData.assignedTo;
  
  // Check if notifications enabled
  const enabled = await isNotificationEnabled(uid, 'newLead');
  if (!enabled) {
    logger.info('[Push] New lead notifications disabled for user:', uid);
    return;
  }
  
  const title = 'New Lead Assigned';
  const body = `${leadData.name || 'A new lead'} in ${leadData.address || 'your area'} has been assigned to you.`;
  
  const result = await sendPushNotification(uid, title, body, {
    type: 'newLead',
    leadId: leadId,
    name: leadData.name,
    address: leadData.address,
    // The Call action reads this. Digits only — the SW strips anything else,
    // but sending it clean keeps the payload readable in logs.
    // The class needs its backslash: `[^d+]` kept only the letter "d" and "+",
    // so every digit was deleted and Call opened the lead (or dialed `tel:+`).
    // tests/push-lead-call-phone.test.js runs this handler on real numbers.
    phone: String(leadData.phone || leadData.phoneNumber || '').replace(/[^\d+]/g, ''),
    clickUrl: `/pro/dashboard.html?tab=leads&leadId=${leadId}`,
    notificationId: `lead-${leadId}`,
    requireInteraction: 'true'
  });
  
  if (result.sent > 0) {
    await logNotificationSent(uid, 'newLead', { leadId, sent: result.sent });
  }
});

/**
 * TRIGGER: Appointment time updated
 * ACTION: Send reminder 30 minutes before
 */
exports.onAppointmentReminder = onSchedule(
  {
    schedule: 'every 15 minutes',
    // Wave 104: business is in Cincinnati / Greater Cincinnati area
    // (America/New_York). The schedule fires at the wall-clock time
    // for THIS timezone — Central Time was a wrong default that
    // shifted every reminder by 1 hour. Note: timeZone here only
    // controls when the function fires, NOT what `new Date()` returns
    // inside the handler — that's still UTC server time. The offset
    // math we do below uses absolute timestamps so it's TZ-agnostic.
    timeZone: 'America/New_York'
  },
  async (context) => {
    const now = new Date();
    const in30min = new Date(now.getTime() + 30 * 60 * 1000);

    logger.info('[Push] Checking for appointments between', now, 'and', in30min);

    try {
      // Appointments live in the top-level `appointments` collection (written
      // by the cal.com webhook — integrations/calcom.js). The previous query
      // read leads.appointments[] — a shape NOTHING in the codebase writes — so
      // this reminder fired for ZERO appointments every tick. A range on the
      // single field `startTime` needs no composite index; `status` is filtered
      // in code (skip cancelled).
      const apptSnap = await db.collection('appointments')
        .where('startTime', '>=', Timestamp.fromDate(now))
        .where('startTime', '<=', Timestamp.fromDate(in30min))
        .get();

      const sendPromises = [];
      // Within-tick dedup (a 15-min schedule + 30-min lookahead overlaps
      // ticks; cross-tick dedup is the reminderSentAt marker set per appt
      // below — see the comment at the send site).
      const recentlySentSet = new Set(); // uid|apptId keys

      apptSnap.forEach(apptDoc => {
        const appt = apptDoc.data();
        const apptId = apptDoc.id;
        if (appt.status === 'cancelled') return;
        const uid = appt.repUid || appt.userId;
        if (!uid) return;

        sendPromises.push(
          (async () => {
            const enabled = await isNotificationEnabled(uid, 'appointmentReminder');
            if (!enabled) return;

            const dedupeKey = `${uid}|${apptId}`;
            if (recentlySentSet.has(dedupeKey)) return;

            // Cross-tick idempotency via a deterministic marker on the
            // appointment doc. The old dedup queried notificationLogs with
            // type==+details.appointmentId==+sentAt> — equality+range on
            // different fields needs a composite index that was NEVER created,
            // so the query threw, the catch swallowed it, and the dedup fell
            // through, firing the same reminder on 2-3 overlapping ticks (QA
            // finding). The marker is index-free, survives across ticks, and
            // is set on ATTEMPT (not delivery success) so a delivery failure
            // doesn't re-spam every 15 min. A reschedule mints a fresh
            // appointment doc (no marker) so it correctly re-reminds.
            if (appt.reminderSentAt) return;
            recentlySentSet.add(dedupeKey);
            await apptDoc.ref.update({ reminderSentAt: FieldValue.serverTimestamp() }).catch(() => {});

            const who = appt.attendeeName || appt.title || 'Your appointment';
            // Real lead time, not a hardcoded "30 minutes" — the lookahead is
            // UP TO 30 min, so an appt 5 min out was mislabeled "30 minutes".
            const startMs = (appt.startTime && appt.startTime.toMillis) ? appt.startTime.toMillis() : 0;
            const mins = startMs ? Math.max(1, Math.round((startMs - now.getTime()) / 60000)) : 30;
            await sendPushNotification(uid, 'Appointment Reminder',
              `${who} starts in ${mins} minute${mins === 1 ? '' : 's'}`, {
                type: 'appointmentReminder',
                appointmentId: apptId,
                appointmentTitle: appt.title || '',
                clickUrl: `/pro/dashboard`,
                notificationId: `appt-${apptId}`,
                requireInteraction: 'true'
              });
            // Always record the attempt for the audit trail (was logged only on
            // sent>0, so a zero-token attempt left no trace — masking the
            // FCM-registration HIGH below).
            await logNotificationSent(uid, 'appointmentReminder', { appointmentId: apptId });
          })()
        );
      });

      await Promise.allSettled(sendPromises);
      logger.info('[Push] Appointment reminder check complete');

    } catch (err) {
      logger.error('[Push] Error checking appointments:', err);
    }
  }
);

/**
 * TRIGGER: Daily follow-up reminder
 * ACTION: Push each rep one reminder covering every knock whose
 *         followUpDate lands on today's Eastern calendar day.
 *
 * FIXED 2026-09-05 — this sent ZERO notifications for its entire life.
 * It read `leads` documents and walked a `d2dKnocks[]` array looking for
 * `knock.autoFollowUp`. Nothing writes either field:
 *   - knocks are their own top-level `knocks` collection —
 *     docs/pro/js/d2d-tracker-core-2026b.js does
 *     addDoc(collection(db, 'knocks'), knockDoc)
 *   - the stored date is `followUpDate`; `autoFollowUp` is a DISPOSITIONS
 *     config *number of days* used client-side to compute it, never stored
 *   - the owner is `userId` / `repId`, not `assignedTo`
 * `git grep d2dKnocks` matched this file and nothing else — the reader was
 * the only mention of its own data model.
 *
 * This is precisely the bug onAppointmentReminder above already carried and
 * had repaired (it read `leads.appointments[]`, a shape nothing wrote). The
 * same repair was never applied to this sibling.
 *
 * The query mirrors that fix: a range on the single field `followUpDate`
 * needs no composite index. The window is deliberately wider than one day
 * and the exact "is this today in ET?" test runs in code via etYmd(), the
 * house convention (functions/monthly-overhead-logic.js:13). That avoids
 * rebuilding Eastern midnight as a UTC instant — which the old code got
 * wrong anyway: `new Date(ymd + 'T00:00:00')` is SERVER-local midnight,
 * i.e. UTC on Cloud Functions, not Eastern.
 */
const FOLLOWUP_TZ = 'America/New_York';

/** Firestore Timestamp | Date | string → 'YYYY-MM-DD' in ET, or null. */
function etYmd(d) {
  if (d == null) return null;
  const js = typeof d.toDate === 'function' ? d.toDate() : new Date(d);
  if (isNaN(js.getTime())) return null;
  return js.toLocaleDateString('en-CA', { timeZone: FOLLOWUP_TZ });
}

exports.onFollowUpDue = onSchedule(
  {
    schedule: 'every day 08:00',
    // W104: Cincinnati is Eastern, not Central. Note this only controls
    // when the function FIRES; `new Date()` inside still returns UTC, which
    // is why the ET comparison below goes through etYmd() rather than
    // getHours()/setHours().
    timeZone: FOLLOWUP_TZ
  },
  async () => {
    const now = new Date();
    const todayEt = etYmd(now);

    // Bound the read without needing exact ET-midnight instants: anything
    // whose followUpDate falls on today's ET date is within ±36h of now,
    // whatever the current UTC offset. The precise day match is below.
    const lo = new Date(now.getTime() - 36 * 3600 * 1000);
    const hi = new Date(now.getTime() + 36 * 3600 * 1000);

    logger.info('[Push] Checking follow-ups due on ET date', { todayEt });

    try {
      const snap = await db.collection('knocks')
        .where('followUpDate', '>=', Timestamp.fromDate(lo))
        .where('followUpDate', '<=', Timestamp.fromDate(hi))
        .get();

      // One push per REP, not one per knock. A rep working a route can
      // easily have several due the same morning, and N buzzes for N knocks
      // is how a useful reminder becomes a muted one.
      const byRep = new Map(); // uid -> [{ id, address, homeowner }]
      snap.forEach((doc) => {
        const k = doc.data();
        if (etYmd(k.followUpDate) !== todayEt) return;
        const uid = k.userId || k.repId;
        if (!uid) return;
        if (!byRep.has(uid)) byRep.set(uid, []);
        byRep.get(uid).push({
          id: doc.id,
          address: k.address || '',
          homeowner: k.homeowner || '',
        });
      });

      const sends = [...byRep.entries()].map(([uid, items]) => (async () => {
        const enabled = await isNotificationEnabled(uid, 'followUpDue');
        if (!enabled) return;

        const first = items[0];
        const who = first.homeowner || first.address || 'A door';
        const title = items.length === 1
          ? 'Follow-Up Due Today'
          : `${items.length} Follow-Ups Due Today`;
        const body = items.length === 1
          ? `${who} — follow-up due today`
          : `${who} and ${items.length - 1} more due today`;

        const result = await sendPushNotification(uid, title, body, {
          type: 'followUpDue',
          knockId: first.id,
          count: String(items.length),
          clickUrl: '/pro/dashboard.html?tab=d2d',
          // Deterministic per rep per ET day, so a retry of the same run
          // replaces the tray entry instead of stacking a second buzz.
          notificationId: `followup-${uid}-${todayEt}`,
        });

        if (result && result.sent > 0) {
          await logNotificationSent(uid, 'followUpDue', {
            count: items.length,
            knockIds: items.slice(0, 20).map((i) => i.id),
          });
        }
      })());

      await Promise.allSettled(sends);

      const dueToday = [...byRep.values()].reduce((n, a) => n + a.length, 0);
      logger.info('[Push] Follow-up reminder check complete', {
        scanned: snap.size, dueToday, reps: byRep.size,
      });
    } catch (err) {
      logger.error('[Push] Error checking follow-ups:', err);
    }
  }
);

/**
 * TRIGGER: Daily 7:30 AM ET
 * ACTION: Remind each rep of the yard signs due for pickup today or overdue.
 *
 * Jo (2026-09-29): he agrees 1–2 weeks with the homeowner and they text him
 * only if he DOESN'T come — so this push is the whole reminder system. Signs
 * live in yardSigns/{id} (docs/pro/js/yard-signs.js); status 'out' until
 * picked up / missing. An overdue sign is reminded again EVERY morning until
 * it's handled (one push per rep per day, deterministic tray tag).
 *
 * Single-field equality on status needs no composite index; the due-day test
 * runs in code in ET, same as onFollowUpDue above.
 */
exports.onYardSignPickupDue = onSchedule(
  { schedule: 'every day 07:30', timeZone: FOLLOWUP_TZ },
  async () => {
    const todayEt = etYmd(new Date());
    try {
      const snap = await db.collection('yardSigns').where('status', '==', 'out').get();
      const byRep = new Map(); // uid -> [{ id, address, overdue }]
      snap.forEach((doc) => {
        const s = doc.data() || {};
        if (s.deleted) return;
        const dueEt = etYmd(s.dueAt);
        if (!dueEt || dueEt > todayEt) return;
        const uid = s.userId;
        if (!uid) return;
        if (!byRep.has(uid)) byRep.set(uid, []);
        byRep.get(uid).push({ id: doc.id, address: s.address || '', overdue: dueEt < todayEt });
      });

      const sends = [...byRep.entries()].map(([uid, items]) => (async () => {
        const enabled = await isNotificationEnabled(uid, 'yardSigns');
        if (!enabled) return;
        items.sort((a, b) => (b.overdue - a.overdue));
        const overdue = items.filter((i) => i.overdue).length;
        const title = items.length === 1 ? '🪧 Yard sign to pick up' : `🪧 ${items.length} yard signs to pick up`;
        const where = items.slice(0, 2).map((i) => i.address || 'a sign').join(', ') + (items.length > 2 ? ` +${items.length - 2} more` : '');
        const body = (overdue ? `${overdue} overdue · ` : '') + where;
        const result = await sendPushNotification(uid, title, body, {
          type: 'yardSignPickup',
          count: String(items.length),
          clickUrl: '/pro/dashboard.html#/signs',
          notificationId: `yardsign-${uid}-${todayEt}`,
        });
        if (result && result.sent > 0) {
          await logNotificationSent(uid, 'yardSigns', { count: items.length, overdue, signIds: items.slice(0, 20).map((i) => i.id) });
        }
      })());
      await Promise.allSettled(sends);
      logger.info('[Push] Yard-sign pickup check complete', {
        out: snap.size, due: [...byRep.values()].reduce((n, a) => n + a.length, 0), reps: byRep.size,
      });
    } catch (err) {
      logger.error('[Push] Error checking yard signs:', err);
    }
  }
);

/**
 * TRIGGER: Claim stage changes
 * ACTION: Send notification to rep about stage update
 */
exports.onClaimStageChange = onDocumentUpdated('leads/{leadId}', async (event) => {
  const beforeData = event.data.before.data();
  const afterData = event.data.after.data();
  const leadId = event.params.leadId;
  
  // Check if claim_stage changed
  if (beforeData.claim_stage === afterData.claim_stage) {
    return;
  }
  
  const uid = afterData.assignedTo;
  if (!uid) return;
  
  const enabled = await isNotificationEnabled(uid, 'claimUpdate');
  if (!enabled) {
    logger.info('[Push] Claim update notifications disabled for user:', uid);
    return;
  }
  
  const title = 'Claim Status Update';
  const newStage = afterData.claim_stage || 'Unknown';
  const body = `Claim for ${afterData.name || 'your lead'} moved to: ${newStage}`;
  
  const result = await sendPushNotification(uid, title, body, {
    type: 'claimUpdate',
    leadId: leadId,
    newStage: newStage,
    previousStage: beforeData.claim_stage,
    name: afterData.name,
    clickUrl: `/pro/customer.html?leadId=${leadId}`,
    notificationId: `claim-${leadId}`
  });
  
  if (result.sent > 0) {
    await logNotificationSent(uid, 'claimUpdate', { leadId, newStage });
  }
});

/**
 * TRIGGER: Team message or comment
 * ACTION: Broadcast to team members
 * 
 * Note: This would be called manually from your API when a team message is created
 */
exports.sendTeamNotification = async (teamId, title, body, data = {}) => {
  try {
    const teamRef = db.collection('teams').doc(teamId);
    const teamDoc = await teamRef.get();
    
    if (!teamDoc.exists) {
      logger.warn('[Push] Team not found:', teamId);
      return [];
    }
    
    const team = teamDoc.data();
    const members = team.members || [];
    
    const sendPromises = members.map(uid =>
      (async () => {
        const enabled = await isNotificationEnabled(uid, 'teamActivity');
        if (!enabled) return { uid, sent: 0 };
        
        const result = await sendPushNotification(uid, title, body, {
          type: 'teamActivity',
          teamId: teamId,
          ...data,
          clickUrl: `/pro/dashboard.html?tab=team`,
          notificationId: `team-${teamId}`
        });
        
        if (result.sent > 0) {
          await logNotificationSent(uid, 'teamActivity', { teamId });
        }
        
        return { uid, sent: result.sent };
      })()
    );
    
    return await Promise.allSettled(sendPromises);
  } catch (err) {
    logger.error('[Push] Error sending team notification:', err);
    return [];
  }
};

/**
 * TRIGGER: D2D Streak milestone
 * ACTION: Celebrate with notification
 * 
 * Note: This would be called manually when a streak is reached
 */
exports.sendStreakNotification = async (uid, streakCount) => {
  const enabled = await isNotificationEnabled(uid, 'd2dStreak');
  if (!enabled) return { sent: 0 };
  
  let title, body;
  if (streakCount >= 100) {
    title = '100+ Knock Streak!';
    body = `Amazing work! You've reached ${streakCount} consecutive knocks!`;
  } else if (streakCount >= 50) {
    title = '50+ Knock Streak!';
    body = `Great momentum! ${streakCount} consecutive knocks!`;
  } else if (streakCount >= 10) {
    title = 'Streak Going Strong';
    body = `${streakCount} consecutive knocks - keep it up!`;
  } else {
    title = 'Streak Started!';
    body = `You've started a ${streakCount}-knock streak!`;
  }
  
  const result = await sendPushNotification(uid, title, body, {
    type: 'd2dStreak',
    streakCount: streakCount.toString(),
    clickUrl: `/pro/dashboard.html?tab=d2d`,
    notificationId: `streak-${uid}-${streakCount}`
  });
  
  if (result.sent > 0) {
    await logNotificationSent(uid, 'd2dStreak', { streakCount });
  }
  
  return result;
};

/**
 * TRIGGER: Manual push notification (for admin or custom events)
 * Called via API when you need to send a custom notification
 */
exports.sendCustomNotification = async (uid, title, body, data = {}) => {
  const result = await sendPushNotification(uid, title, body, data);
  
  if (result.sent > 0) {
    await logNotificationSent(uid, 'custom', { title, body });
  }
  
  return result;
};

module.exports = {
  // Exported for tests/push-notification-actions.test.js, which compares this
  // list against the service worker's copy.
  notificationActionsFor,
  onNewLead: exports.onNewLead,
  onAppointmentReminder: exports.onAppointmentReminder,
  onFollowUpDue: exports.onFollowUpDue,
  onYardSignPickupDue: exports.onYardSignPickupDue,
  onClaimStageChange: exports.onClaimStageChange,
  sendTeamNotification: exports.sendTeamNotification,
  sendStreakNotification: exports.sendStreakNotification,
  sendCustomNotification: exports.sendCustomNotification,
  sendPushNotification: exports.sendPushNotification,
  getUserFCMTokens: exports.getUserFCMTokens
};
