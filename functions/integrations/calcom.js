/**
 * integrations/calcom.js — Cal.com booking webhook receiver
 *
 * When a homeowner books an inspection slot via a rep's Cal.com
 * link, Cal.com POSTs to our webhook. We:
 *   1. Verify HMAC signature.
 *   2. Look up the rep (by calcom username → mapped via
 *      users/{uid}.calcomUsername or reps/{uid}.calcomUsername).
 *   3. Create an `appointments/{id}` doc scoped to that rep.
 *   4. Link it to an EXISTING CRM lead when the attendee's email or
 *      last-10 phone matches one in that rep's pipeline (M-1).
 *   PHONE + ADDRESS (2026-09-13): both are resolved by calcom-logic.js from
 *      whichever field Cal.com used. The documented payload carries NO
 *      phone on attendees[] — the Phone question arrives at
 *      responses.attendeePhoneNumber and a phone-call event's number in
 *      responses.location — and until this change nothing here read
 *      `responses`, so every booking landed phone-less. See that module and
 *      tests/calcom-webhook-payload.test.js.
 *   5. Otherwise CREATE the lead (M-2, added 2026-08-28 / PR #1288):
 *      `leads/{calcom__<bookingId>}`, same doc shape as the public-lead
 *      bridge, source 'Website — Cal.com booking', deterministic id +
 *      .create() so Cal.com's at-least-once redelivery is idempotent.
 *      Without this a cold online booking exists ONLY in `appointments`,
 *      which the Pipeline never queries — invisible in the CRM. That was
 *      a live bug from this file's creation until 2026-08-28; see
 *      documentation/projects/SESSION-2026-08-28-calcom-lead-drop.md.
 *
 * No `tasks/{id}` reminder is written — that step was dead code and was
 * removed (see the note at the end of the BOOKING_CREATED branch);
 * push-functions.js `onAppointmentReminder` reminds off the appointments
 * doc instead.
 *
 * SETUP:
 *   cal.com → Settings → Developer → Webhooks → new
 *     URL:    https://us-central1-nobigdeal-pro.cloudfunctions.net/calcomWebhook
 *     Events: BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED
 *     Secret: generate random (32 bytes) → paste into CALCOM_WEBHOOK_SECRET
 *   firebase functions:secrets:set CALCOM_WEBHOOK_SECRET
 *
 * Reps set their Cal.com username in Settings → Profile → it's
 * saved to users/{uid}.calcomUsername.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { getSecret, hasSecret, SECRETS } = require('./_shared');
const L = require('../lead-bridge-logic');
const CL = require('./calcom-logic');
const { createLeadWithCustomerId } = require('../customer-id-mint');
const { spineAfterBooking } = require('../job-spine');

exports.calcomWebhook = onRequest(
  {
    region: 'us-central1',
    maxInstances: 10,
    timeoutSeconds: 15,
    memory: '256MiB',
    secrets: [SECRETS.CALCOM_WEBHOOK_SECRET]
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    // F2: fail closed when the secret isn't configured. Accepting
    // unsigned Cal.com calls means an attacker who knows the URL can
    // create appointment rows — and, since 2026-08-28 (PR #1288), CRM
    // lead docs — in any rep's calendar and pipeline.
    if (!hasSecret('CALCOM_WEBHOOK_SECRET')) {
      logger.error('calcomWebhook: CALCOM_WEBHOOK_SECRET not set — rejecting unsigned request');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }
    const sig = req.headers['x-cal-signature-256'];
    if (!sig || !req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      res.status(400).json({ error: 'Missing signature' });
      return;
    }
    const computed = crypto
      .createHmac('sha256', getSecret('CALCOM_WEBHOOK_SECRET'))
      .update(req.rawBody)
      .digest('hex');
    if (!safeEqual(computed, String(sig))) {
      res.status(403).json({ error: 'Bad signature' });
      return;
    }

    const body = req.body || {};
    const trigger = String(body.triggerEvent || '').toUpperCase();
    const payload = body.payload || {};

    // Organizer is the rep. Cal.com includes their email + username.
    const organizerEmail = (payload.organizer && payload.organizer.email) || null;
    const organizerUsername = (payload.organizer && payload.organizer.username) || null;
    const attendee = Array.isArray(payload.attendees) ? payload.attendees[0] : null;

    // Resolve rep uid (+ their companyId, for the M-2 lead creation below).
    // Lookups here, the decision in CL.resolveCalcomRep (R5-8-1, 2026-10-06):
    //   1. optional server-only system/calcomRouting doc (clients are denied
    //      by firestore.rules), by event slug then organizer username;
    //   2. the organizer's Auth EMAIL account, if it belongs to a company —
    //      it beats any username (security checklist 2026-10-01: any user can
    //      write their own users/{uid}.calcomUsername);
    //   3. the ONE account carrying the username, only if it belongs to a
    //      company (two claimants = nobody via the username);
    //   4. a company-less email account (legacy fallback, companyId = uid).
    // Before this, a company-less email account won outright, so a tenant
    // whose Cal.com email is an old login lost every booking to it.
    const db = getFirestore();
    const ev = CL.extractEventType(payload);
    const companyOfAccount = async (uid, claims, userData) => {
      const data = userData !== undefined ? userData : await db.doc(`users/${uid}`).get().then((s) => (s.exists ? s.data() : null));
      const coSnap = await db.doc(`companies/${uid}`).get();
      return CL.accountCompanyId({ uid, claims, userData: data, companyData: coSnap.exists ? coSnap.data() : null });
    };

    let configured = null;
    try {
      const cfgSnap = await db.doc('system/calcomRouting').get();
      const cfgCompanyId = cfgSnap.exists ? CL.pickConfiguredCompanyId(cfgSnap.data(), { eventSlug: ev.slug, organizerUsername }) : null;
      if (cfgCompanyId) {
        const coSnap = await db.doc(`companies/${cfgCompanyId}`).get();
        const ownerId = coSnap.exists ? coSnap.data().ownerId : null;
        if (typeof ownerId === 'string' && ownerId) configured = { uid: ownerId, companyId: cfgCompanyId };
        else logger.warn('[calcom] routing config names a company with no owner; ignored', { companyId: cfgCompanyId });
      }
    } catch (e) { logger.warn('[calcom] routing config read failed; using email/username', { err: e && e.message }); }

    let emailAccount = null;
    if (!configured && organizerEmail) {
      let u = null;
      try { u = await getAuth().getUserByEmail(organizerEmail); } catch (e) { /* no matching user */ }
      if (u) emailAccount = { uid: u.uid, companyId: await companyOfAccount(u.uid, u.customClaims || null) };
    }
    let usernameClaimants = [];
    if (!configured && organizerUsername) {
      const q = await db.collection('users').where('calcomUsername', '==', organizerUsername).limit(2).get();
      usernameClaimants = await Promise.all(q.docs.map(async (d) => {
        let claims = null;
        try { claims = (await getAuth().getUser(d.id)).customClaims || null; } catch (e) { /* no Auth record */ }
        return { uid: d.id, companyId: await companyOfAccount(d.id, claims, d.data()) };
      }));
    }

    const route = CL.resolveCalcomRep({ configured, emailAccount, usernameClaimants });
    const repUid = route.repUid;
    const repCompanyId = route.repCompanyId;
    if (route.conflict) {
      logger.warn('[calcom] organizer email and username map to different companies; email wins', { bookingUid: payload.uid || null, repUid, reason: route.reason });
    } else if (route.reason === 'username_ambiguous') {
      logger.warn('[calcom] username claimed by more than one account; booking left unassigned', { bookingUid: payload.uid || null });
    }
    logger.info('[calcom] rep resolved', { bookingUid: payload.uid || null, repUid, reason: route.reason });
    if (!repUid) {
      // Return 200 so Cal.com doesn't retry-storm an unmappable booking, but
      // log loudly with the booking context so a missing/typo'd calcomUsername
      // is diagnosable (the booking is otherwise dropped on the floor — the
      // rep needs to set Settings → Profile → Cal.com username).
      logger.warn('calcomWebhook: no matching rep — booking dropped', {
        organizerUsername,
        organizerEmail,
        trigger,
        bookingId: payload.uid || payload.id || payload.bookingId || null,
        attendeeEmail: attendee && attendee.email,
      });
      res.status(200).json({ ok: true, matched: false });
      return;
    }

    const bookingId = payload.uid || payload.id || payload.bookingId;
    if (!bookingId) { res.status(400).json({ error: 'Missing booking id' }); return; }

    try {
      const apptRef = db.doc(`appointments/${bookingId}`);

      if (trigger === 'BOOKING_CREATED' || trigger === 'BOOKING_RESCHEDULED') {
        const startTime = payload.startTime ? new Date(payload.startTime) : null;
        const endTime   = payload.endTime   ? new Date(payload.endTime)   : null;
        // M-1: link the booking to its CRM lead so it isn't an orphan — the
        // rep's card / smart-calendar can resolve it authoritatively instead of
        // fuzzy attendee-NAME matching (which breaks on nicknames/typos). Best-
        // effort: match attendee email or last-10 phone within the rep's leads.
        // Resolved once, before M-1, from whichever field Cal.com used.
        const resolved = CL.resolveAttendeePhone(payload);
        const resolvedAddress = CL.resolveBookingAddress(payload);
        let leadId = null;
        try {
          const email = String((attendee && attendee.email) || CL.responseValue((payload.responses || {}).email) || '').toLowerCase().trim();
          if (email || resolved.phoneDigits) {
            const mine = await db.collection('leads').where('userId', '==', repUid).get();
            leadId = CL.matchExistingLead(mine.docs.map(d => ({ id: d.id, data: d.data() })), { email, phoneDigits: resolved.phoneDigits });
          }
        } catch (e) { logger.warn('calcomWebhook: lead-link lookup failed', { err: e && e.message }); }

        // M-2: no existing lead matched — this is a new/organic booker, not
        // someone already in the pipeline. Without this, the booking only
        // ever exists as an appointments/{id} doc, which the Pipeline view
        // never reads — the lead is silently dropped from the CRM even
        // though the appointment itself was written correctly. Deterministic
        // id + create() (not set()) makes this idempotent against Cal.com's
        // at-least-once webhook delivery, mirroring the public-lead bridge
        // (lead-bridge.js).
        if (!leadId) {
          try {
            const newLeadId = L.bridgeDocId('calcom', bookingId);
            const fields = CL.buildCalcomLeadFields({ payload, bookingId });
            await createLeadWithCustomerId(db, db.collection('leads').doc(newLeadId), {
              ...fields,
              userId: repUid,
              companyId: repCompanyId || repUid,
              createdAt: FieldValue.serverTimestamp(),
              stageStartedAt: FieldValue.serverTimestamp(),
            });
            leadId = newLeadId;
            // Booleans + field names only, never the number: the first real
            // booking per event type settles which field Cal.com populates.
            logger.info('calcomWebhook: created CRM lead for unmatched booking', { bookingId, leadId, repUid, phonePresent: !fields.needsPhone, phoneSource: fields.phoneSource, addressSource: fields.addressSource, eventSlug: fields.calcomEventSlug });
          } catch (e) {
            if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) {
              // Retried delivery — the lead already exists from a prior
              // attempt at this same booking; link to it instead of leaving
              // this appointment's leadId null.
              leadId = L.bridgeDocId('calcom', bookingId);
            } else {
              logger.warn('calcomWebhook: lead creation failed', { bookingId, err: e && e.message });
            }
          }
        }

        await apptRef.set({
          bookingId,
          userId: repUid,                 // owner scope for Firestore rules
          repUid,
          leadId,                         // M-1: CRM lead linkage (null if no confident match)
          calcomUsername: organizerUsername,
          attendeeName:   attendee && attendee.name,
          attendeeEmail:  attendee && attendee.email,
          attendeePhone:  resolved.phone || null,
          title:          payload.title,
          location:       resolvedAddress.address || payload.location || null,
          calcomLocationRaw: payload.location || null,
          description:    payload.additionalNotes || payload.description,
          startTime:      startTime ? Timestamp.fromDate(startTime) : null,
          endTime:        endTime   ? Timestamp.fromDate(endTime)   : null,
          status:         trigger === 'BOOKING_RESCHEDULED' ? 'rescheduled' : 'booked',
          source:         'calcom',
          createdAt:      FieldValue.serverTimestamp(),
          updatedAt:      FieldValue.serverTimestamp(),
          // On reschedule, clear any reminder marker so the NEW start time
          // re-reminds. Cal.com may reuse the same booking uid, in which case
          // this merge would otherwise keep a stale reminderSentAt and suppress
          // the reminder for the new slot. (See push-functions.js dedup.)
          ...(trigger === 'BOOKING_RESCHEDULED' ? { reminderSentAt: FieldValue.delete() } : {})
        }, { merge: true });

        // A reschedule that mints a NEW booking uid leaves the ORIGINAL
        // appointment doc live → a ghost reminder fires for the stale slot.
        // Cal.com references the prior booking via rescheduleUid/rescheduleId;
        // cancel it. (No-op when the uid is reused — priorUid === bookingId —
        // since that path is handled by the marker clear above.)
        if (trigger === 'BOOKING_RESCHEDULED') {
          const priorUid = payload.rescheduleUid || payload.rescheduleId || payload.fromReschedule || null;
          if (priorUid && String(priorUid) !== String(bookingId)) {
            await db.doc(`appointments/${priorUid}`).update({
              status:       'cancelled',
              cancelledReason: 'rescheduled',
              supersededBy: String(bookingId),
              cancelledAt:  FieldValue.serverTimestamp(),
              updatedAt:    FieldValue.serverTimestamp(),
            }).catch(e => logger.warn('calcomWebhook: prior-appt cancel skipped', { priorUid, err: e && e.message }));
          }
        }

        // Job spine (2026-10-03): a new booking means the homeowner has been
        // reached — New → Contacted (forward only, never a lost/closed lead),
        // plus a timeline note naming the appointment. Once per booking uid;
        // a webhook redelivery is a no-op. Internal only — nothing is sent.
        if (trigger === 'BOOKING_CREATED' && leadId) {
          await spineAfterBooking(db, { leadId, companyId: repCompanyId || repUid, bookingId, startTime, title: payload.title });
        }

        // (Removed a dead "remind 1hr before" tasks/{id} write: its dueAt had
        // ZERO readers and the doc landed in the top-level `tasks` collection,
        // which no task UI (they read leads/{id}/tasks) or cron consumes. The
        // appointment-reminder cron — push-functions.js onAppointmentReminder —
        // now reminds off the `appointments` doc written just above, which
        // already covers this cal.com booking.)
      } else if (trigger === 'BOOKING_CANCELLED') {
        await apptRef.set({
          status: 'cancelled',
          cancelledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          userId: repUid
        }, { merge: true });
      }

      res.status(200).json({ ok: true, matched: true, repUid, trigger });
    } catch (e) {
      logger.error('calcomWebhook write failed:', e.message);
      res.status(500).json({ error: 'write failed' });
    }
  }
);

function safeEqual(a, b) {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = exports;
