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
 *             admin: three number fields and Save. The sheet reads the goals
 *             doc again when it opens (one getDoc) and prefills from that,
 *             never from o.goals: the widget's answer can be 5 minutes old
 *             (another admin) or unknown (its read failed), and Save writes
 *             all three keys, so a stale prefill would overwrite real goals.
 *             Until that read lands, and for good if it fails, the fields
 *             and Save are disabled and the sheet says why. One setDoc of all three
 *             keys plus updatedAt (serverTimestamp) and updatedBy. A blank
 *             field is 0 (no goal); anything not a whole number 0-500, or
 *             text the number field could not parse (validity.badInput,
 *             which reports value ''), is refused on the field, nothing is written. On success the
 *             osdsbiz answer takes the goals just written (NBDOSDsBiz.saved)
 *             and `nbd:os-dsbiz` fires, so the widget repaints with them.
 *             not admin: the goals read-only, and who sets them.
 *
 * Pure (tests/nbd-os-goals-editor-2026-11-09.test.js): parseGoal(text),
 * payload(values, uid, stamp), rows(goals), prefill(data).
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

  /** The goals doc's data -> each field's prefill text: a whole goal 1-500, else '' (0, missing or junk = no goal). */
  function prefill(data) {
    var g = data && typeof data === 'object' ? data : {}, out = {};
    FIELDS.forEach(function (f) { var n = g[f.k]; out[f.k] = typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= MAX ? String(n) : ''; });
    return out;
  }

  var api = { FIELDS: FIELDS, MAX: MAX, parseGoal: parseGoal, payload: payload, rows: rows, prefill: prefill };
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
  /** The goals doc as it is now: { ok: true, data } (data null when there is no doc), or { ok: false }. */
  function readNow(cid) {
    if (!cid || typeof W.getDoc !== 'function' || typeof W.doc !== 'function' || !W.db) return Promise.resolve({ ok: false });
    return Promise.resolve().then(function () { return W.getDoc(W.doc(W.db, 'companies', cid, 'settings', 'goals')); }).then(function (snap) {
      var ex = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
      return { ok: true, data: ex && typeof snap.data === 'function' ? snap.data() : null };
    }, function () { return { ok: false }; });
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
    // admin: 'reading' (the open-time read is out), 'ready' (prefilled from it), 'failed' (no edit: the goals on file are unknown)
    function adminBody(state, vals) {
      var off = state === 'ready' ? '' : ' disabled';
      var msg = state === 'reading' ? 'Reading the goals on file…'
        : state === 'failed' ? 'Couldn\'t read the goals on file, so they can\'t be changed right now. Try again with a connection.' : '';
      return '<p class="os-hw-pub-p">Your team\'s daily targets. Daily Success shows doors done against the doors goal. Leave a box blank for no goal.</p>' +
        '<div class="os-hw-goals-f">' + FIELDS.map(function (f) {
          var v = vals && typeof vals[f.k] === 'string' ? vals[f.k] : '';
          return '<label class="os-hw-goals-row"><span class="os-hw-goals-l">' + esc(f.label) + '</span>' +
            '<input class="os-hw-goals-in" type="number" inputmode="numeric" min="0" max="' + MAX + '" step="1" name="' + esc(f.k) + '" data-oshw-goal="' + esc(f.k) + '" value="' + esc(v) + '"' + off + '></label>';
        }).join('') + '</div>' +
        '<p class="os-hw-pub-p os-hw-pub-status" role="status">' + esc(msg) + '</p>' +
        '<div class="os-hw-pub-row">' +
          '<button type="button" class="btn btn-ghost os-hw-pub-btn" data-oshw-goals="cancel">Cancel</button>' +
          '<button type="button" class="btn btn-orange os-hw-pub-btn" data-oshw-goals="save"' + off + '>Save goals</button>' +
        '</div>';
    }
    var ready = false;
    var title = '<h2 class="os-hw-add-title" id="oshwGoalsTitle">' + (admin ? 'Set daily goals' : 'Team daily goals') + '</h2>';
    if (admin) {
      body = adminBody('reading', null);
    } else {
      var list = rows(g);
      body = (list.length
        ? '<ul class="os-hw-goals-list">' + list.map(function (r) { return '<li><span class="os-hw-goals-l">' + esc(r.label) + '</span><span class="os-hw-goals-n ui-num">' + esc(String(r.n)) + '</span></li>'; }).join('') + '</ul>'
        : '<p class="os-hw-pub-p">Your team has no daily goals set.</p>') +
        '<p class="os-hw-pub-p">Your owner or admin sets these.</p>' +
        '<div class="os-hw-pub-row"><button type="button" class="btn btn-ghost os-hw-pub-btn" data-oshw-goals="cancel">Close</button></div>';
    }
    d.innerHTML = title + body;
    var busy = false;
    function status(t) { var st = d.querySelector('.os-hw-pub-status'); if (st) st.textContent = t; }
    function save() {
      if (!ready) return;   // the goals on file are not known yet (or could not be read): writing would overwrite them
      var vals = {}, bad = null;
      FIELDS.forEach(function (f) {
        var inp = d.querySelector('[data-oshw-goal="' + f.k + '"]');
        // a number field holding '1e', '-' or 'e' reports value '' (badInput): refused, never read as blank = no goal
        var n = inp && inp.validity && inp.validity.badInput ? null : parseGoal(inp ? inp.value : '');
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
        // the widget's answer takes the goals just written (no blank repaint while a re-read is out)
        if (B && typeof B.saved === 'function') { try { B.saved(String(opts.uid || ''), data, Date.now()); } catch (e) {} }
        else if (B && typeof B.reset === 'function') { try { B.reset(); } catch (e) {} }
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
    function focusFirst() {
      var live = Array.prototype.filter.call(d.querySelectorAll('.os-hw-goals-in'), function (i) { return !i.hasAttribute('disabled'); });
      var first = live[0] || d.querySelector('[data-oshw-goals="cancel"]');
      if (first) { try { first.focus(); } catch (e) {} }
    }
    focusFirst();
    if (admin) {
      readNow(String(opts.companyId || '')).then(function (r) {
        if (openEl !== d) return;   // closed (or replaced) while the read was out
        ready = r.ok === true;
        d.innerHTML = title + adminBody(ready ? 'ready' : 'failed', ready ? prefill(r.data) : null);
        focusFirst();
      });
    }
  }

  api.open = open;
  W.NBDOSDsGoals = api;
})(typeof window !== 'undefined' ? window : null);
