'use strict';
/**
 * inbound-stamp.js — what an inbound customer message writes on the lead
 * (2026-11-03, Follow-up board). PURE: the caller passes the Firestore
 * sentinels in, so this unit-tests with no firebase.
 *
 * Before: incomingSMS wrote lastContactedAt on an inbound text, which every
 * reader (the estimate board's touchMs) reads as "Jo touched this lead". A
 * customer replying made the estimate look freshly contacted and hid it, the
 * opposite of what Jo needs. And nothing wrote lastInboundAt, so "customer is
 * waiting on your reply" could not be computed.
 *
 * Now an inbound message stamps ONLY the customer-side fields:
 *   lastInboundAt   the moment the customer wrote (a server timestamp)
 *   lastInboundVia  'sms' | 'portal'
 *   unreadInbound   +1
 * and never lastContactedAt (that stays Jo's own touch: calls, texts he logs).
 * Readers that used lastContactedAt as "any activity" (stale-lead cleanup, the
 * no-next-step nudge, Pixel mode, ...) now also read lastInboundAt, so a
 * lead that just wrote is still not "stale".
 *
 * A message that may be a STOP keyword stamps nothing: an opt-out is not a
 * customer waiting on an answer.
 */
const VIAS = Object.freeze(['sms', 'portal']);

/**
 * @param {{via:string, possibleStop?:boolean}} msg
 * @param {{serverTimestamp:function, increment:function}} fv  FieldValue helpers
 * @returns {object|null} the lead patch, or null when nothing should be written
 */
function inboundLeadPatch(msg, fv) {
  const m = msg || {};
  if (m.possibleStop === true) return null;
  if (VIAS.indexOf(m.via) === -1) return null;
  return {
    lastInboundAt: fv.serverTimestamp(),
    lastInboundVia: m.via,
    unreadInbound: fv.increment(1),
  };
}

module.exports = { inboundLeadPatch, VIAS };
