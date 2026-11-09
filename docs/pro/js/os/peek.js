/**
 * os/peek.js — NBD OS P2: the pre-flight peek and the Welcome Recap, browser half
 * (2026-11-09; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #6, #7).
 *
 *   open({ key, returnFocus })  the Peek sheet for one appointment of the Today plan:
 *                               the appointment, its address (Directions), the lead's
 *                               notes and its promises due, from memory (0 reads). The
 *                               lead brief (functions/lead-brief.js leadBrief, a paid
 *                               callable capped per user per day) loads ONLY when the
 *                               member taps "Get the brief", once per lead per page;
 *                               the sample account answers it with a canned brief
 *                               (demo-sdk/firebase-functions.js).
 *   recap()                     the Welcome Recap: what yesterday's Shutdown left open
 *                               (localStorage nbd_os_carry, ids only, resolved against
 *                               _leads now) and today's first appointment. "Got it",
 *                               Escape or a row's Open remembers the day in localStorage nbd_os_recap,
 *                               so it shows once a day; os/home.js decides when it is due
 *                               (home-logic recapDue) and never loads this file otherwise.
 *
 * Both are native <dialog>s (showModal); their parts are <div>s, not <section>s (nbd-mobile.css
 * pads every <section> with !important). Every value goes in escaped; no inline
 * handlers, no style attributes; css/os/peek.css. Writes nothing to the CRM: its
 * only storage is the nbd_os_recap day key.
 *
 * Loaded with os/peek-logic.js and css/os/peek.css as the runtime ScriptLoader
 * bundle `osp2peek` (registered by os/home.js), never at boot. window.NBDOSPeek.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSPeek) return;
  var PL = W.NBDOSPeekLogic;
  var HL = W.NBDOSHomeLogic;
  if (!PL || !HL) return;

  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var CARRY_KEY = 'nbd_os_carry';
  var RECAP_KEY = 'nbd_os_recap';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsGet(k) { try { return W.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { W.localStorage.setItem(k, v); } catch (e) {} }
  function plan() {
    var T = W.NBDToday;
    try { return T && typeof T.last === 'function' ? T.last() : null; } catch (e) { return null; }
  }
  function apptsFailed() {
    var T = W.NBDToday;
    try { return !!(T && typeof T.appointmentsFailed === 'function' && T.appointmentsFailed()); } catch (e) { return false; }
  }
  /** The CRM's leads once they are loaded (home.js leadsNow's gate), else null: not known yet. */
  function leads() { return W._leadsLoaded === true && Array.isArray(W._leads) ? W._leads : null; }
  function outside(d, ev) {
    if (typeof d.getBoundingClientRect !== 'function') return false;
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }
  function focusIn(d, sel) {
    var n = d && d.querySelector(sel);
    if (!n) return false;
    try { n.focus(); } catch (e) {}
    return true;
  }
  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - Number(ms || 0)) / 60000));
    if (!ms) return '';
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.round(m / 60) + ' h ago';
  }

  // ── the brief: a tap, never a paint ────────────────────────
  var briefs = {};   // leadId -> { state: 'loading'|'done'|'error', brief, error }
  function callable(name, payload) {
    return Promise.resolve().then(function () {
      if (W._functions && typeof W._httpsCallable === 'function') return null;
      return import(FUNCTIONS_SDK).then(function (mod) {
        W._functions = W._functions || mod.getFunctions();
        W._httpsCallable = W._httpsCallable || mod.httpsCallable;
      });
    }).then(function () { return W._httpsCallable(W._functions, name)(payload); })
      .then(function (res) { return res && res.data; });
  }
  function getBrief(leadId, done) {
    var b = briefs[leadId];
    if (b && (b.state === 'loading' || b.state === 'done')) return;
    briefs[leadId] = { state: 'loading' };
    done();
    callable('leadBrief', { leadId: leadId }).then(function (data) {
      var v = PL.brief(data);
      briefs[leadId] = v ? { state: 'done', brief: v } : { state: 'error', error: 'Could not build the brief. Try again in a moment.' };
      done();
    }, function (e) {
      var code = String((e && (e.code || e.message)) || '');
      var sample = !!(e && e.details && e.details.sampleAccount);
      briefs[leadId] = { state: 'error', error: sample && e.message ? String(e.message)
        : (/permission/i.test(code) ? 'You can\'t brief on this customer.' : 'Could not build the brief. Try again in a moment.') };
      done();
    });
  }
  function briefHtml(leadId) {
    var b = briefs[leadId];
    if (!b) {
      return '<p class="os-pk-muted">A summary of the calls, promises, estimates and money on file. It loads only when you ask.</p>' +
        '<button type="button" class="btn btn-ghost os-pk-btn" data-pk-brief="">Get the brief</button>';
    }
    if (b.state === 'loading') return '<p class="os-pk-muted">Reading the calls, promises and money on file…</p>';
    if (b.state === 'error') {
      return '<p class="os-pk-err">' + esc(b.error) + '</p><button type="button" class="btn btn-ghost os-pk-btn" data-pk-brief="">Try again</button>';
    }
    var v = b.brief;
    return '<p class="os-pk-one">' + esc(v.oneLine) + '</p>' +
      (v.bullets.length ? '<ul class="os-pk-list">' + v.bullets.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="os-pk-muted">' + esc([v.source, ago(v.at), v.cached ? 'saved' : ''].filter(Boolean).join(' · ')) + '</p>';
  }

  // ── the sheets ─────────────────────────────────────────────
  var cur = null;   // { d, kind, returnFocus, key }
  function shell(kind, titleId) {
    var d = doc.createElement('dialog');
    d.className = 'os-pk' + (kind === 'recap' ? ' os-rc' : '');
    d.setAttribute('aria-labelledby', titleId);
    d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } });
    // 'close' fires asynchronously: only this sheet, while it is still the current one, cleans up,
    // so an old sheet's late event never tears down the one open() just showed
    d.addEventListener('close', function () { if (cur && cur.d === d) cleanup(); });
    return d;
  }
  function close() {
    var s = cur;
    if (!s) return;
    if (s.d.open) s.d.close();
    if (cur === s) cleanup();   // now, not on the async event
  }
  function cleanup() {
    var s = cur;
    if (!s) return;
    cur = null;
    if (s.kind === 'recap') lsSet(RECAP_KEY, HL.dayKey(Date.now()));   // a close of any kind is the dismiss: once a day
    if (s.d.parentNode) s.d.parentNode.removeChild(s.d);
    if (s.returnFocus && s.returnFocus.isConnected) { try { s.returnFocus.focus(); } catch (e) {} }
  }
  function show(s) {
    cur = s;
    doc.body.appendChild(s.d);
    if (typeof s.d.showModal === 'function') s.d.showModal(); else s.d.setAttribute('open', '');
  }
  var HD = function (id, title) {
    return '<div class="os-pk-hd"><h2 class="os-pk-title" id="' + id + '">' + esc(title) + '</h2>' +
      '<button type="button" class="ui-btn-quiet os-pk-close" data-pk-close="" aria-label="Close">✕</button></div>';
  };

  function peekHtml(f) {
    var h = HD('osPkTitle', 'Peek') +
      '<div class="os-pk-sec"><h3 class="os-pk-st">Appointment</h3>' +
      '<p class="os-pk-name">' + esc(f.name) + '</p>' +
      '<p class="os-pk-sub">' + esc([f.time, f.title].filter(Boolean).join(' · ')) + '</p>' +
      (f.address ? '<p class="os-pk-addr">' + esc(f.address) + '</p>' : '') +
      '<div class="os-pk-acts">' +
      (f.mapsHref ? '<a class="btn btn-ghost os-pk-btn" href="' + esc(f.mapsHref) + '" target="_blank" rel="noopener">Directions</a>' : '') +
      (f.custHref ? '<a class="btn btn-ghost os-pk-btn" href="' + esc(f.custHref) + '">Open customer</a>' : '') +
      '</div></div>';
    if (f.leadsPending) return h + '<p class="os-pk-muted os-pk-sec">Your customers are still loading, so this appointment\'s notes, promises and brief are not here yet. Close and Peek again in a moment.</p>';
    if (!f.linked) return h + '<p class="os-pk-muted os-pk-sec">No customer in the CRM is linked to this appointment, so there are no notes, promises or brief to show.</p>';
    h += '<div class="os-pk-sec"><h3 class="os-pk-st">Last notes</h3>' +
      (f.notes ? '<p class="os-pk-notes">' + esc(f.notes) + (f.notesCut ? '…' : '') + '</p>' : '<p class="os-pk-muted">No notes on this customer.</p>') + '</div>';
    h += '<div class="os-pk-sec"><h3 class="os-pk-st">Promises due</h3>' +
      (f.promises.length ? '<ul class="os-pk-list">' + f.promises.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>'
        : '<p class="os-pk-muted">No promises due on this customer.</p>') + '</div>';
    h += '<div class="os-pk-sec"><h3 class="os-pk-st">Lead brief</h3><div class="os-pk-brief" data-pk-briefbody="" aria-live="polite">' + briefHtml(f.leadId) + '</div></div>';
    return h;
  }
  function open(opts) {
    var o = opts || {};
    var known = leads();
    var f = PL.facts({ plan: plan(), leads: known || [], key: String(o.key || '') });
    if (f && !known && f.leadId) f.leadsPending = true;   // linked or not is not known yet
    if (cur) close();
    var d = shell('peek', 'osPkTitle');
    var s = { d: d, kind: 'peek', returnFocus: o.returnFocus || null, key: f ? f.key : '' };
    function paintBrief(focusBtn) {
      if (cur !== s || !f) return;
      var body = d.querySelector('[data-pk-briefbody]');
      if (body) body.innerHTML = briefHtml(f.leadId);
      if (focusBtn && !focusIn(d, '[data-pk-brief]')) { if (body && !body.hasAttribute('tabindex')) body.setAttribute('tabindex', '-1'); if (body) { try { body.focus(); } catch (e) {} } }
    }
    d.innerHTML = f ? peekHtml(f) : HD('osPkTitle', 'Peek') + '<p class="os-pk-muted">That appointment is not on today\'s list any more.</p>';
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-pk-close]') || (t === d && outside(d, ev))) { close(); return; }
      if (t.closest('[data-pk-brief]') && f && f.linked) { getBrief(f.leadId, function () { paintBrief(true); }); }
    });
    show(s);
    focusIn(d, '[data-pk-close]');
    return d;
  }

  function recapHtml(r) {
    var MAX = 8;
    var h = HD('osRcTitle', 'Welcome back') +
      '<p class="os-pk-lede">Still open from your Shutdown ' + esc(r.when || 'last time') + ':</p>';
    if (r.leads.length) {
      h += '<ul class="os-pk-rows">' + r.leads.slice(0, MAX).map(function (x) {
        return '<li class="os-pk-row" data-rc-lead="' + esc(x.id) + '"><span class="os-pk-txt"><span class="os-pk-name">' + esc(x.name) + '</span>' +
          '<span class="os-pk-sub">' + esc(x.why) + '</span></span>' +
          '<a class="btn btn-ghost os-pk-btn" href="' + esc(x.href) + '">Open</a></li>';
      }).join('') + '</ul>';
      if (r.leads.length > MAX) h += '<p class="os-pk-muted">and ' + esc(String(r.leads.length - MAX)) + ' more</p>';
    }
    if (r.visits) h += '<p class="os-pk-visits">' + esc(PL.visitsLine(r.visits)) + '</p>';
    var a = r.first;
    if (a === 'none') h += '<div class="os-pk-sec"><h3 class="os-pk-st">Today</h3><p class="os-pk-muted">No appointments today.</p></div>';
    else if (a) {
      h += '<div class="os-pk-sec"><h3 class="os-pk-st">Today\'s first appointment</h3><p class="os-pk-name">' + esc(a.time) + ' · ' + esc(a.name) + '</p>' +
        (a.place ? '<p class="os-pk-sub">' + esc(a.place) + '</p>' : '') + '</div>';
    }
    return h + '<div class="os-pk-ft"><button type="button" class="btn btn-ghost os-pk-btn" data-pk-close="">Got it</button></div>';
  }
  /** Shows the recap when there is one to show; returns the dialog or null. Never twice a day (nbd_os_recap). */
  function recap(opts) {
    var o = opts || {};
    var now = Date.now();
    var uid = String((W._user && W._user.uid) || '');
    var raw = lsGet(CARRY_KEY);
    var known = leads(), p = plan();
    // the leads or the plan not loaded yet: null, and os/home.js asks again on the next data event
    if (cur || !known || !p || !HL.recapDue(raw, lsGet(RECAP_KEY), uid, now)) return null;
    var r = PL.recap({ carry: HL.parseCarry(raw), leads: known, plan: p, now: now, apptsFailed: apptsFailed() });
    if (!r) return null;   // every carried lead is gone and no visits: nothing to say
    var d = shell('recap', 'osRcTitle');
    d.innerHTML = recapHtml(r);
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-pk-close]') || (t === d && outside(d, ev))) { close(); return; }
      // Open on a row counts as seeing the recap: the link navigates in this tab, and the way
      // back to the dashboard the same day must not bring it up again
      if (t.closest('.os-pk-row a')) lsSet(RECAP_KEY, HL.dayKey(Date.now()));
    });
    show({ d: d, kind: 'recap', returnFocus: o.returnFocus || doc.activeElement || null });
    if (!focusIn(d, '.os-pk-row a')) focusIn(d, '.os-pk-ft [data-pk-close]');
    return d;
  }

  W.NBDOSPeek = { open: open, recap: recap, close: close, isOpen: function () { return !!cur; } };
})();
