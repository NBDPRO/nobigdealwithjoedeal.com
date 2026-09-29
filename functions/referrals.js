/**
 * functions/referrals.js — homeowner referral pipeline
 * ═══════════════════════════════════════════════════════════════
 *
 * The "send your friend my way" lane. A past customer shares a link
 * with their friend (text / email); the friend lands on /refer.html,
 * fills in their info, hits Submit; this endpoint creates a new lead
 * on the source customer's REP'S book with `referredByCustomerId`
 * pointing back at the original lead.
 *
 * Why a public endpoint and not a portal-token flow:
 *   The referrer (source customer) shares ONE link to many friends.
 *   We don't want to mint a portal token per friend — the source
 *   customer doesn't know who's clicking. Instead the link carries
 *   the source's `customerId` (NBD-0001 format; already public via
 *   the rep's portal share UI), and the friend self-identifies in
 *   the form. Customer IDs are short and easy to dedupe-protect; an
 *   attacker brute-forcing them gets nothing more than the ability
 *   to seed someone's CRM with junk leads — same blast-radius as
 *   filling out a contact form on a marketing site.
 *
 * Anti-spam:
 *   - Per-IP rate limit: 5 submissions / 10 min (covers a sane
 *     family-of-three referring 3 friends, kills any flood)
 *   - Per-source-customer cap: 10 referrals / 24h (a real customer
 *     might refer the whole street after a storm — generous but
 *     bounded)
 *   - Phone + email validation; at least one of the two required
 *   - Name + address required
 *
 * What we DON'T do here:
 *   - No reward / payout flow. That's a policy decision the rep makes;
 *     they get notified of a new referral and can thank-you / comp
 *     however they want. Step 16 ships the tracking; reward automation
 *     is a future PR.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const { phoneDigits10 } = require('./phone-utils');
const { createLeadWithCustomerId } = require('./customer-id-mint');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const MAX_REFERRALS_PER_SOURCE_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }
function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }

function ok(res, body)   { res.status(200).json(body); }
function bad(res, code, error) { res.status(code).json({ error }); }

// CORS preflight + header writer shared across routes here.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// ═══════════════════════════════════════════════════════════════
// submitReferral — public POST from /refer.html
// ═══════════════════════════════════════════════════════════════
//
// Body: { ref: <customerId>, firstName, lastName, phone, email,
//         address?, notes? }
// Resolves: 200 { ok: true } | 4xx { error }
exports.submitReferral = onRequest(
  {
    region: 'us-central1',
    cors: false, // we handle CORS manually to allow the OPTIONS path
    maxInstances: 40,
    concurrency: 60,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST')   { return bad(res, 405, 'POST only'); }

    if (!(await httpRateLimit(req, res, 'referral:ip', 5, 10 * 60_000))) return;

    const body = req.body || {};
    const ref = String(body.ref || '').trim().toUpperCase();
    const firstName = String(body.firstName || '').trim().slice(0, 80);
    const lastName  = String(body.lastName  || '').trim().slice(0, 80);
    const phone     = String(body.phone     || '').trim();
    const email     = String(body.email     || '').trim();
    const address   = String(body.address   || '').trim().slice(0, 200);
    const notes     = String(body.notes     || '').trim().slice(0, 600);

    // Source customer identifier — accept either NBD-0001 customerId
    // OR a raw lead doc id (rare but used in shared previews). Both
    // are looked up below.
    if (!ref || ref.length < 4 || ref.length > 32) {
      return bad(res, 400, 'Missing or malformed referral code');
    }
    if (!firstName) return bad(res, 400, 'First name is required');
    const phoneDigits = digitsOnly(phone);
    const emailOk = !email || validEmail(email);
    if (!emailOk)                       return bad(res, 400, 'Email looks invalid');
    if (!phoneDigits && !email)         return bad(res, 400, 'Phone or email is required');
    if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
      return bad(res, 400, 'Phone needs 10-15 digits');
    }

    const db = getFirestore();

    // ─── Resolve the source customer ────────────────────────────
    // TENANT-SCOPED, AND FAIL-CLOSED ON AMBIGUITY (audit 2026-08-02).
    //
    // This used to be `where('customerId','==',ref).limit(1)` — a GLOBAL
    // query with no tenant scope. Whatever Firestore returned first won, and
    // the new lead is filed onto sourceLead.userId's book under
    // sourceLead.companyId (below). So if two tenants ever held the same
    // customerId, a homeowner's name, phone, email and address were filed
    // into the wrong company's CRM — silently to both sides. The platform
    // tenant is the easy case to collide with: customer-id.js mints un-salted
    // sequential 'NBD-####'.
    //
    // customerIds carry their tenant with them: the leading segment is a
    // GLOBALLY-RESERVED prefix, and docPrefixes/{PREFIX}.companyId maps it
    // back to exactly one company (see reserveCompanyPrefix). So resolve the
    // expected tenant from the code itself and require the lead to match.
    //
    // The query drops .limit(1) on purpose — with a cap of 1 an ambiguous
    // code is indistinguishable from an unambiguous one, which is precisely
    // how this stayed invisible. Filtering happens in memory rather than as a
    // second `where` because there is no composite index on
    // (customerId, companyId) and this result set is 0-1 rows in practice.
    let sourceLead = null;
    try {
      const prefix = ref.split('-')[0] || '';
      let expectedCompanyId = null;
      if (prefix && /^[A-Z0-9]{2,12}$/.test(prefix)) {
        const pfxSnap = await db.doc(`docPrefixes/${prefix}`).get();
        if (pfxSnap.exists) expectedCompanyId = pfxSnap.get('companyId') || null;
      }

      const byCustId = await db.collection('leads')
        .where('customerId', '==', ref)
        .limit(10).get();

      let candidates = byCustId.docs;
      if (expectedCompanyId) {
        candidates = candidates.filter(d => d.get('companyId') === expectedCompanyId);
      }

      if (candidates.length > 1) {
        // Two leads legitimately answering to one code means we cannot know
        // whose customer this is. Guessing is what filed PII into the wrong
        // CRM, so refuse and surface it instead.
        logger.error('[submitReferral] AMBIGUOUS referral code — refusing', {
          ref,
          expectedCompanyId,
          matchCount: candidates.length,
          companyIds: candidates.map(d => d.get('companyId')),
        });
        return bad(res, 409, 'This referral link is not unique. Please contact us directly.');
      }
      if (candidates.length === 1) {
        sourceLead = { id: candidates[0].id, ...candidates[0].data() };
      } else if (byCustId.size > 0 && expectedCompanyId) {
        // The code resolves to a tenant that does not own any lead bearing
        // it — i.e. someone is presenting another tenant's code shape. Treat
        // as invalid rather than falling through to the raw-id path.
        logger.warn('[submitReferral] code prefix tenant does not own the lead', {
          ref, expectedCompanyId,
        });
      } else if (ref.length >= 16 && /^[a-zA-Z0-9]+$/.test(ref)) {
        // Looks like a raw doc id — try it. Document ids are unique, so this
        // path carries no cross-tenant ambiguity.
        const snap = await db.doc(`leads/${ref}`).get();
        if (snap.exists) sourceLead = { id: snap.id, ...snap.data() };
      }
    } catch (e) {
      logger.warn('[submitReferral] lookup failed', { ref, err: e.message });
    }
    if (!sourceLead) return bad(res, 404, 'Referral link is invalid');
    if (sourceLead.deleted) return bad(res, 410, 'Referral link is no longer active');

    // ─── Per-source-customer daily cap ──────────────────────────
    const since = new Date(Date.now() - DAY_MS);
    try {
      const recent = await db.collection('leads')
        .where('referredByLeadId', '==', sourceLead.id)
        .where('createdAt', '>=', since)
        .limit(MAX_REFERRALS_PER_SOURCE_PER_DAY + 1)
        .get();
      if (recent.size >= MAX_REFERRALS_PER_SOURCE_PER_DAY) {
        return bad(res, 429, 'This referrer has reached the daily limit. Try again tomorrow.');
      }
    } catch (e) {
      // Composite-index missing — don't block the referral, just log.
      logger.warn('[submitReferral] cap query failed', { err: e.message });
    }

    // ─── Create the new lead on the source's rep's book ─────────
    const ownerUid = sourceLead.userId || null;
    const companyId = sourceLead.companyId || ownerUid || null;
    if (!ownerUid) return bad(res, 500, 'Internal error');

    const leadData = {
      firstName,
      lastName,
      phone,
      // Normalized match key so an inbound SMS from this referral ties back
      // to the lead (incomingSMS queries leads by phoneDigits). NOTE the
      // local `phoneDigits` above is the raw 10-15 digit string used for
      // validation — this field is the canonical last-10 transform.
      phoneDigits: phoneDigits10(phone),
      email,
      address,
      stage: 'new',
      source: 'Referral',
      notes: notes
        ? `Referred by ${sourceLead.firstName || ''} ${sourceLead.lastName || ''}`.trim() + '. ' + notes
        : `Referred by ${sourceLead.firstName || ''} ${sourceLead.lastName || ''}`.trim(),
      // Step 16 tracking fields — power the rep-side "Referred by"
      // badge AND the referral analytics in future PRs.
      referredByLeadId: sourceLead.id,
      referredByCustomerId: sourceLead.customerId || null,
      referredByName: `${sourceLead.firstName || ''} ${sourceLead.lastName || ''}`.trim() || null,
      referredAt: FieldValue.serverTimestamp(),
      userId: ownerUid,
      companyId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      stageStartedAt: FieldValue.serverTimestamp(),
    };

    let newLeadId;
    try {
      const ref = db.collection('leads').doc();
      await createLeadWithCustomerId(db, ref, leadData);
      newLeadId = ref.id;
    } catch (e) {
      logger.error('[submitReferral] lead create failed', { err: e.message });
      return bad(res, 500, 'Could not save referral. Try again.');
    }

    // ─── Source-customer activity entry + counter bump ──────────
    // Fire-and-forget — the new lead is already saved; failure here
    // only hurts the source customer's portal stats, not the actual
    // referral capture.
    try {
      await db.collection(`leads/${sourceLead.id}/activity`).add({
        userId: ownerUid,
        type: 'referral_sent',
        label: 'Referral sent your way',
        message: `${firstName} ${lastName}`.trim() + ' was referred via your share link.',
        newLeadId,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('[submitReferral] activity write failed', { err: e.message });
    }
    try {
      await db.doc(`leads/${sourceLead.id}`).set({
        referralStats: {
          sent: FieldValue.increment(1),
          lastSentAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      logger.warn('[submitReferral] stats update failed', { err: e.message });
    }

    // ─── Rep notification ───────────────────────────────────────
    try {
      await db.collection('notifications').add({
        userId: ownerUid,
        type: 'referral_received',
        leadId: newLeadId,
        sourceLeadId: sourceLead.id,
        title: 'New referral!',
        message: `${firstName} ${lastName}`.trim() + ` referred by ${leadData.referredByName || 'a past customer'}`,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('[submitReferral] notification write failed', { err: e.message });
    }

    return ok(res, { ok: true, leadId: newLeadId });
  }
);
