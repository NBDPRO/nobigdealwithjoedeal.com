'use strict';
/**
 * doc-link-serve.js — what getSharedReport does for a purpose:'secure_doc'
 * token while SECURE_DOC_LINK_ENABLED=true (2026-11-04). Not a Cloud Function
 * and never an index.js export; report-sharing.js requires it.
 *
 *   GET  /report/<t>         password page, or the viewer shell (stage 1: the
 *                            link was FETCHED — logged, never alerts)
 *   POST /report/<t>/unlock  check the password, set the __session proof
 *   GET  /report/<t>/file    the PDF bytes (same checks), frameable by us only
 *
 * leadId / companyId / ownerUid come ONLY from the token doc, and the lead's
 * owner is re-checked before a view row is written (estimate-view-alert.js
 * does the same), so a lead id re-created under another tenant never receives
 * view rows.
 */
const crypto = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions/v2');
const L = require('./doc-link-logic');
const ESL = require('./estimate-send-logic');
const RENDER_PATH_RE = /^pdf-renders\/[A-Za-z0-9_-]{1,128}\/[^/\\]{1,240}$/;

function newViewId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(16);
  let s = '';
  for (const x of b) s += a[x % a.length];
  return s;
}

function html(res, code, body, csp) {
  res.status(code).set('Content-Type', 'text/html; charset=utf-8').set('X-Robots-Tag', 'noindex, nofollow')
    .set('Cache-Control', 'no-store').set('Content-Security-Policy', csp)
    .set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'no-referrer').send(body);
}

/** Record a wrong/right attempt. The attempt is RESERVED first so parallel guesses cannot beat the budget. */
async function reserve(db, token) {
  const ref = db.doc('report_share_tokens/' + token);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const r = L.reserveAttempt(s.exists ? s.data() : {}, Date.now());
    if (r.allowed) tx.update(ref, r.patch);
    return r;
  });
}

async function bellLocked(db, tok) {
  try {
    if (!tok.ownerUid) return;
    await db.collection('notifications').add({
      userId: tok.ownerUid, type: 'doc_link_lock', leadId: tok.leadId || null, priority: 'high', read: false,
      title: 'Password guesses on a document link',
      message: 'Someone is guessing the password on ' + (String(tok.customerName || '').trim() || 'a customer') + '\'s document link. It is locked for 15 minutes.',
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { logger.warn('[docLink] lock bell failed', { msg: e && e.message }); }
}

async function serveSecureDoc({ req, res, db, token, tok, sub, errPage, streamLeadPdf, awaitBriefly }) {
  const path = typeof tok.storagePath === 'string' ? tok.storagePath : '';
  if (!tok.leadId || !tok.ownerUid || !tok.companyId
    || (!RENDER_PATH_RE.test(path) && !ESL.isServableLeadDocPath(path, tok.leadId))) {
    errPage(404, 'This report is no longer available.'); return;
  }
  const now = Date.now();
  const needsPw = tok.passwordRequired === true;
  const unlocked = !needsPw || L.isUnlocked(req.get('cookie'), token, tok.unlockKey, now);

  // ── unlock ──
  if (sub === 'unlock') {
    if (!needsPw) { res.redirect(303, '/report/' + token); return; }
    if (req.method !== 'POST') { res.redirect(303, '/report/' + token); return; }
    const r = await reserve(db, token);
    if (!r.allowed) { html(res, 429, L.passwordHtml({ token, locked: true }), L.PASSWORD_CSP); return; }
    let code = '';
    const b = req.body;
    if (b && typeof b === 'object' && typeof b.code === 'string') code = b.code;
    const good = code.length <= 200 && await L.verifyPassword(code, tok);
    if (!good) {
      if (r.willLock) await bellLocked(db, tok);
      html(res, 401, L.passwordHtml({ token, wrong: true }), L.PASSWORD_CSP); return;
    }
    await db.doc('report_share_tokens/' + token).update(L.clearAttempts()).catch(() => {});
    res.set('Set-Cookie', L.unlockCookie(req.get('cookie'), token, tok.unlockKey, now));
    res.redirect(303, '/report/' + token); return;
  }

  // ── password gate (no PDF bytes, no view row, before an unlock) ──
  if (!unlocked) {
    if (req.method !== 'GET') { errPage(405, 'This report link is invalid.'); return; }
    html(res, 200, L.passwordHtml({ token }), L.PASSWORD_CSP); return;
  }

  // ── the file ──
  if (sub === 'file') {
    const fail = await streamLeadPdf(res, tok, token, path, { csp: L.FILE_CSP, frameable: true });
    if (fail) errPage(fail.code, fail.msg);
    return;
  }

  // ── the viewer shell: stage 1, link FETCHED ──
  if (req.method !== 'GET') { errPage(405, 'This report link is invalid.'); return; }
  const leadRef = db.doc('leads/' + tok.leadId);
  const leadSnap = await leadRef.get();
  const lead = leadSnap.exists ? (leadSnap.data() || {}) : null;
  if (!lead || lead.deleted === true || lead.isDeleted === true || lead.userId !== tok.ownerUid) {
    errPage(404, 'This report is no longer available.'); return;
  }
  const ua = req.get('user-agent');
  const dev = L.parseDevice(ua);
  const bot = L.isBot(ua);
  const viewId = newViewId();
  const writes = [
    db.doc('leads/' + tok.leadId + '/docViews/' + viewId).set({
      tokenRef: token.slice(0, 10),
      documentId: tok.documentId || null,
      docLabel: String(tok.docLabel || tok.filename || '').slice(0, 160),
      fetchedAt: FieldValue.serverTimestamp(),
      openedAt: null,
      lastPingAt: null,
      readSeconds: 0,
      pings: 0,
      device: dev.device, os: dev.os, browser: dev.browser,
      botSuspect: bot,
      companyId: tok.companyId,
      ownerUid: tok.ownerUid,
      expireAt: Timestamp.fromMillis(now + L.VIEW_TTL_DAYS * L.DAY_MS),
    }).catch((e) => logger.warn('[docLink] view row failed', { msg: e && e.message })),
    db.doc('report_share_tokens/' + token).update({
      fetchCount: FieldValue.increment(1), lastFetchedAt: FieldValue.serverTimestamp(),
    }).catch(() => {}),
  ];
  await awaitBriefly(writes);
  const exp = L.ms(tok.expiresAt);
  html(res, 200, L.shellHtml({
    token, viewId, docLabel: tok.docLabel || tok.filename,
    notice: L.trackingNotice({ brand: tok.noticeBrand, rep: tok.noticeRep, expiresAtMs: exp }),
  }), L.SHELL_CSP);
}

module.exports = { serveSecureDoc, newViewId };
