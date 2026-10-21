/**
 * workout-coach.js — the Workout Coach screen (Daily Success, tracker revamp
 * Phase 1). The rules — rotation, targets, PRs, variety — are all in
 * workout-coach-logic.js (window.NBDCoach); this file is only the screen.
 *
 * Flow: the day page's Fitness section gets a Coach card → "Start today's
 * workout" builds the next day in Jo's rotation → a full-screen, one-handed
 * logger (weight / reps / RPE per set, ✓ starts the rest timer, Swap, Switch
 * it up) → Finish saves the session (localStorage + users/{uid}/ds_workouts via
 * ds-firebase-sync.js), reports PRs, and writes the lifts into the day page's
 * old Exercise Log so everything that reads that table keeps working.
 *
 * Loaded as a classic script after app.js. No inline handlers (CSP): one
 * delegated click/input/change listener on [data-coach-action] /
 * [data-coach-field].
 */
(function () {
  'use strict';
  if (window.NBDCoachUI) return;

  const C = () => window.NBDCoach;
  const SESS = 'nbd_ds_workouts';
  const LIVE = 'nbd_ds_coach_live';
  const CFG = 'nbd_ds_coach';
  const READY = 'nbd_ds_coach_ready';   // { 'YYYY-MM-DD': { sleep, sore, energy } } — one per day, this device only
  const RPES = ['6', '7', '7.5', '8', '8.5', '9', '9.5', '10'];

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const fmtDay = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };

  function settings() {
    const s = readJson(CFG, {}) || {};
    return {
      rotation: C().ROTATIONS[s.rotation] ? s.rotation : 'ppl',
      freshness: C().FRESHNESS[s.freshness] ? s.freshness : 'mixed',
      equip: Array.isArray(s.equip) && s.equip.length ? s.equip.filter((e) => C().EQUIP.includes(e)) : C().EQUIP.slice(),
      avoid: C().normAvoid(s.avoid),
      plates: C().normPlates(s.plates),
      warmups: s.warmups !== false,
    };
  }
  function saveSettings(s) {
    writeJson(CFG, s);
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(CFG);
  }
  const sessions = () => readJson(SESS, []) || [];
  // Hard sets per muscle group over the last 7 days (warm-ups excluded), for the nudge.
  function weekBalance() { const s = settings(); return C().balance(sessions(), today(), { equip: s.equip, avoid: s.avoid }); }
  function balanceHtml() {
    const b = weekBalance();
    if (!b.enough) return '';
    const chips = C().MUSCLES.map((m) => `<span class="wc-bal-chip${b.zero.includes(m) ? ' none' : b.low.includes(m) ? ' low' : ''}">${esc(C().MUSCLE_LABELS[m])} ${b.byMuscle[m]}</span>`).join('');
    const rot = C().ROTATIONS[settings().rotation];
    const needs = b.neglected.slice(0, 3).map((m) => {
      const sp = C().splitsFor(m);
      const day = sp.find((k) => rot.includes(k)) || sp[0];
      return esc(C().MUSCLE_LABELS[m]) + (day ? ' (' + esc(C().SPLITS[day].label) + ' day)' : '');
    });
    const lines = [];
    if (needs.length) lines.push('Behind this week: ' + needs.join(', ') + '.');
    if (b.tilt === 'push') lines.push('Pushing ' + b.push + ' sets vs pulling ' + b.pull + ' — add some pulling.');
    if (b.tilt === 'pull') lines.push('Pulling ' + b.pull + ' sets vs pushing ' + b.push + ' — add some pressing.');
    return `<div class="wc-bal"><div class="wc-bal-h">Hard sets, last 7 days</div><div class="wc-bal-chips">${chips}</div>${lines.length ? `<div class="wc-bal-note">${lines.join(' ')}</div>` : ''}</div>`;
  }
  let live = readJson(LIVE, null);
  let summary = null;          // the just-finished session's report
  let swapOpen = -1;
  let swapShowAvoided = false; // the "avoiding" exercises, behind a warning
  let showSettings = false;
  let armed = '';              // two-tap confirms ('discard' | 'split:legs')
  let rest = null;             // { until, label }
  let restTick = null;

  function persistLive() { if (live) writeJson(LIVE, live); else try { localStorage.removeItem(LIVE); } catch (_) {} }

  function newSession(split, opts) {
    const s = settings();
    const seed = (opts && opts.seed) || (Date.now() % 1000000007);
    const built = C().buildSession(split, sessions(), { today: today(), equip: s.equip, avoid: s.avoid, warmups: s.warmups, plates: s.plates, freshness: s.freshness, seed, reroll: opts && opts.reroll, bias: opts && opts.bias });
    const sess = Object.assign(built, { id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), seed, startedAt: Date.now() });
    // Already checked in today? Carry it over (and apply it) instead of asking again.
    const rec = readJson(READY, {})[today()];
    if (rec) { sess.ready = Object.assign({}, rec); applyReadyTo(sess); }
    return sess;
  }

  // ── readiness check-in ───────────────────────────────────────────────
  const READY_ROWS = [
    { k: 'sleep', label: 'Sleep', opts: ['Rough', 'OK', 'Good'] },
    { k: 'sore', label: 'Soreness', opts: ['Very sore', 'Some', 'Fresh'] },
    { k: 'energy', label: 'Energy', opts: ['Low', 'OK', 'High'] },
  ];
  function saveReady(r) {
    const all = readJson(READY, {}) || {};
    all[today()] = { sleep: r.sleep, sore: r.sore, energy: r.energy };
    Object.keys(all).sort().slice(0, Math.max(0, Object.keys(all).length - 30)).forEach((k) => { delete all[k]; });
    writeJson(READY, all);
  }
  // Rough day -> trim a set / hold the load on lifts nothing has been logged on. Safe to call again.
  function applyReadyTo(sess) {
    const r = sess && sess.ready;
    if (!r || r.skipped || r.undone) return;
    const q = C().readiness(r);
    if (!q.complete) return;
    r.total = q.total; r.level = q.level;
    if (q.level !== 'low') return;
    sess.exercises = C().applyReadiness(sess.exercises, q.level, sessions(), { plates: settings().plates }).exercises;
  }
  function readyHtml() {
    const r = live && live.ready;
    if (r && r.skipped) return '';
    const q = C().readiness(r);
    if (q.complete) {
      const ex = live.exercises;
      const t = ex.filter((x) => x.ready && x.ready.trimmed).length, h = ex.filter((x) => x.ready && x.ready.held).length;
      let msg;
      if (r.undone) msg = `Readiness ${q.total}/9 — plan left as it was.`;
      else if (q.level === 'low') msg = `Readiness ${q.total}/9 — rough day. ${t || h ? [t ? 'Dropped a set on ' + t + ' lift' + (t === 1 ? '' : 's') : '', h ? 'held the weight on ' + h : ''].filter(Boolean).join(' and ') + '.' : 'Nothing needed trimming.'} Go by feel.`;
      else msg = `Readiness ${q.total}/9 — ${q.level === 'good' ? 'good to go' : 'steady day'}. Plan unchanged.`;
      const undo = !r.undone && q.level === 'low' && (t || h) ? '<button class="btn btn-ghost wc-ready-btn" data-coach-action="ready-undo">Undo</button>' : '';
      return `<div class="wc-ready done"><span>${esc(msg)}</span>${undo}<button class="btn btn-ghost wc-ready-btn" data-coach-action="ready-reset">Change</button></div>`;
    }
    if (setsDone(live)) return '';
    const rows = READY_ROWS.map((row) => `<div class="wc-ready-row"><span class="wc-ready-l">${row.label}</span>${row.opts.map((o, n) => `<button class="wc-chip${r && r[row.k] === n + 1 ? ' on' : ''}" data-coach-action="ready-set" data-k="${row.k}" data-v="${n + 1}">${esc(o)}</button>`).join('')}</div>`).join('');
    return `<div class="wc-ready"><div class="wc-ready-h">How are you today? <button class="wc-link" data-coach-action="ready-skip">Skip</button></div>${rows}<div class="wc-hint">Optional. A rough day trims a set and holds the weight — nothing else changes.</div></div>`;
  }

  // Warm-ups never count as sets done / total (they are not work).
  const doneCount = (x) => (x.sets || []).filter((s) => s.done && !s.warm).length;
  const setsDone = (sess) => (sess.exercises || []).reduce((n, x) => n + doneCount(x), 0);
  const setsTotal = (sess) => (sess.exercises || []).reduce((n, x) => n + (x.sets || []).filter((s) => !s.warm).length, 0);
  // Fresh rows for an exercise that replaces another (swap / avoid): same number of working sets, warm-ups re-made for the new lift.
  function rebuildSets(x, exId, target) {
    const so = settings();
    const slot = (C().SPLITS[live.split] || { slots: [] }).slots[x.slot];
    // A set the rough-day check-in trimmed counts as planned: it is trimmed again after the swap, not twice.
    const planned = x.ready && x.ready.trimmed ? x.ready.setsWas : (x.sets || []).filter((s) => !s.warm).length;
    return C().setsFor(slot, exId, target, planned, { warmups: so.warmups, plates: so.plates });
  }

  // ── the card on the day page ─────────────────────────────────────────
  function cardHtml() {
    if (!C()) return '';
    const s = settings();
    const all = sessions();
    const next = C().nextSplit(all, s.rotation);
    const v = C().variety(all, today(), 28);
    const last = all.find((x) => x.finishedAt);
    let body;
    if (live) {
      body = `<div class="wc-line">In progress: <b>${esc(live.label)}</b> · ${setsDone(live)}/${setsTotal(live)} sets</div>
        <button class="btn wc-go" data-coach-action="open">Resume workout</button>`;
    } else {
      body = `<div class="wc-line">Next in your rotation: <b>${esc(C().SPLITS[next].label)}</b></div>
        <button class="btn wc-go" data-coach-action="start">Start today's workout</button>`;
    }
    const meta = [];
    if (last) meta.push('Last: ' + esc(C().SPLITS[last.split] ? C().SPLITS[last.split].label : last.split) + ' · ' + esc(fmtDay(last.date)));
    // A variety score over one or two workouts is noise — show it once there's a pattern to read.
    if (v.total >= 12) meta.push('Variety (4 wks): ' + v.pct + '%');
    return `<div class="wc-card" id="wcCard"><div class="wc-card-h">🏋️ Workout Coach</div>${body}
      ${meta.length ? `<div class="wc-meta">${meta.join(' · ')}</div>` : ''}${balanceHtml()}</div>`;
  }
  function refreshCard() { const el = document.getElementById('wcCard'); if (el) el.outerHTML = cardHtml(); }

  // Wrap the day page's Fitness section so the card sits on top of it.
  function hookFitness() {
    const orig = window.buildFitnessSection;
    if (typeof orig !== 'function' || orig.__coach) return false;
    const wrapped = function (p) { return cardHtml() + orig.apply(this, arguments); };
    wrapped.__coach = true;
    window.buildFitnessSection = wrapped;
    return true;
  }

  // ── the full-screen logger ───────────────────────────────────────────
  function overlay() {
    let el = document.getElementById('wcOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wcOverlay';
      el.className = 'wc-ov';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Workout Coach');
      document.body.appendChild(el);
    }
    return el;
  }
  function open() { overlay().classList.add('open'); document.body.classList.add('wc-lock'); render(); }
  function close() { overlay().classList.remove('open'); document.body.classList.remove('wc-lock'); summary = null; refreshCard(); }

  function render() {
    const el = overlay();
    if (!C()) { el.innerHTML = ''; return; }
    if (summary) { el.innerHTML = summaryHtml(summary); return; }
    if (!live) { el.innerHTML = ''; return; }
    const s = settings();
    const rot = C().ROTATIONS[s.rotation];
    const chips = Object.keys(C().SPLITS).map((k) => {
      const on = k === live.split;
      const inRot = rot.includes(k);
      return `<button class="wc-chip${on ? ' on' : ''}${inRot ? '' : ' off-rot'}" data-coach-action="split" data-split="${k}">${esc(C().SPLITS[k].label)}${armed === 'split:' + k ? ' — tap again' : ''}</button>`;
    }).join('');
    const cards = cardsHtml();
    el.innerHTML = `<div class="wc-box">
      <div class="wc-top">
        <button class="wc-x" data-coach-action="close" aria-label="Close">✕</button>
        <div class="wc-title">${esc(live.label)} day <small>${setsDone(live)}/${setsTotal(live)} sets</small></div>
        <button class="wc-gear${showSettings ? ' on' : ''}" data-coach-action="settings" aria-label="Coach settings">⚙</button>
      </div>
      ${showSettings ? settingsHtml(s) : ''}
      <div class="wc-chips">${chips}</div>
      <div class="wc-actions">
        <button class="btn btn-ghost" data-coach-action="reroll">🔀 Switch it up</button>
        <span class="wc-hint">RPE = effort: 10 nothing left · 8 two reps in the tank</span>
      </div>
      ${behindHint()}
      ${readyHtml()}
      ${cards}
      <div class="wc-foot">
        <button class="btn wc-finish" data-coach-action="finish">Finish workout</button>
        <button class="btn btn-ghost" data-coach-action="discard">${armed === 'discard' ? 'Tap again to discard' : 'Discard'}</button>
      </div>
      ${rest ? `<div class="wc-rest" id="wcRest">${restText()}</div>` : ''}
    </div>`;
  }

  // "45 / 25 / 10 per side" under the target — barbell lifts with a target weight only.
  function platesHtml(x, ex) {
    if (ex.equip !== 'barbell' || !(x.target && parseFloat(x.target.weight) > 0)) return '';
    const p = C().platesPerSide(x.target.weight, settings().plates);
    return p ? `<div class="wc-plates">🏋 ${esc(p.text)}</div>` : '';
  }

  // "Stuck 3 sessions" note with two choices. Shows only until a set is logged; never changes a number by itself.
  function stallHtml(x, i) {
    const st = x.target && x.target.stall;
    if (!st || x.deload || doneCount(x)) return '';
    const dl = st.deloadWeight != null
      ? `<button class="btn wc-stall-btn" data-coach-action="deload" data-i="${i}">Deload to ${esc(st.deloadWeight)} lb (−10%)</button>` : '';
    return `<div class="wc-stall">⚠ Same best (${esc(st.label)}) for ${esc(st.sessions)} sessions. Take a lighter week, or try a different lift.
      <div class="wc-stall-btns">${dl}<button class="btn btn-ghost wc-stall-btn" data-coach-action="swap" data-i="${i}">Swap it</button></div></div>`;
  }

  // One line under the Switch-it-up button when a muscle group is behind: re-rolling leans toward it.
  function behindHint() {
    const b = weekBalance();
    if (!b.neglected.length) return '';
    return `<div class="wc-hint wc-behind">Behind this week: ${b.neglected.slice(0, 3).map((m) => esc(C().MUSCLE_LABELS[m])).join(', ')} — 🔀 Switch it up leans that way.</div>`;
  }

  // One set row. Inside a superset, who = 'A ' / 'B ' (for screen readers) and tag = the A1 / B1 label.
  function setRowHtml(x, i, st, j, n, who, tag, next) {
    const lp = st.warm ? null : C().livePR(x, sessions());
    const pr = lp && lp.index === j ? `<span class="wc-pr" title="Beats your best estimated 1RM (${esc(Math.round(lp.prev))} lb)">\u{1F3C6} PR</span>` : '';
    return `<div class="wc-set${st.done ? ' done' : ''}${st.warm ? ' warm' : ''}${next ? ' next' : ''}">
        <span class="wc-n">${st.warm ? 'W' : (tag || n)}</span>
        <input class="wc-in" inputmode="decimal" placeholder="lb" aria-label="Weight, ${who}${st.warm ? 'warm-up' : 'set'} ${st.warm ? j + 1 : n}" value="${esc(st.weight)}" data-coach-field="weight" data-i="${i}" data-s="${j}">
        <span class="wc-x-sep">×</span>
        <input class="wc-in" inputmode="numeric" placeholder="${esc(st.warm ? st.plan : x.target && x.target.reps)}" aria-label="Reps, ${who}${st.warm ? 'warm-up' : 'set'} ${st.warm ? j + 1 : n}" value="${esc(st.reps)}" data-coach-field="reps" data-i="${i}" data-s="${j}">
        <select class="wc-rpe" aria-label="RPE, ${who}${st.warm ? 'warm-up' : 'set'} ${st.warm ? j + 1 : n}" data-coach-field="rpe" data-i="${i}" data-s="${j}">
          <option value="">RPE</option>${RPES.map((r) => `<option value="${r}"${String(st.rpe) === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
        <button class="wc-check${st.done ? ' on' : ''}" data-coach-action="done" data-i="${i}" data-s="${j}" aria-label="${who}${st.warm ? 'Warm-up' : 'Set'} ${st.warm ? j + 1 : n} done">✓</button>${pr}
      </div>`;
  }

  // ── supersets ────────────────────────────────────────────────────────
  // x.pair = "paired with the next lift". Reading left to right, a flagged lift
  // starts a pair and the one after it is its B (a stray flag on a B is ignored).
  function pairStarts(exs) {
    const out = [];
    for (let k = 0; k < exs.length - 1; k++) { if (exs[k].pair) { out.push(k); k++; } }
    return out;
  }
  function pairOf(i) {
    const s = pairStarts(live.exercises).find((k) => i === k || i === k + 1);
    return s === undefined ? null : { a: s, b: s + 1 };
  }
  // The rows of a pair in the order they are done: warm-ups first, then A1 B1 A2 B2 …
  function pairRowsHtml(a) {
    const A = live.exercises[a], B = live.exercises[a + 1];
    const split = (x) => { const warm = [], work = []; (x.sets || []).forEach((st, j) => (st.warm ? warm : work).push({ st, j })); return { warm, work }; };
    const sa = split(A), sb = split(B);
    const out = [];
    sa.warm.forEach((r, n) => out.push({ x: A, i: a, r, n: n + 1, who: 'A ', tag: '' }));
    sb.warm.forEach((r, n) => out.push({ x: B, i: a + 1, r, n: n + 1, who: 'B ', tag: '' }));
    for (let k = 0; k < Math.max(sa.work.length, sb.work.length); k++) {
      if (sa.work[k]) out.push({ x: A, i: a, r: sa.work[k], n: k + 1, who: 'A ', tag: 'A' + (k + 1) });
      if (sb.work[k]) out.push({ x: B, i: a + 1, r: sb.work[k], n: k + 1, who: 'B ', tag: 'B' + (k + 1) });
    }
    const nextAt = out.findIndex((o) => !o.r.st.done);
    return out.map((o, idx) => setRowHtml(o.x, o.i, o.r.st, o.r.j, o.n, o.who, o.tag, idx === nextAt)).join('');
  }
  function pairHtml(a) {
    return `<div class="wc-ss"><div class="wc-ss-h"><span>⇄ Superset — do A, then B; one rest after each pair</span><button class="wc-link" data-coach-action="pair-next" data-i="${a}">Unpair</button></div>
      ${exerciseHtml(live.exercises[a], a, 'A')}${exerciseHtml(live.exercises[a + 1], a + 1, 'B')}
      <div class="wc-ss-rows">${pairRowsHtml(a)}</div>
      <div class="wc-ss-add"><button class="wc-add" data-coach-action="add-set" data-i="${a}">+ set A</button><button class="wc-add" data-coach-action="add-set" data-i="${a + 1}">+ set B</button></div></div>`;
  }
  function cardsHtml() {
    const starts = pairStarts(live.exercises);
    let out = '';
    for (let i = 0; i < live.exercises.length; i++) {
      if (starts.includes(i)) { out += pairHtml(i); i++; } else out += exerciseHtml(live.exercises[i], i);
    }
    return out;
  }
  // One rest per pair: only once BOTH lifts' sets of this round are done (either order).
  function pairRest(pr, i, j) {
    const a = live.exercises[pr.a], b = live.exercises[pr.b];
    const mine = i === pr.a ? a : b, other = i === pr.a ? b : a;
    const r = mine.sets.slice(0, j + 1).filter((s) => !s.warm).length - 1;
    const ps = other.sets.filter((s) => !s.warm)[r];
    if (ps && !ps.done) return;
    const wa = a.sets.filter((s) => !s.warm), wb = b.sets.filter((s) => !s.warm);
    let label = 'next exercise';
    for (let k = 0; k < Math.max(wa.length, wb.length); k++) {
      if (wa[k] && !wa[k].done) { label = 'next: ' + a.name + ' set ' + (k + 1); break; }
      if (wb[k] && !wb[k].done) { label = 'next: ' + b.name + ' set ' + (k + 1); break; }
    }
    startRest(Math.max(C().restFor(a.exId), C().restFor(b.exId)), label);
  }

  // "Last time (Oct 14): 135×8, 135×8" — read-only context; never fills or changes a number.
  function lastTimeHtml(x) {
    const lt = C().lastTime(x.exId, sessions());
    return lt ? `<div class="wc-last">${esc(lt.text)}</div>` : '';
  }

  function exerciseHtml(x, i, role) {
    const ex = C().BY_ID[x.exId] || {};
    let workN = 0;
    const rows = role ? '' : (x.sets || []).map((st, j) => setRowHtml(x, i, st, j, st.warm ? workN : ++workN, '', '', false)).join('');
    const nx = live.exercises[i + 1];
    const pairBtn = !role && nx && !nx.pair ? `<button class="wc-link" data-coach-action="pair-next" data-i="${i}">⇄ Pair with next lift (superset)</button>` : '';
    let swaps = '';
    if (swapOpen === i) {
      const so = settings();
      const ids = live.exercises.map((e) => e.exId);
      const opts = C().swapOptions(live.split, x.slot, ids, sessions(), { today: today(), equip: so.equip, avoid: so.avoid });
      const avoided = C().avoidedOptions(live.split, x.slot, ids, { equip: so.equip, avoid: so.avoid });
      swaps = `<div class="wc-swaps">${opts
        .map((o) => `<button class="wc-swap-opt" data-coach-action="swap-to" data-i="${i}" data-ex="${esc(o.id)}">${esc(o.name)}</button>`).join('') || '<span class="wc-hint">No other options with your equipment</span>'}</div>`;
      if (avoided.length) {
        swaps += swapShowAvoided
          ? `<div class="wc-hint">⚠ You're avoiding these. Tap one twice to use it anyway.</div><div class="wc-swaps">${avoided
              .map((o) => `<button class="wc-swap-opt wc-avoided" data-coach-action="swap-to" data-i="${i}" data-ex="${esc(o.id)}">${esc(o.name)}${armed === 'avoid:' + o.id ? ' — tap again' : ''}</button>`).join('')}</div>`
          : `<button class="wc-link" data-coach-action="show-avoided">Show ${avoided.length} I'm avoiding</button>`;
      }
    }
    return `<div class="wc-ex${role ? ' wc-ss-ex' : ''}">
      <div class="wc-ex-h"><div><div class="wc-ex-name">${role ? `<span class="wc-ss-tag">${role}</span> ` : ''}${esc(x.name)}</div>
        <div class="wc-ex-sub">${esc(x.repRange[0])}–${esc(x.repRange[1])} reps · ${esc(ex.equip || '')}</div></div>
        <div class="wc-ex-btns"><button class="btn btn-ghost wc-swap" data-coach-action="avoid-ex" data-i="${i}" title="Stop offering this one">${armed === 'avoidx:' + i ? 'Sure? Tap again' : 'Avoid'}</button>
        <button class="btn btn-ghost wc-swap" data-coach-action="swap" data-i="${i}">${swapOpen === i ? 'Cancel' : 'Swap'}</button></div></div>
      <div class="wc-target">🎯 ${esc(x.target && x.target.note)}</div>
      ${lastTimeHtml(x)}
      ${stallHtml(x, i)}
      ${platesHtml(x, ex)}
      ${swaps}${rows}
      ${role ? '' : `<button class="wc-add" data-coach-action="add-set" data-i="${i}">+ set</button>${pairBtn}`}
    </div>`;
  }

  function settingsHtml(s) {
    const radio = (name, val, label, cur) => `<button class="wc-chip${cur === val ? ' on' : ''}" data-coach-action="set-${name}" data-val="${val}">${label}</button>`;
    return `<div class="wc-settings">
      <div class="wc-lbl">Rotation</div><div class="wc-chips">${radio('rotation', 'ppl', 'Push / Pull / Legs', s.rotation)}${radio('rotation', 'ul', 'Upper / Lower', s.rotation)}${radio('rotation', 'full', 'Full Body', s.rotation)}</div>
      <div class="wc-lbl">Main lift changes</div><div class="wc-chips">${radio('freshness', 'steady', 'Every 6 sessions', s.freshness)}${radio('freshness', 'mixed', 'Every 3', s.freshness)}${radio('freshness', 'fresh', 'Every session', s.freshness)}</div>
      <div class="wc-lbl">Equipment I have</div><div class="wc-chips">${C().EQUIP.map((e) => `<button class="wc-chip${s.equip.includes(e) ? ' on' : ''}" data-coach-action="toggle-equip" data-val="${e}">${e}</button>`).join('')}</div>
      <div class="wc-lbl">Warm-up sets (first lift of the day)</div><div class="wc-chips">${radio('warmups', 'on', 'On', s.warmups ? 'on' : 'off')}${radio('warmups', 'off', 'Off', s.warmups ? 'on' : 'off')}</div>
      <div class="wc-lbl">Bar &amp; plates (for the per-side math)</div><div class="wc-chips">${[35, 45].map((b) => `<button class="wc-chip${s.plates.bar === b ? ' on' : ''}" data-coach-action="set-bar" data-val="${b}">${b} lb bar</button>`).join('')}${C().PLATE_SIZES.map((p) => `<button class="wc-chip${s.plates.plates.includes(p) ? ' on' : ''}" data-coach-action="toggle-plate" data-val="${p}">${p}</button>`).join('')}</div>
      <div class="wc-lbl">Avoiding for now (sore spot?)</div><div class="wc-chips">${Object.keys(C().PATTERN_LABELS).map((p) => `<button class="wc-chip${s.avoid.patterns.includes(p) ? ' on' : ''}" data-coach-action="toggle-avoid-pat" data-val="${p}">${esc(C().PATTERN_LABELS[p])}</button>`).join('')}${s.avoid.exercises.map((id) => `<button class="wc-chip on" data-coach-action="unavoid-ex" data-val="${esc(id)}">${esc((C().BY_ID[id] || {}).name || id)} ✕</button>`).join('')}</div>
      <div class="wc-hint">The coach won't offer anything you're avoiding. This is your own list, not medical advice.</div>
      <div class="wc-hint">Changes apply to the next workout you build (or tap 🔀 now).</div>
    </div>`;
  }

  function summaryHtml(r) {
    const prs = r.prs.length
      ? `<div class="wc-prs">${r.prs.map((p) => `<div>🏆 ${esc(p.name)}: est. 1RM ${esc(Math.round(p.e1rm))} lb <small>(was ${esc(Math.round(p.prev))})</small></div>`).join('')}</div>`
      : '<div class="wc-hint">No new PRs this time — the targets are set for next time.</div>';
    return `<div class="wc-box"><div class="wc-top"><button class="wc-x" data-coach-action="close" aria-label="Close">✕</button>
      <div class="wc-title">${esc(r.label)} day done ✓</div><span></span></div>
      <div class="wc-sum"><div><b>${r.vol.sets}</b> sets</div><div><b>${r.vol.lbs.toLocaleString()}</b> lb moved</div><div><b>${r.minutes}</b> min</div></div>
      ${prs}
      ${r.variety.total >= 12 ? `<div class="wc-hint">Variety over the last 4 weeks: ${r.variety.pct}% — ${r.variety.distinct} different lifts across ${r.variety.total} exercise slots</div>` : ''}
      ${r.wrotePage ? '<div class="wc-hint">Logged to today\'s Exercise Log.</div>' : ''}
      <div class="wc-foot"><button class="btn wc-finish" data-coach-action="close">Close</button></div></div>`;
  }

  // ── rest timer ───────────────────────────────────────────────────────
  function restText() {
    const left = Math.max(0, Math.round((rest.until - Date.now()) / 1000));
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    return left > 0
      ? `Rest ${mm}:${ss} <small>${esc(rest.label)}</small> <button class="btn btn-ghost" data-coach-action="skip-rest">Skip</button>`
      : `Go — next set <button class="btn btn-ghost" data-coach-action="skip-rest">OK</button>`;
  }
  function startRest(seconds, label) {
    rest = { until: Date.now() + seconds * 1000, label, buzzed: false };
    clearInterval(restTick);
    restTick = setInterval(() => {
      if (!rest) { clearInterval(restTick); return; }
      const el = document.getElementById('wcRest');
      if (el) el.innerHTML = restText();
      if (!rest.buzzed && Date.now() >= rest.until) { rest.buzzed = true; try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (_) {} }
    }, 1000);
  }
  function stopRest() { rest = null; clearInterval(restTick); }

  // ── actions ──────────────────────────────────────────────────────────
  function start() {
    if (!live) { live = newSession(C().nextSplit(sessions(), settings().rotation)); persistLive(); }
    open();
  }

  function finish() {
    const done = live.exercises.some((x) => (x.sets || []).some((st) => !st.warm && (st.done || parseFloat(st.reps) > 0)));
    if (!done) { toast('Log at least one set first'); return; }
    const prior = sessions();
    // A set with reps typed counts even if ✓ was never tapped.
    live.exercises.forEach((x) => (x.sets || []).forEach((st) => { if (parseFloat(st.reps) > 0) st.done = true; }));
    const now = Date.now();
    const session = {
      id: live.id, date: live.date || today(), split: live.split, startedAt: live.startedAt, finishedAt: now, mt: now,
      exercises: live.exercises.map((x, k) => Object.assign({ exId: x.exId, name: x.name, slot: x.slot, repRange: x.repRange,
        sets: (x.sets || []).filter((st) => st.done).map((st) => Object.assign({ reps: parseFloat(st.reps) || 0, weight: st.weight === '' ? '' : (parseFloat(st.weight) || 0), rpe: parseFloat(st.rpe) || '', done: true }, st.warm ? { warm: true } : {})) }, x.deload ? { deload: true } : {}, x.pair && pairStarts(live.exercises).includes(k) && ((live.exercises[k + 1] || {}).sets || []).some((st) => st.done) ? { pair: true } : {}))
        .filter((x) => x.sets.length),
    };
    const all = C().mergeSessions([session].concat(prior), []);
    writeJson(SESS, all);
    if (window.NBDDsCloud && typeof window.NBDDsCloud.pushWorkout === 'function') window.NBDDsCloud.pushWorkout(session);
    const wrotePage = writeToPage(session);
    summary = {
      label: live.label, prs: C().detectPRs(session, prior), vol: C().volume(session),
      minutes: Math.max(1, Math.round((now - (live.startedAt || now)) / 60000)),
      variety: C().variety(all, today(), 28), wrotePage,
    };
    live = null; persistLive(); stopRest(); swapOpen = -1; armed = '';
    render();
  }

  // The day page's Exercise Log (app.js addExercise/collectPage) — only when
  // the page on screen is today's, so a workout never lands on another day.
  function writeToPage(session) {
    try {
      if (typeof window.collectPage !== 'function' || typeof window.savePages !== 'function') return false;
      // app.js's top-level `let pages` / `let cur` share the global lexical
      // scope with this classic script (they are not window properties).
      /* global pages, cur */
      const onScreen = (typeof pages !== 'undefined' && typeof cur !== 'undefined') ? pages[cur] : null;
      if (!onScreen || onScreen.dk !== session.date) return false;
      // Keep anything typed on the page first, then write to the page object
      // itself (not the DOM table), save, and re-render from it.
      window.collectPage(true);
      const kept = (onScreen.exercises || []).filter((r) => r && Object.values(r).some((v) => String(v || '').trim()));
      onScreen.exercises = kept.concat(C().toPageRows(session));
      onScreen.data = onScreen.data || {};
      // Drop the page's ex-N-* mirror of the old list; the next collect rebuilds it.
      Object.keys(onScreen.data).forEach((k) => { if (/^ex-\d+-/.test(k)) delete onScreen.data[k]; });
      if (!String(onScreen.data['fit-focus'] || '').trim()) onScreen.data['fit-focus'] = (C().SPLITS[session.split] || {}).label || session.split;
      if (!String(onScreen.data['fit-dur'] || '').trim()) onScreen.data['fit-dur'] = Math.max(1, Math.round((session.finishedAt - session.startedAt) / 60000)) + ' min';
      window.savePages();
      if (typeof window.renderPage === 'function') window.renderPage();
      return true;
    } catch (_) { return false; }
  }

  function onClick(ev) {
    const t = ev.target.closest && ev.target.closest('[data-coach-action]');
    if (!t || !C()) return;
    const a = t.dataset.coachAction;
    const i = +t.dataset.i, j = +t.dataset.s;
    if (a !== 'discard' && !String(a).startsWith('split') && a !== 'swap-to' && a !== 'avoid-ex') armed = '';
    switch (a) {
      case 'start': start(); return;
      case 'open': open(); return;
      case 'close': close(); return;
      case 'settings': showSettings = !showSettings; render(); return;
      case 'set-warmups': {
        const s = settings(); s.warmups = t.dataset.val === 'on'; saveSettings(s); render(); return;
      }
      case 'set-rotation': case 'set-freshness': {
        const s = settings(); s[a.slice(4)] = t.dataset.val; saveSettings(s); render(); return;
      }
      case 'toggle-equip': {
        const s = settings(); const v = t.dataset.val;
        s.equip = s.equip.includes(v) ? s.equip.filter((e) => e !== v) : s.equip.concat(v);
        if (!s.equip.length) { toast('Keep at least one'); return; }
        saveSettings(s); render(); return;
      }
      case 'set-bar': {
        const s = settings(); s.plates.bar = +t.dataset.val; saveSettings(s); render(); return;
      }
      case 'toggle-plate': {
        const s = settings(); const v = +t.dataset.val;
        const next = s.plates.plates.includes(v) ? s.plates.plates.filter((p) => p !== v) : s.plates.plates.concat(v);
        if (!next.length) { toast('Keep at least one plate size'); return; }
        s.plates.plates = next; saveSettings(s); render(); return;
      }
      case 'toggle-avoid-pat': {
        const s = settings(); const v = t.dataset.val;
        s.avoid.patterns = s.avoid.patterns.includes(v) ? s.avoid.patterns.filter((p) => p !== v) : s.avoid.patterns.concat(v);
        saveSettings(s); render(); return;
      }
      case 'unavoid-ex': {
        const s = settings(); s.avoid.exercises = s.avoid.exercises.filter((id) => id !== t.dataset.val);
        saveSettings(s); render(); return;
      }
      case 'deload': {
        const x = live && live.exercises[i];
        const st = x && x.target && x.target.stall;
        if (!st || st.deloadWeight == null || doneCount(x)) return;
        const target = { weight: st.deloadWeight, reps: x.target.reps, note: 'Deload: ' + st.deloadWeight + ' lb (10% off) — easy, crisp reps, then build back up' };
        live.exercises[i] = Object.assign({}, x, { target, deload: true, sets: rebuildSets(x, x.exId, target), ready: undefined });
        applyReadyTo(live);
        persistLive(); toast('Deload set: ' + st.deloadWeight + ' lb'); render(); return;
      }
      case 'pair-next': {
        const ex = live && live.exercises;
        if (!ex || !ex[i] || i >= ex.length - 1) return;
        if (ex[i].pair) { delete ex[i].pair; persistLive(); render(); return; }
        if (pairStarts(ex).includes(i - 1)) { toast('That one is already the B of a superset'); return; }
        if (ex[i + 1].pair) { toast('Unpair the next lift first'); return; }
        ex[i].pair = true; persistLive(); render(); return;
      }
      case 'ready-set': {
        if (!live) return;
        live.ready = Object.assign({}, live.ready && !live.ready.skipped ? live.ready : {}, { [t.dataset.k]: +t.dataset.v });
        delete live.ready.undone;
        const q = C().readiness(live.ready);
        if (q.complete) {
          saveReady(live.ready);
          applyReadyTo(live);
          toast(q.level === 'low' ? 'Rough day: lighter plan set (Undo is on the card)' : 'Check-in saved');
        }
        persistLive(); render(); return;
      }
      case 'ready-skip': if (live) { live.ready = { skipped: true }; persistLive(); render(); } return;
      case 'ready-undo': {
        if (!live || !live.ready) return;
        live.exercises = C().undoReadiness(live.exercises, { plates: settings().plates });
        live.ready.undone = true; persistLive(); render(); return;
      }
      case 'ready-reset': {
        if (!live) return;
        live.exercises = C().undoReadiness(live.exercises, { plates: settings().plates });
        live.ready = null; persistLive(); render(); return;
      }
      case 'show-avoided': swapShowAvoided = true; render(); return;
      case 'avoid-ex': {
        const x = live && live.exercises[i]; if (!x) return;
        if (armed !== 'avoidx:' + i) { armed = 'avoidx:' + i; render(); return; }
        armed = '';
        const s = settings();
        if (!s.avoid.exercises.includes(x.exId)) s.avoid.exercises = s.avoid.exercises.concat(x.exId);
        saveSettings(s);
        // Nothing logged yet: swap it out right away for the best other option.
        const alt = doneCount(x) ? null : C().swapOptions(live.split, x.slot, live.exercises.map((e) => e.exId), sessions(), { today: today(), equip: s.equip, avoid: s.avoid })[0];
        if (alt) {
          const target = C().targetFor(alt.id, x.repRange, sessions(), { plates: s.plates });
          live.exercises[i] = Object.assign({}, x, { exId: alt.id, name: alt.name, target, sets: rebuildSets(x, alt.id, target), ready: undefined });
          applyReadyTo(live);
          persistLive();
          toast('Avoiding ' + x.name + ' — swapped to ' + alt.name);
        } else toast('Avoiding ' + x.name + " — it won't be offered again");
        swapOpen = -1; render(); return;
      }
      case 'split': {
        const k = t.dataset.split;
        if (!live || k === live.split) return;
        if (setsDone(live) && armed !== 'split:' + k) { armed = 'split:' + k; render(); return; }
        armed = ''; live = newSession(k); persistLive(); swapOpen = -1; render(); return;
      }
      case 'reroll': {
        if (!live) return;
        // Keep any exercise already started; re-roll the rest.
        const kept = live.exercises.filter((x) => doneCount(x));
        const fresh = newSession(live.split, { seed: (live.seed || 1) + 7919, reroll: true, bias: weekBalance().neglected });
        const keepIds = kept.map((x) => x.exId);
        live.seed = fresh.seed;
        live.exercises = live.exercises.map((x) => {
          if (doneCount(x)) return x;
          const alt = fresh.exercises.find((f) => f.slot === x.slot && !keepIds.includes(f.exId));
          if (alt) keepIds.push(alt.exId);
          return alt ? (x.pair ? Object.assign({ pair: true }, alt) : alt) : x;
        });
        applyReadyTo(live);
        persistLive(); swapOpen = -1; render(); return;
      }
      case 'swap': swapOpen = swapOpen === i ? -1 : i; swapShowAvoided = false; render(); return;
      case 'swap-to': {
        const x = live.exercises[i]; const exId = t.dataset.ex; const ex = C().BY_ID[exId];
        if (!x || !ex) return;
        if (doneCount(x)) { toast('Sets already logged on this one'); return; }
        // An exercise Jo is avoiding needs a second, deliberate tap.
        if (C().isAvoided(ex, settings().avoid) && armed !== 'avoid:' + exId) { armed = 'avoid:' + exId; render(); return; }
        armed = '';
        const target = C().targetFor(exId, x.repRange, sessions(), { plates: settings().plates });
        live.exercises[i] = Object.assign({}, x, { exId, name: ex.name, target, sets: rebuildSets(x, exId, target), ready: undefined });
        applyReadyTo(live);
        swapOpen = -1; swapShowAvoided = false; persistLive(); render(); return;
      }
      case 'done': {
        const st = live.exercises[i] && live.exercises[i].sets[j];
        if (!st) return;
        st.done = !st.done;
        if (st.done && !(parseFloat(st.reps) > 0)) st.reps = st.warm ? (st.plan || '') : (live.exercises[i].target ? live.exercises[i].target.reps : '');
        persistLive();
        if (st.done) {
          const x = live.exercises[i];
          const pr = st.warm ? null : pairOf(i);
          if (pr) pairRest(pr, i, j);
          else {
            const nextSet = x.sets.findIndex((s2) => !s2.done);
            startRest(st.warm ? 60 : C().restFor(x.exId), nextSet > -1 ? 'next: ' + x.name + ' set ' + (nextSet + 1) : 'next exercise');
          }
        }
        render(); return;
      }
      case 'add-set': {
        const x = live.exercises[i]; if (!x) return;
        const last = x.sets[x.sets.length - 1] || {};
        x.sets.push({ reps: '', weight: last.weight == null ? '' : last.weight, rpe: '', done: false });
        persistLive(); render(); return;
      }
      case 'skip-rest': stopRest(); render(); return;
      case 'finish': finish(); return;
      case 'discard':
        if (armed !== 'discard') { armed = 'discard'; render(); return; }
        armed = ''; live = null; persistLive(); stopRest(); close(); toast('Workout discarded'); return;
      default:
    }
  }

  function onField(ev) {
    const el = ev.target;
    if (!el || !el.dataset || !el.dataset.coachField || !live) return;
    const st = live.exercises[+el.dataset.i] && live.exercises[+el.dataset.i].sets[+el.dataset.s];
    if (!st) return;
    st[el.dataset.coachField] = el.value;
    persistLive();
  }

  document.addEventListener('click', onClick);
  document.addEventListener('input', onField);
  document.addEventListener('change', onField);

  function boot() {
    if (!C()) return;
    if (hookFitness() && typeof window.renderPage === 'function') {
      try { if (document.getElementById('fit-pb')) window.renderPage(); } catch (_) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDCoachUI = { refresh: refreshCard, open, start, _render: render };
})();
