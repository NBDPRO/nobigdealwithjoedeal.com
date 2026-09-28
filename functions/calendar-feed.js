/**
 * functions/calendar-feed.js — a read-only .ics feed of a rep's own schedule.
 *
 * Jo asked for his schedule on his phone without another app. Today the CRM's
 * Schedule view is the only place a Cal.com appointment or a rep-typed
 * Scheduled Date exists, which means the phone's own Calendar — the thing that
 * actually pings him — knows nothing about either.
 *
 * This mints one secret URL per rep. iOS subscribes to it once and refreshes on
 * its own forever. No vendor, no API key, no OAuth, no secret of any kind: the
 * whole feature is a token, a rewrite and a serializer, so it works the moment
 * it deploys.
 *
 * Exports:
 *   createCalendarFeedToken (onCall)    — rep mints/rotates their own feed link
 *   getCalendarFeed         (onRequest) — /calendar/<token>.ics → text/calendar
 *
 * Model, and why it differs from report-sharing.js (which it otherwise mirrors):
 *   - ONE active token per rep; minting again ROTATES (revokes the old one).
 *   - NO expiry. A share link for one homeowner should expire; a calendar
 *     subscription that silently stops refreshing is worse than useless — the
 *     phone shows a stale schedule with no error. Rotation is the revocation.
 *   - Bound to the caller's own uid. A company_admin does not get a teammate's
 *     feed.
 *
 * Security: getCalendarFeed is deliberately unauthenticated — that is what lets
 * iOS fetch it. Compensating controls: a ~120-bit unguessable token, per-IP and
 * per-token rate limits, GET/HEAD only, no CORS header, X-Robots-Tag noindex,
 * Cache-Control private/no-store, and text/plain error bodies that reveal only
 * "unknown" vs "rotated". The URL is a bearer credential carrying the rep's own
 * homeowner names, addresses and phones, so the UI says so and every fetch is
 * stamped (lastFetchedAt, fetchCount, lastUserAgent) to make a leak visible.
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { httpRateLimit, enforceRateLimit } = require('./integrations/upstash-ratelimit');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { buildCalendar } = require('./calendar-feed-logic');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  // Was 'nbd-pro.web.app' (a typo — that host has never existed; the
  // Firebase project is nobigdeal-pro). #700 (2026-06-23) fixed this
  // typo in a dozen sibling files but missed this one. Fixed 2026-09-14.
  'https://nobigdeal-pro.web.app',
];

const FEED_BASE = 'https://nobigdealwithjoedeal.com/calendar/';
const TOKEN_COLLECTION = 'calendar_feed_tokens';

// Same 32-char no-confusable alphabet as deal-acceptance / portal /
// report-sharing: 24 chars ≈ 120 bits.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}

// How much of the schedule the phone carries. Back far enough to look at last
// month, forward far enough for anything booked.
const WINDOW_BACK_DAYS = 30;
const WINDOW_FWD_DAYS = 180;
// Ceiling on the rep's lead book read. There is deliberately NO composite index
// on [userId, scheduledDate] — CI deploys firestore.rules but not
// firestore.indexes.json, so a query needing one would throw FAILED_PRECONDITION
// in production while passing every local check. The equality-only query uses
// the automatic single-field index and the date window is applied in memory,
// which is the same trade calcom.js makes when it reads a rep's whole book.
const LEAD_SCAN_CAP = 3000;

function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// ═══════════════════════════════════════════════════════════════
// createCalendarFeedToken — mint (or rotate) the caller's own feed link.
// ═══════════════════════════════════════════════════════════════
exports.createCalendarFeedToken = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const revokeOnly = !!(request.data && request.data.revokeOnly);
    // 2026-09-25 (decision B): a viewer is read-only, and a feed link is an
    // unauthenticated URL serving the schedule's lead names and addresses —
    // a viewer may not mint one. revokeOnly stays open: it only turns off
    // links the caller minted themselves (e.g. before being made a viewer),
    // which leaves less tenant data reachable, not more.
    if (!revokeOnly) assertNotViewer(request.auth.token);
    // A compromised session could otherwise mint links in a loop.
    await callableRateLimit(request, 'createCalendarFeedToken', 10, 60 * 60_000);

    const db = getFirestore();

    // Revoke every currently-active token for this rep. Rotation is the only
    // revocation this feature has, so it must be reliable rather than clever:
    // a plain query + per-doc update, no transaction, no assumptions about how
    // many exist.
    let revoked = 0;
    try {
      const actives = await db.collection(TOKEN_COLLECTION)
        .where('uid', '==', uid).where('status', '==', 'active').get();
      const batch = db.batch();
      actives.forEach((d) => {
        batch.update(d.ref, {
          status: 'revoked',
          revokedAt: FieldValue.serverTimestamp(),
          revokedReason: revokeOnly ? 'user' : 'rotated',
        });
        revoked++;
      });
      if (revoked) await batch.commit();
    } catch (e) {
      logger.error('[createCalendarFeedToken] revoke failed', { uid, err: e && e.message });
      throw new HttpsError('internal', 'Could not rotate your calendar link. Try again.');
    }

    if (revokeOnly) return { revoked, token: null, feedUrl: null, webcalUrl: null };

    let companyId = uid;
    try {
      const userSnap = await db.doc('users/' + uid).get();
      if (userSnap.exists && userSnap.data().companyId) companyId = userSnap.data().companyId;
    } catch (e) { /* solo-op default: own uid is own company */ }

    const token = mintToken();
    await db.doc(TOKEN_COLLECTION + '/' + token).set({
      uid,
      companyId,
      status: 'active',
      mintedBy: uid,
      mintedAt: FieldValue.serverTimestamp(),
      // Deliberately null — see the header. A calendar subscription must not
      // expire silently.
      expiresAt: null,
      fetchCount: 0,
    });

    const feedUrl = FEED_BASE + token + '.ics';
    return {
      token,
      feedUrl,
      // webcal:// makes iOS offer "Subscribe" directly instead of downloading.
      webcalUrl: feedUrl.replace(/^https:/, 'webcal:'),
      revoked,
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// getCalendarFeed — /calendar/<token>.ics → text/calendar
// ═══════════════════════════════════════════════════════════════
// No enforceAppCheck: it is meaningless on onRequest and
// tests/appcheck-onrequest-contract.js fails the build if it appears here.
exports.getCalendarFeed = onRequest(
  {
    region: 'us-central1',
    maxInstances: 20,
    concurrency: 40,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    // Always text/plain: a calendar client shows the body verbatim, and an
    // HTML error page in a subscription slot is unreadable noise.
    const fail = (code, msg, extra) => {
      res.status(code)
        .set('Content-Type', 'text/plain; charset=utf-8')
        .set('Cache-Control', 'private, no-store')
        .set('X-Robots-Tag', 'noindex, nofollow');
      if (extra) for (const [k, v] of Object.entries(extra)) res.set(k, v);
      res.send(msg + '\n');
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(405, 'Method not allowed.'); return;
    }
    // /calendar/<token>.ics — the .ics suffix is what makes iOS treat the URL
    // as a calendar rather than a download.
    const m = (req.path || '').match(/\/calendar\/([A-Za-z0-9]{10,64})(?:\.ics)?\/?$/);
    const token = m ? m[1] : '';
    if (!token) { fail(400, 'This calendar link is not valid.'); return; }

    if (!(await httpRateLimit(req, res, 'calendarfeed-get:ip', 60, 60_000))) return;
    try {
      await enforceRateLimit('calendarfeed-get:token', token, 30, 60_000);
    } catch (e) {
      if (e && e.rateLimited) { fail(429, 'Too many requests. Try again shortly.'); return; }
    }

    const db = getFirestore();
    let tok;
    try {
      const snap = await db.doc(TOKEN_COLLECTION + '/' + token).get();
      if (!snap.exists) { fail(404, 'This calendar link is not valid.'); return; }
      tok = snap.data();
    } catch (e) {
      logger.error('[getCalendarFeed] token read failed', { err: e && e.message });
      fail(503, 'Calendar temporarily unavailable.', { 'Retry-After': '300' });
      return;
    }
    if (tok.status !== 'active') {
      fail(410, 'This calendar link was rotated. Get a fresh one from NBD Pro → Schedule.');
      return;
    }

    // Fire-and-forget: a leaked link is visible here and nowhere else.
    db.doc(TOKEN_COLLECTION + '/' + token).update({
      lastFetchedAt: FieldValue.serverTimestamp(),
      fetchCount: FieldValue.increment(1),
      lastUserAgent: String(req.headers['user-agent'] || '').slice(0, 120),
    }).catch(() => {});

    const uid = tok.uid;
    const now = Date.now();
    const fromMs = now - WINDOW_BACK_DAYS * 86_400_000;
    const toMsWindow = now + WINDOW_FWD_DAYS * 86_400_000;

    let appointments = [];
    let leads = [];
    try {
      // Two appointment queries: repUid is the Cal.com webhook's write shape,
      // userId covers legacy/manual docs. Both composites already exist. Union
      // by doc id — a doc carrying both fields would otherwise appear twice.
      const [byRep, byUser] = await Promise.all([
        db.collection('appointments').where('repUid', '==', uid)
          .where('startTime', '>=', new Date(fromMs)).where('startTime', '<=', new Date(toMsWindow)).get(),
        db.collection('appointments').where('userId', '==', uid)
          .where('startTime', '>=', new Date(fromMs)).where('startTime', '<=', new Date(toMsWindow)).get(),
      ]);
      const seen = new Set();
      for (const snap of [byRep, byUser]) {
        snap.forEach((d) => {
          if (seen.has(d.id)) return;
          seen.add(d.id);
          appointments.push(Object.assign({ id: d.id }, d.data()));
        });
      }

      // Leads: equality-only query (automatic index), date window in memory.
      // See LEAD_SCAN_CAP for why there is no composite here.
      const leadSnap = await db.collection('leads')
        .where('userId', '==', uid).limit(LEAD_SCAN_CAP).get();
      const fromYmd = ymd(fromMs);
      const toYmd = ymd(toMsWindow);
      leadSnap.forEach((d) => {
        const data = d.data();
        const sd = data && data.scheduledDate;
        if (typeof sd === 'string' && sd >= fromYmd && sd <= toYmd) {
          leads.push(Object.assign({ id: d.id }, data));
        }
      });
      if (leadSnap.size === LEAD_SCAN_CAP) {
        logger.warn('[getCalendarFeed] lead scan hit the cap', { uid, cap: LEAD_SCAN_CAP });
      }
    } catch (e) {
      // NEVER fall through to an empty 200: a calendar client reads that as
      // "every event was deleted" and wipes the subscription.
      logger.error('[getCalendarFeed] data read failed', { uid, err: e && e.message });
      fail(503, 'Calendar temporarily unavailable.', { 'Retry-After': '300' });
      return;
    }

    const ics = buildCalendar({ appointments, leads, nowMs: now, calName: 'NBD Schedule' });

    res.status(200)
      .set('Content-Type', 'text/calendar; charset=utf-8')
      .set('Content-Disposition', 'inline; filename="nbd-schedule.ics"')
      .set('Cache-Control', 'private, no-store')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .send(ics);
  }
);

module.exports = exports;
