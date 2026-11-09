/**
 * os/nearby.js — the NBD OS Nearby widget (2026-11-09, P3; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3 "Nearby").
 *
 * Your leads closest to where you are standing, by straight-line distance from
 * the location each lead already carries (os/nearby-logic.js does the math):
 *   S  the nearest one, a tap opens the map to it (or the record, with no address)
 *   M  the two nearest, each with Call and Navigate (when the lead has a phone /
 *      an address); the name opens the record; Update beside the title
 *   L  the four nearest, the same, when the fix was taken, and Yours / All you can see
 * "All you can see" is offered only when the leads the CRM already loaded for this
 * member hold a teammate's (their role already shows those in the CRM), on L
 * (M and S follow it; M's title says which); the choice lives in this page's
 * memory, never saved.
 *
 * Location: read ONLY when the member taps Find nearby (or Update), through one
 * navigator.geolocation.getCurrentPosition call. Never watched, never asked on its
 * own, never written to storage, Firestore or any request: the fix lives in this
 * file's memory for 10 minutes, then the widget asks for a tap again. A refused or
 * failed read shows a plain line. In the demo, demo-mode.js already answers with
 * the sample street, so the demo never asks the browser.
 *
 * Reads: no Firestore. The leads are window._leads (through home.js's kit, so a
 * focus mode's lens applies). "In a home" never paints it (it names customers).
 *
 * Loaded as the runtime ScriptLoader bundle 'osnearby' that os/home.js registers
 * (css/os/nearby.css, os/nearby-logic.js, this file). Every value escaped; no
 * style attributes, no inline handlers. home.js routes taps on [data-oshw-nb]
 * here and repaints on the nbd:os-nearby event.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  if (!W || W.NBDOSNearby) return;
  var NL = W.NBDOSNearbyLogic;
  if (!NL) return;

  var ROWS = { s: 1, m: 2, l: 4 };
  var GUARD_MS = 20000;   // longer than the 15 s the browser gets once permission is granted
  // fix: { lat, lng, at } in memory only; err: nearby-logic geoError; all: the "All you can see" view
  var S = { fix: null, asking: false, err: null, all: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function repaint() { try { W.dispatchEvent(new W.CustomEvent('nbd:os-nearby')); } catch (e) {} }
  function uid() { return String((W._user && W._user.uid) || ''); }
  function runnerVerbs() {
    var R = W.NBDRunner;
    return R && R._pure && typeof R._pure.leadVerbs === 'function' ? R._pure.leadVerbs : null;
  }
  function timeOf(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }

  /** After an answer lands: focus the nearest row (else the line, else the button), unless the member moved on. */
  function refocus(card) {
    if (!card || !card.querySelector) return;
    var a = W.document && W.document.activeElement;
    if (a && a !== W.document.body && a.isConnected !== false && !card.contains(a)) return;
    var f = card.querySelector('.os-nb-row') || card.querySelector('[data-oshw-nb-status]') || card.querySelector('[data-oshw-nb="find"]');
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }

  /** Ask for the position once. Success and failure both repaint; nothing is kept beyond S.fix. */
  function find(card) {
    if (S.asking) return;
    var g = W.navigator && W.navigator.geolocation;
    if (!g || typeof g.getCurrentPosition !== 'function') { S.err = NL.geoError({ kind: 'none' }); S.fix = null; repaint(); refocus(card); return; }
    S.asking = true; S.err = null;
    repaint();
    refocus(card);
    var done = false;
    // Firefox never calls back when the prompt is dismissed ("Not now" or X), and the spec's
    // timeout only counts once permission is granted: this guard ends the wait either way
    var guard = W.setTimeout(function () { fail({ code: 3 }); }, GUARD_MS);
    function settle() { done = true; try { W.clearTimeout(guard); } catch (e) {} }
    function ok(p) {
      if (done) return; settle();
      var c = p && p.coords ? NL.coordsOf({ lat: p.coords.latitude, lng: p.coords.longitude }) : null;
      S.asking = false;
      if (c) { S.fix = { lat: c.lat, lng: c.lng, at: Date.now() }; S.err = null; }
      else { S.fix = null; S.err = NL.geoError({ code: 2 }); }
      repaint();
      refocus(card);
    }
    function fail(e) {
      if (done) return; settle();
      S.asking = false; S.fix = null; S.err = NL.geoError(e);
      repaint();
      refocus(card);
    }
    try { g.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }); }
    catch (e) { fail(e); }
  }

  /** A tap on [data-oshw-nb] (home.js routes it). */
  function tap(btn) {
    var what = btn && btn.getAttribute ? btn.getAttribute('data-oshw-nb') : '';
    var card = btn && btn.closest ? btn.closest('.os-hw') : null;
    if (what === 'find') { find(card); return; }
    if (what !== 'mine' && what !== 'all') return;
    S.all = what === 'all';
    repaint();
    var f = card && card.querySelector('[data-oshw-nb="' + what + '"]');
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }

  function scopeBtns(others) {
    if (!others) return '';
    return '<div class="os-nb-scope" role="group" aria-label="Whose leads">' +
      '<button type="button" class="ui-btn-quiet os-hw-btn os-nb-chip" data-oshw-nb="mine" aria-pressed="' + (S.all ? 'false' : 'true') + '">Yours</button>' +
      '<button type="button" class="ui-btn-quiet os-hw-btn os-nb-chip" data-oshw-nb="all" aria-pressed="' + (S.all ? 'true' : 'false') + '">All you can see</button></div>';
  }
  function findBtn(label, quiet) {
    return '<button type="button" class="' + (quiet ? 'ui-btn-quiet' : 'btn btn-ghost') + ' os-hw-btn os-nb-find" data-oshw-nb="find">' + esc(label) + '</button>';
  }
  function status(t, cls) {
    return '<p class="' + esc(cls || 'os-hw-empty') + '" data-oshw-nb-status tabindex="-1">' + esc(t) + '</p>';
  }
  function verbLink(v, name) {
    var label = v.id === 'call' ? 'Call ' + name : 'Navigate to ' + name;
    return '<a class="ui-btn-quiet os-hw-btn os-nb-verb" href="' + esc(v.href) + '"' + (v.ext ? ' target="_blank" rel="noopener"' : '') +
      ' aria-label="' + esc(label) + '" data-nb-icon="' + (v.id === 'call' ? 'call' : 'nav') + '"><span class="os-nb-vt">' + esc(v.label) + '</span></a>';
  }
  function rowHtml(r, size) {
    var by = {};
    r.verbs.forEach(function (v) { by[v.id] = v; });
    var sub = [r.dist, r.street].filter(Boolean).join(' · ');
    var inner = '<span class="os-hw-row-name">' + esc(r.name) + '</span><span class="os-hw-row-sub">' + esc(sub) + '</span>';
    if (size === 's') {
      // S hides .os-hw-row-sub (home.css), so the distance rides its own line
      var go = by.nav || by.open;
      return '<a class="os-hw-row os-nb-row" href="' + esc(go.href) + '"' + (go.ext ? ' target="_blank" rel="noopener"' : '') +
        ' aria-label="' + esc((go.id === 'nav' ? 'Navigate to ' : 'Open ') + r.name + ', ' + r.dist) + '"><span class="os-hw-row-name">' + esc(r.name) + '</span>' +
        '<span class="os-nb-dist">' + esc(r.dist) + '</span></a>';
    }
    return '<li class="os-nb-item"><a class="os-hw-row os-nb-row" href="' + esc(by.open.href) + '">' + inner + '</a>' +
      (by.call ? verbLink(by.call, r.name) : '') + (by.nav ? verbLink(by.nav, r.name) : '') + '</li>';
  }

  function widget(size, cfg, kit) {
    var sz = ROWS[size] ? size : 'm';
    var leads = kit && typeof kit.leads === 'function' ? kit.leads() : null;
    var sc = leads ? NL.scope(leads, uid()) : null;
    var all = !!(S.all && sc && sc.others);
    if (S.fix && !NL.fresh(S.fix, Date.now())) S.fix = null;   // older than 10 minutes: ask again
    // S has room for the title line and one button only: its message takes the title's place
    // (the card itself stays labelled Nearby); M and L say whose leads they list
    var sMsg = sz === 's' ? (S.asking ? 'Finding you…' : S.err && !S.fix ? S.err.short : '') : '';
    var tag = sz !== 's' && sc && sc.others ? (all ? 'All' : 'Yours') : '';
    var title = sMsg ? '<h3 class="os-hw-title" data-oshw-nb-status tabindex="-1">' + esc(sMsg) + '</h3>'
      : '<h3 class="os-hw-title">Nearby' + (tag ? ' <span class="os-hw-count">' + esc(tag) + '</span>' : '') + '</h3>';
    var located = !!(leads && S.fix && !S.asking);
    // with results showing, M and L carry Update beside the title (S asks again once the fix is 10 minutes old)
    var head = located && sz !== 's' ? '<div class="os-nb-head">' + title + findBtn('Update', true) + '</div>' : title;
    if (!leads) return head + '<p class="os-hw-empty">Loading your leads…</p>';
    if (S.asking) return head + (sz === 's' ? '' : status('Finding where you are…'));
    if (!S.fix) {
      var out = head;
      if (S.err && sz !== 's') out += status(S.err.text, 'os-hw-empty os-nb-err');
      else if (sz !== 's') out += '<p class="os-hw-sub">Uses your location once, only when you tap. Never saved.</p>';
      return out + '<div class="os-nb-acts">' + findBtn(S.err && S.err.kind !== 'none' ? 'Try again' : 'Find nearby') + '</div>' + (sz === 'l' ? scopeBtns(sc.others) : '');
    }
    var res = NL.nearest(leads, S.fix, { uid: uid(), scope: all ? 'all' : 'mine', n: ROWS[sz], verbs: runnerVerbs() });
    if (!res.rows.length) {
      return head + status(all ? 'No lead you can see has a map location yet.' : 'None of your leads has a map location yet.') +
        (sz === 'l' ? scopeBtns(sc.others) : '');
    }
    if (sz === 's') return head + rowHtml(res.rows[0], 's');
    var h = head + '<ul class="os-nb-list">' + res.rows.map(function (r) { return rowHtml(r, sz); }).join('') + '</ul>';
    if (sz === 'l') {
      var at = timeOf(S.fix.at);
      h += '<p class="os-hw-sub os-nb-at">' + esc(at ? 'From where you were at ' + at : 'From where you were') + '</p>' + scopeBtns(sc.others);
    }
    return h;
  }

  W.NBDOSNearby = {
    widget: widget, tap: tap,
    // for tests and the demo check: what the widget holds (never a copy of the position)
    state: function () { return { asking: S.asking, err: S.err ? S.err.kind : '', located: !!S.fix, all: S.all }; },
  };
})();
