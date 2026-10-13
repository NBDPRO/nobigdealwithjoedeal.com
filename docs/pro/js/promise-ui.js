/**
 * promise-ui.js — the Promise sheet, the task writes behind Today's promise /
 * waiting rows, and the draft Nudge (2026-10-12, lazy bundle 'promise').
 * Design: documentation/projects/PROMISE-CAPTURE-2026-10-12.md. Pure rules:
 * promise-logic.js (window.NBDPromiseLogic).
 *
 *   NBDPromise.openSheet({ mode, name, leadId, lead, callIds, summary, why,
 *                          move, onDone })
 *       mode 'handle'  a call row is being handled: chips incl. "Nothing owed"
 *       mode 'promise' a customer page / Call Center card: chips, no "Nothing owed"
 *       mode 'move'    a new date for an open promise (o.move = {…})
 *   NBDPromise.keep(leadId, task) · dead(…) · stillWaiting(…) · nudge(row)
 *   NBDPromise.waitingDays() · setWaitingDays(n) · loadSettings()
 *
 * Writes: a call's promise goes through callCenterAction 'promise' (server:
 * task + handled + supersede); a customer-page promise and every later change
 * (kept / dead / still waiting / move) is a plain write on the task, which the
 * rules already let the lead's owner and company staff do. A write that fails
 * says so and leaves the sheet / row where it was — a promise that did not
 * save is never shown as saved. Nothing here sends anything to a customer:
 * Nudge opens the phone's own composer through NBDPhoneShare (which runs the
 * server's "ok to text?" check first) and records the nudge only once Jo says
 * it went out. Strict CSP: classes and delegated listeners only.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDPromise) return;
  var w = window, doc = document;
  var PL = w.NBDPromiseLogic;
  if (!PL) return;

  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var SETTINGS = { waitingDays: PL.DEFAULT_WAITING_DAYS, loaded: false, busy: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function uid() { return (w._user && w._user.uid) || (w.auth && w.auth.currentUser && w.auth.currentUser.uid) || null; }
  function todayYmd() { return PL.ymdLocal(Date.now()); }
  function isViewer() { return ((w._userClaims || {}).role || '') === 'viewer'; }
  function ts() { return typeof w.serverTimestamp === 'function' ? w.serverTimestamp() : new Date(); }
  function changed() {
    try { w.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'tasks' } })); } catch (_) { /* old browser */ }
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

  // ── the waiting threshold (userSettings/{uid}.promiseSettings.waitingDays) ──
  async function loadSettings() {
    if (SETTINGS.loaded) return SETTINGS.waitingDays;
    if (SETTINGS.busy) return SETTINGS.busy;
    var u = uid();
    if (!u || !w.db || !w.getDoc || !w.doc) return SETTINGS.waitingDays;
    SETTINGS.busy = (async function () {
      try {
        var snap = await w.getDoc(w.doc(w.db, 'userSettings', u));
        var d = snap && snap.exists && snap.exists() ? snap.data() : null;
        var n = d && d.promiseSettings && d.promiseSettings.waitingDays;
        if (n != null) SETTINGS.waitingDays = PL.clampWaitingDays(n);
        SETTINGS.loaded = true;
        changed();
      } catch (e) { /* default stays; asked again next load */ }
      SETTINGS.busy = null;
      return SETTINGS.waitingDays;
    })();
    return SETTINGS.busy;
  }
  async function setWaitingDays(n) {
    var v = PL.clampWaitingDays(n);
    var prev = SETTINGS.waitingDays;
    SETTINGS.waitingDays = v;
    changed();
    var u = uid();
    try {
      if (!u || !w.setDoc || !w.doc || !w.db) throw new Error('not signed in');
      await w.setDoc(w.doc(w.db, 'userSettings', u), { promiseSettings: { waitingDays: v } }, { merge: true });
      SETTINGS.loaded = true;
      return true;
    } catch (e) {
      SETTINGS.waitingDays = prev;
      changed();
      toast("Couldn't save that setting - check your connection and try again", 'error');
      return false;
    }
  }

  // ── task writes ───────────────────────────────────────────────────────
  function taskRef(leadId, taskId) { return w.doc(w.db, 'leads', leadId, 'tasks', taskId); }
  function cached(leadId, taskId) { return ((w._taskCache || {})[leadId] || []).filter(function (t) { return t && t.id === taskId; })[0] || null; }
  function pushCache(leadId, t) {
    if (!w._taskCache) w._taskCache = {};
    var list = w._taskCache[leadId] || (w._taskCache[leadId] = []);
    for (var i = 0; i < list.length; i++) if (list[i].id === t.id) { list[i] = Object.assign(list[i], t); return; }
    list.push(t);
  }
  /** Optimistic patch on the cached task, honest rollback when the write fails. */
  async function patchTask(leadId, task, patch, withCompleted) {
    var t = cached(leadId, task.id) || task;
    var prev = {};
    Object.keys(patch).forEach(function (k) { prev[k] = t[k]; });
    var prevCompleted = t.completedAt;
    Object.assign(t, patch);
    if (withCompleted) t.completedAt = new Date();
    changed();
    try {
      var data = Object.assign({}, patch, { updatedAt: ts() });
      if (withCompleted) data.completedAt = ts();
      await w.updateDoc(taskRef(leadId, task.id), data);
      return true;
    } catch (e) {
      console.warn('[promise] write failed', e && (e.code || e.message));
      Object.assign(t, prev);
      t.completedAt = prevCompleted;
      changed();
      return false;
    }
  }
  var SAVE_FAIL = "Couldn't save that - check your connection and tap it again";

  async function keep(leadId, task) {
    var ok = await patchTask(leadId, task, PL.keptPatch(), true);
    if (!ok) toast(SAVE_FAIL, 'error'); else toast('Kept it', 'success');
    return ok;
  }
  async function dead(leadId, task) {
    var ok = await patchTask(leadId, task, PL.deadPatch(), true);
    if (!ok) toast(SAVE_FAIL, 'error'); else toast('Marked dead', 'info');
    return ok;
  }
  async function stillWaiting(leadId, task) {
    var ok = await patchTask(leadId, task, PL.stillWaitingPatch(task, todayYmd(), SETTINGS.waitingDays), false);
    if (!ok) toast(SAVE_FAIL, 'error'); else toast('Still waiting - clock reset to today', 'info');
    return ok;
  }
  async function moveTask(leadId, task, ymd) {
    var bad = PL.moveProblem(task, ymd, todayYmd());
    if (bad) return { ok: false, reason: bad };
    var ok = await patchTask(leadId, task, PL.movePatch(task, ymd, todayYmd()), false);
    return ok ? { ok: true } : { ok: false, reason: SAVE_FAIL };
  }

  // ── callable (the call's own promise / move) ──────────────────────────
  async function callable(name, data) {
    if (!w._functions || !w._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      w._functions = mod.getFunctions();
      w._httpsCallable = mod.httpsCallable;
    }
    var res = await w._httpsCallable(w._functions, name)(data);
    return res && res.data;
  }
  function reasonOf(e) {
    var m = String((e && e.message) || '');
    if (/failed-precondition|File this call/.test(m) || (e && e.code === 'functions/failed-precondition')) return m.replace(/^.*?:\s*/, '') || SAVE_FAIL;
    if (e && /invalid-argument/.test(String(e.code || ''))) return m || SAVE_FAIL;
    return SAVE_FAIL;
  }

  // ── a new promise task from the customer page (no call behind it) ──────
  async function createTask(lead, built) {
    if (!lead || !lead.id || !w.addDoc || !w.collection || !w.db) throw new Error('Customer not loaded.');
    var u = uid();
    var data = Object.assign({}, built, {
      leadId: lead.id, userId: lead.userId || u, title: built.text,
      createdBy: 'Promise capture', createdAt: ts(), madeAt: ts(), updatedAt: ts(),
    });
    if (lead.companyId) data.companyId = lead.companyId;
    var ref = await w.addDoc(w.collection(w.db, 'leads', lead.id, 'tasks'), data);
    pushCache(lead.id, Object.assign({}, built, { id: ref.id, leadId: lead.id, text: built.text, createdAt: new Date() }));
    changed();
    return ref.id;
  }

  // ── what a call's sheet saved, mirrored locally at once (QA 2026-10-13 H4) ──
  // The server wrote the task / the call's promise; Today reads window._taskCache
  // (tasks.js's one load) and NBDHomeAttention.lastRows, neither of which hears
  // about it until the next leads refresh - so the call vanished from "owed"
  // and the new promise was not on the list. Patch both, then repaint.
  // Home's rows (NBDHomeAttention.lastRows) and the Call Center's own list
  // (NBDCallCenter._state.calls) are different objects for the same call; both
  // are patched, or the one left stale keeps the person listed as owed.
  function callRows(id) {
    var out = [], HA = w.NBDHomeAttention, rows = (HA && HA.lastRows) || [];
    for (var i = 0; i < rows.length; i++) if (rows[i] && (rows[i].id === id || rows[i].id === 'text:' + id)) out.push(rows[i]);
    var cc = w.NBDCallCenter && w.NBDCallCenter._state && w.NBDCallCenter._state.calls;
    if (cc) for (var j = 0; j < cc.length; j++) if (cc[j] && cc[j].id === id && out.indexOf(cc[j]) === -1) out.push(cc[j]);
    return out;
  }
  function callRow(id) { return callRows(id)[0] || null; }
  function markHandledLocal(id) {
    callRows(id).forEach(function (c) { c.handledAtMs = Date.now(); });
  }
  var KEEP_HISTORY = ['missCount', 'rescheduleCount', 'madeYmd', 'madeBy', 'nudgeCount', 'waitingSince'];
  function mirrorSaved(res, o) {
    var mirrored = false;
    try {
      var today = todayYmd();
      var built = PL.buildTask({
        kind: o.kind, dueYmd: (res && res.dueDate) || o.due, why: o.why, todayYmd: today, uid: uid(),
        source: 'call', sourceCallId: o.callId, waitingOn: o.waitingOn, waitingDays: SETTINGS.waitingDays,
      });
      if (built.error) throw new Error(built.error);   // falls through to the reload below
      if (res.on === 'task' && res.taskId) {
        var row = callRow(o.callId);
        var leadId = o.leadId || (row && row.leadId) || '';
        if (!leadId) throw new Error('customer not found locally');
        var prev = cached(leadId, res.taskId);
        var t = Object.assign({}, built, { id: res.taskId, leadId: leadId, title: built.text, phoneCallId: o.callId, createdAt: new Date() });
        if (prev && prev.kind === 'promise') KEEP_HISTORY.forEach(function (k) { if (prev[k] != null) t[k] = prev[k]; });
        t.done = false; t.completedAt = null; t.outcome = null;
        pushCache(leadId, t);
        markHandledLocal(o.callId);   // the server marked the call handled with the task
        mirrored = true;
      } else if (res.on === 'call') {
        callRows(o.callId).forEach(function (c) {
          var p = Object.assign({}, built);
          if (c.promise && c.promise.kind === 'promise') ['missCount', 'rescheduleCount', 'madeYmd', 'madeBy'].forEach(function (k) { if (c.promise[k] != null) p[k] = c.promise[k]; });
          c.promise = p; c.promiseKind = o.kind; c.followUpDate = built.dueDate; c.handledAtMs = null;
          c.snoozeUntilYmd = built.dueDate > today ? built.dueDate : null;
          mirrored = true;
        });
      }
    } catch (e) { console.warn('[promise] local mirror skipped', e && e.message); }
    if (mirrored) changed();
    else {
      // Saved server-side but not found locally (no customer id on the sheet and the
      // call is in neither list): say so, and ask the task loader to re-read rather
      // than leave the promise off Today until the next leads refresh.
      console.warn('[promise] saved but not mirrored locally; asking for a reload');
      try { w.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'leads' } })); } catch (_) { /* old browser */ }
    }
  }
  // A moved promise that rides on a call: the new date, a miss if it was late.
  function mirrorMoved(callId, due) {
    try {
      var today = todayYmd();
      callRows(callId).forEach(function (c) {
        if (!c.promise) return;
        c.promise = Object.assign({}, c.promise, PL.movePatch(c.promise, due, today));
        c.followUpDate = due;
        c.snoozeUntilYmd = due > today ? due : null;
      });
    } catch (e) { console.warn('[promise] local move mirror skipped', e && e.message); }
    changed();
  }

  // ── the sheet ──────────────────────────────────────────────────────────
  var S = null;       // live sheet state
  var opener = null;

  function ensureDom() {
    var el = doc.getElementById('prSheet');
    if (el) return el;
    el = doc.createElement('div');
    el.id = 'prSheet';
    el.className = 'pr-overlay';
    el.hidden = true;
    el.innerHTML = '<div class="pr-back" data-pr-act="close"></div>' +
      '<div class="pr-sheet" role="dialog" aria-modal="true" aria-labelledby="prTitle" tabindex="-1">' +
      '<div class="pr-title" id="prTitle"></div><div class="pr-who" id="prWho"></div>' +
      '<div class="pr-body" id="prBody"></div></div>';
    doc.body.appendChild(el);
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
    return el;
  }

  function chipBtn(act, val, label, on, extra) {
    return '<button type="button" class="pr-chip' + (on ? ' is-on' : '') + (extra ? ' ' + extra : '') + '" data-pr-act="' + act + '" data-pr-val="' + esc(val) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (S && S.busy ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }

  function stepKind() {
    var h = '<div class="pr-kinds">';
    PL.KIND_KEYS.forEach(function (k) { h += chipBtn('kind', k, PL.KINDS[k].label, false, S.busy ? 'is-busy' : ''); });
    if (S.mode === 'handle') h += chipBtn('kind', 'none', S.busy ? 'Saving\u2026' : 'Nothing owed', false, 'pr-none' + (S.busy ? ' is-busy' : ''));
    h += '</div>';
    if (S.mode === 'handle') h += '<div class="pr-note">Handling a call asks what you owe. Pick one, or Nothing owed.</div>';
    // The error has to live on THIS step too: Nothing owed fails here, on the
    // chips, not on the detail step (UX walk H3: #prErr existed only on step 2).
    h += '<div class="pr-err" id="prErr" role="alert" aria-live="polite">' + esc(S.err || '') + '</div>';
    return h;
  }
  function stepDetail() {
    var h = '';
    if (S.mode !== 'move') h += '<button type="button" class="pr-link" data-pr-act="back">&larr; ' + esc(PL.KINDS[S.kind].label) + '</button>';
    if (S.kind === 'waiting' && S.mode !== 'move') {
      h += '<div class="pr-sec">Waiting on</div><div class="pr-kinds">';
      PL.WAITING_ON_KEYS.forEach(function (k) { h += chipBtn('who', k, k === 'other' ? 'Someone else' : k.charAt(0).toUpperCase() + k.slice(1), S.waitingOn === k); });
      h += '</div>';
    }
    h += '<div class="pr-sec">' + (S.kind === 'waiting' && S.mode !== 'move' ? 'Nudge me on' : (S.mode === 'move' ? 'New date' : 'Due')) + '</div><div class="pr-kinds">';
    PL.DUE_CHIPS.forEach(function (c) { h += chipBtn('due', c.id, c.label, S.dueChip === c.id); });
    h += chipBtn('due', 'pick', 'Pick a date', S.dueChip === 'pick');
    h += '</div>';
    h += '<input type="date" class="pr-date" id="prDate" aria-label="Pick a date" min="' + esc(todayYmd()) + '" value="' + esc(S.dueYmd || '') + '"' + (S.dueChip === 'pick' ? '' : ' hidden') + '>';
    if (S.mode !== 'move') {
      h += '<label class="pr-sec" for="prWhy">What did you say? (one line)</label>' +
        '<input type="text" class="pr-why" id="prWhy" maxlength="' + PL.WHY_MAX + '" autocomplete="off" placeholder="e.g. quoted the number, will text it Friday" value="' + esc(S.why || '') + '">';
    }
    h += '<div class="pr-err" id="prErr" role="alert" aria-live="polite">' + esc(S.err || '') + '</div>';
    h += '<div class="pr-foot"><button type="button" class="pr-link" data-pr-act="close">Cancel</button>' +
      '<button type="button" class="pr-save" data-pr-act="save"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : (S.mode === 'move' ? 'Move it' : 'Save promise')) + '</button></div>';
    return h;
  }
  function paint() {
    var el = ensureDom();
    var title = el.querySelector('#prTitle'), who = el.querySelector('#prWho'), body = el.querySelector('#prBody');
    if (S.mode === 'move') { title.textContent = 'Move this promise'; who.textContent = (S.name ? S.name + ' - ' : '') + (S.moveText || ''); }
    else if (S.mode === 'handle') { title.textContent = 'What did you promise' + (S.name ? ' ' + firstName(S.name) : '') + '?'; who.textContent = S.summary ? String(S.summary).slice(0, 120) : ''; }
    else { title.textContent = 'Add a promise' + (S.name ? ' for ' + firstName(S.name) : ''); who.textContent = ''; }
    body.innerHTML = S.mode === 'move' || S.kind ? stepDetail() : stepKind();
  }
  function open(o) {
    var x = o || {};
    if (isViewer()) return;
    opener = doc.activeElement;
    S = {
      mode: x.mode === 'move' ? 'move' : (x.mode === 'handle' ? 'handle' : 'promise'),
      name: x.name || '', leadId: x.leadId || '', lead: x.lead || null,
      callIds: Array.isArray(x.callIds) ? x.callIds.slice() : [],
      summary: x.summary || '', why: PL.cleanWhy(x.why || ''), move: x.move || null, moveText: x.moveText || '',
      onDone: typeof x.onDone === 'function' ? x.onDone : null,
      kind: '', waitingOn: 'customer', dueChip: '', dueYmd: '', err: '', busy: false,
    };
    if (S.mode === 'move') { S.dueChip = ''; S.dueYmd = ''; }
    var el = ensureDom();
    paint();
    el.hidden = false;
    var sh = el.querySelector('.pr-sheet');
    var first = sh.querySelector('button.pr-chip');
    try { (first || sh).focus(); } catch (_) { /* hidden */ }
  }
  function close() {
    var el = doc.getElementById('prSheet');
    if (el) el.hidden = true;
    S = null;
    try { if (opener && opener.focus && doc.contains(opener)) opener.focus(); } catch (_) { /* gone */ }
    opener = null;
  }
  function setErr(m) {
    if (S) S.err = m || '';
    var e = doc.getElementById('prErr');
    if (e) e.textContent = m || '';
  }

  function onInput(ev) {
    if (!S) return;
    var t = ev.target;
    if (t && t.id === 'prWhy') S.why = t.value;
    if (t && t.id === 'prDate') { S.dueYmd = t.value; S.dueChip = 'pick'; setErr(''); }
  }

  async function save() {
    if (!S || S.busy) return;
    // The sheet can be closed (Cancel, Escape, the backdrop) while the callable is
    // in flight: close() nulls S. Everything after an await reads this snapshot,
    // never S - a null S used to throw AFTER the server had saved the promise.
    var st = S;
    var today = todayYmd();
    var why = PL.cleanWhy(S.why);
    var due = S.dueYmd;
    var bad = PL.dueProblem(due, today);
    if (bad) { setErr(bad); return; }
    S.busy = true; paint();
    try {
      if (st.mode === 'move') {
        var m = st.move || {};
        if (m.type === 'call') {
          var pm = await callable('callCenterAction', { id: m.callId, action: 'promiseMove', dueYmd: due });
          if (!(pm && pm.ok)) throw new Error('move');
          mirrorMoved(m.callId, due);
        } else {
          var r = await moveTask(m.leadId, m.task, due);
          if (!r.ok) { if (S === st) { st.busy = false; paint(); setErr(r.reason); } return; }
        }
      } else if (st.callIds.length) {
        // The call's own action: task + handled + supersede, server side.
        var primary = st.callIds[0];
        var res = await callable('callCenterAction', {
          id: primary, action: 'promise', kind: st.kind, dueYmd: due, why: why,
          waitingOn: st.kind === 'waiting' ? st.waitingOn : undefined, waitingDays: SETTINGS.waitingDays,
        });
        if (!(res && res.ok)) throw new Error('promise');
        mirrorSaved(res, { callId: primary, leadId: st.leadId || (st.lead && st.lead.id) || '', kind: st.kind, due: due, why: why, waitingOn: st.waitingOn });
        // The rest of that person's open calls are covered by this promise.
        // (parallel and allSettled: one failing write must not stop the others,
        // and the promise itself is already saved - say what did not close)
        var rest = st.callIds.slice(1);
        var restRes = await Promise.allSettled(rest.map(function (id) { return callable('callCenterAction', { id: id, action: 'handled' }); }));
        var restBad = 0;
        restRes.forEach(function (x, i) { if (x.status === 'fulfilled' && !(x.value && x.value.ok === false)) markHandledLocal(rest[i]); else restBad++; });
        if (restBad) toast('Promise saved, but ' + restBad + ' other call' + (restBad === 1 ? ' was' : 's were') + " not marked handled - they are still listed", 'error');
      } else {
        var built = PL.buildTask({
          kind: st.kind, dueYmd: due, why: why, todayYmd: today, uid: uid(), source: 'customer',
          waitingOn: st.waitingOn, waitingDays: SETTINGS.waitingDays,
        });
        if (built.error) { if (S === st) { st.busy = false; paint(); setErr(built.error); } return; }
        await createTask(st.lead || { id: st.leadId }, built);
      }
    } catch (e) {
      console.warn('[promise] save failed', e && (e.code || e.message));
      if (S === st) { st.busy = false; paint(); setErr(reasonOf(e)); }
      return;
    }
    var done = st.onDone, mode = st.mode, kind = st.kind;
    if (S === st) close();
    toast(mode === 'move' ? 'Moved' : 'Promise saved - it will be on your list', 'success');
    try { if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true); } catch (_) { /* best effort */ }
    if (done) { try { done({ saved: true, kind: kind, due: due, mode: mode }); } catch (_) { /* caller's */ } }
  }

  async function nothingOwed() {
    if (!S) return;
    // A second tap while the writes are in flight does nothing: it used to close
    // the sheet mid-save, leaving a later failure with nowhere to show.
    if (S.busy) return;
    if (!S.callIds.length) { close(); return; }
    var st = S;     // see save(): the sheet can be closed while this is in flight
    st.busy = true; st.err = '';
    paint();
    var ids = st.callIds.slice();
    var res = await Promise.allSettled(ids.map(function (id) { return callable('callCenterAction', { id: id, action: 'handled' }); }));
    var left = [];
    res.forEach(function (x, i) { if (x.status === 'fulfilled' && !(x.value && x.value.ok === false)) markHandledLocal(ids[i]); else left.push(ids[i]); });
    if (left.length) {
      // Retry asks only for what did not save.
      st.callIds = left;
      st.busy = false;
      try { if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true); } catch (_) { /* best effort */ }
      if (S === st) { st.err = (ids.length - left.length) + ' of ' + ids.length + " saved - tap Nothing owed again for the rest. Check your connection."; paint(); }
      else toast(SAVE_FAIL, 'error');
      return;
    }
    var done = st.onDone;
    if (S === st) close();
    try { if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true); } catch (_) { /* best effort */ }
    if (done) { try { done({ saved: true, kind: 'none' }); } catch (_) { /* caller's */ } }
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-pr-act]') : null;
    if (!t || !S) return;
    var act = t.getAttribute('data-pr-act'), val = t.getAttribute('data-pr-val') || '';
    if (act === 'close') { close(); return; }
    if (act === 'back') { S.kind = ''; S.err = ''; paint(); return; }
    if (S.busy && (act === 'kind' || act === 'who' || act === 'due' || act === 'back')) return;
    if (act === 'kind') {
      if (val === 'none') { nothingOwed(); return; }
      if (!PL.isKind(val)) return;
      S.kind = val; S.err = '';
      S.dueYmd = PL.defaultDue(val, todayYmd(), SETTINGS.waitingDays);
      S.dueChip = PL.chipForDue(S.dueYmd, todayYmd());
      paint();
      var why = doc.getElementById('prWhy'); if (why) { try { why.focus(); } catch (_) { /* ignore */ } }
      return;
    }
    if (act === 'who') { S.waitingOn = PL.isWaitingOn(val) ? val : 'customer'; paint(); return; }
    if (act === 'due') {
      S.err = '';
      if (val === 'pick') {
        S.dueChip = 'pick';
        paint();
        var d = doc.getElementById('prDate'); if (d) { try { d.focus(); if (d.showPicker) d.showPicker(); } catch (_) { /* needs gesture */ } }
        return;
      }
      S.dueChip = val; S.dueYmd = PL.dueFromChip(val, todayYmd()); paint(); return;
    }
    if (act === 'save') { save(); return; }
  }

  // ── Nudge: a DRAFT in Jo's own composer, never sent from here ───────────
  async function nudge(row) {
    if (!row || isViewer()) return { ok: false };
    var lead = (w._leads || []).filter(function (l) { return l && l.id === row.leadId; })[0] || null;
    var task = cached(row.leadId, row.taskId) || { id: row.taskId, nudgeCount: row.nudgeCount };
    var on = PL.isWaitingOn(row.waitingOn) ? row.waitingOn : 'customer';
    var recipientName = on === 'adjuster' ? (row.adjusterName || '') : (on === 'customer' ? row.name : '');
    var from = '';
    try {
      var dn = String((w._user && w._user.displayName) || '').trim().split(/\s+/)[0];
      var brand = String((w._companyProfile && (w._companyProfile.companyName || w._companyProfile.name)) || '').trim();
      from = dn && brand ? dn + ' with ' + brand : (dn || brand || '');
    } catch (_) { from = ''; }
    var draft = PL.nudgeDraft({ waitingOn: on, recipientName: recipientName, from: from, claimNumber: row.claimNumber });
    if (!w.NBDPhoneShare || typeof w.NBDPhoneShare.share !== 'function') {
      toast("Couldn't open a draft here - open the customer and text them from there", 'error');
      return { ok: false };
    }
    var phone = on === 'adjuster' ? row.adjusterPhone : (on === 'customer' ? row.phone : '');
    var opts = { text: draft.text, subject: draft.subject, title: draft.subject, phone: phone || undefined, email: on === 'customer' ? row.email : undefined, ask: 'Did the message go out from your phone?', source: 'promise_nudge' };
    if (on === 'customer') opts.leadId = row.leadId;
    else if (phone) opts.recipient = 'number';
    var res = await w.NBDPhoneShare.share(opts);
    if (res && res.shared) {
      var ok = await patchTask(row.leadId, task, PL.nudgePatch(task, todayYmd()), false);
      if (!ok) toast("The message went out but the nudge wasn't recorded - tap Nudge again later", 'info');
      else toast('Nudge recorded', 'success');
      return { ok: true, shared: true };
    }
    return { ok: false, shared: false };
  }

  // ── customer page: the Promise button ───────────────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-promise-open]') : null;
    if (!t) return;
    ev.preventDefault();
    var leadId = t.getAttribute('data-promise-open') || w._customerId || '';
    var lead = null;
    if (typeof w._currentLead === 'object' && w._currentLead) lead = Object.assign({}, w._currentLead, { id: leadId });
    var fromList = (w._leads || []).filter(function (l) { return l && l.id === leadId; })[0];
    if (fromList) lead = fromList;
    if (!lead && leadId) lead = { id: leadId };
    var nm = lead ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.name || '') : '';
    open({ mode: 'promise', leadId: leadId, lead: lead, name: nm, onDone: function () { try { if (typeof w.loadTimeline === 'function') w.loadTimeline(leadId, w._leadDoc || w._currentLead); } catch (_) { /* optional */ } } });
  });

  w.NBDPromise = {
    openSheet: open, closeSheet: close,
    keep: keep, dead: dead, stillWaiting: stillWaiting, move: moveTask, nudge: nudge,
    waitingDays: function () { return SETTINGS.waitingDays; },
    setWaitingDays: setWaitingDays, loadSettings: loadSettings,
    createTask: createTask,
    _state: function () { return S; },
  };
  loadSettings();
  changed();
})();
