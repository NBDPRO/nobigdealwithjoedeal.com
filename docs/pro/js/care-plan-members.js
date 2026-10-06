/**
 * care-plan-members.js — the Roof Care Plan members view (#/careplan), lazy
 * 'careplan' bundle (2026-10-05).
 *
 * Lists this company's careplans/{id} memberships (server-written only —
 * functions/care-plan.js; firestore.rules: tenant-readable, no client
 * writes): members first, then invited-not-paid, then ended. Each row links
 * the customer; a member's row hands Jo their Stripe billing / cancel link
 * (care-plan-crm.js dialog — Jo sends it himself, nothing is sent from here).
 * Only shown in the nav while CARE_PLAN_MODE is on (care-plan-crm.js).
 */
(function () {
  'use strict';
  if (window.NBDCarePlanMembers && window.NBDCarePlanMembers.__v === 1) return;

  const MEMBER = ['active', 'past_due'];
  let _rows = [];
  let _filter = 'members';   // 'members' | 'invited' | 'ended'
  let _loaded = false;
  let _error = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function scroll() { return document.getElementById('careplanScroll') || document.querySelector('#view-careplan .view-scroll'); }
  function fmtDate(iso) {
    const t = iso ? new Date(iso) : null;
    return t && !isNaN(t.getTime()) ? t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function groupOf(r) {
    if (MEMBER.indexOf(r.status) !== -1) return 'members';
    if (r.status === 'pending') return 'invited';
    return 'ended';
  }

  /** Pure: rows sorted members → invited → ended, then by name. */
  function sortRows(rows) {
    const rank = { members: 0, invited: 1, ended: 2 };
    return rows.slice().sort((a, b) => (rank[groupOf(a)] - rank[groupOf(b)])
      || String(a.memberName || '').localeCompare(String(b.memberName || '')));
  }

  async function load() {
    const u = window._user && window._user.uid;
    if (!u || !window.db || !window.getDocs || !window.query || !window.where || !window.collection) return false;
    const c = window._userClaims || {};
    const cid = c.companyId || u;
    const col = window.collection(window.db, 'careplans');
    // Same query shape the rules allow (phone_calls pattern): company readers
    // and platform admins by companyId, a solo owner by userId.
    const byCompany = ['company_admin', 'manager', 'viewer', 'admin'].indexOf(c.role || '') !== -1;
    const q = byCompany ? window.query(col, window.where('companyId', '==', cid)) : window.query(col, window.where('userId', '==', u));
    try {
      const snap = await window.getDocs(q);
      _rows = sortRows(snap.docs.map((d) => Object.assign({ id: d.id }, d.data())));
      _error = '';
    } catch (e) {
      _rows = [];
      _error = 'Could not load memberships (' + String((e && (e.code || e.message)) || 'error') + ').';
    }
    _loaded = true;
    return true;
  }

  function chip(key, label, n) {
    const on = _filter === key;
    return '<button type="button" class="btn btn-sm ' + (on ? 'btn-orange' : 'btn-ghost') + '" data-cp-action="filter" data-cp-filter="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      esc(label) + ' <span class="ui-num">(' + n + ')</span></button>';
  }

  function row(r) {
    const g = groupOf(r);
    const href = '/pro/customer.html?id=' + encodeURIComponent(r.leadId || '');
    const price = r.interval === 'month' ? '$19/month' : (r.interval === 'year' ? '$199/year' : '');
    const meta = [];
    if (price) meta.push(price);
    if (g === 'members') {
      if (r.activatedAt) meta.push('since ' + fmtDate(r.activatedAt));
      if (r.cancelAtPeriodEnd && r.currentPeriodEnd) meta.push('ends ' + fmtDate(r.currentPeriodEnd));
      else if (r.currentPeriodEnd) meta.push('renews ' + fmtDate(r.currentPeriodEnd));
      if (r.status === 'past_due') meta.push('card failed — Stripe is retrying');
    } else if (g === 'invited') {
      meta.push(r.inviteExpiresAtMs ? 'link sent, expires ' + fmtDate(new Date(r.inviteExpiresAtMs).toISOString()) : 'started checkout, not paid');
    } else {
      meta.push(r.cancelledAt ? 'ended ' + fmtDate(r.cancelledAt) : 'ended');
    }
    if (r.memberAddress) meta.push(r.memberAddress);
    const canBill = g === 'members' && !!r.stripeCustomerId && window.NBDCarePlan && window.NBDCarePlan.mayManage();
    return '<div class="cp-row' + (g === 'members' ? ' is-member' : g === 'invited' ? ' is-pending' : '') + '">' +
      '<div class="cp-row-main">' +
        '<a class="cp-row-name" href="' + esc(href) + '">' + esc(r.memberName || 'Customer') + '</a>' +
        '<div class="cp-row-meta">' + esc(meta.join(' · ')) + '</div>' +
      '</div>' +
      (canBill ? '<button type="button" class="btn btn-ghost btn-sm" data-cp-action="billing" data-cp-id="' + esc(r.id) + '">Billing link</button>' : '') +
    '</div>';
  }

  function render() {
    const el = scroll();
    if (!el) return;
    const counts = { members: 0, invited: 0, ended: 0 };
    _rows.forEach((r) => { counts[groupOf(r)]++; });
    const list = _rows.filter((r) => groupOf(r) === _filter);
    el.innerHTML =
      '<div class="page-hdr"><div><div class="page-title">\u{1F6E1} Roof Care Plan</div>' +
      '<div class="page-sub">$199 a year or $19 a month. Members get a yearly inspection with a written report, small touch-ups on the visit, priority after storms and 10% off repairs (applied to their repair estimates automatically).</div></div></div>' +
      '<div class="cp-filters">' + chip('members', 'Members', counts.members) + chip('invited', 'Invited', counts.invited) + chip('ended', 'Ended', counts.ended) + '</div>' +
      (!_loaded ? '<div class="ui-empty"><div class="ui-empty-title">Loading…</div></div>'
        : _error ? '<div class="ui-empty"><div class="ui-empty-title">' + esc(_error) + '</div></div>'
        : list.length ? list.map(row).join('')
        : '<div class="ui-empty"><div class="ui-empty-title">' + esc({ members: 'No members yet', invited: 'No open invites', ended: 'Nobody has ended a plan' }[_filter]) + '</div>' +
          '<div class="ui-empty-body">' + esc(_filter === 'members' ? 'Open a customer and tap "Add to Care Plan" to send them the sign-up link.' : '') + '</div></div>');
  }

  function bind(el) {
    if (!el || el._cpBound) return;
    el._cpBound = true;
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('[data-cp-action]');
      if (!b) return;
      const act = b.getAttribute('data-cp-action');
      if (act === 'filter') { _filter = b.getAttribute('data-cp-filter') || 'members'; render(); return; }
      if (act === 'billing') {
        const r = _rows.find((x) => x.id === b.getAttribute('data-cp-id'));
        if (r && window.NBDCarePlan) window.NBDCarePlan.billingLink({ carePlan: { carePlanId: r.id }, firstName: r.memberName, phone: r.memberPhone, email: r.memberEmail });
      }
    });
  }

  async function init() {
    const el = scroll();
    if (!el) return;
    bind(el);
    render();
    if (await load()) render();
  }

  window.NBDCarePlanMembers = { __v: 1, init, _sortRows: sortRows, _groupOf: groupOf };
})();
