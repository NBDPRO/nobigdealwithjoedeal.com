/**
 * lead-brief.js — two one-tap buttons on the customer page (2026-10-04).
 *
 *   Brief me        → the leadBrief callable (functions/lead-brief.js): a
 *                     pre-visit summary from the calls, promises, estimates,
 *                     what is owed, photos and the next appointment. Claude
 *                     Haiku 4.5 runs SERVER-side only; no key in the browser.
 *                     The server caches it per lead for 4 hours.
 *   Ask for review  → the existing review email (ReviewEngine.sendReviewEmail
 *                     → NBDComms.sendEmail with leadId, so the server's
 *                     record binding passes). reviewRequestedAt is stamped
 *                     only when the platform actually sent it. A tap, never
 *                     automatic. When the paid-in-full gate is present
 *                     (ReviewEngine.paidInFullFor, #2132) it is respected.
 *
 * Wired through the page's data-action dispatcher (customer-tasks-ui.js):
 *   data-action="NBDLeadAI.briefMe"   data-pass-customer-id="true"
 *   data-action="NBDLeadAI.askReview" data-pass-customer-id="true"
 * No inline styles: classes live in css/lead-brief.css.
 */
(function () {
  'use strict';

  const PANEL_ID = 'leadBriefPanel';
  let _inflight = null;

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }

  function currentLead(leadId) {
    const list = Array.isArray(window._leads) ? window._leads : [];
    return list.find((l) => l && l.id === leadId) || window._currentLead || window._leadDoc || null;
  }

  async function callable(name, payload) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
    }
    const res = await window._httpsCallable(window._functions, name)(payload || {});
    return (res && res.data) || null;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function panel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = el('section', 'lead-brief');
    p.id = PANEL_ID;
    p.setAttribute('aria-live', 'polite');
    p.setAttribute('aria-label', 'Brief me');
    const anchor = document.querySelector('.quick-actions');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(p, anchor.nextSibling);
    else document.body.appendChild(p);
    return p;
  }

  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - Number(ms || 0)) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.round(m / 60) + ' h ago';
  }

  function render(leadId, state) {
    const p = panel();
    p.replaceChildren();
    p.hidden = false;
    const head = el('div', 'lead-brief__head');
    head.appendChild(el('h3', 'lead-brief__title', 'Brief me'));
    const actions = el('div', 'lead-brief__actions');
    if (state.brief) {
      const refresh = el('button', 'btn btn-ghost lead-brief__btn', 'Refresh');
      refresh.type = 'button';
      refresh.addEventListener('click', () => briefMe(leadId, { refresh: true }));
      actions.appendChild(refresh);
    }
    const close = el('button', 'btn btn-ghost lead-brief__btn', 'Close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the brief');
    close.addEventListener('click', () => { p.hidden = true; });
    actions.appendChild(close);
    head.appendChild(actions);
    p.appendChild(head);

    if (state.loading) {
      p.appendChild(el('p', 'lead-brief__muted', 'Reading the calls, promises and money on file…'));
      return;
    }
    if (state.error) {
      p.appendChild(el('p', 'lead-brief__error', state.error));
      return;
    }
    const b = state.brief;
    p.appendChild(el('p', 'lead-brief__one', b.oneLine));
    const ul = el('ul', 'lead-brief__list');
    (b.bullets || []).forEach((t) => ul.appendChild(el('li', null, t)));
    p.appendChild(ul);
    const meta = (b.source === 'ai' ? 'AI summary' : 'From the record') + ' · ' + ago(b.generatedAtMs) + (b.cached ? ' · saved' : '');
    p.appendChild(el('p', 'lead-brief__muted', meta));
  }

  async function briefMe(leadId, opts) {
    const id = leadId || window._customerId;
    if (!id) return;
    if (_inflight) return _inflight;
    render(id, { loading: true });
    _inflight = (async () => {
      try {
        const brief = await callable('leadBrief', { leadId: id, refresh: !!(opts && opts.refresh) });
        if (!brief || !brief.oneLine) throw new Error('empty');
        render(id, { brief });
        return brief;
      } catch (e) {
        const code = String((e && (e.code || e.message)) || '');
        render(id, { error: /permission/i.test(code) ? 'You can\'t brief on this customer.' : 'Could not build the brief — try again in a moment.' });
        return null;
      } finally {
        _inflight = null;
      }
    })();
    return _inflight;
  }

  /** The paid-in-full gate when the review engine has it (#2132); else allowed. */
  function reviewGate(lead) {
    const RE = window.ReviewEngine;
    if (RE && typeof RE.paidInFullFor === 'function') {
      return RE.paidInFullFor(lead) ? { ok: true } : { ok: false, why: 'Not paid in full yet — the review ask waits for the final payment.' };
    }
    return { ok: true };
  }

  async function askReview(leadId) {
    const id = leadId || window._customerId;
    const lead = currentLead(id);
    if (!lead) { toast('Customer not loaded yet — try again in a moment.', 'error'); return false; }
    if (!lead.email) { toast('No email address for this customer — add one first.', 'error'); return false; }
    // Paid in full is judged from the invoices — load them first (same as review-deck.js).
    if (window.NBDRevenue && typeof window.NBDRevenue.loadInvoices === 'function') {
      try { await window.NBDRevenue.loadInvoices(); } catch (_) { /* nothing counts as paid then */ }
    }
    const gate = reviewGate(lead);
    if (!gate.ok) { toast(gate.why, 'warning'); return false; }
    const RE = window.ReviewEngine;
    if (!RE || typeof RE.sendReviewEmail !== 'function') { toast('Review email is not available right now.', 'error'); return false; }
    const btn = document.getElementById('askReviewBtn');
    if (btn) btn.disabled = true;
    try {
      const sent = await RE.sendReviewEmail(id);
      if (sent && btn && lead.reviewRequested) btn.textContent = '⭐ Review asked';
      return !!sent;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.NBDLeadAI = { briefMe, askReview, _reviewGate: reviewGate };
})();
