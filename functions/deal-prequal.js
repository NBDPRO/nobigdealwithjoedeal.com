'use strict';
/**
 * deal-prequal.js — POST /api/deal-prequal (2026-10-15).
 *
 * The deal room's "Check my rate" tap (docs/pro/deal-room.js, sendBeacon with
 * the page's deal token). Token-authed like /api/deal-read; no login. Rules in
 * deal-prequal-logic.js: one "Financing prequal started" activity row per deal
 * per 24 h, and the lead moves to Pre-Qual Sent only when that is forward.
 * Always answers 204 (a beacon reads nothing back); never sends anything.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const DV = require('./deal-view-logic');
const JSL = require('./job-spine-logic');
const PQ = require('./deal-prequal-logic');

const TOKEN_RE = /^[A-Za-z0-9]{10,64}$/;
const DONE_STATUSES = ['accepted', 'signed', 'scheduled'];

function parseBody(b) {
  let x = b || {};
  if (Buffer.isBuffer(x)) { try { x = JSON.parse(x.toString('utf8')); } catch (_) { x = {}; } }
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (_) { x = {}; } }
  return x && typeof x === 'object' ? x : {};
}

/**
 * The work, testable without HTTP. → { logged, moved, reason }
 * deps: { FieldValue, nowMs, logger }
 */
async function recordPrequalStarted(db, token, deps) {
  const d = deps || {};
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  if (!TOKEN_RE.test(String(token || ''))) return { logged: false, moved: false, reason: 'bad_token' };
  const tokSnap = await db.doc('deal_accept_tokens/' + token).get();
  const tok = tokSnap.exists ? (tokSnap.data() || {}) : null;
  if (!tok || !tok.dealId) return { logged: false, moved: false, reason: 'no_token' };
  const exp = tok.expiresAt;
  const expMs = !exp ? 0 : (typeof exp.toMillis === 'function' ? exp.toMillis() : (typeof exp.seconds === 'number' ? exp.seconds * 1000 : Number(exp) || 0));
  if (expMs && expMs < nowMs) return { logged: false, moved: false, reason: 'expired' };
  const roomRef = db.doc('deal_rooms/' + tok.dealId);
  return db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) return { logged: false, moved: false, reason: 'no_deal' };
    const room = roomSnap.data() || {};
    const leadId = tok.leadId || room.leadId || null;
    if (!PQ.shouldLog(room.prequalStartedAtMs, nowMs)) return { logged: false, moved: false, reason: 'recent' };
    let lead = null, leadRef = null;
    if (leadId && /^[A-Za-z0-9_-]{1,128}$/.test(String(leadId))) {
      leadRef = db.doc('leads/' + leadId);
      const ls = await tx.get(leadRef);
      lead = ls.exists ? (ls.data() || {}) : null;
    }
    // A lead in another tenant than the token's is not this deal's lead.
    const tenant = tok.companyId || tok.ownerUid || null;
    if (lead && tenant && lead.companyId && lead.companyId !== tenant && lead.userId !== tenant) lead = null;
    tx.update(roomRef, { prequalStartedAtMs: nowMs, prequalStartedCount: FV.increment(1) });
    if (!lead) return { logged: false, moved: false, reason: 'no_lead' };
    const plan = DONE_STATUSES.includes(room.status) ? { move: false, reason: 'deal_done' } : PQ.planPrequalMove(lead);
    if (plan.move) {
      const mp = JSL.movePayload(lead, plan, { atIso: new Date(nowMs).toISOString(), actor: 'homeowner', event: 'prequal_started' }, FV);
      tx.update(leadRef, mp.payload);
    }
    const actRef = leadRef.collection('activity').doc('prequal-' + tok.dealId + '-' + nowMs);
    tx.set(actRef, {
      userId: lead.userId || tok.ownerUid || null,
      type: PQ.ACTIVITY_TYPE,
      label: PQ.ACTIVITY_LABEL,
      message: 'The homeowner tapped "Check my rate" in the deal room (Acorn Finance opened in a new tab).'
        + (plan.move ? ' Moved to Pre-Qual Sent.' : ''),
      dealId: tok.dealId,
      createdAt: FV.serverTimestamp(),
      createdAtMs: nowMs,
    });
    return { logged: true, moved: !!plan.move, reason: plan.move ? 'moved' : plan.reason };
  });
}

exports.dealPrequalStarted = onRequest(
  { region: 'us-central1', invoker: 'public', maxInstances: 20, concurrency: 40, timeoutSeconds: 10, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'dealprequal:ip', 20, 60_000))) return;
    if (DV.isPreviewBot(req.get('user-agent'))) { res.status(204).end(); return; }
    const b = parseBody(req.body);
    try {
      const r = await recordPrequalStarted(getFirestore(), typeof b.token === 'string' ? b.token : '', {});
      logger.info('deal_prequal_started', { reason: r.reason, moved: r.moved });
    } catch (e) {
      logger.warn('deal_prequal_failed', { err: e && e.message });
    }
    res.status(204).end();
  }
);

exports._test = { recordPrequalStarted, parseBody };
