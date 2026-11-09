/**
 * os/home-company.js — NBD OS company home, the owner's half (2026-11-09, P1;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.5).
 *
 * An owner or company_admin, in edit mode, can:
 *   publish(o)  "Publish to team": a native <dialog> asks first, then this
 *               surface's arrangement (widget ids, sizes, their enum settings,
 *               a Smart Stack's card ids and the desk's board cells; never
 *               anyone's numbers) is written as the
 *               company default, companies/{cid}/settings/layout.defaultWidgets
 *               ['os-phone' | 'os-desk'], through LayoutEngine.saveCompany (the
 *               existing company-settings write; firestore.rules lets only the
 *               solo owner or that company's company_admin write it)
 *   lock(o)     "Lock team homes" on or off (homeLocked, OFF by default): members
 *               then see the published home and get no edit mode
 * o: { surface: 'phone'|'desk', items: the home on screen, after(): repaint }.
 *
 * Members see only the business half of a company home's Coach and Daily
 * Success, from their own data (home-logic resolveHome). Reps never see these
 * controls (layouts/os.js shows them for canAdmin() only).
 *
 * Loaded on the first tap as the runtime ScriptLoader bundle `oshomeco`
 * (layouts/os.js registers it), never at boot. Every value goes into the DOM
 * escaped; no inline handlers, no style attributes.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSHomeCompany) return;

  var NAME = { phone: 'phone', desk: 'laptop' };
  var openEl = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    if (typeof W.showToast === 'function') { try { W.showToast(msg, kind || 'success'); } catch (e) {} }
  }
  function engine() { return W.LayoutEngine && typeof W.LayoutEngine.saveCompany === 'function' ? W.LayoutEngine : null; }
  function company() {
    var E = engine();
    var p = E && typeof E.prefs === 'function' ? E.prefs() : null;
    return (p && p.company) || {};
  }
  function HL() { return W.NBDOSHomeLogic; }
  /**
   * What is published: the arrangement only, cleaned the way a member's copy will be read
   * (home-logic companyList): { id, s, cfg? } per widget, plus a Smart Stack's card ids and,
   * on the desk, each widget's board cell (x, y, w, h). Never anyone's numbers.
   */
  function clean(items, surface) {
    var L = HL();
    if (!L || !Array.isArray(items) || !items.length) return [];
    var dw = {};
    dw[L.CO_KEY[surface]] = items;
    return L.companyList(dw, surface) || [];
  }
  function done(o) { if (o && typeof o.after === 'function') { try { o.after(); } catch (e) {} } }
  function outside(d, ev) {
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }

  function publish(o) {
    var opts = o || {};
    var E = engine(), L = HL();
    if (!E || !L) return;
    var surface = opts.surface === 'desk' ? 'desk' : 'phone';
    var items = clean(opts.items, surface);
    if (openEl && openEl.parentNode) openEl.parentNode.removeChild(openEl);
    var d = doc.createElement('dialog');
    d.className = 'os-hw-add os-hw-pub';
    d.setAttribute('aria-labelledby', 'oshwPubTitle');
    var names = items.map(function (it) { return L.CATALOG[it.id].title; });
    var locked = company().homeLocked === true;
    d.innerHTML =
      '<h2 class="os-hw-add-title" id="oshwPubTitle">Publish this home to your team?</h2>' +
      '<p class="os-hw-pub-p">' + esc(items.length
        ? 'Your team\'s ' + NAME[surface] + ' home becomes ' + (items.length === 1 ? 'this widget' : 'these ' + String(items.length) + ' widgets') + ': ' + names.join(', ') + '.'
        : 'Your team\'s ' + NAME[surface] + ' home becomes an empty one: no widgets, just the apps.') + '</p>' +
      '<p class="os-hw-pub-p">It sends which widgets and their sizes, never your numbers. Each person sees their own counts, and only the business half of Coach and Daily Success.</p>' +
      '<p class="os-hw-pub-p">' + esc(locked ? 'Team homes are locked, so everyone on the team sees this one.'
        : 'Anyone who hasn\'t changed their own home sees it. Lock team homes to show it to everyone.') + '</p>' +
      '<p class="os-hw-pub-p os-hw-pub-status" role="status"></p>' +
      '<div class="os-hw-pub-row">' +
        '<button type="button" class="btn btn-ghost os-hw-pub-btn" data-oshw-pub="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-orange os-hw-pub-btn" data-oshw-pub="go">Publish</button>' +
      '</div>';
    var busy = false;
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (busy) return;
      if (t.closest('[data-oshw-pub="cancel"]') || (t === d && outside(d, ev))) { d.close(); return; }
      if (!t.closest('[data-oshw-pub="go"]')) return;
      busy = true;
      var st = d.querySelector('.os-hw-pub-status');
      if (st) st.textContent = 'Publishing…';
      var merged = {};
      var cur = company().defaultWidgets || {};
      Object.keys(cur).forEach(function (k) { merged[k] = cur[k]; });
      merged[L.CO_KEY[surface]] = items;
      Promise.resolve(E.saveCompany({ defaultWidgets: merged })).then(function (r) { return r; }, function () { return null; }).then(function (r) {
        busy = false;
        d.close();
        toast(r && r.saved ? 'Published. Your team\'s ' + NAME[surface] + ' home is this one now.'
          : 'Couldn\'t publish the team home. Only an owner or admin can, and you need a connection.', r && r.saved ? 'success' : 'error');
        done(opts);
      });
    });
    d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (!busy) d.close(); } });
    d.addEventListener('close', function () { if (d.parentNode) d.parentNode.removeChild(d); if (openEl === d) openEl = null; });
    doc.body.appendChild(d);
    openEl = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('[data-oshw-pub="cancel"]');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  function lock(o) {
    var E = engine(), L = HL();
    if (!E || !L) return;
    var c = company();
    var next = c.homeLocked !== true;
    var any = ['phone', 'desk'].some(function (s) { return !!L.companyList(c.defaultWidgets, s); });
    Promise.resolve(E.saveCompany({ homeLocked: next })).then(function (r) { return r; }, function () { return null; }).then(function (r) {
      if (!(r && r.saved)) toast('Couldn\'t change the team lock. Only an owner or admin can, and you need a connection.', 'error');
      else if (!next) toast('Team homes unlocked. Members can change their own home again.');
      else toast(any ? 'Team homes locked. Members see the home you published.' : 'Team homes locked. Publish a home so your team has one to see.');
      done(o);
    });
  }

  W.NBDOSHomeCompany = { publish: publish, lock: lock };
})();
