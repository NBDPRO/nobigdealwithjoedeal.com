/**
 * os/kpi.js — the NBD OS "Saved view" KPI tile (2026-11-09, P3; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3, XFCE genmon).
 *
 * One number: how many leads in memory (window._leads, the same list the map
 * filters) match one of the team's saved map views (companyProfile.mapViews,
 * maps-customers.js). os/kpi-logic.js is the map's own filter as pure code.
 *   S  the view's name and the count
 *   M  the same, plus "Change view"
 * Tapping the number opens the Map with the Customers layer on and that view
 * applied (maps-customers.js openCustomersView). Several tiles can sit on one
 * home, each its own view, within the 24-widget cap.
 *
 * Reads nothing: no Firestore, no listener, no timer. Missing data shows no
 * number: no view picked, a view that is gone, leads or the company profile
 * not loaded yet each say so in words. The tile stores only the view's id (kpi-logic viewId).
 *
 *   NBDOSKpi.widget(size, cfg, kit)   the tile's markup (every value escaped)
 *   NBDOSKpi.pick({ current, onPick, returnFocus })  a native <dialog> of the views
 *   NBDOSKpi.open(id)                 the Map with that view; false when it is gone
 *
 * Loaded as the runtime ScriptLoader bundle 'oskpi' that os/home.js registers
 * (css/os/kpi.css, os/kpi-logic.js, this file). No inline handlers, no style
 * attributes.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSKpi) return;
  var KL = W.NBDOSKpiLogic;
  if (!KL) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function profile() { var p = W._companyProfile; return p && typeof p === 'object' ? p : null; }
  // Until company-profile.js has read the profile (or when that read failed), _companyProfile holds
  // the NBD defaults, mapViews [], so "no saved views" would be a guess: maps-customers.js gates its
  // View list on the same flag (_custViewsReady). The home repaints on nbd:company-profile-loaded.
  function profileReady() { return W._companyProfileLoaded === true; }
  var LOADING = 'Loading your team\'s views';
  function leads() { return W._leadsLoaded === true && Array.isArray(W._leads) ? W._leads : null; }
  function env() { return { normalizeStage: W.normalizeStage, stageRole: W.stageRole }; }
  function viewOf(cfg) { return cfg && typeof cfg.view === 'string' ? KL.findView(profile(), cfg.view) : null; }
  function countOf(v) { try { return KL.count(v.view, leads(), env()); } catch (e) { return null; } }
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }

  var PICK = '<button type="button" class="btn btn-ghost os-hw-btn os-kpi-pick" data-oshw-kpi="pick">Pick a view</button>';
  function title(t) { return '<h3 class="os-hw-title">' + esc(t) + '</h3>'; }

  function widget(size, cfg) {
    if (!profileReady()) return title('Saved view') + '<p class="os-hw-empty">' + esc(LOADING) + '</p>';
    var all = KL.listViews(profile());
    var picked = cfg && typeof cfg.view === 'string';
    var v = viewOf(cfg);
    if (!v) {
      var h = title('Saved view');
      if (!all.length) return h + '<p class="os-hw-empty">' + esc(size === 's' ? 'No saved views yet' : 'Your team has no saved map views yet. An owner saves them on the Map\'s Customers layer.') + '</p>';
      if (picked) return h + '<p class="os-hw-empty">That saved view is gone.</p>' + PICK;
      return h + '<p class="os-hw-empty">' + esc(size === 's' ? 'Count a saved view' : 'Count the leads in one of your team\'s saved map views.') + '</p>' + PICK;
    }
    var n = countOf(v);
    if (n === null) return title(v.name) + '<p class="os-hw-empty">Waiting for your leads</p>';
    var out = title(v.name) +
      '<button type="button" class="os-hw-row os-kpi-big" data-oshw-kpi="open" aria-label="' + esc(plural(n, 'lead matches ', 'leads match ') + v.name + '. Open it on the map') + '">' +
      '<span class="os-kpi-n ui-num">' + esc(String(n)) + '</span><span class="os-kpi-l">' + esc(n === 1 ? 'lead matches' : 'leads match') + '</span></button>';
    if (size === 's') return out;
    return out + '<button type="button" class="ui-btn-quiet os-hw-btn os-kpi-change" data-oshw-kpi="pick">Change view</button>';
  }

  // ── the picker: a native <dialog>, styled as the Add widget sheet (home.css .os-hw-add) ──
  var dlg = null;
  function outside(d, ev) {
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }
  function pick(opts) {
    var o = opts || {};
    if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
    var views = KL.listViews(profile());
    var ls = leads();
    var d = doc.createElement('dialog');
    d.className = 'os-hw-add os-kpi-dlg';
    d.setAttribute('aria-labelledby', 'osKpiTitle');
    var h = '<div class="os-hw-add-hd"><h2 class="os-hw-add-title" id="osKpiTitle">Count a saved view</h2>' +
      '<button type="button" class="btn btn-ghost os-hw-add-close" data-oskpi-close="">Close</button></div>';
    if (!profileReady()) {
      h += '<p class="os-hw-add-full" role="status">Your team\'s saved map views are still loading. Close this and try again in a moment.</p>';
    } else if (!views.length) {
      h += '<p class="os-hw-add-full">Your team has no saved map views yet. An owner or admin saves them from the Customers layer on the Map (the View row).</p>';
    } else {
      h += '<p class="os-hw-add-full">Your team\'s saved map views. The tile counts the leads that match, from what is already loaded.</p><ul class="os-hw-add-list">' +
        views.map(function (v) {
          var full = KL.findView(profile(), v.id);
          var n = ls && full ? KL.count(full.view, ls, env()) : null;
          var on = o.current === v.id;
          return '<li class="os-hw-add-row"><div class="os-hw-add-txt"><span class="os-hw-add-name">' + esc(v.name) + '</span>' +
            (n === null ? '' : '<span class="os-hw-add-about">' + esc(plural(n, 'lead matches', 'leads match')) + '</span>') + '</div>' +
            '<button type="button" class="btn btn-ghost os-hw-add-chip" data-oskpi-view="' + esc(v.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' +
            esc('Count ' + v.name) + '">' + (on ? 'Showing' : 'Use') + '</button></li>';
        }).join('') + '</ul>';
    }
    d.innerHTML = h;
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-oskpi-close]') || (t === d && outside(d, ev))) { d.close(); return; }
      var b = t.closest('[data-oskpi-view]');
      if (!b) return;
      var id = b.getAttribute('data-oskpi-view');
      if (!KL.ID_RE.test(id)) return;
      d.close();
      if (typeof o.onPick === 'function') o.onPick(id, (KL.findView(profile(), id) || {}).name || '');
    });
    d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); d.close(); } });
    d.addEventListener('close', function () {
      if (d.parentNode) d.parentNode.removeChild(d);
      if (dlg === d) dlg = null;
      var back = o.returnFocus;
      if (back && back.isConnected !== false) { try { back.focus(); } catch (e) {} }
    });
    doc.body.appendChild(d);
    dlg = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('[data-oskpi-view][aria-pressed="true"]') || d.querySelector('[data-oskpi-view]') || d.querySelector('[data-oskpi-close]');
    if (first) { try { first.focus(); } catch (e) {} }
    return d;
  }

  /** The Map, the Customers layer on, the view applied (maps-customers.js, fetched with the map). */
  function open(id) {
    var v = KL.findView(profile(), id);
    if (!v) return false;
    if (typeof W.goTo === 'function') { try { W.goTo('map'); } catch (e) {} }
    var SL = W.ScriptLoader;
    var ready = typeof W.openCustomersView === 'function' ? Promise.resolve()
      : (SL && typeof SL.loadBundle === 'function' ? Promise.resolve().then(function () { return SL.loadBundle('mapcustomers'); }) : Promise.resolve());
    ready.then(function () {
      if (typeof W.openCustomersView === 'function') W.openCustomersView(v.name);
    }, function () {});
    return true;
  }

  W.NBDOSKpi = { widget: widget, pick: pick, open: open };
})();
