/**
 * review-ui.js — the Sunday review (Jo's operating system, Build 1,
 * 2026-10-02). Rules: review-logic.js.
 *
 *   📋 card on the program dashboard: the floor streak ("don't miss twice"),
 *   the goal-weight bar, and — on Sundays until it's done — "Start your
 *   Sunday review".
 *
 *   The review sheet, top to bottom (about 10 minutes):
 *     1. Floors this week: each floor out of 7, full days, the $5 miss tax
 *        and a "moved it to savings" tick (Jo moves the money himself).
 *     2. Weigh-in rule: 7-day average vs last week; not down 0.5 lb → cut
 *        200 calories, one tap writes the new Food-card target.
 *     3. Last week's hard thing: done or not done, on the record.
 *     4. Promise audit: what I kept / where I bailed.
 *     5. This week's one hard thing, with a deadline.
 *     Save → the week is stored (nbd_ds_reviews, synced to
 *     userSettings.dsReviews) and the scorecard is ready to copy.
 *
 * Classic script after app.js (getFloors, pages, todayKey by name) and the
 * tracker-history + food-log logic. Delegated listeners; every value that
 * reaches innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDReviewUI) return;
  /* global pages, getFloors */
  const R = () => window.NBDReview;
  const H = () => window.NBDTrackerHistory;
  const KEY = 'nbd_ds_reviews';
  const FOOD = 'nbd_ds_food';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const allPages = () => (typeof pages !== 'undefined' && Array.isArray(pages) ? pages : []);
  const floors = () => { try { return typeof getFloors === 'function' ? getFloors() : []; } catch (_) { return []; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : R().addDays(new Date().toISOString().slice(0, 10), 0));
  const MISS_TAX_CENTS = 500;

  function store() {
    const v = readJson(KEY, {});
    return { goal: v.goal && typeof v.goal === 'object' ? v.goal : {}, weeks: v.weeks && typeof v.weeks === 'object' ? v.weeks : {} };
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { toast('Could not save on this device'); return false; }
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(KEY);
    return true;
  }
  function trend() { return H() ? H().weightTrend(H().weightSeries(allPages()), today()) : null; }
  function calTarget() { const f = readJson(FOOD, {}); return Number(f && f.targets && f.targets.calories) || null; }

  function snapshot() {
    const s = store();
    const t = trend();
    const fl = floors();
    return {
      s, t, fl,
      streak: R().floorStreak(allPages(), fl, today()),
      week: R().weekFloors(allPages(), fl, today(), MISS_TAX_CENTS),
      weight: R().weightRule(t, calTarget()),
      goal: R().goalProgress(t, Number(s.goal.start) || null, Number(s.goal.goal) || null),
      due: R().reviewDue(today(), s.weeks),
      last: R().lastReview(s.weeks, today()),
    };
  }

  // ── publish for the personal bots (Build 3) ───────────────────────────
  // What the screen shows, written to nbd_ds_snapshot → userSettings
  // .dsSnapshot, where Jo's personal Coach / Finance Board key reads it.
  // Unchanged → not re-written (the signature skips the timestamp).
  const SNAP = 'nbd_ds_snapshot';
  function publish() {
    try {
      const x = snapshot();
      const saved = x.s.weeks[today()] || {};
      const card = R().scorecardText({
        from: x.week.from, to: x.week.to, floors: x.fl.length ? x.week : null, taxMoved: !!saved.taxMoved, streak: x.streak,
        weight: x.weight, goal: x.goal,
        lastScary: x.last && x.last.scary ? { text: x.last.scary, done: typeof saved.lastDone === 'boolean' ? saved.lastDone : null } : null,
        kept: saved.kept, bailed: saved.bailed, scary: saved.scary, scaryDue: saved.scaryDue,
      });
      const doc = R().snapshotDoc({ floors: x.fl, byDayToday: R().metByDay(allPages(), x.fl).get(today()), todayDk: today(),
        streak: x.streak, week: x.week, trend: x.t, rule: x.weight, goal: x.goal, scorecard: card }, Date.now());
      const prev = readJson(SNAP, null);
      if (prev && prev.sig === doc.sig) return false;
      localStorage.setItem(SNAP, JSON.stringify(doc));
      if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(SNAP);
      return true;
    } catch (_) { return false; /* the tracker works without it */ }
  }

  // ── dashboard card ─────────────────────────────────────────────────────
  function cardHtml() {
    if (!R()) return '';
    const x = snapshot();
    const st = x.streak;
    const streakLine = !x.fl.length ? 'Set your daily floors (⚙️ Customize) to start a streak.'
      : st.broken ? 'Two misses in a row ended the streak. Today is day one.'
      : st.warned ? '⚠️ Missed yesterday — don\'t miss twice. Today keeps the streak alive.'
      : st.todayMet ? 'All floors met today. 🔒' : 'Floors still open today.';
    const goal = x.goal ? '<div class="rv-goal"><div class="rv-goal-bar"><i class="rv-goal-fill" data-pct="' + Math.round(x.goal.pct * 100) + '"></i></div>' +
      '<div class="wc-meta">' + esc(x.goal.now.toFixed(1)) + ' → ' + esc(x.goal.goal) + ' lb · ' + esc(x.goal.left) + ' to go</div></div>' : '';
    const cta = x.due.due ? '<button type="button" class="btn rv-start" data-rv-action="open">📋 Start your Sunday review</button>'
      : '<button type="button" class="btn btn-ghost rv-open" data-rv-action="open">' + (x.due.done ? '📋 This week\'s review (done)' : '📋 Weekly review') + '</button>';
    return '<div class="wc-card rv-card" id="rvCard"><div class="wc-card-h">🔥 Floor streak <span class="rv-count">' + esc(st.count) + '</span></div>' +
      '<div class="wc-meta' + (st.warned ? ' rv-warn' : '') + '">' + esc(streakLine) + '</div>' + goal + cta + '</div>';
  }
  function paintGoalBars(root) {
    (root || document).querySelectorAll('.rv-goal-fill[data-pct]').forEach((el) => { el.style.width = Math.max(0, Math.min(100, Number(el.dataset.pct) || 0)) + '%'; });
  }

  // ── the review sheet ───────────────────────────────────────────────────
  let _x = null;
  function sheet() {
    let el = document.getElementById('rvOverlay');
    if (!el) { el = document.createElement('div'); el.id = 'rvOverlay'; el.className = 'wc-ov'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Weekly review'); document.body.appendChild(el); }
    return el;
  }
  function open() {
    if (!R()) return;
    _x = snapshot();
    const x = _x, w = x.week, saved = x.s.weeks[today()] || {};
    const rows = w.rows.map((r) => '<div class="rv-row"><span>' + esc(r.label) + '</span><b class="' + (r.hit >= 6 ? 'rv-good' : r.hit <= 3 ? 'rv-bad' : '') + '">' + r.hit + '/' + r.of + '</b></div>').join('');
    const wt = x.weight;
    const lastScary = x.last && x.last.scary ? '<div class="wc-lbl">Last week\'s hard thing</div><div class="rv-quote">"' + esc(x.last.scary) + '"' + (x.last.scaryDue ? ' <small>by ' + esc(x.last.scaryDue) + '</small>' : '') + '</div>' +
      '<div class="rv-yn"><label><input type="radio" name="rvLastDone" value="yes"' + (saved.lastDone === true ? ' checked' : '') + '> Done</label>' +
      '<label><input type="radio" name="rvLastDone" value="no"' + (saved.lastDone === false ? ' checked' : '') + '> Not done</label></div>' : '';
    const el = sheet();
    el.innerHTML = '<div class="wc-box"><div class="wc-top"><button class="wc-x" data-rv-action="close" aria-label="Close">✕</button>' +
      '<div class="wc-title">Weekly review</div><span></span></div>' +
      '<div class="wc-hint">' + esc(w.from) + ' → ' + esc(w.to) + '</div>' +
      '<div class="wc-lbl">1 · Floors</div>' +
      (w.rows.length ? '<div class="wc-sum"><div><b>' + (w.pct != null ? w.pct : 0) + '%</b> hit</div><div><b>' + w.fullDays + '/7</b> full days</div><div><b>' + x.streak.count + '</b> streak</div></div>' + rows +
        '<div class="rv-tax"><div><b>Miss tax: $' + (w.missTaxCents / 100).toFixed(0) + '</b> <small>(' + w.misses + ' missed × $5)</small></div>' +
        (w.missTaxCents ? '<label class="rv-check"><input type="checkbox" id="rvTaxMoved"' + (saved.taxMoved ? ' checked' : '') + '> I moved it to savings</label>' : '<div class="wc-meta">Nothing owed. Clean week.</div>') + '</div>'
        : '<div class="wc-meta">No daily floors set yet — set them under ⚙️ Customize.</div>') +
      '<div class="wc-lbl">2 · Weigh-in</div><div class="wc-meta rv-wt rv-wt-' + esc(wt.verdict) + '">' + esc(wt.text) + '</div>' +
      (wt.verdict === 'adjust' && wt.newCalories ? '<button type="button" class="btn btn-ghost" data-rv-action="cut">Set calories to ' + esc(wt.newCalories) + '</button>' : '') +
      '<div class="rv-goalset"><label>Start <input class="wc-in" id="rvGoalStart" inputmode="decimal" value="' + esc(x.s.goal.start || '') + '" placeholder="375"></label>' +
      '<label>Goal <input class="wc-in" id="rvGoalGoal" inputmode="decimal" value="' + esc(x.s.goal.goal || '') + '" placeholder="220"></label></div>' +
      (lastScary ? '<div class="wc-lbl">3 · Accountability</div>' + lastScary : '') +
      '<div class="wc-lbl">' + (lastScary ? '4' : '3') + ' · Promise audit</div>' +
      '<textarea class="wc-in rv-ta" id="rvKept" rows="2" maxlength="600" placeholder="What I said I\'d do — and did">' + esc(saved.kept || '') + '</textarea>' +
      '<textarea class="wc-in rv-ta" id="rvBailed" rows="2" maxlength="600" placeholder="Where I bailed (honest, no excuses)">' + esc(saved.bailed || '') + '</textarea>' +
      '<div class="wc-lbl">' + (lastScary ? '5' : '4') + ' · One hard thing this week</div>' +
      '<input class="wc-in" id="rvScary" maxlength="200" placeholder="The thing you\'ve been avoiding" value="' + esc(saved.scary || '') + '">' +
      '<label class="rv-due">Deadline <input class="wc-in" type="date" id="rvScaryDue" value="' + esc(saved.scaryDue || R().addDays(today(), 6)) + '"></label>' +
      '<div class="wc-foot"><button class="btn wc-finish" data-rv-action="save">Save review</button>' +
      '<button class="btn btn-ghost" data-rv-action="copy">Copy scorecard</button></div></div>';
    el.classList.add('open'); document.body.classList.add('wc-lock');
  }
  function close() { const el = document.getElementById('rvOverlay'); if (el) el.classList.remove('open'); document.body.classList.remove('wc-lock'); }

  const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  function collect() {
    const x = _x || snapshot();
    const radio = document.querySelector('input[name="rvLastDone"]:checked');
    const taxEl = document.getElementById('rvTaxMoved');
    return {
      pct: x.week.pct, hit: x.week.hit, possible: x.week.possible, fullDays: x.week.fullDays,
      missTaxCents: x.week.missTaxCents, taxMoved: !!(taxEl && taxEl.checked),
      weightChange: x.weight.change != null ? x.weight.change : null, weightVerdict: x.weight.verdict,
      streak: x.streak.count,
      lastDone: radio ? radio.value === 'yes' : null,
      kept: val('rvKept').slice(0, 600), bailed: val('rvBailed').slice(0, 600),
      scary: val('rvScary').slice(0, 200), scaryDue: /^\d{4}-\d{2}-\d{2}$/.test(val('rvScaryDue')) ? val('rvScaryDue') : null,
      at: Date.now(),
    };
  }
  function scorecard() {
    const x = _x || snapshot();
    const c = collect();
    return R().scorecardText({
      from: x.week.from, to: x.week.to, floors: x.fl.length ? x.week : null, taxMoved: c.taxMoved, streak: x.streak,
      weight: x.weight, goal: x.goal, lastScary: x.last && x.last.scary ? { text: x.last.scary, done: c.lastDone } : null,
      kept: c.kept, bailed: c.bailed, scary: c.scary, scaryDue: c.scaryDue,
    });
  }
  function doSave() {
    const s = store();
    const start = parseFloat(val('rvGoalStart')), goal = parseFloat(val('rvGoalGoal'));
    if (start >= 60 && start <= 700) s.goal.start = Math.round(start * 10) / 10;
    if (goal >= 60 && goal <= 700) s.goal.goal = Math.round(goal * 10) / 10;
    s.weeks[today()] = collect();
    // Keep a year of reviews; the doc stays small.
    Object.keys(s.weeks).sort().slice(0, Math.max(0, Object.keys(s.weeks).length - 60)).forEach((k) => { delete s.weeks[k]; });
    if (!save(s)) return;
    close();
    toast('Review saved. ' + (s.weeks[today()].scary ? 'Hard thing locked in.' : ''));
    refresh();
  }
  function doCut() {
    const x = _x || snapshot();
    if (!x.weight.newCalories) return;
    const f = readJson(FOOD, {}) || {};
    f.targets = Object.assign({}, f.targets, { calories: x.weight.newCalories });
    if (!Array.isArray(f.favorites)) f.favorites = [];
    try { localStorage.setItem(FOOD, JSON.stringify(f)); } catch (_) { toast('Could not save on this device'); return; }
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(FOOD);
    toast('Daily calories set to ' + x.weight.newCalories);
    open();
  }
  async function doCopy() {
    const text = scorecard();
    try { await navigator.clipboard.writeText(text); toast('Scorecard copied'); }
    catch (_) { window.prompt('Copy your scorecard:', text); }
  }

  // ── hooks ──────────────────────────────────────────────────────────────
  function mountDash() {
    const main = document.getElementById('main');
    if (!main || document.getElementById('fit-pb') || document.getElementById('rvCard')) return;
    const box = document.createElement('div');
    box.className = 'rv-dash';
    box.innerHTML = cardHtml();
    main.insertBefore(box, main.firstChild);
    paintGoalBars(box);
    publish();
  }
  function hook() {
    const origDash = window.renderDash;
    if (typeof origDash === 'function' && !origDash.__review) {
      const wrapped = function () { const r = origDash.apply(this, arguments); try { mountDash(); } catch (_) {} return r; };
      Object.keys(origDash).forEach((k) => { wrapped[k] = origDash[k]; });
      wrapped.__review = true;
      window.renderDash = wrapped;
    }
  }
  function refresh() {
    const old = document.querySelector('.rv-dash');
    if (old) old.remove();
    try { mountDash(); } catch (_) {}
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-rv-action]');
    if (!t) { if (ev.target && ev.target.id === 'rvOverlay') close(); return; }
    const a = t.dataset.rvAction;
    if (a === 'open') open();
    else if (a === 'close') close();
    else if (a === 'save') doSave();
    else if (a === 'cut') doCut();
    else if (a === 'copy') doCopy();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.querySelector('#rvOverlay.open')) close(); });

  function boot() {
    if (!R()) return;
    hook();
    try { if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) mountDash(); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDReviewUI = { cardHtml, open, close, scorecard, refresh, publish };
})();
