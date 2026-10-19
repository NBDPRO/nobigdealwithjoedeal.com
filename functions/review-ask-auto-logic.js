'use strict';
/**
 * review-ask-auto-logic.js — the automatic homeowner review ask (2026-10-15). PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Joe, 2026-10-15: every job that is paid in full gets ONE review ask, sent
 * automatically, in the same 3–21 day window the rep nudge uses
 * (review-request-nudge.js). Ask EVERY eligible customer: no rating first, no
 * "only if you were happy", no incentive (Google's review policy and the FTC
 * rule on consumer reviews, 16 CFR 465). The I/O lives in review-ask-auto.js.
 *
 * THE WINDOW COUNTS FROM THE DAY THE MONEY WAS RECEIVED. A payment's `at` is
 * the date the rep picked in the Record payment / Mark paid / Catch up sheet
 * (invoice-pipeline.js receivedAtFromDateInput: "the date the payment was
 * received"); `recordedAt` is when it was typed. On 2026-10-15 Jo backfilled
 * months of old payments in one sitting, which also moved those jobs into
 * Final Payment TODAY. The rep nudge anchors on max(stage entry, last
 * payment), so a backfilled job looks "just paid". The automatic ask never
 * looks at the stage date or recordedAt: only receivedMs below. A job with no
 * dated payment at all is not asked automatically (the rep nudge still runs).
 *
 * Flags (functions/.env.nobigdeal-pro; anything but the literal 'true' is off):
 *   REVIEW_ASK_AUTO_EMAIL_ENABLED — the email, from jd@, CAN-SPAM footer.
 *   REVIEW_ASK_EMAIL_PHOTO_ENABLED — the customer's own before/after photo
 *     above the ask (review-ask-photo.js; emailContent's optional `photo`).
 *   REVIEW_ASK_AUTO_TEXT_ENABLED  — DARK until the Twilio A2P campaign is
 *     approved. Only for a customer with no usable email, only with a stored
 *     web-form texting consent, 8am–9pm their time, STOP / Do Not Text and the
 *     declined-consent decision checked by review-ask-auto.js.
 */

const roles = require('./stage-roles');
const { isQuietBackfill, isBackfillInvoice } = require('./quiet-backfill');
const MCR = require('./missed-call-reply-logic');
const SendWindow = require('./sms-send-window');

const EMAIL_FLAG = 'REVIEW_ASK_AUTO_EMAIL_ENABLED';
const TEXT_FLAG = 'REVIEW_ASK_AUTO_TEXT_ENABLED';
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = 3;
const MAX_DAYS = 21;
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
// NBD's Google review link (Joe, 2026-10-15). Another tenant uses its own
// users/{uid}.googleReviewUrl; NBD falls back to this one.
const NBD_REVIEW_URL = 'https://g.page/r/CXzIjLwvtRPdEBM/review';
const SOURCE = 'auto-email';
const TEXT_SOURCE = 'auto-text';

const flagOn = (env, name) => !!env && env[name] === 'true';
const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|y|1|on)$/i.test(v.trim()));
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim().slice(0, 500) : '');

function ms(t) {
  if (!t) return 0;
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  if (t instanceof Date) return t.getTime();
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : 0;
}

const DEAD = { void: 1, voided: 1, cancelled: 1, canceled: 1, uncollectible: 1, draft: 1 };

/**
 * When the job's money finished arriving, by DATE RECEIVED: the latest `at`
 * on any payments[] entry (a refund is not a payment) across the job's live
 * invoices. A paid invoice with no payments[] ledger (Stripe / legacy) falls
 * back to its paidAt. Never recordedAt, updatedAt or the stage date.
 * 0 = no dated payment.
 */
function receivedMs(invoices) {
  let m = 0;
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!inv || inv.deleted === true || DEAD[String(inv.status || '').toLowerCase()]) continue;
    // A payment-backfill invoice records money collected long ago: its date never opens the ask window.
    if (isBackfillInvoice(inv)) continue;
    const pays = (Array.isArray(inv.payments) ? inv.payments : []).filter((p) => p && !p.refund && Number(p.amount) > 0);
    if (pays.length) { for (const p of pays) m = Math.max(m, ms(p.at)); continue; }
    if (String(inv.status || '').toLowerCase() === 'paid') m = Math.max(m, ms(inv.paidAt));
  }
  return m;
}

/** Inside the 3–21 day ask window, counted from the date received. */
function inWindow(recvMs, nowMs) {
  const r = Number(recvMs) || 0;
  const now = Number(nowMs) || Date.now();
  return r > 0 && r <= now - MIN_DAYS * DAY_MS && r >= now - MAX_DAYS * DAY_MS;
}

const tenantOf = (lead) => String((lead && (lead.companyId || lead.userId)) || '');
const isNbd = (lead) => tenantOf(lead) === NBD_OWNER_UID;
const doNotContact = (l) => truthy(l.doNotContact) || truthy(l.dnc);
/** One attempt per job: the key the claim and the nudge's deferral share. */
const jobKey = (jobId) => (jobId ? String(jobId) : '_lead');
const attempted = (lead, jobId) => {
  const a = lead && lead.reviewAutoAsk;
  return !!a && typeof a === 'object' && a.jobKey === jobKey(jobId) && !!a.status;
};

/**
 * Who may be asked automatically, before any read. Shared by both channels.
 * → { ok: true } | { ok: false, reason }
 */
function baseEligibility({ lead, job, jobId, recvMs, nowMs }) {
  const l = lead || {};
  if (!isNbd(l)) return { ok: false, reason: 'not_nbd' };          // jd@ speaks for NBD only
  if (l.deleted === true || l.deletedAt) return { ok: false, reason: 'deleted' };
  if (roles.isLost(l) || (job && roles.isLost(job))) return { ok: false, reason: 'lost' };
  if (isQuietBackfill(l) || (job && isQuietBackfill(job))) return { ok: false, reason: 'quiet_backfill' };
  if (l.reviewRequested === true || (job && ms(job.reviewRequestedAt))) return { ok: false, reason: 'already_requested' };
  if (attempted(l, jobId)) return { ok: false, reason: 'already_attempted' };
  if (doNotContact(l)) return { ok: false, reason: 'do_not_contact' };
  if (!inWindow(recvMs, nowMs)) return { ok: false, reason: recvMs ? 'outside_window' : 'no_received_date' };
  return { ok: true };
}

/** The email channel's pre-flight. Pure. */
function planEmail({ env, lead, job, jobId, recvMs, nowMs }) {
  if (!flagOn(env, EMAIL_FLAG)) return { send: false, reason: 'flag_disabled' };
  const b = baseEligibility({ lead, job, jobId, recvMs, nowMs });
  if (!b.ok) return { send: false, reason: b.reason };
  if (!validEmail(lead.email)) return { send: false, reason: 'no_email' };
  return { send: true, to: String(lead.email).trim() };
}

/**
 * The text channel's pre-flight (DARK). Only when there is no usable email,
 * and only with a stored web-form consent for the number on the lead. The
 * STOP register, Do Not Text, texting switch and declined-consent decision
 * need reads and live in review-ask-auto.js.
 */
function planText(args) {
  const { env, lead, job, jobId, recvMs, nowMs } = args || {};
  if (!flagOn(env, TEXT_FLAG)) return { send: false, reason: 'flag_disabled' };
  const b = baseEligibility({ lead, job, jobId, recvMs, nowMs });
  if (!b.ok) return { send: false, reason: b.reason };
  if (validEmail(lead.email)) return { send: false, reason: 'has_email' };   // one ask: the email
  if (truthy(lead.doNotText) || truthy(lead.smsOptOut) || truthy(lead.smsOptedOut)) return { send: false, reason: 'do_not_text' };
  const d = MCR.digits10(lead.phone || lead.phoneDigits);
  if (!d) return { send: false, reason: 'no_number' };
  if (!MCR.webFormConsent(lead)) return { send: false, reason: 'no_consent' };
  if (!(args && args.ignoreHours) && !SendWindow.withinRecipientWindow(Number(nowMs) || Date.now(), lead)) return { send: false, reason: 'quiet_hours' };
  return { send: true, to: '+1' + d };
}

/**
 * Will the automatic ask handle this job? The rep nudge (06:45 brief / 08:15)
 * runs before the 10:00 sweep, so it waits for a job the sweep will ask
 * instead of telling Joe to ask by hand. Once the sweep has tried (sent,
 * unsubscribed, no postal address, failed) the job carries reviewAutoAsk and
 * the nudge goes back to normal for it.
 */
function willHandle(args) {
  return planEmail(args).send || planText(Object.assign({}, args, { ignoreHours: true })).send;
}

/** The review link: the rep's own (https) → NBD's. '' = nothing to link. */
function reviewUrlFor(lead, repUrl) {
  return safeUrl(repUrl) || (isNbd(lead) ? NBD_REVIEW_URL : '');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const firstNameOf = (lead) => String((lead && (lead.firstName || lead.name)) || '').trim().split(/\s+/)[0].slice(0, 40);

/**
 * The customer's own photos above the ask (review-ask-photo.js, flag
 * REVIEW_ASK_EMAIL_PHOTO_ENABLED). `photo` is its contentFor() shape:
 * { kind: 'pair' | 'single', word: 'roof' | 'project', images: [{ cid, label, alt }] }.
 * The images are inline (cid:) attachments, never a URL. One line that shows
 * the work and nothing else: the ask below it is unchanged.
 */
function photoBlock(photo) {
  const imgs = (photo && Array.isArray(photo.images) ? photo.images : [])
    .filter((im) => im && /^[a-z0-9-]{1,40}$/.test(String(im.cid || '')));
  const word = photo && photo.word === 'project' ? 'project' : 'roof';
  const img = (im, w) => '<img src="cid:' + im.cid + '" alt="' + esc(im.alt) + '" width="' + w + '" '
    + 'style="display:block;width:100%;max-width:' + w + 'px;height:auto;border:0;border-radius:6px;">';
  if (photo && photo.kind === 'pair' && imgs.length === 2) {
    const cell = (im, pad) => '<td width="50%" valign="top" style="padding:' + pad + ';vertical-align:top;">' + img(im, 252)
      + '<div style="font-size:13px;color:#6b7280;text-align:center;padding-top:4px;">' + esc(im.label) + '</div></td>';
    return {
      text: "Here's your " + word + ', before and after (the two photos are in this email).\n\n',
      html: '<p>Here&#39;s your ' + word + ', before and after:</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;"><tr>'
        + cell(imgs[0], '0 4px 0 0') + cell(imgs[1], '0 0 0 4px') + '</tr></table>',
    };
  }
  if (photo && photo.kind === 'single' && imgs.length === 1) {
    return {
      text: "Here's your finished " + word + ' (the photo is in this email).\n\n',
      html: '<p>Here&#39;s your finished ' + word + ':</p><div style="margin:0 0 16px;">' + img(imgs[0], 512) + '</div>',
    };
  }
  return { text: '', html: '' };
}

/**
 * The email. One plain ask, the same words to everyone: no rating first, no
 * "if you were happy", nothing offered in return. `photo` (optional) puts the
 * customer's own before/after above the ask; without it the email is exactly
 * the one sent since 2026-10-15.
 */
function emailContent(lead, reviewUrl, photo) {
  const first = firstNameOf(lead);
  const hi = first ? 'Hi ' + first + ',' : 'Hi,';
  const subject = 'Would you leave No Big Deal a quick Google review?';
  const pb = photoBlock(photo);
  const text = hi + '\n\n'
    + pb.text
    + 'Thank you for trusting No Big Deal Home Solutions with your project. '
    + 'Would you take a minute to leave us a Google review? Honest feedback, whatever it is, helps your neighbors pick a contractor.\n\n'
    + reviewUrl + '\n\n'
    + 'If anything about the job is not right, reply to this email or call me at (859) 420-7382 and I will take care of it.\n\n'
    + 'Thank you,\nJoe Deal\nNo Big Deal Home Solutions';
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;line-height:1.6;">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:28px 24px;">'
    + '<p>' + esc(hi) + '</p>'
    + pb.html
    + '<p>Thank you for trusting No Big Deal Home Solutions with your project. Would you take a minute to leave us a Google review? '
    + 'Honest feedback, whatever it is, helps your neighbors pick a contractor.</p>'
    + '<p style="text-align:center;margin:22px 0;"><a href="' + esc(reviewUrl) + '" style="display:inline-block;padding:12px 24px;background:#BD5728;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">Leave a Google review</a></p>'
    + '<p style="font-size:13px;color:#6b7280;">Or paste this link: ' + esc(reviewUrl) + '</p>'
    + '<p>If anything about the job is not right, reply to this email or call me at (859) 420-7382 and I will take care of it.</p>'
    + '<p>Thank you,<br>Joe Deal<br>No Big Deal Home Solutions</p>'
    + '</div></body></html>';
  return { subject, html, text };
}

/** The text (DARK). Carries the opt-out: it goes from the A2P number. */
function textBody(lead, reviewUrl) {
  const first = firstNameOf(lead);
  return 'Hi' + (first ? ' ' + first : '') + ", it's Joe with No Big Deal Home Solutions. Thank you for choosing us. "
    + 'Would you leave us a Google review? ' + reviewUrl + ' Reply STOP to opt out.';
}

module.exports = {
  EMAIL_FLAG, TEXT_FLAG, MIN_DAYS, MAX_DAYS, NBD_OWNER_UID, NBD_REVIEW_URL, SOURCE, TEXT_SOURCE,
  receivedMs, inWindow, baseEligibility, planEmail, planText, willHandle, reviewUrlFor,
  emailContent, textBody, jobKey, attempted, isNbd, validEmail,
};
