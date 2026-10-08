/**
 * NBD Pro — Google Review Request Engine
 * Auto-nudges the rep when a job is PAID IN FULL (Jo, 2026-10-03 — a won
 * stage at or after Final Payment and no invoice still owing; the shared
 * nbd:paid-in-full-rule below, byte-identical with functions/paid-in-full.js).
 * Until then the nudge fired at ANY won stage, Install Done included — before
 * the money — and 0 of 36 won/paid jobs in prod were ever asked. Bell
 * notification → one-tap prefilled SMS/email carrying the tenant's brand +
 * review link + the homeowner's own referral link (one message, not two). Rep-in-the-loop by
 * design (same TCPA/CAN-SPAM posture as anniversary-touch: we prep the
 * message, a human sends it).
 *
 * Review link resolution: users/{uid}.googleReviewUrl (Settings) →
 * tenant brand.integrations.reviewUrl → legacy localStorage → maps search.
 *
 * Also includes Referral Tracking Engine — unique codes, tracking, rewards.
 *
 * Exposes: window.ReviewEngine
 */

(function() {
  'use strict';

  // NBD literals survive ONLY as the last-ditch fallback for a boot path
  // where company-profile.js hasn't loaded. Copy surfaces resolve through
  // window._brand() (TenantContext, company-profile.js Phase B directive) so
  // a tenant's review ask carries THEIR name/phone/sign-off, never Joe's.
  const BRAND = {
    name: 'No Big Deal Home Solutions',
    phone: '(859) 420-7382',
    website: 'nobigdealwithjoedeal.com',
    navy: '#1A3057',
    orange: '#BD5728'
  };
  function _b() {
    try { if (typeof window._brand === 'function') return window._brand() || {}; } catch (e) { /* fall through */ }
    return {};
  }
  // `|| NBD-literal` is the bug pattern here. _resolveBrand() blanks an unset
  // tenant field to '', so a `||` fallback re-injects the platform owner's
  // identity exactly where a contractor left something empty — his customer got
  // a review request signed "Joe & the NBD team" with Joe's cell number. And
  // smsSignOff has no Settings field at all, so the contractor could not fix it.
  //
  // Gate on isNbd instead: NBD keeps its literals byte-identical, a tenant gets
  // theirs, and a tenant with nothing set gets blank rather than Joe's.
  function _isNbdBrand()  { const b = _b(); return !b.legalName || b.legalName === 'No Big Deal Home Solutions'; }
  function brandName()    { const b = _b(); return b.legalName || b.displayName || (_isNbdBrand() ? BRAND.name : ''); }
  function brandPhone()   { const b = _b(); return (b.contact && b.contact.phone) || (_isNbdBrand() ? BRAND.phone : ''); }
  function brandSignOff() {
    const b = _b();
    if (b.smsSignOff) return b.smsSignOff;
    if (_isNbdBrand()) return 'Joe & the NBD team';
    return b.legalName || b.displayName || '';
  }

  // ═══════════════════════════════════════════════════════════════
  // PAID IN FULL — when a review ask is due (2026-10-03)
  // ═══════════════════════════════════════════════════════════════
  // nbd:paid-in-full-rule:start — ONE "paid in full" rule, kept byte-identical
  // in functions/paid-in-full.js and docs/pro/js/review-engine.js
  // (tests/review-paid-in-full-2026-10-03.test.js). A WON stage at or after
  // Final Payment (a custom won stage counts; Install Done, Final Photos,
  // Deductible and Collections never do), and no invoice still owes money
  // under the owed rule (owedDollarsOf — passed in, so both copies use their
  // own side's owed rule). invoices null/undefined = not known yet = NOT paid.
  var PIF_WON = { closed: 1, final_payment: 1, warranty_claim: 1, install_complete: 1, final_photos: 1, deductible_collected: 1, collections: 1 };
  var PIF_PRE_FINAL = { install_complete: 1, final_photos: 1, deductible_collected: 1, collections: 1 };
  var PIF_ALIAS = { complete: 'closed', 'closed won': 'closed', closed_won: 'closed', 'closed-won': 'closed', won: 'closed' };
  var PIF_ROLES = { 'new': 1, active: 1, job: 1, won: 1, lost: 1 };
  function pifStageKey(lead) {
    var raw = String((lead && (lead._stageKey || lead.stage)) || '').trim().toLowerCase();
    return PIF_ALIAS[raw] || raw.replace(/\s+/g, '_');
  }
  function isPaidStage(lead) {
    if (!lead) return false;
    var key = pifStageKey(lead);
    if (PIF_PRE_FINAL[key]) return false;
    var role = (typeof lead.stageRole === 'string' && PIF_ROLES[lead.stageRole]) ? lead.stageRole : (PIF_WON[key] ? 'won' : '');
    return role === 'won';
  }
  function isPaidInFull(lead, invoices, owedDollarsOf) {
    if (!lead || lead.deleted === true || !isPaidStage(lead)) return false;
    if (!Array.isArray(invoices) || typeof owedDollarsOf !== 'function') return false;
    for (var i = 0; i < invoices.length; i++) {
      if (owedDollarsOf(invoices[i]) > 0) return false;
    }
    return true;
  }
  // nbd:paid-in-full-rule:end

  // The owed rule is collected-revenue.js's (window.NBDRevenue — the same
  // nbd:owed-rule block functions/invoice-owed.js copies). Without it the
  // invoices can't be judged, so nothing counts as paid (no ask on a guess).
  function _owedFn() {
    const R = window.NBDRevenue;
    return (R && typeof R.owedDollarsOf === 'function') ? R.owedDollarsOf : null;
  }
  /** The lead's invoices from the shared cache, or null when not loaded yet. */
  function invoicesForLead(lead, invoices) {
    const all = invoices !== undefined ? invoices
      : ((window.NBDRevenue && typeof window.NBDRevenue.cached === 'function') ? window.NBDRevenue.cached() : null);
    if (!Array.isArray(all) || !lead) return null;
    const jobId = typeof lead.activeJobId === 'string' ? lead.activeJobId : '';
    return all.filter((inv) => inv && inv.leadId === lead.id && inv.deleted !== true && !(jobId && inv.jobId && inv.jobId !== jobId));
  }
  /** Paid in full, judged from the shared invoice cache (null cache → false). */
  function paidInFullFor(lead, invoices) {
    return isPaidInFull(lead, invoicesForLead(lead, invoices), _owedFn());
  }
  const _toMs = (v) => v?.toDate ? v.toDate().getTime() : (v?.seconds ? v.seconds * 1000 : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : (typeof v === 'string' ? (Date.parse(v) || 0) : 0))));
  /** When it became paid in full: the later of entering the paid stage and the last payment. */
  function paidSinceMs(lead, invoices) {
    let m = _toMs(lead && (lead.stageStartedAt || lead.updatedAt));
    for (const inv of (invoicesForLead(lead, invoices) || [])) {
      if (String(inv.status || '').toLowerCase() === 'paid') m = Math.max(m, _toMs(inv.paidAt));
    }
    return m;
  }

  // ═══════════════════════════════════════════════════════════════
  // GOOGLE REVIEW REQUEST
  // ═══════════════════════════════════════════════════════════════

  // The tenant-integrations default is NBD's /r redirect via deep-merge —
  // it must never leak into another tenant's review ask.
  const NBD_DEFAULT_REVIEW_URL = 'https://nobigdealwithjoedeal.com/r';

  /**
   * Resolve the Google review link, once per page load.
   * Priority: users/{uid}.googleReviewUrl (the Settings field the homeowner
   * portal's 4-5★ nudge reads) → tenant brand.integrations.reviewUrl (only
   * when it isn't the deep-merged NBD default on a non-NBD tenant) → legacy
   * localStorage keys → a maps search for the tenant's own name. The old
   * localStorage-first read predated the Settings field, so a link saved in
   * Settings was ignored here — and the empty-placeid fallback produced a
   * broken writereview URL.
   */
  let _reviewLinkPromise = null;
  function getReviewLink() {
    if (_reviewLinkPromise) return _reviewLinkPromise;
    _reviewLinkPromise = (async () => {
      try {
        if (window.db && window._user && typeof window.getDoc === 'function' && typeof window.doc === 'function') {
          const snap = await window.getDoc(window.doc(window.db, 'users', window._user.uid));
          const d = (snap && typeof snap.exists === 'function' && snap.exists()) ? (snap.data() || {}) : {};
          if (/^https?:\/\//i.test(d.googleReviewUrl || '')) return d.googleReviewUrl;
        }
      } catch (e) { /* offline / rules — fall through to static sources */ }
      const b = _b();
      const integ = (b.integrations && b.integrations.reviewUrl) || '';
      if (integ && (integ !== NBD_DEFAULT_REVIEW_URL || (b.seal || '') === 'NBD')) return integ;
      const legacy = localStorage.getItem('nbd_google_review_link');
      if (legacy) return legacy;
      const placeId = localStorage.getItem('nbd_google_place_id');
      if (placeId) return `https://search.google.com/local/writereview?placeid=${placeId}`;
      return `https://www.google.com/maps/search/${encodeURIComponent(brandName())}`;
    })();
    return _reviewLinkPromise;
  }

  /**
   * The homeowner's own referral link, for the review message (2026-10-03:
   * one message, not a second tap). The code comes from the existing
   * generator (assignReferralCode — idempotent, reuses a minted code); the
   * link is the public refer page the portal's "Refer a friend" card uses,
   * keyed by the customer id, carrying the code so the friend's lead is
   * attributed to this homeowner. NO reward is named next to a review ask —
   * Google's policy forbids review incentives (and KY: nothing tied to a
   * claim). If the code can't be minted, the link still works without it.
   */
  async function referralLinkFor(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return '';
    let code = lead.referralCode || null;
    if (!code) { try { code = await assignReferralCode(leadId, { quiet: true }); } catch (e) { code = null; } }
    const ref = lead.customerId || lead.id;
    const co = _isNbdBrand() ? '' : brandName();
    return 'https://nobigdealwithjoedeal.com/pro/refer.html?ref=' + encodeURIComponent(ref)
      + (code ? '&code=' + encodeURIComponent(code) : '')
      + (co ? '&co=' + encodeURIComponent(co) : '');
  }
  // The referral paragraph both review messages carry (tenant-neutral wording).
  function referralLine(link) {
    return link ? `\n\nAnd if a friend or neighbor ever needs work done, here's your own link to send them our way: ${link}` : '';
  }

  /**
   * Send a review request SMS to a customer
   * @param {string} leadId
   */
  async function sendReviewRequestSMS(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead || !lead.phone) {
      if (typeof showToast === 'function') showToast('No phone number for this lead', 'error');
      return;
    }

    const reviewLink = await getReviewLink();
    const referLink = await referralLinkFor(leadId);
    const firstName = lead.firstName || lead.fname || '';
    const phone = lead.phone.replace(/\D/g, '');

    const message =
      `Hi${firstName ? ' ' + firstName : ''}, thank you so much for trusting ${brandName()} with your project! We'd love to hear how we did. If you have 30 seconds, a Google review means the world to us: ${reviewLink}\n\nIf you mention your town and what we did (like 'roof replacement in Mason'), it helps your neighbors find us.${referralLine(referLink)}\n\nThank you! — ${brandSignOff()}`;

    // Through the platform sender, not a raw sms: link (2026-10-01). The raw
    // link opened the phone's Messages app and skipped the server's STOP
    // register, so a homeowner who had opted out could still get a review
    // ask. NBDComms.sendSMS checks the opt-out list server-side first (403
    // opted_out) and only then may hand off to the device on a quota error.
    if (!window.NBDComms || typeof window.NBDComms.sendSMS !== 'function') {
      if (typeof showToast === 'function') showToast('Texting is not available right now — try again in a moment.', 'error');
      return;
    }
    const res = await window.NBDComms.sendSMS({ to: phone, message, leadId, source: 'review_request', sourceRef: leadId });
    if (!res || res.success === false) return false;   // refused (e.g. opted out): NBDComms showed why
    await logReviewRequest(leadId, 'sms');
    if (typeof showToast === 'function') showToast(res.mode === 'queued' ? 'Offline — the review request is queued.' : 'Review request sent', 'ok');
    return true;
  }

  /**
   * Send a review request email
   */
  async function sendReviewRequestEmail(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return;

    const reviewLink = await getReviewLink();
    const referLink = await referralLinkFor(leadId);
    const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();

    const subject = `How did we do? — ${brandName()}`;
    const text =
      `Hi ${name || 'there'},\n\nThank you for choosing ${brandName()} for your project! We truly enjoyed working with you.\n\nIf you have a moment, we'd be incredibly grateful for a Google review. It helps other homeowners find trustworthy contractors:\n\n${reviewLink}\n\nIf you mention your town and what we did (like 'roof replacement in Mason'), it helps your neighbors find us.${referralLine(referLink)}\n\nIf there's anything we could have done better, please let us know directly — we're always improving.\n\nThank you!\n${brandSignOff()}\n${brandPhone()}`;

    if (!lead.email) {
      if (typeof showToast === 'function') showToast('No email address for this lead', 'error');
      return;
    }
    // Through the platform sender (2026-10-01): a review ask is commercial
    // mail, so the server checks the unsubscribe register and adds the footer.
    // The old raw mailto: skipped both. kind 'review_request' is not on the
    // transactional allowlist, on purpose.
    if (!window.NBDComms || typeof window.NBDComms.sendEmail !== 'function') {
      if (typeof showToast === 'function') showToast('Email is not available right now — try again in a moment.', 'error');
      return;
    }
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    const res = await window.NBDComms.sendEmail({ to: lead.email, subject, html, leadId, kind: 'review_request' });
    if (!res || res.success === false) return false;   // refused (e.g. unsubscribed): NBDComms showed why
    // Stamp reviewRequestedAt only when the platform actually SENT it
    // (2026-10-04). A mailto: handoff just opened the mail app — nothing was
    // sent yet, so the lead must not read "asked".
    if (res.mode === 'platform') await logReviewRequest(leadId, 'email');
    if (typeof showToast === 'function') showToast(res.mode === 'mailto' ? 'Opened in your mail app' : 'Review request emailed', 'ok');
    return true;
  }

  /**
   * Log review request to Firestore for tracking
   */
  async function logReviewRequest(leadId, method) {
    if (!window.db || !window._user) return;
    try {
      await window.addDoc(window.collection(window.db, 'review_requests'), {
        leadId,
        userId: window._user.uid,
        method,
        sentAt: window.serverTimestamp(),
        status: 'sent'
      });
      // Update lead record
      await window.updateDoc(window.doc(window.db, 'leads', leadId), {
        reviewRequested: true,
        reviewRequestedAt: window.serverTimestamp()
      });
      // Keep the in-memory lead in step, so "asked" counts drop now, not on reload.
      const local = (window._leads || []).find(l => l.id === leadId);
      if (local) local.reviewRequested = true;
    } catch(e) { console.warn('Review request log failed:', e.message); }
  }

  /**
   * Auto-check for leads that should get review requests
   * Called after leads load — finds jobs that recently became PAID IN FULL
   * without a review request (2026-10-03; was: any won stage).
   */
  let _autoWaitedForInvoices = false;
  function checkAutoReviewRequests() {
    // Paid in full needs the invoices: load them once, then run. Without the
    // revenue module nothing can be judged paid, so nothing fires.
    const R = window.NBDRevenue;
    if (!R || typeof R.cached !== 'function') return;
    if (!R.cached()) {
      if (_autoWaitedForInvoices || typeof R.loadInvoices !== 'function') return;
      _autoWaitedForInvoices = true;
      R.loadInvoices().then(() => { if (R.cached()) checkAutoReviewRequests(); }).catch(() => {});
      return;
    }
    // OWN leads only (team visibility, 2026-07): staff caches now hold the
    // whole tenant book, but review requests act on the lead (updateDoc
    // reviewRequested) which is owner-only at the rules layer — running
    // this over teammates' leads created un-actionable notifications and a
    // denied-write re-fire loop.
    const _me = window._user && window._user.uid;
    const leads = (window._leads || []).filter(l => !l.userId || l.userId === _me);
    // PAID IN FULL (2026-10-03), the shared rule: a won stage at or after
    // Final Payment (custom won stages count; Install Done, Final Photos,
    // Deductible and Collections never do) and no invoice still owing. The
    // old gate was any won stage — the ask landed before the money.
    const recently = Date.now() - (7 * 24 * 60 * 60 * 1000); // Last 7 days

    const candidates = leads.filter(l => {
      if (l.deleted || l.reviewRequested || l.reviewAskDeclined) return false;
      if (!paidInFullFor(l)) return false;
      // Recency keys off BECOMING paid in full: the later of entering the
      // paid stage (stageStartedAt, stamped by moveCard — the old updatedAt
      // check reset on ANY edit) and the last invoice payment.
      return paidSinceMs(l) > recently;
    });

    if (candidates.length > 0) {
      // Create notifications for review requests
      candidates.forEach(lead => {
        const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || 'Customer';
        createReviewNotification(lead.id, name);
      });
    }
  }

  async function createReviewNotification(leadId, customerName) {
    if (!window.db || !window._user) return;
    // Review requests fall under the "Estimate Approvals" trigger
    // semantically (post-close customer outreach). Suppress if the
    // user disabled that trigger or set mode=critical (these are
    // normal-priority — useful but not urgent).
    if (typeof window.shouldFireNotif === 'function' &&
        !window.shouldFireNotif('estimate_approved', null, 'normal')) {
      return;
    }
    try {
      // Check if we already created one
      const existing = (window._notifications || []).find(n =>
        n.leadId === leadId && n.type === 'review_request'
      );
      if (existing) return;

      await window.addDoc(window.collection(window.db, 'notifications'), {
        userId: window._user.uid,
        leadId,
        type: 'review_request',
        title: '⭐ Request a Review',
        message: `${customerName}'s project is paid in full — send a review request?`,
        read: false,
        dismissed: false,
        createdAt: window.serverTimestamp()
      });
    } catch(e) { console.warn('Review notification failed:', e.message); }
  }

  // ═══════════════════════════════════════════════════════════════
  // REFERRAL TRACKING ENGINE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate a unique referral code for a customer
   */
  function generateReferralCode(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return null;

    // Sanitize the name prefix to A-Z0-9 so the code never carries a space or
    // punctuation (e.g. 'Jo Ann' or a '(Web lead)' default) that would break the
    // exact-match redemption lookup and silently lose the bonus. Pad the random
    // suffix to a full 4 chars (toString(36) can drop trailing zeros → 'JOHN-').
    // NBD-leak gate (2026-07-29): a nameless lead (Quick Add creates
    // firstName:'' by design, and non-Latin names sanitize to '') used to get
    // an NBD-prefixed code on a TENANT's surface. The redemption lookup needs a
    // non-empty prefix (exact match, no format regex server-side), so mirror
    // the 'CUS'-floor idea with a neutral 'REF' floor rather than ''.
    const _fbPrefix = _isNbdBrand() ? 'NBD' : 'REF';
    const prefix = (lead.firstName || lead.fname || _fbPrefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || _fbPrefix;
    const suffix = (Math.random().toString(36).substring(2, 6) + '0000').slice(0, 4).toUpperCase();
    return prefix + '-' + suffix;
  }

  /**
   * Create and assign a referral code to a lead
   */
  async function assignReferralCode(leadId, opts) {
    if (!window.db || !window._user) return null;
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return null;

    try {
      // Idempotent: if this referrer already has a code (locally or already
      // minted in the referrals collection), reuse it. A double-tap must not
      // mint a second doc and text the customer a different code. (Both queries
      // are userId-scoped so they satisfy the owner-only referrals read rule.)
      if (lead.referralCode) return lead.referralCode;
      const existing = await window.getDocs(window.query(
        window.collection(window.db, 'referrals'),
        window.where('referrerLeadId', '==', leadId),
        window.where('userId', '==', window._user.uid)
      ));
      if (!existing.empty) {
        const priorCode = existing.docs[0].data().code;
        lead.referralCode = priorCode;
        return priorCode;
      }

      // Mint a code, regenerating on the (rare) same-tenant collision so the
      // redemption lookup resolves to exactly one referrer.
      let code = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateReferralCode(leadId);
        if (!candidate) return null;
        const clash = await window.getDocs(window.query(
          window.collection(window.db, 'referrals'),
          window.where('code', '==', candidate),
          window.where('userId', '==', window._user.uid)
        ));
        if (clash.empty) { code = candidate; break; }
      }
      if (!code) {
        if (typeof showToast === 'function') showToast('Could not generate a unique code — try again', 'error');
        return null;
      }

      // Save code to lead
      await window.updateDoc(window.doc(window.db, 'leads', leadId), {
        referralCode: code,
        referralCodeCreatedAt: window.serverTimestamp()
      });

      // Save to referrals collection for lookup
      await window.addDoc(window.collection(window.db, 'referrals'), {
        code,
        referrerLeadId: leadId,
        userId: window._user.uid,
        // Tenant key so the server trigger scopes redemption by company: a code
        // minted by any teammate credits when the referred lead closes on any
        // teammate's / the owner's book. Falls back to uid for a solo tenant.
        // The rules pin it to the writer's companyId CLAIM (R3-5), so the
        // claim wins over a legacy lead's own field.
        companyId: (window._userClaims && window._userClaims.companyId) || lead.companyId || window._user.uid,
        createdAt: window.serverTimestamp(),
        referredLeads: [],
        rewardsPaid: 0,
        status: 'active'
      });

      lead.referralCode = code;
      if (!(opts && opts.quiet) && typeof showToast === 'function') showToast(`Referral code: ${code}`, 'ok');
      return code;
    } catch(e) {
      console.error('Referral code creation failed:', e);
      return null;
    }
  }

  /**
   * Send referral code to customer via SMS
   */
  async function sendReferralSMS(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead || !lead.phone) return;

    let code = lead.referralCode;
    if (!code) code = await assignReferralCode(leadId);
    if (!code) return;

    const firstName = lead.firstName || lead.fname || '';
    const phone = lead.phone.replace(/\D/g, '');
    const message =
      `Hey${firstName ? ' ' + firstName : ''}, thanks again for choosing ${brandName()}! Here's your personal referral code: ${code}\n\nShare it with friends & neighbors — they get a free inspection, and you get a $100 bonus when their project closes. Win-win!`;
    // Platform sender, same as the review ask above (2026-10-01): the raw sms:
    // link skipped the server's STOP register.
    if (!window.NBDComms || typeof window.NBDComms.sendSMS !== 'function') {
      if (typeof showToast === 'function') showToast('Texting is not available right now — try again in a moment.', 'error');
      return;
    }
    const res = await window.NBDComms.sendSMS({ to: phone, message, leadId, source: 'referral_code', sourceRef: leadId });
    if (res && res.success !== false && typeof showToast === 'function') showToast(res.mode === 'queued' ? 'Offline — the referral text is queued.' : 'Referral code sent', 'ok');
  }

  // Referral attribution + the $100-bonus crediting-on-close moved SERVER-SIDE
  // to functions/referral-rewards.js (onReferralLeadWrite). Intake now just
  // stamps `redeemReferralCode` on the lead (rep Add/Edit Lead modal or the
  // public /inspect form) and the trigger resolves the code to its referrer
  // and records the bonus as owed when the project closes. The old client-side
  // trackReferral() that lived here had ZERO callers and no crediting path, so
  // the $100 promised in sendReferralSMS was unbacked — removed to avoid a
  // second, drifting attribution lane.

  /**
   * Get referral stats for dashboard
   */
  async function getReferralStats() {
    if (!window.db || !window._user) return { total: 0, active: 0, revenue: 0 };
    try {
      const snap = await window.getDocs(window.query(
        window.collection(window.db, 'referrals'),
        window.where('userId', '==', window._user.uid)
      ));
      const refs = snap.docs.map(d => d.data());
      const totalReferred = refs.reduce((s, r) => s + (r.referredLeads?.length || 0), 0);
      return {
        totalCodes: refs.length,
        totalReferred,
        active: refs.filter(r => r.status === 'active').length
      };
    } catch(e) { return { totalCodes: 0, totalReferred: 0, active: 0 }; }
  }

  // Expose to window
  window.ReviewEngine = {
    sendReviewSMS: sendReviewRequestSMS,
    sendReviewEmail: sendReviewRequestEmail,
    // 'manual' = asked in person / by phone; the deck's "Already asked".
    markAsked: logReviewRequest,
    checkAutoReviews: checkAutoReviewRequests,
    // The paid-in-full gate (review deck, Home count) and the referral link.
    isPaidInFull: isPaidInFull,
    paidInFullFor: paidInFullFor,
    paidSinceMs: paidSinceMs,
    referralLinkFor: referralLinkFor,
    assignReferralCode,
    sendReferralSMS,
    getReferralStats
  };

})();
