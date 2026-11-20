/**
 * sub-job-board.js — the Sub job board panel on the Schedule view
 * (flag `subJobBoard`, 2026-11-19). Rules: sub-job-board-logic.js. Data:
 * companies/{id}/subJobs/{leadId} (firestore.rules, owner / company_admin /
 * manager only).
 *
 *   Board      committed and finished jobs with no sub, no agreed pay, no payment
 *              logged, or paid over the agreed amount. Every flag is a WARNING.
 *   Pay editor tap a job: pick the sub, a rate from their rate card (or type one),
 *              quantity and the agreed total, or tick "No sub needed". Saving also
 *              puts the sub on the lead (subId + crew) so the calendar lanes and
 *              double-booking warnings keep working.
 *   Scorecard  per sub: jobs done, paid, average per SQ, days late, paid vs agreed.
 *
 * Agreed pay is COST DATA. It is shown here to the owner, company_admin and
 * manager only and is never written to the lead, a customer page, or the job
 * sheet. "Paid" is logged sub payments only: cash paid and never logged is not
 * in it. Loaded lazily by schedule-planner.js, and only when the flag is on, so
 * with the flag off this file is never fetched. Crews are independent
 * subcontractors. window.NBDSubJobBoard.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDSubJobBoard) return;
  const w = window;
  const FLAG = 'subJobBoard';
  const ROLES = ['', 'company_admin', 'manager'];   // '' = the solo owner
  const PANEL_ID = 'subJobBoardPanel';
  const BASES = [['sq', 'per SQ'], ['job', 'flat per job'], ['hour', 'per hour'], ['day', 'per day']];
  const LG = () => w.NBDSubJobBoardLogic;
  const PL = () => w.NBDProductionLogic;
  const SP = () => w.NBDSubPaymentsLogic;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const claims = () => w._userClaims || {};
  const uid = () => (w._user && w._user.uid) || null;
  const tenant = () => claims().companyId || uid();
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const allowed = () => !!uid() && ROLES.indexOf(claims().role || '') !== -1;
  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)) && !!LG() && !!SP() && allowed(); }

  // S: { subJobs{}, payments[], roster[], capped, loaded, loading, err, view, open (lead id), form }
  const S = { subJobs: {}, payments: [], roster: [], capped: false, loaded: false, loading: false, tried: false, err: '', view: 'board', open: null, msg: '' };

  async function load() {
    if (S.loading || !w.db || !w.getDocs || !tenant()) return;
    S.loading = true; S.tried = true; S.err = '';
    try {
      if (w.NBDProduction && typeof w.NBDProduction.loadSubs === 'function') await w.NBDProduction.loadSubs(true);
      S.roster = (w.NBDProduction && w.NBDProduction.subs ? w.NBDProduction.subs() : []).filter((s) => s && s.name);
      const sj = await w.getDocs(w.collection(w.db, 'companies', tenant(), 'subJobs'));
      S.subJobs = {};
      sj.forEach((d) => { S.subJobs[d.id] = Object.assign({}, d.data(), { id: d.id }); });
      // The same query shape expenses.js uses (it has the index); sub rows are picked out here.
      const col = w.collection(w.db, 'expenses');
      const staffTenant = !!claims().companyId;
      const q = staffTenant
        ? w.query(col, w.where('companyId', '==', tenant()), w.orderBy('date', 'desc'), w.limit(1000))
        : w.query(col, w.where('userId', '==', uid()), w.orderBy('date', 'desc'), w.limit(1000));
      const snap = await w.getDocs(q);
      S.capped = snap.docs.length >= 1000;
      S.payments = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).filter((e) => e.deleted !== true && e.category === 'subcontractor');
      S.loaded = true;
    } catch (e) {
      console.warn('[sub-job-board] load failed', e && e.code);
      S.err = 'Could not load the board. Check your connection and try again.';
    }
    S.loading = false;
  }

  const input = () => ({ leads: w._leads || [], subJobs: S.subJobs, payments: S.payments, roster: S.roster, today: today() });
  const leadById = (id) => (w._leads || []).find((l) => l && l.id === id) || null;

  const rateOptionsHtml = (rates) => '<option value="">' + (rates.length ? 'Rate card…' : 'No rate card on this sub') + '</option>' +
    rates.map((r, i) => '<option value="' + i + '">' + esc(PL().rateLine(r)) + '</option>').join('');
  const ratesOf = (subId) => { const s = S.roster.find((x) => x.id === subId); return s && Array.isArray(s.rates) ? s.rates : []; };

  function editorHtml(row) {
    const sj = S.subJobs[row.leadId] || {};
    const subId = sj.subId || row.subId || '';
    const sub = S.roster.find((s) => s.id === subId);
    const rates = (sub && Array.isArray(sub.rates)) ? sub.rates : [];
    const opts = '<option value="">— No sub yet —</option>' + S.roster.filter((s) => s.active !== false || s.id === subId)
      .map((s) => '<option value="' + esc(s.id) + '"' + (s.id === subId ? ' selected' : '') + '>' + esc(s.name + (s.trade ? ' · ' + s.trade : '')) + '</option>').join('');
    const rateOpts = rateOptionsHtml(rates);
    const basisOpts = BASES.map((b) => '<option value="' + b[0] + '"' + ((sj.basis || 'sq') === b[0] ? ' selected' : '') + '>' + b[1] + '</option>').join('');
    const dollars = (c) => (c ? (c / 100).toFixed(2) : '');
    return '<div class="sp-done" role="group" aria-label="Agreed pay for ' + esc(row.name) + '" data-sjb-form="' + esc(row.leadId) + '">' +
      '<label>Sub<select data-sjb-f="sub">' + opts + '</select></label>' +
      '<label>From the rate card<select data-sjb-f="card">' + rateOpts + '</select></label>' +
      '<label>Pay basis<select data-sjb-f="basis">' + basisOpts + '</select></label>' +
      '<label>Rate ($)<input type="text" inputmode="decimal" data-sjb-f="rate" value="' + esc(dollars(sj.rateCents)) + '"></label>' +
      '<label>Quantity<input type="text" inputmode="decimal" data-sjb-f="qty" value="' + esc(sj.qty != null ? sj.qty : '') + '"></label>' +
      '<label>Agreed total ($)<input type="text" inputmode="decimal" data-sjb-f="total" value="' + esc(dollars(sj.agreedCents)) + '"></label>' +
      '<label>Note<input type="text" maxlength="300" data-sjb-f="note" value="' + esc(sj.note || '') + '"></label>' +
      '<label class="sp-toggle"><input type="checkbox" data-sjb-f="none"' + (sj.noSubNeeded ? ' checked' : '') + '> No sub needed on this job</label>' +
      '<button type="button" class="btn btn-orange" data-sjb-action="save">Save</button> ' +
      '<button type="button" class="btn btn-ghost" data-sjb-action="cancel">Cancel</button>' +
      '<div class="sp-done-note" data-sjb-msg role="status">' + esc(S.msg) + '</div></div>';
  }

  function rowHtml(r) {
    const bits = [];
    if (r.subName) bits.push(esc(r.subName)); else if (r.legacyCrew) bits.push('Crew name not on the roster: ' + esc(r.legacyCrew));
    if (r.agreedCents) bits.push('agreed ' + money(r.agreedCents));
    bits.push('paid ' + money(r.paidCents));
    return '<div class="sp-row" data-id="' + esc(r.leadId) + '">' +
      '<div><span class="sp-name">' + esc(r.name) + '</span></div>' +
      '<div class="sp-sub">' + esc(String(r.stage).replace(/_/g, ' ')) + ' · ' + bits.join(' · ') + '</div>' +
      (S.open === r.leadId ? editorHtml(r) : '<button type="button" class="btn btn-ghost" data-sjb-action="edit" data-id="' + esc(r.leadId) + '">Set pay</button>') +
      '</div>';
  }

  function boardHtml() {
    const res = LG().rowsFor(input());
    let h = '<div class="sp-note">' + res.considered + ' jobs checked' + (res.skipped ? ', ' + res.skipped + ' marked "no sub needed"' : '') + '. These are warnings: nothing here blocks a job.</div>';
    LG().BUCKETS.forEach((b) => {
      const rows = res.rows.filter((r) => r.flags.indexOf(b.key) !== -1);
      h += '<div class="sp-h">' + esc(b.label) + ' <span class="sp-count">' + rows.length + '</span></div>' +
        (rows.length ? rows.slice(0, 40).map(rowHtml).join('') + (rows.length > 40 ? '<div class="sp-note">Showing 40 of ' + rows.length + '.</div>' : '') : '<div class="sp-note">None.</div>');
    });
    return h;
  }

  function scoreHtml() {
    const yr = String(new Date().getFullYear());
    const ms = LG().metrics(input());
    if (!ms.length) return '<div class="sp-note">No subs on the roster yet.</div>';
    return ms.map((m) => '<div class="sp-row"><div><span class="sp-name">' + esc(m.name) + '</span>' + (m.trade ? ' <span class="sp-sub">' + esc(m.trade) + '</span>' : '') + '</div>' +
      '<div class="sp-sub">' + m.jobs + ' finished job' + (m.jobs === 1 ? '' : 's') + ' · paid ' + money(m.totalPaidCents) + ' all time, ' + money(m.paidByYear[yr] || 0) + ' in ' + yr + '</div>' +
      '<div class="sp-sub">' + (m.avgPaidPerSqCents == null ? 'No per-SQ jobs yet' : 'Average ' + money(m.avgPaidPerSqCents) + ' per SQ over ' + m.sqJobs + ' job' + (m.sqJobs === 1 ? '' : 's')) +
      ' · ' + (m.measured ? m.lateJobs + ' of ' + m.measured + ' ran late' + (m.lateDays ? ' (' + m.lateDays + ' day' + (m.lateDays === 1 ? '' : 's') + ' past the grace day)' : '') : 'No scheduled-and-finished jobs to time') + '</div>' +
      '<div class="sp-sub">' + (m.varianceCents == null ? 'No agreed pay to compare' : 'Paid ' + money(m.paidOnAgreedCents) + ' against ' + money(m.agreedCents) + ' agreed (' + (m.varianceCents > 0 ? '+' : '') + money(m.varianceCents) + ')') + '</div></div>').join('');
  }

  function render() {
    const anchor = document.getElementById('schedPlanPanel');
    let panel = document.getElementById(PANEL_ID);
    if (!enabled() || !anchor) { if (panel) panel.remove(); return; }
    if (!S.loaded && !S.loading && !S.tried) { load().then(render); }
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = PANEL_ID;
      anchor.insertAdjacentElement('afterend', panel);
    }
    const tab = (k, label) => '<button type="button" class="btn ' + (S.view === k ? 'btn-orange' : 'btn-ghost') + '" data-sjb-action="view" data-view="' + k + '">' + label + '</button> ';
    panel.innerHTML = '<div class="panel-hdr"><div><div class="panel-label">Who is on what, and what it costs</div><div class="panel-title">Sub job board</div></div></div>' +
      '<div class="panel-body">' + tab('board', 'Board') + tab('score', 'Scorecard') +
      (S.err ? '<div class="sp-note" role="alert">' + esc(S.err) + '</div>' : '') +
      (!S.loaded ? '<div class="sp-note">Loading…</div>' : (S.view === 'score' ? scoreHtml() : boardHtml()) +
        '<div class="sp-note">Paid counts payments logged in the CRM. Cash paid and never logged is not here.' + (S.capped ? ' Only the latest 1,000 expenses were read, so older payments may be missing.' : '') + '</div>') +
      '</div>';
  }

  const field = (form, k) => form.querySelector('[data-sjb-f="' + k + '"]');
  const say = (form, t) => { S.msg = t; const m = form && form.querySelector('[data-sjb-msg]'); if (m) m.textContent = t; };

  async function save(form) {
    const leadId = form.getAttribute('data-sjb-form');
    const none = field(form, 'none').checked;
    const subId = field(form, 'sub').value;
    const cents = (k) => SP().parseCents(field(form, k).value);
    const basis = field(form, 'basis').value;
    const rateCents = cents('rate'), agreedCents = cents('total');
    const qtyRaw = field(form, 'qty').value.trim();
    const qty = qtyRaw === '' ? null : Number(qtyRaw);
    if (!none && !subId) { say(form, 'Pick a sub, or tick "No sub needed".'); return; }
    if (qty != null && !(qty >= 0 && qty <= 100000)) { say(form, 'Quantity must be a number from 0 to 100,000.'); return; }
    if (rateCents > 9999999 || agreedCents > 99999999) { say(form, 'That amount is over the limit. Check the dollars.'); return; }
    const d = { noSubNeeded: none, updatedAt: w.serverTimestamp(), updatedBy: uid() };
    if (!none) {
      d.subId = subId; d.basis = BASES.some((b) => b[0] === basis) ? basis : 'sq';
      if (rateCents > 0) d.rateCents = rateCents;
      if (qty != null && qty > 0) d.qty = qty;
      if (agreedCents > 0) d.agreedCents = agreedCents;
    }
    const note = field(form, 'note').value.trim().slice(0, 300);
    if (note) d.note = note;
    const btn = form.querySelector('[data-sjb-action="save"]');
    if (btn) btn.disabled = true;
    try {
      await w.setDoc(w.doc(w.db, 'companies', tenant(), 'subJobs', leadId), d);
    } catch (e) {
      console.warn('[sub-job-board] save failed', e && e.code);
      say(form, e && e.code === 'permission-denied' ? 'Your role cannot save agreed pay.' : 'Could not save. Try again.');
      if (btn) btn.disabled = false;
      return;
    }
    S.subJobs[leadId] = Object.assign({}, d, { id: leadId, updatedAt: null });
    // Put the sub on the lead too, so the calendar lanes and double-booking warnings see it.
    const lead = leadById(leadId), sub = S.roster.find((s) => s.id === subId);
    if (!none && lead && sub && lead.subId !== sub.id && w.updateDoc) {
      const f = PL().subFieldsFor(sub);
      try { await w.updateDoc(w.doc(w.db, 'leads', leadId), Object.assign({}, f, { updatedAt: w.serverTimestamp() })); Object.assign(lead, f); }
      catch (e) { toast('Pay saved, but the sub could not be put on the job card.', 'error'); }
    }
    S.open = null; S.msg = '';
    toast('Agreed pay saved ✓', 'success');
    render();
  }

  function fillTotal(form) {
    const rate = SP().parseCents(field(form, 'rate').value);
    const basis = field(form, 'basis').value;
    const qty = Number(field(form, 'qty').value);
    if (!rate) return;
    const total = basis === 'job' ? rate : (qty > 0 ? Math.round(rate * qty) : 0);
    if (total > 0) field(form, 'total').value = (total / 100).toFixed(2);
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-sjb-action]') : null;
    if (!t || !t.closest('#' + PANEL_ID)) return;
    const a = t.getAttribute('data-sjb-action');
    if (a === 'view') { S.view = t.getAttribute('data-view') === 'score' ? 'score' : 'board'; S.open = null; render(); }
    else if (a === 'edit') { S.open = t.getAttribute('data-id'); S.msg = ''; render(); }
    else if (a === 'cancel') { S.open = null; S.msg = ''; render(); }
    else if (a === 'save') save(t.closest('[data-sjb-form]'));
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    const form = t && t.closest ? t.closest('[data-sjb-form]') : null;
    if (!form || !form.closest('#' + PANEL_ID)) return;
    const k = t.getAttribute('data-sjb-f');
    if (k === 'card' && t.value !== '') {
      const sub = S.roster.find((s) => s.id === field(form, 'sub').value);
      const r = sub && Array.isArray(sub.rates) ? sub.rates[Number(t.value)] : null;
      if (r) { field(form, 'basis').value = r.basis; field(form, 'rate').value = (r.cents / 100).toFixed(2); fillTotal(form); }
    } else if (k === 'rate' || k === 'qty' || k === 'basis') fillTotal(form);
    else if (k === 'sub') { S.msg = ''; const c = field(form, 'card'); if (c) c.innerHTML = rateOptionsHtml(ratesOf(t.value)); }
  });

  function maybeRender() {
    if (!/schedule/.test(w.location.hash || '')) return;
    if (!w._leads) return;
    render();
  }
  w.addEventListener('hashchange', () => { S.loaded = false; S.tried = false; maybeRender(); });
  w.addEventListener('nbd:data-refreshed', maybeRender);
  w.addEventListener('nbd:subs-changed', () => { if (S.loaded) { S.roster = (w.NBDProduction && w.NBDProduction.subs ? w.NBDProduction.subs() : []).filter((s) => s && s.name); maybeRender(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeRender); else maybeRender();

  w.NBDSubJobBoard = { render, _state: S };
})();
