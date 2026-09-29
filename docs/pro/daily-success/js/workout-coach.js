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
    };
  }
  function saveSettings(s) {
    writeJson(CFG, s);
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(CFG);
  }
  const sessions = () => readJson(SESS, []) || [];
  let live = readJson(LIVE, null);
  let summary = null;          // the just-finished session's report
  let swapOpen = -1;
  let showSettings = false;
  let armed = '';              // two-tap confirms ('discard' | 'split:legs')
  let rest = null;             // { until, label }
  let restTick = null;

  function persistLive() { if (live) writeJson(LIVE, live); else try { localStorage.removeItem(LIVE); } catch (_) {} }

  function newSession(split, opts) {
    const s = settings();
    const seed = (opts && opts.seed) || (Date.now() % 1000000007);
    const built = C().buildSession(split, sessions(), { today: today(), equip: s.equip, freshness: s.freshness, seed, reroll: opts && opts.reroll });
    return Object.assign(built, { id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), seed, startedAt: Date.now() });
  }

  const doneCount = (x) => (x.sets || []).filter((s) => s.done).length;
  const setsDone = (sess) => (sess.exercises || []).reduce((n, x) => n + doneCount(x), 0);
  const setsTotal = (sess) => (sess.exercises || []).reduce((n, x) => n + (x.sets || []).length, 0);

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
      ${meta.length ? `<div class="wc-meta">${meta.join(' · ')}</div>` : ''}</div>`;
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
    const cards = live.exercises.map((x, i) => exerciseHtml(x, i)).join('');
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
      ${cards}
      <div class="wc-foot">
        <button class="btn wc-finish" data-coach-action="finish">Finish workout</button>
        <button class="btn btn-ghost" data-coach-action="discard">${armed === 'discard' ? 'Tap again to discard' : 'Discard'}</button>
      </div>
      ${rest ? `<div class="wc-rest" id="wcRest">${restText()}</div>` : ''}
    </div>`;
  }

  function exerciseHtml(x, i) {
    const ex = C().BY_ID[x.exId] || {};
    const rows = (x.sets || []).map((st, j) => `<div class="wc-set${st.done ? ' done' : ''}">
        <span class="wc-n">${j + 1}</span>
        <input class="wc-in" inputmode="decimal" placeholder="lb" aria-label="Weight, set ${j + 1}" value="${esc(st.weight)}" data-coach-field="weight" data-i="${i}" data-s="${j}">
        <span class="wc-x-sep">×</span>
        <input class="wc-in" inputmode="numeric" placeholder="${esc(x.target && x.target.reps)}" aria-label="Reps, set ${j + 1}" value="${esc(st.reps)}" data-coach-field="reps" data-i="${i}" data-s="${j}">
        <select class="wc-rpe" aria-label="RPE, set ${j + 1}" data-coach-field="rpe" data-i="${i}" data-s="${j}">
          <option value="">RPE</option>${RPES.map((r) => `<option value="${r}"${String(st.rpe) === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
        <button class="wc-check${st.done ? ' on' : ''}" data-coach-action="done" data-i="${i}" data-s="${j}" aria-label="Set ${j + 1} done">✓</button>
      </div>`).join('');
    const swaps = swapOpen === i
      ? `<div class="wc-swaps">${C().swapOptions(live.split, x.slot, live.exercises.map((e) => e.exId), sessions(), { today: today(), equip: settings().equip })
          .map((o) => `<button class="wc-swap-opt" data-coach-action="swap-to" data-i="${i}" data-ex="${esc(o.id)}">${esc(o.name)}</button>`).join('') || '<span class="wc-hint">No other options with your equipment</span>'}</div>`
      : '';
    return `<div class="wc-ex">
      <div class="wc-ex-h"><div><div class="wc-ex-name">${esc(x.name)}</div>
        <div class="wc-ex-sub">${esc(x.repRange[0])}–${esc(x.repRange[1])} reps · ${esc(ex.equip || '')}</div></div>
        <button class="btn btn-ghost wc-swap" data-coach-action="swap" data-i="${i}">${swapOpen === i ? 'Cancel' : 'Swap'}</button></div>
      <div class="wc-target">🎯 ${esc(x.target && x.target.note)}</div>
      ${swaps}${rows}
      <button class="wc-add" data-coach-action="add-set" data-i="${i}">+ set</button>
    </div>`;
  }

  function settingsHtml(s) {
    const radio = (name, val, label, cur) => `<button class="wc-chip${cur === val ? ' on' : ''}" data-coach-action="set-${name}" data-val="${val}">${label}</button>`;
    return `<div class="wc-settings">
      <div class="wc-lbl">Rotation</div><div class="wc-chips">${radio('rotation', 'ppl', 'Push / Pull / Legs', s.rotation)}${radio('rotation', 'ul', 'Upper / Lower', s.rotation)}${radio('rotation', 'full', 'Full Body', s.rotation)}</div>
      <div class="wc-lbl">Main lift changes</div><div class="wc-chips">${radio('freshness', 'steady', 'Every 6 sessions', s.freshness)}${radio('freshness', 'mixed', 'Every 3', s.freshness)}${radio('freshness', 'fresh', 'Every session', s.freshness)}</div>
      <div class="wc-lbl">Equipment I have</div><div class="wc-chips">${C().EQUIP.map((e) => `<button class="wc-chip${s.equip.includes(e) ? ' on' : ''}" data-coach-action="toggle-equip" data-val="${e}">${e}</button>`).join('')}</div>
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
    const done = live.exercises.some((x) => (x.sets || []).some((st) => st.done || parseFloat(st.reps) > 0));
    if (!done) { toast('Log at least one set first'); return; }
    const prior = sessions();
    // A set with reps typed counts even if ✓ was never tapped.
    live.exercises.forEach((x) => (x.sets || []).forEach((st) => { if (parseFloat(st.reps) > 0) st.done = true; }));
    const now = Date.now();
    const session = {
      id: live.id, date: live.date || today(), split: live.split, startedAt: live.startedAt, finishedAt: now, mt: now,
      exercises: live.exercises.map((x) => ({ exId: x.exId, name: x.name, slot: x.slot, repRange: x.repRange,
        sets: (x.sets || []).filter((st) => st.done).map((st) => ({ reps: parseFloat(st.reps) || 0, weight: st.weight === '' ? '' : (parseFloat(st.weight) || 0), rpe: parseFloat(st.rpe) || '', done: true })) }))
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
    if (a !== 'discard' && !String(a).startsWith('split')) armed = '';
    switch (a) {
      case 'start': start(); return;
      case 'open': open(); return;
      case 'close': close(); return;
      case 'settings': showSettings = !showSettings; render(); return;
      case 'set-rotation': case 'set-freshness': {
        const s = settings(); s[a.slice(4)] = t.dataset.val; saveSettings(s); render(); return;
      }
      case 'toggle-equip': {
        const s = settings(); const v = t.dataset.val;
        s.equip = s.equip.includes(v) ? s.equip.filter((e) => e !== v) : s.equip.concat(v);
        if (!s.equip.length) { toast('Keep at least one'); return; }
        saveSettings(s); render(); return;
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
        const fresh = newSession(live.split, { seed: (live.seed || 1) + 7919, reroll: true });
        const keepIds = kept.map((x) => x.exId);
        live.seed = fresh.seed;
        live.exercises = live.exercises.map((x) => {
          if (doneCount(x)) return x;
          const alt = fresh.exercises.find((f) => f.slot === x.slot && !keepIds.includes(f.exId));
          if (alt) keepIds.push(alt.exId);
          return alt || x;
        });
        persistLive(); swapOpen = -1; render(); return;
      }
      case 'swap': swapOpen = swapOpen === i ? -1 : i; render(); return;
      case 'swap-to': {
        const x = live.exercises[i]; const exId = t.dataset.ex; const ex = C().BY_ID[exId];
        if (!x || !ex) return;
        if (doneCount(x)) { toast('Sets already logged on this one'); return; }
        const target = C().targetFor(exId, x.repRange, sessions());
        live.exercises[i] = Object.assign({}, x, { exId, name: ex.name, target,
          sets: x.sets.map(() => ({ reps: '', weight: target.weight == null ? '' : target.weight, rpe: '', done: false })) });
        swapOpen = -1; persistLive(); render(); return;
      }
      case 'done': {
        const st = live.exercises[i] && live.exercises[i].sets[j];
        if (!st) return;
        st.done = !st.done;
        if (st.done && !(parseFloat(st.reps) > 0)) st.reps = live.exercises[i].target ? live.exercises[i].target.reps : '';
        persistLive();
        if (st.done) {
          const x = live.exercises[i];
          const nextSet = x.sets.findIndex((s2) => !s2.done);
          startRest(C().restFor(x.exId), nextSet > -1 ? 'next: ' + x.name + ' set ' + (nextSet + 1) : 'next exercise');
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
