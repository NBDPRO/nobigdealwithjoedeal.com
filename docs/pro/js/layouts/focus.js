/**
 * layouts/focus.js — L03 "Focus Mode" (2026-10-11, D4 of the style integration).
 *
 * One lead at a time, already ranked, with a single plain "Why now" line, the
 * key facts, a DRAFTED next text, and four big actions: Call, Text, Snooze,
 * Done · Next. A full pipeline can freeze a rep; this turns it into a queue
 * that is already in order, so the next call is the next card, not a scroll.
 *
 * It builds on what the CRM already decides — nothing is re-derived:
 *   queue    NBDToday.compute() (today-plan.js): today's appointments, what
 *            you promised, calls/texts owed (one per person), estimates to
 *            follow up, stalled follow-ups. This file only RANKS those rows
 *            and words the reason (a rule table, below — no AI involved).
 *   Snooze   LeadSnooze.prompt, the CRM's own modal.
 *   Done     a task-backed row completes its task(s) with NBDTasks.setDone
 *            (exactly what Today's "Done" does); any other row is only set
 *            aside on THIS device for today, and the button says "Next", not
 *            "Done", so the label never claims a write that did not happen.
 *
 * What it never does: send anything. Text opens the phone's / computer's own
 * composer with the drafted words; the rep presses Send there. Drafts say
 * nothing about insurance, claims, prices or outcomes.
 *
 * Pure part (buildQueue / whyNow / draftFor) is require()-able for tests.
 */
(function (root) {
  'use strict';

  // ── pure: the rule table ─────────────────────────────────────────────
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function ago(ms, now) {
    var d = Math.max(0, (now || Date.now()) - ms);
    var m = Math.round(d / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return plural(h, 'hour') + ' ago';
    return plural(Math.round(h / 24), 'day') + ' ago';
  }
  function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

  // Each rule: when it applies, its rank (lower = sooner), the reason in a rep's words.
  var RULES = [
    { id: 'appt-soon',     rank: 10, when: function (r, n) { return r.kind === 'appointment' && r.sortMs && r.sortMs - n < 3 * 3600000 && r.sortMs - n > -3600000; },
      why: function (r) { return 'Appointment ' + (r.timeLabel || 'today') + (r.address ? ' · ' + clip(r.address, 60) : ''); } },
    { id: 'promised',      rank: 20, when: function (r) { return r.kind === 'promised' && r.promises && r.promises.length > 0; },
      why: function (r) { return 'You promised: ' + clip(r.promises[0], 90); } },
    { id: 'task-overdue',  rank: 25, when: function (r) { return r.kind === 'promised' && r.overdue; },
      why: function (r) { return 'Overdue: ' + clip(r.taskText || 'a task you set', 90); } },
    { id: 'call-urgent',   rank: 30, when: function (r) { return r.kind === 'call' && r.urgent; },
      why: function (r) { return 'Marked urgent: ' + clip(r.summary || 'they need a call back', 90); } },
    { id: 'call-missed',   rank: 40, when: function (r) { return r.kind === 'call' && r.missed; },
      why: function (r, n) { return 'Missed call' + (r.latestMs ? ' · ' + ago(r.latestMs, n) : '') + (r.count > 1 ? ' · ' + r.count + ' tries' : ''); } },
    { id: 'call-text',     rank: 45, when: function (r) { return r.kind === 'call' && r.text; },
      why: function (r, n) { return 'Texted you' + (r.latestMs ? ' ' + ago(r.latestMs, n) : '') + (r.summary ? ': ' + clip(r.summary, 80) : ''); } },
    { id: 'call-other',    rank: 48, when: function (r) { return r.kind === 'call'; },
      why: function (r) { return clip(r.summary || 'They are waiting on a call back', 100); } },
    { id: 'task-today',    rank: 50, when: function (r) { return r.kind === 'promised'; },
      why: function (r) { return 'Due today: ' + clip(r.taskText || 'a task you set', 90); } },
    { id: 'est-opened',    rank: 60, when: function (r) { return r.kind === 'estimate' && r.opened; },
      why: function (r) { return 'Opened your estimate' + (r.openedLabel ? ' ' + clip(r.openedLabel, 40) : ''); } },
    { id: 'follow-up',     rank: 70, when: function (r) { return r.kind === 'stalled'; },
      why: function (r) { return r.daysLate > 0 ? 'Follow-up was due ' + plural(r.daysLate, 'day') + ' ago' : 'Follow-up is due today'; } },
    { id: 'est-quiet',     rank: 80, when: function (r) { return r.kind === 'estimate'; },
      why: function (r) { return 'Estimate went out ' + plural(r.daysOut || 0, 'day') + ' ago; no answer yet'; } },
  ];
  function ruleFor(r, now) {
    for (var i = 0; i < RULES.length; i++) { if (RULES[i].when(r, now)) return RULES[i]; }
    return null;
  }
  function whyNow(r, now) {
    var rule = ruleFor(r, now == null ? Date.now() : now);
    return rule ? rule.why(r, now == null ? Date.now() : now) : 'On your list today';
  }

  // The drafted next text. Plain, short, no claims / prices / outcomes.
  function draftFor(r, now) {
    var f = firstName(r.name);
    var hi = f ? 'Hi ' + f + ', ' : 'Hi, ';
    var rule = ruleFor(r, now == null ? Date.now() : now);
    var id = rule ? rule.id : '';
    if (id === 'appt-soon') return hi + 'I\'m heading your way for our ' + (r.timeLabel ? r.timeLabel + ' ' : '') + 'appointment. See you soon.';
    if (id === 'call-missed' || id === 'call-urgent') return hi + 'sorry I missed you. What\'s a good time to talk?';
    if (id === 'call-text' || id === 'call-other') return hi + 'got your message. When is a good time to talk?';
    if (id === 'est-opened' || id === 'est-quiet') return hi + 'just checking that you got the estimate, and whether you have any questions.';
    if (id === 'promised' || id === 'task-overdue' || id === 'task-today') return hi + 'following up on what I said I\'d do. Is now a good time to talk?';
    return hi + 'following up on your roof. Is now a good time to talk?';
  }

  // Plan rows -> one ranked queue. Pure: no DOM, no clock besides `now`.
  function buildQueue(plan, now) {
    var n = now == null ? Date.now() : now;
    var p = plan || {};
    var out = [], seen = {};
    function push(r) {
      var id = r.leadId ? 'L' + r.leadId : r.key;
      if (seen[id]) return;          // a person appears once (the plan already dedupes; this is belt and braces)
      seen[id] = 1;
      var rule = ruleFor(r, n);
      r.rank = rule ? rule.rank : 90;
      r.ruleId = rule ? rule.id : '';
      r.why = whyNow(r, n);
      out.push(r);
    }
    (p.appointments || []).forEach(function (a) {
      push({ kind: 'appointment', key: a.key, leadId: a.leadId || null, name: a.name, phone: a.phone, address: a.address, timeLabel: a.timeLabel, sortMs: a.sortMs, type: a.type });
    });
    (p.promised || []).forEach(function (r) {
      var t = (r.tasks || [])[0];
      push({ kind: 'promised', key: r.key, leadId: r.leadId, name: r.name, phone: r.phone, promises: r.promises || [], overdue: !!r.overdue,
        taskText: t && (t.text || t.title), tasks: r.tasks || [], dueYmd: r.dueYmd });
    });
    (p.calls || []).forEach(function (r) {
      push({ kind: 'call', key: r.key, leadId: r.leadId, name: r.name, phone: r.phone, urgent: !!r.urgent, missed: !!r.missed, text: !!r.text,
        summary: r.summary, latestMs: r.latestMs, count: r.count || 1 });
    });
    (p.estimates || []).forEach(function (r) {
      push({ kind: 'estimate', key: r.key, leadId: r.leadId, name: r.name, opened: !!r.opened, openedLabel: r.openedLabel, daysOut: r.daysOut, bucket: r.bucket });
    });
    (p.stalled || []).forEach(function (r) {
      push({ kind: 'stalled', key: r.key, leadId: r.leadId, name: r.name, phone: r.phone, daysLate: r.daysLate || 0, followUp: r.followUp });
    });
    out.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.kind === 'stalled' && b.kind === 'stalled') return (b.daysLate || 0) - (a.daysLate || 0);
      if (a.kind === 'estimate' && b.kind === 'estimate') return (b.daysOut || 0) - (a.daysOut || 0);
      if (a.sortMs != null && b.sortMs != null) return a.sortMs - b.sortMs;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return out;
  }

  var logic = { RULES: RULES, whyNow: whyNow, draftFor: draftFor, buildQueue: buildQueue, ago: ago, clip: clip };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (!root) return;
  root.NBDFocusLogic = logic;

  // ── browser: the layout ──────────────────────────────────────────────
  var W = root, doc = root.document;
  var K = W.NBDLayoutKit, E = W.LayoutEngine;
  if (!K || !E) return;
  var esc = K.esc;
  var DAY_KEY = 'nbd_focus_day';
  var rootEl = null, mounted = false, mo = null, timer = null, unbind = [];
  var S = { screen: 'today', i: 0, menu: false };

  function ymd() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function day() {
    var d = null; try { d = JSON.parse(ls(DAY_KEY) || 'null'); } catch (e) {}
    if (!d || d.ymd !== ymd()) d = { ymd: ymd(), done: {}, aside: {}, calls: 0 };
    return d;
  }
  function saveDay(d) { try { localStorage.setItem(DAY_KEY, JSON.stringify(d)); } catch (e) {} }
  function toast(m, t) { if (typeof W.showToast === 'function') W.showToast(m, t || 'info'); }
  function leadById(id) {
    var l = W._leads || [];
    for (var i = 0; i < l.length; i++) if (l[i] && String(l[i].id) === String(id)) return l[i];
    return null;
  }
  function plan() {
    try { if (W.NBDToday && W.NBDToday.compute && W._leadsLoaded === true) return W.NBDToday.compute(); } catch (e) {}
    return null;
  }
  function queue() {
    var p = plan();
    if (!p) return null;
    var d = day();
    return buildQueue(p, Date.now()).filter(function (r) { return !d.done[r.key] && !d.aside[r.key]; });
  }
  function itemOf(r) {
    var lead = r.leadId ? leadById(r.leadId) : null;
    var it = K.fromLead(lead || { id: r.leadId || '' }, { name: r.name, phone: r.phone || (lead && (lead.phone || lead.phoneDigits)), address: r.address, why: r.why });
    return it;
  }
  function smsWithDraft(it, text) {
    var base = K.smsUrl(it.phone);
    return base ? base + '?&body=' + encodeURIComponent(text) : '';
  }

  function counts(q) {
    var c = { calls: 0, promised: 0, estimates: 0, followups: 0, appts: 0 };
    q.forEach(function (r) {
      if (r.kind === 'call') c.calls++; else if (r.kind === 'promised') c.promised++; else if (r.kind === 'estimate') c.estimates++;
      else if (r.kind === 'stalled') c.followups++; else if (r.kind === 'appointment') c.appts++;
    });
    return c;
  }

  // withRecord: the Today and Wrap-up screens carry Record visit up here; the
  // one-lead screen carries it on the card instead, with that lead attached.
  function topBar(withRecord) {
    return '<div class="fo-top"><button type="button" class="fo-pill" data-fo="today">Today</button>' +
      '<button type="button" class="fo-pill" data-fo="wrap">Wrap-up</button>' +
      (withRecord ? K.recordEntry({ source: 'focus', cls: 'fo-rec' }) : '') +
      K.syncDot() +
      '<button type="button" class="fo-pill fo-menu" data-fo="menu" aria-expanded="' + S.menu + '">Menu</button></div>' +
      (S.menu ? '<div class="fo-sheet" role="menu">' + K.menuItems('fo') +
        '<button type="button" role="menuitem" data-fo="today">Back to Focus</button></div>' : '');
  }

  function renderToday(q) {
    // Next stop (js/next-stop.js, 2026-10-15) fills [data-ns-slot].
    var h = topBar(true) + '<div data-ns-slot="focus"></div>';
    if (!q) return h + '<div class="fo-empty">Loading your day…</div>';
    var c = counts(q);
    if (!q.length) {
      return h + '<div class="fo-hero"><div class="fo-big">0</div><div class="fo-sub">Nothing needs you right now.</div></div>' +
        '<p class="fo-note">Open the pipeline to look around, or check back after the next call comes in.</p>';
    }
    var line = [];
    if (c.appts) line.push(plural(c.appts, 'appointment'));
    if (c.calls) line.push(plural(c.calls, 'call') + ' to return');
    if (c.promised) line.push(c.promised + ' you promised');
    if (c.estimates) line.push(plural(c.estimates, 'estimate') + ' to follow up');
    if (c.followups) line.push(plural(c.followups, 'follow-up'));
    // one wrapper, so Customize (js/card-prefs.js) can move or hide the queue
    return h + '<div class="fo-queue"><div class="fo-hero"><div class="fo-big">' + q.length + '</div><div class="fo-sub">' + (q.length === 1 ? 'thing needs' : 'things need') + ' you today</div></div>' +
      '<ul class="fo-lines">' + line.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      '<button type="button" class="fo-start" data-fo="start">Start with ' + esc(firstName(q[0].name) || 'the first one') + '</button></div>';
  }

  function renderFocus(q) {
    var h = topBar(!q || !q.length);
    if (!q || !q.length) return h +'<div class="fo-hero"><div class="fo-big">&#10003;</div><div class="fo-sub">That is everyone for now.</div></div>' +
      '<button type="button" class="fo-start" data-fo="wrap">See your wrap-up</button>';
    if (S.i >= q.length) S.i = q.length - 1;
    if (S.i < 0) S.i = 0;
    var r = q[S.i];
    var it = itemOf(r);
    var draft = draftFor(r, Date.now());
    var sms = smsWithDraft(it, draft);
    var tel = K.telUrl(it.phone);
    var lead = r.leadId ? leadById(r.leadId) : null;
    var facts = [];
    if (it.address) facts.push(esc(it.address));
    if (K.fmtPhone(it.phone)) facts.push(esc(K.fmtPhone(it.phone)));
    if (lead && (lead._stageKey || lead.stage)) facts.push('Stage: ' + esc(lead._stageKey || lead.stage));
    var prev = q[S.i - 1], next = q[S.i + 1];
    var doneLbl = r.kind === 'promised' ? 'Done · Next' : 'Next';
    return h + '<div class="fo-count">' + (S.i + 1) + ' of ' + q.length + '</div>' +
      '<div class="fo-stage">' +
      '<button type="button" class="fo-peek fo-peek-l" data-fo="prev"' + (prev ? '' : ' disabled') + ' aria-label="Previous">' + (prev ? '<span>' + esc(firstName(prev.name)) + '</span>' : '') + '</button>' +
      '<article class="fo-card" data-lead-id="' + esc(it.id) + '">' +
      '<h2 class="fo-name">' + esc(it.name || 'Customer') + '</h2>' +
      '<p class="fo-why"><span class="fo-why-k">Why now</span> ' + esc(r.why) + '</p>' +
      (facts.length ? '<ul class="fo-facts">' + facts.map(function (f) { return '<li>' + f + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="fo-draft"><div class="fo-draft-k">Drafted text &middot; opens in your messages, you press Send</div><p>' + esc(draft) + '</p></div>' +
      '<div class="fo-actions">' +
      (tel ? '<a class="fo-act fo-act-primary" data-fo-call href="' + esc(tel) + '"><span>Call</span><kbd>C</kbd></a>' : '<button type="button" class="fo-act" disabled><span>No phone</span></button>') +
      (sms ? '<a class="fo-act" data-fo-text data-ps-check="1" data-ps-lead="' + esc(it.id) + '" href="' + esc(sms) + '"><span>Text</span><kbd>T</kbd></a>' : '<button type="button" class="fo-act" disabled><span>Text</span></button>') +
      '<button type="button" class="fo-act" data-fo="snooze"' + (it.id ? '' : ' disabled') + '><span>Snooze</span><kbd>S</kbd></button>' +
      '<button type="button" class="fo-act" data-fo="done"><span>' + esc(doneLbl) + '</span><kbd>D</kbd></button>' +
      '</div>' +
      K.recordEntry({ source: 'focus', leadId: it.id, cls: 'fo-rec fo-rec-card' }) +
      (it.id ? '<a class="fo-open" href="' + esc(K.customerUrl(it.id)) + '">Open the full customer page</a>' : '') +
      '</article>' +
      '<button type="button" class="fo-peek fo-peek-r" data-fo="next"' + (next ? '' : ' disabled') + ' aria-label="Next">' + (next ? '<span>' + esc(firstName(next.name)) + '</span>' : '') + '</button>' +
      '</div><p class="fo-keys">Keys: &larr; &rarr; move &middot; C call &middot; T text &middot; S snooze &middot; D next</p>';
  }

  function renderWrap(q) {
    var d = day();
    var done = Object.keys(d.done).length, aside = Object.keys(d.aside).length;
    return topBar(true) + '<div class="fo-hero"><div class="fo-big">' + done + '</div><div class="fo-sub">marked done today</div></div>' +
      '<ul class="fo-lines"><li>' + plural(d.calls || 0, 'call') + ' started from here</li><li>' + aside + ' set aside on this device</li><li>' +
      (q ? q.length : 0) + ' still waiting</li></ul>' +
      '<p class="fo-note">Set-aside items come back tomorrow. They were not changed in the CRM.</p>' +
      '<button type="button" class="fo-start" data-fo="start">Back to the queue</button>';
  }

  function render() {
    if (!rootEl) return;
    var q = queue();
    var html = S.screen === 'focus' ? renderFocus(q) : S.screen === 'wrap' ? renderWrap(q) : renderToday(q);
    rootEl.setAttribute('data-screen', S.screen);
    // "What closes this week" (js/closes-week.js, 2026-10-15) fills [data-cwk-slot];
    // the Cash strip (js/cash-card.js) fills [data-cash-slot].
    rootEl.innerHTML = '<div class="fo-wrap">' + html + (S.screen === 'today' ? '<div data-cash-slot="focus" data-cash-variant="compact"></div><div data-cwk-slot="focus"></div>' : '') + '</div>';
    K.setOverlay(rootEl, homeActive());
  }
  function activeView() { var v = doc.querySelector('.view.active'); return v && v.id ? v.id.replace(/^view-/, '') : ''; }
  function homeActive() { var a = activeView(); return !a || a === 'home'; }

  function currentRow() { var q = queue(); return q && q[S.i] ? q[S.i] : null; }
  function advance(delta) { S.i = Math.max(0, S.i + delta); render(); }
  function doDone() {
    var r = currentRow();
    if (!r) return;
    var d = day();
    var T = W.NBDTasks;
    if (r.kind === 'promised' && r.tasks && r.tasks.length && T && typeof T.setDone === 'function' && r.leadId) {
      Promise.all(r.tasks.map(function (t) { return T.setDone(r.leadId, t.id); })).then(function (res) {
        if (res.some(function (ok) { return !ok; })) { toast('Couldn\'t save that. Check your connection and try again.', 'error'); return; }
        var dd = day(); dd.done[r.key] = Date.now(); saveDay(dd); render();
      });
      return;
    }
    d.aside[r.key] = Date.now(); saveDay(d);
    render();
  }
  function doSnooze() {
    var r = currentRow();
    if (!r || !r.leadId) return;
    var it = itemOf(r);
    if (W.LeadSnooze && typeof W.LeadSnooze.prompt === 'function') W.LeadSnooze.prompt(r.leadId, it.name || '');
    else toast('Snooze is still loading. Try again in a moment.', 'info');
  }
  function noteCall() { var d = day(); d.calls = (d.calls || 0) + 1; saveDay(d); }

  function onClick(ev) {
    var call = ev.target && ev.target.closest ? ev.target.closest('[data-fo-call]') : null;
    if (call) { noteCall(); return; }                       // let the tel: link do its thing
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-fo]') : null;
    if (!t) return;
    var a = t.getAttribute('data-fo');
    ev.preventDefault();
    if (a === 'start') { S.screen = 'focus'; S.i = 0; S.menu = false; render(); return; }
    if (a === 'today') { S.screen = 'today'; S.menu = false; render(); return; }
    if (a === 'wrap') { S.screen = 'wrap'; S.menu = false; render(); return; }
    if (a === 'menu') { S.menu = !S.menu; render(); return; }
    if (a === 'goto') { S.menu = false; if (typeof W.goTo === 'function') W.goTo(t.getAttribute('data-to')); setTimeout(render, 80); return; }
    if (a === 'prev') { advance(-1); return; }
    if (a === 'next') { advance(1); return; }
    if (a === 'snooze') { doSnooze(); return; }
    if (a === 'done') { doDone(); return; }
  }
  function onKey(ev) {
    if (S.screen !== 'focus' || !rootEl || rootEl.hidden) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ev.target && ev.target.isContentEditable)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var k = String(ev.key || '').toLowerCase();
    if (k === 'arrowright') { advance(1); ev.preventDefault(); }
    else if (k === 'arrowleft') { advance(-1); ev.preventDefault(); }
    else if (k === 'c') { var c = rootEl.querySelector('[data-fo-call]'); if (c) { noteCall(); c.click(); } }
    else if (k === 't') { var x = rootEl.querySelector('[data-fo-text]'); if (x) x.click(); }
    else if (k === 's') { doSnooze(); }
    else if (k === 'd') { doDone(); }
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    rootEl = doc.createElement('div');
    rootEl.id = 'nbdFocusRoot';
    rootEl.className = 'fo-root';
    doc.body.appendChild(rootEl);
    rootEl.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    var refresh = function () { if (S.screen !== 'focus') render(); else render(); };
    ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded', 'nbd:estimate-followups'].forEach(function (n) { W.addEventListener(n, refresh); });
    unbind.push(function () {
      doc.removeEventListener('keydown', onKey);
      ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded', 'nbd:estimate-followups'].forEach(function (n) { W.removeEventListener(n, refresh); });
    });
    try {
      var raf = null;
      mo = new MutationObserver(function () { if (raf) return; raf = setTimeout(function () { raf = null; if (rootEl) K.setOverlay(rootEl, homeActive()); }, 60); });
      mo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) {}
    if (W.NBDToday && typeof W.NBDToday.refreshAppointments === 'function') { try { W.NBDToday.refreshAppointments(); } catch (e) {} }
    render();
    var tries = 0;
    timer = setInterval(function () { tries++; if (plan() || tries > 40) { render(); clearInterval(timer); timer = null; } }, 1500);
  }
  function unmount() {
    mounted = false;
    if (timer) clearInterval(timer);
    unbind.forEach(function (f) { try { f(); } catch (e) {} });
    unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    K.clearOverlay();
    S.screen = 'today'; S.i = 0; S.menu = false;
  }

  E.implement('focus', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
