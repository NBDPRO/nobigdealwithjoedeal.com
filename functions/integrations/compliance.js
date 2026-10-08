/**
 * integrations/compliance.js — retention, backup, and GDPR callables
 *
 * Four pieces of compliance infrastructure in one module:
 *   - auditLogRetentionCron    (D4) — prune audit_log entries older
 *                                     than the retention window.
 *   - (D5 nightlyFirestoreBackup was retired 2026-09-05 — it duplicated
 *     functions/firestore-backup.js against a bucket that was never
 *     created, and failed nightly for its whole life. See the D5 note
 *     below for the ADC-token pattern it used to carry.)
 *   - exportMyData             (D6) — GDPR Article 20 portability. A
 *                                     user requests their full data
 *                                     payload; we stream a JSON blob
 *                                     to Storage and return a signed URL.
 *   - requestAccountErasure +  (D7) — GDPR Article 17 right-to-be-
 *     confirmAccountErasure          forgotten. Two-step flow with
 *                                     a confirmation token so a stolen
 *                                     session can't nuke someone's data.
 */

'use strict';

const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('./heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { defineSecret } = require('firebase-functions/params');
const { cancelBillingForErasure, REFUSAL_MESSAGE: BILLING_REFUSAL } = require('./erasure-billing');
// Jo 2026-10-08: a TEAM MEMBER's erasure suspends instead of deleting (their
// records are the company's customers); see erasure-scope.js.
const {
  resolveErasureScope,
  belongsToOtherTenant,
  suspendMemberForErasure,
  OUTCOME_NOTE: MEMBER_OUTCOME_NOTE,
  SUSPEND_MESSAGE: MEMBER_SUSPEND_MESSAGE,
  OWNER_WITH_TEAM_MESSAGE,
} = require('./erasure-scope');
const { revokeMemberAccessTokens } = require('../member-offboarding');

// Stripe (2026-10-03): erasure cancels the user's subscription before it
// deletes the only record of it. Redeclared per module like stripe.js /
// seats.js (defineSecret scope is per-module; same Secret Manager entry).
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_API_VERSION = '2023-10-16'; // pinned, mirrors stripe.js
let _stripeClient = null;
function getStripe() {
  if (_stripeClient) return _stripeClient;
  const raw = STRIPE_SECRET_KEY.value();
  const key = String(raw == null ? '' : raw).trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is empty/unset');
  const Stripe = require('stripe');
  _stripeClient = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20000 });
  return _stripeClient;
}

// M-01/M-02: single source of truth for what "user-owned" means.
// Erasure cascade + Article 20 export both import from here so the
// two cannot drift (historical bug: the original lists were inlined
// and diverged — erasure knew 7 collections, export knew 9).
const {
  FLAT_USER_COLLECTIONS,
  COLLECTION_GROUPS_WITH_USERID,
  STORAGE_PREFIXES,
  ERASURE_RETAINED_PREFIXES,
  ERASURE_STORAGE_PREFIXES,
  OWNER_KEYED_DOCS,
  NESTED_LEADS_PATH,
} = require('./user-owned');

// ─── RETENTION-HOLD DISCLOSURE ──────────────────────────────
// Human wording for each ERASURE_RETAINED_PREFIXES entry, used on the
// consent page and in the deletion receipt. A prefix with no label falls
// back to its raw name rather than being dropped: an unlabelled hold is
// still a hold, and must still be disclosed. Consent to "delete
// everything" is not consent to a carve-out nobody mentioned.
const RETAINED_PREFIX_LABELS = {
  esign: 'signed contracts and the envelopes they were signed in',
};

function describeRetained() {
  const labels = ERASURE_RETAINED_PREFIXES.map(p => RETAINED_PREFIX_LABELS[p] || p);
  if (!labels.length) return '';
  return 'We keep your ' + labels.join('; ') + '. Both sides signed those, so they '
    + 'stay on file as the record of the agreement — they are included in your data '
    + 'export, and nothing else survives this.';
}

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app'
];

// ─── D4: audit_log retention ────────────────────────────────
// 7 years is a common choice:
//   - HIPAA     → 6 years (not applicable here, but a good floor)
//   - SOX       → 7 years
//   - IRS       → 7 years for business records
//   - GDPR      → "no longer than necessary" — 7y is defensible
//                 for contractor tax / dispute reasons.
// Override with AUDIT_LOG_RETENTION_DAYS env var if needed.
const AUDIT_LOG_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS) || (7 * 365);

exports.auditLogRetentionCron = onSchedule(
  {
    region: 'us-central1',
    schedule: 'every day 03:30',
    timeZone: 'America/Chicago',
    timeoutSeconds: 540,
    memory: '256MiB'
  },
  async () => {
    const db = getFirestore();
    const cutoff = Timestamp.fromMillis(
      Date.now() - AUDIT_LOG_RETENTION_DAYS * 86_400_000
    );

    // Page through 500-doc batches. Firestore doesn't return > 500
    // docs/query and batch writes cap at 500 ops — match them.
    let deleted = 0;
    let lastDocRef = null;
    for (let page = 0; page < 20; page++) {  // 10k/day max
      let q = db.collection('audit_log').where('ts', '<', cutoff).orderBy('ts').limit(500);
      if (lastDocRef) q = q.startAfter(lastDocRef);
      const snap = await q.get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      lastDocRef = snap.docs[snap.docs.length - 1];
      if (snap.size < 500) break;
    }
    logger.info('auditLogRetentionCron', { deleted, retentionDays: AUDIT_LOG_RETENTION_DAYS });
  }
);

// ─── D5: nightly Firestore → GCS backup — RETIRED 2026-09-05 ─
// `nightlyFirestoreBackup` used to live here: a second, overlapping
// Firestore export targeting gs://nobigdeal-pro-backups on a daily
// 04:00 CT schedule. That bucket was never created, deliberately —
// it had no retention job, so it would have grown without bound while
// duplicating functions/firestore-backup.js, which already exports to
// gs://nobigdeal-pro-firestore-backups AND prunes to 30 days.
//
// So it failed every night from the day it shipped. FUNCTIONS_INDEX.md
// had already reached the verdict ("retire it rather than fix it");
// this removal carries that out. `backupFreshnessCron` is unaffected —
// it watches the artifact in the WORKING bucket, and its alert policy
// matches backupFreshnessCron's own log line, never this function.
//
// It was also the only place in functions/ that took an ADC token from
// google-auth-library and called a Google REST API with fetch. If you
// need that pattern again (the wave-2 map cites it for the GA4 Data API
// and Search Console), it is in git history — find the commit that
// deleted it and read the parent:
//   git log --diff-filter=D -S nightlyFirestoreBackup -- functions/integrations/compliance.js

// ─── D6: GDPR Article 20 — portability / export ──────────────
// User requests a full JSON dump of the data tied to their uid.
// We stream into a Storage object under gdpr_exports/{uid}/{ts}.json
// and return a 24-hour signed URL. Rate-limited aggressively.
exports.exportMyData = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 540,
    memory: '1GiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    // Aggressive cap — GDPR is a once-a-month-ish activity, not a
    // beacon. 2 exports per 24h per uid ought to cover legit use.
    const rl = require('./upstash-ratelimit');
    try {
      await rl.enforceRateLimit('exportMyData:uid', uid, 2, 24 * 3_600_000);
    } catch (e) {
      if (e.rateLimited) {
        throw new HttpsError('resource-exhausted', 'Only 2 exports per 24h allowed.');
      }
      throw e;
    }

    const db = getFirestore();
    const out = {
      uid,
      generatedAt: new Date().toISOString(),
      collections: {},
      ownerDocs: {},
      storage: {},
    };

    // M-02: pull the registry so export + erasure can never drift.
    //   (1) flat user-owned collections (per-row userId / createdBy)
    //   (2) collectionGroups that stamp userId
    //   (3) nested-leads subtree (listed inline below)
    //   (4) Storage prefixes — metadata + 24h signed download URLs
    //   (5) owner-keyed `{uid}`-path docs
    //   (6) api_usage (last 90d, admin-SDK only, keyed on `uid`)

    // ── (1) flat collections ──
    for (const spec of FLAT_USER_COLLECTIONS) {
      const ownerField = spec.ownerField || 'userId';
      try {
        const snap = await db.collection(spec.name).where(ownerField, '==', uid).get();
        out.collections[spec.name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (e) {
        out.collections[spec.name] = { error: e.message };
      }
    }

    // ── (2) collectionGroup sweeps ──
    for (const group of COLLECTION_GROUPS_WITH_USERID) {
      try {
        const snap = await db.collectionGroup(group).where('userId', '==', uid).get();
        out.collections[group] = snap.docs.map(d => ({
          path: d.ref.path, ...d.data()
        }));
      } catch (e) {
        out.collections[group] = { error: e.message };
      }
    }

    // ── (3) nested-leads subtree ──
    // Firestore doesn't offer a single-call subtree read, but the
    // collectionGroups above catch `activity` and `recordings`; the
    // nested-leads parent (`leads/{uid}/leads/*`) is the remaining
    // surface. List its direct children and dump anything found.
    try {
      const nestedParent = db.doc(NESTED_LEADS_PATH(uid));
      const children = await nestedParent.listCollections();
      const nested = {};
      for (const childColl of children) {
        const snap = await childColl.limit(5000).get();
        nested[childColl.id] = snap.docs.map(d => ({
          path: d.ref.path, ...d.data()
        }));
      }
      if (Object.keys(nested).length) out.collections.nested_leads = nested;
    } catch (e) {
      out.collections.nested_leads = { error: e.message };
    }

    // ── (3b) flat-lead subcollections ──
    // Phase-2.1: leads/{leadId}/{tasks,notes,documents,drawings,
    // portal_messages} hold homeowner project detail but don't all stamp
    // userId, so the collectionGroup sweep above misses them. Walk each
    // owned lead's subcollections so the export matches what erasure now
    // removes. Bounded to the user's own leads (rate-limited 2/24h path).
    try {
      const ownedLeads = Array.isArray(out.collections.leads) ? out.collections.leads : [];
      const leadSubs = {};
      for (const lead of ownedLeads.slice(0, 2000)) {
        if (!lead || !lead.id) continue;
        const subCols = await db.doc('leads/' + lead.id).listCollections();
        for (const sc of subCols) {
          const s = await sc.limit(2000).get();
          if (s.empty) continue;
          leadSubs[lead.id] = leadSubs[lead.id] || {};
          leadSubs[lead.id][sc.id] = s.docs.map(d => ({ id: d.id, ...d.data() }));
        }
      }
      if (Object.keys(leadSubs).length) out.collections.lead_subcollections = leadSubs;
    } catch (e) {
      out.collections.lead_subcollections = { error: e.message };
    }

    // ── (4) Storage prefix listing ──
    // Include object metadata + a 24h signed download URL per file so
    // the user can actually retrieve their binary payload. Caps at
    // 1000 files per prefix to stop a pathological upload history
    // from blowing the export timeout; users over that limit get a
    // `truncated: true` marker per prefix.
    try {
      const bucket = getStorage().bucket();
      for (const prefix of STORAGE_PREFIXES) {
        try {
          const [files] = await bucket.getFiles({
            prefix: prefix + '/' + uid + '/',
            maxResults: 1001,
          });
          const truncated = files.length > 1000;
          const slice = files.slice(0, 1000);
          const entries = await Promise.all(slice.map(async f => {
            let url = null;
            try {
              const [signed] = await f.getSignedUrl({
                action: 'read',
                expires: Date.now() + 24 * 3_600_000,
                version: 'v4',
              });
              url = signed;
            } catch (_) { /* signing failure non-fatal for export */ }
            return {
              name: f.name,
              size: f.metadata && Number(f.metadata.size) || 0,
              contentType: f.metadata && f.metadata.contentType || null,
              updated: f.metadata && f.metadata.updated || null,
              downloadUrl: url,
            };
          }));
          out.storage[prefix] = { count: entries.length, truncated, files: entries };
        } catch (e) {
          out.storage[prefix] = { error: e.message };
        }
      }
    } catch (e) {
      out.storage._error = e.message;
    }

    // ── (5) owner-keyed {uid}-path docs ──
    for (const coll of OWNER_KEYED_DOCS) {
      try {
        const s = await db.doc(coll + '/' + uid).get();
        out.ownerDocs[coll] = s.exists ? s.data() : null;
      } catch (e) {
        out.ownerDocs[coll] = { error: e.message };
      }
    }
    // Alias `profile` / `subscription` at the top level for backwards
    // compat with the previous export shape (clients may parse them).
    out.profile = out.ownerDocs.users || null;
    out.subscription = out.ownerDocs.subscriptions || null;

    // ── (5b) users/{uid} SUBCOLLECTIONS ──
    // The owner-doc .get() above returns only the document's own fields,
    // not its subcollections. users/{uid} carries personal data in
    // subcollections — captures (Talk Tank voice transcripts + AI
    // summaries with extracted people/addresses/amounts), notificationLogs,
    // fcmTokens — which the ERASURE path recursiveDeletes (Article 17), so
    // the Article-20 export must return them too or the two are asymmetric.
    // listCollections() future-proofs this: any new users/{uid}
    // subcollection is exported without a code change here.
    try {
      const userSubs = {};
      const children = await db.doc('users/' + uid).listCollections();
      for (const childColl of children) {
        const snap = await childColl.get();
        userSubs[childColl.id] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      if (Object.keys(userSubs).length) out.collections.user_subcollections = userSubs;
    } catch (e) {
      out.collections.user_subcollections = { error: e.message };
    }

    // ── (6) api_usage (last 90 days) ──
    try {
      const since = Timestamp.fromMillis(Date.now() - 90 * 86_400_000);
      const snap = await db.collection('api_usage')
        .where('uid', '==', uid)
        .where('timestamp', '>', since)
        .get();
      out.collections.api_usage = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { out.collections.api_usage = { error: e.message }; }

    // Serialize Firestore Timestamps to ISO.
    const replacer = (k, v) => {
      if (v && typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().toISOString();
      return v;
    };
    const body = Buffer.from(JSON.stringify(out, replacer, 2), 'utf8');

    // Write to Storage under docs/{uid}/... so the existing rules
    // apply (owner read).
    const bucket = getStorage().bucket();
    const objectName = `docs/${uid}/gdpr-export-${Date.now()}.json`;
    const file = bucket.file(objectName);
    await file.save(body, {
      contentType: 'application/json',
      metadata: { cacheControl: 'private, max-age=0, no-store' }
    });
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 3_600_000,
      version: 'v4'
    });

    logger.info('exportMyData', { uid, bytes: body.length });
    return {
      success: true,
      url,
      expiresIn: 24 * 3600,
      bytes: body.length,
      collections: Object.keys(out.collections)
    };
  }
);

// ─── D7: GDPR Article 17 — right-to-be-forgotten ─────────────
// Two-step flow. Step 1 (request) mints a 24h confirmation token and
// emails it to the account-on-file. Step 2 (confirm) accepts the
// token and performs cascade deletion + Auth account disable.
//
// Why two-step: an attacker with a stolen session token could call
// an immediate-delete endpoint and permanently destroy the victim's
// data before they re-auth. The email confirmation loop forces the
// attacker to also compromise the email inbox.
exports.requestAccountErasure = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const rl = require('./upstash-ratelimit');
    try { await rl.enforceRateLimit('requestErasure:uid', uid, 3, 24 * 3_600_000); }
    catch (e) { if (e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many erasure requests.'); throw e; }

    const db = getFirestore();
    // Who is asking decides what the confirmation email promises (the confirm
    // step re-resolves; this is for honest copy and an early refusal).
    let scope;
    try {
      scope = await resolveErasureScope({ db, auth: getAuth(), uid });
    } catch (e) {
      logger.error('requestAccountErasure: scope lookup failed', { uid, err: e.message });
      throw new HttpsError('unavailable', 'Could not check your account. Please try again.');
    }
    if (scope.mode === 'owner_with_team') {
      throw new HttpsError('failed-precondition', OWNER_WITH_TEAM_MESSAGE);
    }
    const isMember = scope.mode === 'member';

    const token = crypto.randomBytes(32).toString('hex');
    const hash  = crypto.createHash('sha256').update(token).digest('hex');
    await db.doc('account_erasures/' + uid).set({
      tokenHash: hash,
      requestedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 24 * 3_600_000),
      confirmed: false,
      mode: scope.mode,
      companyId: scope.companyId,
    });

    // Email the link. The email-functions module is already wired
    // with Resend — we just enqueue a send job.
    //
    // R4-7-2 (2026-10-06): this used to swallow every failure here (and a
    // missing email) and still answer { success: true }, so the person was
    // told a confirmation was on its way when none could ever arrive. Both
    // cases now throw, so the client shows an error and the person can retry
    // or contact support. Re-requesting is safe: it overwrites the token.
    let email = null;
    try {
      const userRecord = await getAuth().getUser(uid);
      email = userRecord.email || null;
    } catch (e) {
      logger.error('requestAccountErasure: account lookup failed', { uid, err: e.message });
      throw new HttpsError('unavailable', 'Could not send the confirmation email. Please try again.');
    }
    if (!email) {
      logger.error('requestAccountErasure: account has no email on file', { uid });
      throw new HttpsError('failed-precondition',
        'This account has no email address on file, so a confirmation link cannot be sent. Contact support to delete the account.');
    }
    try {
      const confirmUrl =
        'https://nobigdealwithjoedeal.com/pro/account-erasure?uid=' +
        encodeURIComponent(uid) + '&token=' + encodeURIComponent(token);
      await db.collection('email_queue').add({
        to: email,
        subject: 'Confirm account deletion — NBD Pro',
        bodyPlain:
          'You (or someone using your account) requested that your NBD Pro account be permanently deleted.\n\n' +
          (isMember
            ? 'You are on a team, so confirming SUSPENDS your account instead of deleting it: you can no longer sign in, '
              + 'and the customer records you worked on stay with your company, along with your account information. '
              + 'Only your company owner or an admin can turn the account back on.\n\n'
            : '') +
          'To confirm, open this link within 24 hours:\n' +
          confirmUrl + '\n\n' +
          'If you did not make this request, you can ignore this email — your account will remain active.',
        status: 'pending',   // F-wave fix: worker query filters by status
        createdAt: FieldValue.serverTimestamp(),
        source: 'requestAccountErasure'
      });
    } catch (e) {
      logger.error('requestAccountErasure: email enqueue failed', { uid, err: e.message });
      throw new HttpsError('unavailable', 'Could not send the confirmation email. Please try again.');
    }

    return { success: true, mode: scope.mode };
  }
);

// F-01: GET no longer triggers deletion.
//
// The previous implementation accepted GET with (uid, token) in the query
// string and ran the full cascade-delete. Enterprise mail scanners
// (Microsoft Defender SafeLinks, Gmail image proxy, Slack unfurler,
// Mimecast / Proofpoint URL Defense, corporate AV gateways) pre-fetch
// every link in inbound email to check for phishing — which silently
// fired erasure against legit users the moment the confirmation email
// arrived. No recovery path.
//
// New flow:
//   GET  → renders a static HTML confirmation page. Zero state change.
//          Scanners can pre-fetch all they want.
//   POST → verifies token, runs cascade delete. Per-IP + per-uid rate
//          limited; token lives only in request body, not URL.
//
// The email link still contains (uid, token) in the URL because the
// landing page needs them to render the confirm button. The token
// being in logs is accepted — exploitation still requires the human
// POST that only a real click can produce.
exports.confirmAccountErasure = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    // The POST cancels the user's Stripe subscription before erasing.
    secrets: [STRIPE_SECRET_KEY],
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async (req, res) => {
    // Block indexing of the landing page in all paths.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if (req.method === 'GET') {
      // L-04: the GET is stateless (serves a static HTML confirmation
      // page) but still returns ~3KB of inline HTML/CSS/JS per call.
      // An attacker hammering this for bandwidth-DoS costs the
      // function-instance pool and Cloud Run egress. 60/min/IP is
      // plenty for a real user (one confirmation email = one page
      // load) and cheap to enforce. Uses the same Upstash-or-fallback
      // path as the POST's rate limit below.
      const rl = require('./upstash-ratelimit');
      if (!(await rl.httpRateLimit(req, res, 'confirmErasureGet:ip', 60, 60_000))) return;

      // Show confirmation page. NO state change — safe for scanner pre-fetch.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // CSP hardens the inline script we ship below.
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; base-uri 'none'; object-src 'none'; " +
        "frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self';");
      // Light sanity check — we do NOT validate the token itself on GET.
      const uidQ   = String(req.query.uid   || '');
      const tokenQ = String(req.query.token || '');
      const safeUid   = uidQ.slice(0, 128).replace(/[^A-Za-z0-9:_-]/g, '');
      const safeToken = tokenQ.slice(0, 256).replace(/[^A-Za-z0-9_-]/g, '');
      // Disclosed BEFORE the button, not after the fact. The paragraph below
      // used to promise this "removes all your ... documents", which stopped
      // being true the moment esign/ went on the retention list. Derived from
      // ERASURE_RETAINED_PREFIXES so the promise and the behaviour cannot
      // drift apart — empty list, no sentence, no stale caveat.
      const retainedSentence = describeRetained();
      const retainedHtml = retainedSentence
        ? '<p><strong>One exception.</strong> '
          + retainedSentence.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
          + '</p>'
        : '';
      res.status(200).send(
        '<!doctype html><html lang="en"><head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta name="robots" content="noindex,nofollow">' +
        '<title>Confirm account deletion — NBD Pro</title>' +
        '<style>' +
        'body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#e8eaf0;background:#0d1117;}' +
        'h1{color:#ff4e4e;margin-bottom:8px}' +
        'p{line-height:1.5;color:#cfd3dc}' +
        'button{background:#ff4e4e;color:#fff;border:0;padding:14px 22px;font-size:16px;border-radius:6px;cursor:pointer;font-weight:600}' +
        'button:disabled{background:#555;cursor:wait}' +
        '.cancel{display:inline-block;margin-left:12px;color:#9aa3b2;text-decoration:none}' +
        '#status{margin-top:20px;padding:12px;border-radius:6px;display:none}' +
        '.ok{background:rgba(46,204,138,.15);color:#2ecc8a;display:block!important}' +
        '.err{background:rgba(255,78,78,.15);color:#ff6b6b;display:block!important}' +
        '</style></head><body>' +
        '<h1>Permanently delete your NBD Pro account?</h1>' +
        '<p>This cancels any active NBD Pro subscription (billing stops immediately) and removes your leads, estimates, photos, pins, tasks, documents, training sessions, profile, and subscription record. ' +
        'Your Auth account is disabled. This cannot be undone.</p>' +
        retainedHtml +
        '<p><strong>On a team?</strong> If you work under another person\'s company, nothing is deleted: ' +
        'your account is suspended instead. You can no longer sign in, the customer records you worked on stay ' +
        'with your company along with your account information, and only your company owner or an admin can turn ' +
        'the account back on.</p>' +
        '<p>If you did not request this, simply close this tab — nothing will happen.</p>' +
        '<form id="f"><button id="b" type="submit">Yes, delete my account</button>' +
        '<a class="cancel" href="/pro/dashboard.html">Cancel</a></form>' +
        '<div id="status"></div>' +
        '<script>(function(){' +
        'var uid=' + JSON.stringify(safeUid) + ';' +
        'var token=' + JSON.stringify(safeToken) + ';' +
        'var retainedMsg=' + JSON.stringify(retainedSentence ? ' ' + retainedSentence : '') + ';' +
        'var f=document.getElementById("f");var b=document.getElementById("b");var s=document.getElementById("status");' +
        'f.addEventListener("submit",function(ev){ev.preventDefault();b.disabled=true;b.textContent="Deleting...";' +
        'fetch(window.location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({uid:uid,token:token})})' +
        '.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}});})' +
        '.then(function(x){if(x.ok){s.className="ok";s.textContent=(x.d&&x.d.suspended)?(x.d.message||"Account suspended."):("Account deleted. You can close this tab."+retainedMsg);f.style.display="none";}' +
        'else{s.className="err";s.textContent=(x.d&&x.d.error)||"Deletion failed.";b.disabled=false;b.textContent="Yes, delete my account";}})' +
        '.catch(function(){s.className="err";s.textContent="Network error.";b.disabled=false;b.textContent="Yes, delete my account";});' +
        '});' +
        '})();</script></body></html>'
      );
      return;
    }

    if (req.method !== 'POST') { res.status(405).end(); return; }

    // Per-IP rate limit — soft (XFF is spoofable in Cloud Run, see
    // rate-limit.js:37). Defence in depth. Per-uid check below is the
    // real gate.
    const rl = require('./upstash-ratelimit');
    try {
      if (!(await rl.httpRateLimit(req, res, 'confirmErasure:ip', 10, 3_600_000))) return;
    } catch (e) {
      logger.error('confirmAccountErasure rate-limit error', { err: e.message });
      res.status(500).json({ error: 'Rate limiter error' });
      return;
    }

    const uid   = (req.body && req.body.uid)   || '';
    const token = (req.body && req.body.token) || '';
    if (typeof uid !== 'string' || typeof token !== 'string' || !uid || token.length < 32) {
      res.status(400).json({ error: 'Invalid request' }); return;
    }

    // Per-uid rate limit — a single target can't be pounded even if the
    // attacker rotates IPs. 5 attempts / hour / uid is well above human
    // need (normally a single click) and below any reasonable brute.
    try {
      await rl.enforceRateLimit('confirmErasure:uid', uid, 5, 3_600_000);
    } catch (e) {
      if (e.rateLimited) {
        res.status(429).json({ error: 'Too many attempts for this account.' });
        return;
      }
      logger.error('confirmAccountErasure per-uid rl error', { err: e.message });
      res.status(500).json({ error: 'Rate limiter error' });
      return;
    }

    const db = getFirestore();
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const reqRef = db.doc('account_erasures/' + uid);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) { res.status(404).json({ error: 'No pending request' }); return; }
    const data = reqSnap.data();
    if (data.confirmed) { res.status(410).json({ error: 'Already processed' }); return; }
    if (data.tokenHash !== hash) { res.status(403).json({ error: 'Invalid token' }); return; }
    // A PARTIAL erasure (the person already confirmed with this token, and
    // some steps failed) stays retryable with the same link past the 24h
    // window: they asked for erasure and must be able to finish it.
    if (!data.partial && data.expiresAt && data.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'Link expired' }); return;
    }

    // WHO is being erased, resolved now (not trusted from the request doc:
    // membership can change in the 24h window). Jo 2026-10-08: a team
    // member's records are the company's customers, so a member is SUSPENDED
    // and nothing is deleted; an owner whose company still has members is
    // refused; only a solo owner is erased. A lookup failure refuses with
    // nothing changed: guessing 'solo' would be the delete-everything branch.
    let scope;
    try {
      scope = await resolveErasureScope({ db, auth: getAuth(), uid });
    } catch (e) {
      logger.error('confirmAccountErasure: scope lookup failed, nothing changed', { uid, err: e && e.message });
      res.status(503).json({ error: 'Could not check your account right now. Nothing has been changed; open the same link again to retry.', code: 'scope_unavailable' });
      return;
    }
    if (scope.mode === 'owner_with_team') {
      res.status(409).json({ error: OWNER_WITH_TEAM_MESSAGE, code: 'owner_has_team', teamSize: scope.teamSize });
      return;
    }

    // Billing FIRST (2026-10-03, legal-checklist audit). The cascade below
    // deletes subscriptions/{uid} — the only record of the Stripe ids — so a
    // subscription left running here would keep charging a deleted user with
    // nothing left in the app that could find it. Cancel every live sub, or
    // refuse and delete NOTHING. Runs before `confirmed` is set, so a refused
    // request can simply be retried with the same link.
    const billing = await cancelBillingForErasure({ db, uid, getStripe, logger });
    if (!billing.ok) {
      logger.error('confirmAccountErasure: refused, billing not cancelled', { uid, reason: billing.reason });
      res.status(409).json({ error: BILLING_REFUSAL, code: 'billing_not_cancelled' });
      return;
    }

    // R4-7-1 (2026-10-06): `confirmed: true` used to be written HERE, before
    // the cascade, and every step below only logger.warn'ed on failure — so a
    // partial erasure answered 200 "Account deleted" and the link then said
    // "Already processed", with no way to finish. Now the attempt is stamped
    // here, failures are collected per step, and `confirmed` is set only when
    // every step succeeded. Every step is idempotent (deletes of what is
    // already gone are no-ops), so a retry with the same link simply re-runs
    // the cascade.
    await reqRef.update({
      lastAttemptAt: FieldValue.serverTimestamp()
    });

    // ── TEAM MEMBER: suspend, delete nothing (Jo 2026-10-08) ──
    // Their leads/estimates/invoices/photos... are the company's records and
    // stay exactly where they are (company-scoped, authorship kept); so does
    // their own profile and tracker data ("save all their info"). What goes
    // is ACCESS: bot keys + calendar feeds revoked, roster row deactivated
    // (reason 'self-erasure', which no self-serve or billing path restores),
    // Auth disabled, sessions revoked. The companyId claim is kept on purpose
    // so the owner or a company_admin can Re-enable them (deactivateUser
    // reactivate gates on that claim, same tenant, owner/admin only).
    if (scope.mode === 'member') {
      let suspended;
      try {
        suspended = await suspendMemberForErasure({
          db, auth: getAuth(), uid, scope,
          revokeTokens: revokeMemberAccessTokens,
          serverTimestamp: () => FieldValue.serverTimestamp(),
        });
      } catch (e) {
        const failure = { step: 'suspend', target: 'member', err: String((e && e.message) || e).slice(0, 300) };
        logger.error('confirmAccountErasure: member suspension failed, request left retryable', { uid, err: e && e.message });
        await reqRef.update({ confirmed: false, partial: true, mode: 'member', failures: [failure], lastFailedAt: FieldValue.serverTimestamp() });
        res.status(500).json({
          error: 'Your account could not be suspended yet. Nothing has been deleted: open the same link again to finish, or contact support.',
          code: 'suspend_failed', partial: true,
        });
        return;
      }
      await reqRef.update({
        confirmed: true,
        partial: false,
        failures: [],
        confirmedAt: FieldValue.serverTimestamp(),
        mode: 'member',
        outcome: 'suspended',
        outcomeNote: MEMBER_OUTCOME_NOTE,
        companyId: scope.companyId,
        deleted: false,
      });
      await db.collection('audit_log').add({
        type: 'gdpr_erasure_member_suspended',
        op: 'suspend',
        ids: { uid, companyId: scope.companyId },
        note: MEMBER_OUTCOME_NOTE,
        retained: 'all',
        revoked: { agentKeys: suspended.agentKeys || 0, calendarFeeds: suspended.calendarFeeds || 0 },
        roster: suspended.roster || null,
        stripeCancelled: billing.cancelled,
        ts: FieldValue.serverTimestamp()
      });
      res.status(200).json({ success: true, suspended: true, retained: 'all', message: MEMBER_SUSPEND_MESSAGE });
      return;
    }

    const failures = [];
    const fail = (step, target, e) => {
      failures.push({ step, target, err: String((e && e.message) || e).slice(0, 300) });
      logger.error('erasure: ' + step + ' failed for ' + target, { uid, err: e && e.message });
    };

    // M-01: cascade uses the canonical user-owned registry so the
    // surface stays synchronized with Article 20 export. Covers:
    //   (1) flat-path user-owned collections (per-row owner field,
    //       usually `userId` — `invoices` uses `createdBy`)
    //   (2) collectionGroup sweeps for subcollections whose rows
    //       carry `userId` (recordings, activity)
    //   (3) `leads/{uid}/leads/**` nested-leads subtree — vestigial
    //       but writable per firestore.rules:140-145; previously
    //       missed by the cascade entirely. `recursiveDelete` walks
    //       the whole subtree (doc + every child collection) in one
    //       Admin SDK call.
    //   (4) Owner-keyed Storage prefixes — ERASURE_STORAGE_PREFIXES,
    //       which is the Art. 15 export scope minus the documented
    //       Art. 17(3) retention holds (currently `esign/`)
    //   (5) Owner-keyed `{uid}`-path docs (users, subscriptions,
    //       userSettings, leaderboard, reps, estimate_drafts,
    //       feature_flags). `account_erasures/{uid}` intentionally
    //       NOT deleted — it's the audit trail for this operation.

    // Solo only from here. Tenant guard (2026-10-08): a doc carrying this uid
    // that belongs to ANOTHER company (its companyId, or the company of the
    // lead it hangs off) is kept, not deleted. Counted on the audit row.
    const ownCompany = scope.companyId;
    const leadCompany = new Map();
    const leadCompanyOf = async (leadId) => {
      if (!leadCompany.has(leadId)) {
        const s = await db.doc('leads/' + leadId).get();
        leadCompany.set(leadId, s.exists ? ((s.data() || {}).companyId || null) : null);
      }
      return leadCompany.get(leadId);
    };
    const keptForeign = {};
    const keep = (name) => { keptForeign[name] = (keptForeign[name] || 0) + 1; };
    // Pages with a cursor, because kept docs still match the query.
    async function sweep(name, makeQuery, deleteDocs) {
      let last = null;
      while (true) {
        let q = makeQuery();
        if (last) q = q.startAfter(last);
        const snap = await q.limit(500).get();
        if (snap.empty) break;
        const mine = [];
        for (const d of snap.docs) {
          const path = d.ref && d.ref.path;
          if (await belongsToOtherTenant(d.data(), path, ownCompany, leadCompanyOf)) keep(name);
          else mine.push(d);
        }
        if (mine.length) await deleteDocs(mine);
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < 500) break;
      }
    }

    // ── (1) flat-path collections ──
    for (const spec of FLAT_USER_COLLECTIONS) {
      const ownerField = spec.ownerField || 'userId';
      try {
        await sweep(spec.name, () => db.collection(spec.name).where(ownerField, '==', uid), async (docs) => {
          if (spec.recursive) {
            // Phase-2.1: recursiveDelete walks each doc + ALL its
            // subcollections. leads/{id}/{tasks,notes,documents,drawings,
            // portal_messages} don't all stamp userId, so a plain doc
            // delete (or the collectionGroup sweep below) would orphan
            // them — leaving homeowner project detail behind on erasure.
            for (const d of docs) await db.recursiveDelete(d.ref);
          } else {
            const batch = db.batch();
            docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
        });
      } catch (e) {
        fail('collection', spec.name, e);
      }
    }

    // ── (2) collectionGroup sweeps (subcollections with userId) ──
    for (const groupName of COLLECTION_GROUPS_WITH_USERID) {
      try {
        await sweep(groupName, () => db.collectionGroup(groupName).where('userId', '==', uid), async (docs) => {
          const batch = db.batch();
          docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        });
      } catch (e) {
        fail('collectionGroup', groupName, e);
      }
    }

    // ── (3) nested-leads recursive delete ──
    // recursiveDelete(docRef) walks the doc + every subcollection
    // (including activity/tasks/notes children of each nested lead)
    // with an internal BulkWriter. Available in firebase-admin v12+
    // via @google-cloud/firestore.
    try {
      await db.recursiveDelete(db.doc(NESTED_LEADS_PATH(uid)));
    } catch (e) {
      fail('recursiveDelete', 'nested-leads', e);
    }

    // Phase-2.1: daily-success entries live at daily_entries/{uid}/entries/*
    // — a uid-keyed subtree the registry didn't cover. recursiveDelete
    // wipes the parent doc + the entries subcollection.
    try {
      await db.recursiveDelete(db.doc('daily_entries/' + uid));
    } catch (e) {
      fail('recursiveDelete', 'daily_entries', e);
    }

    // ── (4) Storage prefix sweeps ──
    // ERASURE_STORAGE_PREFIXES, not STORAGE_PREFIXES: the export scope and
    // the erasure scope are deliberately different. Everything owner-keyed
    // is exportable; `esign/` (executed contracts) is held back under
    // ERASURE_RETAINED_PREFIXES. See the rationale in user-owned.js.
    try {
      const bucket = getStorage().bucket();
      for (const prefix of ERASURE_STORAGE_PREFIXES) {
        try {
          await bucket.deleteFiles({ prefix: prefix + '/' + uid + '/', force: true });
        } catch (e) {
          fail('storage', prefix, e);
        }
      }
    } catch (e) {
      fail('storage', 'bucket', e);
    }

    // ── (5) owner-keyed `{uid}`-path docs ──
    // recursiveDelete (not a plain .delete()) — `users/{uid}` carries
    // SUBCOLLECTIONS (notificationLogs/{id}, fcmTokens/{id} — both personal
    // data), and a plain doc delete leaves a subcollection's documents
    // ORPHANED in Firestore. recursiveDelete walks the doc + every child
    // collection; on the flat owner docs (subscriptions/userSettings/…) with
    // no subcollections it's just a doc delete, so it's safe across the board.
    for (const coll of OWNER_KEYED_DOCS) {
      try { await db.recursiveDelete(db.doc(coll + '/' + uid)); }
      catch (e) { fail('ownerDoc', coll, e); }
    }

    // Disable the Auth account (don't delete — we keep the uid so
    // future fraud investigations can correlate).
    try {
      await getAuth().updateUser(uid, { disabled: true });
      await getAuth().revokeRefreshTokens(uid);
    } catch (e) {
      // Already-deleted Auth user: nothing left to disable.
      if (!(e && e.code === 'auth/user-not-found')) fail('auth', 'disable', e);
    }

    // `retained` is recorded even when empty. A retention hold that isn't
    // written down is indistinguishable from a sweep that silently missed
    // the prefix — which is exactly the state this cascade was in before
    // 2026-09-08, when four prefixes were absent from the list and nothing
    // said whether that was policy or oversight. The audit row now answers
    // that question for every future erasure.
    if (failures.length) {
      // Partial: NOT confirmed. The audit row lists what is still there, the
      // request stays retryable with the same link (see the expiry check
      // above), and the person is told the truth instead of "deleted".
      await reqRef.update({
        confirmed: false,
        partial: true,
        failures,
        lastFailedAt: FieldValue.serverTimestamp()
      });
      await db.collection('audit_log').add({
        type: 'gdpr_erasure_partial',
        op: 'delete',
        ids: { uid },
        failures,
        retained: ERASURE_RETAINED_PREFIXES,
        keptOtherTenant: keptForeign,
        stripeCancelled: billing.cancelled,
        ts: FieldValue.serverTimestamp()
      });
      logger.error('confirmAccountErasure: PARTIAL erasure, request left retryable', { uid, failed: failures.length });
      res.status(500).json({
        error: 'Some of your data could not be deleted yet. Nothing is wrong with your request: '
          + 'open the same link again to finish, or contact support if it keeps failing.',
        code: 'erasure_partial',
        partial: true,
        failedSteps: failures.map((f) => f.step + ':' + f.target),
      });
      return;
    }

    await reqRef.update({
      confirmed: true,
      partial: false,
      failures: [],
      confirmedAt: FieldValue.serverTimestamp(),
      mode: 'solo',
      outcome: 'erased',
      keptOtherTenant: keptForeign,
    });

    await db.collection('audit_log').add({
      type: 'gdpr_erasure_confirmed',
      op: 'delete',
      ids: { uid },
      retained: ERASURE_RETAINED_PREFIXES,
      keptOtherTenant: keptForeign,
      stripeCancelled: billing.cancelled,
      ts: FieldValue.serverTimestamp()
    });

    // POST response: JSON. The GET landing page's inline JS uses this
    // to flip the UI into the success state. A direct POST from curl
    // gets a machine-readable acknowledgement.
    //
    // `retained` is surfaced to the data subject, not just logged: telling
    // someone their account was erased while quietly keeping their signed
    // contracts is the failure mode Art. 17(3) does NOT license. The carve-out
    // permits retention; it does not permit being silent about it.
    res.status(200).json({
      success: true,
      retained: ERASURE_RETAINED_PREFIXES,
    });
  }
);

module.exports = exports;
