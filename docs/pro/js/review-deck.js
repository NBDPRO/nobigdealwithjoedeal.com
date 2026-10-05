/**
 * review-deck.js — ask for Google reviews one at a time (Jo, 2026-10-02:
 * "make things addressable one thing at a time").
 *
 * The jobs PAID IN FULL in the last 60 days that haven't been asked, newest
 * first, as a triage deck (triage-deck.js). Paid in full is the shared rule
 * (ReviewEngine.paidInFullFor — review-engine.js nbd:paid-in-full-rule, Jo
 * 2026-10-03): a won stage at or after Final Payment and no invoice owing.
 * Until then any won stage counted, so Install Done jobs were asked before
 * they paid.
 *   right = Text the ask    (ReviewEngine.sendReviewSMS — the platform sender,
 *                            which checks the STOP list; marks reviewRequested)
 *   left  = Later
 *   ⋯     = Email the ask · Already asked (marks it, no message) ·
 *           Don't ask this one (reviewAskDeclined) · Open customer
 * Nothing is sent without a tap. Own leads only, as review-engine.js does
 * (the reviewRequested write is owner-only at the rules layer).
 *
 * Entry: Home's attention strip "⭐ N review asks waiting" (home-attention.js
 * renders it from candidates()), and the command palette.
 */
(function () {
  'use strict';
  if (window.NBDReviewDeck) return;

  const DAY = 86400000;
  const WINDOW = 60 * DAY;
  const toMs = (v) => (v && v.toDate ? v.toDate().getTime() : v && v.seconds ? v.seconds * 1000 : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : 0);
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Paid in full + when, from ReviewEngine (one rule with the bell and the
  // server). invoices undefined → the shared NBDRevenue cache; not loaded yet
  // (null) → nothing is paid in full (never ask on a guess).
  const RE = () => window.ReviewEngine || null;
  const paid = (l, invoices) => { const r = RE(); return !!(r && typeof r.paidInFullFor === 'function' && r.paidInFullFor(l, invoices)); };
  const paidAt = (l, invoices) => { const r = RE(); return r && typeof r.paidSinceMs === 'function' ? r.paidSinceMs(l, invoices) : toMs(l.stageStartedAt || l.updatedAt); };

  /** Paid in full in the last 60 days, own lead, not asked, not declined (pure over leads + invoices). */
  function candidates(leads, uid, now, invoices) {
    const t = now == null ? Date.now() : now;
    const me = uid === undefined ? (window._user && window._user.uid) : uid;
    return (leads || []).filter((l) => l && !l.deleted && !l.isProspect && (!l.userId || l.userId === me)
      && !l.reviewRequested && !l.reviewAskDeclined
      && paid(l, invoices) && paidAt(l, invoices) > t - WINDOW)
      .sort((a, b) => paidAt(b, invoices) - paidAt(a, invoices));
  }

  function card(l) {
    const name = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || 'Customer';
    const days = Math.max(0, Math.round((Date.now() - paidAt(l)) / DAY));
    const town = String(l.address || '').split(',').slice(1, 2).join('').trim();
    const what = l.jobType ? (window.JOB_TYPE_META && window.JOB_TYPE_META[l.jobType] && window.JOB_TYPE_META[l.jobType].label) || l.jobType : '';
    return '<div class="deck-name">' + esc(name) + '</div>' +
      '<div><span class="deck-tag">Paid in full ' + (days === 0 ? 'today' : days + (days === 1 ? ' day' : ' days') + ' ago') + '</span></div>' +
      '<div class="deck-sub">' + esc([what, town].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="deck-sub">' + (l.phone ? '📱 ' + esc(l.phone) : 'No phone on file') + (l.email ? ' · ✉ ' + esc(l.email) : '') + '</div>' +
      '<div class="deck-why">The ask: a thank-you and your Google review link, asking them to mention their town and the job — plus their own referral link, in the same message.</div>' +
      '<a class="deck-link" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '" target="_blank" rel="noopener">Open customer ↗</a>';
  }

  async function sentOrThrow(p) { if (!(await p)) throw new Error('Not sent — see the message above.'); }

  async function open() {
    if (!window.NBDTriageDeck || !window.ReviewEngine) return;
    // Paid in full is judged from the invoices — load them first.
    if (window.NBDRevenue && typeof window.NBDRevenue.loadInvoices === 'function') {
      try { await window.NBDRevenue.loadInvoices(); } catch (_) { /* nothing counts as paid then */ }
    }
    const RE = window.ReviewEngine;
    const items = candidates(window._leads).map((l) => ({ id: l.id, lead: l }));
    window.NBDTriageDeck.open({
      id: 'review-asks',
      title: 'Review asks',
      items,
      card: (it) => card(it.lead),
      right: (it) => (it.lead.phone ? { label: 'Text the ask', act: () => sentOrThrow(RE.sendReviewSMS(it.lead.id)) } : null),
      left: { label: 'Later' },
      more: (it) => [].concat(
        it.lead.email ? [{ label: 'Email the ask', act: () => sentOrThrow(RE.sendReviewEmail(it.lead.id)) }] : [],
        [
          { label: 'Already asked', act: async () => { await RE.markAsked(it.lead.id, 'manual'); it.lead.reviewRequested = true; } },
          { label: "Don't ask this one", act: async () => {
            await window.updateDoc(window.doc(window.db, 'leads', it.lead.id), { reviewAskDeclined: true, updatedAt: window.serverTimestamp() });
            it.lead.reviewAskDeclined = true;
          } },
          { label: 'Open customer ↗', href: '/pro/customer.html?id=' + encodeURIComponent(it.lead.id) },
        ]
      ),
      doneText: 'Every job paid in full lately has been asked. Nice.',
      onClose: () => { if (window.NBDHomeAttention && typeof window.NBDHomeAttention.render === 'function') window.NBDHomeAttention.render(true); },
    });
  }

  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-review-deck]') : null;
    if (b) { e.preventDefault(); open(); }
  });
  // Command palette entry, once it exists.
  let tries = 0;
  (function reg() {
    if (window.NBDCommand && typeof window.NBDCommand.registerAction === 'function') {
      window.NBDCommand.registerAction({ id: 'review-asks', label: 'Ask for reviews, one at a time', icon: '⭐', run: open, keywords: ['review', 'google', 'ask', 'stars'], group: 'Tools' });
    } else if (++tries < 40) setTimeout(reg, 500);
  })();

  window.NBDReviewDeck = { open, candidates };
})();
