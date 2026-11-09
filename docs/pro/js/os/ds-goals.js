/**
 * os/ds-goals.js — the NBD OS Daily Success goals sheet (2026-11-09, P2, the
 * P1 follow-up "goals have no editor"; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.1).
 *
 * The team's daily targets, companies/{companyId}/settings/goals
 * { callsPerDay, followUpsPerDay, doorsPerDay }, each a whole number 0-500
 * (0 = no goal). firestore.rules "DAILY GOALS" is the gate: the whole tenant
 * reads it; only the solo owner or that company's company_admin writes it,
 * and updatedBy must be the writer. This sheet is that write's one caller.
 *
 *   open(o)   a native <dialog>. o: { admin, goals (cleanGoals() or null),
 *             companyId, uid, returnFocus, after() }.
 *             admin: three number fields and Save. One setDoc of all three
 *             keys plus updatedAt (serverTimestamp) and updatedBy. A blank
 *             field is 0 (no goal); anything not a whole number 0-500 is
 *             refused on the field, nothing is written. On success the
 *             osdsbiz cache is dropped and `nbd:os-dsbiz` fires, so the
 *             widget reads the goals again.
 *             not admin: the goals read-only, and who sets them.
 *
 * Pure (tests/nbd-os-goals-editor-2026-11-09.test.js): parseGoal(text),
 * payload(values, uid, stamp), rows(goals).
 *
 * Loaded on the first tap as the runtime ScriptLoader bundle `osdsgoals`
 * (os/home.js registers it), never at boot. Every value goes into the DOM
 * escaped; no inline handlers, no style attributes.
 */
(function (root) {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var FIELDS = [
    { k: 'callsPerDay', label: 'Calls a day' },
    { k: 'followUpsPerDay', label: 'Follow-ups a day' },
    { k: 'doorsPerDay', label: 'Doors a day' },
  ];
  var MAX = 500;

  /** A field's text -> a whole number 0-500 (blank = 0, no goal), or null when it is not one. */
  function parseGoal(t) {
    var s = String(t == null ? '' : t).trim();
    if (!s) return 0;
    if (!/^\d{1,3}$/.test(s)) return null;
    var n = Number(s);
    return n <= MAX ? n : null;
  }
  /** The doc to write: all three goals, the stamp, the writer. null when any value is not a goal. */
  function payload(values, uid, stamp) {
    var v = values || {}, out = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var n = v[FIELDS[i].k];
      if (typeof n !== 'number' || Math.floor(n) !== n || n < 0 || n > MAX) return null;
      out[FIELDS[i].k] = n;
    }
    if (typeof uid !== 'string' || !uid) return null;
    out.updatedAt = stamp;
    out.updatedBy = uid;
    return out;
  }
  /** The goals as read-only lines, only the ones that are set: [{ label, n }]. */
  function rows(goals) {
    var g = goals && typeof goals === 'object' ? goals : {};
    return FIELDS.filter(function (f) { return typeof g[f.k] === 'number' && g[f.k] >= 1 && g[f.k] <= MAX && Math.floor(g[f.k]) === g[f.k]; })
      .map(function (f) { return { label: f.label, n: g[f.k] }; });
  }

  var api = { FIELDS: FIELDS, MAX: MAX, parseGoal: parseGoal, payload: payload, rows: rows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!W || !W.document) return;
  var doc = W.document;
  var openEl = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    if (typeof W.showToast === 'function') { try { W.showToast(msg, kind || 'success'); } catch (e) {} }
  }
  function outside(d, ev) {
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }
  function write(cid, data) {
    if (!cid || typeof W.setDoc !== 'function' || typeof W.doc !== 'function' || !W.db) return Promise.reject(new Error('no firestore'));
    return Promise.resolve().then(function () { return W.setDoc(W.doc(W.db, 'companies', cid, 'settings', 'goals'), data); });
  }

  function open(o) {
    var opts = o || {};
    var admin = opts.admin === true;
    var g = opts.goals && typeof opts.goals === 'object' ? opts.goals : {};
    if (openEl && openEl.parentNode) openEl.parentNode.removeChild(openEl);
    var d = doc.createElement('dialog');
    d.className = 'os-hw-add os-hw-pub os-hw-goals';
    d.setAttribute('aria-labelledby', 'oshwGoalsTitle');
    var body;
    if (admin) {
      body = '<p class="os-hw-pub-p">Your team\'s daily targets. Daily Success shows doors done against the doors goal. Leave a box blank for no goal.</p>' +
        '<div class="os-hw-goals-f">' + FIELDS.map(function (f) {
          var v = typeof g[f.k] === 'number' ? String(g[f.k]) : '';
          return '<label class="os-hw-goals-row"><span class="os-hw-goals-l">' + esc(f.label) + '</span>' +
            '<input class="os-hw-goals-in" type="number" inputmode="numeric" min="0" max="' + MAX + '" step="1" name="' + esc(f.k) + '" data-oshw-goal="' + esc(f.k) + '" value="' + esc(v) + '"></label>';
        }).join('') + '</div>' +
        '<p class="os-hw-pub-p os-hw-pub-status" role="status"></p>' +
        '<div class="os-hw-pub-row">' +
          '<button type="button" class="btn btn-ghost os-hw-pub-btn" data-oshw-goals="cancel">Cancel</button>' +
          '<button type="button" class="btn btn-orange os-hw-pub-btn" data-oshw-goals="save">Save goals</button>' +
        '</div>';
    } else {
      var list = rows(g);
      body = (list.length
        ? '<ul class="os-hw-goals-list">' + list.map(function (r) { return '<li><span class="os-hw-goals-l">' + esc(r.label) + '</span><span class="os-hw-goals-n ui-num">' + esc(String(r.n)) + '</span></li>'; }).join('') + '</ul>'
        : '<p class="os-hw-pub-p">Your team has no daily goals set.</p>') +
        '<p class="os-hw-pub-p">Your owner or admin sets these.</p>' +
        '<div class="os-hw-pub-row"><button type="button" class="btn btn-ghost os-hw-pub-btn" data-oshw-goals="cancel">Close</button></div>';
    }
    d.innerHTML = '<h2 class="os-hw-add-title" id="oshwGoalsTitle">' + (admin ? 'Set daily goals' : 'Team daily goals') + '</h2>' + body;
    var busy = false;
    function status(t) { var st = d.querySelector('.os-hw-pub-status'); if (st) st.textContent = t; }
    function save() {
      var vals = {}, bad = null;
      FIELDS.forEach(function (f) {
        var inp = d.querySelector('[data-oshw-goal="' + f.k + '"]');
        var n = parseGoal(inp ? inp.value : '');
        if (inp) { if (n === null) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
        if (n === null && !bad) bad = { f: f, el: inp };
        vals[f.k] = n;
      });
      if (bad) {
        status(bad.f.label + ': a whole number from 0 to ' + MAX + '.');
        if (bad.el) { try { bad.el.focus(); } catch (e) {} }
        return;
      }
      var data = payload(vals, String(opts.uid || ''), typeof W.serverTimestamp === 'function' ? W.serverTimestamp() : null);
      if (!data || !data.updatedAt) { status('Couldn\'t save the goals here. Try again from the dashboard.'); return; }
      busy = true;
      status('Saving…');
      write(String(opts.companyId || ''), data).then(function () { return true; }, function () { return false; }).then(function (okd) {
        busy = false;
        if (!okd) { status('Couldn\'t save the goals. Only an owner or admin can, and you need a connection.'); return; }
        var B = W.NBDOSDsBiz;
        if (B && typeof B.reset === 'function') { try { B.reset(); } catch (e) {} }
        d.close();
        toast('Daily goals saved.');
        try { W.dispatchEvent(new W.CustomEvent('nbd:os-dsbiz')); } catch (e) {}
      });
    }
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest || busy) return;
      if (t.closest('[data-oshw-goals="cancel"]') || (t === d && outside(d, ev))) { d.close(); return; }
      if (t.closest('[data-oshw-goals="save"]')) save();
    });
    d.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (!busy) d.close(); return; }
      if (ev.key === 'Enter' && admin && ev.target && ev.target.matches && ev.target.matches('.os-hw-goals-in')) { ev.preventDefault(); if (!busy) save(); }
    });
    d.addEventListener('close', function () {
      if (d.parentNode) d.parentNode.removeChild(d);
      if (openEl === d) openEl = null;
      if (opts.returnFocus && doc.contains && doc.contains(opts.returnFocus)) { try { opts.returnFocus.focus(); } catch (e) {} }
      if (typeof opts.after === 'function') { try { opts.after(); } catch (e) {} }
    });
    doc.body.appendChild(d);
    openEl = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('.os-hw-goals-in') || d.querySelector('[data-oshw-goals="cancel"]');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  api.open = open;
  W.NBDOSDsGoals = api;
})(typeof window !== 'undefined' ? window : null);
