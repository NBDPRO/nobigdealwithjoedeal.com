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

    const token = crypto.randomBytes(32).toString('hex');
    const hash  = crypto.createHash('sha256').update(token).digest('hex');
    const db = getFirestore();
    await db.doc('account_erasures/' + uid).set({
      tokenHash: hash,
      requestedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 24 * 3_600_000),
      confirmed: false
    });

    // Email the link. The email-functions module is already wired
    // with Resend — we just enqueue a send job.
    try {
      const userRecord = await getAuth().getUser(uid);
      const email = userRecord.email;
      const confirmUrl =
        'https://nobigdealwithjoedeal.com/pro/account-erasure?uid=' +
        encodeURIComponent(uid) + '&token=' + encodeURIComponent(token);
      if (email) {
        await db.collection('email_queue').add({
          to: email,
          subject: 'Confirm account deletion — NBD Pro',
          bodyPlain:
            'You (or someone using your account) requested that your NBD Pro account be permanently deleted.\n\n' +
            'To confirm, open this link within 24 hours:\n' +
            confirmUrl + '\n\n' +
            'If you did not make this request, you can ignore this email — your account will remain active.',
          status: 'pending',   // F-wave fix: worker query filters by status
          createdAt: FieldValue.serverTimestamp(),
          source: 'requestAccountErasure'
        });
      }
    } catch (e) {
      logger.warn('requestAccountErasure: email enqueue failed', { err: e.message });
    }

    return { success: true };
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
        '.then(function(x){if(x.ok){s.className="ok";s.textContent="Account deleted. You can close this tab."+retainedMsg;f.style.display="none";}' +
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
    if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'Link expired' }); return;
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

    // Mark confirmed BEFORE starting the delete so a crash/retry
    // can't double-run.
    await reqRef.update({
      confirmed: true,
      confirmedAt: FieldValue.serverTimestamp()
    });

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

    // ── (1) flat-path collections ──
    for (const spec of FLAT_USER_COLLECTIONS) {
      const ownerField = spec.ownerField || 'userId';
      try {
        while (true) {
          const snap = await db.collection(spec.name)
            .where(ownerField, '==', uid)
            .limit(500)
            .get();
          if (snap.empty) break;
          if (spec.recursive) {
            // Phase-2.1: recursiveDelete walks each doc + ALL its
            // subcollections. leads/{id}/{tasks,notes,documents,drawings,
            // portal_messages} don't all stamp userId, so a plain doc
            // delete (or the collectionGroup sweep below) would orphan
            // them — leaving homeowner project detail behind on erasure.
            for (const d of snap.docs) await db.recursiveDelete(d.ref);
          } else {
            const batch = db.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
          if (snap.size < 500) break;
        }
      } catch (e) {
        logger.warn('erasure: cascade failed for ' + spec.name, { err: e.message });
      }
    }

    // ── (2) collectionGroup sweeps (subcollections with userId) ──
    for (const groupName of COLLECTION_GROUPS_WITH_USERID) {
      try {
        while (true) {
          const snap = await db.collectionGroup(groupName)
            .where('userId', '==', uid)
            .limit(500)
            .get();
          if (snap.empty) break;
          const batch = db.batch();
          snap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
          if (snap.size < 500) break;
        }
      } catch (e) {
        logger.warn('erasure: collectionGroup cascade failed for ' + groupName,
          { err: e.message });
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
      logger.warn('erasure: nested-leads recursiveDelete failed',
        { uid, err: e.message });
    }

    // Phase-2.1: daily-success entries live at daily_entries/{uid}/entries/*
    // — a uid-keyed subtree the registry didn't cover. recursiveDelete
    // wipes the parent doc + the entries subcollection.
    try {
      await db.recursiveDelete(db.doc('daily_entries/' + uid));
    } catch (e) {
      logger.warn('erasure: daily_entries recursiveDelete failed', { uid, err: e.message });
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
          logger.warn('erasure: storage sweep failed for ' + prefix, { err: e.message });
        }
      }
    } catch (e) {
      logger.warn('erasure: storage bucket unavailable', { err: e.message });
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
      catch (e) { logger.warn('erasure: owner-doc delete failed for ' + coll, { err: e.message }); }
    }

    // Disable the Auth account (don't delete — we keep the uid so
    // future fraud investigations can correlate).
    try {
      await getAuth().updateUser(uid, { disabled: true });
      await getAuth().revokeRefreshTokens(uid);
    } catch (e) {
      logger.warn('erasure: auth disable failed', { err: e.message });
    }

    // `retained` is recorded even when empty. A retention hold that isn't
    // written down is indistinguishable from a sweep that silently missed
    // the prefix — which is exactly the state this cascade was in before
    // 2026-09-08, when four prefixes were absent from the list and nothing
    // said whether that was policy or oversight. The audit row now answers
    // that question for every future erasure.
    await db.collection('audit_log').add({
      type: 'gdpr_erasure_confirmed',
      op: 'delete',
      ids: { uid },
      retained: ERASURE_RETAINED_PREFIXES,
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
