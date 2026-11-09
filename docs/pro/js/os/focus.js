/**
 * os/focus.js — the NBD OS knock-block focus session, browser half (2026-11-09, P3;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #10, ChromeOS Focus).
 *
 * The "Knock block" home widget. The rep starts a 30, 60 or 90 minute canvassing
 * block with one tap; nothing starts one by itself. While it runs:
 *   - Do Not Disturb is on (system.js setDnd): routine toasts wait in the
 *     Notification Center. Turned on only if it was off; at the end it is turned
 *     back off only if this block turned it on, it is still on, and no privacy
 *     mode ("In a home", os/acts.js) holds it (os/focus-logic.js restore). If a
 *     mode holds it, the block hands it to the mode (acts.js's memo
 *     nbd_os_acts_dnd), so leaving the mode turns it off.
 *     A switch by hand during the block is not tracked: if the rep turns DND
 *     off, the end leaves it off; off and back on, the end still turns it off
 *     (the block turned it on, and the rep was in the block when they turned
 *     it back on).
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
 * device's localStorage nbd_os_focus (an nbd_ key, so sign-out wipes it). A block that
 * turned DND on also writes nbd_os_focus_dnd (the uid) until DND is put back: it
 * outlives the record, so a record dropped as over 12 h old, or cleared by Done before
 * the system layer loaded, still turns DND back off. os/home.js
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
  var OWE = 'nbd_os_focus_dnd';   // the uid whose block turned DND on and has not put it back (outlives the record)
  var ACTS_DND = 'nbd_os_acts_dnd';   // os/acts.js: a privacy mode owns DND (turned it on, or a block handed it over)

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
  /** Put back the DND a block turned on. False when there is no system layer yet (the memo waits). */
  function putBack() {
    var O = sys();
    if (!O) return false;
    var how = FL.restore({ dnd: 'mine' }, safe(O.isDnd) === true, held());
    if (how === 'off') safe(function () { O.setDnd(false); });
    else if (how === 'hand') lsSet(ACTS_DND, '1');   // the mode turns it off when it ends
    lsSet(OWE, null);
    return true;
  }
  /** Put DND back once the block is over. No system layer yet: the record (and the memo) wait for nbd:os-system-ready. */
  function restoreDnd(r) {
    if (!r || r.dnd === 'done') return r;
    if (r.dnd === 'mine' && !putBack()) return r;
    return Object.assign({}, r, { dnd: 'done' });
  }
  /**
   * DND owed with no record left to carry it: the record was dropped as over 12 h old (the tab
   * died mid-block and the rep came back the next morning), or Done cleared it before the system
   * layer loaded. system.js keeps DND across sessions, so put it back now.
   */
  function settleOwed() {
    var u = uid();
    if (!u || lsGet(OWE) !== u) return;
    var r = load();
    if (r && r.dnd === 'mine') return;   // its record still carries it
    putBack();
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
    settleOwed();
    var r = load();
    if (r && FL.phase(r, Date.now()) === 'over' && r.endedAt == null) end(false);
    else if (r && r.endedAt != null && r.dnd !== 'done') { save(restoreDnd(r)); }
    else arm(r);
  }
  function start(mins, from) {
    var u = uid(), cur = load();
    if (!u || (cur && FL.phase(cur, Date.now()) === 'running')) return;
    var O = sys();
    settleOwed();   // an earlier block's DND first, so this one sees it as it really is
    var r = FL.begin({ uid: u, now: Date.now(), mins: mins, dndOn: O ? safe(O.isDnd) === true : false, dndAvail: !!O });
    if (!r) return;
    failedAt = 0;
    save(r);
    if (r.dnd === 'mine') { lsSet(OWE, u); safe(function () { O.setDnd(true); }); }
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
    refocus(from, 'start');
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
    if (!r) { if (lsGet(FL.KEY)) save(null); settleOwed(); return; }   // another account's, broken or stale
    if (FL.phase(r, Date.now()) === 'over' && r.endedAt == null) { end(false); return; }
    if (r.endedAt != null) { if (r.dnd !== 'done') save(restoreDnd(r)); return; }
    arm(r);
    count();
    askFloor(r);
  }

  // ── the widget ─────────────────────────────────────────────
  var TITLE = '<h3 class="os-hw-title">Knock block</h3>';
  function timeOf(ms) { return safe(function () { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }) || ''; }
  var PICK = 60;   // the small widget's length picker starts here
  function startBtns(size) {
    if (size === 's') {
      // three 44px buttons don't fit a narrow small card: a native length picker and one Start
      return '<div class="os-fb-go"><select class="os-fb-sel" aria-label="Block length">' + FL.LENGTHS.map(function (m) {
        return '<option value="' + m + '"' + (m === PICK ? ' selected' : '') + '>' + esc(m + ' min') + '</option>';
      }).join('') + '</select><button type="button" class="btn btn-ghost os-hw-btn os-fb-start" data-oshw-focus="start">Start</button></div>';
    }
    return '<div class="os-fb-go" role="group" aria-label="Start a knock block">' + FL.LENGTHS.map(function (m) {
      return '<button type="button" class="btn btn-ghost os-hw-btn os-fb-len" data-oshw-focus="start:' + m + '" aria-label="' +
        esc('Start a ' + m + '-minute knock block') + '">' + esc(m + ' min') + '</button>';
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
      // the buttons first: a short card (the one-column desk) clips the line under them, never them
      return TITLE + startBtns(size) + (size === 's' ? '' : '<p class="os-hw-empty">Do Not Disturb goes on and your doors are counted.</p>');
    }
    var failed = !!r && failedAt === r.start;
    var small = size === 's';
    if (v.phase === 'running') {
      var endBtn = '<button type="button" class="ui-btn-quiet os-hw-btn os-fb-end" data-oshw-focus="end" aria-label="End the knock block now">End</button>';
      var doors = small ? v.s.doors : v.doors;
      var h = TITLE + '<div class="os-fb-row"><p class="os-fb-nums"><span class="os-fb-left ui-num">' + esc(small ? v.s.left : v.left) + '</span>' +
        (doors ? '<span class="os-fb-doors">' + esc(doors) + '</span>' : (failed && !small ? '<span class="os-fb-none">Couldn\'t count doors yet.</span>' : '')) +
        '</p>' + endBtn + '</div>';
      if (small) return h;
      h += '<progress class="os-fb-bar" max="100" value="' + esc(String(v.pct)) + '" aria-label="' + esc('Block ' + v.pct + '% done') + '"></progress>';
      if (v.floor) h += '<p class="os-hw-sub">' + esc(v.floor) + '</p>';
      return h + '<p class="os-hw-sub">' + esc('Ends ' + timeOf(r.end) + (r.dnd === 'mine' || r.dnd === 'kept' ? ' · Do Not Disturb on' : '')) + '</p>';
    }
    var ok = '<button type="button" class="btn btn-ghost os-hw-btn os-fb-ok" data-oshw-focus="done">Done</button>';
    if (small) {
      return TITLE + '<div class="os-fb-row"><p class="os-fb-nums"><span class="os-fb-done">' + esc(v.s.doors) + '</span>' +
        '<span class="os-fb-ran">' + esc(v.s.ran) + '</span></p>' + ok + '</div>';
    }
    var o = TITLE + '<div class="os-fb-row"><p class="os-fb-done">' + esc(v.done) + '</p>' + ok + '</div>';
    if (v.floor) o += '<p class="os-hw-sub">' + esc(v.floor) + '</p>';
    if (failed && r.doors == null) o += '<button type="button" class="ui-btn-quiet os-hw-btn os-fb-recount" data-oshw-focus="recount">Count again</button>';
    return o;
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
    if (what === 'start') {   // the small widget: its picker's length
      var sel = card && card.querySelector ? card.querySelector('.os-fb-sel') : null;
      var n = sel ? Number(sel.value) : PICK;
      start(FL.LENGTHS.indexOf(n) !== -1 ? n : PICK, card);
      return;
    }
    if (what === 'end') end(true, card);
    else if (what === 'done') done(card);
    else if (what === 'recount') count();
  }

  W.addEventListener('nbd:knocks-changed', onKnock);
  W.addEventListener('nbd:os-dsbiz', onBiz);
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) check(); });
  W.addEventListener('nbd:os-system-ready', check);   // DND waiting on the system layer (os/system.js) is put back

  W.NBDOSFocus = { widget: widget, tap: tap, key: key, resume: resume };
  resume();
})();
