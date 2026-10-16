/**
 * lead-search.js — typo-tolerant lead search for the command palette and the
 * Field layout (2026-10-16; repos report item 6).
 *
 * MiniSearch 7.2.0 (MIT, /assets/vendor/minisearch, ~6 KB gz) is fetched the
 * first time search is used, never at boot. The index is built in memory from
 * window._leads, the same array the palette already searched: no new
 * Firestore read. Fields: name (boost 3), address + zip (2), claim number and
 * carrier (1.5), phone digits and email (1), the lead's notes (0.5).
 * Prefix and fuzzy matching ("jordn avry" finds Jordan Avery, "sampel ridge"
 * finds 214 Sample Ridge Rd).
 *
 *   NBDLeadSearch.load()            -> Promise<boolean> (MiniSearch available)
 *   NBDLeadSearch.search(q, leads)  -> [{ lead, score }] best first, or null
 *                                      while MiniSearch is not loaded yet
 *
 * The index rebuilds when the leads array changes (identity or length) or is
 * older than a minute, so an edited lead is findable by its new name.
 */
(function (root) {
  'use strict';
  var SRC = '/assets/vendor/minisearch/7.2.0/minisearch.min.js';
  var MAX_AGE_MS = 60000;
  var loading = null;
  var idx = null, idxLeads = null, idxLen = -1, idxAt = 0, byId = {};

  function load() {
    if (root.MiniSearch) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var doc = root.document;
      if (!doc || !doc.createElement) { resolve(false); return; }
      var s = doc.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = function () { resolve(!!root.MiniSearch); };
      s.onerror = function () { loading = null; resolve(false); };
      (doc.head || doc.documentElement).appendChild(s);
    });
    return loading;
  }

  function str(v) { return v == null ? '' : String(v); }
  function docOf(l) {
    var notes = l.notes;
    if (Array.isArray(notes)) notes = notes.map(function (n) { return n && typeof n === 'object' ? str(n.text) : str(n); }).join(' ');
    return {
      id: str(l.id),
      name: (str(l.firstName) + ' ' + str(l.lastName)).trim() || str(l.name),
      address: (str(l.address) + ' ' + str(l.zip)).trim(),
      claim: (str(l.claimNumber) + ' ' + str(l.insCarrier || l.carrier)).trim(),
      contact: (str(l.phoneDigits || l.phone).replace(/\D/g, '') + ' ' + str(l.email)).trim(),
      notes: str(notes).slice(0, 2000),
    };
  }

  function ensure(leads, now) {
    if (idx && leads === idxLeads && leads.length === idxLen && now - idxAt < MAX_AGE_MS) return idx;
    var MS = root.MiniSearch;
    var next = new MS({
      fields: ['name', 'address', 'claim', 'contact', 'notes'],
      searchOptions: { boost: { name: 3, address: 2, claim: 1.5, contact: 1, notes: 0.5 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
    });
    var map = {}, docs = [];
    for (var i = 0; i < leads.length; i++) {
      var l = leads[i];
      if (!l || l.id == null || map[str(l.id)]) continue;
      map[str(l.id)] = l;
      docs.push(docOf(l));
    }
    next.addAll(docs);
    idx = next; idxLeads = leads; idxLen = leads.length; idxAt = now; byId = map;
    return idx;
  }

  function search(q, leads, limit) {
    q = str(q).trim();
    if (!root.MiniSearch || !Array.isArray(leads)) return null;
    if (!q) return [];
    var ix = ensure(leads, Date.now());
    var hits = ix.search(q);
    // Nothing with every word: fall back to any word, still typo-tolerant.
    if (!hits.length) hits = ix.search(q, { combineWith: 'OR' });
    var out = [];
    for (var i = 0; i < hits.length && out.length < (limit || 12); i++) {
      var lead = byId[hits[i].id];
      if (lead) out.push({ lead: lead, score: hits[i].score });
    }
    return out;
  }

  var api = { load: load, search: search, ready: function () { return !!root.MiniSearch; }, _docOf: docOf, SRC: SRC };
  root.NBDLeadSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
