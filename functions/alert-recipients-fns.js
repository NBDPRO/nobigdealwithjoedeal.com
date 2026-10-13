/**
 * functions/alert-recipients-fns.js — confirm a custom lead-alert address
 * ═══════════════════════════════════════════════════════════════
 *
 * The cloud-function surface for functions/alert-recipients.js (the shared
 * recipient policy). A company's lead alerts go to the owner's verified Auth
 * email unless the OWNER confirms a different address:
 *
 *   alertRecipients (onCall)       { action: 'status' | 'send' | 'revoke' }
 *     OWNER ONLY (Jo, 2026-10-13): companies/{id}.ownerId. A company_admin or
 *     any other member gets a clear "ask the owner" refusal, server-side — the
 *     Settings button is also hidden for them, but that is only a courtesy.
 *     status — what the Settings screen shows: the verified Auth email the
 *              alerts fall back to, the configured contact email, and whether
 *              that contact is confirmed.
 *     send   — emails a one-time confirmation link to the company's CONFIGURED
 *              alert email (read server-side from companyProfile, never taken
 *              from the request). The caller's own email must be verified;
 *              capped per company and per destination.
 *     revoke — removes the confirmed address (alerts fall back to the owner's
 *              sign-in email), audits it, and tells the owner.
 *   confirmAlertRecipient (onRequest)  /alert-confirm/<token>
 *     GET renders a button and writes nothing (mail scanners prefetch GET);
 *     POST consumes the token. Two kinds of token share the page:
 *       confirm — emailed to the CONFIGURED address. Honoured only while the
 *                 person who requested it is still the company's owner. Before
 *                 anything is recorded the OWNER is mailed a fixed-copy notice
 *                 (the address, how to revoke); if that mail cannot be sent
 *                 nothing is confirmed. The confirmation REPLACES any earlier
 *                 confirmed address (one at a time) and is audited.
 *       revoke  — carried by that notice to the owner's verified sign-in
 *                 address; one press removes the address. Audited.
 *     Token-authed, per-IP rate limited, no script on the page. Same shape as
 *     /unsubscribe (email-unsubscribe.js).
 *
 * Nothing here is reachable by an unconfirmed address: a confirmation mail is
 * the only thing sent to it, and it carries no tenant-authored text.
 */
'use strict';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { enforceRateLimit, clientIp, rateLimitIpKey } = require('./rate-limit');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const { secretOr } = require('./integrations/_shared');
const AR = require('./alert-recipients');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const CONFIRM_URL_BASE = 'https://nobigdealwithjoedeal.com/alert-confirm/';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ASK_OWNER = 'Only the account owner can change where lead alerts go. Ask the owner to do this from Settings.';
const NOTICES_PER_COMPANY_DAY = 10;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function mintToken() { return crypto.randomBytes(32).toString('base64url'); }

async function contactEmailFor(db, companyId) {
  try {
    const snap = await db.collection('companyProfile').doc(String(companyId)).get();
    const c = (((snap.exists ? snap.data() : {}) || {}).brand || {}).contact || {};
    return { email: AR.normEmail(c.alertEmail), sms: AR.normPhone(c.alertSms) };
  } catch (e) {
    logger.warn('alertRecipients: profile read failed', { err: e && e.message });
    return { email: '', sms: '' };
  }
}

// The notice goes ONLY to the owner's verified sign-in address, with fixed
// copy: the one tenant-influenced value is the address itself, which has passed
// the strict single-address check and is HTML-escaped.
async function sendOwnerNotice(kind, ownerEmail, address, revokeUrl) {
  const { Resend } = require('resend');
  const added = kind === 'added';
  const text = added
    ? `The address ${address} was just confirmed to receive new-lead alerts for your NBD Pro company.\n\n`
      + 'If you did this, there is nothing more to do. If you did not, stop it now:\n'
      + `${revokeUrl}\n\n`
      + 'You can also remove it any time in Settings, Brand Identity, Contact. Lead alerts then go back to your sign-in email.'
    : `The address ${address} no longer receives new-lead alerts for your NBD Pro company. Alerts go to your sign-in email.\n\n`
      + 'If you did not do this, review who has access under Settings, Team.';
  const html = '<div style="font-family:Arial,sans-serif;max-width:520px;color:#12223d">'
    + (added
      ? `<p>The address <strong>${esc(address)}</strong> was just confirmed to receive new-lead alerts for your NBD Pro company.</p>`
        + '<p>If you did this, there is nothing more to do. If you did not, stop it now:</p>'
        + `<p><a href="${esc(revokeUrl)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">Remove this address</a></p>`
        + '<p style="font-size:12px;color:#666">You can also remove it any time in Settings, Brand Identity, Contact. Lead alerts then go back to your sign-in email.</p>'
      : `<p>The address <strong>${esc(address)}</strong> no longer receives new-lead alerts for your NBD Pro company. Alerts go to your sign-in email.</p>`
        + '<p style="font-size:12px;color:#666">If you did not do this, review who has access under Settings, Team.</p>')
    + '</div>';
  const resp = await new Resend(RESEND_API_KEY.value()).emails.send({
    from: secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com'),
    to: ownerEmail,
    subject: added ? 'A lead-alert address was confirmed on your NBD Pro account' : 'A lead-alert address was removed from your NBD Pro account',
    // Email category: TRANSACTIONAL — a security notice to the account owner's own verified sign-in address.
    text,
    html,
  });
  if (resendRejected(resp)) throw new Error(resendErrorMessage(resp));
}

async function audit(db, entry) {
  try {
    await db.collection('audit_log').add(Object.assign({
      path: 'alertRecipients/' + entry.companyId,
      docId: String(entry.companyId),
      ts: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    }, entry));
    return true;
  } catch (e) {
    // Loud on purpose: a confirm / revoke with no audit row is a security gap.
    logger.info('ALERT_RECIPIENT_AUDIT_MISSING: audit_log write failed', { kind: entry.kind, companyId: String(entry.companyId), err: e && e.message });
    return false;
  }
}

// Remove the confirmed address. Returns the removed address ('' when none).
async function revokeConfirmed(db, companyId, actorUid, via, ownerEmail) {
  const ref = db.collection(AR.CONFIRMED_COLLECTION).doc(String(companyId));
  let removed = '';
  const snap = await ref.get();
  const map = (snap.exists && snap.data() && snap.data().confirmed) || {};
  for (const k of Object.keys(map)) { if (map[k] && map[k].email) removed = String(map[k].email); }
  // Never delete: revokedAtMs lets an in-flight confirmation see it was cancelled.
  await ref.set({ confirmed: {}, revokedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
  if (!removed) return '';
  await audit(db, {
    kind: 'alert_recipient.revoked', companyId: String(companyId), actorUid: String(actorUid || ''), via,
    emailMasked: AR.maskEmail(removed), addrKey: removed ? AR.addrKey(removed) : null,
  });
  if (ownerEmail && removed) {
    try {
      await enforceRateLimit('alertNotice:company', String(companyId), NOTICES_PER_COMPANY_DAY, AR.RECIPIENT_WINDOW_MS);
      await sendOwnerNotice('removed', ownerEmail, removed, '');
    } catch (e) {
      logger.warn('alertRecipients: removal notice not sent', { companyId: String(companyId), err: e && e.message });
    }
  }
  return removed;
}

exports.alertRecipients = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'alertRecipients', 20, 60_000);

    const claims = request.auth.token || {};
    const companyId = String(claims.companyId || uid);
    const ownerUid = await AR.ownerUidFor(companyId);
    if (!ownerUid) throw new HttpsError('unavailable', 'Could not look up the company owner. Try again in a minute.');
    // OWNER ONLY (Jo, 2026-10-13): not company_admin, not a platform admin.
    if (ownerUid !== uid) throw new HttpsError('permission-denied', ASK_OWNER);
    const action = String((request.data || {}).action || 'status');
    if (action !== 'status' && action !== 'send' && action !== 'revoke') throw new HttpsError('invalid-argument', 'Unknown action');

    const db = getFirestore();
    const owner = await AR.authOwner(ownerUid);
    const contact = await contactEmailFor(db, companyId);
    const buildStatus = async () => {
      const confirmed = contact.email
        ? AR.entryHonoured((await AR.confirmedEntries(companyId))[AR.addrKey(contact.email)], ownerUid, !!owner.email)
        : false;
      let state = 'none';
      if (contact.email) {
        if (owner.email && contact.email === owner.email) state = 'owner';
        else state = confirmed ? 'confirmed' : 'unconfirmed';
      }
      return {
        state,
        ownerEmail: owner.email || null,
        contactEmail: contact.email || null,
        smsConfigured: !!contact.sms,
        smsMatchesOwnerPhone: !!(contact.sms && owner.phone && contact.sms === owner.phone),
      };
    };
    const status = await buildStatus();
    if (action === 'status') return status;

    if (action === 'revoke') {
      const removed = await revokeConfirmed(db, companyId, uid, 'settings', owner.email);
      return Object.assign({ revoked: !!removed }, await buildStatus());
    }

    // ── send a confirmation link ──
    // The token claim can lag a fresh verification by up to an hour; the caller
    // IS the owner here, and authOwner only returns an email Auth says is verified.
    if (claims.email_verified !== true && !owner.email) {
      throw new HttpsError('failed-precondition', 'Verify your own email address first, then try again');
    }
    // The UI sends the address it DISPLAYED; if the profile changed since (a
    // company admin swapped it), refuse rather than mail a different address.
    const expected = AR.normEmail((request.data || {}).expectedEmail);
    if (!expected || expected !== contact.email) {
      throw new HttpsError('failed-precondition', 'The alert address changed. Reload Settings and check the address, then try again.');
    }
    if (status.state !== 'unconfirmed') return Object.assign({ sent: false }, status);
    if (!owner.email) {
      throw new HttpsError('failed-precondition', 'The account owner\'s email is not verified yet');
    }
    try {
      await enforceRateLimit('alertConfirm:company', companyId, AR.CONFIRM_REQUESTS_PER_OWNER_DAY, AR.RECIPIENT_WINDOW_MS);
      // Canonical inbox (+tag / Gmail dots folded) so spellings of one inbox
      // share a bucket, plus a platform-wide daily ceiling.
      await enforceRateLimit('alertConfirm:address', AR.canonicalInbox(contact.email), AR.CONFIRM_REQUESTS_PER_ADDRESS_DAY, AR.RECIPIENT_WINDOW_MS);
      await enforceRateLimit('alertConfirm:global', 'all', AR.CONFIRM_GLOBAL_DAILY_CAP, AR.RECIPIENT_WINDOW_MS);
    } catch (e) {
      if (e && e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many confirmation emails today. Try again tomorrow.');
      // Fail CLOSED: a missed confirmation mail is cheap, a flood is not.
      logger.warn('alertRecipients: limiter unavailable — not sending', { err: e && e.message });
      throw new HttpsError('unavailable', 'Could not send the confirmation email right now. Try again in a few minutes.');
    }

    const token = mintToken();
    const ref = db.collection(AR.TOKEN_COLLECTION).doc(sha256(token));
    await ref.set({
      kind: 'confirm', companyId, email: contact.email, requestedBy: uid,
      createdAtMs: Date.now(), expiresAtMs: Date.now() + AR.CONFIRM_TTL_MS,
    });
    const url = CONFIRM_URL_BASE + token;
    try {
      const { Resend } = require('resend');
      const resp = await new Resend(RESEND_API_KEY.value()).emails.send({
        from: secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com'),
        to: contact.email,
        subject: 'Confirm this address for new-lead alerts',
        // Email category: TRANSACTIONAL — a one-time confirmation the address's
        // own owner is asked to click. Carries no tenant-authored text.
        text: 'An NBD Pro account owner asked to send new-lead alerts to this address.\n\n'
          + `To allow it, open this link and press Confirm (valid 48 hours):\n${url}\n\n`
          + 'If you did not expect this, ignore this email. Nothing is sent to this address until it is confirmed.',
        html: '<div style="font-family:Arial,sans-serif;max-width:520px;color:#12223d"><p>An NBD Pro account owner asked to send new-lead alerts to this address.</p>'
          + `<p><a href="${esc(url)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">Review and confirm</a></p>`
          + '<p style="font-size:12px;color:#666">The link is valid for 48 hours. If you did not expect this, ignore this email. Nothing is sent to this address until it is confirmed.</p></div>',
      });
      if (resendRejected(resp)) throw new Error(resendErrorMessage(resp));
    } catch (e) {
      await ref.delete().catch(() => {});
      logger.error('alertRecipients: confirmation email failed', { companyId, err: e && e.message });
      throw new HttpsError('unavailable', 'Could not send the confirmation email. Try again in a few minutes.');
    }
    return Object.assign({ sent: true }, status);
  }
);

// ── /alert-confirm/<token> ────────────────────────────────────────

function renderPage(heading, bodyHtml) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>Alert contact</title>'
    + '<style>body{margin:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#12223d}'
    + '.card{max-width:460px;margin:48px auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.1)}'
    + 'h1{font-size:20px;margin:0 0 12px}p{margin:0 0 14px;font-size:15px}.muted{color:#6b7280;font-size:13px}'
    + 'button{display:block;width:100%;padding:13px 16px;border:0;border-radius:8px;background:#12223d;color:#fff;font-size:16px;font-weight:600;cursor:pointer}'
    + '</style></head><body><main class="card"><h1>' + esc(heading) + '</h1>' + bodyHtml + '</main></body></html>';
}

function send(res, status, html, method) {
  res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'private, no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .set('Referrer-Policy', 'no-referrer')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.send(method === 'HEAD' ? '' : html);
}

const INVALID = renderPage('This link isn\'t valid',
  '<p>This link is invalid, expired or already used. Ask the account owner to send a new one from Settings.</p>');

function tokenFromPath(p) {
  const m = String(p || '').match(/\/alert-confirm\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : '';
}

// POST on a revoke token: remove the confirmed address (if it is still there).
async function applyRevoke(db, ref, tok, method, res) {
  const target = db.collection(AR.CONFIRMED_COLLECTION).doc(String(tok.companyId));
  let removed = '';
  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) throw Object.assign(new Error('used'), { code: 'used' });
      const t = await tx.get(target);
      const map = (t.exists && t.data() && t.data().confirmed) || {};
      if (t.exists && map[tok.addrKey]) {
        removed = String((map[tok.addrKey] || {}).email || tok.email || '');
        tx.set(target, { confirmed: {}, revokedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
      }
      tx.delete(ref);
    });
  } catch (e) {
    if (e && e.code === 'used') return send(res, 404, INVALID, method);
    logger.error('confirmAlertRecipient: revoke failed', { err: e && e.message });
    return send(res, 503, renderPage('We couldn\'t save that', '<p>Please press the button again in a minute.</p>'), method);
  }
  if (removed) {
    await audit(db, {
      kind: 'alert_recipient.revoked', companyId: String(tok.companyId), actorUid: '', via: 'link',
      emailMasked: AR.maskEmail(removed), addrKey: AR.addrKey(removed),
    });
    try {
      const ownerUid = await AR.ownerUidFor(tok.companyId);
      const owner = ownerUid ? await AR.authOwner(ownerUid) : { email: '' };
      if (owner.email) await sendOwnerNotice('removed', owner.email, removed, '');
    } catch (e) {
      logger.warn('confirmAlertRecipient: removal notice not sent', { err: e && e.message });
    }
  }
  logger.info('confirmAlertRecipient: revoked', { companyId: String(tok.companyId), removed: !!removed });
  if (!removed) {
    return send(res, 200, renderPage('Nothing to remove',
      '<p>This address was already replaced or removed, so nothing changed.</p><p class="muted">You can close this page.</p>'), method);
  }
  return send(res, 200, renderPage('Removed',
    '<p><strong>' + esc(tok.email) + '</strong> will no longer receive new-lead alerts. Alerts go to the account owner\'s sign-in email.</p>'
    + '<p class="muted">You can close this page.</p>'), method);
}

async function handleConfirm(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    res.set('Allow', 'GET, HEAD, POST');
    return send(res, 405, INVALID, method);
  }
  try {
    await enforceRateLimit('alertConfirm:ip', rateLimitIpKey(clientIp(req)), 30, 60_000);
  } catch (e) {
    if (e && e.rateLimited) {
      res.set('Retry-After', String(Math.ceil((e.retryAfterMs || 60_000) / 1000)));
      return send(res, 429, renderPage('Please try again in a minute', '<p>Too many requests from this network.</p>'), method);
    }
    logger.warn('confirmAlertRecipient: limiter unavailable', { err: e && e.message });
  }
  const token = tokenFromPath(req.path || req.url);
  if (!TOKEN_RE.test(token)) return send(res, 404, INVALID, method);

  const db = getFirestore();
  const ref = db.collection(AR.TOKEN_COLLECTION).doc(sha256(token));
  let tok = null;
  try {
    const snap = await ref.get();
    tok = snap && snap.exists ? (snap.data() || {}) : null;
  } catch (e) {
    logger.error('confirmAlertRecipient: token read failed', { err: e && e.message });
    return send(res, 503, renderPage('Something went wrong', '<p>Please try the link again in a few minutes.</p>'), method);
  }
  if (!tok || !tok.companyId || !tok.email || Number(tok.expiresAtMs || 0) < Date.now()) {
    return send(res, 404, INVALID, method);
  }

  // ── revoke link (carried by the owner notice) ──
  if (tok.kind === 'revoke') {
    // Minted for one owner: it does not outlive a hand-off (the new owner makes
    // their own). A token with no ownerUid is refused.
    let cur = '';
    try { cur = await AR.ownerUidFor(tok.companyId); } catch (_) { cur = ''; }
    if (!cur) return send(res, 503, renderPage('Something went wrong', '<p>Please try the link again in a few minutes.</p>'), method);
    if (!tok.ownerUid || String(tok.ownerUid) !== cur) return send(res, 404, INVALID, method);
    if (method === 'POST') return applyRevoke(db, ref, tok, method, res);
    return send(res, 200, renderPage('Stop lead alerts to this address?',
      '<p>Stop sending new-lead alerts to <strong>' + esc(tok.email) + '</strong>? Alerts will go to the account owner\'s sign-in email.</p>'
      + '<form method="post"><button type="submit">Remove this address</button></form>'), method);
  }

  // ── confirmation link (emailed to the configured address) ──
  if (method === 'POST') {
    // Only the CURRENT owner's request is honoured: a demoted admin's or a
    // former owner's pending link dies here, and the owner must still have a
    // verified inbox to be told.
    let ownerUid = '';
    let owner = { email: '' };
    try {
      ownerUid = await AR.ownerUidFor(tok.companyId);
      owner = ownerUid ? await AR.authOwner(ownerUid) : { email: '' };
    } catch (_) { ownerUid = ''; }
    if (!ownerUid) {
      return send(res, 503, renderPage('Something went wrong', '<p>Please try the link again in a few minutes.</p>'), method);
    }
    if (String(tok.requestedBy || '') !== ownerUid) return send(res, 404, INVALID, method);
    if (!owner.email) {
      return send(res, 403, renderPage('Verify the account email first',
        '<p>The account owner\'s sign-in email is not verified yet, so this address cannot be confirmed. Verify it, then ask for a new link.</p>'), method);
    }

    // THREE steps, none of which can clobber another writer:
    //   1. CLAIM: stamp { nonce, atMs } on the confirm token, in a transaction that
    //      also re-reads companies/{id}.ownerId and aborts unless the requester is
    //      still the owner. Nothing else is written; the previous confirmed
    //      address is untouched.
    //   2. NOTIFY the owner (rate limited). On failure, release the claim (a
    //      nonce-guarded transaction) and stop: there is nothing to roll back.
    //   3. PROMOTE: one transaction re-checks the claim nonce, the owner and that
    //      no revoke happened since the claim, then writes the confirmed entry +
    //      the revoke token and deletes the confirm token.
    // Exactly one notice per claim: a second POST sees a live claim and stops.
    const nonce = mintToken();
    const revokeToken = mintToken();
    const confirmedRef = db.collection(AR.CONFIRMED_COLLECTION).doc(String(tok.companyId));
    const revokeRef = db.collection(AR.TOKEN_COLLECTION).doc(sha256(revokeToken));
    const ownerNow = async (tx) => {
      const co = await tx.get(db.collection('companies').doc(String(tok.companyId)));
      const oid = co && co.exists ? ((co.data() || {}).ownerId || '') : '';
      return String(oid || tok.companyId);
    };
    let claimAtMs = 0;
    try {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (!cur.exists) throw Object.assign(new Error('used'), { code: 'used' });
        const c = cur.data() || {};
        if (c.claim && Number(c.claim.atMs || 0) > Date.now() - AR.CLAIM_TTL_MS) throw Object.assign(new Error('busy'), { code: 'busy' });
        if ((await ownerNow(tx)) !== String(tok.requestedBy || '')) throw Object.assign(new Error('owner'), { code: 'owner' });
        claimAtMs = Date.now();
        tx.set(ref, Object.assign({}, c, { claim: { nonce, atMs: claimAtMs } }));
      });
    } catch (e) {
      if (e && (e.code === 'used' || e.code === 'owner')) return send(res, 404, INVALID, method);
      if (e && e.code === 'busy') {
        return send(res, 409, renderPage('Already in progress', '<p>This link is being processed. Check your email in a minute.</p>'), method);
      }
      logger.error('confirmAlertRecipient: claim failed', { err: e && e.message });
      return send(res, 503, renderPage('We couldn\'t save that', '<p>Please press the button again in a minute.</p>'), method);
    }
    const releaseClaim = async () => {
      try {
        await db.runTransaction(async (tx) => {
          const cur = await tx.get(ref);
          const c = cur.exists ? (cur.data() || {}) : null;
          if (c && c.claim && c.claim.nonce === nonce) { const d = Object.assign({}, c); delete d.claim; tx.set(ref, d); }
        });
      } catch (e) {
        // Harmless: the claim expires on its own (AR.CLAIM_TTL_MS) and nothing was confirmed.
        logger.warn('confirmAlertRecipient: claim release failed', { err: e && e.message });
      }
    };
    try {
      await enforceRateLimit('alertNotice:company', String(tok.companyId), NOTICES_PER_COMPANY_DAY, AR.RECIPIENT_WINDOW_MS);
      await sendOwnerNotice('added', owner.email, tok.email, CONFIRM_URL_BASE + revokeToken);
    } catch (e) {
      logger.error('confirmAlertRecipient: owner notice failed — not confirming', { err: e && e.message });
      await releaseClaim();
      return send(res, 503, renderPage('We couldn\'t save that', '<p>Please press the button again in a minute.</p>'), method);
    }
    try {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const c = cur.exists ? (cur.data() || {}) : null;
        if (!c || !c.claim || c.claim.nonce !== nonce) throw Object.assign(new Error('used'), { code: 'used' });
        if ((await ownerNow(tx)) !== String(tok.requestedBy || '')) throw Object.assign(new Error('owner'), { code: 'owner' });
        const prev = await tx.get(confirmedRef);
        const pd = prev && prev.exists ? (prev.data() || {}) : {};
        if (Number(pd.revokedAtMs || 0) >= claimAtMs) throw Object.assign(new Error('revoked'), { code: 'revoked' });
        const key = AR.addrKey(tok.email);
        // Replaces any earlier confirmed address (no merge): one at a time.
        tx.set(confirmedRef, {
          confirmed: {
            [key]: { email: tok.email, confirmedAtMs: Date.now(), requestedBy: String(tok.requestedBy || '') },
          },
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(revokeRef, {
          kind: 'revoke', companyId: String(tok.companyId), email: tok.email, addrKey: key, ownerUid: String(tok.requestedBy || ''),
          createdAtMs: Date.now(), expiresAtMs: Date.now() + AR.REVOKE_TTL_MS,
        });
        tx.delete(ref);
      });
    } catch (e) {
      if (e && (e.code === 'used' || e.code === 'owner')) return send(res, 404, INVALID, method);
      if (e && e.code === 'revoked') {
        await releaseClaim();
        return send(res, 409, renderPage('Cancelled', '<p>A lead-alert address was removed while this was being confirmed, so nothing was changed. Request a new confirmation from Settings if you still want it.</p>'), method);
      }
      await releaseClaim();
      logger.error('confirmAlertRecipient: record failed', { err: e && e.message });
      return send(res, 503, renderPage('We couldn\'t save that', '<p>Please press the button again in a minute.</p>'), method);
    }
    if (!(await audit(db, {
      kind: 'alert_recipient.confirmed', companyId: String(tok.companyId), actorUid: String(tok.requestedBy || ''), via: 'link',
      emailMasked: AR.maskEmail(tok.email), addrKey: AR.addrKey(tok.email),
    }))) {
      logger.error('confirmAlertRecipient: confirmed WITHOUT an audit row', { companyId: String(tok.companyId) });
    }
    logger.info('confirmAlertRecipient: confirmed', { companyId: String(tok.companyId) });
    return send(res, 200, renderPage('Confirmed',
      '<p><strong>' + esc(tok.email) + '</strong> will now receive new-lead alerts for this company.</p>'
      + '<p class="muted">You can close this page.</p>'), method);
  }

  // GET / HEAD: read only.
  return send(res, 200, renderPage('Confirm lead alerts',
    '<p>Send new-lead alerts to <strong>' + esc(tok.email) + '</strong>?</p>'
    + '<form method="post"><button type="submit">Confirm</button></form>'
    + '<p class="muted" style="margin-top:14px">If you did not expect this, close this page. Nothing is sent until you confirm.</p>'), method);
}

// No enforceAppCheck on onRequest (tests/appcheck-onrequest-contract.test.js).
exports.confirmAlertRecipient = onRequest(
  { region: 'us-central1', maxInstances: 10, concurrency: 40, timeoutSeconds: 15, memory: '256MiB', secrets: [RESEND_API_KEY, EMAIL_FROM] },
  handleConfirm
);

Object.defineProperty(exports, '_internal', {
  enumerable: false,
  value: { handleConfirm, tokenFromPath, sha256 },
});
