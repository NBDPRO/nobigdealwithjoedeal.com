/**
 * os/focus.js — the NBD OS knock-block focus session, browser half (2026-11-09, P3;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #10, ChromeOS Focus).
 *
 * The "Knock block" home widget. The rep starts a 30, 60 or 90 minute canvassing
 * block with one tap; nothing starts one by itself. While it runs:
 *   - Do Not Disturb is on (system.js setDnd): routine toasts wait in the
 *     Notification Center. Turned on only if it was off; at the end it is turned
 *     back off only if this block turned it on, it is still on, and no privacy
 *     mode ("In a home", os/acts.js) holds it (os/focus-logic.js restore).
 *   - a calm countdown in whole minutes (no seconds; the home's 30 s tick repaints
 *     it when the minute changes) and a native <progress> of the time used.
 *   - the doors knocked in this block: os/ds-business.js countKnocks, the same
 *     getCountFromServer on the knocks [userId, createdAt] index that counts
 *     Daily Success's doors, over the block's window. One count when the block
 *     starts, one after a reload, one on each nbd:knocks-changed (the D2D tracker
 *     fires it when a knock is saved, deleted or undone; at most one count out at a
 *     time, a knock meanwhile asks for one more), and one final count at the end.
 *     Never on a timer. A count that fails shows no number.
 *   - against the doors floor: the company's doorsPerDay (Daily Success goals,
 *     os/ds-business.js current(), its own 5-minute cache), Mon-Sat only, asked
 *     when the block starts, resumes and ends, never on a paint.
 * At the end (time up, or End): "Block done: N doors in M min" and the floor, in
 * the widget until Done, and once as a toast.
 *
 * Survives a reload: the record (start, end, DND memo, last count, floor) is this
 * device's localStorage nbd_os_focus (an nbd_ key, so sign-out wipes it). os/home.js
 * loads this bundle when a home mounts with a record waiting, so a block whose
 * widget was removed still ends and restores DND. One timer: a single timeout at
 * the block's end (and a check when the page shows again), never an interval.
 *
 * The OS writes no CRM data: nothing here writes Firestore. Every value goes into
 * the DOM escaped; no inline handlers, no style attributes, no motion.
 *
 * Loaded as the runtime ScriptLoader bundle `osfocus` (css/os/focus.css,
 * os/ds-business.js, os/focus-logic.js, this file), registered and loaded by
 * os/home.js. window.NBDOSFocus: { widget(size, cfg, kit), tap(what, el), key(),
 * resume() }.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSFocus) return;
  var FL = W.NBDOSFocusLogic;
  if (!FL) return;

  var EVENT = 'nbd:os-focus';   // os/home.js repaints its widgets on it
  var ACTS_DND = 'nbd_os_acts_dnd';   // os/acts.js: a privacy mode turned DND on

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safe(fn) { try { return fn(); } catch (e) { try { console.warn('[os-focus]', e && e.message); } catch (_) {} return undefined; } }
  function lsGet(k) { try { return W.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) W.localStorage.removeItem(k); else W.localStorage.setItem(k, v); } catch (e) {} }
  function uid() { return String((W._user && W._user.uid) || ''); }
  function cid() { var c = W._userClaims || {}; return String(c.companyId || uid()); }
  function notify() { try { W.dispatchEvent(new W.CustomEvent(EVENT)); } catch (e) {} }
  function toast(m, t) { if (typeof W.showToast === 'function') safe(function () { W.showToast(m, t || 'info'); }); }

  var live = null;
  function say(msg) {
    if (!live) {
      live = doc.createElement('p');
      live.className = 'os-fb-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      doc.body.appendChild(live);
    }
    live.textContent = '';
    live.textContent = msg;
  }

  // ── the record ─────────────────────────────────────────────
  function load() { var u = uid(); return u ? FL.parse(lsGet(FL.KEY), u, Date.now()) : null; }
  function save(r) { lsSet(FL.KEY, r ? JSON.stringify(r) : null); }
  function same(a, b) { return !!a && !!b && a.uid === b.uid && a.start === b.start; }

  // ── Do Not Disturb (system.js) ─────────────────────────────
  function sys() { var O = W.NBDOS; return O && typeof O.setDnd === 'function' && typeof O.isDnd === 'function' ? O : null; }
  function held() {   // a privacy mode holds DND (os/acts.js)
    var A = W.NBDOSActs;
    return lsGet(ACTS_DND) === '1' || !!(A && typeof A.privacy === 'function' && safe(A.privacy) === true);
  }
  /** Put DND back once the block is over. No system layer yet: try again on the next paint. */
  function restoreDnd(r) {
    if (!r || r.dnd === 'done') return r;
    var O = sys();
    if (!O) return r.dnd === 'mine' ? r : Object.assign({}, r, { dnd: 'done' });
    if (FL.restore(r, safe(O.isDnd) === true, held()) === 'off') safe(function () { O.setDnd(false); });
    return Object.assign({}, r, { dnd: 'done' });
  }

  // ── counting the block's doors ─────────────────────────────
  var busy = false, again = false, failedAt = 0;   // failedAt: the block (start) whose last count failed
  function count() {
    var r = load(), B = W.NBDOSDsBiz;
    if (!r) return;
    if (busy) { again = true; return; }
    if (!B || typeof B.countKnocks !== 'function') { failedAt = r.start; notify(); return; }
    busy = true;
    var w = FL.span(r);
    Promise.resolve().then(function () { return B.countKnocks(r.uid, w.from, w.to); }).then(function (n) { return n; }, function () { return undefined; })
      .then(function (n) {
        var now = load();
        if (same(now, r)) {
          var next = FL.withCount(now, n);
          if (next !== now) { save(next); failedAt = 0; } else failedAt = r.start;
        }
        busy = false;
        notify();
        if (again) { again = false; var cur = load(); if (cur) count(); }
      });
  }
  function onKnock() {
    var r = load();
    if (r && FL.phase(r, Date.now()) === 'running') count();
  }

  // ── the floor: Daily Success's doors goal, asked at start, resume and end ──
  var nav = null, wantFloor = null;   // nav: the home's navHidden (from the last paint); wantFloor: the block asking
  function bizEnv() { return { uid: uid(), companyId: cid(), doors: nav ? safe(function () { return nav('d2d'); }) === false : true, now: Date.now() }; }
  function askFloor(r) {
    var B = W.NBDOSDsBiz;
    if (!r || !B || typeof B.current !== 'function') return;
    var x = safe(function () { return B.current(bizEnv()); });
    if (x) { setFloor(r, x.goals); wantFloor = null; } else wantFloor = r.start;   // the answer fires nbd:os-dsbiz
  }
  function setFloor(r, goals) {
    var cur = load();
    if (!same(cur, r)) return;
    var f = FL.floorOn(goals, cur.start);
    if (f !== (cur.floor == null ? null : cur.floor)) { save(FL.withFloor(cur, f)); notify(); }
  }
  function onBiz() {
    if (wantFloor == null) return;
    var r = load(), B = W.NBDOSDsBiz;
    if (!r || r.start !== wantFloor || !B) { wantFloor = null; return; }
    wantFloor = null;
    var x = safe(function () { return B.current(bizEnv()); });
    if (x) setFloor(r, x.goals);
  }

  // ── start, end, resume ─────────────────────────────────────
  var endT = 0;
  function arm(r) {
    W.clearTimeout(endT);
    endT = 0;
    if (!r || FL.phase(r, Date.now()) !== 'running') return;
    endT = W.setTimeout(check, Math.max(0, r.end - Date.now()) + 250);
  }
  function check() {
    var r = load();
    if (r && FL.phase(r, Date.now()) === 'over' && r.endedAt == null) end(false);
    else if (r && r.endedAt != null && r.dnd !== 'done') { save(restoreDnd(r)); }
    else arm(r);
  }
  function start(mins, from) {
    var u = uid(), cur = load();
    if (!u || (cur && FL.phase(cur, Date.now()) === 'running')) return;
    var O = sys();
    var r = FL.begin({ uid: u, now: Date.now(), mins: mins, dndOn: O ? safe(O.isDnd) === true : false, dndAvail: !!O });
    if (!r) return;
    failedAt = 0;
    save(r);
    if (r.dnd === 'mine') safe(function () { O.setDnd(true); });
    arm(r);
    count();
    askFloor(r);
    notify();
    say('Knock block started: ' + mins + ' minutes.' + (r.dnd === 'none' ? '' : ' Do Not Disturb is on.'));
    refocus(from, 'end');
  }
  function end(early, from) {
    var r = load();
    if (!r || r.endedAt != null) return;
    W.clearTimeout(endT);
    endT = 0;
    r = restoreDnd(FL.finish(r, Date.now()));
    save(r);
    count();   // the final count over the whole block
    askFloor(r);
    notify();
    var v = FL.view(r, Date.now());
    say(v.done + (v.floor ? '. ' + v.floor : ''));
    if (!early) toast(v.done, 'success');
    if (from) refocus(from, 'done');
  }
  function done(from) {
    var r = load();
    if (r && FL.phase(r, Date.now()) === 'running') return;
    if (r) save(restoreDnd(r));
    save(null);
    failedAt = 0;
    notify();
    refocus(from, 'start:60');
  }
  /** After the repaint, focus the new state's button in the same card (the tapped one was replaced). */
  function refocus(card, what) {
    var b = card && card.querySelector ? card.querySelector('[data-oshw-focus="' + what + '"]') : null;
    if (b) safe(function () { b.focus({ preventScroll: true }); });
  }
  var resumed = false;
  /** A home mounted with a record waiting (os/home.js), or this bundle just loaded. */
  function resume() {
    if (!uid()) return;   // not signed in yet: the next paint asks again
    resumed = true;
    var r = load();
    if (!r) { if (lsGet(FL.KEY)) save(null); return; }   // another account's, broken or stale
    if (FL.phase(r, Date.now()) === 'over' && r.endedAt == null) { end(false); return; }
    if (r.endedAt != null) { if (r.dnd !== 'done') save(restoreDnd(r)); return; }
    arm(r);
    count();
    askFloor(r);
  }

  // ── the widget ─────────────────────────────────────────────
  var TITLE = '<h3 class="os-hw-title">Knock block</h3>';
  function timeOf(ms) { return safe(function () { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }) || ''; }
  function startBtns(size) {
    return '<div class="os-fb-go" role="group" aria-label="Start a knock block">' + FL.LENGTHS.map(function (m) {
      return '<button type="button" class="btn btn-ghost os-hw-btn os-fb-len" data-oshw-focus="start:' + m + '" aria-label="' +
        esc('Start a ' + m + '-minute knock block') + '">' + esc(size === 's' ? String(m) : m + ' min') + '</button>';
    }).join('') + '</div>';
  }
  function widget(size, cfg, kit) {
    if (kit && typeof kit.navHidden === 'function') nav = kit.navHidden;
    if (!uid()) return TITLE + '<p class="os-hw-empty">Getting ready…</p>';
    if (!resumed) { resumed = true; W.setTimeout(resume, 0); }   // after this paint: resume may repaint
    var r = load(), now = Date.now();
    if (r && FL.phase(r, now) === 'over' && r.endedAt == null) { W.setTimeout(check, 0); }   // the end timer was throttled: end it now
    var v = FL.view(r, now);
    if (v.phase === 'none') {
      return TITLE + (size === 's' ? '' : '<p class="os-hw-empty">Do Not Disturb on and your doors counted, for one block.</p>') + startBtns(size);
    }
    var failed = !!r && failedAt === r.start;
    if (v.phase === 'running') {
      var h = TITLE + '<p class="os-fb-left ui-num">' + esc(v.left) + '</p>' +
        '<progress class="os-fb-bar" max="100" value="' + esc(String(v.pct)) + '" aria-label="' + esc('Block ' + v.pct + '% done') + '"></progress>';
      if (v.doors) h += '<p class="os-fb-doors">' + esc(v.doors) + '</p>';
      else if (failed) h += '<p class="os-hw-empty">Couldn\'t count doors yet.</p>';
      if (size !== 's') {
        if (v.floor) h += '<p class="os-hw-sub">' + esc(v.floor) + '</p>';
        h += '<p class="os-hw-sub">' + esc('Ends ' + timeOf(r.end) + (r.dnd === 'mine' || r.dnd === 'kept' ? ' · Do Not Disturb on' : '')) + '</p>';
      }
      return h + '<button type="button" class="ui-btn-quiet os-hw-btn os-fb-end" data-oshw-focus="end" aria-label="End the knock block now">End block</button>';
    }
    var o = TITLE + '<p class="os-fb-done">' + esc(v.done) + '</p>';
    if (v.floor && size !== 's') o += '<p class="os-hw-sub">' + esc(v.floor) + '</p>';
    if (failed && r.doors == null) o += '<button type="button" class="ui-btn-quiet os-hw-btn os-fb-recount" data-oshw-focus="recount">Count again</button>';
    return o + '<button type="button" class="btn btn-ghost os-hw-btn os-fb-ok" data-oshw-focus="done">Done</button>';
  }
  /** The home's tick repaints the widget when this changes: the minute, the phase, the count. */
  function key() {
    var r = load();
    if (!r) return 'none';
    var now = Date.now();
    return FL.phase(r, now) + ':' + FL.minsLeft(r, now) + ':' + (r.doors == null ? '' : r.doors);
  }
  function tap(what, el) {
    var card = el && el.closest ? el.closest('[data-oshw]') : null;   // before the repaint replaces el
    var m = /^start:(\d+)$/.exec(String(what || ''));
    if (m) { start(Number(m[1]), card); return; }
    if (what === 'end') end(true, card);
    else if (what === 'done') done(card);
    else if (what === 'recount') count();
  }

  W.addEventListener('nbd:knocks-changed', onKnock);
  W.addEventListener('nbd:os-dsbiz', onBiz);
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) check(); });

  W.NBDOSFocus = { widget: widget, tap: tap, key: key, resume: resume };
  resume();
})();
