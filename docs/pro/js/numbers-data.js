/**
 * numbers-data.js — the Firestore reads/writes behind "knowing your numbers"
 * (2026-10-04). The rules live in numbers-logic.js; this file only fetches.
 *
 *   NBDNumbersData.isOwner()                 → bool (this user owns the tenant)
 *   NBDNumbersData.companyId()               → tenant key (claims.companyId || uid)
 *   NBDNumbersData.loadSpend({force})        → { months: {'YYYY-MM': {spendKey: cents}} } | null
 *   NBDNumbersData.saveSpendMonth(month, key, cents) → Promise<bool>
 *   NBDNumbersData.mergeSpendMonths(byMonth, key)    → Promise<bool> (CSV import)
 *   NBDNumbersData.loadWeekNote(weekKey) / saveWeekNote(weekKey, text)
 *   NBDNumbersData.loadClicks()              → { 'YYYY-MM': n }
 *   NBDNumbersData.loadExpenses()            → expense docs (job-cost links)
 *   NBDNumbersData.loadReviewAsks()          → [{ at, leadId }]
 *   NBDNumbersData.loadReviews()             → [{ time }] (Google, via /api/google-reviews)
 *
 * Spend, cost per lead and the weekly notes live at
 * companies/{companyId}/owner_numbers/{doc} — the OWNER only (firestore.rules).
 * Anyone else gets null and the screens hide the cost columns. Every load is
 * best-effort: a refused or failed read resolves to an empty value, never a
 * thrown error into a render.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  function uid() { return (window._user && window._user.uid) || (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null; }
  function claims() { return window._userClaims || {}; }
  function companyId() { return claims().companyId || uid(); }
  /** Owner of the tenant: solo (no company claim), keyed-by-uid, or role owner/admin. */
  function isOwner() {
    var c = claims();
    if (c.role === 'viewer') return false;
    return !c.companyId || c.companyId === uid() || c.role === 'owner' || c.role === 'admin';
  }
  function db() { return window.db || window._db || null; }
  function ready() { return !!(db() && uid() && window.doc && window.getDoc); }
  function ownerDoc(id) { return window.doc(db(), 'companies', companyId(), 'owner_numbers', id); }

  var _spend = null, _spendAt = 0;
  async function loadSpend(opts) {
    if (!ready() || !isOwner()) return null;
    if (_spend && !(opts && opts.force) && Date.now() - _spendAt < 60000) return _spend;
    try {
      var snap = await window.getDoc(ownerDoc('lead_spend'));
      var d = snap && snap.exists() ? (snap.data() || {}) : {};
      _spend = { months: (d.months && typeof d.months === 'object') ? d.months : {} };
    } catch (e) {
      _spend = { months: {} };
    }
    _spendAt = Date.now();
    return _spend;
  }
  function cachedSpend() { return _spend; }

  async function _writeMonths(months) {
    if (!ready() || !isOwner() || !window.setDoc) return false;
    try {
      await window.setDoc(ownerDoc('lead_spend'), {
        months: months,
        updatedAt: typeof window.serverTimestamp === 'function' ? window.serverTimestamp() : new Date(),
        updatedBy: uid(),
      }, { merge: true });
      _spend = null;
      return true;
    } catch (e) {
      console.warn('[numbers] spend save failed', e && (e.code || e.message));
      return false;
    }
  }
  /** One month, one source: cents (0 clears it). */
  async function saveSpendMonth(month, key, cents) {
    if (!/^\d{4}-\d{2}$/.test(String(month)) || !/^[a-z0-9_]{1,40}$/.test(String(key))) return false;
    var c = Math.max(0, Math.round(Number(cents) || 0));
    var patch = {}; patch[month] = {}; patch[month][key] = c;
    return _writeMonths(patch);
  }
  /** CSV import: { 'YYYY-MM': cents } for one source, replacing those months. */
  async function mergeSpendMonths(byMonth, key) {
    if (!/^[a-z0-9_]{1,40}$/.test(String(key))) return false;
    var patch = {};
    Object.keys(byMonth || {}).forEach(function (m) {
      if (!/^\d{4}-\d{2}$/.test(m)) return;
      patch[m] = {}; patch[m][key] = Math.max(0, Math.round(Number(byMonth[m]) || 0));
    });
    if (!Object.keys(patch).length) return false;
    return _writeMonths(patch);
  }

  async function loadWeekNote(weekKey) {
    if (!ready() || !isOwner() || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekKey))) return null;
    try {
      var snap = await window.getDoc(ownerDoc('week_' + weekKey));
      return snap && snap.exists() ? (snap.data() || {}) : {};
    } catch (e) { return null; }
  }
  async function saveWeekNote(weekKey, text) {
    if (!ready() || !isOwner() || !window.setDoc || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekKey))) return false;
    try {
      await window.setDoc(ownerDoc('week_' + weekKey), {
        weekKey: weekKey,
        decision: String(text || '').slice(0, 2000),
        updatedAt: typeof window.serverTimestamp === 'function' ? window.serverTimestamp() : new Date(),
        updatedBy: uid(),
      }, { merge: true });
      return true;
    } catch (e) {
      console.warn('[numbers] week note save failed', e && (e.code || e.message));
      return false;
    }
  }

  async function loadClicks() {
    var out = {};
    if (!ready() || !isOwner()) return out;
    // The last 12 months, one small doc each (referral_clicks_YYYY-MM).
    var d = new Date(); d.setDate(1);
    var ids = [];
    for (var i = 0; i < 12; i++) {
      ids.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
      d.setMonth(d.getMonth() - 1);
    }
    await Promise.all(ids.map(function (m) {
      return window.getDoc(ownerDoc('referral_clicks_' + m)).then(function (s) {
        if (s && s.exists()) out[m] = Number((s.data() || {}).clicks) || 0;
      }).catch(function () {});
    }));
    return out;
  }

  async function _query(coll, field, value) {
    if (!ready() || !window.getDocs || !window.query || !window.where || !window.collection) return [];
    try {
      var snap = await window.getDocs(window.query(window.collection(db(), coll), window.where(field, '==', value)));
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) { return []; }
  }
  /** Expenses: the company's (staff) or the user's own — same scoping as expenses.js. */
  async function loadExpenses() {
    var c = claims();
    var staff = c.companyId && ['company_admin', 'manager', 'admin'].indexOf(c.role || '') !== -1;
    return staff ? _query('expenses', 'companyId', c.companyId) : _query('expenses', 'userId', uid());
  }
  /** Review asks: review_requests (this user) + reviewRequestedAt on the leads. */
  async function loadReviewAsks() {
    var rows = await _query('review_requests', 'userId', uid());
    var N = window.NBDNumbers;
    var out = rows.map(function (r) { return { at: N ? N.toMs(r.sentAt) : 0, leadId: r.leadId }; }).filter(function (r) { return r.at; });
    // Leads asked before review_requests existed carry only the lead stamp.
    var seen = {}; out.forEach(function (r) { if (r.leadId) seen[r.leadId] = 1; });
    if (N) N.reviewAsksFromLeads(window._leads || []).forEach(function (r) { if (!seen[r.leadId]) out.push(r); });
    return out;
  }
  var _reviews = null;
  async function loadReviews() {
    if (_reviews) return _reviews;
    try {
      var res = await fetch('/api/google-reviews', { credentials: 'omit' });
      var body = res.ok ? await res.json() : {};
      _reviews = Array.isArray(body.reviews) ? body.reviews.map(function (r) { return { time: Number(r.time) || 0 }; }) : [];
    } catch (e) { _reviews = []; }
    return _reviews;
  }

  window.NBDNumbersData = {
    isOwner: isOwner, companyId: companyId,
    loadSpend: loadSpend, cachedSpend: cachedSpend, saveSpendMonth: saveSpendMonth, mergeSpendMonths: mergeSpendMonths,
    loadWeekNote: loadWeekNote, saveWeekNote: saveWeekNote,
    loadClicks: loadClicks, loadExpenses: loadExpenses, loadReviewAsks: loadReviewAsks, loadReviews: loadReviews,
  };
})();
