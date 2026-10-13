/**
 * customer-consent-declined-banner.js — C-7 (2026-10-13)
 *
 * A customer whose form left the texting box UNCHECKED carries
 * `tcpaConsent === false` on the lead. The server now refuses a text to that
 * number unless they texted first (functions/sms-consent-declined.js: a
 * 7-day reply window; campaign texts never). Before this, a rep found out by
 * trying to send and getting a refusal toast.
 *
 * This banner says it up front, on the customer page, in plain words, and
 * hands the rep the two things that still work: call, or email. Nothing here
 * sends anything, and no control on this page sends a text on its own.
 *
 * Activates only on /pro/customer.html. Re-evaluates on 'nbd:data-refreshed'
 * (the background revalidate swaps window._currentLead).
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : {};
  const loaded = root.__NBD_LOADED = root.__NBD_LOADED || {};
  if (loaded['customer-consent-declined-banner']) return;
  loaded['customer-consent-declined-banner'] = true;

  // Keep in step with DECLINED_REPLY_WINDOW_DAYS in functions/sms-consent-declined.js
  // (tests/sms-consent-declined-2026-10-13.test.js asserts they match).
  const REPLY_WINDOW_DAYS = 7;
  const BANNER_ID = 'nbd-consent-declined-banner';

  function digits(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }

  function isDeclined(lead) {
    // Strictly the explicit decline. An absent field is "never asked", not "no".
    return !!lead && lead.tcpaConsent === false;
  }

  /** What to render for a lead — null when there is nothing to say. */
  function buildModel(lead) {
    if (!isDeclined(lead)) return null;
    const phone = digits(lead.phone);
    const email = typeof lead.email === 'string' ? lead.email.trim() : '';
    return {
      title: 'Consent declined — texting blocked unless they text first',
      detail: 'They left the texting box unchecked on their form. NBD rule: replies are allowed for '
        + REPLY_WINDOW_DAYS + ' days after they text you; review asks and other campaign texts stay blocked. '
        + 'This covers texts sent through the CRM and the phone check; a text typed in your own phone is not stopped.',
      callHref: phone.length >= 10 ? 'tel:' + phone : '',
      emailHref: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? 'mailto:' + email : '',
    };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  const STYLE_ID = 'nbd-consent-declined-banner-style';
  const CSS = ''
    + '#' + BANNER_ID + '{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 16px;'
    + 'background:rgba(239,68,68,0.10);border-bottom:1px solid rgba(239,68,68,0.45);'
    + 'color:var(--t,#e8eaf0);font-family:"Barlow",-apple-system,system-ui,sans-serif;font-size:13px;}'
    + '#' + BANNER_ID + ' .ncd-text{flex:1 1 220px;min-width:0;}'
    + '#' + BANNER_ID + ' .ncd-title{font-weight:700;margin-bottom:2px;}'
    + '#' + BANNER_ID + ' .ncd-detail{font-size:12px;color:var(--m,#9aa3b2);}'
    + '#' + BANNER_ID + ' .ncd-actions{display:flex;gap:8px;flex-wrap:wrap;}'
    + '#' + BANNER_ID + ' .ncd-btn{display:inline-flex;align-items:center;justify-content:center;'
    + 'min-height:44px;min-width:44px;padding:0 16px;border-radius:8px;font-weight:700;font-size:13px;'
    + 'text-decoration:none;color:var(--t,#e8eaf0);border:1px solid rgba(239,68,68,0.55);'
    + '-webkit-tap-highlight-color:transparent;}';

  function render(doc, lead) {
    const old = doc.getElementById(BANNER_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const m = buildModel(lead);
    if (!m) return null;
    if (!doc.getElementById(STYLE_ID)) {
      const st = doc.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      doc.head.appendChild(st);
    }
    const el = doc.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'status');
    el.innerHTML = '<span aria-hidden="true" style="font-size:18px;line-height:1;">🚫</span>'
      + '<div class="ncd-text"><div class="ncd-title">' + esc(m.title) + '</div>'
      + '<div class="ncd-detail">' + esc(m.detail) + '</div></div>'
      + '<div class="ncd-actions">'
      + (m.callHref ? '<a class="ncd-btn" data-ncd="call" href="' + esc(m.callHref) + '">Call instead</a>' : '')
      + (m.emailHref ? '<a class="ncd-btn" data-ncd="email" href="' + esc(m.emailHref) + '">Email instead</a>' : '')
      + '</div>';
    doc.body.insertBefore(el, doc.body.firstChild);
    return el;
  }

  const api = { REPLY_WINDOW_DAYS, buildModel, render, isDeclined };
  root.NBDConsentDeclinedBanner = api;

  const PATH = (root.location && root.location.pathname) || '';
  if (!/\/pro\/customer(?:\.html)?$/.test(PATH)) return;

  function refresh() {
    try { render(root.document, root._currentLead || null); } catch (_) { /* a banner never breaks the page */ }
  }

  function init() {
    // _currentLead is populated after the page's own load; revalidate swaps it.
    setTimeout(refresh, 1500);
    root.addEventListener('nbd:data-refreshed', function () { setTimeout(refresh, 60); });
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
