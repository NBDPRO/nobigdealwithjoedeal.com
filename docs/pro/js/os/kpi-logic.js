/**
 * os/kpi-logic.js — the pure half of the NBD OS "Saved view" KPI tile (2026-11-09, P3;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3, "saved-filter
 * KPI tiles", after XFCE's genmon: one number from a command you already have).
 *
 * The saved filters a team already keeps on leads are the Customers map layer's saved
 * views (docs/pro/js/maps-customers.js, "SAVED VIEWS"): companyProfile.mapViews, an
 * array of { name, colorBy, filters: { stage, damage, value, rep }, valMin, valMax },
 * shared by every member, saved and deleted by an owner or company_admin. No new filter
 * language: this file is the map's own test (_custApplyView, then _custPasses over
 * window._leads, skipping deleted leads) written as pure functions, and
 * tests/nbd-os-kpi-setup-2026-11-09.test.js runs both over the same leads to pin parity.
 *
 * A tile stores only an id: viewId(name), 8 hex characters (FNV-1a of the view's name,
 * the name the map's View list shows). Never the name, the filters or a count, so a
 * copied setup carries no team data, and a view that was deleted (or a setup pasted
 * into another company) matches nothing and the tile shows no number.
 *
 *   viewId(name)                 the id a tile stores for a view
 *   listViews(profile)           [{ id, name, index }] in the map's order (the first of
 *                                two views with one name wins, as the map's list shows both)
 *   findView(profile, id)        { id, name, index, view } | null
 *   passes(view, lead, env)      the map's filter for one lead; env: { normalizeStage, stageRole }
 *   count(view, leads, env)      leads that are not deleted and pass; null when leads is not a list
 *
 * Classic script: window.NBDOSKpiLogic; require()-able for tests. Loaded with
 * os/kpi.js as the runtime ScriptLoader bundle 'oskpi' that os/home.js registers.
 */
(function (root) {
  'use strict';

  var ID_RE = /^[0-9a-f]{8}$/;
  var DIMS = ['stage', 'damage', 'value', 'rep'];
  var VAL_CAP = 100000;   // maps-customers.js _CUST_VAL_CAP: max === cap means "no upper limit"

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** FNV-1a 32-bit over the name's UTF-16 code units, as 8 lowercase hex characters. */
  function viewId(name) {
    var s = String(name == null ? '' : name), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    var hex = h.toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex;
  }
  // maps-customers.js _custViewName
  function viewName(v, i) { return (v && v.name) || ('View ' + (i + 1)); }

  function listViews(profile) {
    var list = isObj(profile) && Array.isArray(profile.mapViews) ? profile.mapViews : [];
    var out = [], seen = {};
    list.forEach(function (v, i) {
      if (!v || typeof v !== 'object') return;   // _custApplyView ignores it
      var name = String(viewName(v, i));
      var id = viewId(name);
      if (seen[id]) return;
      seen[id] = true;
      out.push({ id: id, name: name, index: i });
    });
    return out;
  }
  function findView(profile, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    var hit = listViews(profile).filter(function (x) { return x.id === id; })[0];
    return hit ? { id: hit.id, name: hit.name, index: hit.index, view: profile.mapViews[hit.index] } : null;
  }

  // ── the map's dimensions (maps-customers.js), one for one ──
  function roleOf(lead, env) {
    var e = env || {};
    var key = lead._stageKey || (typeof e.normalizeStage === 'function' ? e.normalizeStage(lead.stage) : (lead.stage || 'new'));
    if (typeof e.stageRole === 'function') { try { return e.stageRole(key); } catch (_) { /* the map falls through too */ } }
    return lead._stageRole || 'active';
  }
  function valueOf(lead) { return parseFloat(lead.jobValue || lead.value || lead.contractValue || 0) || 0; }
  function damageKey(lead) {
    var d = String(lead.damageType || '').toLowerCase().trim();
    if (!d) return 'unset';
    var hasHail = d.indexOf('hail') !== -1, hasWind = d.indexOf('wind') !== -1;
    if (hasHail && hasWind) return 'hailwind';
    if (hasHail) return 'hail';
    if (hasWind) return 'wind';
    if (d.indexOf('fire') !== -1) return 'fire';
    if (d.indexOf('water') !== -1) return 'water';
    if (d.indexOf('gutter') !== -1) return 'gutters';
    if (d.indexOf('full') !== -1) return 'full';
    return 'other';
  }
  function valueKey(lead) {
    var v = valueOf(lead);
    if (v >= 50000) return 'v4';
    if (v >= 25000 && v < 50000) return 'v3';
    if (v >= 10000 && v < 25000) return 'v2';
    if (v > 0 && v < 10000) return 'v1';
    return 'v0';
  }
  function repKey(lead) { return lead.userId || lead.assignedTo || 'unassigned'; }
  var CAT_OF = { stage: roleOf, damage: damageKey, value: valueKey, rep: repKey };

  /** What _custApplyView leaves in the map's state: per-dimension lists (null = all) and the value range. */
  function applied(view) {
    var f = {};
    DIMS.forEach(function (dk) {
      var a = view.filters && view.filters[dk];
      f[dk] = Array.isArray(a) ? a.slice() : null;
    });
    return { filters: f, valMin: typeof view.valMin === 'number' ? view.valMin : 0, valMax: typeof view.valMax === 'number' ? view.valMax : VAL_CAP };
  }
  // Set#has: SameValueZero
  function has(list, x) { for (var i = 0; i < list.length; i++) if (list[i] === x || (list[i] !== list[i] && x !== x)) return true; return false; }
  function passesApplied(st, lead, env) {
    for (var i = 0; i < DIMS.length; i++) {
      var dk = DIMS[i], f = st.filters[dk];
      if (f && !has(f, CAT_OF[dk](lead, env))) return false;
    }
    // _custValRangePasses
    if (!(st.valMin > 0 || st.valMax < VAL_CAP)) return true;
    var v = valueOf(lead);
    if (v < st.valMin) return false;
    if (st.valMax < VAL_CAP && v > st.valMax) return false;
    return true;
  }
  function passes(view, lead, env) {
    if (!view || typeof view !== 'object' || !lead) return false;
    return passesApplied(applied(view), lead, env);
  }
  function count(view, leads, env) {
    if (!Array.isArray(leads) || !view || typeof view !== 'object') return null;
    var st = applied(view), n = 0;
    for (var i = 0; i < leads.length; i++) {
      var l = leads[i];
      if (!l || l.deleted) continue;
      if (passesApplied(st, l, env)) n++;
    }
    return n;
  }

  var api = { ID_RE: ID_RE, viewId: viewId, listViews: listViews, findView: findView, passes: passes, count: count };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSKpiLogic = api;
})(typeof window !== 'undefined' ? window : null);
