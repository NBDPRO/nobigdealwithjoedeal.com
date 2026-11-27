/**
 * call-center-filters-logic.js - the Call Center's date / direction / sort filters (pure, no DOM).
 *
 * Jo (2026-10-21): "a full filter system for the call center ... date selection or range, click today or most recent".
 * The existing category tabs (Needs attention / All / Customers / ...) and search stay; these narrow the SAME list by when
 * a call happened, which way it went, and the order. Dates are America/New_York calendar days, like the rest of the
 * Call Center (todayYmd). Loaded before call-center-view.js (lazy bundle 'callcenter').
 *
 * Filter object: { range, from, to, dir, status, sort }
 *   range: 'all' | 'today' | 'yesterday' | '24h' | '7d' | '30d' | 'custom'   (custom uses from / to, YYYY-MM-DD, either may be '')
 *   dir:   'all' | 'in' (they called) | 'out' (you called)   - text days have no direction, so any direction filter leaves them out
 *   status: 'all' | 'unhandled' | 'handled' | 'urgent' | 'promise' | 'missed'   (Horizon 3; Jo has NOT confirmed this exact set)
 *   'missed' is SHOWN as "Short calls": nothing writes `answered` yet and a truly unanswered call often has no recording, so it never
 *   reaches phone_calls. The id stays 'missed' (saved records keep working) until a real missed-call source exists.
 *   sort:  'new' | 'old'
 */
(function (root) {
  'use strict';

  const TZ = 'America/New_York';
  const DAY = 86400000;
  const RANGES = [['all', 'Any time'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Pick dates']];
  const DIRS = [['all', 'Either way'], ['in', 'They called'], ['out', 'You called']];
  const SORTS = [['new', 'Newest first'], ['old', 'Oldest first']];
  const STATUSES = [['all', 'Any status'], ['unhandled', 'Unhandled'], ['handled', 'Handled'], ['urgent', 'Urgent'], ['promise', 'Has promise'], ['missed', 'Short calls']];
  // One-tap views (Horizon 3): a named set of the filters above. They are not a second saved record - tapping one just sets the
  // one saved-filter record (nbd_cc_filters); the order (sort) is Jo's own and is kept.
  const VIEWS = [
    { id: 'missed-today', label: 'Short calls today', filter: { range: 'today', status: 'missed' } },
    { id: 'unhandled-week', label: 'Unhandled this week', filter: { range: '7d', status: 'unhandled' } },
  ];
  // Same cut-off the server uses to call a recording "short" (functions/call-center-logic.js SHORT_CALL_SEC).
  const MISSED_UNDER_SEC = 15;
  const KEY = 'nbd_cc_filters';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const ids = (list) => list.map((x) => x[0]);
  const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

  function defaults() { return { range: 'all', from: '', to: '', dir: 'all', status: 'all', sort: 'new' }; }

  /** Clean any input (stored JSON, a click) into a valid filter; a reversed custom range is swapped, junk is dropped. */
  function normalize(f) {
    const o = defaults();
    if (!f || typeof f !== 'object') return o;
    if (ids(RANGES).indexOf(f.range) > -1) o.range = f.range;
    if (ids(DIRS).indexOf(f.dir) > -1) o.dir = f.dir;
    if (ids(SORTS).indexOf(f.sort) > -1) o.sort = f.sort;
    if (ids(STATUSES).indexOf(f.status) > -1) o.status = f.status;
    o.from = isYmd(f.from) ? f.from : '';
    o.to = isYmd(f.to) ? f.to : '';
    if (o.from && o.to && o.from > o.to) { const t = o.from; o.from = o.to; o.to = t; }
    if (o.range === 'custom' && !o.from && !o.to) o.range = 'all';          // "Pick dates" with nothing picked is no filter
    if (o.range !== 'custom') { o.from = ''; o.to = ''; }
    return o;
  }

  /** The filter a view sets, keeping the caller's current sort; null for an unknown view id. */
  function applyView(id, current) {
    const v = VIEWS.filter((x) => x.id === id)[0];
    if (!v) return null;
    return normalize(Object.assign({}, v.filter, { sort: normalize(current).sort }));
  }
  /** Which view the filter currently IS (same range, status and direction "either way"); null when none. Sort is ignored. */
  function matchView(f) {
    f = normalize(f);
    const hit = VIEWS.filter((v) => { const w = normalize(v.filter); return w.range === f.range && w.status === f.status && w.dir === f.dir && w.from === f.from && w.to === f.to; })[0];
    return hit ? hit.id : null;
  }

  /** YYYY-MM-DD plus n days (calendar arithmetic, no DST drift). */
  function addDays(ymd, n) {
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /** The America/New_York calendar day of a timestamp, or '' for a missing/bad one. */
  function ymdOf(ms) {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    try { return new Date(n).toLocaleDateString('en-CA', { timeZone: TZ }); } catch (_) { return ''; }
  }

  /**
   * The inclusive day range a filter means, as { from, to } (either may be '' = open-ended), or null for "any time".
   * 24h is a rolling window, not days, so it returns null here and is handled by passes() with the clock.
   */
  function rangeOf(f, todayYmd) {
    f = normalize(f);
    switch (f.range) {
      case 'today': return { from: todayYmd, to: todayYmd };
      case 'yesterday': { const y = addDays(todayYmd, -1); return { from: y, to: y }; }
      case '7d': return { from: addDays(todayYmd, -6), to: todayYmd };
      case '30d': return { from: addDays(todayYmd, -29), to: todayYmd };
      case 'custom': return { from: f.from, to: f.to };
      default: return null;
    }
  }

  function isActive(f) { f = normalize(f); return f.range !== 'all' || f.dir !== 'all' || f.status !== 'all'; }

  /**
   * Missed = a call that came in and was not talked through: the phone says it was not answered, or the recording is
   * shorter than MISSED_UNDER_SEC. An unknown length (null / missing - not every call has a sidecar) is NOT missed, and an
   * outbound call or a day of texts never is.
   */
  function isMissed(c) {
    if (!c || c.channel === 'text' || c.direction !== 'inbound') return false;
    if (c.answered === false) return true;
    const d = c.durationSec;
    if (d === null || d === undefined || d === '' || typeof d === 'boolean') return false;
    const n = Number(d);
    return isFinite(n) && n >= 0 && n < MISSED_UNDER_SEC;
  }
  /** Still open: not handled, not personal, not done, not spam (the "closed" half of Needs attention, without its reasons). */
  function isOpen(c) { return !!c && !c.handledAtMs && c.status !== 'personal' && c.taskDone !== true && c.callType !== 'spam'; }
  function matchesStatus(c, status) {
    switch (status) {
      case 'unhandled': return isOpen(c);
      case 'handled': return !!c.handledAtMs;
      case 'urgent': return c.urgent === true;
      case 'promise': return Array.isArray(c.promises) && c.promises.length > 0;
      case 'missed': return isMissed(c);
      default: return true;
    }
  }

  /** Does this call or text day pass the date + direction filters? nowMs is for the rolling 24h window. */
  function passes(call, f, todayYmd, nowMs) {
    f = normalize(f);
    if (!call) return false;
    if (f.dir !== 'all') {
      if (call.channel === 'text') return false;                                     // a day of texts has no direction
      if (f.dir === 'in' && call.direction !== 'inbound') return false;
      if (f.dir === 'out' && call.direction !== 'outbound') return false;
    }
    if (f.status !== 'all' && !matchesStatus(call, f.status)) return false;
    if (f.range === 'all') return true;
    const t = Number(call.startedAtMs);
    if (!isFinite(t) || t <= 0) return false;                                          // no time -> cannot be placed in a range
    if (f.range === '24h') { const now = Number(nowMs) || Date.now(); return t <= now && t > now - DAY; }
    const r = rangeOf(f, todayYmd);
    const day = ymdOf(t);
    if (!day) return false;
    if (r.from && day < r.from) return false;
    if (r.to && day > r.to) return false;
    return true;
  }

  /** A copy of the list in the chosen order (never mutates). Calls with no time sort last either way. */
  function sortCalls(rows, order) {
    const list = (rows || []).slice();
    const key = (c) => { const t = Number(c && c.startedAtMs); return isFinite(t) && t > 0 ? t : null; };
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return order === 'old' ? x - y : y - x;
    });
    return list;
  }

  const fmtDay = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return MON[m - 1] + ' ' + d; };
  /** Words for the active filters, e.g. ["Oct 20 - Oct 21", "They called"]. [] when nothing is filtered. */
  function describe(f, todayYmd) {
    f = normalize(f);
    const parts = [];
    const label = { today: 'Today', yesterday: 'Yesterday', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' }[f.range];
    if (label) parts.push(label);
    else if (f.range === 'custom') {
      if (f.from && f.to) parts.push(f.from === f.to ? fmtDay(f.from) : fmtDay(f.from) + ' – ' + fmtDay(f.to));
      else if (f.from) parts.push('Since ' + fmtDay(f.from));
      else parts.push('Through ' + fmtDay(f.to));
    }
    if (f.dir === 'in') parts.push('They called');
    if (f.dir === 'out') parts.push('You called');
    const st = STATUSES.filter((s) => s[0] === f.status)[0];
    if (st && f.status !== 'all') parts.push(st[1]);
    return parts;
  }

  /**
   * Accessible names for the action buttons on a call card. Several cards each carry "Play" / "Handled" / "Promise", so a
   * screen reader needs to hear WHOSE: "Handled for Dana Smith". The leading glyph (▶ ✓ 📌 🏷 ＋) is dropped from the spoken name.
   */
  function actionLabel(text, who) {
    const t = String(text == null ? '' : text).replace(/^[^A-Za-z0-9]+/, '').replace(/…$/, '').replace(/\s+/g, ' ').trim();
    const w = String(who == null ? '' : who).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return w ? t + ' for ' + w : t;
  }

  /** Arrow-key roving across a row of tabs: the index to move to, or -1 for a key that is not ours. */
  function rove(key, index, count) {
    if (!count || count < 1) return -1;
    if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  }

  /**
   * The Call Center redraws its whole view on every click, which drops keyboard focus. This turns the focused control's
   * attributes into a selector that finds "the same control" after the redraw. attrs = { 'data-cc': 'range', 'data-arg': 'today' }
   * (only the keys in KEYS are used). '' when there is nothing to go on.
   */
  const FOCUS_KEYS = ['data-cc', 'data-arg', 'data-id', 'data-ids', 'data-cc-date', 'data-ccp', 'id'];
  function focusKey(attrs) {
    const a = attrs || {};
    const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const parts = FOCUS_KEYS.filter((k) => a[k] != null && a[k] !== '').map((k) => '[' + k + '="' + q(a[k]) + '"]');
    return parts.join('');
  }

  /** The one-line summary a screen reader hears after the list changes, e.g. "Showing 3 people, Needs attention, Today". */
  function liveSummary(shown, people, tabLabel, parts) {
    const noun = people ? (shown === 1 ? 'person' : 'people') : (shown === 1 ? 'call' : 'calls');
    return ['Showing ' + shown + ' ' + noun].concat(tabLabel ? [tabLabel] : [], parts || []).join(', ');
  }

  /** Read/write the saved choice (localStorage-shaped object; failures are ignored - filters are a convenience). */
  function load(storage) { try { return normalize(JSON.parse(storage.getItem(KEY))); } catch (_) { return defaults(); } }
  function save(storage, f) { try { storage.setItem(KEY, JSON.stringify(normalize(f))); } catch (_) { /* private mode */ } }

  // ── More ways to order the list (2026-11-20, phone sweep: Call Center compact view, behind callCenterCompact) ──
  // The saved FILTER record above (nbd_cc_filters) is untouched. These choices live in their own record, one for the list of
  // calls and one for the Needs attention list of PEOPLE, so Smart can be the default on Needs attention and Newest on All.
  const SORT_LIST = [['new', 'Newest first'], ['old', 'Oldest first'], ['urgent', 'Urgent first'], ['promise', 'Open promises first'],
    ['unhandled', 'Unhandled first'], ['waiting', 'Longest waiting'], ['long', 'Longest call'], ['name', 'Name A to Z'], ['repeat', 'Most calls from one number']];
  const SORT_PEOPLE = [['smart', 'Smart: urgent, promises, longest waiting'], ['new', 'Newest first'], ['old', 'Oldest first'], ['urgent', 'Urgent first'],
    ['promise', 'Promises first'], ['waiting', 'Longest waiting'], ['repeat', 'Most calls'], ['name', 'Name A to Z']];
  const SORT_KEY = 'nbd_cc_sort2';
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  const tOf = (c) => { const t = Number(c && c.startedAtMs); return isFinite(t) && t > 0 ? t : 0; };
  const keyOf = (c) => (c && c.leadId ? 'lead:' + c.leadId : (c && c.phoneDigits ? 'num:' + String(c.phoneDigits).slice(-10) : 'id:' + (c && c.id)));
  /**
   * When is a promise due? Dates are ISO (2026-11-23) or the words the AI notes use (today, tomorrow, a weekday), counted from the
   * day of the call. Anything else is Infinity: undated promises sort after dated ones, never first.
   */
  function dueMs(p, callMs) {
    const raw = String(p && p.due != null ? p.due : '').trim().toLowerCase();
    if (!raw) return Infinity;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { const t = Date.parse(raw + 'T12:00:00Z'); return isFinite(t) ? t : Infinity; }
    const base = Number(callMs) > 0 ? Number(callMs) : 0;
    if (!base) return Infinity;
    if (raw === 'today') return base;
    if (raw === 'tomorrow') return base + DAY;
    const wd = WEEKDAYS.indexOf(raw.slice(0, 3));
    if (wd > -1 && /^[a-z]+$/.test(raw)) { const cur = new Date(base).getUTCDay(); const add = (wd - cur + 7) % 7 || 7; return base + add * DAY; }
    return Infinity;
  }
  const firstDue = (calls) => {
    let best = Infinity, any = false;
    (calls || []).forEach((c) => (Array.isArray(c.promises) ? c.promises : []).forEach((p) => { any = true; best = Math.min(best, dueMs(p, tOf(c))); }));
    return { any, due: best };
  };
  const byName = (a, b) => (a === b ? 0 : !a ? 1 : !b ? -1 : a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const cmpChain = (fns) => (a, b) => { for (let i = 0; i < fns.length; i++) { const r = fns[i](a, b); if (r) return r; } return 0; };
  const newest = (ta, tb) => tb - ta;

  /**
   * The calls (or days of texts) in the chosen order, never mutating. `nameOf(call)` gives the name to sort by (the lead's name or the
   * contact name). Ties always fall back to newest first, so a reorder is never a shuffle.
   */
  function sortListBy(rows, id, nameOf) {
    const list = (rows || []).slice();
    const nm = typeof nameOf === 'function' ? (c) => String(nameOf(c) || '').trim() : () => '';
    const counts = {};
    if (id === 'repeat') list.forEach((c) => { const k = keyOf(c); counts[k] = (counts[k] || 0) + 1; });
    const tie = (a, b) => newest(tOf(a), tOf(b));
    const by = {
      new: (a, b) => newest(tOf(a), tOf(b)),
      old: (a, b) => { const x = tOf(a), y = tOf(b); return x && y ? x - y : (x ? -1 : y ? 1 : 0); },
      urgent: cmpChain([(a, b) => (b.urgent === true) - (a.urgent === true), tie]),
      promise: cmpChain([(a, b) => {
        const x = firstDue([a]), y = firstDue([b]);
        if (x.any !== y.any) return x.any ? -1 : 1;
        return x.due === y.due ? 0 : (x.due < y.due ? -1 : 1);
      }, tie]),
      unhandled: cmpChain([(a, b) => (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0), tie]),
      waiting: cmpChain([(a, b) => (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0), (a, b) => { if (!(isOpen(a) && isOpen(b))) return 0; const x = tOf(a), y = tOf(b); return x && y ? x - y : (x ? -1 : y ? 1 : 0); }, tie]),
      long: cmpChain([(a, b) => (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0), tie]),
      name: cmpChain([(a, b) => byName(nm(a), nm(b)), tie]),
      repeat: cmpChain([(a, b) => (counts[keyOf(b)] || 0) - (counts[keyOf(a)] || 0), tie]),
    };
    list.sort(by[id] || by.new);
    return list;
  }

  /** What a person (one card on Needs attention: { key, calls: [open calls] }) looks like to the sorts. */
  function personFacts(g) {
    const calls = (g && g.calls) || [];
    const ts = calls.map(tOf).filter((t) => t > 0);
    const fd = firstDue(calls);
    return { newest: ts.length ? Math.max.apply(null, ts) : 0, oldest: ts.length ? Math.min.apply(null, ts) : 0, urgent: calls.some((c) => c.urgent === true),
      promise: fd.any, due: fd.due, count: calls.length };
  }
  /** The people in the chosen order, never mutating. Smart = urgent first, then promises (soonest due), then the longest-waiting. */
  function sortPeopleBy(groups, id, nameOfGroup) {
    const list = (groups || []).slice();
    const nm = typeof nameOfGroup === 'function' ? (g) => String(nameOfGroup(g) || '').trim() : () => '';
    const F = new Map();
    list.forEach((g) => F.set(g, personFacts(g)));
    const f = (g) => F.get(g);
    const tie = (a, b) => newest(f(a).newest, f(b).newest);
    const urgent = (a, b) => (f(b).urgent ? 1 : 0) - (f(a).urgent ? 1 : 0);
    const promise = (a, b) => { const x = f(a), y = f(b); if (x.promise !== y.promise) return x.promise ? -1 : 1; return x.due === y.due ? 0 : (x.due < y.due ? -1 : 1); };
    const waiting = (a, b) => { const x = f(a).oldest, y = f(b).oldest; return x && y ? x - y : (x ? -1 : y ? 1 : 0); };
    const by = {
      smart: cmpChain([urgent, promise, waiting, tie]),
      new: tie,
      old: (a, b) => { const x = f(a).newest, y = f(b).newest; return x && y ? x - y : (x ? -1 : y ? 1 : 0); },
      urgent: cmpChain([urgent, tie]),
      promise: cmpChain([promise, tie]),
      waiting: cmpChain([waiting, tie]),
      repeat: cmpChain([(a, b) => f(b).count - f(a).count, tie]),
      name: cmpChain([(a, b) => byName(nm(a), nm(b)), tie]),
    };
    list.sort(by[id] || by.smart);
    return list;
  }
  /** One short word for WHY a person sits where they do under Smart: 'Urgent', 'Promise due Nov 24', 'Waiting 3 days', or ''. */
  function smartReason(g, nowMs) {
    const x = personFacts(g);
    if (x.urgent) return 'Urgent';
    if (x.promise) return isFinite(x.due) ? 'Promise due ' + (function (t) { const d = new Date(t); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); })(x.due) : 'Has a promise';
    const now = Number(nowMs) || Date.now();
    if (x.oldest && now - x.oldest >= DAY) { const n = Math.floor((now - x.oldest) / DAY); return 'Waiting ' + n + (n === 1 ? ' day' : ' days'); }
    return '';
  }

  /** The two saved choices { list, people }; junk or a missing value becomes the default (Newest for the list, Smart for people). */
  function normalizeSort(s) {
    const o = { list: 'new', people: 'smart' };
    if (s && typeof s === 'object') {
      if (ids(SORT_LIST).indexOf(s.list) > -1) o.list = s.list;
      if (ids(SORT_PEOPLE).indexOf(s.people) > -1) o.people = s.people;
    }
    return o;
  }
  function loadSort(storage) { try { return normalizeSort(JSON.parse(storage.getItem(SORT_KEY))); } catch (_) { return normalizeSort(null); } }
  function saveSort(storage, s) { try { storage.setItem(SORT_KEY, JSON.stringify(normalizeSort(s))); } catch (_) { /* private mode */ } }

  const api = { actionLabel, rove, focusKey, liveSummary, KEY, RANGES, DIRS, STATUSES, VIEWS, applyView, matchView, SORTS, MISSED_UNDER_SEC, isMissed, matchesStatus, defaults, normalize, addDays, ymdOf, rangeOf, isActive, passes, sortCalls, describe, load, save };
  Object.assign(api, { SORT_LIST, SORT_PEOPLE, SORT_KEY, sortListBy, sortPeopleBy, smartReason, normalizeSort, loadSort, saveSort, dueMs });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCallCenterFilters = api;
})(typeof window !== 'undefined' ? window : null);
