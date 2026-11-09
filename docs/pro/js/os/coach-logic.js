/**
 * os/coach-logic.js — the NBD OS home's Coach, rules first (2026-11-09, P0c;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2).
 *
 * Pure: no DOM, no clock, no storage, no network (tests/nbd-os-coach-2026-11-09.test.js
 * runs it in plain Node). os/home.js passes in what the CRM already holds in
 * memory and writes the dismiss / snooze memo to localStorage itself.
 *
 *   evaluate({ plan, leads, roleOf, labelOf, ds, nowMs, show }) -> rules, highest priority first
 *     plan    NBDToday.last() (never compute(): it mutates the handled-call state)
 *     leads   window._leads; roleOf the CRM's tenant-aware stageRole, labelOf its stageLabel
 *     ds      the validated same-day Daily Success snapshot (home-logic dsPersonal)
 *     show    'both' | 'business' | 'personal' (the widget's cfg)
 *   Each rule is { id, half, priority, tpl, text, evidence, action:{ label, href | go } }.
 *   `text` is `tpl` filled ONLY from `evidence` (fill()): the templates hold no
 *   digits, so every number on screen is a number the rule counted. A rule
 *   with no data to count never fires; it never says "0".
 *
 *   v1 rules (read cost 0):
 *     missed-calls  missed calls still open in the Today plan, split at 30 minutes
 *                   (the "Call back now" rule of home-strips.js, re-implemented
 *                   here on the plan's own call rows, so that lazy bundle is not
 *                   loaded at paint)
 *     overdue       promises past due (with their miss count) and follow-ups
 *                   past due (Today's Promised and Stalled rows)
 *     estimates     estimates out 5+ / 10+ days with no answer (Today's estimate
 *                   rows, estimate-followups.js buckets d5 / d10)
 *     ds-warned     Daily Success: yesterday's floors were missed (streak.warned)
 *     stuck-new     leads whose stage ROLE is "new" (the tenant's own stage
 *                   names, never the NBD stage name) and created 30+ days ago; the
 *                   text names that stage by the tenant's label, else "your first stage"
 *
 *   pick(rules, memo, dayKey, nowMs) -> { shown, memo }
 *     drops what was dismissed today or is snoozed, rests a rule that topped
 *     the card 3 days running, and counts today's top rule. dismiss() / snooze()
 *     return the next memo: { d: dayKey, off:{ id: 0 (today) | untilMs }, run:{ id:{ last, n } } }
 *     (rule ids and dates only).
 *
 * The AI focus line is P2 and not here: nothing in this file calls a server.
 * Classic script: window.NBDOSCoachLogic; require()-able for tests. Loaded
 * lazily with the OS layout (layout-system.js `needs`), never at boot.
 */
(function (root) {
  'use strict';

  var WINDOW_MIN = 30;        // a missed call is "fresh" for 30 minutes (home-strips.js WINDOW_MS)
  var NEW_DAYS = 30;          // New for 30+ days is stuck
  var EST_DAYS = { d5: 5, d10: 10 };
  var SNOOZE_MS = 2 * 3600000;
  var MAX_RUN = 3;            // the same rule tops the card at most 3 days running
  var DAY = 86400000;
  var HALVES = ['both', 'business', 'personal'];

  function arr(v) { return Array.isArray(v) ? v : []; }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function whole(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (t instanceof Date) return isFinite(t.getTime()) ? t.getTime() : 0;
    if (typeof t.toMillis === 'function') { var v = t.toMillis(); return isFinite(v) ? v : 0; }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t === 'string') { var p = Date.parse(t); return isFinite(p) ? p : 0; }
    return 0;
  }
  function digits10(v) { var d = String(v == null ? '' : v).replace(/\D/g, ''); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d.length === 10 ? d : ''; }

  /** '{n} {n?lead:leads}' with { n: 2 } -> '2 leads'. Values come from evidence only. */
  function fill(tpl, ev) {
    var e = ev || {};
    return String(tpl).replace(/\{(\w+)(?:\?([^:}]*):([^}]*))?\}/g, function (_, k, one, many) {
      if (one !== undefined) return e[k] === 1 ? one : many;
      return e[k] == null ? '' : String(e[k]);
    });
  }
  function leadAction(id, label) { return { label: label, href: '/pro/customer.html?id=' + encodeURIComponent(String(id)) }; }
  function rule(id, half, priority, tpl, evidence, action) {
    return { id: id, half: half, priority: priority, tpl: tpl, text: fill(tpl, evidence), evidence: evidence, action: action };
  }

  // ── the rules ─────────────────────────────────────────────────
  function missedCalls(plan, now) {
    if (!isObj(plan) || !now) return null;
    var rows = arr(plan.calls).filter(function (r) {
      var t = isObj(r) && r.missed === true ? toMs(r.latestMs) : 0;
      return t > 0 && t <= now + 60000;
    });
    if (!rows.length) return null;
    var fresh = rows.filter(function (r) { return now - toMs(r.latestMs) <= WINDOW_MIN * 60000; }).length;
    var ev = { fresh: fresh, late: rows.length - fresh, minutes: WINDOW_MIN };
    var tpl = fresh
      ? '{fresh} missed {fresh?call:calls} in the last {minutes} min. Call back first.' + (ev.late ? ' · {late} older' : '')
      : '{late} missed {late?call:calls} not called back within {minutes} min';
    var tel = rows.length === 1 ? digits10(rows[0].phone) : '';
    var action = tel ? { label: 'Call back', href: 'tel:+1' + tel }
      : (rows.length === 1 && rows[0].leadId ? leadAction(rows[0].leadId, 'Open') : { label: 'Open calls', go: 'calls' });
    return rule('missed-calls', 'business', fresh ? 100 : 85, tpl, ev, action);
  }
  function overdue(plan) {
    if (!isObj(plan)) return null;
    var prom = arr(plan.promises).filter(function (r) { return isObj(r) && arr(r.promiseTasks).some(function (t) { return isObj(t) && t.overdue === true; }); });
    var fu = arr(plan.promised).filter(function (r) { return isObj(r) && r.overdue === true; })
      .concat(arr(plan.stalled).filter(function (r) { return isObj(r) && whole(r.daysLate) > 0; }));
    if (!prom.length && !fu.length) return null;
    var missed = prom.reduce(function (n, r) { return n + whole(r.missTotal); }, 0);
    var ev = { promises: prom.length, followUps: fu.length };
    if (missed) ev.missed = missed;
    var parts = [];
    if (prom.length) parts.push(missed ? '{promises} overdue {promises?promise:promises}, missed {missed} {missed?time:times}' : '{promises} overdue {promises?promise:promises} to keep');
    if (fu.length) parts.push('{followUps} {followUps?follow-up:follow-ups} past due');
    var all = prom.concat(fu);
    var action = all.length === 1 && all[0].leadId ? leadAction(all[0].leadId, 'Open') : { label: 'See them', go: 'home' };
    return rule('overdue', 'business', 90, parts.join(' · '), ev, action);
  }
  function estimates(plan) {
    if (!isObj(plan)) return null;
    var rows = arr(plan.estimates).filter(function (r) { return isObj(r) && (r.bucket === 'd5' || r.bucket === 'd10'); });
    if (!rows.length) return null;
    var n10 = rows.filter(function (r) { return r.bucket === 'd10'; }).length;
    var n5 = rows.length - n10;
    var ev = {};
    var tpl;
    if (n10) {
      ev.over10 = n10; ev.days10 = EST_DAYS.d10;
      tpl = '{over10} {over10?estimate:estimates} out {days10}+ days, no answer';
      if (n5) { ev.over5 = n5; ev.days5 = EST_DAYS.d5; tpl += ' · {over5} out {days5}+'; }
    } else {
      ev.over5 = n5; ev.days5 = EST_DAYS.d5;
      tpl = '{over5} {over5?estimate:estimates} out {days5}+ days, no answer';
    }
    var action = rows.length === 1 && rows[0].leadId ? leadAction(rows[0].leadId, 'Follow up') : { label: 'Follow up', go: 'home' };
    return rule('estimates', 'business', 70, tpl, ev, action);
  }
  function dsWarned(ds) {
    if (!isObj(ds) || ds.warned !== true) return null;
    // floors count Mon-Sat (review-logic.js floorStreak): on a Monday the missed workday is Saturday
    var mon = typeof ds.dk === 'string' && new Date(ds.dk + 'T12:00:00').getDay() === 1;
    return rule('ds-warned', 'personal', 60, 'You missed your floors ' + (mon ? 'on Saturday' : 'yesterday') + '. Don\'t miss twice.', { warned: true },
      { label: 'Open Daily Success', href: '/pro/daily-success/' });
  }
  function roleFor(l, roleOf) {
    if (typeof l._stageRole === 'string' && l._stageRole) return l._stageRole;
    if (typeof roleOf !== 'function') return '';
    try { return String(roleOf(l._stageKey || l.stage || '') || ''); } catch (e) { return ''; }
  }
  /** The tenant's own name for the stage the stuck leads share (labelOf: the CRM's stageLabel), '' when they differ or it has digits. */
  function stageName(stuck, labelOf) {
    if (typeof labelOf !== 'function') return '';
    var keys = stuck.map(function (l) { return String(l._stageKey || l.stage || ''); });
    if (!keys[0] || keys.some(function (k) { return k !== keys[0]; })) return '';
    var name;
    try { name = String(labelOf(keys[0]) || '').trim(); } catch (e) { return ''; }
    // stageLabel falls back to the raw key when a stage has no label: a slug is not a name
    if (name.toLowerCase() === keys[0].toLowerCase() && /[-_]|^[a-z]/.test(name)) return '';
    if (/_/.test(name)) return '';
    return name && name.length <= 40 && !/\d/.test(name) ? name : '';
  }
  function stuckNew(leads, roleOf, now, labelOf) {
    if (!Array.isArray(leads) || !now) return null;
    var stuck = leads.filter(function (l) {
      if (!isObj(l) || l.deleted === true || l.e2eTestData) return false;
      var at = toMs(l.createdAt);
      return at > 0 && now - at >= NEW_DAYS * DAY && roleFor(l, roleOf) === 'new';
    });
    if (!stuck.length) return null;
    var action = stuck.length === 1 && stuck[0].id != null ? leadAction(stuck[0].id, 'Open') : { label: 'Open pipeline', go: 'crm' };
    var ev = { leads: stuck.length, days: NEW_DAYS };
    var name = stageName(stuck, labelOf);
    if (name) ev.stage = name;
    return rule('stuck-new', 'business', 40, '{leads} {leads?lead:leads} still in ' + (name ? '{stage}' : 'your first stage') + ' after {days}+ days', ev, action);
  }

  function evaluate(input) {
    var x = isObj(input) ? input : {};
    var now = whole(x.nowMs);
    var show = HALVES.indexOf(x.show) !== -1 ? x.show : 'both';
    var out = [missedCalls(x.plan, now), overdue(x.plan), estimates(x.plan), dsWarned(x.ds), stuckNew(x.leads, x.roleOf, now, x.labelOf)]
      .filter(function (r) { return r && (show === 'both' || r.half === show); });
    return out.sort(function (a, b) { return b.priority - a.priority || (a.id < b.id ? -1 : 1); });
  }

  // ── dismiss / snooze / 3 days running ─────────────────────────
  function isDk(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  function prevDay(dk) {
    var p = dk.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2] - 1);
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate();
  }
  /** A memo safe to use for `dk`: today's offs, every rule's run record. */
  function cleanMemo(raw, dk) {
    var m = isObj(raw) ? raw : {};
    var out = { d: dk, off: {}, run: {} };
    if (m.d === dk && isObj(m.off)) Object.keys(m.off).forEach(function (id) {
      var v = m.off[id];
      if (/^[a-z-]{1,24}$/.test(id) && typeof v === 'number' && isFinite(v) && v >= 0) out.off[id] = v;
    });
    if (isObj(m.run)) Object.keys(m.run).forEach(function (id) {
      var r = m.run[id];
      if (/^[a-z-]{1,24}$/.test(id) && isObj(r) && isDk(r.last) && whole(r.n)) out.run[id] = { last: r.last, n: Math.min(whole(r.n), MAX_RUN) };
    });
    return out;
  }
  function pick(rules, memo, dk, nowMs) {
    var m = cleanMemo(memo, dk);
    var now = whole(nowMs);
    var yday = isDk(dk) ? prevDay(dk) : '';
    var shown = arr(rules).filter(function (r) {
      if (!r || !r.id) return false;
      var off = m.off[r.id];
      if (off === 0 || (off && off > now)) return false;
      var run = m.run[r.id];
      return !(run && run.last === yday && run.n >= MAX_RUN);
    });
    var top = shown[0];
    if (top && isDk(dk)) {
      var run = m.run[top.id];
      if (!run || run.last !== dk) m.run[top.id] = { last: dk, n: run && run.last === yday ? Math.min(run.n + 1, MAX_RUN) : 1 };
    }
    return { shown: shown, memo: m };
  }
  function dismiss(memo, id, dk) { var m = cleanMemo(memo, dk); m.off[id] = 0; return m; }
  function snooze(memo, id, dk, nowMs) { var m = cleanMemo(memo, dk); m.off[id] = whole(nowMs) + SNOOZE_MS; return m; }

  var api = {
    WINDOW_MIN: WINDOW_MIN, NEW_DAYS: NEW_DAYS, SNOOZE_MS: SNOOZE_MS, MAX_RUN: MAX_RUN, HALVES: HALVES,
    fill: fill, evaluate: evaluate, pick: pick, dismiss: dismiss, snooze: snooze, cleanMemo: cleanMemo,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSCoachLogic = api;
})(typeof window !== 'undefined' ? window : null);
