/**
 * inbound-sms-convert-logic.js — pure transforms behind the
 * convertUnmatchedSms callable (idea #7 Phase 2). Dependency-free (no
 * firebase) so tests/inbound-sms-convert.test.js can require() it directly and
 * the callable (handlers/inbound-sms-convert.js) shares the exact same code
 * path — no logic mirror to drift.
 *
 * The callable turns an `unmatched_sms` row (a text from a number that matched
 * no lead) into a real lead so the rep can work it, then auto-drafts an AI
 * reply. This module builds the rules-compatible lead document. It does NOT do
 * the Firestore reads/writes, the dedup query, or the draft call — those live
 * in the handler.
 */
'use strict';

// The lead's display name when all we have is a phone number: the last 4
// digits, so the kanban card is recognizable until the rep renames it. Never
// throws on odd input.
function leadNameFromSms(phoneDigits) {
  const d = typeof phoneDigits === 'string' ? phoneDigits.replace(/\D/g, '') : '';
  const last4 = d.slice(-4);
  return last4 ? ('Inbound SMS ' + last4) : 'Inbound SMS';
}

// Build the lead document for a converted unmatched text. Returns ONLY the
// domain fields (the caller stamps createdAt/stageStartedAt serverTimestamps).
// Shape mirrors the server lead-bridge path (mapPublicLeadToLead): stage 'New'
// (the canonical first kanban column), phoneDigits stamped for inbound-SMS
// re-matching, notes = the original text (clamped). userId/companyId are the
// converting admin's, so the lead is rules-compatible for their reads/writes.
function buildConvertedLead({ from, body, phoneDigits, ownerUid, companyId, unmatchedId }) {
  return {
    userId: ownerUid || null,
    companyId: companyId || ownerUid || null,
    firstName: leadNameFromSms(phoneDigits),
    lastName: '',
    phone: typeof from === 'string' ? from : '',
    phoneDigits: typeof phoneDigits === 'string' ? phoneDigits : '',
    address: '',
    // Canonical key + role (2026-10-04 numbers audit: 64 leads stored the
    // legacy display name 'New' and 62 had no stageRole). Migration 008
    // heals the ones already written.
    stage: 'new',
    stageRole: 'new',
    status: 'new',
    source: 'Inbound SMS',
    notes: String(body == null ? '' : body).slice(0, 2000),
    webLead: false,
    convertedFromUnmatchedSms: unmatchedId || null,
  };
}

module.exports = { leadNameFromSms, buildConvertedLead };
