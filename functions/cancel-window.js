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

// Platform tenant (same convention as lead-alert.js / render-pdf.js).
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
// Shown to the rep when a contract would print a blank seller on the Notice
// of Cancellation (a company that has not set its legal business name).
const SELLER_NAME_REQUIRED_MSG = 'Add your legal business name first (Settings → Company → Brand Identity → Legal / Company Name). '
  + 'It is printed as the seller on the contract and its Notice of Cancellation, so this contract was not sent.';

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

/**
 * The fields a signing writes beside cancelBy (2026-10-08, review R4 D9).
 * A re-date that failed is never silent: the record (document / deal /
 * envelope) and the lead carry cancelPacketStale, the customer page shows the
 * rep a flag, and the right-to-cancel template prefills the real signing day
 * (cancelPacketSignedOn). A clean signing clears the lead's flag.
 *   rec   { cancelBy, signedOn, stale } — KyLaw.signingCancelBy's shape
 *   source 'deal_room' | 'remote_sign' | 'esign' | 'in_person'
 */
function staleRecordPatch(rec) {
  const r = rec || {};
  return r.stale ? { cancelPacketStale: true, cancelPacketSignedOn: r.signedOn || '' } : {};
}
function staleLeadPatch(rec, source) {
  const r = rec || {};
  if (!r.stale) return { cancelPacketStale: false };
  return { cancelPacketStale: true, cancelPacketSignedOn: r.signedOn || '', cancelPacketStaleSource: String(source || '') };
}

/**
 * Re-date the Notice of Right to Cancel in a STORED record to the signing
 * moment, trying twice (one retry) before giving up loudly.
 *   read()      → Promise<html>  (the stored record)
 *   write(html) → Promise        (store it back)
 * → { cancelBy, signedOn, stale, html }
 * cancelBy is always counted from `when` (KyLaw.signingCancelBy), never from
 * the old packet. stale: the stored paper could not be re-dated (or could not
 * even be read, so nobody knows what it says). A record without a packet is
 * left untouched and is not stale.
 */
async function redateStoredPacket(o) {
  const when = o.when == null ? new Date() : o.when;
  const log = o.logger || null;
  const label = o.label || '[cancel-window]';
  let lastHtml = '';
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cur = String(await o.read());
      lastHtml = cur;
      if (!KyLaw.hasCancelPacket(cur)) return Object.assign(KyLaw.signingCancelBy(cur, when, o.timeZone), { html: cur });
      const next = KyLaw.restampCancelPacket(cur, when);
      const rec = KyLaw.signingCancelBy(next, when, o.timeZone);
      if (rec.stale) throw new Error('the re-dated notice does not carry the signing date');
      await o.write(next);
      return Object.assign(rec, { html: next });
    } catch (e) {
      lastErr = e;
      if (log) log.warn(label + ' cancel packet re-date failed (attempt ' + attempt + ' of 2)', { msg: e && e.message });
    }
  }
  if (log) log.error(label + ' cancel packet NOT re-dated — the record is flagged for a new Notice of Cancellation', { msg: lastErr && lastErr.message });
  return Object.assign(KyLaw.signingCancelBy(lastHtml, when, o.timeZone), { stale: true, html: lastHtml });
}

/**
 * Does `lead` belong to this owner? Its userId is the owner's, or (a teammate's
 * lead) both carry the same companyId. A lead with neither match is another
 * tenant's — a public signing link must never write to it.
 */
function leadBelongsTo(lead, owner) {
  const l = lead || {};
  const o = owner || {};
  if (o.ownerUid && l.userId === o.ownerUid) return true;
  return !!(o.companyId && l.companyId && String(l.companyId) === String(o.companyId));
}

/**
 * Stamp lead.cancelBy — only on a lead that belongs to `owner`
 * ({ ownerUid, companyId } of the signed record). `extra` rides along (the
 * staleLeadPatch flag). Best-effort; never throws.
 */
async function stampLeadCancelBy(db, leadId, cancelBy, logger, owner, extra) {
  if (!leadId || !/^[A-Za-z0-9_-]{1,128}$/.test(String(leadId))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cancelBy || ''))) return false;
  try {
    const ref = db.doc(`leads/${leadId}`);
    const snap = await ref.get();
    if (!snap.exists || !leadBelongsTo(snap.data(), owner)) {
      if (logger) logger.warn('[cancel-window] lead cancelBy refused: not the owner\'s lead', { leadId });
      return false;
    }
    await ref.update(Object.assign({}, extra || {}, { cancelBy: String(cancelBy) }));
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
  // The seller on the Notice of Cancellation. Only NBD's own lead (tenant key
  // = the NBD owner uid; a key-less legacy lead is NBD's) falls back to NBD's
  // name; another company with none set gets '' and the send is refused
  // (SELLER_NAME_REQUIRED_MSG) — never NBD named as their seller.
  const tenantKey = l.companyId || l.userId;
  const nbd = !tenantKey || String(tenantKey) === NBD_OWNER_UID;
  return {
    timeZone: KyLaw.resolveTimeZone(cp),
    sellerName: brand.legalName || cp.companyName || (nbd ? 'No Big Deal Home Solutions' : ''),
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
 * check the homeowner's signed copy would carry a second set. A contract the
 * rep UPLOADED with its own forms carries the same flag (esign-setup.js finds
 * "Notice of Cancellation" in the PDF text, or the rep ticks the box —
 * createEsignEnvelope / saveEsignFields store it; review R4 D8, 2026-10-08).
 */
function envelopeNeedsCancelNotice(env) {
  if (!env || env.cancelFormsIncluded === true) return false;
  return envelopeIsContract(env);
}

/**
 * What a signed envelope records when no dated forms of its own say otherwise
 * (an uploaded contract carrying the rep's own forms, or one whose notice
 * pages could not be appended): cancelBy counted from the signing for an
 * envelope that IS the contract; '' for any other document.
 * → { cancelBy, signedOn, stale:false }
 */
function envelopeSigningCancelBy(env, when, timeZone) {
  const rec = KyLaw.signingCancelBy('', when == null ? new Date() : when, timeZone);
  return envelopeIsContract(env) ? rec : { cancelBy: '', signedOn: rec.signedOn, stale: false };
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
  SELLER_NAME_REQUIRED_MSG,
  CONTRACT_DOC_TYPES, isContractDocType, finalizeSignedPacket, cancelByFor, stampLeadCancelBy, leadBelongsTo,
  packetOptsFrom, loadPacketOpts, envelopeNeedsCancelNotice,
  staleRecordPatch, staleLeadPatch, redateStoredPacket, envelopeSigningCancelBy,
};
