/**
 * functions/deal-acceptance.js — Close Board deal acceptance (1a)
 *
 * Lets a rep share a Close Board deal room with a homeowner who can pick a
 * tier, sign, and ACCEPT remotely (no login) — and have that acceptance
 * actually recorded. Previously the deal-room's ACCEPT button was a
 * console.log stub (the success overlay showed but nothing persisted).
 *
 * Mirrors the audited remote-signing.js / portal.js token model:
 *   - deal_accept_tokens/{token} is admin-SDK only (firestore.rules)
 *   - token = 24 chars over a 32-char no-confusable alphabet (~120 bits),
 *     infeasible to brute-force against the per-IP rate limit
 *   - 14-day server-checked expiry; SINGLE-USE (burned atomically on accept)
 *
 * Exports:
 *   createDealAcceptToken (onCall)    — rep mints a token for a deal they own
 *                                       (the deal-room HTML must already be in
 *                                       Storage at deal_rooms/<uid>/<id>.html)
 *   getDealRoom           (onRequest) — /deal/<token> → serves that HTML,
 *                                       same-origin, with the token injected
 *   submitDealAcceptance  (onRequest) — homeowner POSTs token + tier + signature
 *                                       → burns the token, records the acceptance
 *                                       on the deal, notifies the rep
 *
 * Served first-party via hosting rewrites (/deal/** + /api/deal-accept) so the
 * accept POST is same-origin — NOT cross-origin from a raw Storage URL (which
 * would be CORS-blocked). Mirrors the /share/** → shareSSR pattern.
 *
 * Security exception: getDealRoom + submitDealAcceptance are NOT App-Check or
 * Firebase-auth gated — that's the whole point of a no-login accept link.
 * Compensating controls: unguessable token + 14-day expiry + single-use burn
 * + per-IP rate limit + server-side tier-price snapshot + signature size cap.
 */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const { callableRateLimit, assertNotViewer } = require('./shared');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];
const DEAL_URL_BASE = 'https://nobigdealwithjoedeal.com/deal/';
const SUBMIT_PATH = '/api/deal-accept'; // same-origin hosting rewrite → submitDealAcceptance

const VALID_TIERS = ['good', 'better', 'best'];

// 32-char no-confusable alphabet (no 0/O, 1/I/L) — same as portal.js / remote-signing.js.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════════════════════════
// createDealAcceptToken — rep mints a single-use accept token.
// ═══════════════════════════════════════════════════════════════
exports.createDealAcceptToken = onCall(
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
    // 2026-09-25 (decision B): a viewer is read-only — no deal-room accept
    // link minted, even for a deal the viewer owns (the owner check below).
    assertNotViewer(request.auth.token);
    // A compromised rep session could otherwise mint tokens in a loop.
    await callableRateLimit(request, 'createDealAcceptToken', 30, 60_000);

    const d = request.data || {};
    const dealId = typeof d.dealId === 'string' ? d.dealId : null;
    if (!dealId || !/^[A-Za-z0-9_-]{6,64}$/.test(dealId)) {
      throw new HttpsError('invalid-argument', 'A valid dealId is required');
    }

    const db = getFirestore();
    // Owner-scope: the rep must own the deal (or be platform admin).
    const dealSnap = await db.doc(`deal_rooms/${dealId}`).get();
    if (!dealSnap.exists) throw new HttpsError('not-found', 'Deal not found');
    const deal = dealSnap.data();
    const isAdmin = request.auth.token.role === 'admin';
    if (deal.userId !== uid && !isAdmin) throw new HttpsError('permission-denied', 'Not your deal');

    // The interactive deal-room HTML must already be uploaded to Storage by
    // the client (uploadDealPage → deal_rooms/<uid>/<dealId>.html). We serve
    // THAT, not arbitrary HTML.
    const htmlPath = `deal_rooms/${deal.userId}/${dealId}.html`;

    // Snapshot the tier prices server-side so the recorded acceptance price
    // can't be tampered with via the (unauthenticated) accept payload.
    const tiers = deal.tiers || {};
    const tierPrices = {
      good: Number(tiers.good && tiers.good.price) || 0,
      better: Number(tiers.better && tiers.better.price) || 0,
      best: Number(tiers.best && tiers.best.price) || 0,
    };

    const now = Date.now();
    const ttlDays = 14;
    const expiresAt = Timestamp.fromMillis(now + ttlDays * 86_400_000);
    const token = mintToken();

    await db.doc(`deal_accept_tokens/${token}`).set({
      dealId,
      ownerUid: deal.userId,
      companyId: deal.companyId || deal.userId,
      leadId: deal.leadId || null,
      customerName: String(deal.customerName || '').slice(0, 120),
      htmlPath,
      tierPrices,
      status: 'pending',
      mintedBy: uid,
      mintedAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    logger.info('[createDealAcceptToken] minted', { dealId });
    return { token, acceptUrl: DEAL_URL_BASE + token, expiresAt: expiresAt.toMillis() };
  }
);

// ═══════════════════════════════════════════════════════════════
// getDealRoom — /deal/<token> → serve the interactive deal-room HTML.
// ═══════════════════════════════════════════════════════════════
exports.getDealRoom = onRequest(
  {
    region: 'us-central1',
    maxInstances: 40,
    concurrency: 40,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    const errPage = (code, msg) => {
      res.status(code).set('Content-Type', 'text/html; charset=utf-8').set('X-Robots-Tag', 'noindex, nofollow')
        // Neutral <title> — this error/edge page (invalid / expired /
        // already-accepted) is served for EVERY tenant's /deal/<token> link, so
        // it must never assert NBD's identity on a stranger tenant's customer-
        // facing tab / link-preview. Matches the neutral-error pattern of the
        // sibling SSR surfaces (report-sharing.js 'Inspection Report',
        // share-ssr.js 'Link unavailable').
        .send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Deal</title><body style="font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><div style="font-size:44px">🤝</div><p style="max-width:420px;line-height:1.6;font-size:16px">${escHtml(msg)}</p></div></body>`);
    };
    // token is the last path segment: /deal/<token>
    const m = (req.path || '').match(/\/deal\/([A-Za-z0-9]{10,64})\/?$/);
    const token = m ? m[1] : '';
    if (!token) { errPage(400, 'This deal link is invalid.'); return; }
    // Per-IP rate limit — stops token brute-forcing.
    if (!(await httpRateLimit(req, res, 'dealroom-get:ip', 30, 60_000))) return;

    const db = getFirestore();
    const tokSnap = await db.doc(`deal_accept_tokens/${token}`).get();
    if (!tokSnap.exists) { errPage(404, 'This deal link is invalid.'); return; }
    const tok = tokSnap.data();
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      errPage(410, 'This deal link has expired. Ask your rep for a fresh one.'); return;
    }
    if (tok.status !== 'pending') {
      errPage(410, 'This deal has already been accepted — your rep will reach out to confirm your installation.'); return;
    }
    // A rep can delete a deal room after minting its accept link (Close Board
    // "Remove" doesn't touch deal_accept_tokens). Without this check, the
    // fire-and-forget stamp below RECREATES deal_rooms/{dealId} via set(merge)
    // on a doc that no longer exists — a stale link brings a removed deal back
    // to life just by being opened.
    const dealRoomSnap = await db.doc(`deal_rooms/${tok.dealId}`).get();
    if (!dealRoomSnap.exists) {
      errPage(410, 'This deal is no longer available. Ask your rep for an update.'); return;
    }

    // Fire-and-forget viewed stamps (do not gate the response). update(), not
    // set(merge) — the doc is confirmed to exist above, and update() throws
    // (caught below) instead of silently recreating it if it's deleted in the
    // narrow window between that check and this write.
    db.doc(`deal_accept_tokens/${token}`).update({ viewedAt: FieldValue.serverTimestamp() }).catch(() => {});
    db.doc(`deal_rooms/${tok.dealId}`).update({ status: 'viewed', viewedAt: FieldValue.serverTimestamp() }).catch(() => {});

    let html = '';
    try {
      const [buf] = await getStorage().bucket().file(tok.htmlPath).download();
      html = buf.toString('utf8');
    } catch (e) {
      logger.error('[getDealRoom] html fetch failed', { token: token.slice(0, 6), err: e.message });
      errPage(500, 'We could not load this deal right now. Please try again shortly.'); return;
    }

    // Inject the token + same-origin submit endpoint so the page's ACCEPT
    // button can record the acceptance. The deal-room's submitDeal() reads
    // window.__NBD_DEAL_TOKEN / __NBD_DEAL_SUBMIT_URL. Injected before </head>.
    // Meta tags FIRST: the hosting-layer CSP (script-src-elem 'self' ...,
    // script-src-attr 'none') blocks the legacy inline <script> inject, so
    // token + submit URL never reached the page and the customer's ACCEPT
    // was inert. deal-room.js (external, CSP-allowed) reads the metas. The
    // inline script is kept as a fallback for any serving path without the
    // strict CSP (it is simply ignored where the CSP applies). Tokens are
    // hex, but escape for the attribute anyway.
    const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const inject = `<meta name="nbd-deal-token" content="${escAttr(token)}">`
      + `<meta name="nbd-deal-submit" content="${escAttr(SUBMIT_PATH)}">`
      + `<script>window.__NBD_DEAL_TOKEN=${JSON.stringify(token)};window.__NBD_DEAL_SUBMIT_URL=${JSON.stringify(SUBMIT_PATH)};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;

    res.status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .set('Cache-Control', 'no-store')
      .send(html);
  }
);

// ═══════════════════════════════════════════════════════════════
// submitDealAcceptance — homeowner accepts → burn token + record.
// ═══════════════════════════════════════════════════════════════
exports.submitDealAcceptance = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 40,
    concurrency: 40,
    timeoutSeconds: 20,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'dealaccept-submit:ip', 20, 60_000))) return;

    const b = req.body || {};
    const token = typeof b.token === 'string' ? b.token : '';
    const tier = typeof b.tier === 'string' ? b.tier : '';
    const signature = typeof b.signature === 'string' ? b.signature : '';
    // financing is a numeric index from the client (-1 = pay in full). Coerce
    // to a number or null — never persist free-text from the unauthenticated
    // wire (defends a future renderer against a stored-XSS payload here).
    const financing = Number.isFinite(Number(b.financing)) ? Number(b.financing) : null;
    const scheduledDate = typeof b.scheduledDate === 'string' ? b.scheduledDate.slice(0, 40) : '';

    // Charset-validate the token BEFORE it becomes a Firestore doc-path segment
    // — a '/' would otherwise make db.doc() throw an uncaught 500. Mirrors
    // getDealRoom's [A-Za-z0-9]{10,64} check.
    if (!/^[A-Za-z0-9]{10,64}$/.test(token)) { res.status(400).json({ error: 'Invalid link' }); return; }
    if (!VALID_TIERS.includes(tier)) { res.status(400).json({ error: 'Please choose a package first' }); return; }
    // Signature is a canvas PNG dataURL — require it and allow ONLY base64 body
    // chars after the prefix (blocks a "><svg ...> attribute breakout if a
    // future rep-facing view ever renders it). Size-capped (a drawn signature
    // is tens of KB; anything huge is abuse).
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length < 200) {
      res.status(400).json({ error: 'A signature is required' }); return;
    }
    if (signature.length > 600 * 1024) { res.status(413).json({ error: 'Signature too large' }); return; }

    const db = getFirestore();
    const tokRef = db.doc(`deal_accept_tokens/${token}`);

    // ATOMIC single-use burn + record: flip pending → accepted AND write the
    // deal_rooms acceptance in the SAME transaction, so a homeowner's
    // "accepted" can never diverge from the CRM's deal-room state. Before
    // 2026-09-14 these were two separate writes — the token burn committed
    // unconditionally inside the transaction, then a second, non-transactional
    // deal_rooms.set() ran in a try/catch that only logger.warn'd on failure.
    // A same-request Firestore hiccup on that second write left the token
    // permanently burned (single-use — it can never be replayed) while
    // deal_rooms still read the pre-acceptance state: the homeowner saw
    // "accepted", the rep's Close Board still said draft, and nothing
    // anywhere reported an error. Folding both writes into one transaction
    // removes the failure window instead of trying to detect and revert it —
    // Firestore transactions commit all writes together or none at all, so
    // there is no state where the token is burned but the deal isn't recorded.
    let info;
    try {
      info = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) { const e = new Error('nf'); e._http = 404; e._msg = 'Invalid link'; throw e; }
        const t = snap.data();
        if (t.expiresAt && t.expiresAt.toMillis && t.expiresAt.toMillis() < Date.now()) {
          const e = new Error('exp'); e._http = 410; e._msg = 'This deal link has expired.'; throw e;
        }
        if (t.status !== 'pending') {
          const e = new Error('done'); e._http = 409; e._msg = 'This deal has already been accepted.'; throw e;
        }
        // Same resurrection hazard as getDealRoom: a rep can delete the deal
        // room after minting this token (Close Board "Remove" doesn't touch
        // deal_accept_tokens). Reading the doc inside the transaction means
        // Firestore retries this whole transaction if it's deleted concurrently,
        // so this check can't be raced by a delete landing after it runs.
        const dealRoomRef = db.doc(`deal_rooms/${t.dealId}`);
        const dealRoomSnap = await tx.get(dealRoomRef);
        if (!dealRoomSnap.exists) {
          const e = new Error('gone'); e._http = 410; e._msg = 'This deal is no longer available. Ask your rep for an update.'; throw e;
        }
        const price = (t.tierPrices && t.tierPrices[tier]) || 0;
        tx.update(tokRef, { status: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
        // update(), not set(merge) — the existence check above means this must
        // modify an existing doc, never create one.
        tx.update(dealRoomRef, {
          status: 'accepted',
          acceptedTier: tier,
          acceptedPrice: price,
          acceptedFinancing: financing,
          acceptedSignature: signature,
          scheduledInstallDate: scheduledDate || null,
          acceptedAt: FieldValue.serverTimestamp(),
          acceptedVia: 'remote',
        });
        return {
          dealId: t.dealId, ownerUid: t.ownerUid, leadId: t.leadId || null,
          customerName: t.customerName || '', price,
        };
      });
    } catch (err) {
      if (err && err._http) { res.status(err._http).json({ error: err._msg }); return; }
      logger.error('[submitDealAcceptance] burn+record txn failed', { msg: err.message });
      res.status(500).json({ error: 'Could not record your acceptance. Try again.' }); return;
    }

    // Token is burned AND the deal is recorded — both committed together
    // above. Notification is genuinely best-effort: a missing bell doesn't
    // desync any state, so it stays outside the transaction.
    try {
      await db.collection('notifications').add({
        userId: info.ownerUid,
        type: 'deal_accepted',
        leadId: info.leadId,
        title: 'Deal accepted! 🎉',
        message: (info.customerName || 'A customer') + ' accepted the ' + tier.toUpperCase() + ' package'
          + (info.price ? ' ($' + Number(info.price).toLocaleString('en-US') + ')' : '') + '.',
        priority: 'high',
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { logger.warn('[submitDealAcceptance] notify failed', { msg: e.message }); }

    logger.info('[submitDealAcceptance] accepted', { dealId: info.dealId, tier });
    res.status(200).json({ ok: true });
  }
);

module.exports = exports;
