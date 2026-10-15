/**
 * visit-unfiled-today.js - ONE "N unfiled visits" row on Today
 * (window.NBDVisitUnfiledToday). A visit recording still on no customer after
 * 24 hours is something Jo said he would not forget; this is the nudge.
 *
 *   documentation/projects/VISIT-CAPTURE-PR2-2026-10-13.md
 *
 * Deliberately a NEW file that touches no Today code: it listens for the
 * 'nbd:today-rendered' event today-home.js already dispatches and inserts one
 * section after the Today header. It is loaded lazily by
 * visit-recorder-launcher.js (the same way the recorder is), so it costs no
 * boot tag. Counted once: one row, however many visits (a recording that hit
 * the 60 minute cap and its part 2 are one visit).
 *
 * Buttons: Attach (opens the Unfiled visits sheet, one tap per visit),
 * Keep (hide the row until tomorrow; it returns sooner if more pile up),
 * Discard (arm, then delete them all - audio included).
 * All DOM is built with textContent; nothing here uses innerHTML.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NBDVisitUnfiledToday = api;
  if (api && typeof api.boot === 'function' && root && root.document) api.boot();
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  var AGE_MS = 24 * 3600 * 1000;
  var KEEP_KEY = 'nbd_vr_today_keep';
  var DEAD = { discarded: 1, skipped: 1, quarantined_consent: 1, purge_pending: 1 };

  /**
   * "Unfiled" means ONE thing here and on the Home count: NBDVisitRecorderLogic.isUnfiled
   * (this copy is only for when the logic module is not loaded, e.g. the node test, which
   * checks the two agree). This row adds "and over a day old", and its words say so
   * (2026-10-15: the Home count and this row disagreed with no explanation).
   */
  function fallbackIsUnfiled(r) {
    if (!r || !r.id || r.leadId) return false;
    if (r.status === 'discarded' || r.status === 'recording') return false;
    return !(r.pipelineStatus && DEAD[r.pipelineStatus]);
  }
  function isUnfiled(r) {
    var L = root && root.NBDVisitRecorderLogic;
    return L && typeof L.isUnfiled === 'function' ? L.isUnfiled(r) : fallbackIsUnfiled(r);
  }

  /**
   * Pure: which unattached visits are unfiled and old enough, counted once.
   * rows are visit_captures docs and/or local rows (same field names).
   */
  function summarize(rows, nowMs) {
    var list = (Array.isArray(rows) ? rows : []).filter(function (r) {
      if (!isUnfiled(r)) return false;
      var t = Number(r.startedAtMs) || 0;
      return t > 0 && nowMs - t >= AGE_MS;
    });
    var ids = {};
    list.forEach(function (r) { ids[r.id] = true; });
    // part 2 of a capped recording is the same visit as part 1
    var roots = list.filter(function (r) { return !r.partOf || !ids[r.partOf]; });
    var seen = {};
    var uniq = roots.filter(function (r) { if (seen[r.id]) return false; seen[r.id] = true; return true; });
    var oldest = 0;
    list.forEach(function (r) { var t = Number(r.startedAtMs) || 0; if (!oldest || t < oldest) oldest = t; });
    return { count: uniq.length, ids: list.map(function (r) { return r.id; }), oldestMs: oldest };
  }
  // "over a day": this row only counts visits unfiled for 24 h; the Home "Unfiled visits (N)" counts all of them.
  function title(n) { return n === 1 ? '1 visit unfiled for over a day' : n + ' visits unfiled for over a day'; }
  function ageWords(oldestMs, nowMs) {
    var d = Math.floor((nowMs - oldestMs) / 86400000);
    if (d < 1) return 'since yesterday';
    return d === 1 ? 'the oldest is from yesterday' : 'the oldest is ' + d + ' days old';
  }
  /** Keep hides the row until tomorrow, unless more visits have piled up since. */
  function keepHides(keep, count, nowMs) {
    return !!(keep && Number(keep.until) > nowMs && Number(keep.count) >= count);
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  var doc = root && root.document;
  var armed = false;
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (_) {} }
  function readKeep() { try { return JSON.parse(lsGet(KEEP_KEY) || 'null'); } catch (_) { return null; } }
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function allRows() {
    var R = root.NBDVisitRecorder;
    if (!R || typeof R.list !== 'function') return Promise.resolve([]);
    // listAll brings the phone's customer in line with the server's first (a refused attach
    // the server took back off is unfiled again, not hidden as "attached").
    var both = typeof R.listAll === 'function'
      ? R.listAll().then(function (r) { return [r.local, r.remote]; })
      : Promise.all([R.list(), R.listRemote ? R.listRemote() : Promise.resolve([])]);
    return both.then(function (res) {
      var local = res[0] || [], remote = res[1] || [];
      var have = {};
      local.forEach(function (r) { have[r.id] = true; });
      // another device's visit counts here once it is uploaded (the same rule as the Home count)
      return local.concat(remote.filter(function (r) { return !have[r.id] && r.status === 'uploaded'; }));
    }).catch(function () { return []; });
  }
  function removeRow() {
    var old = doc.querySelectorAll('[data-vr-today]');
    for (var i = 0; i < old.length; i++) { try { old[i].remove(); } catch (_) {} }
  }
  function paint() {
    var host = doc.getElementById('todayPlan');
    if (!host) return Promise.resolve();
    return allRows().then(function (rows) {
      var now = Date.now();
      var s = summarize(rows, now);
      removeRow();
      armed = false;
      if (!s.count) return;
      if (keepHides(readKeep(), s.count, now)) return;
      var sec = el('div', 'tp-sec');
      sec.setAttribute('data-vr-today', '1');
      sec.setAttribute('data-tp-sec', 'unfiled-visits');
      var hd = el('div', 'tp-sec-hd');
      var t = el('span', 'tp-sec-title', 'Visit recordings ');
      t.appendChild(el('span', 'tp-count', String(s.count)));
      hd.appendChild(t);
      sec.appendChild(hd);
      var row = el('div', 'tp-row');
      row.setAttribute('data-tp-row', 'visits:unfiled');
      var main = el('div', 'tp-main');
      main.appendChild(el('div', 'tp-name', title(s.count)));
      main.appendChild(el('div', 'tp-sub', 'Not on any customer yet - ' + ageWords(s.oldestMs, now) + '. Nothing is filed until you pick.'));
      row.appendChild(main);
      var acts = el('div', 'tp-acts');
      function btn(label, extra, fn) {
        var b = el('button', 'tp-btn' + (extra ? ' ' + extra : ''), label);
        b.type = 'button';
        b.addEventListener('click', fn);
        return b;
      }
      acts.appendChild(btn('Attach', 'tp-go', function () {
        var L = root.NBDVisitRecorderLauncher;
        if (L && typeof L.openUnfiled === 'function') L.openUnfiled();
        else if (root.NBDVisitRecorderUI) root.NBDVisitRecorderUI.openUnfiled();
      }));
      acts.appendChild(btn('Keep', '', function () {
        lsSet(KEEP_KEY, JSON.stringify({ until: Date.now() + AGE_MS, count: s.count }));
        removeRow();
      }));
      var del = btn('Discard', '', function () {
        if (!armed) { armed = true; del.textContent = 'Tap again to delete ' + s.count; return; }
        del.disabled = true;
        var R = root.NBDVisitRecorder;
        var chain = Promise.resolve();
        s.ids.forEach(function (id) { chain = chain.then(function () { return R.discard(id); }).catch(function () {}); });
        chain.then(function () { if (R.refreshCounters) R.refreshCounters(); paint(); });
      });
      acts.appendChild(del);
      row.appendChild(acts);
      sec.appendChild(row);
      var hdr = host.querySelector('.tp-hd');
      if (hdr && hdr.nextSibling) host.insertBefore(sec, hdr.nextSibling); else host.appendChild(sec);
    });
  }

  var started = false;
  function boot() {
    if (started || !doc) return;
    started = true;
    root.addEventListener('nbd:today-rendered', function () { paint(); });
    // Today may already be on screen by the time this lazy file arrives.
    var host = doc.getElementById('todayPlan');
    if (host && host.getAttribute('data-tp-state') === 'ready') paint();
  }

  return { summarize: summarize, title: title, ageWords: ageWords, keepHides: keepHides, paint: paint, boot: boot, AGE_MS: AGE_MS, fallbackIsUnfiled: fallbackIsUnfiled };
});
