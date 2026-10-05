/**
 * functions/esign-logic.js — the pure rules of in-house envelope signing.
 *
 * No Firebase, no network, no pdf-lib. Everything here is a plain function of
 * its inputs so tests can drive it directly (tests/esign-gaps-2026-10-04.test.js).
 * esign-envelope.js, esign-reminders.js and the estimate path all read the
 * SAME rules from here, so the signing page, the reminder cron and the
 * completion step cannot disagree about who signs next or what counts as
 * evidence.
 *
 * Written 2026-10-04 when BoldSign was retired (Jo: "retire BoldSign as long as
 * we're fully operational with our own"). The gaps it closes in the envelope
 * engine, against what BoldSign would have given us:
 *
 *   - MULTI-SIGNER. An envelope can carry up to MAX_SIGNERS signers (homeowner
 *     + co-owner is the common roofing case). They sign in order, each on
 *     their own single-use link. Every field belongs to exactly one signer
 *     (field.role = signer id), and a signer can only fill their own fields.
 *   - EVIDENCE PER SIGNER. Consent (with the exact text shown), IP, user
 *     agent, the time, the typed legal name and a digest of the values they
 *     submitted — recorded on the envelope for every signer, not once per
 *     envelope.
 *   - A SIGNATURE CERTIFICATE page on the executed PDF that prints the trail.
 *   - DECLINE, REMINDERS, EXPIRY — envelope states BoldSign had and we did not.
 *   - The estimate's own signatureStatus mirrors the envelope, so every CRM
 *     surface that read the BoldSign webhook's statuses keeps working.
 */
'use strict';

const MAX_SIGNERS = 4;
const SIGNER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEFAULT_SIGNER_ID = 'signer';

/** Shown on the signing page AND stored with each signer's consent record. */
const CONSENT_TEXT =
  'By signing electronically I agree that my electronic signature is the legal ' +
  'equivalent of my handwritten signature, and I consent to do business electronically.';

/** Reminder cadence — the same one BoldSign was configured with (every 2 days, 3 times). */
const REMINDER_EVERY_MS = 2 * 86_400_000;
const REMINDER_MAX = 3;

function str(v, max) {
  return (typeof v === 'string' ? v : '').trim().slice(0, max || 200);
}

/**
 * The envelope's signers, in signing order. An envelope written before
 * multi-signer existed has no `signers` array: it has exactly one signer,
 * built from signerName / signerEmail, with the id every legacy field already
 * carries ('signer').
 */
function normalizeSigners(env) {
  const e = env || {};
  if (Array.isArray(e.signers) && e.signers.length) {
    return e.signers
      .map((s, i) => Object.assign({}, s, {
        id: SIGNER_ID_RE.test(String((s && s.id) || '')) ? String(s.id) : (i === 0 ? DEFAULT_SIGNER_ID : 'signer' + (i + 1)),
        name: str(s && s.name, 200),
        email: str(s && s.email, 320).toLowerCase(),
        order: Number.isFinite(Number(s && s.order)) ? Number(s.order) : i,
        status: (s && s.status) || 'pending',
      }))
      .sort((a, b) => a.order - b.order);
  }
  return [{
    id: DEFAULT_SIGNER_ID,
    name: str(e.signerName, 200),
    email: str(e.signerEmail, 320).toLowerCase(),
    order: 0,
    status: e.status === 'completed' ? 'signed' : 'pending',
  }];
}

/**
 * The fields one signer fills. With a single signer every field is theirs,
 * whatever its role says (layouts saved before multi-signer all say 'signer',
 * and a stray role must never leave a field nobody can fill). With several,
 * a field belongs to the signer whose id is its role.
 */
function fieldsForSigner(env, signerId) {
  const fields = Array.isArray(env && env.fields) ? env.fields : [];
  const signers = normalizeSigners(env);
  if (signers.length <= 1) return fields.slice();
  return fields.filter((f) => String((f && f.role) || DEFAULT_SIGNER_ID) === String(signerId));
}

/** The first signer (in order) who has not signed — null when everyone has. */
function nextPendingSigner(env) {
  return normalizeSigners(env).find((s) => s.status !== 'signed') || null;
}

/** The signer a token belongs to (tokens minted before multi-signer carry no signerId). */
function signerForToken(env, tok) {
  const signers = normalizeSigners(env);
  const id = (tok && tok.signerId) || signers[0].id;
  return signers.find((s) => s.id === id) || null;
}

/**
 * Sanitise a signer list arriving from a rep's client. Throws Error(message)
 * on the first problem. `requireEmail` is true when the link will be emailed.
 */
function sanitizeSignerInput(list, opts) {
  const o = opts || {};
  if (!Array.isArray(list) || !list.length) throw new Error('At least one signer is required.');
  if (list.length > MAX_SIGNERS) throw new Error('At most ' + MAX_SIGNERS + ' signers per document.');
  const out = [];
  const ids = new Set();
  const emails = new Set();
  list.forEach((s, i) => {
    const id = i === 0 ? DEFAULT_SIGNER_ID : (SIGNER_ID_RE.test(String((s && s.id) || '')) ? String(s.id) : 'signer' + (i + 1));
    if (ids.has(id)) throw new Error('Two signers share the id ' + id + '.');
    ids.add(id);
    const name = str(s && s.name, 200);
    const email = str(s && s.email, 320).toLowerCase();
    if (!name) throw new Error('Signer ' + (i + 1) + ' needs a name.');
    if (email && !EMAIL_RE.test(email)) throw new Error('Signer ' + (i + 1) + ' has an invalid email.');
    if (o.requireEmail && !email) throw new Error('Signer ' + (i + 1) + ' needs an email to receive the link.');
    if (email) {
      // Two signers on one inbox would let one person sign twice from the
      // same mailbox without anyone noticing.
      if (emails.has(email)) throw new Error('Each signer needs their own email address.');
      emails.add(email);
    }
    out.push({ id, name, email, order: i, status: 'pending' });
  });
  return out;
}

/**
 * A layout is sendable when every signer owns at least one REQUIRED field and
 * (with several signers) no field is orphaned. Throws Error(message).
 */
function validateSignerLayout(env) {
  const signers = normalizeSigners(env);
  const fields = Array.isArray(env && env.fields) ? env.fields : [];
  if (signers.length > MAX_SIGNERS) throw new Error('At most ' + MAX_SIGNERS + ' signers per document.');
  if (signers.length > 1) {
    const ids = new Set(signers.map((s) => s.id));
    const orphan = fields.find((f) => !ids.has(String((f && f.role) || DEFAULT_SIGNER_ID)));
    if (orphan) throw new Error('Field ' + orphan.id + ' is not assigned to any signer.');
  }
  for (const s of signers) {
    const mine = fieldsForSigner(env, s.id);
    if (!mine.some((f) => f && f.required !== false)) {
      throw new Error((s.name || 'Each signer') + ' has no required field to sign — add a signature for them.');
    }
  }
  return true;
}

/**
 * The submitted values a signer may write: only ids of THEIR fields. A
 * co-owner's link must not be able to fill (or blank) the homeowner's
 * signature box. Returns { values, foreign } — foreign ids are refused by the
 * caller, never silently dropped.
 */
function pickSignerValues(env, signerId, submitted) {
  const mine = new Set(fieldsForSigner(env, signerId).map((f) => f.id));
  const values = {};
  const foreign = [];
  Object.keys(submitted || {}).forEach((k) => {
    if (mine.has(k)) values[k] = submitted[k];
    else foreign.push(k);
  });
  return { values, foreign };
}

/**
 * One signer's evidence record (ESIGN Act / UETA): affirmative consent with
 * the exact words shown, when, from where, on what device, under what typed
 * name, and a digest of what they submitted. Every key is always present, so
 * a missing fact reads as null — never as an absent key a reader skips.
 */
function buildSignerEvidence(input) {
  const i = input || {};
  const at = Number.isFinite(Number(i.at)) ? Number(i.at) : Date.now();
  return {
    status: 'signed',
    signedAt: at,
    typedName: str(i.typedName, 200) || null,
    ip: i.ip ? String(i.ip).slice(0, 64) : null,
    ua: i.ua ? String(i.ua).slice(0, 300) : null,
    consent: {
      agreed: i.consent === true,
      at,
      text: str(i.consentText, 600) || CONSENT_TEXT,
      ip: i.ip ? String(i.ip).slice(0, 64) : null,
      ua: i.ua ? String(i.ua).slice(0, 300) : null,
    },
    valuesSha256: i.valuesSha256 ? String(i.valuesSha256) : null,
    fieldIds: Array.isArray(i.fieldIds) ? i.fieldIds.slice(0, 200).map(String) : [],
    viewedAt: Number.isFinite(Number(i.viewedAt)) ? Number(i.viewedAt) : null,
  };
}

/** Evidence keys that MUST be present (and non-null) before an envelope may complete. */
const REQUIRED_EVIDENCE = ['signedAt', 'ip', 'ua', 'consent.agreed', 'consent.at', 'consent.text', 'valuesSha256'];

/** Which required evidence facts a signer record lacks — [] when complete. */
function missingEvidence(signer) {
  const s = signer || {};
  return REQUIRED_EVIDENCE.filter((k) => {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), s);
    return v == null || v === false || v === '';
  });
}

/** Map an envelope event to the estimate's signatureStatus vocabulary (the BoldSign webhook's). */
function estimateStatusFor(event) {
  return ({
    sent: 'sent', resent: 'sent', viewed: 'viewed', signer_completed: 'viewed',
    completed: 'signed', declined: 'declined', voided: 'voided', expired: 'expired',
  })[event] || null;
}

/** ms → "2026-10-04 14:03:22 UTC" — the certificate prints UTC so no reader guesses a zone. */
function utcStamp(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(n).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * The lines of the signature certificate appended to the executed PDF.
 * env: the envelope (with signers[] carrying evidence); extra: { completedAt }.
 */
function certificateLines(env, extra) {
  const e = env || {};
  const x = extra || {};
  const out = [];
  out.push({ h: 'Signature Certificate' });
  out.push({ t: 'Document: ' + (e.title || 'Document') });
  out.push({ t: 'Envelope ID: ' + (x.envelopeId || e.id || '-') });
  out.push({ t: 'Sent by: ' + (e.companyName || 'No Big Deal Home Solutions') });
  out.push({ t: 'Original document SHA-256: ' + (e.sourceSha256 || '-') });
  out.push({ t: 'Pages in original: ' + (e.pageCount || (Array.isArray(e.pages) ? e.pages.length : '-')) });
  out.push({ t: 'Sent: ' + utcStamp(e.sentAtMs) + '    Completed: ' + utcStamp(x.completedAt) });
  out.push({ sp: 1 });
  normalizeSigners(e).forEach((s, i) => {
    out.push({ h2: 'Signer ' + (i + 1) + ': ' + (s.typedName || s.name || '-') });
    if (s.email) out.push({ t: 'Email: ' + s.email });
    out.push({ t: 'First viewed: ' + utcStamp(s.viewedAt) + '    Signed: ' + utcStamp(s.signedAt) });
    out.push({ t: 'IP address: ' + (s.ip || '-') });
    out.push({ t: 'Device: ' + (s.ua || '-') });
    const c = s.consent || {};
    out.push({ t: 'Consent to sign electronically: ' + (c.agreed ? 'AGREED at ' + utcStamp(c.at) : 'NOT RECORDED') });
    if (c.text) out.push({ t: 'Consent text shown: "' + c.text + '"' });
    out.push({ t: 'Submitted values SHA-256: ' + (s.valuesSha256 || '-') });
    out.push({ sp: 1 });
  });
  out.push({ t: 'Each signer used a single-use link that expired after one signature. Values were drawn into the page content (flattened); the original document was never modified.' });
  return out;
}

// ─── Email bodies ─────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** The "please sign" email — also the reminder (reminder: true) and the next-signer handoff. */
function linkEmail(o) {
  const p = o || {};
  const brand = escHtml(p.brand || 'No Big Deal Home Solutions');
  const title = escHtml(p.title || 'a document');
  const lead = p.reminder
    ? `A friendly reminder: <strong>${title}</strong> from ${brand} is still waiting for your signature.`
    : `${brand} has <strong>${title}</strong> ready for your signature. You can review and sign it right on your phone — it takes about a minute.`;
  return {
    subject: (p.reminder ? 'Reminder: please sign ' : 'Please sign: ') + (p.title || 'your document'),
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#12223d;">
            <p>Hi ${escHtml(p.name || 'there')},</p>
            <p>${lead}</p>
            <p style="text-align:center;margin:28px 0;">
              <a href="${escHtml(p.link)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;display:inline-block;">Review &amp; Sign</a>
            </p>
            <p style="font-size:12px;color:#666;">This secure link expires in ${Number(p.ttlDays) || 14} days and can only be used once.
               If you'd rather not sign, the page has a Decline option. If you weren't expecting this, you can ignore this email.</p>
          </div>`,
  };
}

/** The signed copy, delivered to every signer when the envelope completes. */
function signedCopyEmail(o) {
  const p = o || {};
  const brand = escHtml(p.brand || 'No Big Deal Home Solutions');
  const title = escHtml(p.title || 'your document');
  return {
    subject: 'Signed copy: ' + (p.title || 'your document'),
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#12223d;">
            <p>Hi ${escHtml(p.name || 'there')},</p>
            <p>Thank you — <strong>${title}</strong> with ${brand} is fully signed. Your copy is attached as a PDF${p.attached === false ? ' (it was too large to attach — ask your rep and they will send it)' : ''}.</p>
            <p style="font-size:12px;color:#666;">Keep this email for your records. The last page of the PDF is the signature certificate.</p>
          </div>`,
  };
}

module.exports = {
  MAX_SIGNERS, DEFAULT_SIGNER_ID, CONSENT_TEXT, REMINDER_EVERY_MS, REMINDER_MAX, REQUIRED_EVIDENCE, EMAIL_RE,
  normalizeSigners, fieldsForSigner, nextPendingSigner, signerForToken, sanitizeSignerInput,
  validateSignerLayout, pickSignerValues, buildSignerEvidence, missingEvidence, estimateStatusFor,
  utcStamp, certificateLines, escHtml, linkEmail, signedCopyEmail,
};
