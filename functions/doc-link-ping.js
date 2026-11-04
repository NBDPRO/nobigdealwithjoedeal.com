'use strict';
/**
 * doc-link-ping.js — docLinkPing (2026-11-04): the Secure Document Link's
 * browser beacon, via the same-origin rewrite /api/doc-link-ping. Mirrors
 * dealRoomReadPing: public invoker (a beacon cannot carry App Check), token +
 * viewId authed, 204 on anything odd so it leaks nothing.
 *
 *   k:'open'  stage 2. The page has been VISIBLE for 3+ seconds: this is an
 *             open. First one stamps firstOpenedAt + the 24h reminder due
 *             time; every one goes through recordEstimateView (source
 *             secure_link: lead.lastViewedAt + the 6h-throttled bell/push).
 *   k:'ping'  seconds of visible time since the last ping, clamped. When a
 *             view reaches 10 s, ONE "viewing right now" bell + push
 *             (fresh-view-logic.js, 2h cooldown per lead).
 *   k:'file'  the "Open full document" fallback was used; counted as a ping.
 *
 * Dark: does nothing unless SECURE_DOC_LINK_ENABLED=true. Preview bots are
 * ignored. Nothing here contacts the customer.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { enforceRateLimit, httpRateLimit } = require('./integrations/upstash-ratelimit');
const L = require('./doc-link-logic');
const EVA = require('./estimate-view-alert');
const FV = require('./fresh-view-logic');

const TOKEN_RE = /^[A-Za-z0-9]{10,64}$/;
const VIEW_RE = /^[a-z0-9]{16}$/;

function parseBody(req) {
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch (_) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

/**
 * One transaction: validate the token / view / lead as a unit (tenant check),
 * then apply the open or the ping. Returns { ok, ... } and never throws on
 * bad input.
 */
async function applyBeacon(db, { token, viewId, kind, seconds, ua, nowMs }) {
  const tokRef = db.doc('report_share_tokens/' + token);
  return db.runTransaction(async (tx) => {
    const tokSnap = await tx.get(tokRef);
    if (!tokSnap.exists) return { ok: false, reason: 'no_token' };
    const tok = tokSnap.data() || {};
    if (tok.purpose !== 'secure_doc' || tok.kind !== 'lead_document') return { ok: false, reason: 'not_secure' };
    if ((tok.status && tok.status !== 'active') || tok.revokedAt) return { ok: false, reason: 'revoked' };
    const exp = L.ms(tok.expiresAt);
    if (exp && exp < nowMs) return { ok: false, reason: 'expired' };
    if (!tok.leadId || !tok.ownerUid || !tok.companyId) return { ok: false, reason: 'bad_token' };
    const viewRef = db.doc('leads/' + tok.leadId + '/docViews/' + viewId);
    const leadRef = db.doc('leads/' + tok.leadId);
    const [viewSnap, leadSnap] = await Promise.all([tx.get(viewRef), tx.get(leadRef)]);
    if (!viewSnap.exists || !leadSnap.exists) return { ok: false, reason: 'no_view' };
    const view = viewSnap.data() || {};
    const lead = leadSnap.data() || {};
    // Tenant isolation: everything derives from the token; the view row and the
    // lead must both agree with it.
    if (view.tokenRef !== token.slice(0, 10) || view.companyId !== tok.companyId || view.ownerUid !== tok.ownerUid) {
      return { ok: false, reason: 'view_mismatch' };
    }
    if (lead.deleted === true || lead.isDeleted === true || lead.userId !== tok.ownerUid) return { ok: false, reason: 'owner_mismatch' };
    if (view.botSuspect === true) return { ok: false, reason: 'bot_view' };

    const dev = L.parseDevice(ua);
    const fetchedMs = L.ms(view.fetchedAt);
    const track = lead.docTrack && lead.docTrack.tokenRef === token.slice(0, 10) ? lead.docTrack : null;

    if (kind === 'open') {
      if (view.openedAt) return { ok: false, reason: 'already_open' };
      if (!L.shouldPromoteOpen(seconds, nowMs - fetchedMs)) return { ok: false, reason: 'too_early' };
      const first = !tok.firstOpenedAt;
      const openCount = (Number(tok.openCount) || 0) + 1;
      const tokPatch = {
        openCount: FieldValue.increment(1),
        lastOpenedAt: FieldValue.serverTimestamp(),
        lastDevice: dev.device,
        ['devices.' + dev.device]: FieldValue.increment(1),
      };
      if (first) {
        tokPatch.firstOpenedAt = FieldValue.serverTimestamp();
        tokPatch.followUpDueAtMs = nowMs + L.FOLLOWUP_AFTER_MS;
      }
      tx.update(tokRef, tokPatch);
      tx.update(viewRef, { openedAt: FieldValue.serverTimestamp(), lastPingAt: FieldValue.serverTimestamp(), device: dev.device, os: dev.os, browser: dev.browser });
      tx.update(leadRef, {
        docTrack: {
          tokenRef: token.slice(0, 10),
          docId: tok.documentId || null,
          docName: String(tok.docLabel || tok.filename || '').slice(0, 160),
          firstOpenedAt: first ? FieldValue.serverTimestamp() : (tok.firstOpenedAt || FieldValue.serverTimestamp()),
          lastOpenedAt: FieldValue.serverTimestamp(),
          openCount,
          readSeconds: Number(tok.readSeconds) || 0,
          device: dev.device,
          expiresAt: tok.expiresAt || null,
          passwordSet: tok.passwordRequired === true,
        },
      });
      return { ok: true, opened: true, first, tok, lead };
    }

    // ping / file
    if (!view.openedAt) return { ok: false, reason: 'not_opened' };
    const lastMs = Math.max(L.ms(view.lastPingAt), L.ms(view.openedAt));
    const add = L.clampPing(seconds, nowMs - lastMs, view.readSeconds);
    if (!add) return { ok: false, reason: 'nothing_to_add' };
    const total = (Number(view.readSeconds) || 0) + add;
    const reading = total >= L.READING_NOW_SECONDS && view.readingAlerted !== true;
    const viewPatch = { readSeconds: FieldValue.increment(add), pings: FieldValue.increment(1), lastPingAt: FieldValue.serverTimestamp() };
    if (reading) viewPatch.readingAlerted = true;
    tx.update(viewRef, viewPatch);
    tx.update(tokRef, { readSeconds: FieldValue.increment(add) });
    if (track) tx.update(leadRef, { 'docTrack.readSeconds': FieldValue.increment(add) });
    return { ok: true, opened: false, reading, add, tok, lead };
  });
}

/** "<Name> is viewing their estimate right now": 2 h cooldown per lead, one rolling bell row. */
async function readingNow(db, { tok, lead, nowMs, push }) {
  const ownerUid = tok.ownerUid;
  const leadId = String(tok.leadId);
  const ref = db.collection('notifications').doc(FV.freshViewNotifId(ownerUid, leadId));
  const claimed = await db.runTransaction(async (tx) => {
    const prev = await tx.get(ref);
    const prevMs = prev.exists ? L.ms((prev.data() || {}).createdAt) : 0;
    if (!FV.shouldNotify(prevMs, nowMs, L.READING_COOLDOWN_MS)) return false;
    const n = FV.buildFreshViewNotif({ ownerUid, leadId, customerName: EVA.leadName(lead), customerPhone: null, amount: 0 });
    tx.set(ref, Object.assign({}, n, { source: 'secure_link', createdAt: FieldValue.serverTimestamp() }));
    return n;
  });
  if (!claimed) return false;
  try {
    const p = push || require('./push-functions');
    await p.sendCustomNotification(ownerUid, claimed.title, claimed.message, { type: 'estimate_viewed', leadId });
  } catch (e) { logger.warn('[docLinkPing] push failed', { msg: e && e.message }); }
  return true;
}

async function handle(req, res, deps) {
  const d = deps || {};
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!L.secureLinkEnabled()) { res.status(204).end(); return; }
  const rl = d.httpRateLimit || httpRateLimit;
  if (!(await rl(req, res, 'doclink-ping:ip', 120, 60_000))) return;
  const b = parseBody(req);
  const token = typeof b.t === 'string' ? b.t : '';
  const viewId = typeof b.v === 'string' ? b.v : '';
  const kind = b.k === 'open' ? 'open' : (b.k === 'file' ? 'file' : (b.k === 'ping' ? 'ping' : ''));
  if (!TOKEN_RE.test(token) || !VIEW_RE.test(viewId) || !kind) { res.status(204).end(); return; }
  const ua = req.get('user-agent');
  if (L.isBot(ua)) { res.status(204).end(); return; }
  try {
    await (d.enforceRateLimit || enforceRateLimit)('doclink-ping:view', token + viewId, 10, 60_000);
  } catch (e) {
    if (e && e.rateLimited) { res.status(204).end(); return; }
    throw e;
  }
  const db = d.db || getFirestore();
  const nowMs = d.now ? d.now() : Date.now();
  let r;
  try {
    r = await applyBeacon(db, { token, viewId, kind, seconds: b.s, ua, nowMs });
  } catch (e) {
    logger.warn('[docLinkPing] failed', { msg: e && e.message });
    res.status(204).end(); return;
  }
  if (r && r.ok) {
    try {
      if (r.opened) {
        await EVA.recordEstimateView(db, {
          leadId: String(r.tok.leadId), ownerUid: r.tok.ownerUid, source: 'secure_link',
          what: r.tok.docLabel || r.tok.filename || '',
        }, d.evaDeps);
      } else if (r.reading) {
        await readingNow(db, { tok: r.tok, lead: r.lead, nowMs, push: d.push });
      }
    } catch (e) { logger.warn('[docLinkPing] alert failed', { msg: e && e.message }); }
  }
  res.status(204).end();
}

exports.handle = handle;
exports.applyBeacon = applyBeacon;
exports.readingNow = readingNow;
exports.docLinkPing = onRequest(
  { region: 'us-central1', invoker: 'public', maxInstances: 20, concurrency: 40, timeoutSeconds: 10, memory: '256MiB' },
  (req, res) => handle(req, res)
);
