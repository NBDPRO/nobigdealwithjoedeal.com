/**
 * referral-rewards-ui.js — rep-facing "Referral Rewards" view.
 * ═══════════════════════════════════════════════════════════════
 *
 * Lists the $100 code-referral bonuses that are OWED (a referred lead's
 * project reached a closed stage → the onReferralLeadWrite Cloud Function
 * stamped `referralRewardStatus:'owed'` on the lead) with a "Mark Paid" action,
 * plus a paid-history section that can be reversed.
 *
 * Source of truth is the LEAD doc's `referralRewardStatus` ('pending' → 'owed'
 * → 'paid'). The list reads straight from the already-loaded `window._leads`
 * and computes totals client-side, so there is NO query and NO composite index.
 * Mark Paid / Mark Unpaid just flip that status on the lead.
 *
 * CSP: no inline handlers. Row buttons dispatch through the generic `call`
 * delegate — `data-action="call" data-fn="markReferralPaid" data-arg="<leadId>"`
 * (both fns are allowlisted in dashboard-state.js `_NBD_CALL_ALLOWLIST`).
 * Rendered via the goTo('refrewards') view-init branch in dashboard-actions.js.
 */
(function () {
  'use strict';

  const BONUS_DEFAULT = 100; // $100 everywhere (Jo, 2026-09-27; was $200)
  const esc = (s) => (window.nbdEsc
    ? window.nbdEsc(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  function fmtMoney(n) { return '$' + (Number(n) || 0).toLocaleString(); }
  function amountOf(l) { return Number(l.referralRewardAmount) || BONUS_DEFAULT; }
  function leadName(l) {
    return (`${l.firstName || ''} ${l.lastName || ''}`).trim() || l.name || 'A customer';
  }
  // Timestamps may arrive as a Firestore Timestamp, a millis number (optimistic
  // local write), an ISO string, or null.
  function fmtDate(ts) {
    let ms = null;
    if (!ts) return '';
    if (typeof ts === 'number') ms = ts;
    else if (typeof ts === 'string') { const p = Date.parse(ts); ms = isNaN(p) ? null : p; }
    else if (typeof ts.toDate === 'function') { try { ms = ts.toDate().getTime(); } catch (_) {} }
    else if (typeof ts.seconds === 'number') ms = ts.seconds * 1000;
    if (ms == null) return '';
    try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { return ''; }
  }

  const STYLES = `<style>
    .rr-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:4px 0 18px;}
    .rr-stat{background:var(--s2,#1a1d23);border:1px solid var(--br,#2a2e37);border-radius:10px;padding:14px 16px;}
    .rr-stat-owed{border-left:3px solid var(--orange,#f97316);}
    .rr-stat-n{font-size:22px;font-weight:800;line-height:1.1;}
    .rr-stat-l{font-size:11px;color:var(--m);margin-top:4px;text-transform:uppercase;letter-spacing:.03em;}
    .rr-h{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--m);margin:18px 0 8px;}
    .rr-h-muted{opacity:.75;}
    .rr-card{display:flex;align-items:center;gap:14px;justify-content:space-between;background:var(--s2,#1a1d23);border:1px solid var(--br,#2a2e37);border-radius:10px;padding:12px 16px;margin-bottom:8px;}
    .rr-card.rr-paid{opacity:.7;}
    .rr-main{display:flex;align-items:center;gap:14px;min-width:0;}
    .rr-amt{font-size:20px;font-weight:800;color:var(--orange,#f97316);white-space:nowrap;}
    .rr-card.rr-paid .rr-amt{color:var(--green,#22c55e);}
    .rr-who{min-width:0;}
    .rr-to{font-size:14px;font-weight:600;}
    .rr-sub{font-size:12px;color:var(--m);margin-top:2px;overflow:hidden;text-overflow:ellipsis;}
    .rr-card .btn{flex:none;font-size:12px;padding:8px 14px;}
    .rr-empty{background:var(--s2,#1a1d23);border:1px dashed var(--br,#2a2e37);border-radius:10px;padding:22px 18px;color:var(--m);font-size:13px;line-height:1.5;text-align:center;}
  </style>`;

  function render() {
    const host = document.getElementById('refrewardsScroll')
      || document.querySelector('#view-refrewards .view-scroll');
    if (!host) return;

    const leads = Array.isArray(window._leads) ? window._leads : [];
    const owed = leads.filter((l) => l && l.referralRewardStatus === 'owed');
    const paid = leads.filter((l) => l && l.referralRewardStatus === 'paid');
    const pending = leads.filter((l) => l && l.referralRewardStatus === 'pending');
    const owedTotal = owed.reduce((s, l) => s + amountOf(l), 0);
    const paidTotal = paid.reduce((s, l) => s + amountOf(l), 0);

    const rowOwed = (l) => `
      <div class="rr-card">
        <div class="rr-main">
          <div class="rr-amt">${esc(fmtMoney(amountOf(l)))}</div>
          <div class="rr-who">
            <div class="rr-to">Pay ${esc(l.referredByName || 'your referrer')}</div>
            <div class="rr-sub">Referred ${esc(leadName(l))}${l.referralRewardOwedAt ? ' · closed ' + esc(fmtDate(l.referralRewardOwedAt)) : ''}</div>
          </div>
        </div>
        <button class="btn btn-orange" data-action="call" data-fn="markReferralPaid" data-arg="${esc(l.id)}">Mark Paid</button>
      </div>`;

    const rowPaid = (l) => `
      <div class="rr-card rr-paid">
        <div class="rr-main">
          <div class="rr-amt">${esc(fmtMoney(amountOf(l)))}</div>
          <div class="rr-who">
            <div class="rr-to">Paid ${esc(l.referredByName || 'referrer')}</div>
            <div class="rr-sub">Referred ${esc(leadName(l))}${l.referralRewardPaidAt ? ' · paid ' + esc(fmtDate(l.referralRewardPaidAt)) : ''}</div>
          </div>
        </div>
        <button class="btn btn-ghost" data-action="call" data-fn="markReferralUnpaid" data-arg="${esc(l.id)}">Mark Unpaid</button>
      </div>`;

    host.innerHTML = `${STYLES}
      <div class="page-hdr">
        <div>
          <div class="page-title">🎁 Referral Rewards</div>
          <div class="page-sub">A customer earns a $${BONUS_DEFAULT} bonus when someone they referred closes a project. Pay it here and mark it done.</div>
        </div>
      </div>
      <div class="rr-summary">
        <div class="rr-stat rr-stat-owed"><div class="rr-stat-n">${esc(fmtMoney(owedTotal))}</div><div class="rr-stat-l">Owed (${owed.length})</div></div>
        <div class="rr-stat"><div class="rr-stat-n">${esc(fmtMoney(paidTotal))}</div><div class="rr-stat-l">Paid (${paid.length})</div></div>
        <div class="rr-stat"><div class="rr-stat-n">${pending.length}</div><div class="rr-stat-l">Pending close</div></div>
      </div>
      ${owed.length
        ? `<h3 class="rr-h">Owed now</h3>${owed.map(rowOwed).join('')}`
        : `<div class="rr-empty">No referral bonuses owed right now.<br>When a referred customer's project reaches <strong>Closed</strong>, their $${BONUS_DEFAULT} bonus shows up here to pay.</div>`}
      ${paid.length ? `<h3 class="rr-h rr-h-muted">Paid</h3>${paid.map(rowPaid).join('')}` : ''}`;
  }

  // Best-effort: keep the referrer's referrals-doc ledger (rewardsOwedTotal /
  // rewardsPaid) in sync with the lead-status flip so a future per-referrer
  // "total owed" surface isn't left overstated. Guarded — no-op if the modular
  // increment() isn't exposed on window. The lead docs stay the UI's source of
  // truth (this only reconciles the secondary ledger the trigger accrues).
  async function reconcileLedger(lead, dOwed, dPaid) {
    try {
      if (!lead || !lead.referralDocId) return;
      if (!window.db || !window.updateDoc || !window.doc || !window.increment) return;
      const amt = amountOf(lead);
      await window.updateDoc(window.doc(window.db, 'referrals', lead.referralDocId), {
        rewardsOwedTotal: window.increment(dOwed * amt),
        rewardsPaid: window.increment(dPaid * amt),
      });
    } catch (e) { /* ledger drift is non-fatal; lead status is authoritative */ }
  }

  async function markReferralPaid(id) {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const lead = leads.find((l) => l && l.id === id);
    if (!lead || lead.referralRewardStatus !== 'owed') return;
    const amt = amountOf(lead);
    const to = lead.referredByName || 'the referrer';
    // Paying out is a real-money, outward action and the flip is only
    // reversible by hand, so the guard has to actually guard: native confirm()
    // is patched to always return true in PWA standalone mode
    // (standalone-compat.js), which would silently mark a bonus paid on a
    // mis-tap. nbdConfirm gives a real Promise<boolean> modal there and falls
    // back to native confirm on desktop (and to "yes" where confirm is absent,
    // as before).
    const _ask = window.nbdConfirm
      || ((m) => Promise.resolve(typeof window.confirm === 'function' ? window.confirm(m) : true));
    if (!(await _ask(`Mark the ${fmtMoney(amt)} referral bonus to ${to} as paid?`))) return;
    if (!window.db || !window.updateDoc || !window.doc) {
      if (window.showToast) window.showToast('Not connected — try again in a moment', 'error');
      return;
    }
    try {
      await window.updateDoc(window.doc(window.db, 'leads', id), {
        referralRewardStatus: 'paid',
        referralRewardPaidAt: window.serverTimestamp(),
        updatedAt: window.serverTimestamp(),
      });
      lead.referralRewardStatus = 'paid';           // optimistic local
      lead.referralRewardPaidAt = Date.now();
      await reconcileLedger(lead, -1, 1);           // owed → paid on the referrals doc
      if (window.showToast) window.showToast(`Marked ${fmtMoney(amt)} bonus paid to ${to}`, 'success');
      render();
    } catch (e) {
      console.error('[referral-rewards] mark paid failed', e);
      if (window.showToast) window.showToast('Could not mark paid — try again', 'error');
    }
  }

  async function markReferralUnpaid(id) {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const lead = leads.find((l) => l && l.id === id);
    if (!lead || lead.referralRewardStatus !== 'paid') return;
    if (!window.db || !window.updateDoc || !window.doc) {
      if (window.showToast) window.showToast('Not connected — try again in a moment', 'error');
      return;
    }
    try {
      await window.updateDoc(window.doc(window.db, 'leads', id), {
        referralRewardStatus: 'owed',
        referralRewardPaidAt: null,
        updatedAt: window.serverTimestamp(),
      });
      lead.referralRewardStatus = 'owed';           // optimistic local
      lead.referralRewardPaidAt = null;
      await reconcileLedger(lead, 1, -1);           // paid → owed on the referrals doc
      if (window.showToast) window.showToast('Moved back to owed', 'info');
      render();
    } catch (e) {
      console.error('[referral-rewards] mark unpaid failed', e);
      if (window.showToast) window.showToast('Could not update — try again', 'error');
    }
  }

  // A referred project closing flips its lead to 'owed' server-side; surface
  // freshly-owed bonuses without a manual reload by re-rendering on the app-wide
  // data refresh — but only while the Referral Rewards view is actually showing.
  window.addEventListener('nbd:data-refreshed', function () {
    const v = document.getElementById('view-refrewards');
    if (v && v.classList.contains('active')) render();
  });

  window.ReferralRewards = { render };
  window.markReferralPaid = markReferralPaid;
  window.markReferralUnpaid = markReferralUnpaid;
})();
