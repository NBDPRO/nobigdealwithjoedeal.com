/**
 * cash-payouts.js — "Cash paid out" log for crew / subs (2026-10-19).
 *
 * Crew are often paid in cash (or Zelle, check) and that money never reached
 * the CRM, so finished jobs read a profit that was too high. This logs each
 * payout fast, from a phone: date, amount, payee, method, optional job, note.
 *
 * NO NEW COLLECTION. A payout is an /expenses doc: category 'subcontractor'
 * (a DIRECT cost), source 'cash_payout', supplier = the payee, paymentMethod =
 * cash | zelle | check | other. So every existing reader already counts it:
 * a payout tied to a job lands in that job's direct cost (job profit, the
 * Expenses by-job table, the receipt-health "costs missing" check, the agent
 * job_profit tool). One NOT tied to a job is never dropped: the panel keeps a
 * visible "Unassigned crew cash" counter until each one gets a job.
 *
 * Money is cents. Void / edit keep the row and add an editLog entry with a
 * required note; nothing is hard-deleted from here (a void sets deleted:true,
 * which the cost readers already skip). A viewer sees the log but no buttons.
 *
 * Flag `cashPayoutsLog` (feature_flags/_default, absent = off). Off = the
 * button and the panel render nothing and this file does nothing.
 *
 * Pure parts are exported for tests (window.NBDCashPayouts).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'cashPayoutsLog';
  const SOURCE = 'cash_payout';
  const CATEGORY = 'subcontractor';
  const METHODS = [
    { key: 'cash', label: 'Cash' },
    { key: 'zelle', label: 'Zelle' },
    { key: 'check', label: 'Check' },
    { key: 'other', label: 'Other' },
  ];
  const METHOD_KEYS = METHODS.map((m) => m.key);
  const MAX_CENTS = 99999999; // $999,999.99, well under the rules' ceiling
  const MAX_LOG = 25;         // mirrors the rules' editLog bound
  const ACTIVE_RE = /contract|install|material|schedul|production|permit|supplement/i;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function canWrite() { return !!uid() && claims().role !== 'viewer'; }

  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function monthKeyOf(v) { const d = toDate(v); return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) : ''; }
  function monthLabel(k) {
    const d = new Date(k + '-01T12:00:00');
    return isNaN(d.getTime()) ? k : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  function parseCents(input) {
    const s = String(input == null ? '' : input).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return 0;
    return Math.round(parseFloat(s) * 100);
  }

  // A live payout row: ours, and not voided.
  function isPayout(e) { return !!e && e.source === SOURCE && e.deleted !== true; }
  function payoutsOf(list) { return (list || []).filter(isPayout); }
  function centsOf(e) { return (parseInt(e.amountCents, 10) || 0) + (parseInt(e.taxCents, 10) || 0); }
  function newestFirst(list) {
    return list.slice().sort((a, b) => ((toDate(b.date) || 0) - (toDate(a.date) || 0)));
  }

  // The form -> the fields of an /expenses doc (no timestamps; the caller adds
  // them). Returns { error } when the input cannot be saved.
  function buildFields(form, ctx) {
    form = form || {}; ctx = ctx || {};
    const payee = String(form.payee || '').trim().slice(0, 120);
    if (!payee) return { error: 'Who was paid?' };
    const cents = parseCents(form.amount);
    if (cents <= 0) return { error: 'Enter an amount greater than $0' };
    if (cents > MAX_CENTS) return { error: 'That amount is too large' };
    const method = METHOD_KEYS.indexOf(form.method) !== -1 ? form.method : 'cash';
    const d = form.date ? new Date(form.date + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) return { error: 'Pick a valid date' };
    const leadId = form.leadId ? String(form.leadId) : null;
    return {
      fields: {
        leadId: leadId,
        jobId: leadId ? (ctx.jobIdFor ? ctx.jobIdFor(leadId) : null) : null,
        category: CATEGORY,
        costType: 'direct',
        supplier: payee,
        amountCents: cents,
        taxCents: 0,
        paymentMethod: method,
        date: d,
        note: String(form.note || '').trim().slice(0, 500),
      },
    };
  }

  function logEntry(by, note, what, nowMs) {
    return { at: nowMs, by: by || null, what: what, note: String(note || '').trim().slice(0, 300) };
  }
  // Append, keeping the newest MAX_LOG (the rules bound the list).
  function appendLog(prev, entry) {
    const base = Array.isArray(prev) ? prev.slice() : [];
    base.push(entry);
    return base.slice(-MAX_LOG);
  }

  // Totals: all live payouts, per month, per job, and the ones with no job.
  function totals(list) {
    const rows = payoutsOf(list);
    const byMonth = {}, byJob = {};
    let totalCents = 0, unCents = 0, unCount = 0;
    rows.forEach((e) => {
      const c = centsOf(e);
      totalCents += c;
      const mk = monthKeyOf(e.date) || 'undated';
      byMonth[mk] = byMonth[mk] || { key: mk, cents: 0, count: 0 };
      byMonth[mk].cents += c; byMonth[mk].count++;
      if (e.leadId) {
        byJob[e.leadId] = byJob[e.leadId] || { leadId: e.leadId, cents: 0, count: 0 };
        byJob[e.leadId].cents += c; byJob[e.leadId].count++;
      } else { unCents += c; unCount++; }
    });
    return {
      count: rows.length,
      totalCents: totalCents,
      months: Object.keys(byMonth).map((k) => byMonth[k]).sort((a, b) => (a.key < b.key ? 1 : -1)),
      jobs: Object.keys(byJob).map((k) => byJob[k]).sort((a, b) => b.cents - a.cents),
      unassigned: { cents: unCents, count: unCount },
    };
  }

  // Remembered payees: every name used before, most recent first, de-duplicated
  // ignoring case and spacing.
  function payees(list) {
    const seen = {}, out = [];
    newestFirst(payoutsOf(list)).forEach((e) => {
      const name = String(e.supplier || '').trim();
      const k = name.toLowerCase().replace(/\s+/g, ' ');
      if (!k || seen[k]) return;
      seen[k] = true; out.push(name);
    });
    return out;
  }

  function leadName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Untitled'; }
  function leadLabel(l) { return (l.customerId ? l.customerId + ' · ' : '') + leadName(l); }
  function leadById(id) { return (w._leads || []).find((l) => l && l.id === id) || null; }

  // ── panel on the Expenses view ──────────────────────────────────────────
  function panelHtml(expenses) {
    if (!enabled()) return '';
    const T = totals(expenses);
    const write = canWrite();
    let h = '<div class="ui-card cp-panel" id="cpPanel"><div class="cp-head"><h3 class="cp-title">Cash paid out</h3>' +
      (write ? '<button type="button" class="btn btn-orange cp-add" data-cp-action="add">+ Log payout</button>' : '') + '</div>';
    h += '<div class="cp-sums"><span class="cp-sum"><b>' + money(T.totalCents) + '</b> logged · ' + T.count + ' payout' + (T.count === 1 ? '' : 's') + '</span></div>';
    if (T.unassigned.count) {
      h += '<div class="cp-warn" role="status"><b>Unassigned crew cash: ' + money(T.unassigned.cents) + '</b> (' + T.unassigned.count +
        ' payout' + (T.unassigned.count === 1 ? '' : 's') + ' with no job). It does not reach any job\'s profit until each one is tied to a job.</div>';
    }
    if (!T.count) {
      h += '<div class="cp-empty">No payouts logged yet. Log each crew payment the day it is paid so job profit stays honest.</div>';
    } else {
      h += '<div class="cp-cols"><div><div class="cp-sub">By month</div><ul class="cp-list">' +
        T.months.slice(0, 6).map((m) => '<li><span>' + esc(monthLabel(m.key)) + '</span><b>' + money(m.cents) + '</b></li>').join('') + '</ul></div>' +
        '<div><div class="cp-sub">By job</div><ul class="cp-list">' +
        (T.jobs.length ? T.jobs.slice(0, 6).map((j) => {
          const l = leadById(j.leadId);
          return '<li><span>' + esc(l ? leadLabel(l) : 'Job removed') + '</span><b>' + money(j.cents) + '</b></li>';
        }).join('') : '<li class="cp-sub">None tied to a job yet</li>') + '</ul></div></div>';
      const me = uid();
      h += '<div class="cp-sub">Newest first</div><ul class="cp-rows">' +
        newestFirst(payoutsOf(expenses)).slice(0, 25).map((e) => {
          const l = e.leadId ? leadById(e.leadId) : null;
          const d = toDate(e.date);
          const mine = write && e.userId === me;
          return '<li class="cp-row"><div class="cp-row-main"><div class="cp-row-top"><b class="cp-payee">' + esc(e.supplier || 'Unknown') + '</b><b>' + money(centsOf(e)) + '</b></div>' +
            '<div class="cp-row-sub">' + esc(d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'no date') + ' · ' + esc(e.paymentMethod || 'cash') +
            ' · ' + (l ? esc(leadLabel(l)) : '<span class="cp-flag">no job</span>') + (e.note ? ' · ' + esc(e.note) : '') + '</div></div>' +
            (mine ? '<div class="cp-row-act"><button type="button" class="btn btn-ghost btn-sm" data-cp-action="edit" data-cp-id="' + esc(e.id) + '">Edit</button>' +
              '<button type="button" class="btn btn-ghost btn-sm" data-cp-action="void" data-cp-id="' + esc(e.id) + '">Void</button></div>' : '') + '</li>';
        }).join('') + '</ul>';
    }
    return h + '</div>';
  }

  function buttonHtml() {
    if (!enabled() || !canWrite()) return '';
    return '<button type="button" class="btn btn-ghost" data-cp-action="add" title="Log a cash, Zelle or check payout to a crew member or sub">💵 Log payout</button>';
  }

  // ── sheet (add / edit / void) ───────────────────────────────────────────
  let S = null; // { mode, id, prev }
  function list() { return (w.Expenses && typeof w.Expenses.list === 'function') ? w.Expenses.list() : []; }
  function overlay() {
    let m = document.getElementById('cpOverlay');
    if (!m) { m = document.createElement('div'); m.id = 'cpOverlay'; m.className = 'cp-overlay'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
    return m;
  }
  function closeSheet() { const m = document.getElementById('cpOverlay'); if (m) m.remove(); S = null; }
  function jobIdFor(leadId) {
    const l = leadById(leadId);
    const j = l && l.activeJobId;
    return typeof j === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(j) ? j : null;
  }

  function jobOptions(selected) {
    const ls = (w._leads || []).filter((l) => l && l.id && !l.deleted && !l.isProspect);
    const act = (l) => (ACTIVE_RE.test(String(l._stageKey || l.stage || '')) ? 0 : 1);
    ls.sort((a, b) => act(a) - act(b));
    return '<option value="">No job yet (shows as unassigned)</option>' + ls.slice(0, 400).map((l) =>
      '<option value="' + esc(l.id) + '"' + (l.id === selected ? ' selected' : '') + '>' + esc(leadLabel(l)) + '</option>').join('');
  }

  function openSheet(mode, row) {
    if (!enabled() || !canWrite()) return;
    S = { mode: mode, id: row ? row.id : null, prev: row || null };
    const d = row ? toDate(row.date) : new Date();
    const method = (row && row.paymentMethod) || 'cash';
    const amt = row ? (centsOf(row) / 100).toFixed(2) : '';
    const names = payees(list()).slice(0, 8);
    const isVoid = mode === 'void';
    let h = '<div class="cp-sheet"><div class="cp-head"><h3 class="cp-title">' + (isVoid ? 'Void payout' : mode === 'edit' ? 'Edit payout' : 'Log cash payout') + '</h3>' +
      '<button type="button" class="cp-x" data-cp-action="close" aria-label="Close">✕</button></div>';
    if (isVoid) {
      h += '<p class="cp-sub">' + esc(row.supplier || '') + ' · ' + money(centsOf(row)) + '. A voided payout stops counting toward job profit. The row is kept with your note.</p>' +
        '<label class="cp-lab" for="cpNote">Why void it? (required)</label><input id="cpNote" class="cp-in" type="text" maxlength="300" autocomplete="off">';
    } else {
      h += '<label class="cp-lab" for="cpAmount">Amount</label><input id="cpAmount" class="cp-in cp-big" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(amt) + '">' +
        '<label class="cp-lab" for="cpPayee">Paid to</label><input id="cpPayee" class="cp-in" type="text" maxlength="120" autocomplete="off" list="cpPayeeList" value="' + esc(row ? row.supplier : '') + '">' +
        '<datalist id="cpPayeeList">' + names.map((n) => '<option value="' + esc(n) + '"></option>').join('') + '</datalist>' +
        (names.length ? '<div class="cp-chips">' + names.map((n) => '<button type="button" class="cp-chip" data-cp-payee="' + esc(n) + '">' + esc(n) + '</button>').join('') + '</div>' : '') +
        '<div class="cp-lab">How</div><div class="cp-methods" role="radiogroup" aria-label="Payment method">' +
        METHODS.map((m) => '<label class="cp-method"><input type="radio" name="cpMethod" value="' + m.key + '"' + (m.key === method ? ' checked' : '') + '><span>' + m.label + '</span></label>').join('') + '</div>' +
        '<label class="cp-lab" for="cpJob">Job</label><select id="cpJob" class="cp-in">' + jobOptions(row ? row.leadId : '') + '</select>' +
        '<label class="cp-lab" for="cpDate">Date</label><input id="cpDate" class="cp-in" type="date" value="' + esc(ymd(d || new Date())) + '">' +
        '<label class="cp-lab" for="cpMemo">Note (optional)</label><input id="cpMemo" class="cp-in" type="text" maxlength="500" autocomplete="off" value="' + esc(row ? row.note : '') + '">' +
        (mode === 'edit' ? '<label class="cp-lab" for="cpNote">What changed and why? (required)</label><input id="cpNote" class="cp-in" type="text" maxlength="300" autocomplete="off">' : '');
    }
    h += '<div class="cp-err" id="cpErr" role="alert"></div><div class="cp-actions"><button type="button" class="cp-btn cp-primary" data-cp-action="save">' +
      (isVoid ? 'Void payout' : 'Save payout') + '</button><button type="button" class="cp-btn" data-cp-action="close">Cancel</button></div></div>';
    overlay().innerHTML = h;
    const first = document.getElementById(isVoid ? 'cpNote' : 'cpAmount');
    if (first && typeof first.focus === 'function') first.focus();
  }

  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  function showErr(m) { const el = document.getElementById('cpErr'); if (el) el.textContent = m; }

  async function save() {
    if (!S || !canWrite()) return;
    if (!w.db || !w.doc || !w.serverTimestamp) { showErr('Not connected. Try again.'); return; }
    const me = uid();
    const prev = S.prev;
    try {
      if (S.mode === 'void') {
        const note = val('cpNote').trim();
        if (!note) { showErr('Say why you are voiding it.'); return; }
        await w.updateDoc(w.doc(w.db, 'expenses', S.id), {
          deleted: true,
          editLog: appendLog(prev.editLog, logEntry(me, note, 'void', Date.now())),
          updatedAt: w.serverTimestamp(),
        });
        toast('Payout voided', 'ok');
      } else {
        const method = (document.querySelector('input[name="cpMethod"]:checked') || {}).value;
        const built = buildFields({ amount: val('cpAmount'), payee: val('cpPayee'), method: method, leadId: val('cpJob'), date: val('cpDate'), note: val('cpMemo') }, { jobIdFor: jobIdFor });
        if (built.error) { showErr(built.error); return; }
        if (S.mode === 'edit') {
          const note = val('cpNote').trim();
          if (!note) { showErr('Say what changed and why.'); return; }
          await w.updateDoc(w.doc(w.db, 'expenses', S.id), Object.assign({}, built.fields, {
            editLog: appendLog(prev.editLog, logEntry(me, note, 'edit', Date.now())),
            updatedAt: w.serverTimestamp(),
          }));
          toast('Payout updated', 'ok');
        } else {
          await w.addDoc(w.collection(w.db, 'expenses'), Object.assign({}, built.fields, {
            userId: me,
            companyId: claims().companyId || me,
            source: SOURCE,
            needsReview: false,
            editLog: [],
            createdAt: w.serverTimestamp(),
            createdBy: me,
            updatedAt: w.serverTimestamp(),
          }));
          toast(built.fields.leadId ? 'Payout logged' : 'Payout logged. No job yet, so it is counted as unassigned crew cash.', built.fields.leadId ? 'ok' : 'warn');
        }
      }
    } catch (e) {
      console.warn('[cash-payouts] save failed', e && e.code);
      showErr('Could not save. Nothing changed.');
      return;
    }
    closeSheet();
    if (w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh();
  }

  if (typeof document !== 'undefined' && !w._NBD_CP_DELEGATE) {
    w._NBD_CP_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const chip = ev.target && ev.target.closest && ev.target.closest('[data-cp-payee]');
      if (chip) { const el = document.getElementById('cpPayee'); if (el) el.value = chip.dataset.cpPayee; return; }
      const t = ev.target && ev.target.closest && ev.target.closest('[data-cp-action]');
      if (!t || t.disabled) return;
      const a = t.dataset.cpAction;
      if (a === 'add') openSheet('add', null);
      else if (a === 'close') closeSheet();
      else if (a === 'save') save();
      else if (a === 'edit' || a === 'void') {
        const row = list().find((e) => e && e.id === t.dataset.cpId);
        if (row && isPayout(row) && row.userId === uid()) openSheet(a, row);
      }
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('cpOverlay')) closeSheet(); });
  }

  w.NBDCashPayouts = { enabled, isPayout, buildFields, totals, payees, parseCents, appendLog, panelHtml, buttonHtml, METHODS, SOURCE, CATEGORY };
})();
