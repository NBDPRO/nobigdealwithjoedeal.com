/**
 * os/widgets-p1.js — the NBD OS home's P1 widgets, read-only (2026-11-09, P1;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5, §6.1).
 *
 *   Needs you         the Today plan's own sections as counted groups (home-logic
 *                     needsYou), each one tap to where it is handled
 *   Storm             Storm Center's cached alert line (today-plan.js stormLine);
 *                     with no fresh alert it says which of none / stale / clear it is
 *   Closes this week  the CRM's own "What closes this week" ranking
 *                     (closes-week-logic.js rank, the Home card's inputs), names,
 *                     stage and reason; projected value only when the role sees money
 *   Money             what the member collected this month on their own invoices,
 *                     in cents, formatted by today-plan.js fmtCents; only for a role
 *                     that sees the Money view, never a viewer
 *   Smart Stack       up to 4 cards; os/stack-logic.js picks one (on show, unlock and
 *                     events, never a timer), with prev / next and "Why this?"
 *
 * Read cost 0: everything comes from memory or localStorage the CRM already
 * keeps (NBDToday.last(), _leads, _estimates, _notifications, NBDRevenue.cached(),
 * nbd_storm_alerts_cache). No fetch, no Firestore, no timers.
 *
 * Each renderer is (size, cfg, act, rec, kit) -> body markup; os/home.js calls it
 * inside its own try and owns the DOM, the events and edit mode. `kit` is
 * home.js's read helpers (esc, plan, leads, isViewer, hiddenId, moneyOk, urgency,
 * epoch, render, rowHtml). Every value goes in escaped; no style attributes.
 *
 * Loaded as the runtime ScriptLoader bundle 'oshomep1' (os/home.js registers it
 * on first use, after os/stack-logic.js), never at boot. window.NBDOSHomeP1.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  if (!W || W.NBDOSHomeP1) return;
  var HL = W.NBDOSHomeLogic;
  if (!HL) return;

  function title(t, extra) { return '<h3 class="os-hw-title">' + t + (extra || '') + '</h3>'; }
  function goBtn(k, go, label, cls) {
    return '<button type="button" class="' + k.esc(cls || 'btn btn-ghost os-hw-btn') + '" data-oshw-go="' + k.esc(go) + '">' + k.esc(label) + '</button>';
  }
  function lsJson(k) { try { var v = W.localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  // ── Needs you ──────────────────────────────────────────────
  function needsyou(size, cfg, act, rec, k) {
    var h = title('Needs you');
    var plan = k.plan();
    if (!plan) return h + '<p class="os-hw-empty">Loading your day…</p>';
    var u = k.urgency();
    var ny = HL.needsYou(plan, { money: k.moneyOk(), waiting: u });
    var groups = ny.groups.map(function (g) {
      // a view the role hides is not a tap-through: Today has every one of these rows
      return k.navHidden(g.go) ? { id: g.id, n: g.n, text: g.text, go: 'home' } : g;
    });
    if (!groups.length) {
      var c = k.counts();
      var unsure = k.apptsFailed() || !!(c && c.callsFailed);
      return h + '<p class="os-hw-empty">' + k.esc(unsure ? 'Can\'t confirm your day yet' : 'Nothing needs you right now') + '</p>';
    }
    if (size === 's') {
      return h + '<button type="button" class="os-hw-row os-hw-ny-big" data-oshw-go="home"><span class="os-hw-ny-n ui-num">' + k.esc(String(ny.total)) +
        '</span><span class="os-hw-row-sub">' + k.esc(ny.total === 1 ? 'thing needs you' : 'things need you') + '</span></button>';
    }
    // M: three rows, or two and a "+N more" line, so it fits its two phone rows
    var shown = size === 'l' || groups.length <= 3 ? groups : groups.slice(0, 2);
    h = title('Needs you', ' <span class="os-hw-count">' + k.esc(String(ny.total) + ' in all') + '</span>');
    h += '<div class="os-hw-rows">' + shown.map(function (g) {
      return '<button type="button" class="os-hw-row os-hw-ny-row' + (g.id === 'waiting' ? ' is-urgent' : '') + '" data-oshw-go="' + k.esc(g.go) + '">' +
        '<span class="os-hw-row-name">' + k.esc(g.text) + '</span></button>';
    }).join('') + '</div>';
    if (shown.length < groups.length) h += '<p class="os-hw-sub">' + k.esc('+' + String(groups.length - shown.length) + ' more on Today') + '</p>';
    if (size === 'l') h += goBtn(k, 'home', 'See your whole day');
    return h;
  }

  // ── Storm ──────────────────────────────────────────────────
  function storm(size, cfg, act, rec, k) {
    var h = title('Storm');
    var now = Date.now();
    var cache = lsJson('nbd_storm_alerts_cache');
    var st = HL.stormNow(cache, now);
    var P = W.NBDTodayPlan;
    var line = '';
    if (st.state === 'alert') {
      line = P && typeof P.stormLine === 'function' ? String(P.stormLine(cache, now) || '') : '';
      if (!line) line = st.event + (st.n > 1 ? ' +' + String(st.n - 1) + ' more' : '');
    }
    var open = k.navHidden('storm') ? '' : goBtn(k, 'storm', 'Open Storm Center');
    if (!line) {
      var msg = st.state === 'clear' ? 'No weather alerts at the last check' : (st.state === 'stale' ? 'No storm check in the last hour' : 'Storm Center hasn\'t checked yet');
      return h + '<p class="os-hw-empty">' + k.esc(msg) + '</p>' + (size === 's' ? '' : open);
    }
    h += '<p class="os-hw-storm-line">' + k.esc(line) + '</p>';
    if (size === 's') return h;
    h += '<p class="os-hw-sub">' + k.esc(st.ageMin ? 'Cached ' + String(st.ageMin) + ' min ago' : 'Cached just now') + '</p>';
    return h + open;
  }

  // ── Closes this week ──────────────────────────────────────
  var cwkAsked = false;
  function closesRows(k) {
    var Lg = W.NBDClosesWeekLogic;
    if (!Lg || typeof Lg.rank !== 'function') {
      // the CRM's own lazy bundle (today-home.js kicks it at boot): ask once, no Firestore
      var SL = W.ScriptLoader;
      if (!cwkAsked && SL && typeof SL.loadBundle === 'function') { cwkAsked = true; try { SL.loadBundle('closesweek'); } catch (e) {} }
      return null;
    }
    var leads = k.leads();
    if (!leads) return null;
    // the Home card's own inputs (closes-week.js compute)
    var views = (Array.isArray(W._notifications) ? W._notifications : []).filter(function (n) { return n && n.type === 'estimate_viewed' && n.leadId; })
      .map(function (n) { return { leadId: n.leadId, createdAt: n.createdAt }; });
    var deposit = [];
    try {
      var IP = W.InvoicePipeline, R = W.NBDRevenue, invs = R && typeof R.cached === 'function' ? R.cached() : null;
      if (IP && typeof IP.isDepositDraft === 'function' && Array.isArray(invs)) invs.forEach(function (i) { if (i && i.leadId && IP.isDepositDraft(i)) deposit.push(i.leadId); });
    } catch (e) { /* an optional signal */ }
    return Lg.rank(leads, { nowMs: Date.now(), estimates: Array.isArray(W._estimates) ? W._estimates : [], views: views, depositDraftLeadIds: deposit });
  }
  function centsOf(dollars) { var n = Number(dollars); return isFinite(n) && n > 0 ? Math.round(n * 100) : 0; }
  function closes(size, cfg, act, rec, k) {
    var h = title('Closes this week');
    var rows = closesRows(k);
    if (!rows) return h + '<p class="os-hw-empty">Ranking your open deals…</p>';
    if (!rows.length) return h + '<p class="os-hw-empty">No open estimates or deals with a value right now</p>';
    var money = k.moneyOk(), P = W.NBDTodayPlan;
    var fmt = money && P && typeof P.fmtCents === 'function' ? P.fmtCents : null;
    var shown = rows.slice(0, size === 'l' ? 5 : 3);
    h = title('Closes this week', ' <span class="os-hw-count">' + k.esc(String(rows.length) + ' open') + '</span>');
    h += '<div class="os-hw-rows">' + shown.map(function (r) {
      var c = centsOf(r.projectedValue);
      var sub = [r.stageLabel, fmt && c ? fmt(c) + ' projected' : '', size === 'l' ? r.reason : ''].filter(Boolean).join(' · ');
      return '<a class="os-hw-row" href="' + k.esc('/pro/customer.html?id=' + encodeURIComponent(String(r.leadId))) + '">' +
        '<span class="os-hw-row-name">' + k.esc(r.name) + '</span><span class="os-hw-row-sub">' + k.esc(sub) + '</span></a>';
    }).join('') + '</div>';
    if (size === 'l') h += '<p class="os-hw-note">Ranked by stage, last touch, estimate opens and follow-ups, a rule of thumb. Nothing is sent for you.</p>';
    return h;
  }

  // ── Money: the member's own, collected this month, in cents ──
  var lastMoney = null;   // { uid, mk, at, m }: this page's last counted month, for the gap after a refresh
  function clockOf(ms) {
    var L = W.NBDOSLogic;
    try { if (L && typeof L.clockText === 'function') return L.clockText(new Date(ms)).time; } catch (e) { /* below */ }
    var d = new Date(ms), hh = d.getHours() % 12 || 12, mm = d.getMinutes();
    return hh + ':' + (mm < 10 ? '0' : '') + mm + (d.getHours() < 12 ? ' AM' : ' PM');
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function money(size, cfg, act, rec, k) {
    var h = title('Money');
    if (!k.moneyOk()) return h + '<p class="os-hw-empty">Not shown for your role</p>';
    var R = W.NBDRevenue, P = W.NBDTodayPlan;
    var invs = R && typeof R.cached === 'function' ? R.cached() : null;
    var now = Date.now(), uid = k.uid(), month = MONTHS[new Date(now).getMonth()];
    var m = invs ? HL.moneyMonth(invs, uid, now, R.collectedBetween) : null;
    var asOf = '';
    if (m) lastMoney = { uid: uid, mk: HL.monthStart(now), at: now, m: m };
    else if (!invs && lastMoney && lastMoney.uid === uid && lastMoney.mk === HL.monthStart(now)) {
      // NBDRevenue drops its cache on every data refresh until the next invoice load: the last
      // count stands, with its time, instead of a blank (never a guess)
      m = lastMoney.m;
      asOf = clockOf(lastMoney.at);
    }
    if (!m) {
      var st = R && typeof R.status === 'function' ? R.status() : 'unknown';
      if (invs) return h + '<p class="os-hw-empty">Couldn\'t count payments</p>';
      return h + '<p class="os-hw-empty">' + (st === 'failed' ? 'Couldn\'t load payments' : 'Checking payments…') + '</p>';
    }
    if (!P || typeof P.fmtCents !== 'function') return h + '<p class="os-hw-empty">Couldn\'t count payments</p>';
    if (!m.count && !m.cents) return h + '<p class="os-hw-empty">' + k.esc(size === 's' ? 'No payments yet in ' + month : 'No payments on your invoices yet in ' + month) + '</p>' + (size === 's' ? '' : goBtn(k, 'money', 'Open Money'));
    h += '<button type="button" class="os-hw-row os-hw-money-big" data-oshw-go="money"><span class="os-hw-money-n ui-num">' + k.esc(P.fmtCents(m.cents)) + '</span>' +
      '<span class="os-hw-row-sub">' + k.esc('collected in ' + month) + '</span></button>';
    if (asOf) h += '<p class="os-hw-sub">' + k.esc('as of ' + asOf) + '</p>';
    if (size === 's') return h;
    return h + '<p class="os-hw-sub">' + k.esc(String(m.count) + (m.count === 1 ? ' payment' : ' payments') + ' on your own invoices') + '</p>';
  }

  // ── Smart Stack ────────────────────────────────────────────
  function stack(size, cfg, act, rec, k) {
    var SLg = W.NBDOSStackLogic;
    var cards = (rec.it.items || []).filter(function (id) { return HL.CATALOG[id] && !k.hiddenId(id) && k.has(id); });
    if (!SLg || !cards.length) return title('Smart Stack') + '<p class="os-hw-empty">' + (cards.length ? 'Loading…' : 'Nothing in this stack you can see') + '</p>';
    var st = rec.stack || (rec.stack = { cur: 0, rule: '', reason: '', focus: null, pickId: '', manual: false, why: false, epoch: 0 });
    // re-pick only on show, unlock and events (home.js bumps the epoch), never on a timer or an edit
    if (st.epoch !== k.epoch() || cards.indexOf(st.cardAt) === -1 || st.cards !== cards.join()) {
      var now = Date.now();
      var res = SLg.pick({ now: now, plan: k.plan(), storm: lsJson('nbd_storm_alerts_cache'), counts: { waiting: k.urgency() },
        dsSnapshot: k.dsNow(), dismissed: null, children: cards, shutdown: !!HL.CATALOG.shutdown });
      var idx = Math.max(0, cards.indexOf(res.childId));
      // a member who stepped to another card keeps it until a different rule fires
      if (!st.manual || res.rule !== st.rule || cards.indexOf(st.cardAt) === -1) { st.cur = idx; st.manual = false; }
      st.rule = res.rule; st.reason = res.reason; st.focus = res.focus; st.pickId = res.childId;
      st.epoch = k.epoch(); st.cards = cards.join();
    }
    st.cur = Math.min(st.cur, cards.length - 1);
    var id = cards[st.cur];
    st.cardAt = id;
    var child = HL.CATALOG[id];
    // a card is one size under the stack (the prev / next bar takes a row): M shows S cards, L shows
    // M cards; a card without that size takes its largest one under it, else its smallest
    var under = HL.SIZES.slice(0, HL.SIZES.indexOf(size)).reverse();
    var childSize = under.filter(function (z) { return child.sizes.indexOf(z) !== -1; })[0] || child.sizes[0];
    var picked = !st.manual && id === st.pickId;
    // the child paints with the stack's record (its open state, its focus) but its own size
    var inner = k.render(id, childSize, null, act, { it: { id: id, s: childSize }, el: rec.el, open: !!rec.open, focus: picked ? st.focus : null });
    var why = picked ? st.reason : 'You picked this card. The stack picks again when something changes.';
    var n = cards.length;
    var bar = '<div class="os-hw-stack-bar">' +
      (n > 1 ? '<button type="button" class="ui-btn-quiet os-hw-btn os-hw-stack-nav" data-oshw-stack="prev" aria-label="Previous card">‹</button>' : '') +
      '<span class="os-hw-stack-pos">' + k.esc(String(st.cur + 1) + ' of ' + String(n)) + '</span>' +
      (n > 1 ? '<button type="button" class="ui-btn-quiet os-hw-btn os-hw-stack-nav" data-oshw-stack="next" aria-label="Next card">›</button>' : '') +
      '<button type="button" class="ui-btn-quiet os-hw-btn os-hw-stack-why" data-oshw-stack="why" aria-expanded="' + (st.why ? 'true' : 'false') + '">Why this?</button>' +
      '</div>' + (st.why ? '<p class="os-hw-why">' + k.esc(why) + '</p>' : '');
    return '<div class="os-hw-stack-card os-hw-' + k.esc(id) + '">' + inner + '</div>' + bar;
  }
  /** prev / next / why on a stack: the card moves, nothing re-picks. */
  function stackTap(rec, what, cards) {
    var st = rec.stack;
    var SLg = W.NBDOSStackLogic;
    if (!st || !SLg) return;
    if (what === 'why') { st.why = !st.why; return; }
    if (cards < 2) return;
    st.cur = SLg.step(cards, st.cur, what === 'prev' ? -1 : 1);
    st.manual = true;
  }

  W.NBDOSHomeP1 = { needsyou: needsyou, storm: storm, closes: closes, money: money, stack: stack, stackTap: stackTap };
})();
