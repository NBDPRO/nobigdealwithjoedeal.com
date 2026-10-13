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
  if (typeof v.toMillis === 'function') return v.toMillis();
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
function captureOff(labels, phoneDigits) {
  const d = String(phoneDigits || '').replace(/\D/g, '').slice(-10);
  const lb = d.length === 10 && labels ? labels[d] : null;
  return !!lb && lb.kind === 'personal' && lb.capture === 'off';
}

module.exports = { loadLabels, captureOff };
