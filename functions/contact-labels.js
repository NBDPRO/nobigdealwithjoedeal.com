'use strict';
/**
 * functions/contact-labels.js — server read of the per-number label registry
 * (companies/{tenant}/contact_labels/{digits10}; client side:
 * docs/pro/js/contact-labels*.js, design: documentation/projects/
 * CONTACT-ROUTING-TREE-2026-10-12.md).
 *
 * Read-only. A failed read returns NO labels and logs — every consumer here
 * fails toward doing what it did before labels existed (copy, transcribe,
 * alert), because losing a customer call is worse than keeping a personal one.
 */
const { logger } = require('firebase-functions/v2');
const W = require('./call-watch-logic');

const toMs = (v) => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime() || 0;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
};

/**
 * { digits10: { kind, policy, capture, ackAtMs, updatedAtMs } } for one tenant.
 * ackAtMs / updatedAtMs beyond now + 24 h are dropped to 0 (W.saneStampMs): a
 * huge client stamp would otherwise park a hidden number for good (QA
 * 2026-10-13; firestore.rules now refuses them too, this covers old docs).
 */
async function loadLabels(db, tenantUid) {
  try {
    const snap = await db.collection('companies').doc(tenantUid).collection('contact_labels').get();
    const out = {};
    const now = Date.now();
    snap.docs.forEach((d) => {
      const x = d.data() || {};
      if (/^\d{10}$/.test(d.id) && x.kind) {
        out[d.id] = { kind: x.kind, policy: x.policy || '', capture: x.capture || '', ackAtMs: W.saneStampMs(toMs(x.ackAtMs), now), updatedAtMs: W.saneStampMs(toMs(x.updatedAtMs), now) };
      }
    });
    return out;
  } catch (e) {
    logger.warn('[contact-labels] read failed — continuing without labels', { err: e && e.message });
    return {};
  }
}

/**
 * Jo confirmed "stop copying and transcribing this number" (label kind
 * personal + capture 'off'). Both halves are required: a stray capture field
 * on another kind never stops anything.
 */
function captureOff(labels, phoneDigits, leadsOnNumber) {
  const d = String(phoneDigits || '').replace(/\D/g, '').slice(-10);
  const lb = d.length === 10 && labels ? labels[d] : null;
  if (!(!!lb && lb.kind === 'personal' && lb.capture === 'off')) return false;
  // Audit C-4 (2026-10-13): a number that BECAME a customer after the label was
  // set (or last confirmed with "Keep hidden") is captured again. Texts skipped
  // while it was off are not recoverable, so a real customer must never ride a
  // stale label. A customer that already existed when Jo labeled the number
  // (the sheet showed "On customer ...") keeps his choice. Callers pass the
  // tenant's own non-deleted leads that carry the number (a proxy line on 3+
  // leads is not indexed, so it never counts). A lead with no createdAt is
  // legacy and predates the label.
  const base = Math.max(Number(lb.ackAtMs) || 0, Number(lb.updatedAtMs) || 0);
  const newer = (leadsOnNumber || []).some((l) => l && l.deleted !== true && l.archived !== true && toMs(l.createdAt || l.createdAtMs) > base);
  return !newer;
}

module.exports = { loadLabels, captureOff, toMs };
