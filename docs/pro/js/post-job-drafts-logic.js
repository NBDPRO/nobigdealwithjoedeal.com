/* ══════════════════════════════════════════════════════════════════════
   post-job-drafts-logic.js — review-ask and referral-ask DRAFTS (2026-10-23).
   PURE: no DOM, no clock, no network, no sends.

   Draft-only. Nothing here sends; the finished-job card (job-closeout.js)
   shows the text and the rep pastes it into the CRM composer, whose sender
   checks consent / STOP / unsubscribe and adds the footer.

   Rules baked in:
   - Moments: both asks wait for PAID IN FULL (the shared rule; the caller
     passes paidInFull). The review ask is offered until a review was asked.
     The referral ask is a SEPARATE message, offered once the customer has
     been asked for a review or the warranty certificate is filed.
   - FTC (16 CFR 465): the review ask goes to everyone — no rating first, no
     "if you were happy", nothing offered for it, and no referral in it. The
     referral ask never mentions a review.
   - Referral amount is the flat $100 the server credits (functions/
     referral-rewards.js REFERRAL_BONUS_USD; a test pins both). Kentucky
     KRS 367.628(2) allows nothing over $100 to an insured: the draft
     states the flat amount only, never ties it to a deductible, a claim or
     an insurer, and never changes it for an insurance job.
   - Channels: a text draft only with stored texting consent and no
     opt-out / do-not-contact flag; the text carries "Reply STOP to opt
     out." The rep is told to send 8am-9pm the customer's time.
   - Crews are independent subcontractors: no "our crew", "in-house", "W2".
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var REFERRAL_BONUS_USD = 100;
  var truthy = function (v) { return v === true || v === 'true' || v === 1 || v === '1'; };
  var str = function (v) { return v == null ? '' : String(v).trim(); };

  function firstName(lead) { return str(lead && (lead.firstName || lead.fname)).split(/\s+/)[0].slice(0, 30); }

  function optedOut(lead) {
    lead = lead || {};
    return truthy(lead.doNotContact) || truthy(lead.dnc) || truthy(lead.doNotText) || truthy(lead.smsOptOut) || truthy(lead.smsOptedOut);
  }
  function canText(lead) {
    lead = lead || {};
    var digits = str(lead.phone || lead.phoneDigits).replace(/\D/g, '');
    return digits.length >= 10 && !optedOut(lead) && str(lead.tcpaConsentText) !== '';
  }
  function canEmail(lead) {
    lead = lead || {};
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(lead.email)) && !truthy(lead.doNotContact) && !truthy(lead.dnc);
  }

  /** Which asks are on offer right now. ctx: { paidInFull: boolean } */
  function moments(lead, ctx) {
    lead = lead || {};
    var paid = !!(ctx && ctx.paidInFull === true);
    var reviewAsked = lead.reviewRequested === true || !!lead.reviewRequestedAt;
    var warrantyFiled = !!lead.warrantyCertFiledAt;
    // A job marked finished after the fact gets no ask (Jo's rule, postJob()).
    var quiet = lead.completedBackfill === true;
    return {
      review: paid && !reviewAsked && !quiet && !optedOut(lead),
      referral: paid && (reviewAsked || warrantyFiled) && !quiet && !optedOut(lead)
    };
  }

  function sign(co) { return co ? ' \u2014 ' + co : ''; }

  /**
   * kind: 'review' | 'referral'; opts: { company, link } (link = review URL or
   * the customer's own referral link). Returns null without a link.
   */
  function build(kind, lead, opts) {
    opts = opts || {};
    var link = str(opts.link);
    if (!link || (kind !== 'review' && kind !== 'referral')) return null;
    var co = str(opts.company).slice(0, 60);
    var first = firstName(lead);
    var hi = first ? 'Hi ' + first + ',' : 'Hi,';
    var usd = '$' + REFERRAL_BONUS_USD;
    var out = { kind: kind, email: null, text: null, notes: [] };
    if (kind === 'review') {
      var body = 'thank you for choosing ' + (co || 'us') + ' for your project. Would you take a minute to leave us a Google review? Honest feedback, whatever it is, helps your neighbors pick a contractor: ' + link;
      if (canEmail(lead)) out.email = { subject: 'Would you leave ' + (co || 'us') + ' a quick Google review?', body: hi + '\n\n' + body[0].toUpperCase() + body.slice(1) + '\n\nThank you,' + (co ? '\n' + co : '') };
      if (canText(lead)) out.text = hi + ' ' + body + sign(co) + ' Reply STOP to opt out.';
    } else {
      var ask = 'if a friend or neighbor ever needs roofing, siding or gutter work, you can send them our way with your own link: ' + link + ' When their job is completed and paid in full, we send you a ' + usd + ' thank-you.';
      if (canEmail(lead)) out.email = { subject: 'Know a neighbor who needs work done?', body: hi + '\n\n' + ask[0].toUpperCase() + ask.slice(1) + '\n\nThank you,' + (co ? '\n' + co : '') };
      if (canText(lead)) out.text = hi + ' ' + ask + sign(co) + ' Reply STOP to opt out.';
    }
    if (out.text) out.notes.push('Send texts between 8am and 9pm the customer\u2019s time.');
    if (!out.text && !out.email) out.notes.push('No usable channel: the customer has no email, no texting consent, or opted out. Ask in person instead.');
    out.notes.push('Paste it into the CRM message composer so opt-outs are honored and the footer is added. Nothing is sent from here.');
    return out;
  }

  var api = { REFERRAL_BONUS_USD: REFERRAL_BONUS_USD, moments: moments, build: build, canText: canText, canEmail: canEmail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PostJobDrafts = api;
})(typeof window !== 'undefined' ? window : null);
