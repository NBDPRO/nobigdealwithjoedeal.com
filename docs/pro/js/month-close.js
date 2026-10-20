/**
 * month-close.js — the "Month close" screen (2026-10-19, flag monthClose).
 *
 * Walks the monthly money checklist with data the CRM already holds:
 * collected revenue (NBDRevenue.paymentsOf, refunds out), direct costs and the
 * job-profit table, the zero-flag counts, a bank-deposits field the OWNER types
 * (never a bank connection), and a tax set-aside on PROFIT at a rate the OWNER
 * types. Every rate and date is labelled "confirm with the CPA"; none is a fact
 * here. Each close is saved as monthCloses/{companyId_YYYY-MM} (totals, checked
 * items, notes, editLog) and can be reopened. The one-page summary is text the
 * owner copies or downloads into his own vault; nothing is sent anywhere, and
 * nothing here messages anyone.
 *
 * Owner / company_admin edit; manager and viewer see it read-only. A source
 * that is off (cash payouts log, job cost auditor) reads "not enabled".
 *
 * Ships DARK behind the `monthClose` feature flag. Absent / false = no panel,
 * no reads, no writes. Reads happen only when the screen is opened.
 *
 * Mounted on the Expenses view: Expenses.html calls panelHtml(); the pure math
 * is month-close-logic.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var w = window, doc = document;
  if (w.NBDMonthClose) return;
  var L = w.NBDMonthCloseLogic;
  var FLAG = 'monthClose';

  var overlay = null;
  var st = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || (w.auth && w.auth.currentUser && w.auth.currentUser.uid) || null; }
  function companyId() { return claims().companyId || uid(); }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function available() { return !!L && flagOn() && L.canView(claims(), uid()); }
  function canEdit() { return !!L && L.canClose(claims(), uid()); }
  function leads() { return w._leads || []; }
  function leadName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Job'; }
  function expensesNow() {
    if (w.Expenses && typeof w.Expenses.list === 'function') return w.Expenses.list();
    return [];
  }
  function dollarsStr(cents) { return cents == null ? '' : (cents / 100).toFixed(2); }

  // ── data ─────────────────────────────────────────────────────────────
  function freshState(monthKey) {
    return {
      monthKey: monthKey, loading: true, error: '', invoices: null, expenses: [], expMeta: { capped: false, oldestMs: 0 }, stale: false, auditorNoSub: null,
      saved: null, overhead: '', deposits: '', rate: '', checks: {}, explain: {}, notes: '',
      dirty: false, saving: false, due: null, remPanel: false
    };
  }

  async function readSaved(monthKey) {
    var db = w.db || w._db;
    if (!db || typeof w.getDoc !== 'function' || typeof w.doc !== 'function' || !companyId()) return null;
    var snap = await w.getDoc(w.doc(db, 'monthCloses', L.closeDocId(companyId(), monthKey)));
    return snap && snap.exists() ? snap.data() : null;
  }

  function applySaved(d) {
    st.saved = d || null;
    var t = (d && d.totals) || {};
    st.overhead = d ? dollarsStr(t.overheadCents) : '';
    st.deposits = d && t.depositsCents != null ? dollarsStr(t.depositsCents) : '';
    st.rate = d && t.rateBp != null ? String(t.rateBp / 100) : '';
    st.checks = Object.assign({}, d && d.checks);
    st.explain = Object.assign({}, d && d.explain);
    st.notes = (d && d.notes) || '';
    st.dirty = false;
  }

  async function loadData(monthKey) {
    st = freshState(monthKey); paint();
    var mine = st;
    try {
      var R = w.NBDRevenue;
      if (!R || typeof R.loadInvoices !== 'function') throw new Error('Money data is not loaded on this page');
      var invs = await R.loadInvoices({ force: true });
      // loadInvoices resolves [] when the read failed. That is NOT "nothing collected".
      if ((R.status && R.status() === 'failed') || (typeof R.cached === 'function' && !R.cached())) throw new Error('Payments could not be read, so collected money is unknown');
      if (st !== mine) return;
      st.invoices = invs || [];
      st.expenses = expensesNow().slice();
      st.expMeta = (w.Expenses && typeof w.Expenses.meta === 'function') ? w.Expenses.meta() : { capped: false, oldestMs: 0 };
      if (!st.expenses.length && w.NBDNumbersData && typeof w.NBDNumbersData.loadExpenses === 'function') { st.expenses = await w.NBDNumbersData.loadExpenses(); st.expMeta = { capped: st.expenses.length >= 1000, oldestMs: 0 }; }
      if (w.NBDJobCostAuditor && typeof w.NBDJobCostAuditor.enabled === 'function' && w.NBDJobCostAuditor.enabled() && typeof w.NBDJobCostAuditor.noSubQueue === 'function') {
        try { var q = await w.NBDJobCostAuditor.noSubQueue(); st.auditorNoSub = q && q.rows ? q.rows.length : null; } catch (e) { st.auditorNoSub = null; }
      }
      try { applySaved(await readSaved(monthKey)); } catch (e) { st.error = 'Could not read the saved close (' + ((e && e.code) || 'error') + '). You can still work the numbers.'; }
    } catch (e) {
      if (st === mine) { st.invoices = null; st.error = (e && e.message) || 'Could not load'; }
    }
    if (st === mine) { st.loading = false; paint(); }
  }

  // ── the numbers (recomputed on every paint) ───────────────────────────
  function compute() {
    var range = L.monthRange(st.monthKey);
    var coll = L.collectedForMonth(st.invoices || [], w.NBDRevenue.paymentsOf, range);
    var costs = L.costsForMonth(st.expenses, range);
    var real = L.jobsWithRealCost(st.expenses);
    var jobs = L.jobTable(leads(), coll, costs, real, leadName);
    var RH = w.NBDReceiptHealth;
    var CP = w.NBDCashPayouts;
    var cashOn = !!(CP && typeof CP.enabled === 'function' && CP.enabled());
    var nj = L.noJobCounts(st.expenses, range, RH && RH.isUnsorted);
    var jobsNoCosts = null, jobsNoCostsAll = null, receiptsAll = null;
    if (RH && typeof RH.isWon === 'function') {
      jobsNoCosts = leads().filter(function (l) { return l && l.id && !l.deleted && RH.isWon(l) && (coll.byLead[l.id] || 0) > 0 && !real[l.id]; }).length;
      jobsNoCostsAll = RH.costsMissing(leads(), st.expenses).length;
      receiptsAll = RH.unsortedList(st.expenses).length;
    }
    var flags = L.flagRows({
      jobsNoCosts: jobsNoCosts, jobsNoCostsAll: jobsNoCostsAll,
      paymentsNoJob: coll.unlinkedCount,
      receiptsNoJob: RH ? nj.receiptsNoJob : null, receiptsNoJobAll: receiptsAll,
      cashNoJob: cashOn ? nj.cashNoJob : null,
      auditorNoSub: st.auditorNoSub
    });
    return { range: range, coll: coll, costs: costs, jobs: jobs, flags: flags };
  }

  // The owner's three entries, parsed. ok=false means a typo, and Save is blocked.
  function inputs() {
    var out = { ok: true, errors: [], overheadCents: 0, depositsCents: null, rateBp: null };
    var ov = String(st.overhead).trim();
    if (ov) { var o = L.parseCents(ov); if (o == null) { out.ok = false; out.errors.push('Overhead must be a dollar amount like 1250.50'); } else out.overheadCents = o; }
    var dp = String(st.deposits).trim();
    if (dp) { var d = L.parseCents(dp); if (d == null) { out.ok = false; out.errors.push('Bank deposits must be a dollar amount like 18400.00'); } else out.depositsCents = d; }
    var rt = String(st.rate).trim();
    if (rt) { var r = L.parseRateBp(rt); if (r == null) { out.ok = false; out.errors.push('Rate must be a percent from 0 to 100, like 25 or 22.5'); } else out.rateBp = r; }
    return out;
  }

  // ── views ────────────────────────────────────────────────────────────
  function resultHtml() {
    if (!st || st.loading || !st.invoices) return '';
    var c = compute(), inp = inputs();
    var aside = L.setAside(c.coll.collectedCents, c.costs.directCents, inp.overheadCents, inp.rateBp);
    var gap = L.depositGap(c.coll.collectedCents, inp.depositsCents);
    var h = '';
    if (inp.errors.length) h += '<p class="mc-err" role="alert">' + esc(inp.errors.join('. ')) + '.</p>';
    h += '<div class="mc-res">';
    h += '<div class="mc-kv"><span>Profit (collected - direct costs - overhead)</span><b class="' + (aside.loss ? 'mc-neg' : '') + '">' + esc(L.fmtMoney(aside.profitCents)) + '</b></div>';
    if (!String(st.overhead).trim()) h += '<p class="mc-hint">Overhead is blank, so it counts as $0. Type the month\'s overhead for an honest profit.</p>';
    h += '<div class="mc-kv"><span>Bank deposits vs collected</span><b>' + (gap.gapCents == null ? 'type the bank total' : esc(L.fmtMoney(gap.gapCents)) + (gap.status === 'match' ? ' (match)' : gap.status === 'bank_higher' ? ' (bank is higher)' : ' (bank is lower)')) + '</b></div>';
    if (gap.status !== 'match' && gap.gapCents != null) h += '<p class="mc-hint">Explain each piece of the gap in the checklist: processor fees, pending deposits, transfers, owner draws, personal money.</p>';
    h += '<div class="mc-kv mc-aside"><span>Tax set-aside on profit</span><b>' + (aside.setAsideCents == null ? 'enter a rate' : esc(L.fmtMoney(aside.setAsideCents))) + '</b></div>';
    if (aside.loss) h += '<p class="mc-hint">Profit is below zero this month, so nothing is set aside.</p>';
    h += '<p class="mc-hint">' + esc(L.CPA_NOTE) + ': the rate is your own entry, not a fact. The set-aside is figured on profit, never on deposits. You move the money; this only computes.</p></div>';
    h += '<p class="mc-state" role="status">' + (st.saved ? 'Saved ' + esc(savedWhen()) + '.' : 'Not saved yet.') + (st.dirty ? ' <b>Unsaved changes.</b>' : '') + '</p>';
    if (st.saved && st.saved.totals) {
      var ch = L.changedSince(st.saved.totals, { collectedCents: c.coll.collectedCents, directCents: c.costs.directCents, refundsCents: c.coll.refundsCents });
      if (ch.length) h += '<p class="mc-hint mc-warn">Collected or cost figures have changed since this close was saved (' + esc(ch.map(function (k) { return k.replace('Cents', ''); }).join(', ')) + '). Save again to record today\'s numbers.</p>';
    }
    return h;
  }
  function savedWhen() {
    var ms = L.toMs(st.saved && st.saved.updatedAt);
    return ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'earlier';
  }

  function flagsHtml(c) {
    return '<ul class="mc-flags">' + c.flags.map(function (f) {
      var tag = f.status === 'off' ? '<span class="mc-chip mc-off">not enabled</span>'
        : f.status === 'ok' ? '<span class="mc-chip mc-ok">0</span>' : '<span class="mc-chip mc-open">' + f.count + '</span>';
      var more = f.allTime != null && f.allTime > 0 && f.status !== 'off' ? ' <span class="mc-sub">(' + f.allTime + ' open in all time)</span>' : '';
      return '<li><span>' + esc(f.label) + more + '</span>' + tag + '</li>';
    }).join('') + '</ul>';
  }

  function jobsHtml(c) {
    if (!c.jobs.length) return '<p class="mc-hint">No job had money collected or a cost dated in this month.</p>';
    var shown = c.jobs.slice(0, 15);
    return '<ul class="mc-jobs">' + shown.map(function (j) {
      return '<li><div class="mc-jn">' + esc(j.name) + '</div><div class="mc-jm"><span>In ' + esc(L.fmtMoney(j.collectedCents)) + '</span><span>Costs ' + esc(L.fmtMoney(j.directCents)) + '</span>' +
        (j.costsNotLogged ? '<span class="mc-chip mc-open">costs not logged</span>' : '<span>' + (j.marginPct == null ? 'no margin' : j.marginPct + '% margin') + '</span>') + '</div></li>';
    }).join('') + '</ul>' + (c.jobs.length > shown.length ? '<p class="mc-hint">+ ' + (c.jobs.length - shown.length) + ' more jobs (the saved summary lists the first 15).</p>' : '');
  }

  function checklistHtml(ro) {
    var dis = ro ? ' disabled' : '';
    return '<ul class="mc-check">' + L.ITEMS.map(function (i) {
      var on = i.auto || st.checks[i.id] === true;
      var has = L.EXPLAIN_IDS.indexOf(i.id) !== -1;
      return '<li><label class="mc-cl"><input type="checkbox" data-mc-check="' + esc(i.id) + '"' + (on ? ' checked' : '') + (i.auto ? ' disabled' : dis) + '><span>' + esc(i.label) + '</span></label>' +
        (has ? '<input type="text" class="mc-in mc-ex" maxlength="' + L.EXPLAIN_MAX + '" placeholder="Explain (optional)" value="' + esc(st.explain[i.id] || '') + '" data-mc-explain="' + esc(i.id) + '" aria-label="Explanation: ' + esc(i.label) + '"' + dis + '>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function remindersHtml() {
    if (!st.due) {
      var y = (L.monthRange(st.monthKey) || { year: new Date().getFullYear() }).year;
      st.due = L.suggestedDueDates(y);
    }
    var h = '<details class="mc-rem"' + (st.remPanel ? ' open' : '') + ' data-mc-rem="1"><summary>Create reminder dates (for you to confirm and copy)</summary>' +
      '<p class="mc-hint">These start from the dates commonly cited for federal estimated tax. Weekends, holidays, Kentucky and Ohio can differ. <b>' + esc(L.CPA_NOTE) + '</b> and fix each date below before you copy it. Nothing is created or sent from here.</p><div class="mc-due">';
    st.due.forEach(function (d, i) {
      h += '<label class="mc-f">Due date ' + (i + 1) + '<input type="date" class="mc-in" value="' + esc(d) + '" data-mc-due="' + i + '"></label>';
    });
    h += '</div><pre class="mc-pre" data-mc-remtext="1">' + esc(L.reminderText(st.due.filter(L.validYmd))) + '</pre>' +
      '<button type="button" class="mc-btn" data-mc-act="copyrem">Copy reminder dates</button></details>';
    return h;
  }

  function bodyHtml() {
    var ro = !canEdit();
    var h = '<div class="mc-head"><h2 class="mc-title" id="mcTitle">Month close</h2><button type="button" class="mc-x" data-mc-act="close" aria-label="Close">×</button></div>' +
      '<div class="mc-top"><label class="mc-f">Month<input type="month" class="mc-in" value="' + esc(st.monthKey) + '" data-mc-month="1" max="' + esc(L.monthKeyOf(Date.now())) + '"></label>' +
      '<p class="mc-basis">Cash basis, collected only; months follow Eastern time. Not tax advice: ' + esc(L.CPA_LC) + '.</p></div>';
    if (ro) h += '<p class="mc-hint">You can look at this close but not change it. Only the owner or a company admin saves a close.</p>';
    if (st.loading) return h + '<p class="mc-empty" role="status">Loading the month…</p>';
    if (!st.invoices) return h + '<p class="mc-empty" role="alert">' + esc(st.error || 'Could not load') + '</p><div class="mc-row"><button type="button" class="mc-btn" data-mc-act="retry">Try again</button></div>';
    if (st.error) h += '<p class="mc-err" role="alert">' + esc(st.error) + '</p>';
    if (L.expensesTruncated(st.expMeta, st.monthKey)) h += '<p class="mc-err" role="alert">Only the newest 1000 expenses are loaded and this month may reach past them, so costs, profit and the set-aside can read too low. You cannot save this month until the costs are complete (export the expenses CSV to check).</p>';
    var c = compute(), t = c.costs, cl = c.coll;
    h += '<section class="mc-sec"><h3>1. Collected</h3>' +
      '<div class="mc-kv"><span>Collected (payments in, refunds out)</span><b>' + esc(L.fmtMoney(cl.collectedCents)) + '</b></div>' +
      '<div class="mc-kv mc-sub"><span>Payments ' + esc(L.fmtMoney(cl.grossCents)) + ' · refunds ' + esc(L.fmtMoney(cl.refundsCents)) + ' · ' + cl.paymentCount + ' entr' + (cl.paymentCount === 1 ? 'y' : 'ies') + '</span></div></section>';
    h += '<section class="mc-sec"><h3>2. Costs</h3>' +
      '<div class="mc-kv"><span>Direct job costs dated in the month</span><b>' + esc(L.fmtMoney(t.directCents)) + '</b></div>' +
      (t.estimatedCents ? '<p class="mc-hint">' + esc(L.fmtMoney(t.estimatedCents)) + ' of that is marked as an estimate.</p>' : '') +
      (t.noJobCount ? '<p class="mc-hint">' + esc(L.fmtMoney(t.noJobCents)) + ' (' + t.noJobCount + ' row' + (t.noJobCount === 1 ? '' : 's') + ') is not tied to a job.</p>' : '') +
      '<div class="mc-kv"><span>Overhead logged in the CRM this month</span><b>' + esc(L.fmtMoney(t.loggedOverheadCents)) + '</b></div>' +
      (ro ? '' : '<button type="button" class="mc-btn mc-small" data-mc-act="useoverhead">Use this as overhead</button>') +
      '<h4>Job profit this month</h4>' + jobsHtml(c) + '</section>';
    h += '<section class="mc-sec"><h3>3. Zero-flag checks</h3>' + flagsHtml(c) +
      '<p class="mc-hint">Receipts and payouts count only this month\'s dates. Check scans, the sub payments sorter and the payment backfill have their own screens; work them there and tick the box below.</p></section>';
    var dis = ro ? ' disabled' : '';
    h += '<section class="mc-sec"><h3>4. Your numbers</h3>' +
      '<label class="mc-f">Overhead for the month (dollars)<input type="text" inputmode="decimal" class="mc-in" value="' + esc(st.overhead) + '" data-mc-num="overhead" placeholder="0.00"' + dis + '></label>' +
      '<label class="mc-f">Bank deposits total for the month (dollars, you read it from the bank)<input type="text" inputmode="decimal" class="mc-in" value="' + esc(st.deposits) + '" data-mc-num="deposits" placeholder="0.00"' + dis + '></label>' +
      '<label class="mc-f">Tax set-aside rate, percent (' + esc(L.CPA_LC) + ')<input type="text" inputmode="decimal" class="mc-in" value="' + esc(st.rate) + '" data-mc-num="rate" placeholder="enter your rate"' + dis + '></label>' +
      '<div data-mc-result="1">' + resultHtml() + '</div></section>';
    h += '<section class="mc-sec"><h3>5. Checklist</h3>' + checklistHtml(ro) +
      '<label class="mc-f">Notes<textarea class="mc-in mc-ta" maxlength="' + L.NOTES_MAX + '" data-mc-notes="1" rows="3"' + dis + '>' + esc(st.notes) + '</textarea></label></section>';
    h += '<div class="mc-row">' + (ro ? '' : '<button type="button" class="mc-btn mc-primary" data-mc-act="save"' + (st.saving ? ' disabled' : '') + '>' + (st.saved ? 'Save changes' : 'Save this close') + '</button>') +
      '<button type="button" class="mc-btn" data-mc-act="copysum">Copy summary</button>' +
      '<button type="button" class="mc-btn" data-mc-act="downloadsum">Download summary (.md)</button></div>' +
      '<p class="mc-hint">The summary is a text file for your own private vault. Nothing is sent anywhere.</p>' + remindersHtml();
    return h;
  }

  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;
    overlay.innerHTML = '<div class="mc-box" role="dialog" aria-modal="true" aria-labelledby="mcTitle">' + bodyHtml() + '</div>';
    overlay.scrollTop = keep;
  }
  function paintResult() {
    var el = overlay && overlay.querySelector('[data-mc-result]');
    if (el) el.innerHTML = resultHtml();
  }

  // ── summary ──────────────────────────────────────────────────────────
  function snapshot() {
    var c = compute(), inp = inputs();
    return { c: c, inp: inp, totals: L.totalsOf(c.coll, c.costs, inp.overheadCents, inp.depositsCents, inp.rateBp) };
  }
  function summaryText() {
    var s = snapshot();
    return L.summaryMarkdown({
      monthKey: st.monthKey, totals: s.totals, checks: st.checks, explain: st.explain, notes: st.notes,
      flags: s.c.flags, jobs: s.c.jobs.slice(0, 15)
    });
  }
  function copyText(text, okMsg) {
    try {
      if (w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
        return w.navigator.clipboard.writeText(text).then(function () { toast(okMsg, 'success'); }, function () { toast('Could not copy. Use Download instead.', 'warn'); });
      }
    } catch (e) { /* fall through */ }
    toast('Copy is not available here. Use Download instead.', 'warn');
  }
  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = w.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = name;
      doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
      setTimeout(function () { w.URL.revokeObjectURL(url); }, 2000);
    } catch (e) { toast('Could not make the file. Use Copy summary instead.', 'warn'); }
  }

  // ── save ─────────────────────────────────────────────────────────────
  async function save() {
    if (!st || st.saving || !canEdit() || !flagOn() || !st.invoices) return;
    if (st.stale) { toast('Reopen this month before saving again (the last save could not be read back).', 'warn'); return; }
    if (L.expensesTruncated(st.expMeta, st.monthKey)) { toast('Costs for this month may be incomplete (only the newest 1000 expenses are loaded). Not saved.', 'warn'); return; }
    var s = snapshot();
    if (!s.inp.ok) { toast(s.inp.errors[0], 'warn'); return; }
    var db = w.db || w._db;
    if (!db || typeof w.setDoc !== 'function' || typeof w.doc !== 'function') { toast('Could not save: the CRM is not ready, reload and try again', 'error'); return; }
    var ts = typeof w.serverTimestamp === 'function' ? w.serverTimestamp() : new Date();
    var built = L.buildCloseDoc({
      companyId: companyId(), uid: uid(), monthKey: st.monthKey, totals: s.totals, checks: st.checks, explain: st.explain,
      notes: st.notes, existing: st.saved, ts: ts, nowMs: Date.now()
    });
    if (built.error) { toast(built.error, 'warn'); return; }
    st.saving = true; paintResult();
    try {
      await w.setDoc(w.doc(db, 'monthCloses', L.closeDocId(companyId(), st.monthKey)), built.doc);
      try { applySaved(await readSaved(st.monthKey)); } catch (e) { st.saved = null; st.dirty = false; st.stale = true; toast('Saved, but could not read it back. Reopen the month before saving again.', 'warn'); }
      if (!st.stale) toast('Month close saved', 'success');
    } catch (e) {
      toast('Could not save: ' + ((e && e.code) || (e && e.message) || 'unknown error'), 'error');
    }
    st.saving = false; paint();
  }

  // ── open / close ─────────────────────────────────────────────────────
  function open() {
    if (!available()) return false;
    if (overlay) { paint(); return true; }
    overlay = doc.createElement('div');
    overlay.className = 'mc-overlay';
    overlay.setAttribute('data-mc-overlay', '1');
    doc.body.appendChild(overlay);
    loadData(L.previousMonthKey(Date.now()));
    return true;
  }
  function close() {
    if (st && st.saving) return;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; st = null;
  }

  function panelHtml(expenses) {
    if (!available()) return '';
    return '<div class="ui-card mc-panel" id="mcPanel"><div class="mc-phead"><div><h3 class="mc-ptitle">Month close</h3>' +
      '<div class="mc-psub">Collected, costs, bank gap and tax set-aside on profit, one month at a time.</div></div>' +
      '<button type="button" class="btn btn-orange" data-mc-act="open">Open month close</button></div></div>';
  }

  // ── events ───────────────────────────────────────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-mc-act]');
    if (!t) return;
    var act = t.getAttribute('data-mc-act');
    if (act === 'open') { ev.preventDefault(); open(); return; }
    if (!overlay || !st) return;
    if (act === 'close') close();
    else if (act === 'retry') loadData(st.monthKey);
    else if (act === 'save') save().catch(function (e) { st.saving = false; toast('Could not save: ' + (e && e.message || 'unknown error'), 'error'); paint(); });
    else if (act === 'useoverhead' && canEdit() && st.invoices) { st.overhead = dollarsStr(compute().costs.loggedOverheadCents); st.dirty = true; paint(); }
    else if (act === 'copysum') copyText(summaryText(), 'Summary copied');
    else if (act === 'downloadsum') download('month-close-' + st.monthKey + '.md', summaryText());
    else if (act === 'copyrem') copyText(L.reminderText((st.due || []).filter(L.validYmd)), 'Reminder dates copied');
  });
  doc.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!overlay || !st || !el || !el.getAttribute) return;
    var num = el.getAttribute('data-mc-num'), ex = el.getAttribute('data-mc-explain');
    if (num && canEdit()) { st[num] = String(el.value || '').slice(0, 20); st.dirty = true; paintResult(); }
    else if (ex && canEdit()) { st.explain[ex] = String(el.value || '').slice(0, L.EXPLAIN_MAX); st.dirty = true; paintResult(); }
    else if (el.getAttribute('data-mc-notes') && canEdit()) { st.notes = String(el.value || '').slice(0, L.NOTES_MAX); st.dirty = true; paintResult(); }
  });
  doc.addEventListener('change', function (ev) {
    var el = ev.target;
    if (!overlay || !st || !el || !el.getAttribute) return;
    var chk = el.getAttribute('data-mc-check'), due = el.getAttribute('data-mc-due');
    if (el.getAttribute('data-mc-month')) {
      if (L.isMonthKey(el.value) && el.value !== st.monthKey) loadData(el.value);
    } else if (chk && canEdit() && L.ITEM_IDS.indexOf(chk) !== -1) {
      if (el.checked) st.checks[chk] = true; else delete st.checks[chk];
      st.dirty = true; paintResult();
    } else if (due != null && st.due) {
      st.due[Number(due)] = el.value; st.remPanel = true; paint();
    }
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  w.NBDMonthClose = { open: open, close: close, available: available, panelHtml: panelHtml, FLAG: FLAG };
})();
