/**
 * receipt-filter-logic.js — pure search / filter / sort for the receipt import
 * review (2026-10-19). Nothing here touches the DOM, Firestore or storage.
 *
 * Jo (live Home Depot import, 2026-10-19): "when the best matches don't show
 * up I scroll a long list of jobs" and "more searchability and filtering".
 * Two lanes, both pure so they can be unit-tested in a vm sandbox:
 *
 *   searchLeads(leads, query, opts)   type-ahead for the per-row job picker.
 *       Multi-word AND, case-insensitive, over name / address / street /
 *       customer # / lead id / stage. The row's best matches (and then the
 *       jobs used most recently) stay pinned on top and are still shown first.
 *   filterRows / sortRows / totals    the review table's filter bar.
 *   bulkTargets                       which visible rows a bulk "assign to job"
 *       may touch (never a row already imported, never a customer-# or
 *       remembered-name match that points at a different job).
 *
 * Money stays in cents. Exposes window.NBDReceiptFilter.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9.#]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function tokens(q) { return norm(String(q == null ? '' : q).replace(/\$/g, '')).split(' ').filter(Boolean); }

  // "12.5" / "$1,200" / "" → cents, or null when blank / not a number
  function dollarsToCents(v) {
    const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  function centsText(c) { return (Math.max(0, Number(c) || 0) / 100).toFixed(2); }

  // ── job picker ───────────────────────────────────────────────────────
  function leadName(l) {
    return (((l.firstName || '') + ' ' + (l.lastName || '')).trim()) || l.name || '';
  }
  function leadStreet(l) { return String(l.address || '').split(',')[0].trim(); }
  function leadHaystack(l) {
    return norm([l.customerId, leadName(l), l.address, l.id, l.stage, l.status, l.damageType].filter(Boolean).join(' '));
  }
  function leadMatches(l, q) {
    const t = tokens(q);
    if (!t.length) return true;
    const h = leadHaystack(l);
    return t.every((w) => h.indexOf(w) !== -1);
  }
  // Lower = better. A name or street that STARTS with the first word beats a
  // match buried in the middle of the address.
  function leadRank(l, q) {
    const t = tokens(q);
    if (!t.length) return 0;
    const name = norm(leadName(l)), street = norm(leadStreet(l)), cid = norm(l.customerId);
    let r = 3;
    if (cid && cid === t[0]) r = 0;
    else if (name.indexOf(t[0]) === 0 || street.indexOf(t[0]) === 0) r = 1;
    else if (name.split(' ').some((w) => w.indexOf(t[0]) === 0) || street.split(' ').some((w) => w.indexOf(t[0]) === 0)) r = 2;
    return r;
  }

  // opts: { pinned: [leadId] (the row's best matches, in order),
  //         recent: [leadId] (most recently assigned first), limit }
  // Returns [{ lead, group }] with group 'best' | 'recent' | 'all'.
  function searchLeads(leads, query, opts) {
    const o = opts || {};
    const live = (leads || []).filter((l) => l && l.id && !l.deleted);
    const seen = {};
    const out = [];
    const take = (l, group) => {
      if (seen[l.id] || !leadMatches(l, query)) return;
      seen[l.id] = 1;
      out.push({ lead: l, group });
    };
    const byId = {};
    live.forEach((l) => { byId[l.id] = l; });
    (o.pinned || []).forEach((id) => { if (byId[id]) take(byId[id], 'best'); });
    (o.recent || []).forEach((id) => { if (byId[id]) take(byId[id], 'recent'); });
    const rest = live.filter((l) => !seen[l.id] && leadMatches(l, query));
    rest.sort((a, b) => {
      const d = leadRank(a, query) - leadRank(b, query);
      if (d) return d;
      return (leadName(a) || leadStreet(a)).localeCompare(leadName(b) || leadStreet(b));
    });
    rest.forEach((l) => take(l, 'all'));
    const lim = Number(o.limit) > 0 ? Number(o.limit) : 50;
    return out.slice(0, lim);
  }

  // ── review table ─────────────────────────────────────────────────────
  const DEFAULT_FILTERS = { q: '', assign: 'all', from: '', to: '', min: '', max: '', store: '', sort: 'date-desc' };
  function isDefault(f) {
    const d = DEFAULT_FILTERS, x = f || {};
    return Object.keys(d).every((k) => String(x[k] == null ? d[k] : x[k]) === d[k]);
  }
  function cleanFilters(f) {
    const out = Object.assign({}, DEFAULT_FILTERS);
    Object.keys(DEFAULT_FILTERS).forEach((k) => { if (f && typeof f[k] === 'string') out[k] = f[k].slice(0, 80); });
    if (['all', 'assigned', 'unassigned', 'selected', 'unselected', 'imported'].indexOf(out.assign) === -1) out.assign = 'all';
    if (SORTS.indexOf(out.sort) === -1) out.sort = 'date-desc';
    return out;
  }
  const SORTS = ['date-desc', 'date-asc', 'amount-desc', 'amount-asc', 'job-asc', 'store-asc', 'unassigned-first'];

  // ctx.labelFor(leadId) → the assigned job's label, so a search for the
  // customer's name finds the receipts already assigned to them.
  function rowHaystack(r, ctx) {
    const lab = (ctx && typeof ctx.labelFor === 'function' && r.leadId) ? ctx.labelFor(r.leadId) : '';
    return norm([
      'home depot', r.jobName, r.projectName, r.storeName, r.store ? '#' + r.store : '', r.store, r.date, r.order, r.invoice,
      centsText(r.totalCents), centsText(r.taxCents), lab,
      (r.items || []).map((i) => (i.desc || '') + ' ' + (i.sku || '')).join(' '),
    ].filter(Boolean).join(' '));
  }
  function isAssigned(r) { return !!r.leadId; }

  function filterRows(rows, f, ctx) {
    const x = cleanFilters(f);
    const t = tokens(x.q);
    const min = dollarsToCents(x.min), max = dollarsToCents(x.max);
    return (rows || []).filter((r) => {
      if (x.assign === 'assigned' && !isAssigned(r)) return false;
      if (x.assign === 'unassigned' && isAssigned(r)) return false;
      if (x.assign === 'selected' && !(r.include && !r.already)) return false;
      if (x.assign === 'unselected' && (r.include || r.already)) return false;
      if (x.assign === 'imported' && !r.already) return false;
      if (x.from && String(r.date || '') < x.from) return false;
      if (x.to && String(r.date || '') > x.to) return false;
      if (min != null && (r.totalCents || 0) < min) return false;
      if (max != null && (r.totalCents || 0) > max) return false;
      if (x.store && String(r.store || '') !== x.store) return false;
      if (t.length) { const h = rowHaystack(r, ctx); if (!t.every((w) => h.indexOf(w) !== -1)) return false; }
      return true;
    });
  }

  function sortRows(rows, sort, ctx) {
    const list = (rows || []).slice();
    const s = SORTS.indexOf(sort) === -1 ? 'date-desc' : sort;
    const cmpDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const cmp = {
      'date-desc': (a, b) => cmpDate(b, a),
      'date-asc': cmpDate,
      'amount-desc': (a, b) => (b.totalCents || 0) - (a.totalCents || 0),
      'amount-asc': (a, b) => (a.totalCents || 0) - (b.totalCents || 0),
      'job-asc': (a, b) => String(a.jobName || '').toLowerCase().localeCompare(String(b.jobName || '').toLowerCase()),
      'store-asc': (a, b) => String(a.storeName || a.store || '').toLowerCase().localeCompare(String(b.storeName || b.store || '').toLowerCase()),
      'unassigned-first': (a, b) => (isAssigned(a) ? 1 : 0) - (isAssigned(b) ? 1 : 0),
    }[s];
    // stable: ties keep the incoming (newest-first) order
    return list.map((r, i) => ({ r, i })).sort((a, b) => cmp(a.r, b.r) || a.i - b.i).map((p) => p.r);
  }

  function totals(allRows, visibleRows) {
    const sel = (r) => r.include && !r.already;
    const sum = (arr) => arr.reduce((a, r) => a + (r.totalCents || 0), 0);
    const vis = visibleRows || [];
    const visSel = vis.filter(sel);
    return {
      total: (allRows || []).length,
      visible: vis.length,
      visibleCents: sum(vis),
      selectedVisible: visSel.length,
      selectedVisibleCents: sum(visSel),
      selectedAll: (allRows || []).filter(sel).length,
      selectedAllCents: sum((allRows || []).filter(sel)),
    };
  }

  function storeOptions(rows) {
    const m = {};
    (rows || []).forEach((r) => { if (r.store) m[r.store] = r.storeName || ''; });
    return Object.keys(m).sort().map((s) => ({ store: s, label: (m[s] ? m[s] + ' ' : '') + '#' + s }));
  }

  // A bulk assign never rewrites a row that is already imported, and never
  // moves a row Jo's own customer # / remembered name pinned to ANOTHER job.
  function bulkTargets(visibleRows, leadId) {
    const apply = [], skipped = [];
    (visibleRows || []).forEach((r) => {
      if (r.already) { skipped.push({ row: r, why: 'imported' }); return; }
      const st = r.match && r.match.status;
      if ((st === 'code' || st === 'alias') && r.leadId && r.leadId !== leadId) { skipped.push({ row: r, why: 'matched' }); return; }
      apply.push(r);
    });
    return { apply, skipped };
  }

  root.NBDReceiptFilter = {
    norm, tokens, dollarsToCents, centsText,
    leadMatches, leadHaystack, searchLeads,
    DEFAULT_FILTERS, SORTS, isDefault, cleanFilters, rowHaystack, filterRows, sortRows, totals, storeOptions, bulkTargets,
  };
})();
