/**
 * os/team.js — the NBD OS Team widget (2026-11-09, P2; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5, §8 P2).
 *
 * The owner's view of the team: counted doors, appointments set, estimates sent
 * and deals won, today and this week, from the company's leaderboard/{uid} rows
 * (functions/leaderboard-aggregate.js, every 30 minutes, in the company's time
 * zone). Read through team-board-logic.js (window.NBDTeamBoard), which shows a
 * row's numbers only for the day / week they were counted in.
 *   S  the team's doors today (else this week, labelled so)
 *   M  today's totals and the top three by doors today (else this week)
 *   L  today's and this week's totals, up to six people by doors this week,
 *      when it was counted, and the full Leaderboard
 * Owner-only: home.js never paints it for anyone else (catalog owner:true).
 *
 * Reads: one query, leaderboard where companyId == the claim, limit 50 (a solo
 * owner with no claim: their own row, one getDoc), only from a paint, at most
 * every 5 minutes; no timer, no listener. A refused read shows Retry. Missing or
 * stale rows show a plain line and no number.
 *
 * Loaded as the runtime ScriptLoader bundle 'osteam' that os/home.js registers
 * (css/os/team.css, team-board-logic.js, this file). Every value escaped; no
 * style attributes, no inline handlers.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  if (!W || W.NBDOSTeam) return;

  var REFRESH_MS = 5 * 60000;
  var LEADERBOARD = '/pro/leaderboard.html';
  var S = { rows: null, at: 0, state: '', inflight: false };   // state: '' | 'loading' | 'ok' | 'failed'

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  function line(m) {
    return [plural(m.doors, 'door', 'doors'), plural(m.appts, 'appointment', 'appointments'),
      plural(m.estimates, 'estimate', 'estimates'), plural(m.deals, 'deal', 'deals')].join(' · ');
  }

  function fetchRows() {
    var db = W.db || W._db;
    var uid = String((W._user && W._user.uid) || '');
    var cid = String((W._userClaims || {}).companyId || '');
    if (!db || !uid || typeof W.collection !== 'function' || typeof W.getDocs !== 'function') return Promise.reject(new Error('Firestore not ready'));
    if (cid) {
      if (typeof W.query !== 'function' || typeof W.where !== 'function' || typeof W.limit !== 'function') return Promise.reject(new Error('Firestore not ready'));
      return W.getDocs(W.query(W.collection(db, 'leaderboard'), W.where('companyId', '==', cid), W.limit(50))).then(function (snap) {
        return (snap && snap.docs ? snap.docs : []).map(function (d) { var r = d.data() || {}; r.uid = r.uid || d.id; return r; });
      });
    }
    if (typeof W.getDoc !== 'function' || typeof W.doc !== 'function') return Promise.reject(new Error('Firestore not ready'));
    return W.getDoc(W.doc(db, 'leaderboard', uid)).then(function (s) {
      var ex = s && (typeof s.exists === 'function' ? s.exists() : !!s.exists);
      return ex ? [Object.assign({ uid: uid }, s.data() || {})] : [];
    });
  }
  /** Read when the cache is older than 5 minutes (or never read); repaint through nbd:os-team. */
  function ensure() {
    if (S.inflight || (S.state === 'ok' && Date.now() - S.at < REFRESH_MS) || S.state === 'failed') return;
    S.inflight = true;
    if (S.state !== 'ok') S.state = 'loading';
    Promise.resolve().then(fetchRows).then(function (rows) {
      S.rows = rows; S.at = Date.now(); S.state = 'ok';
    }, function () {
      // a failed refresh keeps the last good rows and waits the 5-minute floor too (else every
      // repaint it triggers would read again, a microtask loop that never yields)
      S.at = Date.now();
      S.state = S.rows ? 'ok' : 'failed';
    }).then(function () {
      S.inflight = false;
      try { W.dispatchEvent(new W.CustomEvent('nbd:os-team')); } catch (e) {}
    });
  }
  function retry() { S.state = ''; S.at = 0; ensure(); }

  function timeOf(ms, tz) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); } catch (e) { return ''; }
  }
  function people(list, k, max) {
    return '<ul class="os-tm-people">' + list.slice(0, max).map(function (r) {
      return '<li class="os-tm-person"><span class="os-tm-name">' + esc(r.name || 'Teammate') + '</span>' +
        '<span class="os-tm-num">' + esc(plural(r.doors, 'door', 'doors') + ' · ' + plural(r.deals, 'deal', 'deals')) + '</span></li>';
    }).join('') + '</ul>';
  }

  function widget(size, cfg, kit) {
    var TB = W.NBDTeamBoard;
    var h = '<h3 class="os-hw-title">Team</h3>';
    ensure();
    if (!TB) return h + '<p class="os-hw-empty">Loading…</p>';
    if (S.state === 'failed') {
      return h + '<p class="os-hw-fail">Couldn\'t load · <button type="button" class="ui-btn-quiet os-hw-btn os-hw-retry" data-oshw-retry="team">Retry</button></p>';
    }
    if (!S.rows) return h + '<p class="os-hw-empty">Loading…</p>';
    var now = Date.now();
    var today = TB.board(S.rows, 'day', now, 'doors');
    var week = TB.board(S.rows, 'week', now, 'doors');
    if (!S.rows.length) return h + '<p class="os-hw-empty">Team numbers show here once they are counted. They update every half hour.</p>';
    if (!today.length && !week.length) return h + '<p class="os-hw-empty">This week\'s team numbers have not been counted yet.</p>';
    var useToday = today.length > 0;
    var list = useToday ? today : week;
    var t = TB.totals(list);
    var when = useToday ? 'today' : 'this week';
    if (size === 's') {
      return h + '<div class="os-tm-big ui-num">' + esc(String(t.doors)) + '</div><p class="os-hw-sub">' + esc((t.doors === 1 ? 'door ' : 'doors ') + when) + '</p>';
    }
    if (size === 'm') {
      return h + '<div class="os-tm-label">' + esc(useToday ? 'Today' : 'This week') + '</div>' +
        '<div class="os-tm-line">' + esc(line(t)) + '</div>' + people(list, 'doors', 3);
    }
    var tz = (S.rows[0] && S.rows[0].tz) || undefined;
    var asOf = TB.asOf(S.rows);
    var out = h;
    if (today.length) out += '<div class="os-tm-label">Today</div><div class="os-tm-line">' + esc(line(TB.totals(today))) + '</div>';
    else out += '<div class="os-tm-label">Today</div><p class="os-hw-sub">Not counted yet today.</p>';
    if (week.length) out += '<div class="os-tm-label">This week</div><div class="os-tm-line">' + esc(line(TB.totals(week))) + '</div>' + people(week, 'doors', 6);
    var at = asOf ? timeOf(asOf, tz) : '';
    if (at) out += '<p class="os-hw-sub">' + esc('Updated ' + at) + '</p>';
    out += '<a class="btn btn-ghost os-hw-btn os-tm-open" href="' + esc(LEADERBOARD) + '">Open leaderboard</a>';
    return out;
  }

  W.NBDOSTeam = { widget: widget, retry: retry, state: function () { return { state: S.state, at: S.at, n: S.rows ? S.rows.length : null }; } };
})();
