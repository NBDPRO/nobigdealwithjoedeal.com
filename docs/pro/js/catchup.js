/**
 * catchup.js — "Catch up my numbers" (#/catchup, 2026-10-04). Owner only.
 *
 * One screen Jo can work through on his iPhone in about 30 minutes so the
 * numbers screens (#2150) become real. Three decks, one card at a time:
 *
 *   1. Won jobs — each card says what the job is missing (payments, close
 *      date, package, job costs) with one-tap fixes that reuse the existing
 *      writers: the Record Payment sheet (invoice-pipeline.js, #2135) with
 *      NO receipt option, a "Paid in full?" shortcut that records ONE payment
 *      for the job total already on file on the date Jo enters, the close
 *      date (same write as customer-numbers.js), the package picker and
 *      "+ Add cost" (expenses.js). Skip / Done. "12 of 38 jobs done".
 *   2. Lost leads with no reason — quick-pick reasons, "Other" and the bulk
 *      "same reason for all" go through the lost-reason picker (#2150).
 *   3. Thumbtack spend — every month since the first Thumbtack lead: type
 *      the month's spend, or import the billing CSV (numbers-logic.js
 *      parseSpendCsv + NBDNumbersData.mergeSpendMonths, #2150's import).
 *
 * Rules (Jo): revenue is collected money by payment date — a payment gets
 * the date Jo enters, never "today" by default; money in cents; nothing is
 * written without Jo's tap; nothing here emails anyone (Record payment runs
 * with noReceipt, the shortcut passes sendReceipt:false); every write is
 * logged with what it replaced and Undo reverses the last one. Progress
 * (Done marks) and the log live at companies/{co}/owner_numbers/catchup —
 * owner-only (firestore.rules), so a reload keeps the place.
 *
 * Pure rules: catchup-logic.js. CSP-safe: delegated listeners, classes only
 * (css/catchup.css + numbers.css's .nb-sheet).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDCatchUp) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = () => window.NBDNumbers;
  const L = () => window.NBDCatchUpLogic;
  const D = () => window.NBDNumbersData;
  const IP = () => window.InvoicePipeline;
  const SCROLL_SEL = '#view-catchup .view-scroll';

  let _tab = 'jobs';
  let _data = null;                 // { invs, expenses, spend }
  let _progress = { doneJobs: {}, log: [] };
  let _skipJobs = [], _skipLost = [];
  let _csv = null;
  let _busy = false;
  let _loading = false;
  let _pendingCost = null;          // { leadId, before: [expense ids] }
  let _curJob = null;               // the card on screen stays put while Jo fixes it

  function host() { return typeof document !== 'undefined' ? document.querySelector(SCROLL_SEL) : null; }
  function db() { return window.db || window._db || null; }
  function uid() { return (window._user && window._user.uid) || (window._auth && window._auth.currentUser && window._auth.currentUser.uid) || null; }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); }
  function leadById(id) { return (window._leads || []).find((l) => l && l.id === id) || null; }
  function leadName(l) { return l ? (((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Unnamed') : 'Unnamed'; }
  function money(c) { return N().fmtMoney(c); }
  function exact(c) { return '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function ts() { return typeof window.serverTimestamp === 'function' ? window.serverTimestamp() : new Date(); }
  function canWrite() { return !(window.NBDRole && !window.NBDRole.guard()); }
  function isOwner() { return !!(D() && D().isOwner()); }

  // ── Progress + the action log (owner_numbers/catchup) ─────────────────
  function progressRef() { return window.doc(db(), 'companies', D().companyId(), 'owner_numbers', 'catchup'); }
  async function loadProgress() {
    try {
      const s = await window.getDoc(progressRef());
      const d = s && s.exists() ? (s.data() || {}) : {};
      _progress = {
        doneJobs: (d.doneJobs && typeof d.doneJobs === 'object') ? d.doneJobs : {},
        log: Array.isArray(d.log) ? d.log : [],
      };
    } catch (e) {
      console.warn('[catchup] progress read failed', e && (e.code || e.message));
      _progress = { doneJobs: {}, log: [] };
    }
  }
  // Whole-doc write (no merge): un-marking a job must remove its key.
  async function saveProgress() {
    try {
      await window.setDoc(progressRef(), { doneJobs: _progress.doneJobs, log: _progress.log, updatedAt: ts(), updatedBy: uid() });
      return true;
    } catch (e) {
      console.warn('[catchup] progress save failed', e && (e.code || e.message));
      toast('Saved — but the undo log could not be saved', 'error');
      return false;
    }
  }
  async function logAction(entry) {
    _progress.log = L().pushLog(_progress.log, Object.assign({ at: Date.now(), by: uid() }, entry));
    return saveProgress();
  }

  // ── Loads ──────────────────────────────────────────────────────────────
  async function load() {
    const R = window.NBDRevenue;
    const res = await Promise.all([
      R ? R.loadInvoices({ force: true }).catch(() => []) : Promise.resolve([]),
      D().loadExpenses(),
      D().loadSpend({ force: true }),
      loadProgress(),
    ]);
    _data = { invs: res[0] || [], expenses: res[1] || [], spend: res[2] || { months: {} } };
  }
  function collectedByLead() {
    const R = window.NBDRevenue;
    return (R && _data) ? R.collectedByLead(_data.invs, null, null) : {};
  }
  function jobs() {
    return L().jobDeck(window._leads || [], { collectedByLead: collectedByLead(), expenses: (_data && _data.expenses) || [], progress: _progress, skipped: _skipJobs });
  }
  function losses() { return L().lostDeck(window._leads || [], { skipped: _skipLost }); }
  function spendRows() { return L().thumbtackMonths(window._leads || [], (_data && _data.spend) || { months: {} }, Date.now()); }

  // ── Writes (each one logged) ───────────────────────────────────────────
  async function writeLead(id, patch, label) {
    if (!canWrite()) return false;
    const keys = Object.keys(patch);
    const before = L().pick(leadById(id) || {}, keys);
    try {
      await window.updateDoc(window.doc(db(), 'leads', id), Object.assign({}, patch, { updatedAt: ts() }));
    } catch (e) {
      toast('Could not save: ' + ((e && (e.code || e.message)) || 'error'), 'error');
      return false;
    }
    const l = leadById(id); if (l) Object.assign(l, patch);
    await logAction({ kind: 'lead', label, leadId: id, undo: L().leadUndoPatch(before, keys) });
    return true;
  }
  async function writeLeads(ids, patch, label) {
    if (!canWrite()) return 0;
    const keys = Object.keys(patch);
    const items = [];
    for (const id of ids) {
      const before = L().pick(leadById(id) || {}, keys);
      try {
        await window.updateDoc(window.doc(db(), 'leads', id), Object.assign({}, patch, { updatedAt: ts() }));
        const l = leadById(id); if (l) Object.assign(l, patch);
        items.push({ leadId: id, undo: L().leadUndoPatch(before, keys) });
      } catch (e) { console.warn('[catchup] lead write failed', id, e && (e.code || e.message)); }
    }
    if (items.length) await logAction({ kind: 'leads', label: label + ' (' + items.length + ')', items });
    return items.length;
  }

  /**
   * "Paid in full? Yes": ONE payment for the job total already on file
   * (catchup-logic paidInFullPlan), on the date Jo entered, through the same
   * Record Payment write (#2135 recordPaymentCommit) — sendReceipt:false.
   * choice = { method, payer, ymd, expectCents }. → { invoiceId, cents, owedCents }
   */
  async function paidInFull(leadId, choice) {
    const c = choice || {};
    const ip = IP();
    if (!ip || typeof ip.recordPaymentContext !== 'function') throw new Error('Payments did not load — reload and try again');
    const at = L().dateFromYmd(c.ymd, Date.now());
    if (!at) throw new Error('Pick the date the money came in (not a future date)');
    if (!ip.isManualPaymentMethod(c.method)) throw new Error('Pick how it was paid');
    const ctx = await ip.recordPaymentContext(leadId);
    const plan = L().paidInFullPlan(ctx.target, { collectedCents: L().collectedCentsOf(ctx.invoices) });
    if (!plan.ok && plan.reason === 'already_collected') throw new Error('Money is already recorded for this customer (a Stripe payment, or one entered elsewhere) — use Record payment for the rest');
    if (!plan.ok) throw new Error('No single job total on file — use Record payment');
    if (c.expectCents != null && plan.cents !== c.expectCents) throw new Error('The job total changed since this opened — open it again');
    const invoiceId = await ip.recordPaymentCommit({
      leadId, lead: ctx.lead, target: ctx.target,
      totalCents: plan.cents,
      amount: (plan.cents / 100).toFixed(2),
      method: c.method, payer: c.payer || 'homeowner', at,
      invoiceId: plan.invoiceId, reference: '',
      sendReceipt: false,
      // A balancing entry: a Stripe payment for this job found later
      // replaces part of it instead of adding to it (R6-2-8).
      basis: ip.PAYMENT_BASIS_CATCHUP || 'catchup_paid_in_full',
    });
    const after = await ip.loadLeadInvoices(leadId);
    await logPayment(leadId, ctx.invoices, after, invoiceId, 'Paid in full ' + exact(plan.cents) + ' — ' + leadName(ctx.lead));
    const inv = after.find((i) => i && i.id === invoiceId) || {};
    return { invoiceId, cents: plan.cents, owedCents: Math.round((Number(inv.balanceDue) || 0) * 100) };
  }
  async function logPayment(leadId, before, after, invoiceId, label) {
    const u = L().paymentUndoFrom(before, after, invoiceId);
    if (!u) return;
    const inv = (after || []).find((i) => i && i.id === invoiceId) || {};
    const pays = Array.isArray(inv.payments) ? inv.payments : [];
    const last = pays[pays.length - 1];
    const noteId = (last && typeof IP().paymentTimelineNoteId === 'function') ? IP().paymentTimelineNoteId(invoiceId, last) : '';
    await logAction({ kind: 'payment', label, leadId, invoiceId, created: u.created, restore: u.restore, noteId: noteId || null });
  }

  /** "No — record what came in": #2135's Record Payment sheet, no receipt option. */
  async function recordPaymentSheet(leadId) {
    const ip = IP();
    if (!ip || typeof ip.recordPaymentUI !== 'function') { toast('Payments did not load — reload and try again', 'error'); return false; }
    let before = [];
    try { before = await ip.loadLeadInvoices(leadId); } catch (_) { toast('Could not read the invoices — try again', 'error'); return false; }
    const ok = await ip.recordPaymentUI(leadId, { noReceipt: true });
    if (ok !== true) return false;
    const after = await ip.loadLeadInvoices(leadId).catch(() => []);
    const id = L().changedInvoiceId(before, after);
    if (id) await logPayment(leadId, before, after, id, 'Payment recorded — ' + leadName(leadById(leadId)));
    return true;
  }

  async function saveSpend(month, key, cents) {
    const months = ((_data && _data.spend && _data.spend.months) || {});
    const prev = Number((months[month] || {})[key]) || 0;
    const ok = await D().saveSpendMonth(month, key, cents);
    if (!ok) { toast('Could not save the spend', 'error'); return false; }
    months[month] = months[month] || {}; months[month][key] = cents;
    const before = {}; before[month] = prev;
    await logAction({ kind: 'spend', label: 'Thumbtack ' + month + ' ' + exact(cents), key, before });
    return true;
  }
  async function saveCsv() {
    if (!_csv) return false;
    const months = ((_data && _data.spend && _data.spend.months) || {});
    const before = {};
    Object.keys(_csv.byMonth).forEach((m) => { before[m] = Number((months[m] || {})[_csv.key]) || 0; });
    const ok = await D().mergeSpendMonths(_csv.byMonth, _csv.key);
    if (!ok) { toast('Could not save the spend', 'error'); return false; }
    Object.keys(_csv.byMonth).forEach((m) => { months[m] = months[m] || {}; months[m][_csv.key] = Math.max(0, _csv.byMonth[m]); });
    await logAction({ kind: 'spend', label: 'CSV import (' + Object.keys(before).length + ' months)', key: _csv.key, before });
    _csv = null;
    return true;
  }

  async function markDone(id) {
    _progress.doneJobs = Object.assign({}, _progress.doneJobs);
    _progress.doneJobs[id] = true;
    _skipJobs = _skipJobs.filter((x) => x !== id);
    _curJob = null;
    await logAction({ kind: 'done', label: 'Done — ' + leadName(leadById(id)), leadId: id });
  }

  /** Undo the last logged action. */
  async function undoLast() {
    const e = L().lastEntry(_progress.log);
    if (!e) { toast('Nothing to undo', 'info'); return false; }
    if (!canWrite()) return false;
    try {
      if (e.kind === 'lead') {
        await window.updateDoc(window.doc(db(), 'leads', e.leadId), Object.assign({}, e.undo, { updatedAt: ts() }));
        const l = leadById(e.leadId); if (l) Object.assign(l, e.undo);
      } else if (e.kind === 'leads') {
        for (const it of (e.items || [])) {
          await window.updateDoc(window.doc(db(), 'leads', it.leadId), Object.assign({}, it.undo, { updatedAt: ts() }));
          const l = leadById(it.leadId); if (l) Object.assign(l, it.undo);
        }
      } else if (e.kind === 'payment') {
        // Stripe money booked on this invoice since (R6-2-8) → undo would
        // erase a real payment. Refuse, visibly.
        const cur = await window.getDoc(window.doc(db(), 'invoices', e.invoiceId));
        const why = L().paymentUndoBlocked(cur.exists() ? cur.data() : null, e);
        if (why) throw new Error(why);
        if (e.created) await window.deleteDoc(window.doc(db(), 'invoices', e.invoiceId));
        else await window.updateDoc(window.doc(db(), 'invoices', e.invoiceId), Object.assign({}, e.restore, { updatedAt: new Date() }));
        if (e.noteId && typeof window.deleteDoc === 'function') {
          try { await window.deleteDoc(window.doc(db(), 'notes', e.noteId)); } catch (_) { /* the timeline line is best-effort */ }
        }
      } else if (e.kind === 'spend') {
        const ok = await D().mergeSpendMonths(e.before, e.key);
        if (!ok) throw new Error('spend');
        const months = (_data && _data.spend && _data.spend.months) || {};
        Object.keys(e.before || {}).forEach((m) => { months[m] = months[m] || {}; months[m][e.key] = Number(e.before[m]) || 0; });
      } else if (e.kind === 'done') {
        _progress.doneJobs = Object.assign({}, _progress.doneJobs);
        delete _progress.doneJobs[e.leadId];
      } else if (e.kind === 'cost') {
        const ex = window.Expenses;
        if (!ex || typeof ex.removeExpense !== 'function') throw new Error('Expenses did not load');
        for (const id of (e.expenseIds || [])) await ex.removeExpense(id);
      }
    } catch (err) {
      toast('Could not undo: ' + ((err && (err.code || err.message)) || 'error'), 'error');
      return false;
    }
    _progress.log = L().popLog(_progress.log);
    await saveProgress();
    if (e.kind === 'payment' || e.kind === 'cost') { try { await load(); } catch (_) { /* render what we have */ } }
    toast('Undone: ' + e.label + (e.kind === 'payment' ? ' (a stage move it caused stays)' : ''), 'success');
    return true;
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function tabBtn(key, label, sub) {
    const on = _tab === key;
    return '<button type="button" class="cu-tab' + (on ? ' cu-on' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" data-cu="tab" data-tab="' + key + '">' +
      '<span class="cu-tab-l">' + esc(label) + '</span><span class="cu-tab-s">' + esc(sub) + '</span></button>';
  }
  function progressBar(done, total, text) {
    return '<div class="cu-progress"><progress class="cu-bar" max="' + Math.max(1, total) + '" value="' + done + '"></progress>' +
      '<div class="cu-progress-t" data-cu-progress>' + esc(text) + '</div></div>';
  }

  function jobCard(item, pos, left) {
    const Nn = N(), Ln = L();
    const l = item.lead, m = item.missing;
    const chips = Ln.MISSING_KEYS.map((k) => '<li class="cu-chip ' + (m[k] ? 'cu-miss' : 'cu-ok') + '">' + (m[k] ? '• ' : '✓ ') + esc(Ln.MISSING_LABELS[k]) + '</li>').join('');
    let secs = '';
    if (m.payment) {
      secs += '<section class="cu-sec"><div class="cu-sec-t">Payments — none recorded</div>' +
        '<div class="cu-q">Paid in full?</div><div class="cu-row">' +
        '<button type="button" class="cu-btn cu-btn-primary" data-cu="pif-yes" data-id="' + esc(l.id) + '">Yes</button>' +
        '<button type="button" class="cu-btn" data-cu="pif-no" data-id="' + esc(l.id) + '">No — record what came in</button></div></section>';
    }
    if (m.closeDate) {
      const cur = Nn.toMs(l.closedAt);
      const sug = Ln.suggestCloseYmd(l);
      secs += '<section class="cu-sec"><div class="cu-sec-t">Close date' + (cur ? ' — matches the created date' : ' — not set') + '</div>' +
        '<div class="cu-row"><input type="date" class="cu-date" data-cu="close-date" aria-label="Close date for ' + esc(leadName(l)) + '" value="' + esc(sug) + '" max="' + Nn.ymd(Date.now()) + '">' +
        '<button type="button" class="cu-btn" data-cu="save-close" data-id="' + esc(l.id) + '">Save</button></div>' +
        '<div class="cu-dim cu-small">The day the contract was signed.' + (sug ? ' Filled from the stage history — check it.' : '') + '</div></section>';
    }
    if (m.package) {
      secs += '<section class="cu-sec"><div class="cu-sec-t">Package sold</div><div class="cu-tiers" role="group" aria-label="Package sold">' +
        Nn.TIERS.map((t) => '<button type="button" class="cu-btn cu-tier" data-cu="tier" data-tier="' + t + '" data-id="' + esc(l.id) + '">' + esc(Nn.TIER_LABELS[t]) + '</button>').join('') +
        '</div></section>';
    }
    if (m.costs) {
      secs += '<section class="cu-sec"><div class="cu-sec-t">Job costs — none recorded</div><div class="cu-row">' +
        '<button type="button" class="cu-btn" data-cu="add-cost" data-id="' + esc(l.id) + '">+ Add cost</button></div>' +
        '<div class="cu-dim cu-small">Sub invoice, materials, dump fees — one at a time.</div></section>';
    }
    if (!secs) secs = '<div class="cu-allset">Nothing missing on this job ✓</div>';
    return '<article class="cu-card" data-cu-card="job" data-id="' + esc(l.id) + '">' +
      '<div class="cu-card-h"><a class="cu-name" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '">' + esc(leadName(l)) + '</a>' +
        '<span class="cu-booked">' + (item.bookedCents ? money(item.bookedCents) + ' booked <span class="cu-proj">projected</span>' : 'no job value') + '</span></div>' +
      (l.address ? '<div class="cu-dim cu-addr">' + esc(l.address) + '</div>' : '') +
      '<ul class="cu-chips" aria-label="What this job is missing">' + chips + '</ul>' +
      secs +
      '<div class="cu-foot"><button type="button" class="cu-btn cu-btn-ghost" data-cu="skip-job" data-id="' + esc(l.id) + '">Skip</button>' +
        '<button type="button" class="cu-btn cu-btn-done" data-cu="done-job" data-id="' + esc(l.id) + '">Done ✓</button></div>' +
      '<div class="cu-dim cu-small cu-pos">' + pos + ' of ' + left + ' left · swipe left to skip</div>' +
    '</article>';
  }

  function renderJobs() {
    const d = jobs();
    let html = progressBar(d.done, d.total, d.text);
    if (!d.total) return html + '<div class="cu-empty">No won jobs yet.</div>';
    if (!d.queue.length) return html + '<div class="cu-empty">Every won job is caught up ✓</div>';
    // Fixing one gap must not swap the card for one with more gaps: the job
    // on screen stays first until Done / Skip (or it has nothing missing).
    let q = d.queue;
    if (_curJob && q.indexOf(_curJob) > 0) q = [_curJob].concat(q.filter((x) => x !== _curJob));
    _curJob = q[0];
    const item = d.items.find((i) => i.id === q[0]);
    return html + jobCard(item, 1, q.length);
  }

  function renderLost() {
    const Nn = N();
    const d = losses();
    let html = progressBar(d.withReason, d.total, d.text);
    if (!d.total) return html + '<div class="cu-empty">No lost leads.</div>';
    if (!d.queue.length) return html + '<div class="cu-empty">Every loss has a reason ✓</div>';
    const l = leadById(d.queue[0]);
    const when = Nn.toMs(l.closedAt) || Nn.toMs(l.stageStartedAt);
    return html +
      '<article class="cu-card" data-cu-card="lost" data-id="' + esc(l.id) + '">' +
        '<div class="cu-card-h"><a class="cu-name" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '">' + esc(leadName(l)) + '</a>' +
          '<span class="cu-dim">' + esc(Nn.normalizeSource(l.source)) + (when ? ' · lost ' + esc(Nn.ymd(when)) : '') + '</span></div>' +
        (l.address ? '<div class="cu-dim cu-addr">' + esc(l.address) + '</div>' : '') +
        '<div class="cu-q">Why was it lost?</div>' +
        '<div class="cu-reasons" role="group" aria-label="Why it was lost">' +
          Nn.LOST_REASONS.map((r) => '<button type="button" class="cu-btn cu-reason" data-cu="lost-reason" data-key="' + r.key + '" data-id="' + esc(l.id) + '">' + esc(r.label) + (r.key === 'other' ? '…' : '') + '</button>').join('') +
        '</div>' +
        '<div class="cu-foot"><button type="button" class="cu-btn cu-btn-ghost" data-cu="skip-lost" data-id="' + esc(l.id) + '">Skip</button>' +
          (d.queue.length > 1 ? '<button type="button" class="cu-btn" data-cu="lost-bulk">Same reason for all ' + d.queue.length + '…</button>' : '') + '</div>' +
        '<div class="cu-dim cu-small cu-pos">1 of ' + d.queue.length + ' left · one tap saves and moves on</div>' +
      '</article>';
  }

  function renderSpend() {
    const s = spendRows();
    let html = progressBar(s.covered, s.total, s.covered + ' of ' + s.total + ' month' + (s.total === 1 ? '' : 's') + ' with Thumbtack spend');
    if (!s.total) return html + '<div class="cu-empty">No Thumbtack leads yet.</div>';
    html += '<div class="cu-card"><div class="cu-sec-t">Thumbtack — what you paid each month</div>' +
      '<div class="cu-dim cu-small">From Thumbtack › Billing. A lead with no price of its own costs the month’s spend ÷ that month’s Thumbtack leads. Owner-only.</div>' +
      '<ul class="cu-months">' + s.rows.map((r) =>
        '<li class="cu-month' + (r.covered ? ' cu-month-ok' : '') + '"><div class="cu-month-l"><strong>' + esc(r.month) + '</strong>' +
          '<span class="cu-dim">' + r.leads + ' lead' + (r.leads === 1 ? '' : 's') + (r.priced ? ' · ' + r.priced + ' priced' : '') + '</span></div>' +
          '<div class="cu-row cu-month-r"><input type="number" inputmode="decimal" min="0" step="0.01" class="cu-money" data-cu="spend" data-month="' + r.month + '"' +
            ' aria-label="Thumbtack spend ' + r.month + '" placeholder="$0" value="' + (r.spendCents != null && r.spendCents > 0 ? (r.spendCents / 100).toFixed(2) : '') + '">' +
          '<button type="button" class="cu-btn" data-cu="save-spend" data-month="' + r.month + '" data-key="' + esc(s.key) + '">Save</button></div></li>').join('') +
      '</ul></div>';
    html += '<div class="cu-card"><div class="cu-sec-t">Or import the billing CSV</div>' +
      '<label class="cu-dim cu-small" for="cuCsvFile">Thumbtack › Billing › Download — any CSV with a date and an amount column.</label>' +
      '<input type="file" id="cuCsvFile" accept=".csv,text/csv" class="cu-file" data-key="' + esc(s.key) + '">' +
      (_csv ? '<div class="cu-csv"><strong>' + _csv.rows.length + ' charges</strong>' + (_csv.skipped ? ', ' + _csv.skipped + ' rows skipped' : '') +
        '<ul class="cu-list">' + Object.keys(_csv.byMonth).sort().reverse().map((m) => '<li>' + esc(m) + ': ' + esc(exact(_csv.byMonth[m])) + '</li>').join('') + '</ul>' +
        '<div class="cu-row"><button type="button" class="cu-btn cu-btn-ghost" data-cu="csv-cancel">Cancel</button>' +
        '<button type="button" class="cu-btn cu-btn-primary" data-cu="csv-save">Save these months</button></div></div>' : '') +
      '</div>';
    return html;
  }

  function render() {
    const h = host();
    if (!h) return;
    if (!N() || !L() || !D()) { h.innerHTML = '<div class="cu-page"><div class="cu-empty">Loading…</div></div>'; return; }
    if (!isOwner()) {
      h.innerHTML = '<div class="cu-page"><div class="cu-empty">Catching up the numbers is for the account owner — it shows spend and payments.</div></div>';
      return;
    }
    if (!_data) { h.innerHTML = '<div class="cu-page"><div class="cu-empty">Loading your jobs…</div></div>'; return; }
    const j = jobs(), lo = losses(), sp = spendRows();
    const last = L().lastEntry(_progress.log);
    const body = _tab === 'lost' ? renderLost() : _tab === 'spend' ? renderSpend() : renderJobs();
    h.innerHTML = '<div class="cu-page">' +
      '<div class="cu-top"><div class="cu-title">Catch up my numbers</div>' +
        '<div class="cu-sub">One card at a time. Nothing is saved until you tap, and nothing emails a customer.</div></div>' +
      '<div class="cu-tabs" role="tablist" aria-label="Decks">' +
        tabBtn('jobs', 'Won jobs', j.done + '/' + j.total) +
        tabBtn('lost', 'Lost reasons', lo.withReason + '/' + lo.total) +
        tabBtn('spend', 'Thumbtack', sp.covered + '/' + sp.total) +
      '</div>' +
      (last ? '<div class="cu-undo"><span class="cu-undo-t">Last: ' + esc(last.label) + '</span><button type="button" class="cu-btn cu-btn-ghost" data-cu="undo">↶ Undo</button></div>' : '') +
      body +
    '</div>';
  }

  // ── The Paid-in-full sheet ─────────────────────────────────────────────
  function closeSheet() { const o = document.getElementById('cu-pif'); if (o) o.remove(); }
  async function openPaidInFull(leadId) {
    const ip = IP();
    if (!ip || typeof ip.recordPaymentContext !== 'function') { toast('Payments did not load — reload and try again', 'error'); return; }
    let ctx;
    try { ctx = await ip.recordPaymentContext(leadId); } catch (_) { toast('Could not read the invoices — try again', 'error'); return; }
    const plan = L().paidInFullPlan(ctx.target, { collectedCents: L().collectedCentsOf(ctx.invoices) });
    if (!plan.ok) {
      toast(plan.reason === 'no_total' ? 'No job total on file — record what came in instead'
        : plan.reason === 'already_collected' ? 'Money is already recorded for this customer — record the rest instead'
        : 'This job has more than one bill — record what came in instead', 'info');
      recordPaymentSheet(leadId).then((ok) => { if (ok) afterWrite(); });
      return;
    }
    closeSheet();
    const methods = ip.PAYMENT_METHODS || [];
    const payers = ip.PAYERS || [];
    const today = N().ymd(Date.now());
    const def = L().defaultPaymentYmd(ctx.lead, Date.now());
    const bg = document.createElement('div');
    bg.id = 'cu-pif';
    bg.className = 'nb-sheet-bg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.setAttribute('aria-labelledby', 'cuPifTitle');
    bg.dataset.id = leadId;
    bg.dataset.cents = String(plan.cents);
    bg.innerHTML = '<div class="nb-sheet">' +
      '<div class="nb-sheet-title" id="cuPifTitle">Paid in full</div>' +
      '<div class="nb-sheet-sub">' + esc(leadName(ctx.lead)) + '</div>' +
      '<div class="cu-pif-amt" data-cu-amount>' + esc(exact(plan.cents)) + '</div>' +
      '<div class="cu-dim cu-small">The job total from ' + esc(L().PLAN_BASIS_LABELS[plan.basis] || 'the job') + '. Records ONE payment for it. No receipt is emailed.</div>' +
      '<div class="nb-note-label cu-mt">How was it paid?</div>' +
      '<div class="cu-picks" role="group" aria-label="Payment method">' + methods.map((m, i) =>
        '<button type="button" class="cu-btn cu-pick' + (i === 0 ? ' cu-on' : '') + '" data-cu-method="' + esc(m.key) + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' + esc(m.label) + '</button>').join('') + '</div>' +
      '<div class="nb-note-label cu-mt">Paid by</div>' +
      '<div class="cu-picks" role="group" aria-label="Who paid">' + payers.map((p, i) =>
        '<button type="button" class="cu-btn cu-pick' + (i === 0 ? ' cu-on' : '') + '" data-cu-payer="' + esc(p.key) + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' + esc(p.label) + '</button>').join('') + '</div>' +
      '<label class="nb-note-label cu-mt" for="cuPifDate">Date the money came in</label>' +
      '<input type="date" id="cuPifDate" class="cu-date cu-date-wide" value="' + esc(def) + '" max="' + esc(today) + '">' +
      '<div class="cu-dim cu-small">' + (def ? 'Filled from the job’s stage history — change it if the check came another day.' : 'Pick the day it came in — revenue counts on that date.') + '</div>' +
      '<div class="nb-sheet-err" role="alert" id="cuPifErr"></div>' +
      '<div class="nb-sheet-foot"><button type="button" class="nb-btn nb-btn-ghost" data-cu-pif="cancel">Cancel</button>' +
        '<button type="button" class="nb-btn nb-btn-primary" data-cu-pif="save">Record ' + esc(exact(plan.cents)) + '</button></div>' +
    '</div>';
    document.body.appendChild(bg);
  }
  async function onSheetClick(e) {
    const bg = document.getElementById('cu-pif');
    if (!bg || !bg.contains(e.target)) return;
    if (e.target === bg) { closeSheet(); return; }
    const pick = e.target.closest('[data-cu-method],[data-cu-payer]');
    if (pick) {
      const attr = pick.hasAttribute('data-cu-method') ? 'data-cu-method' : 'data-cu-payer';
      bg.querySelectorAll('[' + attr + ']').forEach((b) => { const on = b === pick; b.classList.toggle('cu-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      return;
    }
    const act = e.target.closest('[data-cu-pif]');
    if (!act) return;
    if (act.dataset.cuPif === 'cancel') { closeSheet(); return; }
    if (_busy) return;
    const m = bg.querySelector('[data-cu-method].cu-on');
    const p = bg.querySelector('[data-cu-payer].cu-on');
    const err = bg.querySelector('#cuPifErr');
    const ymd = (bg.querySelector('#cuPifDate') || {}).value || '';
    if (!L().dateFromYmd(ymd, Date.now())) { err.textContent = 'Pick the date the money came in (not a future date).'; return; }
    _busy = true; act.disabled = true; act.textContent = 'Saving…';
    try {
      const r = await paidInFull(bg.dataset.id, { method: m && m.dataset.cuMethod, payer: p && p.dataset.cuPayer, ymd, expectCents: Number(bg.dataset.cents) });
      closeSheet();
      toast('Payment recorded — ' + exact(r.cents) + (r.owedCents > 0 ? ' (the invoice still shows ' + exact(r.owedCents) + ' owed)' : ''), 'success');
      await afterWrite();
    } catch (x) {
      err.textContent = (x && x.message) || 'Could not record the payment';
      act.disabled = false; act.textContent = 'Record ' + exact(Number(bg.dataset.cents));
    } finally { _busy = false; }
  }

  async function afterWrite() {
    try { await load(); } catch (_) { /* keep what we have */ }
    render();
  }

  // ── Actions ────────────────────────────────────────────────────────────
  async function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-cu]') : null;
    if (!b || !b.closest(SCROLL_SEL)) return;
    const a = b.dataset.cu;
    const id = b.dataset.id;
    if (a === 'tab') { _tab = b.dataset.tab; render(); return; }
    if (_busy) return;
    _busy = true;
    try {
      if (a === 'undo') { await undoLast(); render(); return; }
      if (a === 'skip-job') { _curJob = null; _skipJobs = _skipJobs.filter((x) => x !== id).concat([id]); render(); return; }
      if (a === 'skip-lost') { _skipLost = _skipLost.filter((x) => x !== id).concat([id]); render(); return; }
      if (a === 'done-job') { await markDone(id); toast('Done ✓', 'success'); render(); return; }
      if (a === 'pif-yes') { _busy = false; await openPaidInFull(id); return; }
      if (a === 'pif-no') { _busy = false; if (await recordPaymentSheet(id)) await afterWrite(); return; }
      if (a === 'save-close') {
        const inp = b.parentNode.querySelector('[data-cu="close-date"]');
        const at = L().dateFromYmd(inp && inp.value, Date.now());
        if (!at) { toast('Pick the date the contract was signed (not a future date)', 'error'); return; }
        if (await writeLead(id, { closedAt: at, closedAtSource: 'manual' }, 'Close date ' + inp.value + ' — ' + leadName(leadById(id)))) { toast('Close date saved ✓', 'success'); render(); }
        return;
      }
      if (a === 'tier') {
        const t = b.dataset.tier;
        if (N().TIERS.indexOf(t) === -1) return;
        if (await writeLead(id, { soldTier: t, soldTierSource: 'manual', soldTierAt: new Date() }, N().TIER_LABELS[t] + ' package — ' + leadName(leadById(id)))) { toast('Package saved ✓', 'success'); render(); }
        return;
      }
      if (a === 'add-cost') {
        try { if (window.ScriptLoader) await window.ScriptLoader.loadBundle('expenses'); } catch (_) { /* checked below */ }
        if (!window.Expenses || typeof window.Expenses.openForm !== 'function') { toast('Expenses did not load — try again', 'error'); return; }
        const before = ((_data && _data.expenses) || []).filter((x) => x && x.leadId === id).map((x) => x.id);
        _pendingCost = { leadId: id, before };
        window.Expenses.openForm({ leadId: id, category: 'materials' });
        return;
      }
      if (a === 'lost-reason') {
        const key = b.dataset.key;
        let fields = null;
        if (key === 'other') {
          if (!window.NBDLostReason) { toast('Reload the page and try again', 'error'); return; }
          _busy = false;
          const choice = await window.NBDLostReason.prompt(leadById(id));
          if (!choice) return;
          fields = choice.fields;
        } else {
          if (N().validateLostReason({ key })) return;
          fields = N().lostReasonFields({ key, note: '' });
        }
        if (await writeLeads([id], fields, 'Lost: ' + N().lostReasonLabel(fields.lostReasonKey) + ' — ' + leadName(leadById(id)))) { toast('Reason saved ✓', 'success'); render(); }
        return;
      }
      if (a === 'lost-bulk') {
        if (!window.NBDLostReason) { toast('Reload the page and try again', 'error'); return; }
        const ids = losses().queue.slice();
        _busy = false;
        const choice = await window.NBDLostReason.prompt({ name: 'All ' + ids.length + ' losses with no reason' });
        if (!choice) return;
        _busy = true;
        const n = await writeLeads(ids, choice.fields, 'Lost: ' + N().lostReasonLabel(choice.key) + ' on all');
        toast('Reason set on ' + n + ' loss' + (n === 1 ? '' : 'es'), 'success');
        render();
        return;
      }
      if (a === 'save-spend') {
        const inp = b.parentNode.querySelector('[data-cu="spend"]');
        const raw = String((inp && inp.value) || '').trim();
        if (!raw) { toast('Type the month’s spend first (0 if none)', 'error'); return; }
        const cents = N().dollarsToCents(raw);
        if (!(cents >= 0)) { toast('Enter an amount', 'error'); return; }
        if (await saveSpend(b.dataset.month, b.dataset.key, cents)) { toast('Spend saved ✓', 'success'); render(); }
        return;
      }
      if (a === 'csv-cancel') { _csv = null; render(); return; }
      if (a === 'csv-save') {
        if (await saveCsv()) { toast('Spend saved', 'success'); render(); }
        return;
      }
    } finally { _busy = false; }
  }

  async function onChange(e) {
    const t = e.target;
    if (!t || t.id !== 'cuCsvFile' || !t.closest(SCROLL_SEL) || !t.files || !t.files[0]) return;
    const f = t.files[0];
    if (f.size > 2 * 1024 * 1024) { toast('That file is over 2 MB — is it the billing CSV?', 'error'); return; }
    const parsed = N().parseSpendCsv(await f.text());
    if (parsed.error) { toast(parsed.error, 'error'); return; }
    _csv = { key: t.dataset.key || 'thumbtack', rows: parsed.rows, byMonth: parsed.byMonth, skipped: parsed.skipped };
    render();
  }

  // An expense saved from "+ Add cost": log the new ids for that job so Undo can remove them.
  async function onExpensesChanged() {
    const p = _pendingCost;
    if (!p || !host()) return;
    _pendingCost = null;
    try {
      const all = await D().loadExpenses();
      const added = (all || []).filter((x) => x && x.leadId === p.leadId && p.before.indexOf(x.id) === -1).map((x) => x.id);
      if (_data) _data.expenses = all || [];
      if (added.length) await logAction({ kind: 'cost', label: 'Cost added — ' + leadName(leadById(p.leadId)), leadId: p.leadId, expenseIds: added });
    } catch (_) { /* the cost is saved; only its undo entry is missing */ }
    render();
  }

  // Swipe left on a card = Skip (one thumb).
  let _tx = null;
  function onTouchStart(e) {
    const c = e.target && e.target.closest ? e.target.closest(SCROLL_SEL + ' .cu-card[data-cu-card]') : null;
    if (!c || e.target.closest('input,select,textarea')) { _tx = null; return; }
    _tx = { x: e.touches[0].clientX, y: e.touches[0].clientY, card: c };
  }
  function onTouchEnd(e) {
    if (!_tx) return;
    const t = e.changedTouches && e.changedTouches[0];
    const dx = t ? t.clientX - _tx.x : 0, dy = t ? t.clientY - _tx.y : 0;
    const c = _tx.card; _tx = null;
    if (dx < -70 && Math.abs(dy) < 50) {
      const id = c.dataset.id;
      if (c.dataset.cuCard === 'job') { _curJob = null; _skipJobs = _skipJobs.filter((x) => x !== id).concat([id]); }
      else _skipLost = _skipLost.filter((x) => x !== id).concat([id]);
      render();
    }
  }

  async function refresh() {
    if (_loading) return;
    _loading = true;
    try {
      if (!D() || !D().isOwner()) { render(); return; }
      await load();
    } catch (e) {
      console.warn('[catchup] load failed', e);
    } finally { _loading = false; }
    render();
  }

  let _wired = false;
  function init() {
    if (!_wired && typeof document !== 'undefined') {
      _wired = true;
      document.addEventListener('click', onClick);
      document.addEventListener('click', onSheetClick);
      document.addEventListener('change', onChange);
      document.addEventListener('touchstart', onTouchStart, { passive: true });
      document.addEventListener('touchend', onTouchEnd, { passive: true });
      window.addEventListener('nbd:expenses-changed', onExpensesChanged);
      window.addEventListener('nbd:data-refreshed', (e) => {
        const src = e && e.detail && e.detail.source;
        const v = document.getElementById('view-catchup');
        if (!(!src || src === 'leads') || !_data || !v || !v.classList.contains('active')) return;
        // Never wipe a half-typed date or amount.
        const a = document.activeElement;
        if (a && a.closest && a.closest(SCROLL_SEL) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
        render();
      });
    }
    render();
    refresh();
  }
  /** Sign-in finished after a deep link: load once if nothing is loaded yet. */
  function ensure() { if (!_data && !_loading) init(); }

  const api = {
    init, ensure, refresh, render,
    paidInFull, recordPaymentSheet, undoLast, markDone, saveSpend,
    _state: () => ({ tab: _tab, progress: _progress, data: _data, skipJobs: _skipJobs.slice(), skipLost: _skipLost.slice() }),
    _setData: (d, p) => { _data = d; if (p) _progress = p; },
  };
  window.NBDCatchUp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
