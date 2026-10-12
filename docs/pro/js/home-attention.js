/**
 * home-attention.js — the "needs you" strip on Home (#homeAttention, under the
 * KPI row). Two counts, each shown only when it is not zero, each a tap to
 * the view that clears it:
 *
 *   💳 Stripe payments that need a customer   → Money (the Stripe panel's
 *      review list, stripeLedger needsReview:true)
 *   🪧 Yard signs due for pickup today / late  → Yard Signs
 *
 * Both lists already exist on their own views; Jo asked for the Stripe one
 * to surface on Home (2026-09-29) so a payment never sits unassigned because
 * nobody opened Money. Reads only — nothing here writes.
 *
 * The Stripe count uses the ledger's read rule (stripe-ledger-ui-logic.js
 * canRead: not a sales rep or viewer — tests pin the parity) and the tenant
 * the panel uses. Yard signs use the same owner / company query as
 * yard-signs.js. Both are equality-only queries (no composite index).
 * Rendered after data refreshes, throttled to one read per minute.
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  const DAY = 86400000;
  const toMs = (t) => {
    if (t == null) return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const v = Date.parse(t); return isFinite(v) ? v : 0;
  };
  const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

  function canSeeStripe(claims, uid) {
    if (!uid) return false;
    const r = (claims || {}).role || '';
    return r !== 'sales_rep' && r !== 'viewer';
  }
  function tenantOf(claims, uid) { return (claims && claims.companyId) || uid || null; }

  /** Signs still out whose pickup day is today or already past. */
  function signsDue(signs, now) {
    const today = startOfDay(now == null ? Date.now() : now);
    return (signs || []).filter((s) => {
      if (!s || s.status === 'picked_up' || s.status === 'missing') return false;
      const due = toMs(s.dueAt);
      return due > 0 && startOfDay(due) <= today;
    }).length;
  }
  function reviewCount(rows) {
    return (rows || []).filter((r) => r && r.needsReview === true && r.kind !== 'platform_subscription').length;
  }

  function stripHtml(counts) {
    const c = counts || {};
    const items = [];
    if (c.stripe > 0) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="money">💳 ' + c.stripe + ' Stripe payment' + (c.stripe === 1 ? '' : 's') + ' need' + (c.stripe === 1 ? 's' : '') + ' a customer</button>');
    if (c.signs > 0) items.push('<button type="button" class="ha-item" data-action="goTo" data-target="signs">🪧 ' + c.signs + ' yard sign' + (c.signs === 1 ? '' : 's') + ' to pick up</button>');
    return items.join('');
  }

  const api = { canSeeStripe, tenantOf, signsDue, reviewCount, stripHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.NBDHomeAttention = api;

  // ── DOM ──────────────────────────────────────────────────────────────
  const w = root;
  let _last = 0, _busy = false;
  const uid = () => (w._user && w._user.uid) || null;
  const claims = () => w._userClaims || {};
  const fbReady = () => !!(w.db && w.getDocs && w.query && w.where && w.collection);

  async function count() {
    const u = uid(), c = claims();
    const out = { stripe: 0, signs: 0 };
    const tenant = tenantOf(c, u);
    const jobs = [];
    if (canSeeStripe(c, u) && tenant) {
      jobs.push(w.getDocs(w.query(w.collection(w.db, 'stripeLedger'), w.where('companyId', '==', tenant), w.where('needsReview', '==', true)))
        .then((snap) => { out.stripe = reviewCount(snap.docs.map((d) => d.data())); }).catch(() => {}));
    }
    const staff = ['company_admin', 'manager', 'viewer', 'admin'].includes(c.role || '') && !!c.companyId;
    const col = w.collection(w.db, 'yardSigns');
    jobs.push(w.getDocs(staff ? w.query(col, w.where('companyId', '==', c.companyId)) : w.query(col, w.where('userId', '==', u)))
      .then((snap) => { out.signs = signsDue(snap.docs.map((d) => d.data()), Date.now()); }).catch(() => {}));
    await Promise.all(jobs);
    return out;
  }

  async function render(force) {
    const el = document.getElementById('homeAttention');
    if (!el || !uid() || !fbReady() || _busy) return;
    if (!force && Date.now() - _last < 60000) return;
    _busy = true; _last = Date.now();
    try {
      const html = stripHtml(await count());
      el.innerHTML = html;
      el.hidden = !html;
    } finally { _busy = false; }
  }

  w.addEventListener('nbd:data-refreshed', () => { render(false); });
  w.addEventListener('hashchange', () => { if (/^#?\/?(home|dash)?$/.test(location.hash || '')) setTimeout(() => render(false), 300); });
  const boot = () => setTimeout(() => render(true), 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  api.render = render;
})(typeof window !== 'undefined' ? window : null);
