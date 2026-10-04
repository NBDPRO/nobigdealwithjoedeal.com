/**
 * server-aggregates.js — Stage B slice 1: SHADOW server-side counts.
 *
 * Ops Audit #4 P1 item 4 ("client loads every lead") can't be fixed by
 * truncating the fetch: 11 consumers (KPIs, money dashboard, global
 * search, export, forecasting, ROI) compute over window._leads and
 * would silently under-report. The migration path is server-side
 * aggregates — and step one is proving they AGREE with the cache
 * before anything consumes them.
 *
 * This module runs a Firestore count() aggregation over the same
 * predicate loadLeads uses (userId == uid) and compares it against
 * window._leadsRawCount — the PRE-filter page-union total loadLeads
 * stashes — so the comparison is apples-to-apples (window._leads
 * itself is post-filter and would mismatch by design).
 *
 * SHADOW ONLY: nothing in the UI reads these numbers. Behind the
 * `serverAggregatesShadow` feature flag (feature_flags/_default) so it
 * costs zero reads until deliberately enabled. Mismatches log a
 * console.warn (picked up by Sentry breadcrumbs) with both values;
 * agreement logs quietly at info. Once this has run clean in prod for
 * a while, slice 2 starts moving KPI counts onto getCountFromServer
 * and the fetch can eventually page-and-stop.
 *
 * Aggregation queries are priced at 1 doc-read per 1000 index entries
 * scanned — the shadow costs ~1 read per dashboard boot while it runs.
 */
(function () {
  'use strict';
  if (window.NBDServerAggregates && window.NBDServerAggregates.__sentinel === 'nbd-server-agg-v1') return;

  const SDK = '/assets/vendor/firebase/12.19.0/firebase-firestore.js';

  async function leadCount(uid) {
    const fs = await import(SDK);
    const db = window._db || window.db;
    if (!db || typeof fs.getCountFromServer !== 'function') return null;
    // Mirror loadLeads' role-branched scope EXACTLY (team pipeline
    // visibility, 2026-07) or the shadow fires a guaranteed false
    // MISMATCH for staff: the cache holds the tenant book (+ own leads,
    // deduped) while a userId-only count sees one rep's slice. Team
    // readers count company + own and subtract the overlap.
    const claims = window._userClaims || {};
    const teamReader = ['company_admin', 'manager', 'viewer'].includes(claims.role || '')
      && !!claims.companyId;
    const countOf = async (...filters) => {
      const snap = await fs.getCountFromServer(
        fs.query(fs.collection(db, 'leads'), ...filters));
      return snap.data().count;
    };
    if (!teamReader) return countOf(fs.where('userId', '==', uid));
    if (claims.companyId === uid) return countOf(fs.where('companyId', '==', uid));
    const [companyN, ownN, overlapN] = await Promise.all([
      countOf(fs.where('companyId', '==', claims.companyId)),
      countOf(fs.where('userId', '==', uid)),
      countOf(fs.where('companyId', '==', claims.companyId), fs.where('userId', '==', uid)),
    ]);
    return companyN + ownN - overlapN;
  }

  async function shadowCompare() {
    try {
      if (!window.NBDFlags || !window.NBDFlags.enabled('serverAggregatesShadow')) return null;
      const uid = window._user && window._user.uid;
      if (!uid) return null;
      const clientCount = window._leadsRawCount;
      if (typeof clientCount !== 'number') return null; // loadLeads hasn't stamped it
      const serverCount = await leadCount(uid);
      if (serverCount == null) return null;
      const result = { serverCount, clientCount, match: serverCount === clientCount };
      if (result.match) {
        console.info('[server-aggregates] shadow count agrees with cache:', serverCount);
      } else {
        // The signal this whole slice exists for: cache and server disagree.
        // Expected causes to rule out before trusting aggregates: writes that
        // landed between the paged fetch and the count, or the 100k page cap.
        console.warn('[server-aggregates] SHADOW MISMATCH — server:', serverCount,
          'cache(raw):', clientCount, '— investigate before Stage B slice 2');
      }
      return result;
    } catch (e) {
      console.warn('[server-aggregates] shadow compare failed (non-fatal):', e && e.message);
      return null;
    }
  }

  window.NBDServerAggregates = {
    __sentinel: 'nbd-server-agg-v1',
    leadCount,
    shadowCompare,
  };
})();
