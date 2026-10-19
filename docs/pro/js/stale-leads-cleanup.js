/**
 * stale-leads-cleanup.js — "Clean up stale leads" (2026-10-19).
 *
 * Jo had 86 leads sitting in stage `new`, 40 of them Thumbtack leads nobody
 * touched for 30+ days. Agents cannot change a stage, so this is a UI action:
 * the CRM board toolbar gets a "Clean up stale leads" button that lists leads
 * in stage `new` with no activity for N days (14 / 30 / 60 / 90, default 30),
 * optionally for one source, as a preview table with a checkbox per row (all
 * checked, nothing is sent until the confirm step), then moves the checked
 * ones to Lost with the reason "Stale - no response".
 *
 * Ships DARK behind the `bulkCloseStaleLeads` feature flag
 * (feature_flags/_default). Absent / false = no button, no modal, no listener
 * does anything: nothing renders and nothing is written.
 *
 * Writes go through the CRM's own path, one lead at a time:
 *   window.moveCard(id, 'lost', { lostReason, lostReasonKey: 'no_response' })
 *   → stage-write.js commitStageChange: a Firestore transaction with the
 *     stale-write guards, stage + stageRole + closedAt + lostReason(+Key),
 *     a stageHistory entry (who, when, reason), and the "Stage moved to Lost"
 *     activity note. That is the same path "Mark lost" and the No-next-step
 *     bulk lost use, so there is no second way to write a stage. (A raw
 *     500-doc writeBatch would skip the race guard, the history and the
 *     note, so it is deliberately NOT used; leads are processed in chunks of
 *     CHUNK so the progress line stays honest and the page stays responsive.)
 * Soft change only: nothing is deleted and no write here sets `deleted`.
 *
 * Undo (this session): the previous stage / stageRole / stageStartedAt /
 * closedAt / updatedAt of every closed lead are kept in memory. Undo puts them
 * back in a transaction, lead by lead, but only while the lead is still Lost
 * with THIS cleanup's reason (a lead somebody moved since is left alone and
 * counted as skipped). It clears lostReason / lostReasonKey / lostReasonNote,
 * appends an undo entry to stageHistory (never deletes one) and files an
 * activity note.
 *
 * Permissions: viewers cannot open it, and a lead is listed only when the
 * signed-in user may change it (own lead, or same company for
 * manager / company_admin; the rule commitBulkLeadOp and No-next-step use).
 * The list is built from window._leads, which is already tenant-scoped.
 *
 * Pure logic is exported for tests (module.exports under Node).
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  var DAY = 86400000;
  var DAY_CHOICES = [14, 30, 60, 90];
  var DEFAULT_DAYS = 30;
  var CHUNK = 25;
  var REASON = 'Stale - no response';
  var REASON_KEY = 'no_response';
  var FLAG = 'bulkCloseStaleLeads';

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }

  /** Latest moment anything touched the lead (0 = no usable date at all). */
  function lastActivityMs(lead) {
    var l = lead || {};
    return Math.max(toMs(l.updatedAt), toMs(l.stageStartedAt), toMs(l.lastContactedAt), toMs(l.lastActivityAt), toMs(l.createdAt));
  }

  function stageKeyOf(lead, normalize) {
    if (lead._stageKey) return lead._stageKey;
    if (typeof normalize === 'function') { try { return normalize(lead.stage) || lead.stage || 'new'; } catch (_) {} }
    return lead.stage || 'new';
  }

  function sourceLabel(lead) {
    var s = String((lead && lead.source) == null ? '' : lead.source).trim();
    return s || 'Unknown';
  }
  function sourceKey(lead) { return sourceLabel(lead).toLowerCase(); }

  function nameOf(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '').trim();
    return n || String(lead.address || '').split(',')[0] || 'Customer';
  }

  function ymd(now) {
    var d = new Date(now);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** A planned next step (future snooze, follow-up today or later) is not "no activity". */
  function hasPlannedNextStep(lead, now) {
    if (toMs(lead.snoozedUntil) > now) return true;
    var f = String(lead.followUp == null ? '' : lead.followUp).trim();
    return f !== '' && f.slice(0, 10) >= ymd(now);
  }

  /** Is this a lead the cleanup may list at all (before the age / source filters)? */
  function isNewStageLead(lead, env) {
    if (!lead || !lead.id) return false;
    if (lead.deleted === true) return false;
    if (lead.isProspect) return false;                       // prospects live on their own page
    env = env || {};
    var sk = stageKeyOf(lead, env.normalizeStage);
    return String(sk).toLowerCase() === 'new';
  }

  /**
   * The stale list.
   * @param {Array} leads  window._leads
   * @param {{days?:number, source?:string, now?:number}} opts  source '' / 'all' = every source
   * @param {{normalizeStage?:Function, canChange?:Function}} [env]
   * @returns {Array<{id,lead,name,source,createdMs,lastMs,ageDays}>} oldest first.
   *   Leads with no usable date anywhere are left out (cannot prove they are stale).
   */
  function selectStale(leads, opts, env) {
    opts = opts || {}; env = env || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var days = DAY_CHOICES.indexOf(opts.days) >= 0 ? opts.days : DEFAULT_DAYS;
    var want = String(opts.source == null ? '' : opts.source).trim().toLowerCase();
    if (want === 'all') want = '';
    var cutoff = now - days * DAY;
    var out = [];
    (leads || []).forEach(function (l) {
      if (!isNewStageLead(l, env)) return;
      if (typeof env.canChange === 'function' && !env.canChange(l)) return;
      if (want && sourceKey(l) !== want) return;
      if (hasPlannedNextStep(l, now)) return;
      var last = lastActivityMs(l);
      if (!last || last > cutoff) return;
      out.push({
        id: l.id, lead: l, name: nameOf(l), source: sourceLabel(l),
        createdMs: toMs(l.createdAt), lastMs: last,
        ageDays: Math.max(0, Math.floor((now - last) / DAY)),
      });
    });
    out.sort(function (a, b) { return a.lastMs - b.lastMs || (a.id < b.id ? -1 : 1); });
    return out;
  }

  /** Source dropdown: every source among stage-new leads, with how many are stale at `days`. */
  function sourceOptions(leads, opts, env) {
    var all = selectStale(leads, Object.assign({}, opts, { source: '' }), env);
    var by = {};
    all.forEach(function (r) {
      var k = r.source.toLowerCase();
      by[k] = by[k] || { key: k, label: r.source, count: 0 };
      by[k].count++;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.count - a.count || (a.label < b.label ? -1 : 1); });
  }

  /** Ids that will be closed: the candidates minus the unchecked ones. Order preserved. */
  function selectedIds(candidates, unchecked) {
    var skip = unchecked instanceof Set ? unchecked : new Set(unchecked || []);
    return (candidates || []).filter(function (r) { return !skip.has(r.id); }).map(function (r) { return r.id; });
  }

  function chunk(arr, n) {
    var size = n > 0 ? n : CHUNK, out = [];
    for (var i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /** What Undo needs from a lead BEFORE it is closed. */
  function snapshotForUndo(lead) {
    return {
      id: lead.id,
      stage: lead.stage || 'new',
      stageRole: lead.stageRole === undefined ? null : lead.stageRole,
      stageStartedAt: lead.stageStartedAt === undefined ? null : lead.stageStartedAt,
      closedAt: lead.closedAt === undefined ? null : lead.closedAt,
      updatedAt: lead.updatedAt === undefined ? null : lead.updatedAt,
    };
  }

  /**
   * The Firestore patch that puts a closed lead back, or null when the lead
   * is no longer in the state this cleanup left it (moved, reopened, or lost
   * for a different reason) and must be left alone.
   * Never sets `deleted`. Fields the lead did not have before go back to null
   * (the app reads null and absent alike).
   */
  function undoPatch(cur, snap) {
    if (!cur || !snap) return null;
    if (!/^lost$/i.test(String(cur.stage || ''))) return null;
    if (cur.lostReason !== REASON) return null;
    return {
      stage: snap.stage,
      stageRole: snap.stageRole,
      stageStartedAt: snap.stageStartedAt,
      closedAt: snap.closedAt,
      updatedAt: snap.updatedAt,
      lostReason: null, lostReasonKey: null, lostReasonNote: null,
    };
  }

  function confirmText(n) {
    return 'Mark ' + n + ' lead' + (n === 1 ? '' : 's') + ' as Lost with the reason "' + REASON + '"? Nothing is deleted and nothing is sent to anyone. You can undo it right after.';
  }

  var pure = {
    lastActivityMs: lastActivityMs, selectStale: selectStale, sourceOptions: sourceOptions,
    selectedIds: selectedIds, chunk: chunk, snapshotForUndo: snapshotForUndo, undoPatch: undoPatch,
    isNewStageLead: isNewStageLead, hasPlannedNextStep: hasPlannedNextStep, confirmText: confirmText,
    DAY_CHOICES: DAY_CHOICES, DEFAULT_DAYS: DEFAULT_DAYS, CHUNK: CHUNK, REASON: REASON, REASON_KEY: REASON_KEY, FLAG: FLAG,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (!root || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  if (w.NBDStaleLeads) return;

  var overlay = null;
  var st = { days: DEFAULT_DAYS, source: '', unchecked: new Set(), confirming: false, busy: false, progress: '', result: '' };
  var lastBatch = null;          // { snaps: [...], at, count } — in memory, this session only

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function isViewer() { return (claims().role || '') === 'viewer'; }
  // Same mutable-lead rule as commitBulkLeadOp (crm-portal-bridge.js) / No-next-step.
  function canChange(l) {
    var c = claims(), role = c.role || '', uid = (w._user && w._user.uid) || null;
    if (role === 'viewer') return false;
    if (role === 'admin' || !l.userId || !uid || l.userId === uid) return true;
    return (role === 'company_admin' || role === 'manager') && !!c.companyId && l.companyId === c.companyId;
  }
  function env() { return { normalizeStage: w.normalizeStage, canChange: canChange }; }
  function flagOn() {
    return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG));
  }
  function available() { return flagOn() && !isViewer(); }

  function candidates() {
    return selectStale(w._leads || [], { days: st.days, source: st.source }, env());
  }
  function fmtDate(ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { return '—'; }
  }

  // ── toolbar button: hidden unless the flag is on ─────────────────────
  function syncButton() {
    var b = doc.getElementById('staleLeadsBtn');
    if (!b) return;
    b.hidden = !available();
  }

  // ── modal ────────────────────────────────────────────────────────────
  function rowHtml(r) {
    var checked = !st.unchecked.has(r.id);
    return '<tr class="slc-row">' +
      '<td class="slc-c-check" data-label=""><input type="checkbox" class="slc-check" data-slc-id="' + esc(r.id) + '"' + (checked ? ' checked' : '') + (st.busy ? ' disabled' : '') + ' aria-label="Include ' + esc(r.name) + '"></td>' +
      '<td class="slc-c-name" data-label="Name">' + esc(r.name) + '</td>' +
      '<td data-label="Source">' + esc(r.source) + '</td>' +
      '<td data-label="Created">' + esc(fmtDate(r.createdMs)) + '</td>' +
      '<td data-label="Last activity">' + esc(fmtDate(r.lastMs)) + '</td>' +
      '<td data-label="Age">' + r.ageDays + ' days</td>' +
      '</tr>';
  }

  function bodyHtml() {
    var list = candidates();
    var ids = selectedIds(list, st.unchecked);
    var n = ids.length;
    var opts = sourceOptions(w._leads || [], { days: st.days }, env());
    var dis = st.busy ? ' disabled' : '';
    var h = '<div class="slc-head"><h2 class="slc-title" id="slcTitle">Clean up stale leads</h2>' +
      '<button type="button" class="slc-x" data-slc-act="close" aria-label="Close"' + (st.busy ? ' disabled' : '') + '>×</button></div>' +
      '<p class="slc-sub">Leads still in <b>New</b> with no activity for a while. Checked leads move to <b>Lost</b> ("' + esc(REASON) + '"). Nothing is deleted and nothing is sent to anyone.</p>';
    if (lastBatch && lastBatch.snaps.length) {
      h += '<div class="slc-undo"><span>Last cleanup closed ' + lastBatch.snaps.length + ' lead' + (lastBatch.snaps.length === 1 ? '' : 's') + '.</span>' +
        '<button type="button" class="slc-btn" data-slc-act="undo"' + dis + '>Undo it</button></div>';
    }
    h += '<div class="slc-filters">' +
      '<label class="slc-f">No activity for <select class="slc-sel" data-slc-f="days"' + dis + '>' +
        DAY_CHOICES.map(function (d) { return '<option value="' + d + '"' + (d === st.days ? ' selected' : '') + '>' + d + ' days</option>'; }).join('') + '</select></label>' +
      '<label class="slc-f">Source <select class="slc-sel" data-slc-f="source"' + dis + '><option value="">All sources</option>' +
        opts.map(function (o) { return '<option value="' + esc(o.key) + '"' + (o.key === st.source ? ' selected' : '') + '>' + esc(o.label) + ' (' + o.count + ')</option>'; }).join('') + '</select></label>' +
      '</div>';
    if (st.result) h += '<div class="slc-result" role="status">' + esc(st.result) + '</div>';
    if (!list.length) {
      h += '<p class="slc-empty">No stale leads match. Nothing to clean up.</p>';
    } else {
      h += '<div class="slc-bar"><span class="slc-count" id="slcCount">' + n + ' of ' + list.length + ' selected</span>' +
        '<span><button type="button" class="slc-link" data-slc-act="all"' + dis + '>Select all</button>' +
        '<button type="button" class="slc-link" data-slc-act="none"' + dis + '>Select none</button></span></div>' +
        '<table class="slc-table"><thead><tr><th class="slc-c-check"><span class="slc-sr">Include</span></th><th>Name</th><th>Source</th><th>Created</th><th>Last activity</th><th>Age</th></tr></thead><tbody>' +
        list.map(rowHtml).join('') + '</tbody></table>';
    }
    if (st.busy) {
      h += '<div class="slc-foot"><span class="slc-progress" role="status">' + esc(st.progress) + '</span></div>';
    } else if (st.confirming) {
      h += '<div class="slc-confirm" role="alertdialog" aria-label="Confirm"><p>' + esc(confirmText(n)) + '</p>' +
        '<div class="slc-foot"><button type="button" class="slc-btn" data-slc-act="back">Back</button>' +
        '<button type="button" class="slc-btn slc-danger" data-slc-act="go">Yes, close ' + n + ' lead' + (n === 1 ? '' : 's') + '</button></div></div>';
    } else {
      h += '<div class="slc-foot"><button type="button" class="slc-btn" data-slc-act="close">Cancel</button>' +
        '<button type="button" class="slc-btn slc-danger" data-slc-act="review"' + (n ? '' : ' disabled') + '>Close ' + n + ' lead' + (n === 1 ? '' : 's') + '…</button></div>';
    }
    return h;
  }

  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;                 // a checkbox tap must not jump the list
    overlay.innerHTML = '<div class="slc-box" role="dialog" aria-modal="true" aria-labelledby="slcTitle">' + bodyHtml() + '</div>';
    overlay.scrollTop = keep;
  }

  function open() {
    if (!available()) return false;           // flag off / viewer: nothing renders
    if (overlay) { paint(); return true; }
    st.days = DEFAULT_DAYS; st.source = ''; st.unchecked = new Set(); st.confirming = false; st.busy = false; st.progress = ''; st.result = '';
    overlay = doc.createElement('div');
    overlay.className = 'slc-overlay';
    overlay.setAttribute('data-slc-overlay', '1');
    doc.body.appendChild(overlay);
    paint();
    return true;
  }
  function close() {
    if (st.busy) return;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    else if (overlay && typeof overlay.remove === 'function') overlay.remove();
    overlay = null;
  }

  // ── the write ────────────────────────────────────────────────────────
  function leadById(id) { return (w._leads || []).filter(function (l) { return l && l.id === id; })[0] || null; }

  async function closeSelected() {
    if (typeof w.moveCard !== 'function') { toast('Pipeline not loaded — open the board once and try again', 'error'); return; }
    // Re-read at write time: only leads that are still stale, still New and still allowed.
    var fresh = new Set(candidates().map(function (r) { return r.id; }));
    var ids = selectedIds(candidates(), st.unchecked).filter(function (id) { return fresh.has(id); });
    if (!ids.length) return;
    st.busy = true; st.confirming = false; st.result = '';
    var done = [], failed = 0, chunks = chunk(ids, CHUNK);
    for (var c = 0; c < chunks.length; c++) {
      for (var i = 0; i < chunks[c].length; i++) {
        var id = chunks[c][i], l = leadById(id);
        if (!l) { failed++; continue; }
        var snap = snapshotForUndo(l);                 // BEFORE moveCard mutates the lead
        var ok = false;
        try { ok = (await w.moveCard(id, 'lost', { lostReason: REASON, lostReasonKey: REASON_KEY })) === true; } catch (_) { ok = false; }
        if (ok) done.push(snap); else failed++;
        st.progress = 'Closing ' + (done.length + failed) + ' of ' + ids.length + '…';
        paint();
      }
    }
    st.busy = false;
    st.unchecked = new Set();
    if (done.length) lastBatch = { snaps: done, at: Date.now() };
    st.result = 'Closed ' + done.length + ' lead' + (done.length === 1 ? '' : 's') + ' as Lost' + (failed ? ' · ' + failed + ' not moved (open them to see why)' : '') + '.';
    paint();
    if (done.length && typeof w.showToast === 'function') {
      w.showToast({
        message: 'Closed ' + done.length + ' stale lead' + (done.length === 1 ? '' : 's'),
        type: failed ? 'warning' : 'success', duration: 10000, undoText: 'Undo',
        undoAction: function () { undoLast(); },
      });
    }
  }

  async function actorFields() {
    var a = null;
    try { var m = await import('./stage-write.js'); a = m.stageActor(); } catch (_) { /* fall back below */ }
    if (!a) {
      var u = (w.auth && w.auth.currentUser) || w._user || {};
      a = { uid: u.uid || null, email: u.email || null, name: u.displayName || null, label: u.email || u.uid || 'unknown' };
    }
    return a;
  }

  async function undoLast() {
    if (!lastBatch || st.busy) return;
    if (typeof w.runTransaction !== 'function' || !w.db) { toast('Undo unavailable on this page — reload the board', 'error'); return; }
    var batch = lastBatch, actor = await actorFields();
    st.busy = true; st.result = ''; paint();
    var back = 0, skipped = 0, failed = 0;
    for (var c = 0, chunks = chunk(batch.snaps, CHUNK); c < chunks.length; c++) {
      for (var i = 0; i < chunks[c].length; i++) {
        var snap = chunks[c][i];
        try {
          var ref = w.doc(w.db, 'leads', snap.id);
          var applied = false;
          await w.runTransaction(w.db, async function (tx) {
            applied = false;
            var s = await tx.get(ref);
            if (!s.exists()) return;
            var patch = undoPatch(s.data() || {}, snap);
            if (!patch) return;
            if (patch.stageStartedAt == null) patch.stageStartedAt = w.serverTimestamp();
            if (patch.updatedAt == null) patch.updatedAt = w.serverTimestamp();
            var ev = { from: 'lost', to: snap.stage, timestamp: new Date().toISOString(), user: actor.label, by: actor.uid, staleCleanupUndo: true };
            if (actor.email) ev.byEmail = actor.email;
            patch.stageHistory = w.arrayUnion(ev);
            tx.update(ref, patch);
            applied = true;
          });
          if (!applied) { skipped++; continue; }
          back++;
          var l = leadById(snap.id);
          if (l) {
            l.stage = snap.stage; l._stageKey = w.normalizeStage ? w.normalizeStage(snap.stage) : snap.stage;
            l._stageRole = w.stageRole ? w.stageRole(snap.stage) : l._stageRole;
            l.lostReason = null; l.lostReasonKey = null; l.lostReasonNote = null;
          }
          try {
            await w.addDoc(w.collection(w.db, 'notes'), {
              leadId: snap.id, userId: actor.uid, type: 'stage_change',
              text: 'Undid stale-lead cleanup - back to "' + snap.stage + '"',
              createdAt: w.serverTimestamp(), createdBy: actor.email || 'system',
            });
          } catch (e) { console.warn('[stale-leads] undo note failed:', e && e.message); }
        } catch (e) { failed++; console.warn('[stale-leads] undo failed', snap.id, e && (e.code || e.message)); }
      }
    }
    st.busy = false;
    lastBatch = null;
    st.result = 'Undone: ' + back + ' lead' + (back === 1 ? '' : 's') + ' back in New' +
      (skipped ? ' · ' + skipped + ' left alone (changed since)' : '') + (failed ? ' · ' + failed + ' failed' : '') + '.';
    if (typeof w.renderLeads === 'function') { try { w.renderLeads(w._leads, w._filteredLeads); } catch (_) {} }
    if (overlay) paint(); else toast(st.result, failed ? 'warning' : 'success');
  }

  // ── events ───────────────────────────────────────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-slc-act],#staleLeadsBtn');
    if (!t) return;
    if (t.id === 'staleLeadsBtn') { ev.preventDefault(); open(); return; }
    if (!overlay || !available()) return;
    var act = t.getAttribute('data-slc-act');
    if (act === 'close') close();
    else if (act === 'all') { st.unchecked = new Set(); st.confirming = false; paint(); }
    else if (act === 'none') { st.unchecked = new Set(candidates().map(function (r) { return r.id; })); st.confirming = false; paint(); }
    else if (act === 'review') { if (selectedIds(candidates(), st.unchecked).length) { st.confirming = true; paint(); } }
    else if (act === 'back') { st.confirming = false; paint(); }
    else if (act === 'go') { if (st.confirming && !st.busy) closeSelected().catch(function (e) { st.busy = false; toast('Could not finish: ' + (e && e.message || 'unknown error'), 'error'); paint(); }); }
    else if (act === 'undo') { undoLast().catch(function (e) { st.busy = false; toast('Undo failed: ' + (e && e.message || 'unknown error'), 'error'); paint(); }); }
  });
  doc.addEventListener('change', function (ev) {
    if (!overlay || !ev.target || st.busy) return;
    var el = ev.target, f = el.getAttribute && el.getAttribute('data-slc-f');
    if (f) {
      if (f === 'days') st.days = parseInt(el.value, 10) || DEFAULT_DAYS;
      if (f === 'source') st.source = String(el.value || '');
      st.unchecked = new Set(); st.confirming = false; st.result = '';      // a new list starts all-checked
      paint(); return;
    }
    var id = el.getAttribute && el.getAttribute('data-slc-id');
    if (id) {
      if (el.checked) st.unchecked.delete(id); else st.unchecked.add(id);
      st.confirming = false; paint();
    }
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  function init() {
    syncButton();
    if (w.NBDFlags && typeof w.NBDFlags.load === 'function') {
      Promise.resolve(w.NBDFlags.load()).then(syncButton, function () {});
    }
  }
  w.addEventListener('nbd:data-refreshed', syncButton);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1500); });
  else setTimeout(init, 1500);
  setInterval(syncButton, 60000);

  w.NBDStaleLeads = { open: open, close: close, sync: syncButton, available: available, _pure: pure };
})(typeof window !== 'undefined' ? window : this);
