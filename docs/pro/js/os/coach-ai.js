/**
 * os/coach-ai.js — the NBD OS Coach's AI focus line, the browser half
 * (2026-11-09, P2; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2).
 *
 * Shown only when the company opted in (companyProfile.coachAiEnabled === true;
 * an owner or company_admin turns it on in edit mode's team controls) and the
 * rules Coach has something to say. Never on paint: the rep taps "Today's focus"
 * once, the coachLine callable (functions/coach-line.js) answers with one
 * sentence or with no line. The line is kept for this page only (memory), never
 * on the device: after a reload a tap re-reads the server's day cache (no model
 * call), which checks the AI kill switches first, so an operator can pull a line
 * back the same day. "No line" is kept for the day on this device (localStorage
 * nbd_os_coach_ai: { d: day key, u: uid, none }; an nbd_ key, wiped at sign-out).
 * What is sent is the rules' counted evidence
 * only: rule ids and whole numbers, no names, no text (the server drops anything
 * else too). A failed call can be tried again; "no line" is final for the day.
 *
 *   NBDOSCoachAI.on()          the company opted in (the profile already in memory)
 *   NBDOSCoachAI.html(rules)   the markup above the top rule ('' = nothing)
 *   NBDOSCoachAI.ask(rules)    the tap: one callable, then 'nbd:os-coachai' repaints
 *   NBDOSCoachAI.evidence(rules) what ask() sends (tests)
 *
 * The runtime ScriptLoader bundle `oscoachai` (with css/os/coach-ai.css),
 * registered and loaded by os/home.js the first time an opted-in Coach paints;
 * never at boot. Every value goes into the DOM escaped; no inline handlers, no
 * style attributes.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  if (!W || W.NBDOSCoachAI) return;

  var KEY = 'nbd_os_coach_ai';
  var IDS = /^[a-z-]{1,24}$/;
  var busy = false, failed = false, mem = null;   // mem: { d, u, line }, this page's line

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() { return String((W._user && W._user.uid) || ''); }
  function dk() {
    var HL = W.NBDOSHomeLogic;
    return HL && typeof HL.dayKey === 'function' ? HL.dayKey(Date.now()) : '';
  }
  function mine(v) { return !!v && typeof v === 'object' && !!v.d && v.d === dk() && v.u === uid(); }
  /** Today's answer for this user: this page's line, or a "no line" kept on the device; else null. */
  function today() {
    if (mine(mem)) return { line: mem.line };
    var v = null;
    try { v = JSON.parse(W.localStorage.getItem(KEY) || 'null'); } catch (e) { v = null; }
    return mine(v) && v.none === true ? { none: true } : null;
  }
  function keep(v) {
    if (v.line) { mem = { d: dk(), u: uid(), line: v.line }; return; }
    try { W.localStorage.setItem(KEY, JSON.stringify(Object.assign({ d: dk(), u: uid() }, v))); } catch (e) {}
  }
  function on() {
    var p = W._companyProfile;
    return !!(p && typeof p === 'object' && p.coachAiEnabled === true);
  }
  /** The rules' counted evidence only: ids and whole numbers (a stage name or any text stays here). */
  function evidence(rules) {
    return (Array.isArray(rules) ? rules : []).filter(function (r) { return r && IDS.test(String(r.id || '')); }).slice(0, 5).map(function (r) {
      var ev = {};
      var src = r.evidence && typeof r.evidence === 'object' ? r.evidence : {};
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (!/^[A-Za-z0-9]{1,16}$/.test(k)) return;
        if (typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v) ev[k] = v;
        else if (v === true) ev[k] = true;
      });
      return { id: String(r.id), evidence: ev };
    });
  }
  function html(rules) {
    if (!on() || !Array.isArray(rules) || !rules.length) return '';
    var t = today();
    if (t && t.line) {
      return '<p class="os-hw-ai"><span class="os-hw-ai-tag">AI focus</span> <span class="os-hw-ai-line">' + esc(t.line) + '</span></p>';
    }
    if (t && t.none) return '';
    if (busy) return '<p class="os-hw-ai os-hw-ai-busy" role="status">Finding today\'s focus…</p>';
    return '<button type="button" class="ui-btn-quiet os-hw-btn os-hw-ai-ask" data-oshw-coach="ai">' +
      (failed ? 'Couldn\'t reach the coach. Try again' : 'Today\'s focus (AI)') + '</button>';
  }
  function repaint() { try { W.dispatchEvent(new W.CustomEvent('nbd:os-coachai')); } catch (e) {} }
  function callable(name, payload) {
    var go = function () { return W._httpsCallable(W._functions, name)(payload); };
    if (W._functions && typeof W._httpsCallable === 'function') return Promise.resolve().then(go);
    return import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (mod) {
      W._functions = W._functions || mod.getFunctions();
      W._httpsCallable = W._httpsCallable || mod.httpsCallable;
      return go();
    });
  }
  function ask(rules) {
    if (busy || !on() || today()) return Promise.resolve(null);
    var ev = evidence(rules);
    if (!ev.length) return Promise.resolve(null);
    busy = true; failed = false;
    repaint();
    return callable('coachLine', { rules: ev }).then(function (res) {
      var d = (res && res.data) || {};
      var line = typeof d.line === 'string' ? d.line.replace(/\s+/g, ' ').trim() : '';
      if (line && line.length <= 200) keep({ line: line });
      else if (d.reason === 'model') failed = true;   // the model was down: worth one more try
      else keep({ none: true });                       // off, capped, checked out, nothing to say: not today
    }, function () { failed = true; }).then(function () {
      busy = false;
      repaint();
      return today();
    });
  }

  W.NBDOSCoachAI = { on: on, html: html, ask: ask, evidence: evidence, KEY: KEY };
})();
