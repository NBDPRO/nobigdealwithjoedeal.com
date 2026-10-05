/**
 * functions/cancel-window.js — the 3-day right to cancel on the server's
 * signing paths (2026-10-04).
 *
 * Every contract signed in the app carries the Notice of Right to Cancel and
 * two completed FTC Notice of Cancellation forms (plus the KRS 367.624(4)
 * forms on a Kentucky insurance job) — ky-insurance-law.js cancelPacketHtml,
 * the same copy the browser prints. The packet must be dated the day the
 * homeowner SIGNS, and its three business days count from that day, so the
 * server re-dates it wherever it records a signature:
 *
 *   remote-signing.js   submitSignature  — the signed HTML record
 *   deal-acceptance.js  submitDealAcceptance — the stored deal page
 *   esign-envelope.js   submitEsignEnvelope — the signed PDF (pages appended
 *                       by cancel-notice-pdf.js)
 *
 * and records the last day to cancel as `cancelBy` ("YYYY-MM-DD") on the
 * document / deal / envelope AND on the lead — the customer page shows it,
 * and a stage move that starts work inside it warns.
 *
 * Pure helpers here are tested by tests/contract-cancel-forms.test.js.
 */
'use strict';

const KyLaw = require('./ky-insurance-law');
const { envelopeIsContract } = require('./job-spine-logic');

// Generated document types that are contracts (they carry the packet).
const CONTRACT_DOC_TYPES = ['contract', 'proposal'];

function isContractDocType(type) {
  return CONTRACT_DOC_TYPES.indexOf(String(type || '')) !== -1;
}

/**
 * The record to store for a remotely signed document: the signer's copy with
 * the packet re-rendered from the ORIGINAL we served (never the signer's
 * bytes) and dated `when`. When the original carries a packet and the signed
 * copy lost it, the packet is put back before </body>. An original without a
 * packet is returned untouched.
 */
function finalizeSignedPacket(originalHtml, signedHtml, when) {
  const orig = String(originalHtml || '');
  const signed = String(signedHtml || '');
  if (!KyLaw.hasCancelPacket(orig)) return signed;
  const at = when == null ? new Date() : when;
  if (/<!--nbd-cancel-packet:start-->/.test(signed)) {
    return KyLaw.restampCancelPacket(signed, at, orig);
  }
  const packet = KyLaw.restampCancelPacket(orig.match(/<!--nbd-cancel-packet:start-->[\s\S]*?<!--nbd-cancel-packet:end-->/)[0], at, orig);
  return /<\/body>/i.test(signed) ? signed.replace(/<\/body>/i, () => packet + '</body>') : signed + packet;
}

/**
 * cancelBy for a signing at `when`: the packet's own date when the HTML
 * carries one (so the record and the paper agree), else 3 business days from
 * `when` in `timeZone` (default America/New_York).
 */
function cancelByFor(html, when, timeZone) {
  return KyLaw.packetCancelBy(html) || KyLaw.cancelBy(when == null ? new Date() : when, timeZone);
}

/** Stamp lead.cancelBy. Best-effort; never throws. */
async function stampLeadCancelBy(db, leadId, cancelBy, logger) {
  if (!leadId || !/^\d{4}-\d{2}-\d{2}$/.test(String(cancelBy || ''))) return false;
  try {
    await db.doc(`leads/${leadId}`).update({ cancelBy: String(cancelBy) });
    return true;
  } catch (e) {
    if (logger) logger.warn('[cancel-window] lead cancelBy stamp failed', { leadId, msg: e && e.message });
    return false;
  }
}

/**
 * Packet inputs from stored data, for a server path with no rendered packet
 * to copy (an uploaded e-sign PDF): the tenant's legal name, its mailing
 * address (brand.contact.mailingAddress — the address the law requires,
 * never the letterhead one), email, fax and timezone from
 * companyProfile/{companyId || userId}; the homeowner, property, state and
 * Kentucky-insurance classification from the lead.
 */
function packetOptsFrom(lead, profile) {
  const l = lead || {};
  const cp = profile || {};
  const brand = cp.brand || {};
  const j = KyLaw.classifyLead(l) || {};
  return {
    timeZone: KyLaw.resolveTimeZone(cp),
    sellerName: brand.legalName || cp.companyName || 'No Big Deal Home Solutions',
    sellerAddress: KyLaw.contractorMailingAddress(cp),
    email: (brand.contact && brand.contact.email) || '',
    fax: String(cp.businessFax || '').trim(),
    homeownerName: ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || '',
    propertyAddress: l.address || '',
    state: j.state || '',
    kyInsurance: j.kyInsurance === true,
  };
}

/**
 * Does submitEsignEnvelope append the notice + forms to this envelope's signed
 * PDF? Only for an envelope that IS the contract (envelopeIsContract — the
 * same test that moves the job to Contract Signed), and never when the
 * document already carries them: an estimate envelope (sendEstimateEnvelope,
 * #2166) builds its contract PDF WITH the two completed FTC forms and sets
 * cancelFormsIncluded — its title is "Roofing Contract — …", so without this
 * check the homeowner's signed copy would carry a second set.
 */
function envelopeNeedsCancelNotice(env) {
  if (!env || env.cancelFormsIncluded === true) return false;
  return envelopeIsContract(env);
}

async function loadPacketOpts(db, leadId) {
  const leadSnap = await db.doc(`leads/${leadId}`).get();
  const lead = leadSnap.exists ? (leadSnap.data() || {}) : {};
  let profile = {};
  const key = lead.companyId || lead.userId;
  if (key) {
    try {
      const cp = await db.doc(`companyProfile/${key}`).get();
      if (cp.exists) profile = cp.data() || {};
    } catch (_) { profile = {}; }
  }
  return packetOptsFrom(lead, profile);
}

module.exports = {
  CONTRACT_DOC_TYPES, isContractDocType, finalizeSignedPacket, cancelByFor, stampLeadCancelBy,
  packetOptsFrom, loadPacketOpts, envelopeNeedsCancelNotice,
};
